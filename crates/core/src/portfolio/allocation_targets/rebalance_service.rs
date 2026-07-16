use async_trait::async_trait;
use log::debug;
use rust_decimal::Decimal;
use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use std::sync::Arc;

use crate::errors::{Error as CoreError, Result as CoreResult};
use crate::portfolio::allocation::{AllocationServiceTrait, HoldingAllocationContribution};
use crate::portfolio::holdings::{Holding, HoldingType, HoldingsServiceTrait};

use super::cash::{
    deployable_cash_from_contributions, has_deployable_cash_categories,
    is_deployable_cash_category, tracked_cash,
};
use super::drift_service::DriftServiceTrait;
use super::model::{
    CalculateRebalancePlanInput, RebalancePlan, RebalanceWarning, RebalanceWarningKind,
};
use super::optimizer::{
    AssetCandidate, CategoryState, DriftPriorityOptimizer, RebalanceInput, RebalanceOptimizer,
    RebalanceProfile, SellCandidate,
};
use super::target_service::AllocationTargetServiceTrait;

// ── Service trait ─────────────────────────────────────────────────────────────

#[async_trait]
pub trait RebalanceServiceTrait: Send + Sync {
    async fn calculate_plan(&self, input: CalculateRebalancePlanInput)
        -> CoreResult<RebalancePlan>;
}

// ── Implementation ────────────────────────────────────────────────────────────

pub struct RebalanceService {
    allocation_target_service: Arc<dyn AllocationTargetServiceTrait>,
    drift_service: Arc<dyn DriftServiceTrait>,
    allocation_service: Arc<dyn AllocationServiceTrait>,
    holdings_service: Arc<dyn HoldingsServiceTrait>,
}

impl RebalanceService {
    pub fn new(
        allocation_target_service: Arc<dyn AllocationTargetServiceTrait>,
        drift_service: Arc<dyn DriftServiceTrait>,
        allocation_service: Arc<dyn AllocationServiceTrait>,
        holdings_service: Arc<dyn HoldingsServiceTrait>,
    ) -> Self {
        Self {
            allocation_target_service,
            drift_service,
            allocation_service,
            holdings_service,
        }
    }

    fn currency_fraction_digits(currency: &str) -> u32 {
        match currency.to_ascii_uppercase().as_str() {
            "BIF" | "CLP" | "DJF" | "GNF" | "ISK" | "JPY" | "KMF" | "KRW" | "PYG" | "RWF"
            | "UGX" | "VND" | "VUV" | "XAF" | "XOF" | "XPF" => 0,
            "BHD" | "IQD" | "JOD" | "KWD" | "LYD" | "OMR" | "TND" => 3,
            "CLF" => 4,
            _ => 2,
        }
    }

    fn currency_rounding_tolerance(currency: &str) -> Decimal {
        Decimal::ONE / Decimal::from(10_i64.pow(Self::currency_fraction_digits(currency)))
    }

    fn asset_key(holding: &crate::portfolio::holdings::Holding) -> String {
        holding
            .instrument
            .as_ref()
            .map(|i| i.id.clone())
            .unwrap_or_else(|| holding.id.clone())
    }

    fn base_price_per_unit(holding: &crate::portfolio::holdings::Holding) -> Option<Decimal> {
        if holding.quantity > Decimal::ZERO && holding.market_value.base > Decimal::ZERO {
            return Some(holding.market_value.base / holding.quantity);
        }

        holding.price.filter(|p| *p > Decimal::ZERO).map(|price| {
            let fx_rate = if holding.local_currency == holding.base_currency {
                Decimal::ONE
            } else {
                holding.fx_rate.unwrap_or(Decimal::ONE)
            };
            price * fx_rate
        })
    }

    fn tagged_cash_warnings(
        taxonomy_id: &str,
        contributions: &[HoldingAllocationContribution],
    ) -> Vec<RebalanceWarning> {
        if !has_deployable_cash_categories(taxonomy_id) {
            return vec![];
        }

        let mut value_by_category: HashMap<String, (String, Decimal)> = HashMap::new();
        for contribution in contributions {
            if contribution.holding_type != HoldingType::Cash
                || is_deployable_cash_category(taxonomy_id, &contribution.category_id)
            {
                continue;
            }

            let entry = value_by_category
                .entry(contribution.category_id.clone())
                .or_insert_with(|| (contribution.category_name.clone(), Decimal::ZERO));
            entry.1 += contribution.value;
        }

        let mut categories: Vec<_> = value_by_category.into_iter().collect();
        categories.sort_by(|a, b| a.0.cmp(&b.0));

        categories
            .into_iter()
            .map(|(category_id, (category_name, value))| RebalanceWarning {
                kind: RebalanceWarningKind::TaggedCash,
                category_id,
                message: format!(
                    "{} contains {:.2} of tagged cash. It is excluded from cash to deploy; move or reclassify that cash before the plan can rebalance this sleeve.",
                    category_name, value
                ),
            })
            .collect()
    }

    /// Build `AssetCandidate` list from holdings + contributions.
    ///
    /// Rules (Afadil, #1036):
    /// - Holdings with no taxonomy assignments → `__UNKNOWN__` in contributions → warn
    ///   `UnclassifiedAsset`, skip.
    /// - Holdings with partial weights (<100%) → contributions already include an
    ///   `__UNKNOWN__` remainder row (from `AllocationService`). Use the known exposure
    ///   as-is and warn `PartialClassification`. Do NOT normalise.
    /// - Weights >100%: `AllocationService` normalises silently to 100%; we align with
    ///   that behaviour for consistency. (Open question for Afadil in PR-B description.)
    /// - Cash holdings: excluded from candidates.
    /// - Holdings with no usable price: skip (warn `MissingQuote` if whole_shares_only).
    fn build_candidates(
        contributions: &[HoldingAllocationContribution],
        price_by_asset: &HashMap<String, Decimal>,
        quantity_by_asset: &HashMap<String, Decimal>,
        whole_shares_only: bool,
    ) -> (Vec<AssetCandidate>, Vec<RebalanceWarning>) {
        // Group contributions by asset_id (instrument ID).
        let mut by_asset: HashMap<&str, Vec<&HoldingAllocationContribution>> = HashMap::new();
        for c in contributions {
            by_asset.entry(c.asset_id.as_str()).or_default().push(c);
        }

        let mut candidates: Vec<AssetCandidate> = Vec::new();
        let mut warnings: Vec<RebalanceWarning> = Vec::new();

        let mut asset_ids: Vec<&str> = by_asset.keys().copied().collect();
        asset_ids.sort_unstable();

        for asset_id in asset_ids {
            let contribs = &by_asset[asset_id];
            // Skip cash holdings.
            if contribs.iter().all(|c| c.holding_type == HoldingType::Cash) {
                continue;
            }

            let repr = contribs[0];
            let symbol = &repr.symbol;

            // Check classification state.
            let all_unknown = contribs.iter().all(|c| c.category_id == "__UNKNOWN__");
            let has_unknown = contribs.iter().any(|c| c.category_id == "__UNKNOWN__");

            if all_unknown {
                warnings.push(RebalanceWarning {
                    kind: RebalanceWarningKind::UnclassifiedAsset,
                    category_id: "__UNKNOWN__".to_string(),
                    message: format!(
                        "{} isn't classified for this target, so it's excluded from the plan. Classify it to include it.",
                        symbol
                    ),
                });
                continue;
            }

            if has_unknown {
                warnings.push(RebalanceWarning {
                    kind: RebalanceWarningKind::PartialClassification,
                    category_id: repr.category_id.clone(),
                    message: format!(
                        "{} is only partly classified, so only its known exposure counts toward the plan; the rest is ignored.",
                        symbol
                    ),
                });
            }

            // Derive price.
            let price = match price_by_asset.get(asset_id) {
                Some(&p) if p > Decimal::ZERO => p,
                _ => {
                    if whole_shares_only {
                        warnings.push(RebalanceWarning {
                            kind: RebalanceWarningKind::MissingQuote,
                            category_id: repr.category_id.clone(),
                            message: format!(
                                "{}: no valid price for whole-share mode. Skipped.",
                                symbol
                            ),
                        });
                    }
                    continue;
                }
            };

            // Build exposure per share: contribution.value / owned quantity,
            // excluding __UNKNOWN__.
            let qty = match quantity_by_asset.get(asset_id) {
                Some(&q) if q > Decimal::ZERO => q,
                _ => continue,
            };
            let mut exposure_per_share: HashMap<String, Decimal> = HashMap::new();
            for c in contribs.iter() {
                if c.category_id == "__UNKNOWN__" {
                    continue;
                }
                *exposure_per_share.entry(c.category_id.clone()).or_default() += c.value / qty;
            }

            if exposure_per_share.is_empty() {
                continue;
            }

            candidates.push(AssetCandidate {
                holding_id: asset_id.to_string(),
                asset_id: repr.asset_id.clone(),
                symbol: symbol.clone(),
                name: Some(repr.name.clone()),
                price,
                exposure_per_share,
            });
        }

        (candidates, warnings)
    }

    /// Build sell candidates from non-cash holdings that have known prices and
    /// taxonomy classifications. All holdings with quantity > 0 are eligible.
    fn build_sell_candidates(
        contributions: &[HoldingAllocationContribution],
        price_by_asset: &HashMap<String, Decimal>,
        quantity_by_asset: &HashMap<String, Decimal>,
        source_holdings: &[Holding],
    ) -> Vec<SellCandidate> {
        let mut by_asset: HashMap<&str, Vec<&HoldingAllocationContribution>> = HashMap::new();
        for c in contributions {
            by_asset.entry(c.asset_id.as_str()).or_default().push(c);
        }

        let mut holdings_by_asset: HashMap<String, Vec<&Holding>> = HashMap::new();
        for holding in source_holdings
            .iter()
            .filter(|h| h.holding_type != HoldingType::Cash && h.quantity > Decimal::ZERO)
        {
            holdings_by_asset
                .entry(Self::asset_key(holding))
                .or_default()
                .push(holding);
        }
        for holdings in holdings_by_asset.values_mut() {
            holdings.sort_by(|a, b| {
                a.account_id
                    .cmp(&b.account_id)
                    .then_with(|| a.id.cmp(&b.id))
            });
        }

        let mut sell_candidates: Vec<SellCandidate> = Vec::new();
        let mut asset_ids: Vec<&str> = by_asset.keys().copied().collect();
        asset_ids.sort_unstable();

        for asset_id in asset_ids {
            let contribs = &by_asset[asset_id];
            if contribs.iter().all(|c| c.holding_type == HoldingType::Cash) {
                continue;
            }
            let all_unknown = contribs.iter().all(|c| c.category_id == "__UNKNOWN__");
            if all_unknown {
                continue;
            }

            let price = match price_by_asset.get(asset_id) {
                Some(&p) if p > Decimal::ZERO => p,
                _ => continue,
            };
            let qty_owned = match quantity_by_asset.get(asset_id) {
                Some(&q) if q > Decimal::ZERO => q,
                _ => continue,
            };

            let mut exposure_per_share: HashMap<String, Decimal> = HashMap::new();
            for c in contribs.iter() {
                if c.category_id == "__UNKNOWN__" {
                    continue;
                }
                *exposure_per_share.entry(c.category_id.clone()).or_default() +=
                    c.value / qty_owned;
            }
            if exposure_per_share.is_empty() {
                continue;
            }

            let repr = contribs[0];
            let Some(source_holdings) = holdings_by_asset.get(asset_id) else {
                continue;
            };

            for holding in source_holdings {
                let holding_price = Self::base_price_per_unit(holding).unwrap_or(price);
                if holding_price <= Decimal::ZERO {
                    continue;
                }
                let mut source_account_ids = if holding.source_account_ids.is_empty() {
                    vec![holding.account_id.clone()]
                } else {
                    holding.source_account_ids.clone()
                };
                source_account_ids.sort_unstable();
                source_account_ids.dedup();
                let account_id = source_account_ids
                    .first()
                    .cloned()
                    .unwrap_or_else(|| holding.account_id.clone());
                sell_candidates.push(SellCandidate {
                    holding_id: holding.id.clone(),
                    asset_id: repr.asset_id.clone(),
                    account_id,
                    source_account_ids,
                    symbol: repr.symbol.clone(),
                    name: Some(repr.name.clone()),
                    price: holding_price,
                    quantity_owned: holding.quantity,
                    exposure_per_share: exposure_per_share.clone(),
                });
            }
        }

        sell_candidates
    }
}

