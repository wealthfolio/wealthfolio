use std::collections::HashMap;

use rust_decimal::Decimal;
use rust_decimal_macros::dec;

use crate::errors::Result as CoreResult;

use super::model::{
    BandType, RebalanceGoal, RebalancePlan, RebalanceWarning, RebalanceWarningKind, ScenarioMode,
    SuggestedManualTrade,
};

// ── Input types ───────────────────────────────────────────────────────────────

pub struct RebalanceProfile {
    pub target_id: String,
    pub drift_band_bps: i32,
    pub band_type: BandType,
    pub relative_factor_bps: i32,
    pub rebalance_goal: RebalanceGoal,
    pub min_trade_amount: Decimal,
    pub whole_shares_only: bool,
}

impl RebalanceProfile {
    pub fn effective_band_bps(&self, target_bps: i32) -> i32 {
        self.band_type
            .effective_band_bps(target_bps, self.drift_band_bps, self.relative_factor_bps)
    }
}

pub struct CategoryState {
    pub category_id: String,
    pub category_name: String,
    pub target_bps: i32,
    pub current_value: Decimal,
    pub is_cash: bool,
    pub is_required: bool,
}

pub struct AssetCandidate {
    pub holding_id: String,
    pub asset_id: String,
    pub symbol: String,
    pub name: Option<String>,
    pub price: Decimal,
    /// Value added per share in base currency, keyed by category_id.
    /// __UNKNOWN__ excluded. May sum to less than price (partial classification).
    pub exposure_per_share: HashMap<String, Decimal>,
}

pub struct SellCandidate {
    pub holding_id: String,
    pub asset_id: String,
    pub account_id: String,
    /// All real account IDs that hold this asset (for account-level constraint filtering).
    pub source_account_ids: Vec<String>,
    pub symbol: String,
    pub name: Option<String>,
    pub price: Decimal,
    pub quantity_owned: Decimal,
    /// Same semantics as AssetCandidate: value removed per share sold.
    pub exposure_per_share: HashMap<String, Decimal>,
}

pub struct RebalanceInput {
    pub profile: RebalanceProfile,
    pub scenario_mode: ScenarioMode,
    pub available_cash: Decimal,
    pub total_value: Decimal,
    pub categories: Vec<CategoryState>,
    pub candidates: Vec<AssetCandidate>,
    pub sell_candidates: Vec<SellCandidate>,
    /// Pre-populated classification warnings (UnclassifiedAsset, PartialClassification).
    pub warnings: Vec<RebalanceWarning>,
    /// Max % of portfolio value that can be sold in one plan.
    pub max_turnover_bps: Option<Decimal>,
}

// ── Trait ─────────────────────────────────────────────────────────────────────

pub trait RebalanceOptimizer: Send + Sync {
    fn plan(&self, input: RebalanceInput) -> CoreResult<RebalancePlan>;
}

// ── DriftPriorityOptimizer ────────────────────────────────────────────────────

/// Greedy exposure-aware planner: each iteration buys 1 share of the asset that
/// maximises total drift reduction per dollar across all taxonomy categories.
pub struct DriftPriorityOptimizer;

impl DriftPriorityOptimizer {
    fn desired_bps_for_goal(target_bps: i32, goal: &RebalanceGoal, band_bps: i32) -> Decimal {
        match goal {
            RebalanceGoal::ExactTarget => Decimal::from(target_bps),
            RebalanceGoal::NearestBand => {
                (Decimal::from(target_bps) - Decimal::from(band_bps)).max(Decimal::ZERO)
            }
        }
    }

    fn cap_fractional_shares_to_next_bend(
        candidate: &AssetCandidate,
        cash: Decimal,
        values: &HashMap<String, Decimal>,
        categories: &[CategoryState],
        total_value: Decimal,
        profile: &RebalanceProfile,
    ) -> Decimal {
        if candidate.price <= Decimal::ZERO || cash <= Decimal::ZERO {
            return Decimal::ZERO;
        }

        let scale = dec!(10000);
        let mut shares = cash / candidate.price;

        for cat in categories.iter().filter(|c| c.is_required && !c.is_cash) {
            let Some(expo) = candidate.exposure_per_share.get(&cat.category_id) else {
                continue;
            };
            if *expo <= Decimal::ZERO {
                continue;
            }

            let band_bps = profile.effective_band_bps(cat.target_bps);
            let desired_bps =
                Self::desired_bps_for_goal(cat.target_bps, &profile.rebalance_goal, band_bps);
            let desired_value = desired_bps / scale * total_value;
            let base = values.get(&cat.category_id).copied().unwrap_or_default();
            if base < desired_value {
                let cap = (desired_value - base) / expo;
                if cap < shares {
                    shares = cap;
                }
            }
        }

        shares.max(Decimal::ZERO)
    }

    fn exposure_delta(
        exposure_per_share: &HashMap<String, Decimal>,
        shares: Decimal,
    ) -> HashMap<String, Decimal> {
        exposure_per_share
            .iter()
            .map(|(cat_id, e)| (cat_id.clone(), e * shares))
            .collect()
    }

    fn topup_shares_for_budget(
        candidate: &AssetCandidate,
        budget: Decimal,
        profile: &RebalanceProfile,
    ) -> Decimal {
        if budget <= Decimal::ZERO || candidate.price <= Decimal::ZERO {
            return Decimal::ZERO;
        }

        let shares = if profile.whole_shares_only {
            (budget / candidate.price).floor()
        } else {
            budget / candidate.price
        };

        if shares <= Decimal::ZERO {
            return Decimal::ZERO;
        }

        let amount = shares * candidate.price;
        if profile.min_trade_amount > Decimal::ZERO && amount < profile.min_trade_amount {
            return Decimal::ZERO;
        }

        shares
    }

    fn remaining_cash_excess_after_buys(
        categories: &[CategoryState],
        total_value: Decimal,
        profile: &RebalanceProfile,
        sell_proceeds: Decimal,
        buy_amount: Decimal,
    ) -> Option<Decimal> {
        let required_cash: Vec<&CategoryState> = categories
            .iter()
            .filter(|c| c.is_required && c.is_cash)
            .collect();
        if required_cash.is_empty() {
            return None;
        }
        if total_value <= Decimal::ZERO {
            return Some(Decimal::ZERO);
        }

        let current_cash: Decimal = required_cash.iter().map(|c| c.current_value).sum();
        let target_bps: i32 = required_cash.iter().map(|c| c.target_bps).sum();
        let cash_band = Decimal::from(profile.effective_band_bps(target_bps));
        let stop_bps = match profile.rebalance_goal {
            RebalanceGoal::ExactTarget => Decimal::from(target_bps),
            RebalanceGoal::NearestBand => (Decimal::from(target_bps) + cash_band).min(dec!(10000)),
        };
        let stop_value = stop_bps / dec!(10000) * total_value;

        Some((current_cash + sell_proceeds - stop_value - buy_amount).max(Decimal::ZERO))
    }

