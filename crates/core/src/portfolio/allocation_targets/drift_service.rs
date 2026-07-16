use async_trait::async_trait;
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::errors::Result as CoreResult;
use crate::portfolio::allocation::{AllocationServiceTrait, TaxonomyHoldingContributions};
use crate::portfolio::holdings::{HoldingType, HoldingsServiceTrait};
use crate::taxonomies::TaxonomyServiceTrait;

use super::cash::{deployable_cash_from_contributions, is_deployable_cash_category, tracked_cash};
use super::model::{
    AllocationTarget, AllocationTargetWeight, DriftHoldingRow, DriftHoldingsReport, DriftReport,
    DriftRow, DriftStatus, ScopeType,
};
use super::target_service::AllocationTargetServiceTrait;

#[derive(Debug, Clone)]
struct CategoryCurrent {
    value: Decimal,
    name: String,
    color: String,
}

#[async_trait]
pub trait DriftServiceTrait: Send + Sync {
    /// Compute the drift report for an explicit target_id.
    async fn get_drift_report_for_target(
        &self,
        target_id: &str,
        account_ids: &[String],
        base_currency: &str,
        aggregated_account_id: &str,
    ) -> CoreResult<DriftReport>;

    /// Compute the drift report and embed holding-level drift rows.
    async fn get_drift_report_with_holdings_for_target(
        &self,
        target_id: &str,
        account_ids: &[String],
        base_currency: &str,
        aggregated_account_id: &str,
    ) -> CoreResult<DriftReport>;
}

pub struct DriftService {
    target_service: Arc<dyn AllocationTargetServiceTrait>,
    allocation_service: Arc<dyn AllocationServiceTrait>,
    holdings_service: Option<Arc<dyn HoldingsServiceTrait>>,
    taxonomy_service: Option<Arc<dyn TaxonomyServiceTrait>>,
}

impl DriftService {
    pub fn new(
        target_service: Arc<dyn AllocationTargetServiceTrait>,
        allocation_service: Arc<dyn AllocationServiceTrait>,
    ) -> Self {
        Self {
            target_service,
            allocation_service,
            holdings_service: None,
            taxonomy_service: None,
        }
    }

    pub fn with_holdings_service(
        mut self,
        holdings_service: Arc<dyn HoldingsServiceTrait>,
    ) -> Self {
        self.holdings_service = Some(holdings_service);
        self
    }

    /// Provide the taxonomy service so category display names/colors can be
    /// resolved for targeted categories that currently hold nothing. Without
    /// it, such rows fall back to showing the raw category id.
    pub fn with_taxonomy_service(
        mut self,
        taxonomy_service: Arc<dyn TaxonomyServiceTrait>,
    ) -> Self {
        self.taxonomy_service = Some(taxonomy_service);
        self
    }

    /// id → (display name, color) for every category in a taxonomy.
    fn category_meta_for_taxonomy(&self, taxonomy_id: &str) -> HashMap<String, (String, String)> {
        let Some(service) = self.taxonomy_service.as_ref() else {
            return HashMap::new();
        };
        match service.get_taxonomy(taxonomy_id) {
            Ok(Some(twc)) => twc
                .categories
                .into_iter()
                .map(|category| (category.id, (category.name, category.color)))
                .collect(),
            _ => HashMap::new(),
        }
    }

    fn target_and_weights(
        &self,
        target_id: &str,
    ) -> CoreResult<(AllocationTarget, Vec<AllocationTargetWeight>)> {
        let target = self.target_service.get_target(target_id)?.ok_or_else(|| {
            crate::errors::Error::Database(crate::errors::DatabaseError::NotFound(format!(
                "AllocationTarget {} not found",
                target_id
            )))
        })?;
        let weights = self.target_service.list_weights_for_target(target_id)?;
        Ok((target, weights))
    }

    fn current_bps(value: Decimal, total_value: Decimal) -> i32 {
        if total_value <= Decimal::ZERO {
            return 0;
        }

        ((value / total_value) * dec!(10000))
            .round()
            .to_i32()
            .unwrap_or(0)
    }

    fn is_gap_row(row: &DriftRow) -> bool {
        row.status == DriftStatus::NotTargeted
            || (row.is_required
                && matches!(
                    row.status,
                    DriftStatus::Underweight | DriftStatus::Overweight
                ))
    }

    fn current_by_category(
        contributions: &TaxonomyHoldingContributions,
    ) -> HashMap<String, CategoryCurrent> {
        let mut current_by_category: HashMap<String, CategoryCurrent> = HashMap::new();

        for contribution in &contributions.contributions {
            let entry = current_by_category
                .entry(contribution.category_id.clone())
                .or_insert_with(|| CategoryCurrent {
                    value: Decimal::ZERO,
                    name: contribution.category_name.clone(),
                    color: contribution.category_color.clone(),
                });
            entry.value += contribution.value;
        }

        current_by_category
    }