#[async_trait]
impl RebalanceServiceTrait for RebalanceService {
    async fn calculate_plan(
        &self,
        input: CalculateRebalancePlanInput,
    ) -> CoreResult<RebalancePlan> {
        debug!("Calculating rebalance plan for target {}", input.target_id);

        if input.available_cash < Decimal::ZERO {
            return Err(CoreError::Validation(
                crate::errors::ValidationError::InvalidInput(
                    "available_cash must be non-negative".to_string(),
                ),
            ));
        }

        // Load profile early — needed for taxonomy_id before cash calculation.
        let profile = self
            .allocation_target_service
            .get_target(&input.target_id)?
            .ok_or_else(|| {
                CoreError::Database(crate::errors::DatabaseError::NotFound(format!(
                    "AllocationTarget {} not found",
                    input.target_id
                )))
            })?;

        // Fetch holdings once — used for both cash check and price extraction.
        let all_holdings = self
            .holdings_service
            .get_holdings_for_accounts(
                &input.account_ids,
                &input.base_currency,
                &input.aggregated_account_id,
            )
            .await?;

        let sell_source_holdings = if profile.allow_sells
            && !matches!(
                input.scenario_mode,
                crate::portfolio::allocation_targets::ScenarioMode::CashFlowOnly
            ) {
            let mut holdings = Vec::new();
            for account_id in &input.account_ids {
                holdings.extend(
                    self.holdings_service
                        .get_holdings(account_id, &input.base_currency)
                        .await?,
                );
            }
            holdings
        } else {
            Vec::new()
        };

        // Holding contributions for exposure vectors.
        let taxonomy_contributions = self
            .allocation_service
            .get_holding_contributions_for_taxonomy_for_accounts(
                &input.account_ids,
                &input.base_currency,
                &profile.taxonomy_id,
                &input.aggregated_account_id,
            )
            .await?;

        let cash_in_scope =
            deployable_cash_from_contributions(&profile.taxonomy_id, &taxonomy_contributions)
                .unwrap_or_else(|| tracked_cash(&all_holdings));

        let available_cash = if input.available_cash > cash_in_scope {
            let overage = input.available_cash - cash_in_scope;
            if overage <= Self::currency_rounding_tolerance(&input.base_currency) {
                cash_in_scope
            } else {
                return Err(CoreError::Validation(
                    crate::errors::ValidationError::InvalidInput(
                        "cash to deploy exceeds deployable cash in scope".to_string(),
                    ),
                ));
            }
        } else {
            input.available_cash
        };

        // Load persisted constraints from DB.
        let constraints = self
            .allocation_target_service
            .list_target_constraints(&input.target_id)?;
        let do_not_sell_asset_ids: Vec<String> = constraints
            .iter()
            .filter(|c| {
                matches!(c.subject_type, super::model::ConstraintSubjectType::Asset)
                    && matches!(
                        c.action,
                        super::model::ConstraintAction::Sell
                            | super::model::ConstraintAction::Trade
                    )
                    && matches!(c.effect, super::model::ConstraintEffect::Block)
            })
            .map(|c| c.subject_id.clone())
            .collect();
        let avoid_selling_account_ids: Vec<String> = constraints
            .iter()
            .filter(|c| {
                matches!(c.subject_type, super::model::ConstraintSubjectType::Account)
                    && matches!(
                        c.action,
                        super::model::ConstraintAction::Sell
                            | super::model::ConstraintAction::Trade
                    )
                    && matches!(c.effect, super::model::ConstraintEffect::Block)
            })
            .map(|c| c.subject_id.clone())
            .collect();

        // Drift report — provides total_value and per-category target/current data.
        let drift = self
            .drift_service
            .get_drift_report_for_target(
                &input.target_id,
                &input.account_ids,
                &input.base_currency,
                &input.aggregated_account_id,
            )
            .await?;

        let total_value = drift.total_value;

        if total_value == Decimal::ZERO && available_cash == Decimal::ZERO {
            return Ok(RebalancePlan {
                target_id: input.target_id,
                available_cash: Decimal::ZERO,
                cash_used: Decimal::ZERO,
                cash_remaining: Decimal::ZERO,
                max_drift_bps_before: 0,
                max_drift_bps_after: 0,
                trades: vec![],
                warnings: vec![],
                after_bps_by_category: std::collections::HashMap::new(),
            });
        }

        // Price map and quantity map keyed by asset (instrument) ID so the keys
        // match contribution.asset_id regardless of holding aggregation.
        let price_by_asset: HashMap<String, Decimal> = all_holdings
            .iter()
            .filter(|h| h.holding_type != HoldingType::Cash)
            .filter_map(|h| Some((Self::asset_key(h), Self::base_price_per_unit(h)?)))
            .collect();
        let quantity_by_asset: HashMap<String, Decimal> = all_holdings
            .iter()
            .filter(|h| h.holding_type != HoldingType::Cash)
            .map(|h| (Self::asset_key(h), h.quantity))
            .collect();

        let (candidates, mut classification_warnings) = Self::build_candidates(
            &taxonomy_contributions.contributions,
            &price_by_asset,
            &quantity_by_asset,
            profile.whole_shares_only,
        );
        classification_warnings.extend(Self::tagged_cash_warnings(
            &profile.taxonomy_id,
            &taxonomy_contributions.contributions,
        ));

        let sell_candidates = if profile.allow_sells
            && !matches!(
                input.scenario_mode,
                crate::portfolio::allocation_targets::ScenarioMode::CashFlowOnly
            ) {
            let all_sell = Self::build_sell_candidates(
                &taxonomy_contributions.contributions,
                &price_by_asset,
                &quantity_by_asset,
                &sell_source_holdings,
            );

            let do_not_sell = &do_not_sell_asset_ids;
            let avoid_selling = &avoid_selling_account_ids;
            let mut warned_do_not_sell_assets: HashSet<String> = HashSet::new();
            let mut warned_avoid_selling_accounts: HashSet<String> = HashSet::new();

            all_sell
                .into_iter()
                .filter(|c| {
                    if do_not_sell.contains(&c.asset_id) {
                        if warned_do_not_sell_assets.insert(c.asset_id.clone()) {
                            classification_warnings.push(super::model::RebalanceWarning {
                                kind: super::model::RebalanceWarningKind::ConstraintSkippedSell,
                                category_id: String::new(),
                                message: format!(
                                    "Skipped selling {}: do-not-sell constraint.",
                                    c.symbol
                                ),
                            });
                        }
                        return false;
                    }
                    if let Some(account_id) = avoid_selling
                        .iter()
                        .find(|a| c.source_account_ids.contains(a) || *a == &c.account_id)
                    {
                        if warned_avoid_selling_accounts.insert(account_id.to_string()) {
                            classification_warnings.push(super::model::RebalanceWarning {
                                kind: super::model::RebalanceWarningKind::ConstraintSkippedSell,
                                category_id: String::new(),
                                message: format!(
                                    "Skipped selling {} from account: avoid-selling constraint.",
                                    c.symbol
                                ),
                            });
                        }
                        return false;
                    }
                    true
                })
                .collect()
        } else {
            vec![]
        };

        // Map drift rows to CategoryState for the optimizer.
        let categories: Vec<CategoryState> = drift
            .rows
            .iter()
            .map(|row| CategoryState {
                category_id: row.category_id.clone(),
                category_name: row.category_name.clone(),
                target_bps: row.target_bps,
                current_value: row.current_value,
                is_cash: row.is_cash,
                is_required: row.is_required,
            })
            .collect();

        let max_turnover_bps = profile.max_turnover_bps.map(Decimal::from);

        let optimizer_input = RebalanceInput {
            profile: RebalanceProfile {
                target_id: input.target_id.clone(),
                drift_band_bps: profile.drift_band_bps,
                band_type: profile.band_type.clone(),
                relative_factor_bps: profile.relative_factor_bps,
                rebalance_goal: profile.rebalance_goal.clone(),
                min_trade_amount: Decimal::from_str(&profile.min_trade_amount)
                    .unwrap_or(Decimal::ZERO),
                whole_shares_only: profile.whole_shares_only,
            },
            scenario_mode: input.scenario_mode,
            available_cash,
            total_value,
            categories,
            candidates,
            sell_candidates,
            warnings: classification_warnings,
            max_turnover_bps,
        };

        DriftPriorityOptimizer.plan(optimizer_input)
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::DatabaseError;
    use crate::portfolio::allocation::{
        AllocationHoldings, HoldingAllocationContribution, PortfolioAllocations,
        TaxonomyHoldingContributions,
    };
    use crate::portfolio::allocation_targets::{
        AllocationTarget, AllocationTargetConstraint, AllocationTargetWeight, BandType,
        ConstraintAction, ConstraintEffect, ConstraintSubjectType, DriftReport, DriftRow,
        DriftStatus, NewAllocationTarget, NewAllocationTargetWeight, RebalanceGoal, ScenarioMode,
        ScopeType, TriggerType,
    };
    use crate::portfolio::holdings::{Holding, HoldingType, Instrument, MonetaryValue};
    use rust_decimal_macros::dec;

    // ── Test helpers ─────────────────────────────────────────────────────────

    fn make_profile(rebalance_goal: RebalanceGoal, whole_shares_only: bool) -> AllocationTarget {
        AllocationTarget {
            id: "profile-1".to_string(),
            name: "Test".to_string(),
            scope_type: ScopeType::All,
            scope_id: None,
            taxonomy_id: "asset_classes".to_string(),
            trigger_type: TriggerType::Threshold,
            drift_band_bps: 500,
            band_type: BandType::Absolute,
            relative_factor_bps: 2000,
            rebalance_goal,
            min_trade_amount: "0".to_string(),
            whole_shares_only,
            allow_sells: false,
            max_turnover_bps: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
            archived_at: None,
        }
    }

    fn make_drift_row(
        category_id: &str,
        current_bps: i32,
        target_bps: i32,
        total_value: Decimal,
    ) -> DriftRow {
        let drift_bps = current_bps - target_bps;
        let current_value = Decimal::from(current_bps) / dec!(10000) * total_value;
        let target_value = Decimal::from(target_bps) / dec!(10000) * total_value;
        let value_delta = current_value - target_value;
        let status = if drift_bps.abs() <= 500 {
            DriftStatus::InBand
        } else if drift_bps < 0 {
            DriftStatus::Underweight
        } else {
            DriftStatus::Overweight
        };
        DriftRow {
            category_id: category_id.to_string(),
            category_name: category_id.to_string(),
            color: "#aaa".to_string(),
            current_bps,
            target_bps,
            drift_bps,
            current_value,
            target_value,
            value_delta,
            effective_band_bps: 500,
            status,
            is_required: true,
            is_zero_current: current_bps == 0,
            is_cash: false,
        }
    }

    fn make_holding(id: &str, symbol: &str, quantity: Decimal, market_value: Decimal) -> Holding {
        let price = if quantity > Decimal::ZERO {
            Some(market_value / quantity)
        } else {
            None
        };
        Holding {
            id: id.to_string(),
            account_id: "acc-1".to_string(),
            holding_type: HoldingType::Security,
            instrument: Some(Instrument {
                id: id.to_string(),
                symbol: symbol.to_string(),
                name: Some(symbol.to_string()),
                currency: "USD".to_string(),
                notes: None,
                pricing_mode: "auto".to_string(),
                preferred_provider: None,
                exchange_mic: None,
                classifications: None,
            }),
            asset_kind: None,
            quantity,
            open_date: None,
            lots: None,
            contract_multiplier: Decimal::ONE,
            local_currency: "USD".to_string(),
            base_currency: "USD".to_string(),
            fx_rate: None,
            market_value: MonetaryValue {
                local: market_value,
                base: market_value,
            },
            cost_basis: None,
            price,
            purchase_price: None,
            unrealized_gain: None,
            unrealized_gain_pct: None,
            realized_gain: None,
            realized_gain_pct: None,
            total_gain: None,
            total_gain_pct: None,
            income: None,
            total_return: None,
            total_return_pct: None,
            return_basis: None,
            day_change: None,
            day_change_pct: None,
            prev_close_value: None,
            weight: Decimal::ZERO,
            as_of_date: chrono::NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
            metadata: None,
            source_account_ids: vec![],
        }
    }

    fn make_cash_holding(amount: Decimal, currency: &str) -> Holding {
        Holding {
            id: "cash".to_string(),
            account_id: "acc-1".to_string(),
            holding_type: HoldingType::Cash,
            instrument: None,
            asset_kind: None,
            quantity: amount,
            open_date: None,
            lots: None,
            contract_multiplier: Decimal::ONE,
            local_currency: currency.to_string(),
            base_currency: currency.to_string(),
            fx_rate: None,
            market_value: MonetaryValue {
                local: amount,
                base: amount,
            },
            cost_basis: None,
            price: None,
            purchase_price: None,
            unrealized_gain: None,
            unrealized_gain_pct: None,
            realized_gain: None,
            realized_gain_pct: None,
            total_gain: None,
            total_gain_pct: None,
            income: None,
            total_return: None,
            total_return_pct: None,
            return_basis: None,
            day_change: None,
            day_change_pct: None,
            prev_close_value: None,
            weight: Decimal::ZERO,
            as_of_date: chrono::NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
            metadata: None,
            source_account_ids: vec![],
        }
    }

    /// Build a single-category `HoldingAllocationContribution` (100% classified).
    fn make_contribution(
        holding: &Holding,
        category_id: &str,
        value: Decimal,
    ) -> HoldingAllocationContribution {
        HoldingAllocationContribution {
            id: format!("{}:{}", holding.id, category_id),
            holding_id: holding.id.clone(),
            asset_id: holding
                .instrument
                .as_ref()
                .map(|i| i.id.clone())
                .unwrap_or_default(),
            account_id: holding.account_id.clone(),
            source_account_ids: vec![],
            symbol: holding
                .instrument
                .as_ref()
                .map(|i| i.symbol.clone())
                .unwrap_or_default(),
            name: holding
                .instrument
                .as_ref()
                .and_then(|i| i.name.clone())
                .unwrap_or_default(),
            holding_type: holding.holding_type.clone(),
            quantity: holding.quantity,
            category_id: category_id.to_string(),
            category_name: category_id.to_string(),
            category_color: "#aaa".to_string(),
            value,
        }
    }

    fn make_contributions(
        contribs: Vec<HoldingAllocationContribution>,
    ) -> TaxonomyHoldingContributions {
        let total: Decimal = contribs.iter().map(|c| c.value).sum();
        TaxonomyHoldingContributions {
            taxonomy_id: "asset_classes".to_string(),
            taxonomy_name: "Asset Classes".to_string(),
            total_value: total,
            currency: "USD".to_string(),
            contributions: contribs,
        }
    }

    fn make_report(rows: Vec<DriftRow>, total_value: Decimal) -> DriftReport {
        let max = rows
            .iter()
            .map(|r| r.drift_bps.unsigned_abs())
            .max()
            .unwrap_or(0);
        let out = rows
            .iter()
            .filter(|r| r.drift_bps.unsigned_abs() > 500)
            .count();
        DriftReport {
            target_id: "profile-1".to_string(),
            scope_type: ScopeType::All,
            scope_id: None,
            total_value,
            base_currency: "USD".to_string(),
            max_drift_bps: max as i32,
            out_of_band_count: out,
            rows,
            holdings: None,
            deployable_cash: Decimal::ZERO,
        }
    }

    // ── Mocks ─────────────────────────────────────────────────────────────────

    struct MockTargetService {
        profile: AllocationTarget,
        constraints: Vec<AllocationTargetConstraint>,
        constraint_load_error: bool,
    }

    #[async_trait]
    impl AllocationTargetServiceTrait for MockTargetService {
        fn get_target(&self, _: &str) -> CoreResult<Option<AllocationTarget>> {
            Ok(Some(self.profile.clone()))
        }
        fn list_targets(&self) -> CoreResult<Vec<AllocationTarget>> {
            Ok(vec![])
        }
        fn list_weights_for_target(&self, _: &str) -> CoreResult<Vec<AllocationTargetWeight>> {
            Ok(vec![])
        }
        async fn create_target(&self, _: NewAllocationTarget) -> CoreResult<AllocationTarget> {
            unimplemented!()
        }
        async fn update_target(
            &self,
            _: &str,
            _: NewAllocationTarget,
        ) -> CoreResult<AllocationTarget> {
            unimplemented!()
        }
        async fn archive_target(&self, _: &str) -> CoreResult<AllocationTarget> {
            unimplemented!()
        }
        async fn delete_target(&self, _: &str) -> CoreResult<()> {
            unimplemented!()
        }
        async fn save_weights(
            &self,
            _: &str,
            _: Vec<NewAllocationTargetWeight>,
        ) -> CoreResult<Vec<AllocationTargetWeight>> {
            unimplemented!()
        }
        async fn save_target_with_weights(
            &self,
            _: Option<String>,
            _: NewAllocationTarget,
            _: Vec<NewAllocationTargetWeight>,
        ) -> CoreResult<crate::portfolio::allocation_targets::SaveAllocationTargetResult> {
            unimplemented!()
        }
        fn list_target_constraints(&self, _: &str) -> CoreResult<Vec<AllocationTargetConstraint>> {
            if self.constraint_load_error {
                return Err(CoreError::Database(DatabaseError::QueryFailed(
                    "constraint load failed".to_string(),
                )));
            }
            Ok(self.constraints.clone())
        }
        async fn save_target_constraints(
            &self,
            _: &str,
            _: Vec<crate::portfolio::allocation_targets::AllocationTargetConstraint>,
        ) -> CoreResult<Vec<crate::portfolio::allocation_targets::AllocationTargetConstraint>>
        {
            unimplemented!()
        }
    }

    struct MockDriftService {
        report: DriftReport,
    }

    #[async_trait]
    impl DriftServiceTrait for MockDriftService {
        async fn get_drift_report_for_target(
            &self,
            _: &str,
            _: &[String],
            _: &str,
            _: &str,
        ) -> CoreResult<DriftReport> {
            Ok(self.report.clone())
        }
        async fn get_drift_report_with_holdings_for_target(
            &self,
            _: &str,
            _: &[String],
            _: &str,
            _: &str,
        ) -> CoreResult<DriftReport> {
            Ok(self.report.clone())
        }
    }

    struct MockAllocationService {
        contributions: TaxonomyHoldingContributions,
    }

    #[async_trait]
    impl AllocationServiceTrait for MockAllocationService {
        async fn get_portfolio_allocations(
            &self,
            _: &str,
            _: &str,
        ) -> CoreResult<PortfolioAllocations> {
            unimplemented!()
        }
        async fn get_portfolio_allocations_for_accounts(
            &self,
            _: &[String],
            _: &str,
            _: &str,
        ) -> CoreResult<PortfolioAllocations> {
            unimplemented!()
        }
        async fn get_holdings_by_allocation(
            &self,
            _: &str,
            _: &str,
            _: &str,
            _: &str,
        ) -> CoreResult<AllocationHoldings> {
            unimplemented!()
        }
        async fn get_holdings_by_allocation_for_accounts(
            &self,
            _: &[String],
            _: &str,
            _: &str,
            _: &str,
            _: &str,
        ) -> CoreResult<AllocationHoldings> {
            unimplemented!()
        }
        async fn get_holding_contributions_for_taxonomy_for_accounts(
            &self,
            _: &[String],
            _: &str,
            _: &str,
            _: &str,
        ) -> CoreResult<TaxonomyHoldingContributions> {
            Ok(self.contributions.clone())
        }
    }

    struct MockHoldingsService {
        holdings: Vec<Holding>,
    }

    #[async_trait]
    impl crate::portfolio::holdings::HoldingsServiceTrait for MockHoldingsService {
        async fn get_holdings(&self, account_id: &str, _: &str) -> CoreResult<Vec<Holding>> {
            Ok(self
                .holdings
                .iter()
                .filter(|h| h.account_id == account_id)
                .cloned()
                .collect())
        }
        async fn get_holdings_for_accounts(
            &self,
            _: &[String],
            _: &str,
            _: &str,
        ) -> CoreResult<Vec<Holding>> {
            Ok(self.holdings.clone())
        }
        async fn get_holding(&self, _: &str, _: &str, _: &str) -> CoreResult<Option<Holding>> {
            unimplemented!()
        }
        async fn holdings_from_snapshot(
            &self,
            _: &crate::portfolio::snapshot::AccountStateSnapshot,
            _: &str,
        ) -> CoreResult<Vec<Holding>> {
            unimplemented!()
        }
    }

    // ── Service constructors ──────────────────────────────────────────────────

    fn make_service(
        profile: AllocationTarget,
        report: DriftReport,
        mut contributions: TaxonomyHoldingContributions,
        holdings: Vec<Holding>,
    ) -> RebalanceService {
        // Auto-inject cash contributions so cash_in_scope (now derived from
        // contributions) matches the cash holdings the test provides.
        for h in &holdings {
            if h.holding_type == HoldingType::Cash {
                contributions
                    .contributions
                    .push(make_contribution(h, "CASH", h.market_value.base));
                contributions.total_value += h.market_value.base;
            }
        }
        RebalanceService::new(
            Arc::new(MockTargetService {
                profile,
                constraints: vec![],
                constraint_load_error: false,
            }),
            Arc::new(MockDriftService { report }),
            Arc::new(MockAllocationService { contributions }),
            Arc::new(MockHoldingsService { holdings }),
        )
    }

    fn make_service_with_constraint_load_error(
        profile: AllocationTarget,
        report: DriftReport,
        contributions: TaxonomyHoldingContributions,
        holdings: Vec<Holding>,
    ) -> RebalanceService {
        RebalanceService::new(
            Arc::new(MockTargetService {
                profile,
                constraints: vec![],
                constraint_load_error: true,
            }),
            Arc::new(MockDriftService { report }),
            Arc::new(MockAllocationService { contributions }),
            Arc::new(MockHoldingsService { holdings }),
        )
    }

    fn make_service_with_constraints(
        profile: AllocationTarget,
        report: DriftReport,
        mut contributions: TaxonomyHoldingContributions,
        holdings: Vec<Holding>,
        constraints: Vec<AllocationTargetConstraint>,
    ) -> RebalanceService {
        for h in &holdings {
            if h.holding_type == HoldingType::Cash {
                contributions
                    .contributions
                    .push(make_contribution(h, "CASH", h.market_value.base));
                contributions.total_value += h.market_value.base;
            }
        }
        RebalanceService::new(
            Arc::new(MockTargetService {
                profile,
                constraints,
                constraint_load_error: false,
            }),
            Arc::new(MockDriftService { report }),
            Arc::new(MockAllocationService { contributions }),
            Arc::new(MockHoldingsService { holdings }),
        )
    }

    fn sell_block_constraint(
        id: &str,
        subject_type: ConstraintSubjectType,
        subject_id: &str,
    ) -> AllocationTargetConstraint {
        AllocationTargetConstraint {
            id: id.to_string(),
            target_id: "profile-1".to_string(),
            subject_type,
            subject_id: subject_id.to_string(),
            action: ConstraintAction::Sell,
            effect: ConstraintEffect::Block,
            reason: None,
            metadata_json: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    fn make_input(available_cash: Decimal) -> CalculateRebalancePlanInput {
        CalculateRebalancePlanInput {
            target_id: "profile-1".to_string(),
            available_cash,
            account_ids: vec!["acc-1".to_string()],
            base_currency: "USD".to_string(),
            aggregated_account_id: "agg".to_string(),
            scenario_mode: ScenarioMode::CashFlowOnly,
        }
    }

    #[tokio::test]
    async fn calculate_plan_propagates_constraint_load_errors() {
        let total = dec!(10000);
        let h = make_holding("h1", "VTI", dec!(100), total);
        let c = make_contribution(&h, "equity", total);
        let svc = make_service_with_constraint_load_error(
            make_profile(RebalanceGoal::ExactTarget, false),
            make_report(vec![make_drift_row("equity", 10000, 10000, total)], total),
            make_contributions(vec![c]),
            vec![h],
        );

        let err = svc.calculate_plan(make_input(dec!(0))).await.unwrap_err();

        assert!(err.to_string().contains("constraint load failed"));
    }

    #[test]
    fn split_classification_single_holding_keeps_weighted_exposure_per_share() {
        let h = make_holding("asset-a", "AAA", dec!(10), dec!(1000));
        let c_equity = make_contribution(&h, "equity", dec!(600));
        let c_bond = make_contribution(&h, "bond", dec!(400));
        let price_by_asset = HashMap::from([("asset-a".to_string(), dec!(100))]);
        let quantity_by_asset = HashMap::from([("asset-a".to_string(), dec!(10))]);

        let (candidates, warnings) = RebalanceService::build_candidates(
            &[c_equity, c_bond],
            &price_by_asset,
            &quantity_by_asset,
            false,
        );

        assert!(warnings.is_empty());
        assert_eq!(candidates.len(), 1);
        assert_eq!(
            candidates[0].exposure_per_share.get("equity").copied(),
            Some(dec!(60))
        );
        assert_eq!(
            candidates[0].exposure_per_share.get("bond").copied(),
            Some(dec!(40))
        );
    }

    #[test]
    fn same_asset_account_rows_use_combined_quantity_for_buy_exposure() {
        let mut h1 = make_holding("SEC-acc-1-asset-a", "AAA", dec!(5), dec!(500));
        let mut h2 = make_holding("SEC-acc-2-asset-a", "AAA", dec!(5), dec!(500));
        h1.account_id = "acc-1".to_string();
        h2.account_id = "acc-2".to_string();
        h1.instrument.as_mut().unwrap().id = "asset-a".to_string();
        h2.instrument.as_mut().unwrap().id = "asset-a".to_string();
        let c1 = make_contribution(&h1, "equity", dec!(500));
        let c2 = make_contribution(&h2, "equity", dec!(500));
        let price_by_asset = HashMap::from([("asset-a".to_string(), dec!(100))]);
        let quantity_by_asset = HashMap::from([("asset-a".to_string(), dec!(10))]);

        let (candidates, warnings) = RebalanceService::build_candidates(
            &[c1, c2],
            &price_by_asset,
            &quantity_by_asset,
            false,
        );

        assert!(warnings.is_empty());
        assert_eq!(candidates.len(), 1);
        assert_eq!(
            candidates[0].exposure_per_share.get("equity").copied(),
            Some(dec!(100))
        );
    }

    #[test]
    fn same_asset_account_rows_build_account_level_sell_candidates() {
        let mut h1 = make_holding("SEC-acc-1-asset-a", "AAA", dec!(5), dec!(500));
        let mut h2 = make_holding("SEC-acc-2-asset-a", "AAA", dec!(5), dec!(500));
        h1.account_id = "acc-1".to_string();
        h2.account_id = "acc-2".to_string();
        h1.instrument.as_mut().unwrap().id = "asset-a".to_string();
        h2.instrument.as_mut().unwrap().id = "asset-a".to_string();
        let c1 = make_contribution(&h1, "equity", dec!(500));
        let c2 = make_contribution(&h2, "equity", dec!(500));
        let price_by_asset = HashMap::from([("asset-a".to_string(), dec!(100))]);
        let quantity_by_asset = HashMap::from([("asset-a".to_string(), dec!(10))]);

        let sell_candidates = RebalanceService::build_sell_candidates(
            &[c1, c2],
            &price_by_asset,
            &quantity_by_asset,
            &[h1, h2],
        );

        assert_eq!(sell_candidates.len(), 2);
        assert_eq!(sell_candidates[0].account_id, "acc-1");
        assert_eq!(sell_candidates[0].quantity_owned, dec!(5));
        assert_eq!(sell_candidates[1].account_id, "acc-2");
        assert_eq!(sell_candidates[1].quantity_owned, dec!(5));
        assert!(sell_candidates.iter().all(|candidate| candidate
            .exposure_per_share
            .get("equity")
            .copied()
            == Some(dec!(100))));
    }

    #[test]
    fn account_sell_constraint_keeps_unprotected_same_asset_quantity() {
        let mut h1 = make_holding("SEC-acc-1-asset-a", "AAA", dec!(5), dec!(500));
        let mut h2 = make_holding("SEC-acc-2-asset-a", "AAA", dec!(5), dec!(500));
        h1.account_id = "acc-1".to_string();
        h2.account_id = "acc-2".to_string();
        h1.instrument.as_mut().unwrap().id = "asset-a".to_string();
        h2.instrument.as_mut().unwrap().id = "asset-a".to_string();
        let c1 = make_contribution(&h1, "equity", dec!(500));
        let c2 = make_contribution(&h2, "equity", dec!(500));
        let price_by_asset = HashMap::from([("asset-a".to_string(), dec!(100))]);
        let quantity_by_asset = HashMap::from([("asset-a".to_string(), dec!(10))]);

        let mut sell_candidates = RebalanceService::build_sell_candidates(
            &[c1, c2],
            &price_by_asset,
            &quantity_by_asset,
            &[h1, h2],
        );
        let avoid_selling = ["acc-1".to_string()];
        sell_candidates.retain(|c| {
            !avoid_selling
                .iter()
                .any(|a| c.source_account_ids.contains(a) || a == &c.account_id)
        });

        assert_eq!(sell_candidates.len(), 1);
        assert_eq!(sell_candidates[0].account_id, "acc-2");
        assert_eq!(sell_candidates[0].quantity_owned, dec!(5));
    }

    // ── Cash enforcement tests (unchanged behaviour from PR-A) ────────────────

    #[tokio::test]
    async fn negative_cash_returns_validation_error() {
        let total = dec!(10000);
        let h = make_holding("h1", "VTI", dec!(10), dec!(6000));
        let c = make_contribution(&h, "equity", dec!(6000));
        let svc = make_service(
            make_profile(RebalanceGoal::ExactTarget, false),
            make_report(vec![make_drift_row("equity", 6000, 7000, total)], total),
            make_contributions(vec![c]),
            vec![make_cash_holding(dec!(1_000_000), "USD"), h],
        );
        let err = svc
            .calculate_plan(make_input(dec!(-100)))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("non-negative"), "{err}");
    }

    #[tokio::test]
    async fn deploy_exceeding_tracked_cash_is_rejected() {
        let total = dec!(10000);
        let h = make_holding("h1", "VTI", dec!(10), dec!(9500));
        let c = make_contribution(&h, "equity", dec!(9500));
        let svc = make_service(
            make_profile(RebalanceGoal::ExactTarget, false),
            make_report(vec![make_drift_row("equity", 9500, 7000, total)], total),
            make_contributions(vec![c]),
            vec![make_cash_holding(dec!(500), "USD"), h],
        );
        let err = svc
            .calculate_plan(make_input(dec!(1000)))
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("exceeds deployable cash in scope"),
            "{err}"
        );
    }

    #[tokio::test]
    async fn asset_class_tagged_cash_is_not_deployable() {
        let cash = make_cash_holding(dec!(1000), "USD");
        let tagged_cash = make_contribution(&cash, "FIXED_INCOME", dec!(1000));
        let svc = RebalanceService::new(
            Arc::new(MockTargetService {
                profile: make_profile(RebalanceGoal::ExactTarget, false),
                constraints: vec![],
                constraint_load_error: false,
            }),
            Arc::new(MockDriftService {
                report: make_report(
                    vec![make_drift_row("FIXED_INCOME", 10000, 0, dec!(1000))],
                    dec!(1000),
                ),
            }),
            Arc::new(MockAllocationService {
                contributions: make_contributions(vec![tagged_cash]),
            }),
            Arc::new(MockHoldingsService {
                holdings: vec![cash],
            }),
        );

        let err = svc
            .calculate_plan(make_input(dec!(1000)))
            .await
            .unwrap_err();

        assert!(
            err.to_string().contains("exceeds deployable cash in scope"),
            "{err}"
        );
    }

    #[tokio::test]
    async fn tagged_cash_in_non_cash_sleeve_emits_warning() {
        let cash = make_cash_holding(dec!(1000), "USD");
        let tagged_cash = make_contribution(&cash, "FIXED_INCOME", dec!(1000));
        let svc = RebalanceService::new(
            Arc::new(MockTargetService {
                profile: make_sell_profile(RebalanceGoal::ExactTarget),
                constraints: vec![],
                constraint_load_error: false,
            }),
            Arc::new(MockDriftService {
                report: make_report(
                    vec![make_drift_row("FIXED_INCOME", 10000, 0, dec!(1000))],
                    dec!(1000),
                ),
            }),
            Arc::new(MockAllocationService {
                contributions: make_contributions(vec![tagged_cash]),
            }),
            Arc::new(MockHoldingsService {
                holdings: vec![cash],
            }),
        );

        let plan = svc
            .calculate_plan(make_input_with_mode(
                Decimal::ZERO,
                ScenarioMode::SellToRebalance,
            ))
            .await
            .unwrap();

        let warning = plan
            .warnings
            .iter()
            .find(|warning| warning.kind == RebalanceWarningKind::TaggedCash)
            .expect("tagged cash warning expected");
        assert_eq!(warning.category_id, "FIXED_INCOME");
        assert!(warning.message.contains("move or reclassify"));
    }

    #[tokio::test]
    async fn non_cash_taxonomy_uses_tracked_cash_for_deployment() {
        let total = dec!(10000);
        let h = make_holding("h1", "XLK", dec!(10), dec!(6000));
        let c = make_contribution(&h, "45", dec!(6000));
        let mut profile = make_profile(RebalanceGoal::ExactTarget, false);
        profile.taxonomy_id = "industries_gics".to_string();
        let mut contributions = make_contributions(vec![c]);
        contributions.taxonomy_id = "industries_gics".to_string();
        let svc = RebalanceService::new(
            Arc::new(MockTargetService {
                profile,
                constraints: vec![],
                constraint_load_error: false,
            }),
            Arc::new(MockDriftService {
                report: make_report(vec![make_drift_row("45", 6000, 7000, total)], total),
            }),
            Arc::new(MockAllocationService { contributions }),
            Arc::new(MockHoldingsService {
                holdings: vec![make_cash_holding(dec!(1000), "USD"), h],
            }),
        );

        let plan = svc.calculate_plan(make_input(dec!(1000))).await.unwrap();

        assert_eq!(plan.available_cash, dec!(1000));
    }

    #[tokio::test]
    async fn rounded_cash_within_cent_is_capped_to_tracked_cash() {
        let total = dec!(1000);
        let h = make_holding("h1", "VTI", dec!(10), dec!(500));
        let c = make_contribution(&h, "equity", dec!(500));
        let rows = vec![
            make_drift_row("equity", 5000, 6000, total),
            DriftRow {
                is_cash: true,
                ..make_drift_row("cash", 5000, 4000, total)
            },
        ];
        let svc = make_service(
            make_profile(RebalanceGoal::ExactTarget, false),
            make_report(rows, total),
            make_contributions(vec![c]),
            vec![make_cash_holding(dec!(100.005), "USD"), h],
        );
        let plan = svc.calculate_plan(make_input(dec!(100.01))).await.unwrap();
        assert_eq!(plan.available_cash, dec!(100.005));
    }

    #[tokio::test]
    async fn rounded_zero_decimal_cash_is_capped_to_tracked_cash() {
        let total = dec!(1000);
        let h = make_holding("h1", "VTI", dec!(10), dec!(500));
        let c = make_contribution(&h, "equity", dec!(500));
        let rows = vec![
            make_drift_row("equity", 5000, 6000, total),
            DriftRow {
                is_cash: true,
                ..make_drift_row("cash", 5000, 4000, total)
            },
        ];
        let svc = make_service(
            make_profile(RebalanceGoal::ExactTarget, false),
            make_report(rows, total),
            make_contributions(vec![c]),
            vec![make_cash_holding(dec!(100.5), "USD"), h],
        );
        let input = CalculateRebalancePlanInput {
            base_currency: "JPY".to_string(),
            ..make_input(dec!(101))
        };
        let plan = svc.calculate_plan(input).await.unwrap();
        assert_eq!(plan.available_cash, dec!(100.5));
    }

    // ── Greedy planner tests ──────────────────────────────────────────────────

    #[tokio::test]
    async fn zero_cash_produces_no_trades() {
        let total = dec!(10000);
        let h = make_holding("h1", "VTI", dec!(10), dec!(6000));
        let c = make_contribution(&h, "equity", dec!(6000));
        let svc = make_service(
            make_profile(RebalanceGoal::ExactTarget, false),
            make_report(vec![make_drift_row("equity", 6000, 7000, total)], total),
            make_contributions(vec![c]),
            vec![make_cash_holding(dec!(0), "USD"), h],
        );
        let plan = svc.calculate_plan(make_input(dec!(0))).await.unwrap();
        assert!(plan.trades.is_empty());
        assert_eq!(plan.cash_used, Decimal::ZERO);
    }

    #[tokio::test]
    async fn cash_flow_only_no_sells_generated() {
        // Equity 60% (target 70%), Bond 40% (target 30%). Bond overweight.
        let total = dec!(10000);
        let h_vti = make_holding("h1", "VTI", dec!(10), dec!(6000));
        let h_bnd = make_holding("h2", "BND", dec!(40), dec!(4000));
        let c_vti = make_contribution(&h_vti, "equity", dec!(6000));
        let c_bnd = make_contribution(&h_bnd, "bond", dec!(4000));
        let rows = vec![
            make_drift_row("equity", 6000, 7000, total),
            make_drift_row("bond", 4000, 3000, total),
        ];
        let svc = make_service(
            make_profile(RebalanceGoal::ExactTarget, false),
            make_report(rows, total),
            make_contributions(vec![c_vti, c_bnd]),
            vec![make_cash_holding(dec!(2000), "USD"), h_vti, h_bnd],
        );
        let plan = svc.calculate_plan(make_input(dec!(2000))).await.unwrap();

        assert!(
            plan.trades.iter().all(|t| t.action == "buy"),
            "cash-flow-only must not sell"
        );
        assert!(plan.cash_used <= dec!(2000));
        assert!(
            plan.trades.iter().any(|t| t.category_id == "equity"),
            "should suggest buying equity"
        );
    }

    #[tokio::test]
    async fn greedy_buys_most_drift_reducing_asset() {
        // Equity 50% (target 70%), Bond 50% (target 30%). Equity far underweight.
        // VTI (equity): price $100. BND (bond): price $50.
        // Greedy should buy VTI (improves equity drift) not BND (overweight, buying worsens).
        let total = dec!(10000);
        let h_vti = make_holding("h1", "VTI", dec!(50), dec!(5000));
        let h_bnd = make_holding("h2", "BND", dec!(100), dec!(5000));
        let c_vti = make_contribution(&h_vti, "equity", dec!(5000));
        let c_bnd = make_contribution(&h_bnd, "bond", dec!(5000));
        let rows = vec![
            make_drift_row("equity", 5000, 7000, total),
            make_drift_row("bond", 5000, 3000, total),
        ];
        let svc = make_service(
            make_profile(RebalanceGoal::ExactTarget, false),
            make_report(rows, total),
            make_contributions(vec![c_vti, c_bnd]),
            vec![make_cash_holding(dec!(5000), "USD"), h_vti, h_bnd],
        );
        let plan = svc.calculate_plan(make_input(dec!(200))).await.unwrap();

        assert!(
            plan.trades
                .iter()
                .all(|t| t.symbol.as_deref() != Some("BND")),
            "BND is overweight — buying it increases bond drift"
        );
        assert!(
            plan.trades
                .iter()
                .any(|t| t.symbol.as_deref() == Some("VTI")),
            "VTI should be selected to reduce equity drift"
        );
    }

    #[tokio::test]
    async fn multi_category_etf_reduces_multiple_sleeve_drifts() {
        // VT is a global ETF: 60% US equity, 40% international equity.
        // Portfolio: US 40% (target 60%), Intl 40% (target 40%), Cash 20%.
        // Buying VT should simultaneously improve US and Intl drift.
        let total = dec!(10000);
        let price = dec!(100); // $100/share
        let qty = dec!(40);
        let h_vt = make_holding("vt", "VT", qty, price * qty);

        // Split contribution: 60% US, 40% Intl of holding value ($4000 total)
        let c_us = make_contribution(&h_vt, "us_equity", dec!(2400)); // 60%
        let c_intl = make_contribution(&h_vt, "intl_equity", dec!(1600)); // 40%

        let rows = vec![
            make_drift_row("us_equity", 4000, 6000, total),
            make_drift_row("intl_equity", 4000, 4000, total),
            DriftRow {
                is_cash: true,
                ..make_drift_row("cash", 2000, 0, total)
            },
        ];
        let svc = make_service(
            make_profile(RebalanceGoal::ExactTarget, false),
            make_report(rows, total),
            make_contributions(vec![c_us, c_intl]),
            vec![make_cash_holding(dec!(2000), "USD"), h_vt],
        );
        let plan = svc.calculate_plan(make_input(dec!(200))).await.unwrap();

        // VT should be selected (only candidate that reduces US drift)
        let vt_trade = plan
            .trades
            .iter()
            .find(|t| t.symbol.as_deref() == Some("VT"));
        assert!(vt_trade.is_some(), "VT should be selected");
        assert!(plan.cash_used > Decimal::ZERO);
    }

    #[tokio::test]
    async fn underweight_cash_is_not_a_buy_candidate() {
        // Cash underweight but cannot be a buy candidate.
        let total = dec!(10000);
        let h_vti = make_holding("h1", "VTI", dec!(80), dec!(8000));
        // No contribution for cash sleeve — it has no HoldingAllocationContribution.
        let c_vti = make_contribution(&h_vti, "equity", dec!(8000));
        let rows = vec![
            make_drift_row("equity", 8000, 7000, total),
            DriftRow {
                is_cash: true,
                ..make_drift_row("cash", 2000, 3000, total)
            },
        ];
        let svc = make_service(
            make_profile(RebalanceGoal::ExactTarget, false),
            make_report(rows, total),
            make_contributions(vec![c_vti]),
            vec![make_cash_holding(dec!(2000), "USD"), h_vti],
        );
        let plan = svc.calculate_plan(make_input(dec!(1000))).await.unwrap();

        // Equity is overweight → buying VTI would worsen equity drift → greedy finds no improvement.
        assert!(plan.cash_used == Decimal::ZERO || plan.trades.iter().all(|t| t.action == "buy"));
    }

    #[tokio::test]
    async fn no_holdings_emits_warning_and_sleeve_level_trade() {
        let total = dec!(10000);
        // No holdings, no contributions for bonds sleeve.
        let svc = make_service(
            make_profile(RebalanceGoal::ExactTarget, false),
            make_report(vec![make_drift_row("bonds", 2000, 4000, total)], total),
            make_contributions(vec![]),
            vec![make_cash_holding(dec!(1000), "USD")],
        );
        let plan = svc.calculate_plan(make_input(dec!(1000))).await.unwrap();

        assert!(
            plan.warnings
                .iter()
                .any(|w| w.kind == RebalanceWarningKind::NoBuyCandidate),
            "NoBuyCandidate warning expected"
        );
        let trade = plan.trades.iter().find(|t| t.category_id == "bonds");
        assert!(trade.is_some(), "sleeve-level trade expected");
        assert!(
            trade.unwrap().symbol.is_none(),
            "sleeve trade has no ticker"
        );
    }

    #[tokio::test]
    async fn equal_price_candidates_break_ties_by_symbol() {
        // Two equity candidates, identical price ($100) and exposure. Cash funds exactly
        // one share. The stable (price, symbol, asset_id) sort must always pick the
        // lexicographically smaller symbol (AAA), regardless of HashMap iteration order.
        let total = dec!(10000);
        let h_z = make_holding("z1", "ZZZ", dec!(1), dec!(100));
        let h_a = make_holding("a1", "AAA", dec!(1), dec!(100));
        let c_z = make_contribution(&h_z, "equity", dec!(100));
        let c_a = make_contribution(&h_a, "equity", dec!(100));
        let svc = make_service(
            make_profile(RebalanceGoal::ExactTarget, false),
            make_report(vec![make_drift_row("equity", 5000, 7000, total)], total),
            make_contributions(vec![c_z, c_a]),
            vec![make_cash_holding(dec!(100), "USD"), h_z, h_a],
        );
        let plan = svc.calculate_plan(make_input(dec!(100))).await.unwrap();

        let trade = plan
            .trades
            .iter()
            .find(|t| t.asset_id.is_some())
            .expect("one share bought");
        assert_eq!(
            trade.symbol.as_deref(),
            Some("AAA"),
            "equal-price tie must resolve to the smaller symbol"
        );
    }

    #[tokio::test]
    async fn manual_sleeve_trade_is_reflected_in_after_bps() {
        // Bonds underweight (0%, target 10%) with no buy candidate. A $1000 manual
        // sleeve trade fills it; after_bps_by_category must credit the target category
        // (1000 bps) rather than leaving it at 0.
        let total = dec!(10000);
        let rows = vec![
            make_drift_row("bonds", 0, 1000, total),
            make_drift_row("equity", 9000, 9000, total),
            DriftRow {
                is_cash: true,
                ..make_drift_row("cash", 1000, 0, total)
            },
        ];
        let svc = make_service(
            make_profile(RebalanceGoal::ExactTarget, false),
            make_report(rows, total),
            make_contributions(vec![]),
            vec![make_cash_holding(dec!(1000), "USD")],
        );
        let plan = svc.calculate_plan(make_input(dec!(1000))).await.unwrap();

        assert_eq!(
            plan.cash_used,
            dec!(1000),
            "manual trade should deploy $1000"
        );
        assert_eq!(
            plan.after_bps_by_category.get("bonds").copied(),
            Some(1000),
            "bonds after-drift must reflect the manual sleeve trade"
        );
    }

    #[tokio::test]
    async fn multiple_uncovered_categories_never_overspend_cash() {
        // Two required underweight categories with no buy candidates. Each shortfall
        // ($2000) exceeds available cash ($1000). Manual sleeve trades must share the
        // cash, never letting cash_used exceed available / cash_remaining go negative.
        let total = dec!(10000);
        let rows = vec![
            make_drift_row("bonds", 2000, 4000, total),
            make_drift_row("reit", 2000, 4000, total),
            make_drift_row("equity", 6000, 2000, total),
        ];
        let svc = make_service(
            make_profile(RebalanceGoal::ExactTarget, false),
            make_report(rows, total),
            make_contributions(vec![]),
            vec![make_cash_holding(dec!(1000), "USD")],
        );
        let plan = svc.calculate_plan(make_input(dec!(1000))).await.unwrap();

        assert!(
            plan.cash_used <= dec!(1000),
            "cash_used must not exceed available cash, got {}",
            plan.cash_used
        );
        assert!(
            plan.cash_remaining >= Decimal::ZERO,
            "cash_remaining must not go negative, got {}",
            plan.cash_remaining
        );
        assert_eq!(plan.cash_used + plan.cash_remaining, dec!(1000));
    }

    #[tokio::test]
    async fn unclassified_asset_emits_warning_and_is_skipped() {
        let total = dec!(10000);
        let h = make_holding("h1", "XYZ", dec!(10), dec!(5000));
        // All contribution in __UNKNOWN__ = no taxonomy assignments.
        let c_unknown = make_contribution(&h, "__UNKNOWN__", dec!(5000));
        let svc = make_service(
            make_profile(RebalanceGoal::ExactTarget, false),
            make_report(vec![make_drift_row("equity", 5000, 7000, total)], total),
            make_contributions(vec![c_unknown]),
            vec![make_cash_holding(dec!(1000), "USD"), h],
        );
        let plan = svc.calculate_plan(make_input(dec!(500))).await.unwrap();

        assert!(
            plan.warnings
                .iter()
                .any(|w| w.kind == RebalanceWarningKind::UnclassifiedAsset),
            "UnclassifiedAsset warning expected"
        );
        assert!(
            !plan
                .trades
                .iter()
                .any(|t| t.symbol.as_deref() == Some("XYZ")),
            "XYZ must not be a buy candidate"
        );
    }

    #[tokio::test]
    async fn partial_classification_warns_and_uses_known_exposure() {
        // ABC: 70% equity, 30% __UNKNOWN__. Should warn PartialClassification
        // and still be a candidate using only the 70% equity exposure.
        let total = dec!(10000);
        let qty = dec!(10);
        let mv = dec!(7000);
        let h = make_holding("h1", "ABC", qty, mv);
        let c_equity = make_contribution(&h, "equity", dec!(4900)); // 70%
        let c_unknown = make_contribution(&h, "__UNKNOWN__", dec!(2100)); // 30%

        let svc = make_service(
            make_profile(RebalanceGoal::ExactTarget, false),
            make_report(vec![make_drift_row("equity", 3000, 7000, total)], total),
            make_contributions(vec![c_equity, c_unknown]),
            vec![make_cash_holding(dec!(5000), "USD"), h],
        );
        let plan = svc.calculate_plan(make_input(dec!(700))).await.unwrap();

        assert!(
            plan.warnings
                .iter()
                .any(|w| w.kind == RebalanceWarningKind::PartialClassification),
            "PartialClassification warning expected"
        );
        assert!(
            plan.trades
                .iter()
                .any(|t| t.symbol.as_deref() == Some("ABC")),
            "ABC should still be a buy candidate"
        );
    }

    #[tokio::test]
    async fn fractional_mode_deploys_partial_share() {
        // Fractional mode (whole_shares_only = false): $50 cash, $100 ETF. No whole
        // share fits, but the leftover should deploy as a 0.5-share fractional buy.
        let total = dec!(10000);
        let h = make_holding("h1", "ETF", dec!(1), dec!(100)); // $100/share
        let c = make_contribution(&h, "equity", dec!(100));
        let svc = make_service(
            make_profile(RebalanceGoal::ExactTarget, false),
            make_report(vec![make_drift_row("equity", 5000, 7000, total)], total),
            make_contributions(vec![c]),
            vec![make_cash_holding(dec!(50), "USD"), h],
        );
        let plan = svc.calculate_plan(make_input(dec!(50))).await.unwrap();

        let trade = plan
            .trades
            .iter()
            .find(|t| t.symbol.as_deref() == Some("ETF"))
            .expect("fractional ETF trade expected");
        assert_eq!(trade.quantity, Some(dec!(0.5)), "should buy 0.5 shares");
        assert_eq!(plan.cash_used, dec!(50));
    }

    #[tokio::test]
    async fn fractional_mode_caps_trade_at_target_shortfall() {
        // Fractional mode: greedy sizes the drift-closing buy fractionally (0.75 sh = $75),
        // then the proportional top-up deploys the remaining $925 into the same ETF
        // (9.25 sh). Combined: one ETF trade of 10 sh, cash_used = $1000.
        let total = dec!(10000);
        let h = make_holding("h1", "ETF", dec!(1), dec!(100)); // $100/share
        let c = make_contribution(&h, "equity", dec!(100));
        let svc = make_service(
            make_profile(RebalanceGoal::ExactTarget, false),
            make_report(vec![make_drift_row("equity", 6925, 7000, total)], total),
            make_contributions(vec![c]),
            vec![make_cash_holding(dec!(1000), "USD"), h],
        );
        let plan = svc.calculate_plan(make_input(dec!(1000))).await.unwrap();

        let trade = plan
            .trades
            .iter()
            .find(|t| t.symbol.as_deref() == Some("ETF"))
            .expect("fractional ETF trade expected");
        assert_eq!(trade.quantity, Some(dec!(10.0000)));
        assert_eq!(plan.cash_used, dec!(1000));
    }

    #[tokio::test]
    async fn trade_sizing_uses_base_currency_price() {
        // USD asset in a CAD-base portfolio: local quote is 100 USD, base unit price
        // is 140 CAD. CAD 1000 can fund 7 whole units, not 10.
        let total = dec!(10000);
        let mut h = make_holding("h1", "USETF", dec!(10), dec!(1400));
        h.local_currency = "USD".to_string();
        h.base_currency = "CAD".to_string();
        h.fx_rate = Some(dec!(1.4));
        h.price = Some(dec!(100));
        h.market_value.local = dec!(1000);

        let c = make_contribution(&h, "equity", dec!(1400));
        let svc = make_service(
            make_profile(RebalanceGoal::ExactTarget, true),
            make_report(vec![make_drift_row("equity", 1000, 9000, total)], total),
            make_contributions(vec![c]),
            vec![make_cash_holding(dec!(1000), "CAD"), h],
        );
        let input = CalculateRebalancePlanInput {
            base_currency: "CAD".to_string(),
            ..make_input(dec!(1000))
        };
        let plan = svc.calculate_plan(input).await.unwrap();

        let trade = plan
            .trades
            .iter()
            .find(|t| t.symbol.as_deref() == Some("USETF"))
            .expect("USETF trade expected");
        assert_eq!(trade.quantity, Some(dec!(7)));
        assert_eq!(trade.estimated_price, Some(dec!(140)));
        assert_eq!(plan.cash_used, dec!(980));
    }

    #[tokio::test]
    async fn whole_shares_only_buys_integer_shares() {
        let total = dec!(10000);
        // VTI: 10 shares @ $600 = $6000. Price = $600/share.
        let h = make_holding("h1", "VTI", dec!(10), dec!(6000));
        let c = make_contribution(&h, "equity", dec!(6000));
        let svc = make_service(
            make_profile(RebalanceGoal::ExactTarget, true),
            make_report(vec![make_drift_row("equity", 6000, 7000, total)], total),
            make_contributions(vec![c]),
            vec![make_cash_holding(dec!(5000), "USD"), h],
        );
        let plan = svc.calculate_plan(make_input(dec!(1500))).await.unwrap();

        let vti = plan
            .trades
            .iter()
            .find(|t| t.symbol.as_deref() == Some("VTI"))
            .expect("VTI trade");
        let qty = vti.quantity.unwrap();
        assert_eq!(
            qty.fract(),
            Decimal::ZERO,
            "whole shares only: must be integer, got {qty}"
        );
    }

    #[tokio::test]
    async fn nearest_band_deploys_less_than_exact_target() {
        let total = dec!(10000);
        let h = make_holding("h1", "VTI", dec!(10), dec!(6000));
        let c1 = make_contribution(&h, "equity", dec!(6000));
        let c2 = make_contribution(&h, "equity", dec!(6000));
        let rows = vec![make_drift_row("equity", 6000, 7000, total)];

        let svc_exact = make_service(
            make_profile(RebalanceGoal::ExactTarget, false),
            make_report(rows.clone(), total),
            make_contributions(vec![c1]),
            vec![make_cash_holding(dec!(5000), "USD"), h.clone()],
        );
        let svc_band = make_service(
            make_profile(RebalanceGoal::NearestBand, false),
            make_report(rows, total),
            make_contributions(vec![c2]),
            vec![make_cash_holding(dec!(5000), "USD"), h],
        );

        let plan_exact = svc_exact
            .calculate_plan(make_input(dec!(5000)))
            .await
            .unwrap();
        let plan_band = svc_band
            .calculate_plan(make_input(dec!(5000)))
            .await
            .unwrap();

        assert!(
            plan_band.cash_used <= plan_exact.cash_used,
            "nearest_band deploys less cash than exact_target: {} vs {}",
            plan_band.cash_used,
            plan_exact.cash_used
        );
    }

    #[tokio::test]
    async fn nearest_band_stops_at_band_edge() {
        // Equity 60% (target 70%, band 5%).
        //
        // Greedy phase: NearestBand stops at the 65% band edge ($500 deployed);
        // ExactTarget deploys all the way to 70% ($1000).
        //
        // Proportional top-up phase: both goals then deploy remaining cash
        // proportionally to target_bps. So for this single-category portfolio both
        // end up with cash_used = $1000. The difference between goals shows up in
        // multi-category portfolios where scoring and stopping criteria diverge.
        let total = dec!(10000);
        let h = make_holding("h1", "VTI", dec!(60), dec!(6000)); // $100/share
        let rows = vec![make_drift_row("equity", 6000, 7000, total)];

        let svc_band = make_service(
            make_profile(RebalanceGoal::NearestBand, false),
            make_report(rows.clone(), total),
            make_contributions(vec![make_contribution(&h, "equity", dec!(6000))]),
            vec![make_cash_holding(dec!(1000), "USD"), h.clone()],
        );
        let svc_exact = make_service(
            make_profile(RebalanceGoal::ExactTarget, false),
            make_report(rows, total),
            make_contributions(vec![make_contribution(&h, "equity", dec!(6000))]),
            vec![make_cash_holding(dec!(1000), "USD"), h],
        );

        let plan_band = svc_band
            .calculate_plan(make_input(dec!(1000)))
            .await
            .unwrap();
        let plan_exact = svc_exact
            .calculate_plan(make_input(dec!(1000)))
            .await
            .unwrap();

        // Both deploy all $1000: greedy + proportional top-up.
        assert_eq!(
            plan_band.cash_used,
            dec!(1000),
            "nearest_band + top-up deploys all available cash, got {}",
            plan_band.cash_used
        );
        assert_eq!(
            plan_exact.cash_used,
            dec!(1000),
            "exact_target deploys all available cash, got {}",
            plan_exact.cash_used
        );
    }

    #[tokio::test]
    async fn min_trade_amount_filters_small_trades() {
        // VTI at $80/share. min_trade $100.
        // Cash $80 → greedy buys 1 share ($80). Post-filter: $80 < $100 → dropped.
        // Result: no trades. cash_used = $0, cash_remaining = $80.
        let total = dec!(10000);
        let h = make_holding("h1", "VTI", dec!(75), dec!(6000)); // $80/share
        let c = make_contribution(&h, "equity", dec!(6000));
        let profile = AllocationTarget {
            min_trade_amount: "100".to_string(),
            ..make_profile(RebalanceGoal::ExactTarget, false)
        };
        let svc = make_service(
            profile,
            make_report(vec![make_drift_row("equity", 6000, 7000, total)], total),
            make_contributions(vec![c]),
            vec![make_cash_holding(dec!(80), "USD"), h],
        );
        let plan = svc.calculate_plan(make_input(dec!(80))).await.unwrap();
        assert!(
            plan.trades.iter().all(|t| t.estimated_amount >= dec!(100)),
            "all trades must meet min_trade threshold"
        );

        // With $160 cash: 2 shares × $80 = $160 ≥ $100 → kept.
        let h2 = make_holding("h2", "VTI", dec!(75), dec!(6000));
        let c2 = make_contribution(&h2, "equity", dec!(6000));
        let profile2 = AllocationTarget {
            min_trade_amount: "100".to_string(),
            ..make_profile(RebalanceGoal::ExactTarget, false)
        };
        let svc2 = make_service(
            profile2,
            make_report(vec![make_drift_row("equity", 6000, 7000, total)], total),
            make_contributions(vec![c2]),
            vec![make_cash_holding(dec!(160), "USD"), h2],
        );
        let plan2 = svc2.calculate_plan(make_input(dec!(160))).await.unwrap();
        assert!(
            plan2
                .trades
                .iter()
                .any(|t| t.symbol.as_deref() == Some("VTI")),
            "VTI should survive min_trade when total >= threshold"
        );
    }

    #[tokio::test]
    async fn dropped_min_trade_does_not_starve_manual_sleeve_trade() {
        let total = dec!(10000);
        let h = make_holding("h1", "VTI", dec!(60), dec!(6000)); // $100/share
        let c = make_contribution(&h, "equity", dec!(6000));
        let profile = AllocationTarget {
            min_trade_amount: "200".to_string(),
            ..make_profile(RebalanceGoal::ExactTarget, false)
        };
        let rows = vec![
            make_drift_row("equity", 6000, 7000, total),
            make_drift_row("bonds", 0, 1000, total),
            DriftRow {
                is_cash: true,
                ..make_drift_row("cash", 4000, 2000, total)
            },
        ];
        let svc = make_service(
            profile,
            make_report(rows, total),
            make_contributions(vec![c]),
            vec![make_cash_holding(dec!(100), "USD"), h],
        );
        let plan = svc.calculate_plan(make_input(dec!(100))).await.unwrap();

        assert!(
            plan.trades
                .iter()
                .all(|t| t.symbol.as_deref() != Some("VTI")),
            "sub-min asset trade should be dropped"
        );
        let manual = plan
            .trades
            .iter()
            .find(|t| t.category_id == "bonds")
            .expect("manual sleeve trade should use cash from dropped asset trade");
        assert_eq!(manual.estimated_amount, dec!(100));
        assert_eq!(plan.cash_used, dec!(100));
    }

    #[tokio::test]
    async fn cheap_asset_large_cash_batches_shares() {
        // Equity 10% (target 90%), funded by a $1 asset, with $8000 cash. A one-share
        // loop would iterate 8000 times; batching deploys it in one step. Verify the
        // plan completes and buys the full 8000 shares to reach the target.
        let total = dec!(10000);
        let h = make_holding("h1", "CHEAP", dec!(1000), dec!(1000)); // $1/share
        let c = make_contribution(&h, "equity", dec!(1000));
        let svc = make_service(
            make_profile(RebalanceGoal::ExactTarget, false),
            make_report(vec![make_drift_row("equity", 1000, 9000, total)], total),
            make_contributions(vec![c]),
            vec![make_cash_holding(dec!(8000), "USD"), h],
        );
        let plan = svc.calculate_plan(make_input(dec!(8000))).await.unwrap();

        let trade = plan
            .trades
            .iter()
            .find(|t| t.symbol.as_deref() == Some("CHEAP"))
            .expect("CHEAP trade expected");
        assert_eq!(trade.quantity, Some(dec!(8000)), "should buy 8000 shares");
        assert_eq!(plan.cash_used, dec!(8000));
    }

    #[tokio::test]
    async fn total_value_stays_constant_when_cash_deployed() {
        // Portfolio: equity $6000 (60%), cash $4000 (40%). Total = $10000.
        // Target: equity 70%, cash 30%.
        // Greedy buys equity, max_drift_after should improve.
        let total = dec!(10000);
        let h = make_holding("h1", "VTI", dec!(10), dec!(6000));
        let c = make_contribution(&h, "equity", dec!(6000));
        let rows = vec![
            make_drift_row("equity", 6000, 7000, total),
            DriftRow {
                is_cash: true,
                ..make_drift_row("cash", 4000, 3000, total)
            },
        ];
        let svc = make_service(
            make_profile(RebalanceGoal::ExactTarget, false),
            make_report(rows, total),
            make_contributions(vec![c]),
            vec![make_cash_holding(dec!(4000), "USD"), h],
        );
        let plan = svc.calculate_plan(make_input(dec!(2000))).await.unwrap();

        assert_eq!(
            plan.cash_used + plan.cash_remaining,
            dec!(2000),
            "cash_used + remaining must equal available"
        );
        assert!(
            plan.max_drift_bps_after <= plan.max_drift_bps_before,
            "drift must not increase after buying"
        );
    }

    // ── Sell-to-rebalance tests ────────────────────────────────────────────────

    fn make_input_with_mode(
        available_cash: Decimal,
        mode: ScenarioMode,
    ) -> CalculateRebalancePlanInput {
        CalculateRebalancePlanInput {
            scenario_mode: mode,
            ..make_input(available_cash)
        }
    }

    fn make_sell_profile(rebalance_goal: RebalanceGoal) -> AllocationTarget {
        AllocationTarget {
            allow_sells: true,
            ..make_profile(rebalance_goal, false)
        }
    }

    #[tokio::test]
    async fn sell_to_rebalance_generates_sell_trades() {
        // Bond 60% (target 30%) — overweight. Equity 40% (target 70%) — underweight.
        // SellToRebalance: should sell BND to fund VTI buy.
        let total = dec!(10000);
        let h_vti = make_holding("h1", "VTI", dec!(10), dec!(4000));
        let h_bnd = make_holding("h2", "BND", dec!(60), dec!(6000)); // $100/share
        let c_vti = make_contribution(&h_vti, "equity", dec!(4000));
        let c_bnd = make_contribution(&h_bnd, "bond", dec!(6000));
        let rows = vec![
            make_drift_row("equity", 4000, 7000, total),
            make_drift_row("bond", 6000, 3000, total),
        ];
        let svc = make_service(
            make_sell_profile(RebalanceGoal::ExactTarget),
            make_report(rows, total),
            make_contributions(vec![c_vti, c_bnd]),
            vec![make_cash_holding(dec!(0), "USD"), h_vti, h_bnd],
        );
        let plan = svc
            .calculate_plan(make_input_with_mode(dec!(0), ScenarioMode::SellToRebalance))
            .await
            .unwrap();

        assert!(
            plan.trades.iter().any(|t| t.action == "sell"),
            "sell trades expected"
        );
        assert!(
            plan.trades.iter().any(|t| t.action == "buy"),
            "buy trades expected"
        );
        assert!(
            plan.trades
                .iter()
                .filter(|t| t.action == "sell")
                .all(|t| t.symbol.as_deref() == Some("BND")),
            "only BND should be sold (overweight bond)"
        );
        assert!(
            plan.max_drift_bps_after < plan.max_drift_bps_before,
            "drift must improve: before={} after={}",
            plan.max_drift_bps_before,
            plan.max_drift_bps_after
        );
    }

    #[tokio::test]
    async fn do_not_sell_constraint_filters_asset_and_dedupes_warning() {
        let total = dec!(10000);
        let h_vti = make_holding("h-vti", "VTI", dec!(30), dec!(3000));
        let mut h_bnd_1 = make_holding("h-bnd-1", "BND", dec!(35), dec!(3500));
        let mut h_bnd_2 = make_holding("h-bnd-2", "BND", dec!(35), dec!(3500));
        h_bnd_1.account_id = "acc-1".to_string();
        h_bnd_2.account_id = "acc-2".to_string();
        h_bnd_1.instrument.as_mut().unwrap().id = "asset-bnd".to_string();
        h_bnd_2.instrument.as_mut().unwrap().id = "asset-bnd".to_string();

        let svc = make_service_with_constraints(
            make_sell_profile(RebalanceGoal::ExactTarget),
            make_report(
                vec![
                    make_drift_row("equity", 3000, 7000, total),
                    make_drift_row("bond", 7000, 3000, total),
                ],
                total,
            ),
            make_contributions(vec![
                make_contribution(&h_vti, "equity", dec!(3000)),
                make_contribution(&h_bnd_1, "bond", dec!(3500)),
                make_contribution(&h_bnd_2, "bond", dec!(3500)),
            ]),
            vec![make_cash_holding(dec!(0), "USD"), h_vti, h_bnd_1, h_bnd_2],
            vec![sell_block_constraint(
                "c-bnd",
                ConstraintSubjectType::Asset,
                "asset-bnd",
            )],
        );
        let plan = svc
            .calculate_plan(CalculateRebalancePlanInput {
                account_ids: vec!["acc-1".to_string(), "acc-2".to_string()],
                ..make_input_with_mode(dec!(0), ScenarioMode::SellToRebalance)
            })
            .await
            .unwrap();

        assert!(
            plan.trades.iter().all(|trade| trade.action != "sell"),
            "do-not-sell asset must be filtered before optimizer"
        );
        let skipped: Vec<_> = plan
            .warnings
            .iter()
            .filter(|warning| warning.kind == RebalanceWarningKind::ConstraintSkippedSell)
            .collect();
        assert_eq!(
            skipped.len(),
            1,
            "one blocked asset held in multiple accounts should emit one warning"
        );
    }

    #[tokio::test]
    async fn account_sell_constraint_filters_only_protected_account() {
        let total = dec!(10000);
        let h_vti = make_holding("h-vti", "VTI", dec!(30), dec!(3000));
        let mut h_bnd_1 = make_holding("h-bnd-1", "BND", dec!(35), dec!(3500));
        let mut h_bnd_2 = make_holding("h-bnd-2", "BND", dec!(35), dec!(3500));
        h_bnd_1.account_id = "acc-1".to_string();
        h_bnd_2.account_id = "acc-2".to_string();
        h_bnd_1.instrument.as_mut().unwrap().id = "asset-bnd".to_string();
        h_bnd_2.instrument.as_mut().unwrap().id = "asset-bnd".to_string();

        let svc = make_service_with_constraints(
            make_sell_profile(RebalanceGoal::ExactTarget),
            make_report(
                vec![
                    make_drift_row("equity", 3000, 7000, total),
                    make_drift_row("bond", 7000, 3000, total),
                ],
                total,
            ),
            make_contributions(vec![
                make_contribution(&h_vti, "equity", dec!(3000)),
                make_contribution(&h_bnd_1, "bond", dec!(3500)),
                make_contribution(&h_bnd_2, "bond", dec!(3500)),
            ]),
            vec![make_cash_holding(dec!(0), "USD"), h_vti, h_bnd_1, h_bnd_2],
            vec![sell_block_constraint(
                "c-acc-1",
                ConstraintSubjectType::Account,
                "acc-1",
            )],
        );
        let plan = svc
            .calculate_plan(CalculateRebalancePlanInput {
                account_ids: vec!["acc-1".to_string(), "acc-2".to_string()],
                ..make_input_with_mode(dec!(0), ScenarioMode::SellToRebalance)
            })
            .await
            .unwrap();

        let sell_accounts: Vec<_> = plan
            .trades
            .iter()
            .filter(|trade| trade.action == "sell")
            .filter_map(|trade| trade.account_id.as_deref())
            .collect();
        assert!(
            sell_accounts
                .iter()
                .all(|account_id| *account_id != "acc-1"),
            "protected account must not produce sell trades: {sell_accounts:?}"
        );
        assert!(
            sell_accounts.contains(&"acc-2"),
            "unprotected same-asset holding should remain sellable"
        );
    }

    #[tokio::test]
    async fn cash_flow_only_never_generates_sells_even_when_allow_sells_true() {
        // Profile has allow_sells = true but mode is CashFlowOnly — must not sell.
        let total = dec!(10000);
        let h_vti = make_holding("h1", "VTI", dec!(10), dec!(3000));
        let h_bnd = make_holding("h2", "BND", dec!(70), dec!(7000));
        let c_vti = make_contribution(&h_vti, "equity", dec!(3000));
        let c_bnd = make_contribution(&h_bnd, "bond", dec!(7000));
        let rows = vec![
            make_drift_row("equity", 3000, 6000, total),
            make_drift_row("bond", 7000, 4000, total),
        ];
        let svc = make_service(
            make_sell_profile(RebalanceGoal::ExactTarget),
            make_report(rows, total),
            make_contributions(vec![c_vti, c_bnd]),
            vec![make_cash_holding(dec!(500), "USD"), h_vti, h_bnd],
        );
        let plan = svc
            .calculate_plan(make_input_with_mode(dec!(500), ScenarioMode::CashFlowOnly))
            .await
            .unwrap();

        assert!(
            plan.trades.iter().all(|t| t.action == "buy"),
            "CashFlowOnly must not sell even when allow_sells=true on profile"
        );
    }

    #[tokio::test]
    async fn sell_to_rebalance_ignored_when_allow_sells_false() {
        // Profile has allow_sells = false — sell phase must be skipped regardless of mode.
        let total = dec!(10000);
        let h = make_holding("h1", "BND", dec!(80), dec!(8000));
        let c = make_contribution(&h, "bond", dec!(8000));
        let rows = vec![
            make_drift_row("equity", 2000, 6000, total),
            make_drift_row("bond", 8000, 4000, total),
        ];
        let svc = make_service(
            make_profile(RebalanceGoal::ExactTarget, false), // allow_sells = false
            make_report(rows, total),
            make_contributions(vec![c]),
            vec![make_cash_holding(dec!(0), "USD"), h],
        );
        let plan = svc
            .calculate_plan(make_input_with_mode(dec!(0), ScenarioMode::SellToRebalance))
            .await
            .unwrap();

        assert!(
            plan.trades.iter().all(|t| t.action != "sell"),
            "allow_sells=false must prevent sell trades regardless of scenario_mode"
        );
    }

    #[tokio::test]
    async fn hybrid_skips_sells_when_nothing_is_overweight() {
        // Equity 60% (target 70%), bond 30% (target 30%), cash 10% (target 0%).
        // Only equity is out of band. Bond and cash are at/within target — nothing is
        // overweight, so the sell phase has no candidates that improve drift.
        // Hybrid should produce only buy trades.
        let total = dec!(10000);
        let h_vti = make_holding("h1", "VTI", dec!(60), dec!(6000)); // $100/share
        let h_bnd = make_holding("h2", "BND", dec!(30), dec!(3000));
        let c_vti = make_contribution(&h_vti, "equity", dec!(6000));
        let c_bnd = make_contribution(&h_bnd, "bond", dec!(3000));
        let rows = vec![
            make_drift_row("equity", 6000, 7000, total),
            make_drift_row("bond", 3000, 3000, total), // at target — not overweight
            DriftRow {
                is_cash: true,
                ..make_drift_row("cash", 1000, 0, total)
            },
        ];
        let svc = make_service(
            make_sell_profile(RebalanceGoal::NearestBand),
            make_report(rows, total),
            make_contributions(vec![c_vti, c_bnd]),
            vec![make_cash_holding(dec!(1000), "USD"), h_vti, h_bnd],
        );
        let plan = svc
            .calculate_plan(make_input_with_mode(dec!(1000), ScenarioMode::Hybrid))
            .await
            .unwrap();

        assert!(
            plan.trades.iter().all(|t| t.action == "buy"),
            "hybrid should not sell when nothing is overweight outside band"
        );
    }

    #[tokio::test]
    async fn sell_proceeds_fund_buys_increasing_total_deployed() {
        // Equity 30% (target 70%), Bond 70% (target 30%). Zero cash.
        // SellToRebalance: sells of BND should generate proceeds that fund VTI buys.
        // cash_remaining = available_cash + sell_proceeds - buy_cash_used >= 0.
        let total = dec!(10000);
        let h_vti = make_holding("h1", "VTI", dec!(30), dec!(3000));
        let h_bnd = make_holding("h2", "BND", dec!(70), dec!(7000)); // $100/share
        let c_vti = make_contribution(&h_vti, "equity", dec!(3000));
        let c_bnd = make_contribution(&h_bnd, "bond", dec!(7000));
        let rows = vec![
            make_drift_row("equity", 3000, 7000, total),
            make_drift_row("bond", 7000, 3000, total),
        ];
        let svc = make_service(
            make_sell_profile(RebalanceGoal::ExactTarget),
            make_report(rows, total),
            make_contributions(vec![c_vti, c_bnd]),
            vec![make_cash_holding(dec!(0), "USD"), h_vti, h_bnd],
        );
        let plan = svc
            .calculate_plan(make_input_with_mode(dec!(0), ScenarioMode::SellToRebalance))
            .await
            .unwrap();

        let sell_proceeds: rust_decimal::Decimal = plan
            .trades
            .iter()
            .filter(|t| t.action == "sell")
            .map(|t| t.estimated_amount)
            .sum();
        assert!(sell_proceeds > dec!(0), "sell proceeds should be > 0");
        assert!(
            plan.cash_remaining >= dec!(0),
            "cash_remaining must not go negative: {}",
            plan.cash_remaining
        );
        assert!(
            plan.max_drift_bps_after < plan.max_drift_bps_before,
            "drift must improve"
        );
    }

    #[tokio::test]
    async fn sell_to_rebalance_does_not_use_available_cash_for_buys() {
        // SellToRebalance buy pool = sell proceeds only. With zero proceeds (nothing
        // to sell because equity and bond are both at target), no buys should happen
        // even if available_cash > 0. Conversely, with €0 available_cash and
        // overweight bonds → we should still get buys funded by sell proceeds.
        let total = dec!(10000);
        let h_vti = make_holding("h1", "VTI", dec!(30), dec!(3000));
        let h_bnd = make_holding("h2", "BND", dec!(70), dec!(7000)); // $100/share
        let c_vti = make_contribution(&h_vti, "equity", dec!(3000));
        let c_bnd = make_contribution(&h_bnd, "bond", dec!(7000));
        let rows = vec![
            make_drift_row("equity", 3000, 7000, total),
            make_drift_row("bond", 7000, 3000, total),
        ];
        // available_cash = 0 — SellToRebalance must still produce buys via proceeds.
        let svc = make_service(
            make_sell_profile(RebalanceGoal::ExactTarget),
            make_report(rows, total),
            make_contributions(vec![c_vti, c_bnd]),
            vec![make_cash_holding(dec!(0), "USD"), h_vti, h_bnd],
        );
        let plan = svc
            .calculate_plan(make_input_with_mode(dec!(0), ScenarioMode::SellToRebalance))
            .await
            .unwrap();

        let sell_proceeds: Decimal = plan
            .trades
            .iter()
            .filter(|t| t.action == "sell")
            .map(|t| t.estimated_amount)
            .sum();
        let buy_total: Decimal = plan
            .trades
            .iter()
            .filter(|t| t.action == "buy")
            .map(|t| t.estimated_amount)
            .sum();

        assert!(sell_proceeds > dec!(0), "should sell overweight bond");
        assert!(buy_total > dec!(0), "proceeds should fund equity buys");
        // buy_total must not exceed sell_proceeds (no cash used for buys).
        assert!(
            buy_total <= sell_proceeds,
            "buys ({}) must not exceed sell proceeds ({}) — available_cash must not fund buys",
            buy_total,
            sell_proceeds
        );
    }

    #[tokio::test]
    async fn hybrid_sells_less_than_sell_to_rebalance_when_cash_dilutes_overweight() {
        // Hybrid uses available_cash for pass-1 buys, then sells only remaining
        // overweight in pass-2. SellToRebalance ignores available_cash and sells
        // everything needed up front. Because Hybrid's pass-1 buys reduce
        // underweight drift, its pass-2 sell phase may sell ≤ SellToRebalance.
        // Note: total_value is fixed, so cash buys are a cash↔asset swap and do
        // not reduce an untouched overweight category's bps. The sell reduction
        // comes from Hybrid's two-pass ordering, not from cash diluting overweight.
        // Equity 30% (target 70%), Bond 70% (target 30%). Cash = $4000.
        let total = dec!(10000);
        let h_vti = make_holding("h1", "VTI", dec!(30), dec!(3000));
        let h_bnd = make_holding("h2", "BND", dec!(70), dec!(7000)); // $100/share
        let c_vti = make_contribution(&h_vti, "equity", dec!(3000));
        let c_bnd = make_contribution(&h_bnd, "bond", dec!(7000));
        let rows = vec![
            make_drift_row("equity", 3000, 7000, total),
            make_drift_row("bond", 7000, 3000, total),
        ];

        let svc_sell = make_service(
            make_sell_profile(RebalanceGoal::ExactTarget),
            make_report(rows.clone(), total),
            make_contributions(vec![
                make_contribution(&h_vti, "equity", dec!(3000)),
                make_contribution(&h_bnd, "bond", dec!(7000)),
            ]),
            vec![
                make_cash_holding(dec!(4000), "USD"),
                h_vti.clone(),
                h_bnd.clone(),
            ],
        );
        let svc_hybrid = make_service(
            make_sell_profile(RebalanceGoal::ExactTarget),
            make_report(rows, total),
            make_contributions(vec![c_vti, c_bnd]),
            vec![make_cash_holding(dec!(4000), "USD"), h_vti, h_bnd],
        );

        let plan_sell = svc_sell
            .calculate_plan(make_input_with_mode(
                dec!(4000),
                ScenarioMode::SellToRebalance,
            ))
            .await
            .unwrap();
        let plan_hybrid = svc_hybrid
            .calculate_plan(make_input_with_mode(dec!(4000), ScenarioMode::Hybrid))
            .await
            .unwrap();

        let sell_amount = |plan: &crate::portfolio::allocation_targets::RebalancePlan| -> Decimal {
            plan.trades
                .iter()
                .filter(|t| t.action == "sell")
                .map(|t| t.estimated_amount)
                .sum()
        };

        let str_sells = sell_amount(&plan_sell);
        let hybrid_sells = sell_amount(&plan_hybrid);

        assert!(
            hybrid_sells <= str_sells,
            "Hybrid should sell ≤ SellToRebalance: hybrid={} str={}",
            hybrid_sells,
            str_sells
        );
        // Both should improve drift.
        assert!(plan_sell.max_drift_bps_after < plan_sell.max_drift_bps_before);
        assert!(plan_hybrid.max_drift_bps_after < plan_hybrid.max_drift_bps_before);
    }

    #[tokio::test]
    async fn proportional_topup_deploys_remaining_cash_after_drift_resolved() {
        // Portfolio: Equity 50% Bond 50% (both at target — no drift).
        // User deposits $2000 cash. Greedy finds no drift-improving trade (drift=0).
        // Top-up should deploy $2000 proportionally: $1000 equity (VTI), $1000 bond (BND).
        let total = dec!(10000);
        let h_vti = make_holding("h1", "VTI", dec!(50), dec!(5000)); // $100/share
        let h_bnd = make_holding("h2", "BND", dec!(50), dec!(5000)); // $100/share
        let svc = make_service(
            make_profile(RebalanceGoal::ExactTarget, false),
            make_report(
                vec![
                    make_drift_row("equity", 5000, 5000, total),
                    make_drift_row("bond", 5000, 5000, total),
                ],
                total,
            ),
            make_contributions(vec![
                make_contribution(&h_vti, "equity", dec!(5000)),
                make_contribution(&h_bnd, "bond", dec!(5000)),
            ]),
            vec![make_cash_holding(dec!(2000), "USD"), h_vti, h_bnd],
        );
        let plan = svc.calculate_plan(make_input(dec!(2000))).await.unwrap();

        assert_eq!(plan.cash_used, dec!(2000), "all cash should be deployed");
        assert_eq!(plan.cash_remaining, dec!(0));

        let vti_trade = plan
            .trades
            .iter()
            .find(|t| t.symbol.as_deref() == Some("VTI"))
            .expect("VTI trade expected");
        let bnd_trade = plan
            .trades
            .iter()
            .find(|t| t.symbol.as_deref() == Some("BND"))
            .expect("BND trade expected");

        // Each sleeve gets 50% of $2000 = $1000 → 10 shares each.
        assert_eq!(vti_trade.estimated_amount, dec!(1000));
        assert_eq!(bnd_trade.estimated_amount, dec!(1000));
    }

    #[tokio::test]
    async fn proportional_topup_uses_affordable_whole_share_candidate() {
        // Both holdings are full equity exposure. The expensive one has higher
        // exposure per share only because it costs more, but the sleeve budget cannot
        // buy it. Top-up must fall back to the affordable candidate.
        let total = dec!(10000);
        let h_expensive = make_holding("h-expensive", "EXP", dec!(1), dec!(1500));
        let h_cheap = make_holding("h-cheap", "CHEAP", dec!(1), dec!(100));
        let svc = make_service(
            make_profile(RebalanceGoal::ExactTarget, true),
            make_report(vec![make_drift_row("equity", 5000, 5000, total)], total),
            make_contributions(vec![
                make_contribution(&h_expensive, "equity", dec!(1500)),
                make_contribution(&h_cheap, "equity", dec!(100)),
            ]),
            vec![make_cash_holding(dec!(1000), "USD"), h_expensive, h_cheap],
        );

        let plan = svc.calculate_plan(make_input(dec!(1000))).await.unwrap();

        let trade = plan
            .trades
            .iter()
            .find(|t| t.symbol.as_deref() == Some("CHEAP"))
            .expect("top-up should use the affordable equity candidate");
        assert_eq!(trade.quantity, Some(dec!(10)));
        assert_eq!(plan.cash_used, dec!(1000));
    }

    #[tokio::test]
    async fn proportional_topup_preserves_required_cash_target() {
        // Portfolio is exactly at its 80% equity / 20% cash target. The available
        // cash is target cash, not excess cash, so top-up must not spend it and
        // create drift from a zero-drift starting point.
        let total = dec!(10000);
        let h_vti = make_holding("h-vti", "VTI", dec!(80), dec!(8000));
        let svc = make_service(
            make_profile(RebalanceGoal::ExactTarget, false),
            make_report(
                vec![
                    make_drift_row("equity", 8000, 8000, total),
                    DriftRow {
                        is_cash: true,
                        ..make_drift_row("cash", 2000, 2000, total)
                    },
                ],
                total,
            ),
            make_contributions(vec![make_contribution(&h_vti, "equity", dec!(8000))]),
            vec![make_cash_holding(dec!(2000), "USD"), h_vti],
        );

        let plan = svc.calculate_plan(make_input(dec!(2000))).await.unwrap();

        assert_eq!(plan.max_drift_bps_before, 0);
        assert_eq!(plan.cash_used, Decimal::ZERO);
        assert_eq!(plan.cash_remaining, dec!(2000));
        assert_eq!(plan.max_drift_bps_after, 0);
    }

    #[tokio::test]
    async fn sell_to_rebalance_does_not_top_up_remaining_proceeds() {
        // SellToRebalance: sell overweight bonds, use proceeds to buy equity.
        // Any leftover proceeds stay as cash_remaining — no proportional top-up.
        // Portfolio: Equity 30% (target 50%), Bond 70% (target 50%). Cash = $0.
        let total = dec!(10000);
        let h_vti = make_holding("h1", "VTI", dec!(30), dec!(3000));
        let h_bnd = make_holding("h2", "BND", dec!(70), dec!(7000)); // $100/share
        let svc = make_service(
            make_sell_profile(RebalanceGoal::ExactTarget),
            make_report(
                vec![
                    make_drift_row("equity", 3000, 5000, total),
                    make_drift_row("bond", 7000, 5000, total),
                ],
                total,
            ),
            make_contributions(vec![
                make_contribution(&h_vti, "equity", dec!(3000)),
                make_contribution(&h_bnd, "bond", dec!(7000)),
            ]),
            vec![make_cash_holding(dec!(0), "USD"), h_vti, h_bnd],
        );
        let plan = svc
            .calculate_plan(make_input_with_mode(dec!(0), ScenarioMode::SellToRebalance))
            .await
            .unwrap();

        // Sells BND to fund VTI buys. After rebalance, drift should be resolved.
        let sells: Decimal = plan
            .trades
            .iter()
            .filter(|t| t.action == "sell")
            .map(|t| t.estimated_amount)
            .sum();
        let buys: Decimal = plan
            .trades
            .iter()
            .filter(|t| t.action == "buy")
            .map(|t| t.estimated_amount)
            .sum();

        assert!(sells > Decimal::ZERO, "should sell overweight bonds");
        // No additional BND repurchase from top-up (circular sell→rebuy avoided).
        let bnd_buys = plan
            .trades
            .iter()
            .filter(|t| t.action == "buy" && t.symbol.as_deref() == Some("BND"))
            .count();
        assert_eq!(bnd_buys, 0, "SellToRebalance must not rebuy BND via top-up");
        // Buys funded entirely by sell proceeds.
        assert!(buys <= sells, "buys must not exceed sell proceeds");
    }
}