    fn category_drift(
        bps: Decimal,
        target_bps: i32,
        goal: &RebalanceGoal,
        band_bps: i32,
    ) -> Decimal {
        let dist = (bps - Decimal::from(target_bps)).abs();
        match goal {
            RebalanceGoal::ExactTarget => dist,
            RebalanceGoal::NearestBand => (dist - Decimal::from(band_bps)).max(Decimal::ZERO),
        }
    }

    fn total_drift(
        values: &HashMap<String, Decimal>,
        categories: &[CategoryState],
        total_value: Decimal,
        profile: &RebalanceProfile,
    ) -> Decimal {
        if total_value == Decimal::ZERO {
            return Decimal::ZERO;
        }
        let scale = dec!(10000);
        categories
            .iter()
            .filter(|c| c.is_required && !c.is_cash)
            .map(|c| {
                let v = values.get(&c.category_id).copied().unwrap_or_default();
                let bps = v / total_value * scale;
                let band_bps = profile.effective_band_bps(c.target_bps);
                Self::category_drift(bps, c.target_bps, &profile.rebalance_goal, band_bps)
            })
            .sum()
    }

    fn total_drift_with_buy(
        values: &HashMap<String, Decimal>,
        categories: &[CategoryState],
        total_value: Decimal,
        exposure: &HashMap<String, Decimal>,
        profile: &RebalanceProfile,
    ) -> Decimal {
        if total_value == Decimal::ZERO {
            return Decimal::ZERO;
        }
        let scale = dec!(10000);
        categories
            .iter()
            .filter(|c| c.is_required && !c.is_cash)
            .map(|c| {
                let base = values.get(&c.category_id).copied().unwrap_or_default();
                let delta = exposure.get(&c.category_id).copied().unwrap_or_default();
                let bps = (base + delta) / total_value * scale;
                let band_bps = profile.effective_band_bps(c.target_bps);
                Self::category_drift(bps, c.target_bps, &profile.rebalance_goal, band_bps)
            })
            .sum()
    }

    /// Sell greedy: each iteration sells 1 share of the asset with the highest
    /// drift-improvement/dollar score. Returns (updated values, proceeds, sell trades).
    #[allow(clippy::too_many_arguments)]
    fn run_sell_phase(
        values: &HashMap<String, Decimal>,
        total_value: Decimal,
        categories: &[CategoryState],
        sell_candidates: &[SellCandidate],
        profile: &RebalanceProfile,
        max_turnover_bps: Option<Decimal>,
        warnings: &mut Vec<RebalanceWarning>,
    ) -> (HashMap<String, Decimal>, Decimal, Vec<SuggestedManualTrade>) {
        if total_value == Decimal::ZERO || sell_candidates.is_empty() {
            return (values.clone(), Decimal::ZERO, vec![]);
        }

        let turnover_cap_value = max_turnover_bps.map(|p| total_value * p / dec!(10000));

        let scale = dec!(10000);
        let initial_values = values.clone();
        let mut values = initial_values.clone();
        let mut qty_remaining: Vec<Decimal> =
            sell_candidates.iter().map(|c| c.quantity_owned).collect();
        let mut shares_sold: Vec<Decimal> = vec![Decimal::ZERO; sell_candidates.len()];
        let mut cumulative_sold = Decimal::ZERO;
        let mut turnover_cap_reached = false;

        loop {
            let drift_before = Self::total_drift(&values, categories, total_value, profile);
            if drift_before == Decimal::ZERO {
                break;
            }

            let mut best_score = Decimal::ZERO;
            let mut best_idx: Option<usize> = None;
            let mut best_sell_shares = Decimal::ZERO;

            for (idx, candidate) in sell_candidates.iter().enumerate() {
                if qty_remaining[idx] <= Decimal::ZERO {
                    continue;
                }
                if candidate.price <= Decimal::ZERO {
                    continue;
                }

                let sell_qty = if profile.whole_shares_only {
                    if qty_remaining[idx] < Decimal::ONE {
                        continue;
                    }
                    Decimal::ONE
                } else {
                    let mut max_shares = qty_remaining[idx];
                    for cat in categories.iter().filter(|c| c.is_required && !c.is_cash) {
                        let Some(expo) = candidate.exposure_per_share.get(&cat.category_id) else {
                            continue;
                        };
                        if *expo <= Decimal::ZERO {
                            continue;
                        }
                        let current_v = values.get(&cat.category_id).copied().unwrap_or_default();
                        let current_bps = current_v / total_value * scale;
                        let cat_band = Decimal::from(profile.effective_band_bps(cat.target_bps));
                        let stop_bps = match profile.rebalance_goal {
                            RebalanceGoal::ExactTarget => Decimal::from(cat.target_bps),
                            RebalanceGoal::NearestBand => {
                                (Decimal::from(cat.target_bps) + cat_band).min(dec!(10000))
                            }
                        };
                        if current_bps <= stop_bps {
                            continue;
                        }
                        let stop_value = stop_bps / scale * total_value;
                        let cap = (current_v - stop_value) / expo;
                        if cap < max_shares {
                            max_shares = cap;
                        }
                    }
                    max_shares.min(qty_remaining[idx]).max(Decimal::ZERO)
                };

                if sell_qty <= Decimal::ZERO {
                    continue;
                }

                let neg_exposure: HashMap<String, Decimal> = candidate
                    .exposure_per_share
                    .iter()
                    .map(|(k, v)| (k.clone(), -(*v) * sell_qty))
                    .collect();
                let drift_after = Self::total_drift_with_buy(
                    &values,
                    categories,
                    total_value,
                    &neg_exposure,
                    profile,
                );
                let improvement = drift_before - drift_after;
                if improvement <= Decimal::ZERO {
                    continue;
                }
                let cost = candidate.price * sell_qty;
                if cost <= Decimal::ZERO {
                    continue;
                }
                let score = improvement / cost;
                if score > best_score {
                    best_score = score;
                    best_idx = Some(idx);
                    best_sell_shares = sell_qty;
                }
            }

            let Some(idx) = best_idx else {
                break;
            };

            let candidate = &sell_candidates[idx];
            let batch = if profile.whole_shares_only {
                let improving_count = sell_candidates
                    .iter()
                    .enumerate()
                    .filter(|(i, c)| {
                        if qty_remaining[*i] < Decimal::ONE || c.price <= Decimal::ZERO {
                            return false;
                        }
                        let neg: HashMap<String, Decimal> = c
                            .exposure_per_share
                            .iter()
                            .map(|(k, v)| (k.clone(), -*v))
                            .collect();
                        let da = Self::total_drift_with_buy(
                            &values,
                            categories,
                            total_value,
                            &neg,
                            profile,
                        );
                        (drift_before - da) > Decimal::ZERO
                    })
                    .count();

                if improving_count == 1 {
                    let mut cap = qty_remaining[idx].floor().max(Decimal::ONE);
                    for cat in categories.iter().filter(|c| c.is_required && !c.is_cash) {
                        let Some(expo) = candidate.exposure_per_share.get(&cat.category_id) else {
                            continue;
                        };
                        if *expo <= Decimal::ZERO {
                            continue;
                        }
                        let current_v = values.get(&cat.category_id).copied().unwrap_or_default();
                        let cat_band = Decimal::from(profile.effective_band_bps(cat.target_bps));
                        let stop_bps = match profile.rebalance_goal {
                            RebalanceGoal::ExactTarget => Decimal::from(cat.target_bps),
                            RebalanceGoal::NearestBand => {
                                (Decimal::from(cat.target_bps) + cat_band).min(dec!(10000))
                            }
                        };
                        let stop_value = stop_bps / dec!(10000) * total_value;
                        if current_v > stop_value {
                            let shares_to_stop =
                                ((current_v - stop_value) / expo).floor().max(Decimal::ONE);
                            if shares_to_stop < cap {
                                cap = shares_to_stop;
                            }
                        }
                    }
                    cap.min(qty_remaining[idx])
                } else {
                    Decimal::ONE
                }
            } else {
                best_sell_shares
            };

            let mut actual = batch.min(qty_remaining[idx]);
            if actual <= Decimal::ZERO {
                break;
            }

            if let Some(cap) = turnover_cap_value {
                let sell_amount = candidate.price * actual;
                let remaining_budget = (cap - cumulative_sold).max(Decimal::ZERO);
                if remaining_budget <= Decimal::ZERO {
                    turnover_cap_reached = true;
                    break;
                }
                if sell_amount > remaining_budget {
                    let capped_shares = remaining_budget / candidate.price;
                    actual = if profile.whole_shares_only {
                        let floored = capped_shares.floor();
                        if floored <= Decimal::ZERO {
                            turnover_cap_reached = true;
                            break;
                        }
                        floored
                    } else {
                        capped_shares
                    };
                }
            }

            cumulative_sold += candidate.price * actual;

            for (cat_id, expo) in &candidate.exposure_per_share {
                let entry = values.entry(cat_id.clone()).or_default();
                *entry = (*entry - expo * actual).max(Decimal::ZERO);
            }
            qty_remaining[idx] -= actual;
            shares_sold[idx] += actual;
        }

        let mut kept_values = initial_values;
        let mut proceeds = Decimal::ZERO;
        let mut sell_trades: Vec<SuggestedManualTrade> = Vec::new();

        for (candidate, &shares) in sell_candidates.iter().zip(shares_sold.iter()) {
            if shares <= Decimal::ZERO {
                continue;
            }

            let estimated_amount = shares * candidate.price;
            if profile.min_trade_amount > Decimal::ZERO
                && estimated_amount < profile.min_trade_amount
            {
                continue;
            }

            let (primary_cat_id, primary_cat_name) = candidate
                .exposure_per_share
                .iter()
                .max_by(|(_, a), (_, b)| a.cmp(b))
                .map(|(cat_id, _)| {
                    let name = categories
                        .iter()
                        .find(|c| &c.category_id == cat_id)
                        .map(|c| c.category_name.clone())
                        .unwrap_or_else(|| cat_id.clone());
                    (cat_id.clone(), name)
                })
                .unwrap_or_else(|| ("unknown".to_string(), "Unknown".to_string()));

            let drift_info = if total_value > Decimal::ZERO {
                let cat_current_bps = kept_values
                    .get(&primary_cat_id)
                    .copied()
                    .unwrap_or_default()
                    / total_value
                    * scale;
                let cat_target_bps = categories
                    .iter()
                    .find(|c| c.category_id == primary_cat_id)
                    .map(|c| c.target_bps)
                    .unwrap_or(0);
                let overweight_bps = (cat_current_bps - Decimal::from(cat_target_bps))
                    .round()
                    .to_string()
                    .parse::<i32>()
                    .unwrap_or(0);
                if overweight_bps > 0 {
                    format!(
                        "Sell {}: {} overweight by {} bps.",
                        candidate.symbol, primary_cat_name, overweight_bps
                    )
                } else {
                    format!(
                        "Sell {}: reduces {} drift.",
                        candidate.symbol, primary_cat_name
                    )
                }
            } else {
                format!("Sell {}: reduces portfolio drift.", candidate.symbol)
            };

            for (cat_id, expo) in &candidate.exposure_per_share {
                let entry = kept_values.entry(cat_id.clone()).or_default();
                *entry = (*entry - expo * shares).max(Decimal::ZERO);
            }
            proceeds += estimated_amount;

            sell_trades.push(SuggestedManualTrade {
                action: "sell".to_string(),
                category_id: primary_cat_id,
                category_name: primary_cat_name,
                asset_id: Some(candidate.asset_id.clone()),
                account_id: Some(candidate.account_id.clone()),
                holding_id: Some(candidate.holding_id.clone()),
                symbol: Some(candidate.symbol.clone()),
                name: candidate.name.clone(),
                quantity: Some(shares),
                estimated_price: Some(candidate.price),
                estimated_amount,
                reason: drift_info,
            });
        }

        if turnover_cap_reached && proceeds > Decimal::ZERO {
            warnings.push(RebalanceWarning {
                kind: RebalanceWarningKind::TurnoverCapReached,
                category_id: String::new(),
                message: format!(
                    "Turnover cap ({:.1}%) reached — {:.2} of {:.2} portfolio already sold.",
                    max_turnover_bps.unwrap_or_default() / dec!(100),
                    proceeds,
                    total_value,
                ),
            });
        }

        (kept_values, proceeds, sell_trades)
    }