    fn build_drift_rows(
        target: &AllocationTarget,
        weights: &[AllocationTargetWeight],
        contributions: &TaxonomyHoldingContributions,
        category_meta: &HashMap<String, (String, String)>,
    ) -> Vec<DriftRow> {
        let total_value = contributions.total_value;
        let current_by_category = Self::current_by_category(contributions);
        let bps_scale = dec!(10000);

        let mut rows: Vec<DriftRow> = weights
            .iter()
            .map(|weight| {
                let current = current_by_category.get(weight.category_id.as_str());
                let current_value = current.map(|current| current.value).unwrap_or_default();
                let current_bps = Self::current_bps(current_value, total_value);
                let target_bps = weight.target_bps;
                let drift_bps = current_bps - target_bps;

                let target_value = if total_value > Decimal::ZERO {
                    total_value * Decimal::from(target_bps) / bps_scale
                } else {
                    Decimal::ZERO
                };
                let value_delta = current_value - target_value;

                let effective_band = target.band_type.effective_band_bps(
                    target_bps,
                    target.drift_band_bps,
                    target.relative_factor_bps,
                );
                let status = if drift_bps.abs() <= effective_band {
                    DriftStatus::InBand
                } else if drift_bps < 0 {
                    DriftStatus::Underweight
                } else {
                    DriftStatus::Overweight
                };

                DriftRow {
                    category_id: weight.category_id.clone(),
                    category_name: current
                        .map(|current| current.name.clone())
                        .or_else(|| {
                            category_meta
                                .get(weight.category_id.as_str())
                                .map(|(name, _)| name.clone())
                        })
                        .unwrap_or_else(|| weight.category_id.clone()),
                    color: current
                        .map(|current| current.color.clone())
                        .or_else(|| {
                            category_meta
                                .get(weight.category_id.as_str())
                                .map(|(_, color)| color.clone())
                        })
                        .unwrap_or_else(|| "#94a3b8".to_string()),
                    current_bps,
                    target_bps,
                    drift_bps,
                    current_value,
                    target_value,
                    value_delta,
                    effective_band_bps: effective_band,
                    status,
                    is_required: weight.is_required,
                    is_zero_current: current_value == Decimal::ZERO,
                    is_cash: is_deployable_cash_category(&target.taxonomy_id, &weight.category_id),
                }
            })
            .filter(|row| row.is_required || row.current_value > Decimal::ZERO)
            .collect();

        let targeted_ids: HashSet<&str> = weights
            .iter()
            .map(|weight| weight.category_id.as_str())
            .collect();

        for (category_id, current) in current_by_category {
            if targeted_ids.contains(category_id.as_str()) {
                continue;
            }

            let current_bps = Self::current_bps(current.value, total_value);
            let is_cash = is_deployable_cash_category(&target.taxonomy_id, &category_id);
            rows.push(DriftRow {
                category_id,
                category_name: current.name,
                color: current.color,
                current_bps,
                target_bps: 0,
                drift_bps: current_bps,
                current_value: current.value,
                target_value: Decimal::ZERO,
                value_delta: current.value,
                effective_band_bps: 0,
                status: DriftStatus::NotTargeted,
                is_required: false,
                is_zero_current: current.value == Decimal::ZERO,
                is_cash,
            });
        }

        rows.sort_by(|a, b| {
            let a_targeted = a.status != DriftStatus::NotTargeted;
            let b_targeted = b.status != DriftStatus::NotTargeted;
            b_targeted
                .cmp(&a_targeted)
                .then(b.drift_bps.unsigned_abs().cmp(&a.drift_bps.unsigned_abs()))
                .then_with(|| a.category_id.cmp(&b.category_id))
        });

        rows
    }

    fn build_drift_holdings_report(
        target_id: &str,
        base_currency: &str,
        weights: &[AllocationTargetWeight],
        contributions: &TaxonomyHoldingContributions,
    ) -> DriftHoldingsReport {
        let total_value = contributions.total_value;
        let target_bps_by_category: HashMap<&str, i32> = weights
            .iter()
            .map(|weight| (weight.category_id.as_str(), weight.target_bps))
            .collect();
        let mut current_value_by_category: HashMap<String, Decimal> = HashMap::new();
        for contribution in &contributions.contributions {
            *current_value_by_category
                .entry(contribution.category_id.clone())
                .or_default() += contribution.value;
        }

        let mut rows: Vec<DriftHoldingRow> = contributions
            .contributions
            .iter()
            .map(|contribution| {
                let current_pct = if total_value > Decimal::ZERO {
                    contribution.value / total_value * dec!(100)
                } else {
                    Decimal::ZERO
                };
                let target_bps = target_bps_by_category
                    .get(contribution.category_id.as_str())
                    .copied()
                    .unwrap_or(0);
                let category_value = current_value_by_category
                    .get(contribution.category_id.as_str())
                    .copied()
                    .unwrap_or_default();
                let target_pct = if category_value > Decimal::ZERO {
                    Some(
                        contribution.value / category_value * Decimal::from(target_bps) / dec!(100),
                    )
                } else {
                    None
                };
                let drift_bps = target_pct.map(|target_pct| {
                    ((current_pct - target_pct) * dec!(100))
                        .round()
                        .to_i32()
                        .unwrap_or(0)
                });

                DriftHoldingRow {
                    id: contribution.id.clone(),
                    holding_id: contribution.holding_id.clone(),
                    asset_id: contribution.asset_id.clone(),
                    account_id: contribution.account_id.clone(),
                    source_account_ids: contribution.source_account_ids.clone(),
                    symbol: contribution.symbol.clone(),
                    name: contribution.name.clone(),
                    category_id: contribution.category_id.clone(),
                    category_name: contribution.category_name.clone(),
                    category_color: Some(contribution.category_color.clone()),
                    value: contribution.value,
                    current_pct,
                    target_pct,
                    drift_bps,
                    is_unknown_category: contribution.category_id == "__UNKNOWN__",
                    is_cash: contribution.holding_type == HoldingType::Cash,
                }
            })
            .collect();

        rows.sort_by(|a, b| {
            let a_drift = a.drift_bps.map(|drift| drift.abs()).unwrap_or(-1);
            let b_drift = b.drift_bps.map(|drift| drift.abs()).unwrap_or(-1);
            b_drift
                .cmp(&a_drift)
                .then_with(|| b.value.cmp(&a.value))
                .then_with(|| a.id.cmp(&b.id))
        });

        DriftHoldingsReport {
            target_id: target_id.to_string(),
            total_value,
            base_currency: base_currency.to_string(),
            rows,
        }
    }

