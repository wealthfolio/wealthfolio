use std::collections::HashMap;

use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use rust_decimal_macros::dec;

use crate::errors::Result as CoreResult;

use super::model::{RebalancePlan, ResidualGap, SuggestedTransfer};
use super::optimizer::RebalanceInput;

pub struct TransferOptimizer;

fn decimal_to_bps(value: Decimal, total_value: Decimal) -> i32 {
    if total_value <= Decimal::ZERO {
        return 0;
    }
    ((value / total_value) * dec!(10000))
        .round()
        .to_i32()
        .unwrap_or(0)
}

impl TransferOptimizer {
    pub fn plan(&self, input: RebalanceInput) -> CoreResult<RebalancePlan> {
        let total_value = input.total_value;
        let target_id = input.profile.target_id.clone();
        let min_trade = input.profile.min_trade_amount;

        // Build category lookup: category_id -> (name, target_bps, current_value)
        let mut category_map: HashMap<String, (String, i32, Decimal)> = HashMap::new();
        for cat in &input.categories {
            category_map.insert(
                cat.category_id.clone(),
                (cat.category_name.clone(), cat.target_bps, cat.current_value),
            );
        }

        // Compute max_drift_bps_before
        let max_drift_bps_before = input
            .categories
            .iter()
            .filter(|c| c.is_required && !c.is_cash)
            .map(|c| {
                let current_bps = decimal_to_bps(c.current_value, total_value);
                (current_bps - c.target_bps).abs()
            })
            .max()
            .unwrap_or(0);

        // Two-tier supply strategy for minimum transfers:
        //
        // Tier 1 (primary): excess above TARGET — take from overweight categories first.
        //   These funds are above their objective, so reducing them improves the portfolio.
        //
        // Tier 2 (secondary): headroom between lower band edge and target — only used
        //   when Tier 1 doesn't cover all demand. This avoids worsening funds that are
        //   already at or below target unless absolutely necessary.
        //
        // Demand: deficit below the category's LOWER band edge.
        //
        // The transportation algorithm runs with supply sorted by amount DESC,
        // so the biggest overweight funds donate first → minimum number of pairs.

        // Per-asset supply tiers and demand.
        let mut primary_supply: Vec<(usize, Decimal)> = Vec::new();
        let mut secondary_supply: Vec<(usize, Decimal)> = Vec::new();
        let mut deficit_assets: Vec<(usize, Decimal)> = Vec::new();

        for (idx, candidate) in input.candidates.iter().enumerate() {
            let mut asset_primary = Decimal::ZERO;
            let mut asset_secondary = Decimal::ZERO;
            let mut asset_demand = Decimal::ZERO;

            for (cat_id, exposure) in &candidate.exposure_per_share {
                if let Some((_, target_bps, current_value)) = category_map.get(cat_id) {
                    let target_value = total_value * Decimal::from(*target_bps) / dec!(10000);
                    let band_bps = input.profile.effective_band_bps(*target_bps);
                    let band_value = total_value * Decimal::from(band_bps) / dec!(10000);
                    let lower_edge = (target_value - band_value).max(Decimal::ZERO);

                    let category_total_exposure: Decimal = input
                        .candidates
                        .iter()
                        .filter_map(|c| c.exposure_per_share.get(cat_id))
                        .sum();

                    if category_total_exposure <= Decimal::ZERO {
                        continue;
                    }

                    let share = *exposure / category_total_exposure;

                    if *current_value < lower_edge {
                        // Below lower band edge — needs inflow.
                        asset_demand += (lower_edge - *current_value) * share;
                    } else if *current_value > target_value {
                        // Above target — primary supply (excess over target).
                        asset_primary += (*current_value - target_value) * share;
                        // Also has secondary headroom (target down to lower edge).
                        asset_secondary += (target_value - lower_edge) * share;
                    } else {
                        // Between lower edge and target — secondary supply only.
                        asset_secondary += (*current_value - lower_edge) * share;
                    }
                }
            }

            if asset_primary > Decimal::ZERO {
                primary_supply.push((idx, asset_primary));
            }
            if asset_secondary > Decimal::ZERO {
                secondary_supply.push((idx, asset_secondary));
            }
            if asset_demand > Decimal::ZERO {
                deficit_assets.push((idx, asset_demand));
            }
        }

        // Decide which supply tiers to use.
        let total_demand: Decimal = deficit_assets.iter().map(|(_, d)| *d).sum();
        let total_primary: Decimal = primary_supply.iter().map(|(_, s)| *s).sum();

        let mut excess_assets: Vec<(usize, Decimal)> = Vec::new();

        if total_demand <= Decimal::ZERO {
            // Nothing to do — all categories are within band.
        } else if total_primary >= total_demand {
            // Tier 1 alone covers demand — only take from overweight funds.
            excess_assets = primary_supply;
        } else {
            // Tier 1 doesn't cover — combine with Tier 2.
            // Merge primary + secondary per asset.
            let mut combined: HashMap<usize, Decimal> = HashMap::new();
            for (idx, amount) in &primary_supply {
                *combined.entry(*idx).or_default() += *amount;
            }
            for (idx, amount) in &secondary_supply {
                *combined.entry(*idx).or_default() += *amount;
            }
            excess_assets = combined.into_iter().collect();
        }

        // Sort supply by amount DESC (biggest donors first → fewer pairs),
        // then asset_id ASC for deterministic tie-break.
        excess_assets.sort_by(|a, b| {
            b.1.cmp(&a.1).then_with(|| {
                input.candidates[a.0]
                    .asset_id
                    .cmp(&input.candidates[b.0].asset_id)
            })
        });
        deficit_assets.sort_by(|a, b| {
            b.1.cmp(&a.1).then_with(|| {
                input.candidates[a.0]
                    .asset_id
                    .cmp(&input.candidates[b.0].asset_id)
            })
        });

        // Northwest-corner transportation algorithm: greedily match supply to demand
        let mut transfer_pairs: Vec<SuggestedTransfer> = Vec::new();
        let mut supply: Vec<Decimal> = excess_assets.iter().map(|(_, v)| *v).collect();
        let mut demand: Vec<Decimal> = deficit_assets.iter().map(|(_, v)| *v).collect();

        let mut i = 0usize;
        let mut j = 0usize;
        while i < supply.len() && j < demand.len() {
            let flow = supply[i].min(demand[j]);
            if flow > Decimal::ZERO {
                let from = &input.candidates[excess_assets[i].0];
                let to = &input.candidates[deficit_assets[j].0];
                transfer_pairs.push(SuggestedTransfer {
                    from_asset_id: from.asset_id.clone(),
                    from_symbol: from.symbol.clone(),
                    from_name: from.name.clone(),
                    from_account_id: None,
                    from_holding_id: Some(from.holding_id.clone()),
                    to_asset_id: to.asset_id.clone(),
                    to_symbol: to.symbol.clone(),
                    to_name: to.name.clone(),
                    to_account_id: None,
                    to_holding_id: Some(to.holding_id.clone()),
                    amount: flow,
                    reason: String::new(),
                    drift_improvement_bps: 0,
                });
                supply[i] -= flow;
                demand[j] -= flow;
            }
            if supply[i] == Decimal::ZERO {
                i += 1;
            }
            if j < demand.len() && demand[j] == Decimal::ZERO {
                j += 1;
            }
        }

        // Prune pairs below min_trade_amount; track pruned amounts for residual gap cause
        let mut pruned_amount_by_dest: HashMap<String, Decimal> = HashMap::new();
        if min_trade > Decimal::ZERO {
            transfer_pairs.retain(|p| {
                if p.amount < min_trade {
                    *pruned_amount_by_dest
                        .entry(p.to_asset_id.clone())
                        .or_default() += p.amount;
                    false
                } else {
                    true
                }
            });
        }

        // Compute after-values per category by applying the remaining transfers
        let mut after_values: HashMap<String, Decimal> = input
            .categories
            .iter()
            .map(|c| (c.category_id.clone(), c.current_value))
            .collect();

        for pair in &transfer_pairs {
            let from = input
                .candidates
                .iter()
                .find(|c| c.asset_id == pair.from_asset_id);
            let to = input
                .candidates
                .iter()
                .find(|c| c.asset_id == pair.to_asset_id);

            if let Some(from) = from {
                let total_exposure: Decimal = from.exposure_per_share.values().sum();
                if total_exposure > Decimal::ZERO {
                    for (cat_id, exp) in &from.exposure_per_share {
                        let proportion = *exp / total_exposure;
                        if let Some(val) = after_values.get_mut(cat_id) {
                            *val -= pair.amount * proportion;
                        }
                    }
                }
            }
            if let Some(to) = to {
                let total_exposure: Decimal = to.exposure_per_share.values().sum();
                if total_exposure > Decimal::ZERO {
                    for (cat_id, exp) in &to.exposure_per_share {
                        let proportion = *exp / total_exposure;
                        if let Some(val) = after_values.get_mut(cat_id) {
                            *val += pair.amount * proportion;
                        }
                    }
                }
            }
        }

        // Compute after bps by category
        let mut after_bps_by_category: HashMap<String, i32> = HashMap::new();
        for (cat_id, value) in &after_values {
            after_bps_by_category.insert(cat_id.clone(), decimal_to_bps(*value, total_value));
        }

        let max_drift_bps_after = input
            .categories
            .iter()
            .filter(|c| c.is_required && !c.is_cash)
            .map(|c| {
                let after = after_bps_by_category
                    .get(&c.category_id)
                    .copied()
                    .unwrap_or(0);
                (after - c.target_bps).abs()
            })
            .max()
            .unwrap_or(0);

        // Fill in reasons and drift_improvement_bps for each pair
        for pair in &mut transfer_pairs {
            let from_cats: Vec<String> = input
                .candidates
                .iter()
                .find(|c| c.asset_id == pair.from_asset_id)
                .map(|c| c.exposure_per_share.keys().cloned().collect())
                .unwrap_or_default();
            let cat_name = from_cats
                .first()
                .and_then(|id| category_map.get(id))
                .map(|(name, _, _)| name.clone())
                .unwrap_or_default();
            pair.reason = format!(
                "Transfer {} from {} to {} to reduce {} drift",
                pair.amount, pair.from_symbol, pair.to_symbol, cat_name
            );
            pair.drift_improvement_bps = max_drift_bps_before - max_drift_bps_after;
        }

        // Build residual gaps for categories that still have drift after transfers
        let has_pruned = pruned_amount_by_dest.values().any(|v| *v > Decimal::ZERO);
        let mut residual_gaps: Vec<ResidualGap> = Vec::new();
        for cat in &input.categories {
            if !cat.is_required || cat.is_cash {
                continue;
            }
            let after = after_bps_by_category
                .get(&cat.category_id)
                .copied()
                .unwrap_or(0);
            let gap = (after - cat.target_bps).abs();
            if gap > 0 {
                let cause = if has_pruned {
                    "below_minimum".to_string()
                } else {
                    "rounding".to_string()
                };
                residual_gaps.push(ResidualGap {
                    category_id: cat.category_id.clone(),
                    category_name: cat.category_name.clone(),
                    gap_bps: gap,
                    cause,
                });
            }
        }

        Ok(RebalancePlan {
            target_id,
            available_cash: input.available_cash,
            cash_used: Decimal::ZERO,
            cash_remaining: input.available_cash,
            max_drift_bps_before,
            max_drift_bps_after,
            trades: vec![],
            warnings: input.warnings,
            after_bps_by_category,
            transfer_pairs,
            residual_gaps,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::model::{BandType, RebalanceGoal, ScenarioMode};
    use super::super::optimizer::{AssetCandidate, CategoryState, RebalanceProfile};
    use super::*;

    fn make_profile(min_trade: Decimal) -> RebalanceProfile {
        RebalanceProfile {
            target_id: "t1".to_string(),
            drift_band_bps: 500,
            band_type: BandType::Absolute,
            relative_factor_bps: 0,
            rebalance_goal: RebalanceGoal::ExactTarget,
            min_trade_amount: min_trade,
            whole_shares_only: false,
        }
    }

    fn make_input(
        categories: Vec<CategoryState>,
        candidates: Vec<AssetCandidate>,
        total_value: Decimal,
    ) -> RebalanceInput {
        RebalanceInput {
            profile: make_profile(dec!(0)),
            scenario_mode: ScenarioMode::TransferOnly,
            available_cash: dec!(0),
            total_value,
            categories,
            candidates,
            sell_candidates: vec![],
            warnings: vec![],
            max_turnover_bps: None,
        }
    }

    #[test]
    fn two_assets_one_overweight_one_underweight() {
        // Portfolio: $10,000 total. EQUITY at 70% (target 60%), BONDS at 30% (target 40%).
        // Band = 500 bps (5%).
        // EQ: upper=65%, lower=55%. Current 70% → supply headroom = 70%-55% = $1,500.
        // BD: upper=45%, lower=35%. Current 30% → demand = 35%-30% = $500.
        // Supply ($1,500) > demand ($500) → cap supply to $500.
        // Transfer $500 from VTI to BND → BD reaches exactly 35% (lower edge).
        let categories = vec![
            CategoryState {
                category_id: "EQ".to_string(),
                category_name: "Equity".to_string(),
                target_bps: 6000,
                current_value: dec!(7000),
                is_cash: false,
                is_required: true,
            },
            CategoryState {
                category_id: "BD".to_string(),
                category_name: "Bonds".to_string(),
                target_bps: 4000,
                current_value: dec!(3000),
                is_cash: false,
                is_required: true,
            },
        ];

        let candidates = vec![
            AssetCandidate {
                holding_id: "h-vti".to_string(),
                asset_id: "vti".to_string(),
                symbol: "VTI".to_string(),
                name: Some("Vanguard Total Stock".to_string()),
                price: dec!(100),
                exposure_per_share: HashMap::from([("EQ".to_string(), dec!(100))]),
            },
            AssetCandidate {
                holding_id: "h-bnd".to_string(),
                asset_id: "bnd".to_string(),
                symbol: "BND".to_string(),
                name: Some("Vanguard Total Bond".to_string()),
                price: dec!(80),
                exposure_per_share: HashMap::from([("BD".to_string(), dec!(80))]),
            },
        ];

        let plan = TransferOptimizer
            .plan(make_input(categories, candidates, dec!(10000)))
            .unwrap();

        assert!(
            plan.trades.is_empty(),
            "transfer_only must not produce trades"
        );
        assert_eq!(plan.cash_used, dec!(0));
        assert_eq!(plan.transfer_pairs.len(), 1);

        let pair = &plan.transfer_pairs[0];
        assert_eq!(pair.from_asset_id, "vti");
        assert_eq!(pair.to_asset_id, "bnd");
        // Transfer exactly enough to bring BD to its lower band edge (35%)
        assert!(
            (pair.amount - dec!(500)).abs() < dec!(1),
            "expected ~500, got {}",
            pair.amount
        );
        assert!(plan.max_drift_bps_after < plan.max_drift_bps_before);
    }

    #[test]
    fn already_balanced_produces_empty_plan() {
        let categories = vec![
            CategoryState {
                category_id: "EQ".to_string(),
                category_name: "Equity".to_string(),
                target_bps: 6000,
                current_value: dec!(6000),
                is_cash: false,
                is_required: true,
            },
            CategoryState {
                category_id: "BD".to_string(),
                category_name: "Bonds".to_string(),
                target_bps: 4000,
                current_value: dec!(4000),
                is_cash: false,
                is_required: true,
            },
        ];
        let candidates = vec![
            AssetCandidate {
                holding_id: "h-vti".to_string(),
                asset_id: "vti".to_string(),
                symbol: "VTI".to_string(),
                name: None,
                price: dec!(100),
                exposure_per_share: HashMap::from([("EQ".to_string(), dec!(100))]),
            },
            AssetCandidate {
                holding_id: "h-bnd".to_string(),
                asset_id: "bnd".to_string(),
                symbol: "BND".to_string(),
                name: None,
                price: dec!(80),
                exposure_per_share: HashMap::from([("BD".to_string(), dec!(80))]),
            },
        ];

        let plan = TransferOptimizer
            .plan(make_input(categories, candidates, dec!(10000)))
            .unwrap();
        assert!(plan.transfer_pairs.is_empty());
        assert!(plan.residual_gaps.is_empty());
    }

    #[test]
    fn three_assets_multi_pair() {
        // EQ at 50% (target 33%), BD at 25% (target 33%), RE at 25% (target 34%).
        let categories = vec![
            CategoryState {
                category_id: "EQ".to_string(),
                category_name: "Equity".to_string(),
                target_bps: 3300,
                current_value: dec!(5000),
                is_cash: false,
                is_required: true,
            },
            CategoryState {
                category_id: "BD".to_string(),
                category_name: "Bonds".to_string(),
                target_bps: 3300,
                current_value: dec!(2500),
                is_cash: false,
                is_required: true,
            },
            CategoryState {
                category_id: "RE".to_string(),
                category_name: "Real Estate".to_string(),
                target_bps: 3400,
                current_value: dec!(2500),
                is_cash: false,
                is_required: true,
            },
        ];
        let candidates = vec![
            AssetCandidate {
                holding_id: "h-vti".to_string(),
                asset_id: "vti".to_string(),
                symbol: "VTI".to_string(),
                name: None,
                price: dec!(100),
                exposure_per_share: HashMap::from([("EQ".to_string(), dec!(100))]),
            },
            AssetCandidate {
                holding_id: "h-bnd".to_string(),
                asset_id: "bnd".to_string(),
                symbol: "BND".to_string(),
                name: None,
                price: dec!(80),
                exposure_per_share: HashMap::from([("BD".to_string(), dec!(80))]),
            },
            AssetCandidate {
                holding_id: "h-vnq".to_string(),
                asset_id: "vnq".to_string(),
                symbol: "VNQ".to_string(),
                name: None,
                price: dec!(90),
                exposure_per_share: HashMap::from([("RE".to_string(), dec!(90))]),
            },
        ];

        let plan = TransferOptimizer
            .plan(make_input(categories, candidates, dec!(10000)))
            .unwrap();
        assert!(plan.trades.is_empty());
        assert!(
            plan.transfer_pairs.len() >= 2,
            "should produce at least 2 pairs"
        );
        assert!(plan.max_drift_bps_after < plan.max_drift_bps_before);
    }

    #[test]
    fn determinism_same_input_same_output() {
        let make = || {
            let categories = vec![
                CategoryState {
                    category_id: "EQ".to_string(),
                    category_name: "Equity".to_string(),
                    target_bps: 6000,
                    current_value: dec!(7000),
                    is_cash: false,
                    is_required: true,
                },
                CategoryState {
                    category_id: "BD".to_string(),
                    category_name: "Bonds".to_string(),
                    target_bps: 4000,
                    current_value: dec!(3000),
                    is_cash: false,
                    is_required: true,
                },
            ];
            let candidates = vec![
                AssetCandidate {
                    holding_id: "h-vti".to_string(),
                    asset_id: "vti".to_string(),
                    symbol: "VTI".to_string(),
                    name: None,
                    price: dec!(100),
                    exposure_per_share: HashMap::from([("EQ".to_string(), dec!(100))]),
                },
                AssetCandidate {
                    holding_id: "h-bnd".to_string(),
                    asset_id: "bnd".to_string(),
                    symbol: "BND".to_string(),
                    name: None,
                    price: dec!(80),
                    exposure_per_share: HashMap::from([("BD".to_string(), dec!(80))]),
                },
            ];
            make_input(categories, candidates, dec!(10000))
        };

        let plan1 = TransferOptimizer.plan(make()).unwrap();
        let plan2 = TransferOptimizer.plan(make()).unwrap();

        assert_eq!(plan1.transfer_pairs.len(), plan2.transfer_pairs.len());
        for (a, b) in plan1.transfer_pairs.iter().zip(plan2.transfer_pairs.iter()) {
            assert_eq!(a.from_asset_id, b.from_asset_id);
            assert_eq!(a.to_asset_id, b.to_asset_id);
            assert_eq!(a.amount, b.amount);
        }
    }

    #[test]
    fn min_trade_filter_prunes_small_pairs() {
        // Portfolio: $10,000. EQ at 62% (target 50%), BD at 38% (target 50%).
        // Band = 500 bps (5%). EQ excess beyond band = 62% - 55% = 7% → $700.
        // But with min_trade = $800, the $700 pair is pruned.
        let categories = vec![
            CategoryState {
                category_id: "EQ".to_string(),
                category_name: "Equity".to_string(),
                target_bps: 5000,
                current_value: dec!(6200),
                is_cash: false,
                is_required: true,
            },
            CategoryState {
                category_id: "BD".to_string(),
                category_name: "Bonds".to_string(),
                target_bps: 5000,
                current_value: dec!(3800),
                is_cash: false,
                is_required: true,
            },
        ];
        let candidates = vec![
            AssetCandidate {
                holding_id: "h-vti".to_string(),
                asset_id: "vti".to_string(),
                symbol: "VTI".to_string(),
                name: None,
                price: dec!(100),
                exposure_per_share: HashMap::from([("EQ".to_string(), dec!(100))]),
            },
            AssetCandidate {
                holding_id: "h-bnd".to_string(),
                asset_id: "bnd".to_string(),
                symbol: "BND".to_string(),
                name: None,
                price: dec!(80),
                exposure_per_share: HashMap::from([("BD".to_string(), dec!(80))]),
            },
        ];

        let mut input = make_input(categories, candidates, dec!(10000));
        input.profile = make_profile(dec!(800)); // min trade $800

        let plan = TransferOptimizer.plan(input).unwrap();
        assert!(
            plan.transfer_pairs.is_empty(),
            "pair below min_trade should be pruned"
        );
        assert!(!plan.residual_gaps.is_empty(), "should report gap");
    }

    #[test]
    fn single_asset_no_transfer_possible() {
        let categories = vec![CategoryState {
            category_id: "EQ".to_string(),
            category_name: "Equity".to_string(),
            target_bps: 6000,
            current_value: dec!(10000),
            is_cash: false,
            is_required: true,
        }];
        let candidates = vec![AssetCandidate {
            holding_id: "h-vti".to_string(),
            asset_id: "vti".to_string(),
            symbol: "VTI".to_string(),
            name: None,
            price: dec!(100),
            exposure_per_share: HashMap::from([("EQ".to_string(), dec!(100))]),
        }];

        let plan = TransferOptimizer
            .plan(make_input(categories, candidates, dec!(10000)))
            .unwrap();
        assert!(plan.transfer_pairs.is_empty());
    }

    #[test]
    fn within_band_drift_produces_no_transfers() {
        // Portfolio: $10,000. EQ at 63% (target 60%), BD at 37% (target 40%).
        // Drift is 3% (300 bps), band is 5% (500 bps) → within band → no transfers.
        let categories = vec![
            CategoryState {
                category_id: "EQ".to_string(),
                category_name: "Equity".to_string(),
                target_bps: 6000,
                current_value: dec!(6300),
                is_cash: false,
                is_required: true,
            },
            CategoryState {
                category_id: "BD".to_string(),
                category_name: "Bonds".to_string(),
                target_bps: 4000,
                current_value: dec!(3700),
                is_cash: false,
                is_required: true,
            },
        ];
        let candidates = vec![
            AssetCandidate {
                holding_id: "h-vti".to_string(),
                asset_id: "vti".to_string(),
                symbol: "VTI".to_string(),
                name: None,
                price: dec!(100),
                exposure_per_share: HashMap::from([("EQ".to_string(), dec!(100))]),
            },
            AssetCandidate {
                holding_id: "h-bnd".to_string(),
                asset_id: "bnd".to_string(),
                symbol: "BND".to_string(),
                name: None,
                price: dec!(80),
                exposure_per_share: HashMap::from([("BD".to_string(), dec!(80))]),
            },
        ];

        let plan = TransferOptimizer
            .plan(make_input(categories, candidates, dec!(10000)))
            .unwrap();
        assert!(
            plan.transfer_pairs.is_empty(),
            "drift within band should produce no transfers"
        );
    }

    #[test]
    fn transfers_bring_underweight_into_band_using_in_band_headroom() {
        // Portfolio: $10,000. EQ at 68% (target 60%), BD at 32% (target 40%).
        // Band = 500 bps (5%).
        // EQ: upper=65%, lower=55%. Current 68% → supply headroom = 68%-55% = $1,300.
        // BD: upper=45%, lower=35%. Current 32% → demand = 35%-32% = $300.
        // Supply ($1,300) > demand ($300) → cap supply to $300.
        // Transfer $300 → BD reaches 35% (lower edge, in band).
        let categories = vec![
            CategoryState {
                category_id: "EQ".to_string(),
                category_name: "Equity".to_string(),
                target_bps: 6000,
                current_value: dec!(6800),
                is_cash: false,
                is_required: true,
            },
            CategoryState {
                category_id: "BD".to_string(),
                category_name: "Bonds".to_string(),
                target_bps: 4000,
                current_value: dec!(3200),
                is_cash: false,
                is_required: true,
            },
        ];
        let candidates = vec![
            AssetCandidate {
                holding_id: "h-vti".to_string(),
                asset_id: "vti".to_string(),
                symbol: "VTI".to_string(),
                name: None,
                price: dec!(100),
                exposure_per_share: HashMap::from([("EQ".to_string(), dec!(100))]),
            },
            AssetCandidate {
                holding_id: "h-bnd".to_string(),
                asset_id: "bnd".to_string(),
                symbol: "BND".to_string(),
                name: None,
                price: dec!(80),
                exposure_per_share: HashMap::from([("BD".to_string(), dec!(80))]),
            },
        ];

        let plan = TransferOptimizer
            .plan(make_input(categories, candidates, dec!(10000)))
            .unwrap();

        assert_eq!(plan.transfer_pairs.len(), 1);
        let pair = &plan.transfer_pairs[0];
        assert_eq!(pair.from_asset_id, "vti");
        assert_eq!(pair.to_asset_id, "bnd");
        assert!(
            (pair.amount - dec!(300)).abs() < dec!(1),
            "expected ~300, got {}",
            pair.amount
        );
    }
}