    /// Proportional top-up: after the drift-improving greedy exhausts its gains, deploy
    /// remaining cash proportionally to `target_bps` weights. Each sleeve gets the
    /// candidate with the highest category exposure per invested dollar.
    ///
    /// Accumulates into the caller's `shares_bought` so greedy + top-up shares for the
    /// same asset merge into a single output trade.
    ///
    /// Only called for CashFlowOnly and Hybrid (SellToRebalance leaves remaining proceeds
    /// as cash_remaining to avoid circular sell→buy patterns).
    fn run_proportional_topup(
        values: &mut HashMap<String, Decimal>,
        candidates: &[AssetCandidate],
        shares_bought: &mut [Decimal],
        cash: Decimal,
        categories: &[CategoryState],
        profile: &RebalanceProfile,
    ) {
        if cash <= Decimal::ZERO || candidates.is_empty() {
            return;
        }

        let required_cats: Vec<&CategoryState> = categories
            .iter()
            .filter(|c| c.is_required && !c.is_cash && c.target_bps > 0)
            .collect();

        let total_target_bps: i32 = required_cats.iter().map(|c| c.target_bps).sum();
        if total_target_bps == 0 {
            return;
        }

        // Stable allocation order: largest sleeve first, then by category_id.
        let mut cats_sorted = required_cats;
        cats_sorted.sort_by(|a, b| {
            b.target_bps
                .cmp(&a.target_bps)
                .then(a.category_id.cmp(&b.category_id))
        });

        let mut remaining = cash;

        for cat in cats_sorted {
            if remaining <= Decimal::ZERO {
                break;
            }

            // Budget for this sleeve, capped at what's left.
            let sleeve_budget = (cash * Decimal::from(cat.target_bps)
                / Decimal::from(total_target_bps))
            .min(remaining);

            if sleeve_budget <= Decimal::ZERO {
                continue;
            }

            // Best candidate = highest category exposure per invested dollar.
            // Tie-break: lower price preferred (consistent with greedy tie-break).
            let best = candidates
                .iter()
                .enumerate()
                .filter_map(|(idx, candidate)| {
                    let exposure = candidate
                        .exposure_per_share
                        .get(&cat.category_id)
                        .copied()
                        .filter(|e| *e > Decimal::ZERO)?;
                    if candidate.price <= Decimal::ZERO {
                        return None;
                    }
                    let shares = Self::topup_shares_for_budget(candidate, sleeve_budget, profile);
                    if shares <= Decimal::ZERO {
                        return None;
                    }
                    Some((idx, candidate, shares, exposure / candidate.price))
                })
                .max_by(|(_, a, _, score_a), (_, b, _, score_b)| {
                    score_a
                        .cmp(score_b)
                        .then(b.price.cmp(&a.price))
                        .then(b.symbol.cmp(&a.symbol))
                        .then(b.asset_id.cmp(&a.asset_id))
                });

            let Some((best_idx, best_candidate, shares, _)) = best else {
                continue;
            };

            let amount = shares * best_candidate.price;

            for (cat_id, expo) in &best_candidate.exposure_per_share {
                *values.entry(cat_id.clone()).or_default() += expo * shares;
            }
            remaining -= amount;
            shares_bought[best_idx] += shares;
        }
    }