    async fn drift_report_for_target(
        &self,
        target_id: &str,
        account_ids: &[String],
        base_currency: &str,
        aggregated_account_id: &str,
        include_holdings: bool,
    ) -> CoreResult<DriftReport> {
        let (target, weights) = self.target_and_weights(target_id)?;
        let contributions = self
            .allocation_service
            .get_holding_contributions_for_taxonomy_for_accounts(
                account_ids,
                base_currency,
                &target.taxonomy_id,
                aggregated_account_id,
            )
            .await?;

        let category_meta = self.category_meta_for_taxonomy(&target.taxonomy_id);
        let rows = Self::build_drift_rows(&target, &weights, &contributions, &category_meta);
        let max_drift_bps = rows
            .iter()
            .filter(|row| Self::is_gap_row(row))
            .map(|row| row.drift_bps.unsigned_abs() as i32)
            .max()
            .unwrap_or(0);
        let out_of_band_count = rows.iter().filter(|row| Self::is_gap_row(row)).count();
        let scope_type = ScopeType::try_from(target.scope_type.as_str()).unwrap_or(ScopeType::All);
        let holdings = include_holdings.then(|| {
            Self::build_drift_holdings_report(target_id, base_currency, &weights, &contributions)
        });

        let deployable_cash = if let Some(cash) =
            deployable_cash_from_contributions(&target.taxonomy_id, &contributions)
        {
            cash
        } else if let Some(holdings_service) = self.holdings_service.as_ref() {
            let holdings = holdings_service
                .get_holdings_for_accounts(account_ids, base_currency, aggregated_account_id)
                .await?;
            tracked_cash(&holdings)
        } else {
            Decimal::ZERO
        };

        Ok(DriftReport {
            target_id: target_id.to_string(),
            scope_type,
            scope_id: target.scope_id,
            total_value: contributions.total_value,
            base_currency: base_currency.to_string(),
            max_drift_bps,
            out_of_band_count,
            rows,
            holdings,
            deployable_cash,
        })
    }
}

#[async_trait]
impl DriftServiceTrait for DriftService {
    async fn get_drift_report_for_target(
        &self,
        target_id: &str,
        account_ids: &[String],
        base_currency: &str,
        aggregated_account_id: &str,
    ) -> CoreResult<DriftReport> {
        self.drift_report_for_target(
            target_id,
            account_ids,
            base_currency,
            aggregated_account_id,
            false,
        )
        .await
    }