    fn run_buy_greedy(
        values: &mut HashMap<String, Decimal>,
        candidates: &[AssetCandidate],
        cash_pool: Decimal,
        categories: &[CategoryState],
        profile: &RebalanceProfile,
        total_value: Decimal,
        scale: Decimal,
    ) -> Vec<Decimal> {
        let mut shares_bought = vec![Decimal::ZERO; candidates.len()];
        let mut cash = cash_pool;

        loop {
            if cash <= Decimal::ZERO {
                break;
            }
            let drift_before = Self::total_drift(values, categories, total_value, profile);

            let mut best_score = Decimal::ZERO;
            let mut best_idx: Option<usize> = None;
            let mut best_fractional_shares = Decimal::ZERO;
            let mut improving_whole_share_candidates = 0usize;

            for (idx, candidate) in candidates.iter().enumerate() {
                let (shares_to_score, amount_to_score, exposure_to_score) =
                    if profile.whole_shares_only {
                        if cash < candidate.price {
                            continue;
                        }
                        (
                            Decimal::ONE,
                            candidate.price,
                            candidate.exposure_per_share.clone(),
                        )
                    } else {
                        let shares = Self::cap_fractional_shares_to_next_bend(
                            candidate,
                            cash,
                            values,
                            categories,
                            total_value,
                            profile,
                        );
                        if shares <= Decimal::ZERO {
                            continue;
                        }
                        (
                            shares,
                            candidate.price * shares,
                            Self::exposure_delta(&candidate.exposure_per_share, shares),
                        )
                    };

                let drift_after = Self::total_drift_with_buy(
                    values,
                    categories,
                    total_value,
                    &exposure_to_score,
                    profile,
                );
                let improvement = drift_before - drift_after;
                if improvement <= Decimal::ZERO {
                    continue;
                }
                if profile.whole_shares_only {
                    improving_whole_share_candidates += 1;
                }
                let score = improvement / amount_to_score;
                if score > best_score {
                    best_score = score;
                    best_idx = Some(idx);
                    best_fractional_shares = shares_to_score;
                }
            }

            let Some(idx) = best_idx else { break };
            let candidate = &candidates[idx];

            if !profile.whole_shares_only {
                for (cat_id, expo) in &candidate.exposure_per_share {
                    *values.entry(cat_id.clone()).or_default() += expo * best_fractional_shares;
                }
                cash -= candidate.price * best_fractional_shares;
                shares_bought[idx] += best_fractional_shares;
                continue;
            }

            let mut batch = Decimal::ONE;
            if improving_whole_share_candidates == 1 {
                batch = (cash / candidate.price).floor().max(Decimal::ONE);
                for cat in categories.iter().filter(|c| c.is_required && !c.is_cash) {
                    let Some(expo) = candidate.exposure_per_share.get(&cat.category_id) else {
                        continue;
                    };
                    if *expo <= Decimal::ZERO {
                        continue;
                    }
                    let cat_band_bps = profile.effective_band_bps(cat.target_bps);
                    let desired_bps = Self::desired_bps_for_goal(
                        cat.target_bps,
                        &profile.rebalance_goal,
                        cat_band_bps,
                    );
                    let desired_value = desired_bps / scale * total_value;
                    let base = values.get(&cat.category_id).copied().unwrap_or_default();
                    if base < desired_value {
                        let cap = ((desired_value - base) / expo).floor().max(Decimal::ONE);
                        if cap < batch {
                            batch = cap;
                        }
                    }
                }
            }

            for (cat_id, expo) in &candidate.exposure_per_share {
                *values.entry(cat_id.clone()).or_default() += expo * batch;
            }
            cash -= candidate.price * batch;
            shares_bought[idx] += batch;
        }

        shares_bought
    }

    /// Max |current_bps[c] - target_bps[c]| for required categories (including cash).
    fn max_drift_bps(
        values: &HashMap<String, Decimal>,
        categories: &[CategoryState],
        total_value: Decimal,
    ) -> i32 {
        if total_value == Decimal::ZERO {
            return 0;
        }
        let scale = dec!(10000);
        categories
            .iter()
            .filter(|c| c.is_required)
            .map(|c| {
                let v = values.get(&c.category_id).copied().unwrap_or_default();
                let bps: i32 = (v / total_value * scale)
                    .round()
                    .to_string()
                    .parse()
                    .unwrap_or(0);
                (bps - c.target_bps).abs()
            })
            .max()
            .unwrap_or(0)
    }
}

impl RebalanceOptimizer for DriftPriorityOptimizer {
    fn plan(&self, input: RebalanceInput) -> CoreResult<RebalancePlan> {
        let RebalanceInput {
            profile,
            scenario_mode,
            available_cash,
            total_value,
            categories,
            mut candidates,
            sell_candidates,
            mut warnings,
            max_turnover_bps,
        } = input;

        if total_value == Decimal::ZERO && available_cash == Decimal::ZERO {
            return Ok(RebalancePlan {
                target_id: profile.target_id,
                available_cash: Decimal::ZERO,
                cash_used: Decimal::ZERO,
                cash_remaining: Decimal::ZERO,
                max_drift_bps_before: 0,
                max_drift_bps_after: 0,
                trades: vec![],
                warnings,
                after_bps_by_category: HashMap::new(),
            });
        }

        let scale = dec!(10000);

        let mut values: HashMap<String, Decimal> = categories
            .iter()
            .map(|c| (c.category_id.clone(), c.current_value))
            .collect();

        let max_drift_before = Self::max_drift_bps(&values, &categories, total_value);

        // ── Sell phase (SellToRebalance / Hybrid) ────────────────────────────
        //
        // SellToRebalance: always sells overweight, buy pool = sell proceeds only
        //   (available_cash is not used for buys; it stays in the account).
        //
        // Hybrid: uses available cash first. Only sells if at least one required
        //   category is currently overweight outside its band — cash buys cannot
        //   reduce an overweight, so sells are necessary. Buy pool = cash + proceeds.
        //
        // CashFlowOnly: no sells, buy pool = available_cash.

        // Sell phase runs here only for SellToRebalance.
        // Hybrid defers its sell phase to after the cash buy pass (two-pass below).
        let (mut sell_trades, mut sell_proceeds) = match &scenario_mode {
            ScenarioMode::SellToRebalance => {
                let (updated_values, proceeds, trades) = Self::run_sell_phase(
                    &values,
                    total_value,
                    &categories,
                    &sell_candidates,
                    &profile,
                    max_turnover_bps,
                    &mut warnings,
                );
                values = updated_values;
                (trades, proceeds)
            }
            _ => (vec![], Decimal::ZERO),
        };

        // Buy pool:
        //   SellToRebalance → sell proceeds only (available_cash untouched).
        //   Hybrid          → available_cash only for pass 1; proceeds added in pass 2.
        //   CashFlowOnly    → available_cash only.
        let buy_pool = match &scenario_mode {
            ScenarioMode::SellToRebalance => sell_proceeds,
            _ => available_cash,
        };

        // ── Emit NoBuyCandidate for required underweight categories with no candidate coverage.
        // Track them so sleeve-level dollar trades can be added after the greedy.
        let mut no_candidate_categories: Vec<&CategoryState> = Vec::new();
        for cat in categories.iter().filter(|c| c.is_required && !c.is_cash) {
            let cat_band_bps = profile.effective_band_bps(cat.target_bps);
            let desired_bps =
                Self::desired_bps_for_goal(cat.target_bps, &profile.rebalance_goal, cat_band_bps);
            let desired_value = desired_bps / scale * total_value;
            if cat.current_value >= desired_value {
                continue;
            }
            let covered = candidates
                .iter()
                .any(|c| c.exposure_per_share.contains_key(&cat.category_id));
            if !covered {
                let shortfall = (desired_value - cat.current_value).max(Decimal::ZERO);
                warnings.push(RebalanceWarning {
                    kind: RebalanceWarningKind::NoBuyCandidate,
                    category_id: cat.category_id.clone(),
                    message: format!(
                        "No classifiable holdings in {}. Allocate {:.2} to this category manually.",
                        cat.category_name, shortfall,
                    ),
                });
                no_candidate_categories.push(cat);
            }
        }

        // Sort by price ASC for tie-breaking on equal scores, then by (symbol, asset_id)
        // so equal-price candidates have a stable, reproducible order across runs.
        candidates.sort_by(|a, b| {
            a.price
                .cmp(&b.price)
                .then_with(|| a.symbol.cmp(&b.symbol))
                .then_with(|| a.asset_id.cmp(&b.asset_id))
        });

        let values_before_buy_trades = values.clone();

        // ── Buy phase(s) via run_buy_greedy ──────────────────────────────────
        //
        // CashFlowOnly / SellToRebalance: single pass with buy_pool.
        //
        // Hybrid (two-pass):
        //   Pass 1 — deploy available_cash first.
        //   Pass 2 — if overweight categories remain after cash buys, run sell
        //             phase on the post-buy state, then deploy proceeds.
        //   This implements "use cash first, sell only what cash cannot fix."

        let shares_bought: Vec<Decimal> = match &scenario_mode {
            ScenarioMode::Hybrid => {
                let mut sb = Self::run_buy_greedy(
                    &mut values,
                    &candidates,
                    available_cash,
                    &categories,
                    &profile,
                    total_value,
                    scale,
                );

                let still_overweight = categories
                    .iter()
                    .filter(|c| c.is_required && !c.is_cash)
                    .any(|c| {
                        if total_value == Decimal::ZERO {
                            return false;
                        }
                        let v = values.get(&c.category_id).copied().unwrap_or_default();
                        let bps = v / total_value * scale;
                        let cat_band = Decimal::from(profile.effective_band_bps(c.target_bps));
                        let threshold = match profile.rebalance_goal {
                            RebalanceGoal::ExactTarget => Decimal::from(c.target_bps),
                            RebalanceGoal::NearestBand => {
                                (Decimal::from(c.target_bps) + cat_band).min(dec!(10000))
                            }
                        };
                        bps > threshold
                    });

                if still_overweight && !sell_candidates.is_empty() {
                    let (updated_values, proceeds, extra_sell_trades) = Self::run_sell_phase(
                        &values,
                        total_value,
                        &categories,
                        &sell_candidates,
                        &profile,
                        max_turnover_bps,
                        &mut warnings,
                    );
                    values = updated_values;
                    let sb2 = Self::run_buy_greedy(
                        &mut values,
                        &candidates,
                        proceeds,
                        &categories,
                        &profile,
                        total_value,
                        scale,
                    );
                    for (i, s) in sb2.into_iter().enumerate() {
                        sb[i] += s;
                    }
                    sell_trades = extra_sell_trades;
                    sell_proceeds = proceeds;
                }

                sb
            }
            _ => Self::run_buy_greedy(
                &mut values,
                &candidates,
                buy_pool,
                &categories,
                &profile,
                total_value,
                scale,
            ),
        };

        let mut shares_bought = shares_bought;
        if !matches!(scenario_mode, ScenarioMode::SellToRebalance) {
            let topup_pool = match &scenario_mode {
                ScenarioMode::Hybrid => available_cash + sell_proceeds,
                _ => buy_pool,
            };
            let greedy_used: Decimal = shares_bought
                .iter()
                .zip(candidates.iter())
                .map(|(s, c)| s * c.price)
                .sum();
            let topup_cash = (topup_pool - greedy_used).max(Decimal::ZERO);
            let topup_cash = match Self::remaining_cash_excess_after_buys(
                &categories,
                total_value,
                &profile,
                sell_proceeds,
                greedy_used,
            ) {
                Some(cash_excess) => topup_cash.min(cash_excess),
                None => topup_cash,
            };
            if topup_cash > Decimal::ZERO {
                Self::run_proportional_topup(
                    &mut values,
                    &candidates,
                    &mut shares_bought,
                    topup_cash,
                    &categories,
                    &profile,
                );
            }
        }

        // Build trades from accumulated shares; apply min_trade_amount filter.
        let mut trades: Vec<SuggestedManualTrade> = Vec::new();
        let mut buy_reason_values = values_before_buy_trades;

        for (idx, &shares) in shares_bought.iter().enumerate() {
            if shares == Decimal::ZERO {
                continue;
            }
            let candidate = &candidates[idx];
            let estimated_amount = shares * candidate.price;

            if profile.min_trade_amount > Decimal::ZERO
                && estimated_amount < profile.min_trade_amount
            {
                continue;
            }

            // Primary category = category with the largest per-share exposure.
            let (primary_cat_id, primary_cat_name) = candidate
                .exposure_per_share
                .iter()
                .max_by(|(_, a), (_, b)| a.cmp(b))
                .map(|(cat_id, _)| {
                    let name = categories
                        .iter()
                        .find(|c| &c.category_id == cat_id)
                        .map(|c| c.category_name.clone())
                        .unwrap_or_else(|| cat_id.clone());
                    (cat_id.clone(), name)
                })
                .unwrap_or_else(|| ("unknown".to_string(), "Unknown".to_string()));

            let buy_reason = if total_value > Decimal::ZERO {
                let cat_target_bps = categories
                    .iter()
                    .find(|c| c.category_id == primary_cat_id)
                    .map(|c| c.target_bps)
                    .unwrap_or(0);
                let cat_current_value = categories
                    .iter()
                    .find(|c| c.category_id == primary_cat_id)
                    .and_then(|c| buy_reason_values.get(&c.category_id).copied())
                    .unwrap_or_default();
                let current_bps: i32 = (cat_current_value / total_value * dec!(10000))
                    .round()
                    .to_string()
                    .parse()
                    .unwrap_or(0);
                let underweight_bps = cat_target_bps - current_bps;
                if underweight_bps > 0 {
                    format!(
                        "Buy {}: {} underweight by {} bps.",
                        candidate.symbol, primary_cat_name, underweight_bps
                    )
                } else {
                    format!(
                        "Buy {}: improves {} drift.",
                        candidate.symbol, primary_cat_name
                    )
                }
            } else {
                format!("Buy {}: improves portfolio drift.", candidate.symbol)
            };

            trades.push(SuggestedManualTrade {
                action: "buy".to_string(),
                category_id: primary_cat_id,
                category_name: primary_cat_name,
                asset_id: Some(candidate.asset_id.clone()),
                account_id: None,
                holding_id: None,
                symbol: Some(candidate.symbol.clone()),
                name: candidate.name.clone(),
                quantity: Some(shares),
                estimated_price: Some(candidate.price),
                estimated_amount,
                reason: buy_reason,
            });

            for (cat_id, expo) in &candidate.exposure_per_share {
                *buy_reason_values.entry(cat_id.clone()).or_default() += expo * shares;
            }
        }

        // Sleeve-level dollar trades for uncovered underweight categories.
        // Draw from cash left after kept asset trades (including sell proceeds).
        // For Hybrid, buy_pool = available_cash but pass-2b also consumed sell_proceeds —
        // so the actual pool is available_cash + sell_proceeds.
        let total_buy_pool = match &scenario_mode {
            ScenarioMode::Hybrid => available_cash + sell_proceeds,
            _ => buy_pool,
        };
        let mut manual_cash = (total_buy_pool
            - trades.iter().map(|t| t.estimated_amount).sum::<Decimal>())
        .max(Decimal::ZERO);
        for cat in &no_candidate_categories {
            if manual_cash <= Decimal::ZERO {
                break;
            }
            let cat_band_bps = profile.effective_band_bps(cat.target_bps);
            let desired_bps =
                Self::desired_bps_for_goal(cat.target_bps, &profile.rebalance_goal, cat_band_bps);
            let shortfall =
                ((desired_bps / scale * total_value) - cat.current_value).max(Decimal::ZERO);
            let amount = shortfall.min(manual_cash);
            if amount > Decimal::ZERO {
                manual_cash -= amount;
                trades.push(SuggestedManualTrade {
                    action: "buy".to_string(),
                    category_id: cat.category_id.clone(),
                    category_name: cat.category_name.clone(),
                    asset_id: None,
                    account_id: None,
                    holding_id: None,
                    symbol: None,
                    name: None,
                    quantity: None,
                    estimated_price: None,
                    estimated_amount: amount,
                    reason: format!(
                        "{} is underweight — no classified holding available. Allocate manually.",
                        cat.category_name
                    ),
                });
            }
        }

        // Prepend sell trades so the final list is: sells then buys.
        let mut all_trades: Vec<SuggestedManualTrade> = sell_trades;
        all_trades.append(&mut trades);
        let trades = all_trades;

        // cash_used = sum of buy trade amounts (post min_trade filter).
        // cash_remaining = original cash + sell proceeds - cash deployed on buys.
        let buy_cash_used: Decimal = trades
            .iter()
            .filter(|t| t.action == "buy")
            .map(|t| t.estimated_amount)
            .sum();
        let cash_used = buy_cash_used;
        let cash_remaining = (available_cash + sell_proceeds - cash_used).max(Decimal::ZERO);

        // After-drift: recompute from initial state + all recommended trades.
        let mut after_values: HashMap<String, Decimal> = categories
            .iter()
            .map(|c| (c.category_id.clone(), c.current_value))
            .collect();
        for trade in &trades {
            let shares = trade.quantity.unwrap_or(Decimal::ZERO);
            if trade.action == "sell" {
                if let Some(asset_id) = &trade.asset_id {
                    if let Some(sc) = sell_candidates.iter().find(|c| &c.asset_id == asset_id) {
                        for (cat_id, expo) in &sc.exposure_per_share {
                            let entry = after_values.entry(cat_id.clone()).or_default();
                            *entry = (*entry - expo * shares).max(Decimal::ZERO);
                        }
                    }
                }
            } else if let Some(asset_id) = &trade.asset_id {
                if let Some(candidate) = candidates.iter().find(|c| &c.asset_id == asset_id) {
                    for (cat_id, expo) in &candidate.exposure_per_share {
                        *after_values.entry(cat_id.clone()).or_default() += expo * shares;
                    }
                }
            } else {
                // Manual sleeve trade: deployed cash lands in target category.
                *after_values.entry(trade.category_id.clone()).or_default() +=
                    trade.estimated_amount;
            }
        }
        // Update cash sleeve: reduce by net cash deployed (buys - sell proceeds).
        let net_cash_change = cash_used - sell_proceeds;
        for cat in categories.iter().filter(|c| c.is_cash) {
            let entry = after_values.entry(cat.category_id.clone()).or_default();
            *entry = (*entry - net_cash_change).max(Decimal::ZERO);
        }
        let max_drift_after = Self::max_drift_bps(&after_values, &categories, total_value);

        let after_bps_by_category: HashMap<String, i32> = if total_value > Decimal::ZERO {
            after_values
                .iter()
                .map(|(cat_id, val)| {
                    let bps: i32 = (*val / total_value * scale)
                        .round()
                        .to_string()
                        .parse()
                        .unwrap_or(0);
                    (cat_id.clone(), bps)
                })
                .collect()
        } else {
            HashMap::new()
        };

        Ok(RebalancePlan {
            target_id: profile.target_id,
            available_cash,
            cash_used,
            cash_remaining,
            max_drift_bps_before: max_drift_before,
            max_drift_bps_after: max_drift_after,
            trades,
            warnings,
            after_bps_by_category,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filtered_sell_trade_does_not_mutate_returned_values() {
        let values = HashMap::from([
            ("equity".to_string(), dec!(3000)),
            ("bond".to_string(), dec!(7000)),
        ]);
        let categories = vec![
            CategoryState {
                category_id: "equity".to_string(),
                category_name: "Equity".to_string(),
                target_bps: 7000,
                current_value: dec!(3000),
                is_cash: false,
                is_required: true,
            },
            CategoryState {
                category_id: "bond".to_string(),
                category_name: "Bond".to_string(),
                target_bps: 3000,
                current_value: dec!(7000),
                is_cash: false,
                is_required: true,
            },
        ];
        let sell_candidates = vec![SellCandidate {
            holding_id: "h-bond".to_string(),
            asset_id: "a-bond".to_string(),
            account_id: "acc-1".to_string(),
            source_account_ids: vec!["acc-1".to_string()],
            symbol: "BND".to_string(),
            name: Some("BND".to_string()),
            price: dec!(100),
            quantity_owned: dec!(1),
            exposure_per_share: HashMap::from([("bond".to_string(), dec!(100))]),
        }];

        let profile = RebalanceProfile {
            target_id: "test".to_string(),
            drift_band_bps: 500,
            band_type: BandType::Absolute,
            relative_factor_bps: 2000,
            rebalance_goal: RebalanceGoal::ExactTarget,
            min_trade_amount: dec!(500),
            whole_shares_only: false,
        };
        let mut warnings = vec![];
        let (updated_values, proceeds, trades) = DriftPriorityOptimizer::run_sell_phase(
            &values,
            dec!(10000),
            &categories,
            &sell_candidates,
            &profile,
            None,
            &mut warnings,
        );

        assert!(trades.is_empty(), "sub-minimum sell should be filtered");
        assert_eq!(proceeds, Decimal::ZERO);
        assert_eq!(
            updated_values.get("bond").copied(),
            Some(dec!(7000)),
            "filtered sells must not alter the state used by the buy phase"
        );
    }

    #[test]
    fn turnover_cap_ignores_sub_minimum_dropped_sells() {
        let optimizer = DriftPriorityOptimizer;
        let mut input = make_sell_rebalance_input();
        input.profile.min_trade_amount = dec!(100);
        input.max_turnover_bps = Some(dec!(50)); // 0.5% of $10,000 = $50

        let plan = optimizer.plan(input).unwrap();

        assert!(
            plan.trades.iter().all(|trade| trade.action != "sell"),
            "cap only allows a $50 sell, which is below the $100 min trade"
        );
        assert!(
            !plan
                .warnings
                .iter()
                .any(|warning| warning.kind == RebalanceWarningKind::TurnoverCapReached),
            "a sell dropped by min_trade_amount must not consume turnover budget"
        );
    }

    fn make_two_sleeve_input(band_type: BandType) -> RebalanceInput {
        // EQUITY 60% target, currently 68% (overweight +800 bps)
        // BOND   40% target, currently 32% (underweight -800 bps)
        // Cash: $500. Band floor: 500 bps. Relative factor: 20%.
        //
        // Absolute effective bands: EQUITY=500, BOND=500
        //   → BOND desired = 4000-500 = 3500 bps, current 3200 → greedy buys BOND first
        //
        // Hybrid effective bands: EQUITY=max(6000*20%,500)=1200, BOND=max(4000*20%,500)=800
        //   → BOND desired = 4000-800 = 3200 bps, current 3200 → already at desired
        //   → greedy has nothing to do, all cash goes to proportional top-up
        RebalanceInput {
            profile: RebalanceProfile {
                target_id: "test".to_string(),
                drift_band_bps: 500,
                band_type,
                relative_factor_bps: 2000,
                rebalance_goal: RebalanceGoal::NearestBand,
                min_trade_amount: Decimal::ZERO,
                whole_shares_only: false,
            },
            scenario_mode: ScenarioMode::CashFlowOnly,
            available_cash: dec!(500),
            total_value: dec!(10000),
            categories: vec![
                CategoryState {
                    category_id: "equity".to_string(),
                    category_name: "Equity".to_string(),
                    target_bps: 6000,
                    current_value: dec!(6800),
                    is_cash: false,
                    is_required: true,
                },
                CategoryState {
                    category_id: "bond".to_string(),
                    category_name: "Bond".to_string(),
                    target_bps: 4000,
                    current_value: dec!(3200),
                    is_cash: false,
                    is_required: true,
                },
            ],
            candidates: vec![
                AssetCandidate {
                    holding_id: "h-vti".to_string(),
                    asset_id: "a-vti".to_string(),
                    symbol: "VTI".to_string(),
                    name: Some("Vanguard Total Stock".to_string()),
                    price: dec!(50),
                    exposure_per_share: HashMap::from([("equity".to_string(), dec!(50))]),
                },
                AssetCandidate {
                    holding_id: "h-bnd".to_string(),
                    asset_id: "a-bnd".to_string(),
                    symbol: "BND".to_string(),
                    name: Some("Vanguard Total Bond".to_string()),
                    price: dec!(50),
                    exposure_per_share: HashMap::from([("bond".to_string(), dec!(50))]),
                },
            ],
            sell_candidates: vec![],
            warnings: vec![],
            max_turnover_bps: None,
        }
    }

    fn buy_amount_for(plan: &RebalancePlan, symbol: &str) -> Decimal {
        plan.trades
            .iter()
            .filter(|t| t.action == "buy" && t.symbol.as_deref() == Some(symbol))
            .map(|t| t.estimated_amount)
            .sum()
    }

    #[test]
    fn hybrid_vs_absolute_produces_different_trade_allocation() {
        let optimizer = DriftPriorityOptimizer;

        let abs_plan = optimizer
            .plan(make_two_sleeve_input(BandType::Absolute))
            .unwrap();
        let hyb_plan = optimizer
            .plan(make_two_sleeve_input(BandType::Hybrid))
            .unwrap();

        let abs_bnd = buy_amount_for(&abs_plan, "BND");
        let abs_vti = buy_amount_for(&abs_plan, "VTI");
        let hyb_bnd = buy_amount_for(&hyb_plan, "BND");
        let hyb_vti = buy_amount_for(&hyb_plan, "VTI");

        // Absolute: BOND is underweight outside band → greedy prioritizes BND
        assert!(
            abs_bnd > abs_vti,
            "absolute should buy more BND ({abs_bnd}) than VTI ({abs_vti})"
        );

        // Hybrid: BOND is at desired level → proportional top-up favors larger-weight EQUITY
        assert!(
            hyb_vti > hyb_bnd,
            "hybrid should buy more VTI ({hyb_vti}) than BND ({hyb_bnd})"
        );

        // Both use all available cash
        let abs_total = abs_bnd + abs_vti;
        let hyb_total = hyb_bnd + hyb_vti;
        assert!(abs_total > Decimal::ZERO);
        assert!(hyb_total > Decimal::ZERO);
    }

    fn make_sell_rebalance_input() -> RebalanceInput {
        // EQUITY 30% (target 70%), BOND 70% (target 30%).
        // BND is overweight, VTI is underweight.
        RebalanceInput {
            profile: RebalanceProfile {
                target_id: "test".to_string(),
                drift_band_bps: 500,
                band_type: BandType::Absolute,
                relative_factor_bps: 2000,
                rebalance_goal: RebalanceGoal::ExactTarget,
                min_trade_amount: Decimal::ZERO,
                whole_shares_only: false,
            },
            scenario_mode: ScenarioMode::SellToRebalance,
            available_cash: Decimal::ZERO,
            total_value: dec!(10000),
            categories: vec![
                CategoryState {
                    category_id: "equity".to_string(),
                    category_name: "Equity".to_string(),
                    target_bps: 7000,
                    current_value: dec!(3000),
                    is_cash: false,
                    is_required: true,
                },
                CategoryState {
                    category_id: "bond".to_string(),
                    category_name: "Bond".to_string(),
                    target_bps: 3000,
                    current_value: dec!(7000),
                    is_cash: false,
                    is_required: true,
                },
            ],
            candidates: vec![AssetCandidate {
                holding_id: "h-vti".to_string(),
                asset_id: "a-vti".to_string(),
                symbol: "VTI".to_string(),
                name: Some("Vanguard Total Stock".to_string()),
                price: dec!(100),
                exposure_per_share: HashMap::from([("equity".to_string(), dec!(100))]),
            }],
            sell_candidates: vec![SellCandidate {
                holding_id: "h-bnd".to_string(),
                asset_id: "a-bnd".to_string(),
                account_id: "acc-1".to_string(),
                source_account_ids: vec!["acc-1".to_string()],
                symbol: "BND".to_string(),
                name: Some("Vanguard Total Bond".to_string()),
                price: dec!(100),
                quantity_owned: dec!(70),
                exposure_per_share: HashMap::from([("bond".to_string(), dec!(100))]),
            }],
            warnings: vec![],
            max_turnover_bps: None,
        }
    }

    #[test]
    fn turnover_cap_limits_sell_amount() {
        let optimizer = DriftPriorityOptimizer;
        let mut input = make_sell_rebalance_input();
        // Cap at 10% turnover = $1000 max sold out of $10000
        input.max_turnover_bps = Some(dec!(1000));

        let plan = optimizer.plan(input).unwrap();

        let sell_total: Decimal = plan
            .trades
            .iter()
            .filter(|t| t.action == "sell")
            .map(|t| t.estimated_amount)
            .sum();

        assert!(
            sell_total <= dec!(1000),
            "sell total ({sell_total}) should not exceed 10% turnover cap ($1000)"
        );
        assert!(
            plan.warnings
                .iter()
                .any(|w| w.kind == RebalanceWarningKind::TurnoverCapReached),
            "should emit TurnoverCapReached warning"
        );
    }

    #[test]
    fn turnover_cap_warning_formats_basis_points_as_percent() {
        let optimizer = DriftPriorityOptimizer;
        let mut input = make_sell_rebalance_input();
        input.profile.whole_shares_only = true;
        input.max_turnover_bps = Some(dec!(100));

        let plan = optimizer.plan(input).unwrap();

        let warning = plan
            .warnings
            .iter()
            .find(|w| w.kind == RebalanceWarningKind::TurnoverCapReached)
            .expect("turnover warning expected");
        assert!(
            warning.message.contains("(1.0%)"),
            "turnover warning should format bps as percent: {}",
            warning.message
        );
    }

    #[test]
    fn sell_trade_preserves_account_and_holding_context() {
        let optimizer = DriftPriorityOptimizer;
        let input = make_sell_rebalance_input();

        let plan = optimizer.plan(input).unwrap();

        let sell = plan
            .trades
            .iter()
            .find(|t| t.action == "sell")
            .expect("sell trade expected");
        assert_eq!(sell.account_id.as_deref(), Some("acc-1"));
        assert_eq!(sell.holding_id.as_deref(), Some("h-bnd"));
    }

    #[test]
    fn sell_reason_uses_pre_sell_overweight_bps() {
        let optimizer = DriftPriorityOptimizer;
        let input = make_sell_rebalance_input();

        let plan = optimizer.plan(input).unwrap();

        let sell = plan
            .trades
            .iter()
            .find(|t| t.action == "sell")
            .expect("sell trade expected");
        assert!(
            sell.reason.contains("overweight by 4000 bps"),
            "sell reason should describe the pre-sell overweight state: {}",
            sell.reason
        );
    }

    #[test]
    fn no_turnover_cap_sells_as_needed() {
        let optimizer = DriftPriorityOptimizer;
        let input = make_sell_rebalance_input();

        let plan = optimizer.plan(input).unwrap();

        let sell_total: Decimal = plan
            .trades
            .iter()
            .filter(|t| t.action == "sell")
            .map(|t| t.estimated_amount)
            .sum();

        assert!(
            sell_total > dec!(1000),
            "without cap, should sell more than $1000 to fix 40pp drift"
        );
        assert!(
            !plan
                .warnings
                .iter()
                .any(|w| w.kind == RebalanceWarningKind::TurnoverCapReached),
            "no turnover cap warning expected"
        );
    }

    #[test]
    fn buy_reason_includes_underweight_bps() {
        let optimizer = DriftPriorityOptimizer;
        let input = make_two_sleeve_input(BandType::Absolute);
        let plan = optimizer.plan(input).unwrap();

        let bnd_trade = plan
            .trades
            .iter()
            .find(|t| t.symbol.as_deref() == Some("BND"))
            .expect("BND trade expected");
        assert!(
            bnd_trade.reason.contains("underweight"),
            "buy reason should mention underweight: got '{}'",
            bnd_trade.reason
        );
    }

    #[test]
    fn buy_reasons_use_running_underweight_after_prior_buys() {
        let optimizer = DriftPriorityOptimizer;
        let input = RebalanceInput {
            profile: RebalanceProfile {
                target_id: "test".to_string(),
                drift_band_bps: 0,
                band_type: BandType::Absolute,
                relative_factor_bps: 2000,
                rebalance_goal: RebalanceGoal::ExactTarget,
                min_trade_amount: Decimal::ZERO,
                whole_shares_only: true,
            },
            scenario_mode: ScenarioMode::CashFlowOnly,
            available_cash: dec!(250),
            total_value: dec!(10000),
            categories: vec![CategoryState {
                category_id: "equity".to_string(),
                category_name: "Equity".to_string(),
                target_bps: 10000,
                current_value: dec!(6000),
                is_cash: false,
                is_required: true,
            }],
            candidates: vec![
                AssetCandidate {
                    holding_id: "h-big".to_string(),
                    asset_id: "a-big".to_string(),
                    symbol: "BIG".to_string(),
                    name: Some("Big Equity".to_string()),
                    price: dec!(150),
                    exposure_per_share: HashMap::from([("equity".to_string(), dec!(150))]),
                },
                AssetCandidate {
                    holding_id: "h-small".to_string(),
                    asset_id: "a-small".to_string(),
                    symbol: "SMALL".to_string(),
                    name: Some("Small Equity".to_string()),
                    price: dec!(100),
                    exposure_per_share: HashMap::from([("equity".to_string(), dec!(50))]),
                },
            ],
            sell_candidates: vec![],
            warnings: vec![],
            max_turnover_bps: None,
        };

        let plan = optimizer.plan(input).unwrap();
        let equity_reasons: Vec<&str> = plan
            .trades
            .iter()
            .filter(|trade| trade.action == "buy" && trade.category_id == "equity")
            .map(|trade| trade.reason.as_str())
            .collect();

        assert_eq!(equity_reasons.len(), 2, "expected two equity buy trades");
        let stale_reason_count = equity_reasons
            .iter()
            .filter(|reason| reason.contains("underweight by 4000 bps"))
            .count();
        assert_eq!(
            stale_reason_count, 1,
            "only the first buy should report the original underweight: {equity_reasons:?}"
        );
    }
}