    async fn get_drift_report_with_holdings_for_target(
        &self,
        target_id: &str,
        account_ids: &[String],
        base_currency: &str,
        aggregated_account_id: &str,
    ) -> CoreResult<DriftReport> {
        self.drift_report_for_target(
            target_id,
            account_ids,
            base_currency,
            aggregated_account_id,
            true,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::Result as CoreResult;
    use crate::portfolio::allocation::{
        AllocationHoldings, CategoryAllocation, HoldingAllocationContribution,
        PortfolioAllocations, TaxonomyAllocation, TaxonomyHoldingContributions,
    };
    use crate::portfolio::allocation_targets::model::{
        AllocationTarget, AllocationTargetWeight, BandType, NewAllocationTarget,
        NewAllocationTargetWeight, RebalanceGoal, SaveAllocationTargetResult, ScopeType,
        TriggerType,
    };
    use crate::portfolio::holdings::{Holding, HoldingType, MonetaryValue};
    use async_trait::async_trait;
    use rust_decimal_macros::dec;

    // ── Helpers ──────────────────────────────────────────────────────────────

    fn base_target(drift_band_bps: i32) -> AllocationTarget {
        AllocationTarget {
            id: "p1".to_string(),
            name: "Test".to_string(),
            scope_type: ScopeType::All,
            scope_id: None,
            taxonomy_id: "asset_classes".to_string(),
            trigger_type: TriggerType::Threshold,
            drift_band_bps,
            band_type: BandType::Absolute,
            relative_factor_bps: 2000,
            rebalance_goal: RebalanceGoal::NearestBand,
            min_trade_amount: "0".to_string(),
            whole_shares_only: false,
            allow_sells: false,
            max_turnover_bps: None,
            created_at: "2026-01-01".to_string(),
            updated_at: "2026-01-01".to_string(),
            archived_at: None,
        }
    }

    fn target_with_taxonomy(taxonomy_id: &str, drift_band_bps: i32) -> AllocationTarget {
        AllocationTarget {
            taxonomy_id: taxonomy_id.to_string(),
            ..base_target(drift_band_bps)
        }
    }

    fn weight(category_id: &str, target_bps: i32) -> AllocationTargetWeight {
        AllocationTargetWeight {
            id: uuid::Uuid::new_v4().to_string(),
            target_id: "p1".to_string(),
            taxonomy_id: "asset_classes".to_string(),
            category_id: category_id.to_string(),
            target_bps,
            is_locked: false,
            is_required: true,
            created_at: "2026-01-01".to_string(),
            updated_at: "2026-01-01".to_string(),
        }
    }

    fn optional_weight(category_id: &str, target_bps: i32) -> AllocationTargetWeight {
        AllocationTargetWeight {
            is_required: false,
            ..weight(category_id, target_bps)
        }
    }

    fn cat(category_id: &str, value: rust_decimal::Decimal) -> CategoryAllocation {
        CategoryAllocation {
            category_id: category_id.to_string(),
            category_name: category_id.to_string(),
            color: "#000000".to_string(),
            value,
            percentage: rust_decimal::Decimal::ZERO,
            children: vec![],
        }
    }

    fn make_cash_holding(amount: Decimal, currency: &str) -> Holding {
        Holding {
            id: "cash".to_string(),
            account_id: "acc".to_string(),
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

    fn holding_contribution(category_id: &str, value: Decimal) -> HoldingAllocationContribution {
        HoldingAllocationContribution {
            id: format!("asset:{category_id}:0"),
            holding_id: format!("holding-{category_id}"),
            asset_id: format!("asset-{category_id}"),
            account_id: "acc".to_string(),
            source_account_ids: vec![],
            symbol: category_id.to_string(),
            name: category_id.to_string(),
            holding_type: HoldingType::Security,
            quantity: dec!(1),
            category_id: category_id.to_string(),
            category_name: category_id.to_string(),
            category_color: "#111111".to_string(),
            value,
        }
    }

    fn cash_contribution(category_id: &str, value: Decimal) -> HoldingAllocationContribution {
        HoldingAllocationContribution {
            id: format!("cash:{category_id}:0"),
            holding_id: "cash".to_string(),
            asset_id: "cash".to_string(),
            symbol: "USD".to_string(),
            name: "Cash (USD)".to_string(),
            holding_type: HoldingType::Cash,
            quantity: value,
            ..holding_contribution(category_id, value)
        }
    }

    fn alloc_with(
        categories: Vec<CategoryAllocation>,
        total: rust_decimal::Decimal,
    ) -> PortfolioAllocations {
        PortfolioAllocations {
            asset_classes: TaxonomyAllocation {
                taxonomy_id: "asset_classes".to_string(),
                taxonomy_name: "Asset Classes".to_string(),
                color: "#000000".to_string(),
                categories,
            },
            total_value: total,
            ..Default::default()
        }
    }

    fn taxonomy_alloc(
        taxonomy_id: &str,
        categories: Vec<CategoryAllocation>,
    ) -> TaxonomyAllocation {
        TaxonomyAllocation {
            taxonomy_id: taxonomy_id.to_string(),
            taxonomy_name: taxonomy_id.to_string(),
            color: "#000000".to_string(),
            categories,
        }
    }

    fn contributions_from_allocations(
        taxonomy_id: &str,
        allocations: &PortfolioAllocations,
    ) -> TaxonomyHoldingContributions {
        let allocation = match taxonomy_id {
            "asset_classes" => Some(&allocations.asset_classes),
            "industries_gics" => Some(&allocations.sectors),
            "regions" => Some(&allocations.regions),
            "risk_category" => Some(&allocations.risk_category),
            "instrument_type" => Some(&allocations.security_types),
            other => allocations
                .custom_groups
                .iter()
                .find(|allocation| allocation.taxonomy_id == other),
        };

        let (taxonomy_name, total_value, categories) = match allocation {
            Some(allocation) => {
                let category_total = allocation
                    .categories
                    .iter()
                    .map(|category| category.value)
                    .sum();
                let total_value = if taxonomy_id == "asset_classes" {
                    allocations.total_value
                } else {
                    category_total
                };
                (
                    allocation.taxonomy_name.clone(),
                    total_value,
                    allocation.categories.clone(),
                )
            }
            None => (taxonomy_id.to_string(), Decimal::ZERO, Vec::new()),
        };

        let contributions = categories
            .into_iter()
            .enumerate()
            .filter(|(_, category)| category.value > Decimal::ZERO)
            .map(|(index, category)| HoldingAllocationContribution {
                id: format!("holding-{index}:{}", category.category_id),
                holding_id: format!("holding-{index}"),
                asset_id: format!("asset-{index}"),
                account_id: "acc".to_string(),
                source_account_ids: vec![],
                symbol: category.category_id.clone(),
                name: category.category_name.clone(),
                holding_type: HoldingType::Security,
                quantity: dec!(1),
                category_id: category.category_id,
                category_name: category.category_name,
                category_color: category.color,
                value: category.value,
            })
            .collect();

        TaxonomyHoldingContributions {
            taxonomy_id: taxonomy_id.to_string(),
            taxonomy_name,
            total_value,
            currency: "USD".to_string(),
            contributions,
        }
    }

    // ── Mocks ────────────────────────────────────────────────────────────────

    struct MockTargetService {
        target: AllocationTarget,
        weights: Vec<AllocationTargetWeight>,
    }

    #[async_trait]
    impl AllocationTargetServiceTrait for MockTargetService {
        fn get_target(&self, _id: &str) -> CoreResult<Option<AllocationTarget>> {
            Ok(Some(self.target.clone()))
        }
        fn list_targets(&self) -> CoreResult<Vec<AllocationTarget>> {
            Ok(vec![self.target.clone()])
        }
        fn list_weights_for_target(
            &self,
            _target_id: &str,
        ) -> CoreResult<Vec<AllocationTargetWeight>> {
            Ok(self.weights.clone())
        }
        async fn create_target(&self, _input: NewAllocationTarget) -> CoreResult<AllocationTarget> {
            unimplemented!()
        }
        async fn update_target(
            &self,
            _id: &str,
            _input: NewAllocationTarget,
        ) -> CoreResult<AllocationTarget> {
            unimplemented!()
        }
        async fn archive_target(&self, _id: &str) -> CoreResult<AllocationTarget> {
            unimplemented!()
        }
        async fn delete_target(&self, _id: &str) -> CoreResult<()> {
            unimplemented!()
        }
        async fn save_weights(
            &self,
            _target_id: &str,
            _nodes: Vec<NewAllocationTargetWeight>,
        ) -> CoreResult<Vec<AllocationTargetWeight>> {
            unimplemented!()
        }
        async fn save_target_with_weights(
            &self,
            _id: Option<String>,
            _input: NewAllocationTarget,
            _weights: Vec<NewAllocationTargetWeight>,
        ) -> CoreResult<SaveAllocationTargetResult> {
            unimplemented!()
        }
        fn list_target_constraints(
            &self,
            _: &str,
        ) -> CoreResult<Vec<crate::portfolio::allocation_targets::AllocationTargetConstraint>>
        {
            Ok(vec![])
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

    struct MockAllocationService {
        allocations: PortfolioAllocations,
        contributions: TaxonomyHoldingContributions,
    }

    #[async_trait]
    impl crate::portfolio::allocation::AllocationServiceTrait for MockAllocationService {
        async fn get_portfolio_allocations(
            &self,
            _account_id: &str,
            _base_currency: &str,
        ) -> CoreResult<PortfolioAllocations> {
            Ok(self.allocations.clone())
        }
        async fn get_portfolio_allocations_for_accounts(
            &self,
            _account_ids: &[String],
            _base_currency: &str,
            _aggregated_account_id: &str,
        ) -> CoreResult<PortfolioAllocations> {
            Ok(self.allocations.clone())
        }
        async fn get_holdings_by_allocation(
            &self,
            _account_id: &str,
            _base_currency: &str,
            _taxonomy_id: &str,
            _category_id: &str,
        ) -> CoreResult<AllocationHoldings> {
            unimplemented!()
        }
        async fn get_holdings_by_allocation_for_accounts(
            &self,
            _account_ids: &[String],
            _base_currency: &str,
            _taxonomy_id: &str,
            _category_id: &str,
            _aggregated_account_id: &str,
        ) -> CoreResult<AllocationHoldings> {
            unimplemented!()
        }
        async fn get_holding_contributions_for_taxonomy_for_accounts(
            &self,
            _account_ids: &[String],
            _base_currency: &str,
            _taxonomy_id: &str,
            _aggregated_account_id: &str,
        ) -> CoreResult<TaxonomyHoldingContributions> {
            Ok(self.contributions.clone())
        }
    }

    struct MockHoldingsService {
        holdings: Vec<Holding>,
    }

    #[async_trait]
    impl crate::portfolio::holdings::HoldingsServiceTrait for MockHoldingsService {
        async fn get_holdings(
            &self,
            _account_id: &str,
            _base_currency: &str,
        ) -> CoreResult<Vec<Holding>> {
            Ok(self.holdings.clone())
        }
        async fn get_holdings_for_accounts(
            &self,
            _account_ids: &[String],
            _base_currency: &str,
            _aggregated_account_id: &str,
        ) -> CoreResult<Vec<Holding>> {
            Ok(self.holdings.clone())
        }
        async fn get_holding(
            &self,
            _holding_id: &str,
            _account_id: &str,
            _base_currency: &str,
        ) -> CoreResult<Option<Holding>> {
            Ok(self.holdings.first().cloned())
        }
        async fn holdings_from_snapshot(
            &self,
            _snapshot: &crate::portfolio::snapshot::AccountStateSnapshot,
            _base_currency: &str,
        ) -> CoreResult<Vec<Holding>> {
            Ok(self.holdings.clone())
        }
    }

    fn make_service(
        target: AllocationTarget,
        weights: Vec<AllocationTargetWeight>,
        allocations: PortfolioAllocations,
    ) -> DriftService {
        let contributions = contributions_from_allocations(&target.taxonomy_id, &allocations);
        DriftService::new(
            Arc::new(MockTargetService { target, weights }),
            Arc::new(MockAllocationService {
                allocations,
                contributions,
            }),
        )
    }

    fn make_service_with_contributions(
        target: AllocationTarget,
        weights: Vec<AllocationTargetWeight>,
        allocations: PortfolioAllocations,
        contributions: TaxonomyHoldingContributions,
    ) -> DriftService {
        DriftService::new(
            Arc::new(MockTargetService { target, weights }),
            Arc::new(MockAllocationService {
                allocations,
                contributions,
            }),
        )
    }

    fn make_service_with_holdings(
        target: AllocationTarget,
        weights: Vec<AllocationTargetWeight>,
        allocations: PortfolioAllocations,
        holdings: Vec<Holding>,
    ) -> DriftService {
        let contributions = contributions_from_allocations(&target.taxonomy_id, &allocations);
        DriftService::new(
            Arc::new(MockTargetService { target, weights }),
            Arc::new(MockAllocationService {
                allocations,
                contributions,
            }),
        )
        .with_holdings_service(Arc::new(MockHoldingsService { holdings }))
    }

    // ── Tests ────────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn overweight_detected() {
        // EQUITY current=70% (7000 bps), target=60% (6000 bps), band=500 → drift=+1000 → Overweight
        let svc = make_service(
            base_target(500),
            vec![weight("EQUITY", 6000), weight("BONDS", 4000)],
            alloc_with(
                vec![cat("EQUITY", dec!(7000)), cat("BONDS", dec!(3000))],
                dec!(10000),
            ),
        );
        let report = svc
            .get_drift_report_for_target("p1", &[], "USD", "agg")
            .await
            .unwrap();

        let equity = report
            .rows
            .iter()
            .find(|r| r.category_id == "EQUITY")
            .unwrap();
        assert_eq!(equity.current_bps, 7000);
        assert_eq!(equity.target_bps, 6000);
        assert_eq!(equity.drift_bps, 1000);
        assert_eq!(equity.status, DriftStatus::Overweight);
    }

    #[tokio::test]
    async fn underweight_detected() {
        // BONDS current=30% (3000 bps), target=40% (4000 bps), band=500 → drift=-1000 → Underweight
        let svc = make_service(
            base_target(500),
            vec![weight("EQUITY", 6000), weight("BONDS", 4000)],
            alloc_with(
                vec![cat("EQUITY", dec!(7000)), cat("BONDS", dec!(3000))],
                dec!(10000),
            ),
        );
        let report = svc
            .get_drift_report_for_target("p1", &[], "USD", "agg")
            .await
            .unwrap();

        let bonds = report
            .rows
            .iter()
            .find(|r| r.category_id == "BONDS")
            .unwrap();
        assert_eq!(bonds.drift_bps, -1000);
        assert_eq!(bonds.status, DriftStatus::Underweight);
    }

    #[tokio::test]
    async fn in_band_detected() {
        // EQUITY current=61% (6100 bps), target=60% (6000 bps), band=500 → drift=+100 → InBand
        let svc = make_service(
            base_target(500),
            vec![weight("EQUITY", 6000), weight("BONDS", 4000)],
            alloc_with(
                vec![cat("EQUITY", dec!(6100)), cat("BONDS", dec!(3900))],
                dec!(10000),
            ),
        );
        let report = svc
            .get_drift_report_for_target("p1", &[], "USD", "agg")
            .await
            .unwrap();

        let equity = report
            .rows
            .iter()
            .find(|r| r.category_id == "EQUITY")
            .unwrap();
        assert_eq!(equity.drift_bps, 100);
        assert_eq!(equity.status, DriftStatus::InBand);
    }

    #[tokio::test]
    async fn zero_current_marks_is_zero_current_and_underweight() {
        // Weight for BONDS but no current allocation → is_zero_current=true, Underweight
        let svc = make_service(
            base_target(500),
            vec![weight("EQUITY", 6000), weight("BONDS", 4000)],
            alloc_with(
                vec![cat("EQUITY", dec!(10000))], // no BONDS position
                dec!(10000),
            ),
        );
        let report = svc
            .get_drift_report_for_target("p1", &[], "USD", "agg")
            .await
            .unwrap();

        let bonds = report
            .rows
            .iter()
            .find(|r| r.category_id == "BONDS")
            .unwrap();
        assert!(bonds.is_zero_current);
        assert_eq!(bonds.current_bps, 0);
        assert_eq!(bonds.drift_bps, -4000);
        assert_eq!(bonds.status, DriftStatus::Underweight);
    }

    #[tokio::test]
    async fn not_targeted_category_appended() {
        // CASH in alloc but not in weights → NotTargeted row
        let svc = make_service(
            base_target(500),
            vec![weight("EQUITY", 10000)],
            alloc_with(
                vec![cat("EQUITY", dec!(8000)), cat("CASH", dec!(2000))],
                dec!(10000),
            ),
        );
        let report = svc
            .get_drift_report_for_target("p1", &[], "USD", "agg")
            .await
            .unwrap();

        let cash = report
            .rows
            .iter()
            .find(|r| r.category_id == "CASH")
            .unwrap();
        assert_eq!(cash.status, DriftStatus::NotTargeted);
        assert_eq!(cash.target_bps, 0);
        assert_eq!(cash.current_bps, 2000);
        assert_eq!(cash.drift_bps, 2000);
        assert_eq!(report.max_drift_bps, 2000);
        assert_eq!(report.out_of_band_count, 2);
    }

    #[tokio::test]
    async fn optional_zero_current_weight_is_not_shown_or_counted_as_gap() {
        let svc = make_service(
            base_target(500),
            vec![weight("EQUITY", 7000), optional_weight("OPTIONAL", 3000)],
            alloc_with(
                vec![cat("EQUITY", dec!(8000)), cat("CASH", dec!(2000))],
                dec!(10000),
            ),
        );

        let report = svc
            .get_drift_report_for_target("p1", &[], "USD", "agg")
            .await
            .unwrap();

        assert!(report.rows.iter().all(|row| row.category_id != "OPTIONAL"));
        assert_eq!(report.out_of_band_count, 2);
        assert_eq!(report.max_drift_bps, 2000);
    }

    #[tokio::test]
    async fn tiny_not_targeted_value_is_still_counted_as_gap() {
        let svc = make_service(
            base_target(500),
            vec![weight("EQUITY", 10000)],
            alloc_with(
                vec![cat("EQUITY", dec!(999999)), cat("DUST", dec!(1))],
                dec!(1000000),
            ),
        );

        let report = svc
            .get_drift_report_for_target("p1", &[], "USD", "agg")
            .await
            .unwrap();
        let dust = report
            .rows
            .iter()
            .find(|row| row.category_id == "DUST")
            .unwrap();

        assert_eq!(dust.status, DriftStatus::NotTargeted);
        assert_eq!(dust.current_bps, 0);
        assert_eq!(dust.current_value, dec!(1));
        assert_eq!(report.out_of_band_count, 1);
    }

    #[tokio::test]
    async fn max_drift_bps_from_required_rows() {
        // EQUITY drift=+1000, BONDS drift=-1000 → max_drift_bps=1000
        let svc = make_service(
            base_target(500),
            vec![weight("EQUITY", 6000), weight("BONDS", 4000)],
            alloc_with(
                vec![cat("EQUITY", dec!(7000)), cat("BONDS", dec!(3000))],
                dec!(10000),
            ),
        );
        let report = svc
            .get_drift_report_for_target("p1", &[], "USD", "agg")
            .await
            .unwrap();

        assert_eq!(report.max_drift_bps, 1000);
    }

    #[tokio::test]
    async fn out_of_band_count_correct() {
        // Both EQUITY and BONDS out of band → count=2
        let svc = make_service(
            base_target(500),
            vec![weight("EQUITY", 6000), weight("BONDS", 4000)],
            alloc_with(
                vec![cat("EQUITY", dec!(7000)), cat("BONDS", dec!(3000))],
                dec!(10000),
            ),
        );
        let report = svc
            .get_drift_report_for_target("p1", &[], "USD", "agg")
            .await
            .unwrap();

        assert_eq!(report.out_of_band_count, 2);
    }

    #[tokio::test]
    async fn drift_holdings_prorate_target_by_category_current_share() {
        let svc = make_service_with_contributions(
            base_target(500),
            vec![weight("EQUITY", 6000), weight("BONDS", 4000)],
            alloc_with(
                vec![cat("EQUITY", dec!(7000)), cat("BONDS", dec!(3000))],
                dec!(10000),
            ),
            TaxonomyHoldingContributions {
                taxonomy_id: "asset_classes".to_string(),
                taxonomy_name: "Asset Classes".to_string(),
                total_value: dec!(10000),
                currency: "USD".to_string(),
                contributions: vec![
                    HoldingAllocationContribution {
                        id: "aapl:EQUITY:0".to_string(),
                        holding_id: "aapl".to_string(),
                        asset_id: "aapl".to_string(),
                        account_id: "acc".to_string(),
                        source_account_ids: vec![],
                        symbol: "AAPL".to_string(),
                        name: "Apple".to_string(),
                        holding_type: HoldingType::Security,
                        quantity: dec!(1),
                        category_id: "EQUITY".to_string(),
                        category_name: "Equity".to_string(),
                        category_color: "#111111".to_string(),
                        value: dec!(7000),
                    },
                    HoldingAllocationContribution {
                        id: "bnd:BONDS:0".to_string(),
                        holding_id: "bnd".to_string(),
                        asset_id: "bnd".to_string(),
                        account_id: "acc".to_string(),
                        source_account_ids: vec![],
                        symbol: "BND".to_string(),
                        name: "Bond ETF".to_string(),
                        holding_type: HoldingType::Security,
                        quantity: dec!(1),
                        category_id: "BONDS".to_string(),
                        category_name: "Bonds".to_string(),
                        category_color: "#222222".to_string(),
                        value: dec!(3000),
                    },
                ],
            },
        );

        let report = svc
            .get_drift_report_with_holdings_for_target("p1", &[], "USD", "agg")
            .await
            .unwrap();
        let holdings = report.holdings.unwrap();

        let equity = holdings
            .rows
            .iter()
            .find(|row| row.category_id == "EQUITY")
            .unwrap();
        let bonds = holdings
            .rows
            .iter()
            .find(|row| row.category_id == "BONDS")
            .unwrap();

        assert_eq!(equity.current_pct, dec!(70));
        assert_eq!(equity.target_pct, Some(dec!(60)));
        assert_eq!(equity.drift_bps, Some(1000));
        assert_eq!(bonds.current_pct, dec!(30));
        assert_eq!(bonds.target_pct, Some(dec!(40)));
        assert_eq!(bonds.drift_bps, Some(-1000));
    }

    #[tokio::test]
    async fn drift_holdings_uses_exact_category_value_for_tiny_category() {
        let svc = make_service_with_contributions(
            base_target(500),
            vec![weight("TINY", 100), weight("OTHER", 9900)],
            alloc_with(vec![], dec!(1000000)),
            TaxonomyHoldingContributions {
                taxonomy_id: "asset_classes".to_string(),
                taxonomy_name: "Asset Classes".to_string(),
                total_value: dec!(1000000),
                currency: "USD".to_string(),
                contributions: vec![
                    holding_contribution("TINY", dec!(1)),
                    holding_contribution("OTHER", dec!(999999)),
                ],
            },
        );

        let report = svc
            .get_drift_report_with_holdings_for_target("p1", &[], "USD", "agg")
            .await
            .unwrap();
        let holdings = report.holdings.unwrap();
        let tiny = holdings
            .rows
            .iter()
            .find(|row| row.category_id == "TINY")
            .unwrap();

        assert_eq!(tiny.current_pct, dec!(0.0001));
        assert_eq!(tiny.target_pct, Some(dec!(1)));
        assert_eq!(tiny.drift_bps, Some(-100));
    }

    #[tokio::test]
    async fn drift_report_can_embed_holding_rows_from_same_contributions() {
        let svc = make_service_with_contributions(
            base_target(500),
            vec![weight("EQUITY", 6000), weight("BONDS", 4000)],
            alloc_with(vec![], dec!(10000)),
            TaxonomyHoldingContributions {
                taxonomy_id: "asset_classes".to_string(),
                taxonomy_name: "Asset Classes".to_string(),
                total_value: dec!(10000),
                currency: "USD".to_string(),
                contributions: vec![
                    holding_contribution("EQUITY", dec!(7000)),
                    holding_contribution("BONDS", dec!(3000)),
                ],
            },
        );

        let report = svc
            .get_drift_report_with_holdings_for_target("p1", &[], "USD", "agg")
            .await
            .unwrap();

        assert_eq!(report.rows.len(), 2);
        assert_eq!(report.holdings.as_ref().unwrap().rows.len(), 2);
    }

    #[tokio::test]
    async fn total_value_zero_all_bps_zero() {
        // Empty portfolio → all current_bps = 0, no drift
        let svc = make_service(
            base_target(500),
            vec![weight("EQUITY", 6000), weight("BONDS", 4000)],
            alloc_with(vec![], dec!(0)),
        );
        let report = svc
            .get_drift_report_for_target("p1", &[], "USD", "agg")
            .await
            .unwrap();

        for row in &report.rows {
            assert_eq!(row.current_bps, 0);
        }
        assert_eq!(report.total_value, dec!(0));
    }

    #[tokio::test]
    async fn value_delta_correct() {
        // EQUITY: current=$7000, target=60%*$10000=$6000 → delta=+$1000
        let svc = make_service(
            base_target(500),
            vec![weight("EQUITY", 6000), weight("BONDS", 4000)],
            alloc_with(
                vec![cat("EQUITY", dec!(7000)), cat("BONDS", dec!(3000))],
                dec!(10000),
            ),
        );
        let report = svc
            .get_drift_report_for_target("p1", &[], "USD", "agg")
            .await
            .unwrap();

        let equity = report
            .rows
            .iter()
            .find(|r| r.category_id == "EQUITY")
            .unwrap();
        assert_eq!(equity.current_value, dec!(7000));
        assert_eq!(equity.target_value, dec!(6000));
        assert_eq!(equity.value_delta, dec!(1000));
    }

    #[tokio::test]
    async fn non_asset_taxonomy_uses_its_own_allocation_value() {
        // Sectors exclude cash in AllocationService, so drift percentages must use
        // the sector allocation value instead of the all-assets portfolio value.
        let svc = make_service(
            target_with_taxonomy("industries_gics", 500),
            vec![weight("45", 7000), weight("40", 3000)],
            PortfolioAllocations {
                sectors: taxonomy_alloc(
                    "industries_gics",
                    vec![cat("45", dec!(7000)), cat("40", dec!(3000))],
                ),
                total_value: dec!(12000),
                ..Default::default()
            },
        );

        let report = svc
            .get_drift_report_for_target("p1", &[], "USD", "agg")
            .await
            .unwrap();

        let technology = report.rows.iter().find(|r| r.category_id == "45").unwrap();
        assert_eq!(report.total_value, dec!(10000));
        assert_eq!(technology.current_bps, 7000);
        assert_eq!(technology.target_bps, 7000);
        assert_eq!(technology.status, DriftStatus::InBand);
    }

    #[tokio::test]
    async fn non_asset_taxonomy_deployable_cash_uses_tracked_cash() {
        let svc = make_service_with_holdings(
            target_with_taxonomy("industries_gics", 500),
            vec![weight("45", 7000), weight("40", 3000)],
            PortfolioAllocations {
                sectors: taxonomy_alloc(
                    "industries_gics",
                    vec![cat("45", dec!(7000)), cat("40", dec!(3000))],
                ),
                total_value: dec!(12000),
                ..Default::default()
            },
            vec![make_cash_holding(dec!(2000), "USD")],
        );

        let report = svc
            .get_drift_report_for_target("p1", &[], "USD", "agg")
            .await
            .unwrap();

        assert_eq!(report.deployable_cash, dec!(2000));
    }

    #[tokio::test]
    async fn tagged_cash_in_non_cash_category_is_not_cash_sleeve() {
        let svc = make_service_with_contributions(
            base_target(500),
            vec![weight("FIXED_INCOME", 10000), weight("CASH", 0)],
            alloc_with(vec![], dec!(1000)),
            TaxonomyHoldingContributions {
                taxonomy_id: "asset_classes".to_string(),
                taxonomy_name: "Asset Classes".to_string(),
                total_value: dec!(1000),
                currency: "USD".to_string(),
                contributions: vec![cash_contribution("FIXED_INCOME", dec!(1000))],
            },
        );

        let report = svc
            .get_drift_report_for_target("p1", &[], "USD", "agg")
            .await
            .unwrap();

        let fixed_income = report
            .rows
            .iter()
            .find(|row| row.category_id == "FIXED_INCOME")
            .unwrap();
        assert!(!fixed_income.is_cash);

        let cash = report
            .rows
            .iter()
            .find(|row| row.category_id == "CASH")
            .unwrap();
        assert!(cash.is_cash);
        assert_eq!(cash.current_value, Decimal::ZERO);
    }

    #[tokio::test]
    async fn missing_custom_taxonomy_does_not_fallback_to_asset_classes() {
        let svc = make_service(
            target_with_taxonomy("my_custom_taxonomy", 500),
            vec![weight("CUSTOM_CATEGORY", 10000)],
            alloc_with(vec![cat("EQUITY", dec!(10000))], dec!(10000)),
        );

        let report = svc
            .get_drift_report_for_target("p1", &[], "USD", "agg")
            .await
            .unwrap();

        assert_eq!(report.total_value, dec!(0));
        assert_eq!(report.rows.len(), 1);
        assert!(report.rows.iter().all(|row| row.category_id != "EQUITY"));
        let custom = report
            .rows
            .iter()
            .find(|r| r.category_id == "CUSTOM_CATEGORY")
            .unwrap();
        assert_eq!(custom.current_bps, 0);
        assert_eq!(custom.target_bps, 10000);
        assert_eq!(custom.status, DriftStatus::Underweight);
    }

    #[tokio::test]
    async fn custom_group_unknown_current_is_counted_as_not_targeted_gap() {
        let svc = make_service_with_contributions(
            target_with_taxonomy("custom_groups", 500),
            vec![weight("small_cap", 10000)],
            alloc_with(vec![], dec!(10000)),
            TaxonomyHoldingContributions {
                taxonomy_id: "custom_groups".to_string(),
                taxonomy_name: "Custom Groups".to_string(),
                total_value: dec!(10000),
                currency: "USD".to_string(),
                contributions: vec![HoldingAllocationContribution {
                    category_id: "__UNKNOWN__".to_string(),
                    category_name: "Unknown".to_string(),
                    ..holding_contribution("__UNKNOWN__", dec!(10000))
                }],
            },
        );

        let report = svc
            .get_drift_report_for_target("p1", &[], "USD", "agg")
            .await
            .unwrap();

        assert_eq!(report.total_value, dec!(10000));
        assert_eq!(report.out_of_band_count, 2);
        let unknown = report
            .rows
            .iter()
            .find(|row| row.category_id == "__UNKNOWN__")
            .unwrap();
        let target = report
            .rows
            .iter()
            .find(|row| row.category_id == "small_cap")
            .unwrap();
        assert_eq!(unknown.status, DriftStatus::NotTargeted);
        assert_eq!(unknown.current_bps, 10000);
        assert_eq!(target.status, DriftStatus::Underweight);
        assert_eq!(target.current_bps, 0);
    }

    // ── Hybrid band tests ──────────────────────────────────────────────────

    fn hybrid_target(drift_band_bps: i32, relative_factor_bps: i32) -> AllocationTarget {
        AllocationTarget {
            band_type: BandType::Hybrid,
            relative_factor_bps,
            ..base_target(drift_band_bps)
        }
    }

    #[tokio::test]
    async fn hybrid_band_large_sleeve_in_band_where_absolute_would_flag() {
        // EQUITY: target=50% (5000 bps), current=56% (5600 bps), drift=+600.
        // Absolute band 500 → 600 > 500 → Overweight.
        // Hybrid 20%: effective = max(5000*2000/10000, 500) = max(1000, 500) = 1000 → 600 ≤ 1000 → InBand.
        let svc = make_service(
            hybrid_target(500, 2000),
            vec![weight("EQUITY", 5000), weight("BONDS", 5000)],
            alloc_with(
                vec![cat("EQUITY", dec!(5600)), cat("BONDS", dec!(4400))],
                dec!(10000),
            ),
        );
        let report = svc
            .get_drift_report_for_target("p1", &[], "USD", "agg")
            .await
            .unwrap();

        let equity = report
            .rows
            .iter()
            .find(|r| r.category_id == "EQUITY")
            .unwrap();
        assert_eq!(equity.drift_bps, 600);
        assert_eq!(equity.status, DriftStatus::InBand);
        assert_eq!(equity.effective_band_bps, 1000);
    }

    #[tokio::test]
    async fn hybrid_band_small_sleeve_uses_floor() {
        // SMALL: target=5% (500 bps), current=8% (800 bps), drift=+300.
        // Hybrid 20%: effective = max(500*2000/10000, 100) = max(100, 100) = 100 → 300 > 100 → Overweight.
        // With absolute 500: 300 ≤ 500 → InBand.
        let svc = make_service(
            hybrid_target(100, 2000),
            vec![weight("SMALL", 500), weight("OTHER", 9500)],
            alloc_with(
                vec![cat("SMALL", dec!(800)), cat("OTHER", dec!(9200))],
                dec!(10000),
            ),
        );
        let report = svc
            .get_drift_report_for_target("p1", &[], "USD", "agg")
            .await
            .unwrap();

        let small = report
            .rows
            .iter()
            .find(|r| r.category_id == "SMALL")
            .unwrap();
        assert_eq!(small.drift_bps, 300);
        assert_eq!(small.status, DriftStatus::Overweight);
        assert_eq!(small.effective_band_bps, 100);
    }

    #[tokio::test]
    async fn hybrid_effective_band_bps_varies_per_sleeve() {
        // Two sleeves with different targets should get different effective bands.
        let svc = make_service(
            hybrid_target(100, 2000),
            vec![weight("BIG", 6000), weight("SMALL", 4000)],
            alloc_with(
                vec![cat("BIG", dec!(6000)), cat("SMALL", dec!(4000))],
                dec!(10000),
            ),
        );
        let report = svc
            .get_drift_report_for_target("p1", &[], "USD", "agg")
            .await
            .unwrap();

        let big = report.rows.iter().find(|r| r.category_id == "BIG").unwrap();
        let small = report
            .rows
            .iter()
            .find(|r| r.category_id == "SMALL")
            .unwrap();
        // BIG: 6000 * 2000 / 10000 = 1200; max(1200, 100) = 1200
        assert_eq!(big.effective_band_bps, 1200);
        // SMALL: 4000 * 2000 / 10000 = 800; max(800, 100) = 800
        assert_eq!(small.effective_band_bps, 800);
    }
}
