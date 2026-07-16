use crate::activities::{
    Activity, ActivityRepositoryTrait, TransferPairResolution, ACTIVITY_TYPE_TRANSFER_IN,
    ACTIVITY_TYPE_TRANSFER_OUT, ACTIVITY_TYPE_WITHDRAWAL,
};
use crate::errors::{CalculatorError, Error as CoreError, Result as CoreResult};
use crate::fx::currency::normalize_currency_code;
use crate::fx::FxServiceTrait;
use crate::lots::{LotDisposal, LotRepositoryTrait};
use crate::portfolio::economic_events::{
    ActivityEconomicsResolver, BasisStatus, ResolvedActivityEconomics, TransferBoundary,
};
use crate::portfolio::performance::{
    classify_flow_for_scope, classify_transfer_boundary_for_account_scope, is_external_transfer,
    FlowType, PerformanceScope,
};
use crate::portfolio::snapshot::{AccountStateSnapshot, Position, SnapshotServiceTrait};
use crate::portfolio::valuation::valuation_calculator::calculate_valuation_with_price_factors;
use crate::portfolio::valuation::valuation_model::{
    DailyAccountValuation, ExternalFlowSource, NegativeBalanceInfo, ValuationStatus,
};
use crate::portfolio::valuation::ValuationRepositoryTrait;
use crate::quotes::{Quote, QuoteServiceTrait};
use crate::utils::time_utils;
use async_trait::async_trait;
use chrono::{DateTime, Duration, NaiveDate, Utc};
use log::{debug, error, warn};
use rust_decimal::Decimal;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Instant;

use super::DailyFxRateMap;

static VALUATION_SERVICE_INSTANCE_COUNTER: AtomicU64 = AtomicU64::new(1);
const SCOPED_HISTORY_CACHE_LIMIT_PER_MODE: usize = 128;

fn parse_decimal_lossy(value: &str) -> Decimal {
    Decimal::from_str(value).unwrap_or(Decimal::ZERO)
}

/// Controls the scope of a valuation history recalculation.
#[derive(Clone, Debug)]
pub enum ValuationRecalcMode {
    /// Delete all valuations and recalculate from the first snapshot.
    Full,
    /// Resume from the latest saved valuation date, only computing new dates forward.
    IncrementalFromLast,
    /// Delete valuations from `date` forward, recalculating with the previous day as an anchor.
    SinceDate(NaiveDate),
}

#[async_trait]
pub trait ValuationServiceTrait: Send + Sync {
    /// Ensures the valuation history for the account is calculated and stored.
    ///
    /// The `mode` controls how much history is recomputed:
    /// - `Full`: delete all valuations and recalculate from the first snapshot.
    /// - `IncrementalFromLast`: resume from the latest saved valuation date.
    /// - `SinceDate(date)`: delete valuations from `date` forward, recalculating with the previous day as an anchor.
    ///
    /// Args:
    ///     account_id: The ID of a real account.
    ///     mode: Controls the recalculation scope.
    async fn calculate_valuation_history(
        &self,
        account_id: &str,
        mode: ValuationRecalcMode,
    ) -> CoreResult<()>;

    /// Loads the valuation data for the account within the specified date range.
    ///
    /// Args:
    ///     account_id: The ID of a real account.
    ///     start_date_opt: Optional start date (inclusive).
    ///     end_date_opt: Optional end date (inclusive).
    ///
    /// Returns:
    ///     A `Result` containing a vector of `DailyAccountValuation` or an error.
    fn get_historical_valuations(
        &self,
        account_id: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> CoreResult<Vec<DailyAccountValuation>>;

    /// Loads and aggregates valuation history for a concrete account scope.
    fn get_historical_valuations_for_accounts(
        &self,
        scope_id: &str,
        account_ids: &[String],
        base_currency: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> CoreResult<Vec<DailyAccountValuation>>;

    /// Loads and aggregates scoped valuation totals without activity-flow enrichment.
    ///
    /// Use this for chart/read paths that only need stored valuation totals and
    /// net contribution history. Performance calculations should use
    /// `get_historical_valuations_for_accounts`.
    fn get_historical_valuation_totals_for_accounts(
        &self,
        scope_id: &str,
        account_ids: &[String],
        base_currency: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> CoreResult<Vec<DailyAccountValuation>> {
        self.get_historical_valuations_for_accounts(
            scope_id,
            account_ids,
            base_currency,
            start_date_opt,
            end_date_opt,
        )
    }

    /// Loads real-account valuation histories in an account-keyed shape.
    fn get_historical_valuations_by_account(
        &self,
        account_ids: &[String],
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> CoreResult<HashMap<String, Vec<DailyAccountValuation>>> {
        let mut histories = HashMap::with_capacity(account_ids.len());
        for account_id in account_ids {
            histories.insert(
                account_id.clone(),
                self.get_historical_valuations(account_id, start_date_opt, end_date_opt)?,
            );
        }
        Ok(histories)
    }

    /// Loads the latest valuation history record for a list of accounts.
    ///
    /// Args:
    ///     account_ids: A slice of account IDs.
    ///
    /// Returns:
    ///     A `Result` containing a `HashMap` mapping account IDs to their
    ///     latest `DailyAccountValuation` (if found), or `None` if no history exists.
    ///     latest `DailyAccountValuation` for each account that has one.
    fn get_latest_valuations(
        &self,
        account_ids: &[String],
    ) -> CoreResult<Vec<DailyAccountValuation>>;

    fn get_valuations_on_date(
        &self,
        account_ids: &[String],
        date: NaiveDate,
    ) -> CoreResult<Vec<DailyAccountValuation>>;

    /// Returns info about accounts that have at least one negative total_value in their history.
    fn get_accounts_with_negative_balance(
        &self,
        account_ids: &[String],
    ) -> CoreResult<Vec<NegativeBalanceInfo>>;
}

fn since_date_calculation_window(date: NaiveDate) -> (NaiveDate, Option<NaiveDate>) {
    let start_date = date.checked_sub_signed(Duration::days(1)).unwrap_or(date);
    let anchor_date = if start_date < date {
        Some(start_date)
    } else {
        None
    };

    (start_date, anchor_date)
}

#[derive(Clone)]
pub struct ValuationService {
    base_currency: Arc<RwLock<String>>,
    valuation_repository: Arc<dyn ValuationRepositoryTrait>,
    snapshot_service: Arc<dyn SnapshotServiceTrait>,
    quote_service: Arc<dyn QuoteServiceTrait>,
    fx_service: Arc<dyn FxServiceTrait>,
    activity_repository: Option<Arc<dyn ActivityRepositoryTrait>>,
    lot_repository: Option<Arc<dyn LotRepositoryTrait>>,
    timezone: Arc<RwLock<String>>,
    scoped_history_cache: Arc<RwLock<HashMap<ScopedValuationCacheKey, Vec<DailyAccountValuation>>>>,
    service_instance_id: u64,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ScopedValuationCacheKey {
    service_instance_id: u64,
    mode: ScopedValuationHistoryMode,
    scope_id: String,
    membership_hash: String,
    base_currency: String,
    start_date: Option<NaiveDate>,
    end_date: Option<NaiveDate>,
    max_calculated_at: String,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum ScopedValuationHistoryMode {
    TotalsOnly,
    PerformanceFlows,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct DailyFlowAmounts {
    inflow: Decimal,
    outflow: Decimal,
    source: ExternalFlowSource,
}

impl DailyFlowAmounts {
    fn zero_with_source(source: ExternalFlowSource) -> Self {
        Self {
            inflow: Decimal::ZERO,
            outflow: Decimal::ZERO,
            source,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
struct QuoteAdjustedSplitEvent {
    asset_id: String,
    split_date: NaiveDate,
    ratio: Decimal,
}

#[derive(Clone, Debug, Default)]
struct TransferMultiplierContext {
    by_account_asset_date: HashMap<(String, String, NaiveDate), Decimal>,
    by_account_asset: HashMap<(String, String), Decimal>,
}

impl TransferMultiplierContext {
    fn add_snapshot(&mut self, snapshot: &AccountStateSnapshot) {
        for (asset_id, position) in &snapshot.positions {
            if position.contract_multiplier <= Decimal::ZERO {
                continue;
            }
            self.by_account_asset_date.insert(
                (
                    snapshot.account_id.clone(),
                    asset_id.clone(),
                    snapshot.snapshot_date,
                ),
                position.contract_multiplier,
            );
            self.by_account_asset.insert(
                (snapshot.account_id.clone(), asset_id.clone()),
                position.contract_multiplier,
            );
        }
    }

    fn multiplier_for(&self, activity: &Activity, activity_date: NaiveDate) -> Decimal {
        let Some(asset_id) = activity.asset_id.as_ref() else {
            return Decimal::ONE;
        };
        self.by_account_asset_date
            .get(&(activity.account_id.clone(), asset_id.clone(), activity_date))
            .or_else(|| {
                self.by_account_asset
                    .get(&(activity.account_id.clone(), asset_id.clone()))
            })
            .copied()
            .filter(|multiplier| *multiplier > Decimal::ZERO)
            .unwrap_or(Decimal::ONE)
    }
}

impl ValuationService {
    pub fn new(
        base_currency: Arc<RwLock<String>>,
        valuation_repository: Arc<dyn ValuationRepositoryTrait>,
        snapshot_service: Arc<dyn SnapshotServiceTrait>,
        quote_service: Arc<dyn QuoteServiceTrait>,
        fx_service: Arc<dyn FxServiceTrait>,
    ) -> Self {
        Self {
            base_currency,
            snapshot_service,
            quote_service,
            fx_service,
            valuation_repository,
            activity_repository: None,
            lot_repository: None,
            timezone: Arc::new(RwLock::new(String::new())),
            scoped_history_cache: Arc::new(RwLock::new(HashMap::new())),
            service_instance_id: VALUATION_SERVICE_INSTANCE_COUNTER.fetch_add(1, Ordering::Relaxed),
        }
    }

    pub fn with_activity_repository(
        mut self,
        activity_repository: Arc<dyn ActivityRepositoryTrait>,
        timezone: Arc<RwLock<String>>,
    ) -> Self {
        self.activity_repository = Some(activity_repository);
        self.timezone = timezone;
        self
    }

    pub fn with_lot_repository(mut self, lot_repository: Arc<dyn LotRepositoryTrait>) -> Self {
        self.lot_repository = Some(lot_repository);
        self
    }

    fn membership_hash(account_ids: &[String]) -> String {
        let mut ids = account_ids.to_vec();
        ids.sort();
        ids.dedup();
        let digest = Sha256::digest(ids.join("\n").as_bytes());
        hex::encode(&digest[..8])
    }

    fn insert_scoped_history_cache(
        &self,
        cache_key: ScopedValuationCacheKey,
        aggregate: &[DailyAccountValuation],
    ) {
        let mode = cache_key.mode;
        let mut cache = self.scoped_history_cache.write().unwrap();
        let mode_entry_count = cache.keys().filter(|key| key.mode == mode).count();
        if mode_entry_count >= SCOPED_HISTORY_CACHE_LIMIT_PER_MODE {
            cache.retain(|key, _| key.mode != mode);
        }
        cache.insert(cache_key, aggregate.to_vec());
    }

    fn position_requires_price_quote(position: &Position) -> bool {
        !position.is_alternative
    }

    fn position_counts_for_quote_gating(position: &Position) -> bool {
        Self::position_requires_price_quote(position) && !position.quantity.is_zero()
    }

    async fn fetch_fx_rates_for_range(
        &self,
        pairs: &HashSet<(String, String)>,
        start_date: NaiveDate,
        end_date: NaiveDate,
    ) -> CoreResult<HashMap<NaiveDate, DailyFxRateMap>> {
        if pairs.is_empty() {
            return Ok(HashMap::new());
        }

        let mut fx_rates_by_date: HashMap<NaiveDate, DailyFxRateMap> = HashMap::new();
        let date_range = time_utils::get_days_between(start_date, end_date);

        for current_date in date_range {
            let mut daily_map: DailyFxRateMap = HashMap::with_capacity(pairs.len());
            for (from_curr, to_curr) in pairs {
                match self
                    .fx_service
                    .get_exchange_rate_for_date(from_curr, to_curr, current_date)
                {
                    Ok(rate) => {
                        daily_map.insert((from_curr.clone(), to_curr.clone()), rate);
                    }
                    Err(e) => {
                        warn!(
                            "Failed to get FX rate {}->{} for date {}: {}. Valuation for this date might be affected.",
                            from_curr, to_curr, current_date, e
                        );
                    }
                }
            }
            if !daily_map.is_empty() {
                fx_rates_by_date.insert(current_date, daily_map);
            }
        }

        Ok(fx_rates_by_date)
    }

    async fn fetch_fx_rates_for_dates(
        &self,
        pairs: &HashSet<(String, String)>,
        dates: &HashSet<NaiveDate>,
    ) -> CoreResult<HashMap<NaiveDate, DailyFxRateMap>> {
        if pairs.is_empty() || dates.is_empty() {
            return Ok(HashMap::new());
        }

        let mut fx_rates_by_date: HashMap<NaiveDate, DailyFxRateMap> =
            HashMap::with_capacity(dates.len());

        for current_date in dates {
            let mut daily_map: DailyFxRateMap = HashMap::with_capacity(pairs.len());
            for (from_curr, to_curr) in pairs {
                match self
                    .fx_service
                    .get_exchange_rate_for_date(from_curr, to_curr, *current_date)
                {
                    Ok(rate) => {
                        daily_map.insert((from_curr.clone(), to_curr.clone()), rate);
                    }
                    Err(e) => {
                        warn!(
                            "Failed to get acquisition FX rate {}->{} for date {}: {}.",
                            from_curr, to_curr, current_date, e
                        );
                    }
                }
            }
            if !daily_map.is_empty() {
                fx_rates_by_date.insert(*current_date, daily_map);
            }
        }

        Ok(fx_rates_by_date)
    }

    fn aggregate_scoped_valuations(
        scope_id: &str,
        account_ids: &[String],
        base_currency: &str,
        histories: Vec<Vec<DailyAccountValuation>>,
        external_flows_by_date: Option<&HashMap<NaiveDate, DailyFlowAmounts>>,
        internal_transfer_flow_adjustments_by_date: Option<&HashMap<NaiveDate, (Decimal, Decimal)>>,
    ) -> CoreResult<Vec<DailyAccountValuation>> {
        if account_ids.is_empty() {
            return Ok(Vec::new());
        }
        Self::validate_scoped_history_completeness(account_ids, &histories)?;

        let mut by_date: std::collections::BTreeMap<NaiveDate, DailyAccountValuation> =
            std::collections::BTreeMap::new();

        for valuation in histories.into_iter().flatten() {
            let entry =
                by_date
                    .entry(valuation.valuation_date)
                    .or_insert_with(|| DailyAccountValuation {
                        id: format!("{}_{}", scope_id, valuation.valuation_date),
                        account_id: scope_id.to_string(),
                        valuation_date: valuation.valuation_date,
                        account_currency: base_currency.to_string(),
                        base_currency: base_currency.to_string(),
                        fx_rate_to_base: rust_decimal::Decimal::ONE,
                        cash_balance: rust_decimal::Decimal::ZERO,
                        investment_market_value: rust_decimal::Decimal::ZERO,
                        total_value: rust_decimal::Decimal::ZERO,
                        cost_basis: rust_decimal::Decimal::ZERO,
                        book_basis: rust_decimal::Decimal::ZERO,
                        net_contribution: rust_decimal::Decimal::ZERO,
                        cash_balance_base: rust_decimal::Decimal::ZERO,
                        investment_market_value_base: rust_decimal::Decimal::ZERO,
                        total_value_base: rust_decimal::Decimal::ZERO,
                        cost_basis_base: rust_decimal::Decimal::ZERO,
                        book_basis_base: rust_decimal::Decimal::ZERO,
                        net_contribution_base: rust_decimal::Decimal::ZERO,
                        external_inflow_base: rust_decimal::Decimal::ZERO,
                        external_outflow_base: rust_decimal::Decimal::ZERO,
                        // A missing account-date contributes no flow: use the neutral
                        // identity so it does not poison the aggregated provenance.
                        external_flow_source: ExternalFlowSource::NoFlow,
                        performance_eligible_value_base: rust_decimal::Decimal::ZERO,
                        value_status: ValuationStatus::Complete,
                        basis_status: BasisStatus::NotApplicable,
                        calculated_at: valuation.calculated_at,
                    });

            entry.cash_balance += valuation.cash_balance_base;
            entry.investment_market_value += valuation.investment_market_value_base;
            entry.total_value += valuation.total_value_base;
            entry.cost_basis += valuation.cost_basis_base;
            entry.book_basis += valuation.book_basis_base;
            entry.net_contribution += valuation.net_contribution_base;
            entry.cash_balance_base += valuation.cash_balance_base;
            entry.investment_market_value_base += valuation.investment_market_value_base;
            entry.total_value_base += valuation.total_value_base;
            entry.cost_basis_base += valuation.cost_basis_base;
            entry.book_basis_base += valuation.book_basis_base;
            entry.net_contribution_base += valuation.net_contribution_base;
            entry.external_inflow_base += valuation.external_inflow_base;
            entry.external_outflow_base += valuation.external_outflow_base;
            entry.external_flow_source = Self::combine_external_flow_sources(
                entry.external_flow_source,
                valuation.external_flow_source,
            );
            entry.performance_eligible_value_base += valuation.performance_eligible_value_base;
            entry.value_status = entry.value_status.combine(valuation.value_status);
            entry.basis_status = entry.basis_status.combine(valuation.basis_status);
            entry.calculated_at = entry.calculated_at.max(valuation.calculated_at);
        }

        let mut values: Vec<_> = by_date.into_values().collect();
        let authoritative_flow_dates = external_flows_by_date
            .map(|flows_by_date| flows_by_date.keys().copied().collect::<HashSet<_>>());
        match external_flows_by_date {
            Some(flows_by_date) => {
                Self::set_external_flows_from_activity_map_or_net_contribution_base(
                    &mut values,
                    flows_by_date,
                );
            }
            None => Self::set_external_flows_from_net_contribution_base(&mut values),
        }
        if let Some(adjustments_by_date) = internal_transfer_flow_adjustments_by_date {
            Self::apply_internal_transfer_flow_adjustments(
                &mut values,
                adjustments_by_date,
                authoritative_flow_dates.as_ref(),
            );
        }
        Ok(values)
    }

    fn aggregate_scoped_valuation_totals(
        scope_id: &str,
        account_ids: &[String],
        base_currency: &str,
        histories: Vec<Vec<DailyAccountValuation>>,
    ) -> CoreResult<Vec<DailyAccountValuation>> {
        Self::aggregate_scoped_valuations(
            scope_id,
            account_ids,
            base_currency,
            histories,
            None,
            None,
        )
    }

    fn validate_scoped_history_completeness(
        account_ids: &[String],
        histories: &[Vec<DailyAccountValuation>],
    ) -> CoreResult<()> {
        if histories.len() != account_ids.len() {
            return Err(CoreError::Calculation(CalculatorError::Calculation(
                format!(
                    "Scoped valuation history count mismatch: expected {} account histories, got {}",
                    account_ids.len(),
                    histories.len()
                ),
            )));
        }

        let union_dates: BTreeSet<NaiveDate> = histories
            .iter()
            .flat_map(|history| history.iter().map(|valuation| valuation.valuation_date))
            .collect();
        let scope_last_date = union_dates.iter().next_back().copied();

        for (account_id, history) in account_ids.iter().zip(histories.iter()) {
            if history.is_empty() {
                continue;
            }

            let account_dates: HashSet<NaiveDate> = history
                .iter()
                .map(|valuation| valuation.valuation_date)
                .collect();
            let first_date = history
                .iter()
                .map(|valuation| valuation.valuation_date)
                .min()
                .expect("non-empty history has first date");
            let last_date = history
                .iter()
                .map(|valuation| valuation.valuation_date)
                .max()
                .expect("non-empty history has last date");

            let missing_dates: Vec<NaiveDate> = union_dates
                .iter()
                .copied()
                .filter(|date| {
                    *date >= first_date && *date <= last_date && !account_dates.contains(date)
                })
                .take(5)
                .collect();

            if !missing_dates.is_empty() {
                let preview = missing_dates
                    .iter()
                    .map(|date| date.to_string())
                    .collect::<Vec<_>>()
                    .join(", ");
                return Err(CoreError::Calculation(CalculatorError::Calculation(
                    format!(
                        "Incomplete scoped valuation history for account '{}': missing valuation date(s) inside its active range: {}",
                        account_id, preview
                    ),
                )));
            }

            if let Some(scope_last_date) = scope_last_date {
                if last_date < scope_last_date {
                    let latest = history
                        .iter()
                        .max_by_key(|valuation| valuation.valuation_date)
                        .expect("non-empty history has latest valuation");
                    if !latest.total_value_base.is_zero() {
                        return Err(CoreError::Calculation(CalculatorError::Calculation(
                            format!(
                                "Incomplete scoped valuation history for account '{}': latest valuation is {}, but scope continues through {}",
                                account_id, last_date, scope_last_date
                            ),
                        )));
                    }
                }
            }
        }

        Ok(())
    }

    fn split_external_flow(delta: Decimal) -> (Decimal, Decimal) {
        if delta.is_sign_negative() {
            (Decimal::ZERO, -delta)
        } else {
            (delta, Decimal::ZERO)
        }
    }

    fn combine_external_flow_sources(
        current: ExternalFlowSource,
        next: ExternalFlowSource,
    ) -> ExternalFlowSource {
        Self::combine_activity_flow_sources(current, next)
    }

    fn combine_activity_flow_sources(
        current: ExternalFlowSource,
        next: ExternalFlowSource,
    ) -> ExternalFlowSource {
        current.combine(next)
    }

    fn should_preserve_stored_external_flow(
        valuation: &DailyAccountValuation,
        net_contribution_delta: Decimal,
    ) -> bool {
        !valuation.external_inflow_base.is_zero()
            || !valuation.external_outflow_base.is_zero()
            || (valuation.external_flow_source.is_explicit_gross()
                && net_contribution_delta.is_zero())
    }

    fn set_external_flows_from_net_contribution_base(values: &mut [DailyAccountValuation]) {
        if values.is_empty() {
            return;
        }

        values.sort_by_key(|valuation| valuation.valuation_date);
        values[0].external_inflow_base = rust_decimal::Decimal::ZERO;
        values[0].external_outflow_base = rust_decimal::Decimal::ZERO;
        values[0].external_flow_source = ExternalFlowSource::NetContributionFallback;

        for index in 1..values.len() {
            let delta =
                values[index].net_contribution_base - values[index - 1].net_contribution_base;
            if Self::should_preserve_stored_external_flow(&values[index], delta) {
                if values[index].external_flow_source == ExternalFlowSource::NoFlow {
                    values[index].external_flow_source = ExternalFlowSource::StoredGross;
                }
                continue;
            }

            let (inflow, outflow) = Self::split_external_flow(delta);
            values[index].external_inflow_base = inflow;
            values[index].external_outflow_base = outflow;
            values[index].external_flow_source = ExternalFlowSource::NetContributionFallback;
        }
    }

    fn set_external_flows_from_activity_map_or_net_contribution_base(
        values: &mut [DailyAccountValuation],
        flows_by_date: &HashMap<NaiveDate, DailyFlowAmounts>,
    ) {
        if values.is_empty() {
            return;
        }

        values.sort_by_key(|valuation| valuation.valuation_date);
        values[0].external_inflow_base = Decimal::ZERO;
        values[0].external_outflow_base = Decimal::ZERO;
        values[0].external_flow_source = ExternalFlowSource::NoFlow;

        for index in 1..values.len() {
            let delta =
                values[index].net_contribution_base - values[index - 1].net_contribution_base;
            if let Some(flow) = flows_by_date.get(&values[index].valuation_date) {
                values[index].external_inflow_base = flow.inflow;
                values[index].external_outflow_base = flow.outflow;
                values[index].external_flow_source = flow.source;
                continue;
            }

            if Self::should_preserve_stored_external_flow(&values[index], delta) {
                if values[index].external_flow_source == ExternalFlowSource::NoFlow {
                    values[index].external_flow_source = ExternalFlowSource::StoredGross;
                }
                continue;
            }

            if delta.is_zero() {
                values[index].external_inflow_base = Decimal::ZERO;
                values[index].external_outflow_base = Decimal::ZERO;
                values[index].external_flow_source = ExternalFlowSource::NoFlow;
                continue;
            }

            let (inflow, outflow) = Self::split_external_flow(delta);
            values[index].external_inflow_base = inflow;
            values[index].external_outflow_base = outflow;
            values[index].external_flow_source = ExternalFlowSource::NetContributionFallback;
        }
    }

    fn apply_internal_transfer_flow_adjustments(
        values: &mut [DailyAccountValuation],
        adjustments_by_date: &HashMap<NaiveDate, (Decimal, Decimal)>,
        authoritative_flow_dates: Option<&HashSet<NaiveDate>>,
    ) {
        for value in values {
            if authoritative_flow_dates
                .map(|flow_dates| flow_dates.contains(&value.valuation_date))
                .unwrap_or(false)
            {
                continue;
            }

            let Some((inflow_to_remove, outflow_to_remove)) =
                adjustments_by_date.get(&value.valuation_date)
            else {
                continue;
            };

            value.external_inflow_base =
                Self::subtract_flow_floor_zero(value.external_inflow_base, *inflow_to_remove);
            value.external_outflow_base =
                Self::subtract_flow_floor_zero(value.external_outflow_base, *outflow_to_remove);
            value.external_flow_source = Self::combine_external_flow_sources(
                value.external_flow_source,
                ExternalFlowSource::CashAmount,
            );
        }
    }

    fn subtract_flow_floor_zero(current: Decimal, amount_to_remove: Decimal) -> Decimal {
        let adjusted = current - amount_to_remove;
        if adjusted.is_sign_negative() {
            Decimal::ZERO
        } else {
            adjusted
        }
    }

    fn is_security_transfer_activity(activity: &Activity) -> bool {
        ActivityEconomicsResolver::is_security_transfer(activity)
    }

    #[cfg(test)]
    fn resolve_activity_economics_for_boundary(
        activity: &Activity,
        quote: Option<&Quote>,
        transfer_boundary: TransferBoundary,
    ) -> ResolvedActivityEconomics {
        ActivityEconomicsResolver::compile_activity(activity, quote, transfer_boundary)
    }

    fn resolve_activity_economics_for_boundary_with_unit_multiplier(
        activity: &Activity,
        quote: Option<&Quote>,
        transfer_boundary: TransferBoundary,
        unit_multiplier: Decimal,
    ) -> ResolvedActivityEconomics {
        ActivityEconomicsResolver::compile_activity_with_unit_multiplier(
            activity,
            quote,
            transfer_boundary,
            unit_multiplier,
        )
    }

    fn activity_is_outflow(activity: &Activity) -> bool {
        let effective_type = activity.effective_type();
        effective_type == ACTIVITY_TYPE_WITHDRAWAL || effective_type == ACTIVITY_TYPE_TRANSFER_OUT
    }

    fn transfer_multiplier_context_for_accounts(
        &self,
        account_ids: &[String],
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> CoreResult<TransferMultiplierContext> {
        let snapshot_start_date_opt = Self::transfer_multiplier_snapshot_start(start_date_opt);
        let mut context = TransferMultiplierContext::default();
        for account_id in account_ids {
            let snapshots = self
                .snapshot_service
                .get_daily_holdings_snapshots(account_id, snapshot_start_date_opt, end_date_opt)
                .map_err(|e| {
                    CoreError::Calculation(CalculatorError::Calculation(format!(
                        "Failed snapshot fetch for transfer economics account {}: {}",
                        account_id, e
                    )))
                })?;
            for snapshot in snapshots {
                context.add_snapshot(&snapshot);
            }
        }
        Ok(context)
    }

    fn transfer_multiplier_snapshot_start(start_date_opt: Option<NaiveDate>) -> Option<NaiveDate> {
        start_date_opt.map(|start_date| start_date - Duration::days(1))
    }

    fn has_posted_security_transfer_in_range(
        activities: &[Activity],
        timezone: chrono_tz::Tz,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> bool {
        activities.iter().any(|activity| {
            if !activity.is_posted() || !Self::is_security_transfer_activity(activity) {
                return false;
            }
            let activity_date = time_utils::activity_date_in_tz(activity.activity_date, timezone);
            Self::activity_date_in_range(activity_date, start_date_opt, end_date_opt)
        })
    }

    fn activity_flow_amount_base(
        &self,
        activity: &Activity,
        quote: Option<&Quote>,
        base_currency: &str,
        activity_date: NaiveDate,
        transfer_boundary: TransferBoundary,
        unit_multiplier: Decimal,
    ) -> CoreResult<Decimal> {
        let economics = Self::resolve_activity_economics_for_boundary_with_unit_multiplier(
            activity,
            quote,
            transfer_boundary,
            unit_multiplier,
        );
        let amount = economics.performance_flow_value.abs();
        if amount.is_zero() {
            return Ok(Decimal::ZERO);
        }

        let activity_currency = normalize_currency_code(&economics.performance_flow_currency);
        let base_currency = normalize_currency_code(base_currency);
        if activity_currency == base_currency {
            return Ok(amount);
        }

        match self.fx_service.convert_currency_for_date(
            amount,
            activity_currency,
            base_currency,
            activity_date,
        ) {
            Ok(converted) => Ok(converted),
            Err(err) => Err(CoreError::Calculation(CalculatorError::Calculation(
                format!(
                    "Failed to convert external flow {} {}->{} on {} for activity {}: {}",
                    amount, activity_currency, base_currency, activity_date, activity.id, err
                ),
            ))),
        }
    }

    fn activity_query_utc_bounds(
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> (Option<DateTime<Utc>>, Option<DateTime<Utc>>) {
        let start_utc = start_date_opt.map(|date| {
            (date - Duration::days(1))
                .and_hms_opt(0, 0, 0)
                .expect("midnight is valid")
                .and_utc()
        });
        let end_exclusive_utc = end_date_opt.map(|date| {
            (date + Duration::days(2))
                .and_hms_opt(0, 0, 0)
                .expect("midnight is valid")
                .and_utc()
        });
        (start_utc, end_exclusive_utc)
    }

    fn activity_date_in_range(
        activity_date: NaiveDate,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> bool {
        !start_date_opt
            .map(|start_date| activity_date < start_date)
            .unwrap_or(false)
            && !end_date_opt
                .map(|end_date| activity_date > end_date)
                .unwrap_or(false)
    }

    fn merge_activities_by_id(primary: Vec<Activity>, secondary: Vec<Activity>) -> Vec<Activity> {
        let mut by_id: HashMap<String, Activity> = primary
            .into_iter()
            .map(|activity| (activity.id.clone(), activity))
            .collect();
        for activity in secondary {
            by_id.entry(activity.id.clone()).or_insert(activity);
        }
        let mut activities: Vec<Activity> = by_id.into_values().collect();
        activities.sort_by_key(|activity| activity.activity_date);
        activities
    }

    fn split_ratio_from_activity(activity: &Activity) -> Option<Decimal> {
        let amount = activity.amt();
        if amount.is_sign_positive() && !amount.is_zero() {
            return Some(amount);
        }

        let quantity = activity.qty();
        if quantity.is_sign_positive() && !quantity.is_zero() {
            return Some(quantity);
        }

        None
    }

    fn quote_close_by_asset_date(
        quotes: &[Quote],
    ) -> HashMap<String, BTreeMap<NaiveDate, Decimal>> {
        let mut by_asset: HashMap<String, BTreeMap<NaiveDate, Decimal>> = HashMap::new();
        for quote in quotes {
            if quote.close.is_zero() || !quote.close.is_sign_positive() {
                continue;
            }
            by_asset
                .entry(quote.asset_id.clone())
                .or_default()
                .insert(quote.timestamp.date_naive(), quote.close);
        }
        by_asset
    }

    fn relative_distance(value: Decimal, target: Decimal) -> Decimal {
        let target_abs = target.abs();
        let denominator = if target_abs > Decimal::ONE {
            target_abs
        } else {
            Decimal::ONE
        };
        (value - target).abs() / denominator
    }

    fn quotes_appear_split_adjusted(
        quote_closes_by_asset_date: &HashMap<String, BTreeMap<NaiveDate, Decimal>>,
        asset_id: &str,
        split_date: NaiveDate,
        ratio: Decimal,
    ) -> bool {
        if !ratio.is_sign_positive() || ratio.is_zero() || ratio == Decimal::ONE {
            return false;
        }

        let Some(asset_quotes) = quote_closes_by_asset_date.get(asset_id) else {
            return false;
        };
        let Some((_, previous_close)) = asset_quotes.range(..split_date).next_back() else {
            return false;
        };
        let Some((_, split_or_next_close)) = asset_quotes.range(split_date..).next() else {
            return false;
        };
        if previous_close.is_zero()
            || split_or_next_close.is_zero()
            || !previous_close.is_sign_positive()
            || !split_or_next_close.is_sign_positive()
        {
            return false;
        }

        let observed_price_ratio = *previous_close / *split_or_next_close;
        let adjusted_distance = Self::relative_distance(observed_price_ratio, Decimal::ONE);
        let raw_distance = Self::relative_distance(observed_price_ratio, ratio);

        adjusted_distance < raw_distance
    }

    fn split_activity_source_rank(activity: &Activity) -> u8 {
        if activity.is_user_modified {
            return 3;
        }

        match activity
            .source_system
            .as_deref()
            .map(str::trim)
            .filter(|source| !source.is_empty())
        {
            None => 3,
            Some(source)
                if source.eq_ignore_ascii_case("MANUAL") || source.eq_ignore_ascii_case("CSV") =>
            {
                3
            }
            Some(source) if source.eq_ignore_ascii_case("GENERATED") => 1,
            Some(_) => 2,
        }
    }

    fn select_shared_split_activities(
        activities: Vec<Activity>,
        timezone: chrono_tz::Tz,
    ) -> Vec<(Activity, NaiveDate, Decimal)> {
        // Rows for the same real-world split can resolve to adjacent local dates when
        // sources stamp different times of day, so cluster per asset by date gap
        // instead of keying on the exact date; two events would apply the factor twice.
        const MERGE_GAP_DAYS: i64 = 1;

        let mut candidates_by_asset: BTreeMap<String, Vec<(Activity, NaiveDate, Decimal)>> =
            BTreeMap::new();

        for activity in activities {
            let Some(asset_id) = activity
                .asset_id
                .as_ref()
                .filter(|asset_id| !asset_id.is_empty())
                .cloned()
            else {
                continue;
            };
            let Some(ratio) = Self::split_ratio_from_activity(&activity) else {
                continue;
            };
            let split_date = time_utils::activity_date_in_tz(activity.activity_date, timezone);
            candidates_by_asset
                .entry(asset_id)
                .or_default()
                .push((activity, split_date, ratio));
        }

        let mut selected_events = Vec::new();
        for (asset_id, mut candidates) in candidates_by_asset {
            candidates.sort_by_key(|(_, split_date, _)| *split_date);

            let mut clusters: Vec<Vec<(Activity, NaiveDate, Decimal)>> = Vec::new();
            for candidate in candidates {
                match clusters.last_mut() {
                    Some(cluster)
                        if cluster.last().is_some_and(|(_, last_date, _)| {
                            (candidate.1 - *last_date).num_days() <= MERGE_GAP_DAYS
                        }) =>
                    {
                        cluster.push(candidate);
                    }
                    _ => clusters.push(vec![candidate]),
                }
            }

            for mut cluster in clusters {
                cluster.sort_by(|(left, _, _), (right, _, _)| {
                    Self::split_activity_source_rank(right)
                        .cmp(&Self::split_activity_source_rank(left))
                        .then_with(|| right.updated_at.cmp(&left.updated_at))
                        .then_with(|| left.id.cmp(&right.id))
                });

                let distinct_ratios: HashSet<Decimal> =
                    cluster.iter().map(|(_, _, ratio)| *ratio).collect();
                let Some((selected, split_date, selected_ratio)) = cluster.into_iter().next()
                else {
                    continue;
                };
                if distinct_ratios.len() > 1 {
                    let mut ratios: Vec<String> = distinct_ratios
                        .into_iter()
                        .map(|ratio| ratio.to_string())
                        .collect();
                    ratios.sort();
                    warn!(
                        "Conflicting split ratios for asset '{}' on {}: {:?}. Using ratio {} from activity '{}'.",
                        asset_id, split_date, ratios, selected_ratio, selected.id
                    );
                }

                selected_events.push((selected, split_date, selected_ratio));
            }
        }

        selected_events
    }

    fn quote_adjusted_split_events_for_assets(
        &self,
        asset_ids: &HashSet<String>,
        start_date: NaiveDate,
        end_date: NaiveDate,
        quote_closes_by_asset_date: &HashMap<String, BTreeMap<NaiveDate, Decimal>>,
    ) -> CoreResult<Vec<QuoteAdjustedSplitEvent>> {
        let Some(activity_repository) = &self.activity_repository else {
            return Ok(Vec::new());
        };

        let timezone = {
            let timezone_guard = self.timezone.read().unwrap();
            time_utils::parse_user_timezone_or_default(&timezone_guard)
        };
        let (start_utc, end_exclusive_utc) =
            Self::activity_query_utc_bounds(Some(start_date), Some(end_date));
        let asset_ids: Vec<String> = asset_ids.iter().cloned().collect();
        let activities = activity_repository.get_split_activities_by_asset_ids_in_date_range(
            &asset_ids,
            start_utc.expect("start bound is provided"),
            end_exclusive_utc.expect("end bound is provided"),
        )?;

        let mut events = Vec::new();
        for (activity, split_date, ratio) in
            Self::select_shared_split_activities(activities, timezone)
        {
            if !Self::activity_date_in_range(split_date, Some(start_date), Some(end_date)) {
                continue;
            }

            let Some(asset_id) = activity
                .asset_id
                .as_ref()
                .filter(|asset_id| !asset_id.is_empty())
            else {
                continue;
            };
            if Self::quotes_appear_split_adjusted(
                quote_closes_by_asset_date,
                asset_id,
                split_date,
                ratio,
            ) {
                events.push(QuoteAdjustedSplitEvent {
                    asset_id: asset_id.clone(),
                    split_date,
                    ratio,
                });
            }
        }

        events.sort_by_key(|event| event.split_date);
        Ok(events)
    }

    fn split_price_factors_for_date(
        valuation_date: NaiveDate,
        events: &[QuoteAdjustedSplitEvent],
    ) -> HashMap<String, Decimal> {
        let mut factors = HashMap::new();
        for event in events {
            if valuation_date >= event.split_date {
                continue;
            }

            *factors
                .entry(event.asset_id.clone())
                .or_insert(Decimal::ONE) *= event.ratio;
        }
        factors
    }

    fn disposal_cost_basis_base(
        &self,
        disposal: &LotDisposal,
        target_base_currency: &str,
    ) -> Decimal {
        let cost_basis_base = parse_decimal_lossy(&disposal.cost_basis_base);
        if disposal
            .base_currency
            .eq_ignore_ascii_case(target_base_currency)
        {
            return cost_basis_base;
        }

        let cost_basis = parse_decimal_lossy(&disposal.cost_basis);
        if cost_basis.is_zero() {
            return Decimal::ZERO;
        }
        let Ok(disposal_date) = NaiveDate::parse_from_str(&disposal.disposal_date, "%Y-%m-%d")
        else {
            return Decimal::ZERO;
        };

        self.fx_service
            .convert_currency_for_date(
                cost_basis,
                &disposal.currency,
                target_base_currency,
                disposal_date,
            )
            .unwrap_or(Decimal::ZERO)
    }

    fn removed_lot_basis_by_activity_base(
        &self,
        account_ids: &[String],
        base_currency: &str,
        start_date_exclusive: NaiveDate,
        end_date_inclusive: NaiveDate,
    ) -> CoreResult<HashMap<String, Decimal>> {
        let Some(lot_repository) = &self.lot_repository else {
            return Ok(HashMap::new());
        };

        let disposals = lot_repository.get_lot_disposals_for_accounts_in_date_range_sync(
            account_ids,
            start_date_exclusive,
            end_date_inclusive,
        )?;
        let mut by_activity = HashMap::<String, Decimal>::new();
        for disposal in disposals {
            let cost_basis_base = self.disposal_cost_basis_base(&disposal, base_currency);
            if cost_basis_base.is_zero() {
                continue;
            }
            *by_activity
                .entry(disposal.disposal_activity_id.clone())
                .or_default() += cost_basis_base.abs();
        }
        Ok(by_activity)
    }

    fn disposal_query_bounds_from_activities(
        activities: &[Activity],
        timezone: chrono_tz::Tz,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> Option<(NaiveDate, NaiveDate)> {
        if let (Some(start_date), Some(end_date)) = (start_date_opt, end_date_opt) {
            return Some((
                start_date
                    .checked_sub_signed(Duration::days(1))
                    .unwrap_or(start_date),
                end_date,
            ));
        }

        let mut dates = activities
            .iter()
            .filter(|activity| activity.is_posted())
            .map(|activity| time_utils::activity_date_in_tz(activity.activity_date, timezone));
        let first_date = dates.next()?;
        let (min_date, max_date) = dates.fold(
            (first_date, first_date),
            |(current_min, current_max), date| (current_min.min(date), current_max.max(date)),
        );

        let start_date_exclusive = start_date_opt.unwrap_or_else(|| {
            min_date
                .checked_sub_signed(Duration::days(1))
                .unwrap_or(min_date)
        });
        let end_date_inclusive = end_date_opt.unwrap_or(max_date);

        Some((start_date_exclusive, end_date_inclusive))
    }

    fn add_external_flow_amount(
        flows_by_date: &mut HashMap<NaiveDate, DailyFlowAmounts>,
        activity_date: NaiveDate,
        amount_base: Decimal,
        is_outflow: bool,
        source: ExternalFlowSource,
    ) {
        if amount_base.is_zero()
            && !matches!(
                source,
                ExternalFlowSource::Unknown
                    | ExternalFlowSource::UnknownBoundaryTransfer
                    | ExternalFlowSource::RemovedLotBasisFallback
            )
        {
            return;
        }

        let entry = flows_by_date
            .entry(activity_date)
            .or_insert_with(|| DailyFlowAmounts::zero_with_source(source));
        if is_outflow {
            entry.outflow += amount_base;
        } else {
            entry.inflow += amount_base;
        }
        entry.source = Self::combine_activity_flow_sources(entry.source, source);
    }

    fn add_flow_adjustment_amount(
        adjustments_by_date: &mut HashMap<NaiveDate, (Decimal, Decimal)>,
        activity_date: NaiveDate,
        amount_base: Decimal,
        is_outflow: bool,
    ) {
        if amount_base.is_zero() {
            return;
        }

        let entry = adjustments_by_date
            .entry(activity_date)
            .or_insert((Decimal::ZERO, Decimal::ZERO));
        if is_outflow {
            entry.1 += amount_base;
        } else {
            entry.0 += amount_base;
        }
    }

    fn transfer_quotes_by_asset_date(
        &self,
        activities: &[Activity],
        timezone: chrono_tz::Tz,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> CoreResult<HashMap<(String, NaiveDate), Quote>> {
        let mut asset_ids = HashSet::new();
        let mut dates = Vec::new();

        for activity in activities {
            if !activity.is_posted() || !Self::is_security_transfer_activity(activity) {
                continue;
            }

            let activity_date = time_utils::activity_date_in_tz(activity.activity_date, timezone);
            if !Self::activity_date_in_range(activity_date, start_date_opt, end_date_opt) {
                continue;
            }

            if let Some(asset_id) = activity
                .asset_id
                .as_ref()
                .filter(|asset_id| !asset_id.is_empty())
            {
                asset_ids.insert(asset_id.clone());
                dates.push(activity_date);
            }
        }

        if asset_ids.is_empty() || dates.is_empty() {
            return Ok(HashMap::new());
        }

        let start_date = dates
            .iter()
            .min()
            .copied()
            .expect("non-empty dates has min");
        let end_date = dates
            .iter()
            .max()
            .copied()
            .expect("non-empty dates has max");

        let quotes = self
            .quote_service
            .get_quotes_in_range_filled(&asset_ids, start_date, end_date)?;
        let mut quotes_by_key = HashMap::with_capacity(quotes.len());
        for quote in quotes {
            quotes_by_key.insert(
                (quote.asset_id.clone(), quote.timestamp.date_naive()),
                quote,
            );
        }

        Ok(quotes_by_key)
    }

    fn account_external_flows_by_date(
        &self,
        account_ids: &[String],
        base_currency: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> CoreResult<Option<HashMap<NaiveDate, DailyFlowAmounts>>> {
        let Some(activity_repository) = &self.activity_repository else {
            return Ok(None);
        };
        if account_ids.is_empty() {
            return Ok(Some(HashMap::new()));
        }

        let scope_account_ids: HashSet<String> = account_ids.iter().cloned().collect();
        let timezone = {
            let timezone_guard = self.timezone.read().unwrap();
            time_utils::parse_user_timezone_or_default(&timezone_guard)
        };
        let (start_utc, end_exclusive_utc) =
            Self::activity_query_utc_bounds(start_date_opt, end_date_opt);

        let scoped_activities = match (start_utc, end_exclusive_utc) {
            (Some(start_utc), Some(end_exclusive_utc)) => activity_repository
                .get_activities_by_account_ids_in_date_range(
                    account_ids,
                    start_utc,
                    end_exclusive_utc,
                )?,
            _ => activity_repository.get_activities_by_account_ids(account_ids)?,
        };
        let transfer_activities = activity_repository
            .get_transfer_activities_touching_account_ids_in_date_range(
                account_ids,
                start_utc,
                end_exclusive_utc,
            )?;
        let all_activities = Self::merge_activities_by_id(scoped_activities, transfer_activities);
        let transfer_resolution = TransferPairResolution::from_activities(&all_activities);
        let transfer_quotes_by_key = self.transfer_quotes_by_asset_date(
            &all_activities,
            timezone,
            start_date_opt,
            end_date_opt,
        )?;
        let transfer_multiplier_context = if Self::has_posted_security_transfer_in_range(
            &all_activities,
            timezone,
            start_date_opt,
            end_date_opt,
        ) {
            self.transfer_multiplier_context_for_accounts(
                account_ids,
                start_date_opt,
                end_date_opt,
            )?
        } else {
            TransferMultiplierContext::default()
        };
        let removed_lot_basis_by_activity = match Self::disposal_query_bounds_from_activities(
            &all_activities,
            timezone,
            start_date_opt,
            end_date_opt,
        ) {
            Some((start_date_exclusive, end_date_inclusive)) => self
                .removed_lot_basis_by_activity_base(
                    account_ids,
                    base_currency,
                    start_date_exclusive,
                    end_date_inclusive,
                )?,
            None => HashMap::new(),
        };

        let mut flows_by_date: HashMap<NaiveDate, DailyFlowAmounts> = HashMap::new();
        for activity in all_activities
            .iter()
            .filter(|activity| scope_account_ids.contains(&activity.account_id))
        {
            if !activity.is_posted() {
                continue;
            }
            let activity_date = time_utils::activity_date_in_tz(activity.activity_date, timezone);
            if !Self::activity_date_in_range(activity_date, start_date_opt, end_date_opt) {
                continue;
            }

            let effective_type = activity.effective_type();
            let transfer_boundary = if effective_type == ACTIVITY_TYPE_TRANSFER_IN
                || effective_type == ACTIVITY_TYPE_TRANSFER_OUT
            {
                if let Some(pair) = transfer_resolution.pair_for_activity(&activity.id) {
                    classify_transfer_boundary_for_account_scope(
                        activity,
                        &scope_account_ids,
                        pair.counterparty_account_id(&activity.id),
                    )
                } else {
                    if let Some(group) =
                        transfer_resolution.invalid_group_for_activity(&activity.id)
                    {
                        warn!(
                            "Invalid transfer group {} ({}) includes activity {}; marking scoped flow as unknown.",
                            group.group_id, group.reason, activity.id
                        );
                    } else if transfer_resolution.is_ungrouped_transfer(&activity.id)
                        && !is_external_transfer(activity)
                    {
                        warn!(
                            "Unresolved transfer activity {} on {} has no explicit external marker; marking scoped flow as unknown.",
                            activity.id, activity_date
                        );
                    }
                    if is_external_transfer(activity) {
                        TransferBoundary::External
                    } else {
                        TransferBoundary::Unknown
                    }
                }
            } else {
                match classify_flow_for_scope(activity, PerformanceScope::Portfolio) {
                    FlowType::External => TransferBoundary::External,
                    FlowType::Internal => TransferBoundary::Internal,
                }
            };

            if transfer_boundary == TransferBoundary::Internal {
                continue;
            }

            let quote = activity.asset_id.as_ref().and_then(|asset_id| {
                transfer_quotes_by_key.get(&(asset_id.clone(), activity_date))
            });
            let unit_multiplier =
                transfer_multiplier_context.multiplier_for(activity, activity_date);
            let economics = Self::resolve_activity_economics_for_boundary_with_unit_multiplier(
                activity,
                quote,
                transfer_boundary,
                unit_multiplier,
            );
            let mut amount_base = self.activity_flow_amount_base(
                activity,
                quote,
                base_currency,
                activity_date,
                transfer_boundary,
                unit_multiplier,
            )?;
            let needs_removed_lot_basis = Self::is_security_transfer_activity(activity)
                && Self::activity_is_outflow(activity)
                && matches!(
                    (transfer_boundary, economics.performance_flow_source),
                    (TransferBoundary::External, ExternalFlowSource::Unknown)
                        | (
                            TransferBoundary::Unknown,
                            ExternalFlowSource::UnknownBoundaryTransfer
                        )
                )
                && amount_base.is_zero();
            let flow_source = if needs_removed_lot_basis {
                ExternalFlowSource::RemovedLotBasisFallback
            } else {
                economics.performance_flow_source
            };
            let flow_source = if flow_source == ExternalFlowSource::RemovedLotBasisFallback {
                match removed_lot_basis_by_activity.get(&activity.id).copied() {
                    Some(removed_basis_base) if !removed_basis_base.is_zero() => {
                        amount_base = removed_basis_base.abs();
                        if transfer_boundary == TransferBoundary::Unknown {
                            ExternalFlowSource::UnknownBoundaryTransfer
                        } else {
                            ExternalFlowSource::RemovedLotBasisFallback
                        }
                    }
                    _ if transfer_boundary == TransferBoundary::Unknown => {
                        ExternalFlowSource::UnknownBoundaryTransfer
                    }
                    _ => ExternalFlowSource::Unknown,
                }
            } else {
                flow_source
            };
            Self::add_external_flow_amount(
                &mut flows_by_date,
                activity_date,
                amount_base,
                Self::activity_is_outflow(activity),
                flow_source,
            );
        }

        Ok(Some(flows_by_date))
    }

    fn scoped_internal_transfer_flow_adjustments_by_date(
        &self,
        account_ids: &[String],
        base_currency: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> CoreResult<Option<HashMap<NaiveDate, (Decimal, Decimal)>>> {
        let Some(activity_repository) = &self.activity_repository else {
            return Ok(None);
        };
        if account_ids.is_empty() {
            return Ok(Some(HashMap::new()));
        }

        let scope_account_ids: HashSet<String> = account_ids.iter().cloned().collect();
        let timezone = {
            let timezone_guard = self.timezone.read().unwrap();
            time_utils::parse_user_timezone_or_default(&timezone_guard)
        };
        let (start_utc, end_exclusive_utc) =
            Self::activity_query_utc_bounds(start_date_opt, end_date_opt);
        let transfer_activities = activity_repository
            .get_transfer_activities_touching_account_ids_in_date_range(
                account_ids,
                start_utc,
                end_exclusive_utc,
            )?;
        let transfer_resolution = TransferPairResolution::from_activities(&transfer_activities);
        let transfer_quotes_by_key = self.transfer_quotes_by_asset_date(
            &transfer_activities,
            timezone,
            start_date_opt,
            end_date_opt,
        )?;
        let transfer_multiplier_context = if Self::has_posted_security_transfer_in_range(
            &transfer_activities,
            timezone,
            start_date_opt,
            end_date_opt,
        ) {
            self.transfer_multiplier_context_for_accounts(
                account_ids,
                start_date_opt,
                end_date_opt,
            )?
        } else {
            TransferMultiplierContext::default()
        };

        let mut adjustments_by_date: HashMap<NaiveDate, (Decimal, Decimal)> = HashMap::new();
        for pair in transfer_resolution.pairs() {
            if !pair.both_accounts_in_scope(&scope_account_ids) {
                continue;
            }

            for activity in [&pair.transfer_in, &pair.transfer_out] {
                let activity_date =
                    time_utils::activity_date_in_tz(activity.activity_date, timezone);
                if !Self::activity_date_in_range(activity_date, start_date_opt, end_date_opt) {
                    continue;
                }
                let quote = activity.asset_id.as_ref().and_then(|asset_id| {
                    transfer_quotes_by_key.get(&(asset_id.clone(), activity_date))
                });
                let unit_multiplier =
                    transfer_multiplier_context.multiplier_for(activity, activity_date);
                let amount_base = self.activity_flow_amount_base(
                    activity,
                    quote,
                    base_currency,
                    activity_date,
                    TransferBoundary::External,
                    unit_multiplier,
                )?;
                Self::add_flow_adjustment_amount(
                    &mut adjustments_by_date,
                    activity_date,
                    amount_base,
                    Self::activity_is_outflow(activity),
                );
            }
        }

        Ok(Some(adjustments_by_date))
    }
}

#[async_trait]
impl ValuationServiceTrait for ValuationService {
    async fn calculate_valuation_history(
        &self,
        account_id: &str,
        mode: ValuationRecalcMode,
    ) -> CoreResult<()> {
        let total_start_time = Instant::now();
        debug!(
            "Starting valuation data update/recalculation for account '{}', mode: {:?}",
            account_id, mode
        );

        let mut calculation_start_date: Option<NaiveDate> = None;
        let mut incremental_anchor_date: Option<NaiveDate> = None;
        let replace_since_date = match &mode {
            ValuationRecalcMode::Full => Some(None),
            ValuationRecalcMode::SinceDate(date) => Some(Some(*date)),
            ValuationRecalcMode::IncrementalFromLast => None,
        };

        match &mode {
            ValuationRecalcMode::Full => {}
            ValuationRecalcMode::SinceDate(date) => {
                let (start_date, anchor_date) = since_date_calculation_window(*date);
                calculation_start_date = Some(start_date);
                incremental_anchor_date = anchor_date;
            }
            ValuationRecalcMode::IncrementalFromLast => {
                let last_saved_date_opt = self
                    .valuation_repository
                    .load_latest_valuation_date(account_id)?;

                if let Some(last_saved) = last_saved_date_opt {
                    calculation_start_date = Some(last_saved);
                    incremental_anchor_date = Some(last_saved);
                }
            }
        }

        let snapshots_to_process = self
            .snapshot_service
            .get_daily_holdings_snapshots(account_id, calculation_start_date, None)
            .map_err(|e| {
                CoreError::Calculation(CalculatorError::Calculation(format!(
                    "Failed snapshot fetch for account {}: {}",
                    account_id, e
                )))
            })?;

        if snapshots_to_process.is_empty() {
            if let Some(since_date) = replace_since_date {
                self.valuation_repository
                    .replace_valuations_for_account(account_id, since_date, &[])
                    .await?;
            }
            return Ok(());
        }

        let actual_calculation_start_date = snapshots_to_process.first().unwrap().snapshot_date;
        let calculation_end_date = snapshots_to_process.last().unwrap().snapshot_date;

        let mut required_asset_ids = HashSet::new();
        let mut required_fx_pairs = HashSet::new();
        let mut acquisition_fx_pairs = HashSet::new();
        let mut acquisition_fx_dates = HashSet::new();
        let base_curr = {
            let base_guard = self.base_currency.read().unwrap();
            normalize_currency_code(&base_guard).to_string()
        };
        let mut normalized_account_currency: Option<String> = None;

        for snapshot in &snapshots_to_process {
            let account_curr = normalize_currency_code(&snapshot.currency);
            if normalized_account_currency.is_none() {
                normalized_account_currency = Some(account_curr.to_string());
            }
            if account_curr != base_curr {
                required_fx_pairs.insert((account_curr.to_string(), base_curr.clone()));
            }
            for (asset_id, position) in &snapshot.positions {
                if !Self::position_requires_price_quote(position) {
                    continue;
                }
                required_asset_ids.insert(asset_id.clone());
                let position_currency = normalize_currency_code(&position.currency);
                if position_currency != account_curr {
                    required_fx_pairs
                        .insert((position_currency.to_string(), account_curr.to_string()));
                }
                if position_currency != base_curr {
                    required_fx_pairs.insert((position_currency.to_string(), base_curr.clone()));
                }
                if !position.lots.is_empty() {
                    if position_currency != account_curr {
                        acquisition_fx_pairs
                            .insert((position_currency.to_string(), account_curr.to_string()));
                    }
                    if position_currency != base_curr {
                        acquisition_fx_pairs
                            .insert((position_currency.to_string(), base_curr.clone()));
                    }
                    for lot in &position.lots {
                        acquisition_fx_dates.insert(lot.acquisition_date_key());
                    }
                }
            }
            for cash_curr in snapshot.cash_balances.keys() {
                let normalized_cash_currency = normalize_currency_code(cash_curr);
                if normalized_cash_currency != account_curr {
                    required_fx_pairs.insert((
                        normalized_cash_currency.to_string(),
                        account_curr.to_string(),
                    ));
                }
            }
        }

        let account_curr = normalized_account_currency.unwrap_or_else(|| base_curr.clone());

        // Fetch quotes with single call
        let quotes_vec = self.quote_service.get_quotes_in_range_filled(
            &required_asset_ids,
            actual_calculation_start_date,
            calculation_end_date,
        )?;
        let quote_closes_by_asset_date = Self::quote_close_by_asset_date(&quotes_vec);
        let quote_adjusted_split_events = self.quote_adjusted_split_events_for_assets(
            &required_asset_ids,
            actual_calculation_start_date,
            calculation_end_date,
            &quote_closes_by_asset_date,
        )?;

        for quote in &quotes_vec {
            let normalized_quote_currency = normalize_currency_code(&quote.currency);
            if normalized_quote_currency != account_curr.as_str() {
                required_fx_pairs
                    .insert((normalized_quote_currency.to_string(), account_curr.clone()));
            }
        }

        let mut fx_rates_by_date = self
            .fetch_fx_rates_for_range(
                &required_fx_pairs,
                actual_calculation_start_date,
                calculation_end_date,
            )
            .await?;
        let acquisition_fx_rates_by_date = self
            .fetch_fx_rates_for_dates(&acquisition_fx_pairs, &acquisition_fx_dates)
            .await?;
        for (date, rates) in acquisition_fx_rates_by_date {
            fx_rates_by_date.entry(date).or_default().extend(rates);
        }

        // Build quotes_by_date and track which assets have ANY quotes at all
        let mut assets_with_quotes: HashSet<String> = HashSet::new();
        let quotes_by_date = {
            let mut map = HashMap::new();
            for quote in quotes_vec {
                assets_with_quotes.insert(quote.asset_id.clone());
                map.entry(quote.timestamp.date_naive())
                    .or_insert_with(HashMap::new)
                    .insert(quote.asset_id.clone(), quote);
            }
            map
        };

        let mut skipped_incomplete_dates: Vec<(NaiveDate, String)> = Vec::new();
        let mut newly_calculated_valuations: Vec<DailyAccountValuation> = snapshots_to_process
            .into_iter()
            .filter_map(|holdings_snapshot| {
                let current_date = holdings_snapshot.snapshot_date;
                let account_id_clone = account_id.to_string();
                let base_curr_clone = base_curr.clone();
                let split_price_factors =
                    Self::split_price_factors_for_date(current_date, &quote_adjusted_split_events);

                let quotes_for_current_date =
                    quotes_by_date.get(&current_date).cloned().unwrap_or_default();

                let fx_for_current_date = fx_rates_by_date
                    .get(&current_date)
                    .cloned()
                    .unwrap_or_default();

                // Count quotable positions (those with quotes somewhere in the range)
                // and how many are missing a quote on this specific date.
                let quotable_positions: Vec<_> = holdings_snapshot
                    .positions
                    .iter()
                    .filter(|(_, position)| Self::position_counts_for_quote_gating(position))
                    .map(|(symbol, _)| symbol)
                    .filter(|symbol| assets_with_quotes.contains(*symbol))
                    .cloned()
                    .collect();

                let missing_quotes: Vec<_> = quotable_positions
                    .iter()
                    .filter(|symbol| !quotes_for_current_date.contains_key(*symbol))
                    .cloned()
                    .collect();

                // Full gap: no quotes at all for any quotable position → skip day
                // to avoid recording a fake zero-value valuation.
                if !quotable_positions.is_empty() && missing_quotes.len() == quotable_positions.len()
                {
                    debug!(
                        "No quotes for any quotable position on {} (account '{}'). Skipping day.",
                        current_date, account_id_clone
                    );
                    return None;
                }

                // Partial gap: some quotes present, some missing → proceed.
                // Missing positions valued at ZERO by the calculator, which is
                // better than dropping the entire day (see #683).
                if !missing_quotes.is_empty() {
                    debug!(
                        "Partial quote gap for {:?} on {} (account '{}').",
                        missing_quotes, current_date, account_id_clone
                    );
                }
                let account_curr = &holdings_snapshot.currency;
                if account_curr != &base_curr_clone
                    && !fx_for_current_date
                        .contains_key(&(account_curr.clone(), base_curr_clone.clone()))
                {
                    warn!(
                        "Base currency FX rate ({}->{}) missing for {} (account '{}'). Skipping day.",
                        account_curr, base_curr_clone, current_date, account_id_clone
                    );
                    skipped_incomplete_dates.push((
                        current_date,
                        format!(
                            "missing base-currency FX rate {}->{}",
                            account_curr, base_curr_clone
                        ),
                    ));
                    return None;
                }

                match calculate_valuation_with_price_factors(
                    &holdings_snapshot,
                    &quotes_for_current_date,
                    &fx_for_current_date,
                    &fx_rates_by_date,
                    current_date,
                    &base_curr_clone,
                    &split_price_factors,
                ) {
                    Ok(valuation_result) => Some(valuation_result),
                    Err(e) => {
                        error!(
                            "Failed to calculate valuation for account {} on date {}: {}. Skipping this date.",
                            account_id, current_date, e
                        );
                        skipped_incomplete_dates.push((current_date, e.to_string()));
                        None
                    }
                }
            })
            .collect();

        if !skipped_incomplete_dates.is_empty() {
            let preview = skipped_incomplete_dates
                .iter()
                .take(5)
                .map(|(date, reason)| format!("{} ({})", date, reason))
                .collect::<Vec<_>>()
                .join(", ");
            return Err(CoreError::Calculation(CalculatorError::Calculation(
                format!(
                    "Incomplete valuation history for account '{}': {} date(s) could not be calculated. First skipped dates: {}",
                    account_id,
                    skipped_incomplete_dates.len(),
                    preview
                ),
            )));
        }

        if let Some(flows_by_date) = self.account_external_flows_by_date(
            &[account_id.to_string()],
            &base_curr,
            Some(actual_calculation_start_date),
            Some(calculation_end_date),
        )? {
            Self::set_external_flows_from_activity_map_or_net_contribution_base(
                &mut newly_calculated_valuations,
                &flows_by_date,
            );
        } else {
            Self::set_external_flows_from_net_contribution_base(&mut newly_calculated_valuations);
        }

        if let Some(anchor_date) = incremental_anchor_date {
            newly_calculated_valuations.retain(|valuation| valuation.valuation_date != anchor_date);
        }

        if let Some(since_date) = replace_since_date {
            self.valuation_repository
                .replace_valuations_for_account(
                    account_id,
                    since_date,
                    &newly_calculated_valuations,
                )
                .await?;
        } else if !newly_calculated_valuations.is_empty() {
            self.valuation_repository
                .save_valuations(&newly_calculated_valuations)
                .await?;
        }

        let total_duration = total_start_time.elapsed();
        debug!(
            "Successfully updated/recalculated valuation data for account '{}' in {:?}",
            account_id, total_duration
        );

        Ok(())
    }

    fn get_historical_valuations(
        &self,
        account_id: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> CoreResult<Vec<DailyAccountValuation>> {
        debug!(
            "Loading historical valuations for account '{}' from {:?} to {:?}",
            account_id, start_date_opt, end_date_opt
        );
        self.valuation_repository.get_historical_valuations(
            account_id,
            start_date_opt,
            end_date_opt,
        )
    }

    fn get_historical_valuations_for_accounts(
        &self,
        scope_id: &str,
        account_ids: &[String],
        base_currency: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> CoreResult<Vec<DailyAccountValuation>> {
        let max_calculated_at = self
            .valuation_repository
            .get_max_calculated_at_for_accounts(account_ids, start_date_opt, end_date_opt)?
            .unwrap_or_default();
        let mut cache_key = ScopedValuationCacheKey {
            service_instance_id: self.service_instance_id,
            mode: ScopedValuationHistoryMode::PerformanceFlows,
            scope_id: scope_id.to_string(),
            membership_hash: Self::membership_hash(account_ids),
            base_currency: base_currency.to_string(),
            start_date: start_date_opt,
            end_date: end_date_opt,
            max_calculated_at,
        };

        if let Some(cached) = self
            .scoped_history_cache
            .read()
            .unwrap()
            .get(&cache_key)
            .cloned()
        {
            return Ok(cached);
        }

        let records = self
            .valuation_repository
            .get_historical_valuations_for_accounts(account_ids, start_date_opt, end_date_opt)?;

        let loaded_max_calculated_at = records
            .iter()
            .map(|valuation| valuation.calculated_at.to_rfc3339())
            .max()
            .unwrap_or_default();
        if loaded_max_calculated_at != cache_key.max_calculated_at {
            cache_key.max_calculated_at = loaded_max_calculated_at;
            if let Some(cached) = self
                .scoped_history_cache
                .read()
                .unwrap()
                .get(&cache_key)
                .cloned()
            {
                return Ok(cached);
            }
        }

        let mut histories_by_account: HashMap<String, Vec<DailyAccountValuation>> =
            HashMap::with_capacity(account_ids.len());
        for record in records {
            histories_by_account
                .entry(record.account_id.clone())
                .or_default()
                .push(record);
        }
        let histories = account_ids
            .iter()
            .map(|account_id| histories_by_account.remove(account_id).unwrap_or_default())
            .collect();

        let internal_transfer_flow_adjustments_by_date = self
            .scoped_internal_transfer_flow_adjustments_by_date(
                account_ids,
                base_currency,
                start_date_opt,
                end_date_opt,
            )?;
        let external_flows_by_date = self.account_external_flows_by_date(
            account_ids,
            base_currency,
            start_date_opt,
            end_date_opt,
        )?;

        let aggregate = Self::aggregate_scoped_valuations(
            scope_id,
            account_ids,
            base_currency,
            histories,
            external_flows_by_date.as_ref(),
            internal_transfer_flow_adjustments_by_date.as_ref(),
        )?;

        self.insert_scoped_history_cache(cache_key, &aggregate);

        Ok(aggregate)
    }

    fn get_historical_valuation_totals_for_accounts(
        &self,
        scope_id: &str,
        account_ids: &[String],
        base_currency: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> CoreResult<Vec<DailyAccountValuation>> {
        let max_calculated_at = self
            .valuation_repository
            .get_max_calculated_at_for_accounts(account_ids, start_date_opt, end_date_opt)?
            .unwrap_or_default();
        let mut cache_key = ScopedValuationCacheKey {
            service_instance_id: self.service_instance_id,
            mode: ScopedValuationHistoryMode::TotalsOnly,
            scope_id: scope_id.to_string(),
            membership_hash: Self::membership_hash(account_ids),
            base_currency: base_currency.to_string(),
            start_date: start_date_opt,
            end_date: end_date_opt,
            max_calculated_at,
        };

        if let Some(cached) = self
            .scoped_history_cache
            .read()
            .unwrap()
            .get(&cache_key)
            .cloned()
        {
            return Ok(cached);
        }

        let records = self
            .valuation_repository
            .get_historical_valuations_for_accounts(account_ids, start_date_opt, end_date_opt)?;

        let loaded_max_calculated_at = records
            .iter()
            .map(|valuation| valuation.calculated_at.to_rfc3339())
            .max()
            .unwrap_or_default();
        if loaded_max_calculated_at != cache_key.max_calculated_at {
            cache_key.max_calculated_at = loaded_max_calculated_at;
            if let Some(cached) = self
                .scoped_history_cache
                .read()
                .unwrap()
                .get(&cache_key)
                .cloned()
            {
                return Ok(cached);
            }
        }

        let mut histories_by_account: HashMap<String, Vec<DailyAccountValuation>> =
            HashMap::with_capacity(account_ids.len());
        for record in records {
            histories_by_account
                .entry(record.account_id.clone())
                .or_default()
                .push(record);
        }
        let histories = account_ids
            .iter()
            .map(|account_id| histories_by_account.remove(account_id).unwrap_or_default())
            .collect();

        let aggregate = Self::aggregate_scoped_valuation_totals(
            scope_id,
            account_ids,
            base_currency,
            histories,
        )?;

        self.insert_scoped_history_cache(cache_key, &aggregate);

        Ok(aggregate)
    }

    fn get_historical_valuations_by_account(
        &self,
        account_ids: &[String],
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> CoreResult<HashMap<String, Vec<DailyAccountValuation>>> {
        let records = self
            .valuation_repository
            .get_historical_valuations_for_accounts(account_ids, start_date_opt, end_date_opt)?;

        let mut histories = HashMap::with_capacity(account_ids.len());
        for account_id in account_ids {
            histories.insert(account_id.clone(), Vec::new());
        }
        for record in records {
            histories
                .entry(record.account_id.clone())
                .or_default()
                .push(record);
        }

        Ok(histories)
    }

    fn get_latest_valuations(
        &self,
        account_ids: &[String],
    ) -> CoreResult<Vec<DailyAccountValuation>> {
        debug!("Loading latest valuations for accounts: {:?}", account_ids);
        self.valuation_repository.get_latest_valuations(account_ids)
    }

    fn get_valuations_on_date(
        &self,
        account_ids: &[String],
        date: NaiveDate,
    ) -> CoreResult<Vec<DailyAccountValuation>> {
        debug!(
            "Loading valuations for accounts {:?} on date {}",
            account_ids, date
        );
        self.valuation_repository
            .get_valuations_on_date(account_ids, date)
    }

    fn get_accounts_with_negative_balance(
        &self,
        account_ids: &[String],
    ) -> CoreResult<Vec<NegativeBalanceInfo>> {
        self.valuation_repository
            .get_accounts_with_negative_balance(account_ids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activities::ActivityStatus;
    use crate::portfolio::snapshot::SnapshotSource;
    use chrono::{DateTime, Utc};
    use rust_decimal::Decimal;
    use rust_decimal_macros::dec;

    // ─── External flow-source provenance combiner contract ───────────────────
    //
    // The combiner merges two flow provenances that land on the same day (same
    // activity-flow date) or the same aggregation bucket (same date across
    // accounts in scope). The hard contract is: merging must never *upgrade*
    // trust. If either input is unavailable-for-returns or degraded, the merged
    // provenance must remain at least as unavailable/degraded. Otherwise the
    // downstream TWR/IRR availability gates can be silently bypassed.

    const ALL_FLOW_SOURCES: [ExternalFlowSource; 12] = [
        ExternalFlowSource::NoFlow,
        ExternalFlowSource::Unknown,
        ExternalFlowSource::CashAmount,
        ExternalFlowSource::QuoteDerivedMarketValue,
        ExternalFlowSource::CostBasisFallback,
        ExternalFlowSource::RemovedLotBasisFallback,
        ExternalFlowSource::LegacyActivityAmountFallback,
        ExternalFlowSource::UnknownBoundaryTransfer,
        ExternalFlowSource::ActivityDerived,
        ExternalFlowSource::StoredGross,
        ExternalFlowSource::NetContributionFallback,
        ExternalFlowSource::Mixed,
    ];

    #[test]
    fn combiner_is_idempotent_for_every_source() {
        for source in ALL_FLOW_SOURCES {
            assert_eq!(
                ValuationService::combine_activity_flow_sources(source, source),
                source,
                "combining {source:?} with itself must be a no-op",
            );
        }
    }

    #[test]
    fn combiner_decision_is_order_independent() {
        for a in ALL_FLOW_SOURCES {
            for b in ALL_FLOW_SOURCES {
                let ab = ValuationService::combine_activity_flow_sources(a, b);
                let ba = ValuationService::combine_activity_flow_sources(b, a);
                assert_eq!(
                    ab.is_unavailable_for_returns(),
                    ba.is_unavailable_for_returns(),
                    "availability must not depend on combine order for ({a:?}, {b:?})",
                );
                assert_eq!(
                    ab.is_degraded(),
                    ba.is_degraded(),
                    "degradation must not depend on combine order for ({a:?}, {b:?})",
                );
            }
        }
    }

    #[test]
    fn combiner_preserves_unknown_boundary_transfer_over_known_cash() {
        assert_eq!(
            ValuationService::combine_activity_flow_sources(
                ExternalFlowSource::UnknownBoundaryTransfer,
                ExternalFlowSource::CashAmount,
            ),
            ExternalFlowSource::UnknownBoundaryTransfer,
        );
        assert_eq!(
            ValuationService::combine_activity_flow_sources(
                ExternalFlowSource::CashAmount,
                ExternalFlowSource::UnknownBoundaryTransfer,
            ),
            ExternalFlowSource::UnknownBoundaryTransfer,
        );
    }

    #[test]
    fn combiner_preserves_removed_lot_basis_over_known_cash() {
        assert_eq!(
            ValuationService::combine_activity_flow_sources(
                ExternalFlowSource::RemovedLotBasisFallback,
                ExternalFlowSource::CashAmount,
            ),
            ExternalFlowSource::RemovedLotBasisFallback,
        );
    }

    #[test]
    fn combiner_mixes_two_distinct_known_gross_sources() {
        assert_eq!(
            ValuationService::combine_activity_flow_sources(
                ExternalFlowSource::CashAmount,
                ExternalFlowSource::QuoteDerivedMarketValue,
            ),
            ExternalFlowSource::Mixed,
        );
    }

    #[test]
    fn unavailable_sources_are_always_degraded() {
        for source in ALL_FLOW_SOURCES {
            if source.is_unavailable_for_returns() {
                assert!(
                    source.is_degraded(),
                    "{source:?} is unavailable-for-returns but not degraded",
                );
            }
        }
    }

    #[test]
    fn combiner_treats_no_flow_as_the_neutral_identity() {
        for source in ALL_FLOW_SOURCES {
            assert_eq!(
                ValuationService::combine_activity_flow_sources(ExternalFlowSource::NoFlow, source),
                source,
                "NoFlow on the left must be the identity for {source:?}",
            );
            assert_eq!(
                ValuationService::combine_activity_flow_sources(source, ExternalFlowSource::NoFlow),
                source,
                "NoFlow on the right must be the identity for {source:?}",
            );
        }
    }

    // F1 end to end: aggregating a real unvaluable flow in one account with a
    // valued cash flow in another must keep the aggregated scope unavailable, so
    // a multi-account scope cannot bypass the TWR/IRR gate.
    #[test]
    fn aggregating_unknown_with_known_cash_keeps_scope_unavailable() {
        let mut acct_a = vec![
            valuation(
                "acct_a",
                "2026-04-01",
                dec!(1000),
                dec!(1000),
                dec!(0),
                dec!(0),
            ),
            valuation(
                "acct_a",
                "2026-04-02",
                dec!(1100),
                dec!(1100),
                dec!(100),
                dec!(0),
            ),
        ];
        acct_a[1].external_flow_source = ExternalFlowSource::Unknown;

        let mut acct_b = vec![
            valuation(
                "acct_b",
                "2026-04-01",
                dec!(500),
                dec!(500),
                dec!(0),
                dec!(0),
            ),
            valuation(
                "acct_b",
                "2026-04-02",
                dec!(550),
                dec!(550),
                dec!(50),
                dec!(0),
            ),
        ];
        acct_b[1].external_flow_source = ExternalFlowSource::CashAmount;

        let aggregated = ValuationService::aggregate_scoped_valuations(
            "scope",
            &["acct_a".to_string(), "acct_b".to_string()],
            "USD",
            vec![acct_a, acct_b],
            None,
            None,
        )
        .expect("aggregation should succeed");

        let day2 = aggregated
            .iter()
            .find(|v| v.valuation_date == NaiveDate::from_ymd_opt(2026, 4, 2).unwrap())
            .expect("aggregated day 2 present");
        assert_eq!(
            day2.external_flow_source,
            ExternalFlowSource::Unknown,
            "an unvaluable flow in one account must keep the aggregated scope unavailable",
        );
        assert!(day2.external_flow_source.is_unavailable_for_returns());
    }

    #[test]
    fn scoped_history_cache_keys_separate_totals_from_performance_flows() {
        let totals_key = ScopedValuationCacheKey {
            service_instance_id: 1,
            mode: ScopedValuationHistoryMode::TotalsOnly,
            scope_id: "all".to_string(),
            membership_hash: "members".to_string(),
            base_currency: "CAD".to_string(),
            start_date: Some(date("2026-01-01")),
            end_date: Some(date("2026-06-25")),
            max_calculated_at: "2026-06-25T00:00:00Z".to_string(),
        };
        let performance_key = ScopedValuationCacheKey {
            mode: ScopedValuationHistoryMode::PerformanceFlows,
            ..totals_key.clone()
        };

        assert_ne!(totals_key, performance_key);
    }

    #[test]
    fn valuation_totals_aggregation_skips_internal_transfer_flow_adjustments() {
        let acct_a = vec![
            valuation(
                "acct_a",
                "2026-04-01",
                dec!(100),
                dec!(100),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            valuation(
                "acct_a",
                "2026-04-02",
                dec!(150),
                dec!(150),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
        ];
        let acct_b = vec![
            valuation(
                "acct_b",
                "2026-04-01",
                dec!(50),
                dec!(50),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            valuation(
                "acct_b",
                "2026-04-02",
                dec!(70),
                dec!(70),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
        ];
        let histories = vec![acct_a, acct_b];
        let account_ids = ["acct_a".to_string(), "acct_b".to_string()];
        let mut internal_transfer_adjustments = HashMap::new();
        internal_transfer_adjustments.insert(date("2026-04-02"), (dec!(70), Decimal::ZERO));

        let totals = ValuationService::aggregate_scoped_valuation_totals(
            "scope",
            &account_ids,
            "CAD",
            histories.clone(),
        )
        .expect("totals aggregation should succeed");
        let adjusted = ValuationService::aggregate_scoped_valuations(
            "scope",
            &account_ids,
            "CAD",
            histories,
            None,
            Some(&internal_transfer_adjustments),
        )
        .expect("adjusted aggregation should succeed");

        let totals_day2 = totals
            .iter()
            .find(|valuation| valuation.valuation_date == date("2026-04-02"))
            .expect("totals day 2 present");
        let adjusted_day2 = adjusted
            .iter()
            .find(|valuation| valuation.valuation_date == date("2026-04-02"))
            .expect("adjusted day 2 present");

        assert_eq!(totals_day2.total_value_base, dec!(220));
        assert_eq!(totals_day2.net_contribution_base, dec!(220));
        assert_eq!(totals_day2.external_inflow_base, dec!(70));
        assert_eq!(adjusted_day2.external_inflow_base, Decimal::ZERO);
    }

    // Core availability contract: merging two provenances must never upgrade
    // trust. If either input is unavailable-for-returns, the result must remain
    // unavailable. This holds because `Unknown`/`UnknownBoundaryTransfer` are
    // absorbing and the neutral identity is the dedicated `NoFlow` variant.
    #[test]
    fn combiner_never_upgrades_availability() {
        for a in ALL_FLOW_SOURCES {
            for b in ALL_FLOW_SOURCES {
                let combined = ValuationService::combine_activity_flow_sources(a, b);
                let inputs_unavailable =
                    a.is_unavailable_for_returns() || b.is_unavailable_for_returns();
                assert_eq!(
                    combined.is_unavailable_for_returns(),
                    inputs_unavailable,
                    "combine({a:?}, {b:?}) = {combined:?} must stay unavailable-for-returns when either input is",
                );
            }
        }
    }

    #[test]
    fn combiner_never_downgrades_degradation() {
        for a in ALL_FLOW_SOURCES {
            for b in ALL_FLOW_SOURCES {
                let combined = ValuationService::combine_activity_flow_sources(a, b);
                if a.is_degraded() || b.is_degraded() {
                    assert!(
                        combined.is_degraded(),
                        "combine({a:?}, {b:?}) = {combined:?} dropped degradation",
                    );
                }
            }
        }
    }

    #[test]
    fn combiner_keeps_unknown_over_known_cash() {
        assert_eq!(
            ValuationService::combine_activity_flow_sources(
                ExternalFlowSource::Unknown,
                ExternalFlowSource::CashAmount,
            ),
            ExternalFlowSource::Unknown,
        );
        assert_eq!(
            ValuationService::combine_activity_flow_sources(
                ExternalFlowSource::CashAmount,
                ExternalFlowSource::Unknown,
            ),
            ExternalFlowSource::Unknown,
        );
    }

    fn valuation(
        account_id: &str,
        date: &str,
        total_value_base: Decimal,
        net_contribution_base: Decimal,
        external_inflow_base: Decimal,
        external_outflow_base: Decimal,
    ) -> DailyAccountValuation {
        DailyAccountValuation {
            id: format!("{}-{}", account_id, date),
            account_id: account_id.to_string(),
            valuation_date: NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap(),
            account_currency: "CAD".to_string(),
            base_currency: "USD".to_string(),
            fx_rate_to_base: Decimal::ONE,
            cash_balance: total_value_base,
            investment_market_value: Decimal::ZERO,
            total_value: total_value_base,
            cost_basis: Decimal::ZERO,
            book_basis: net_contribution_base,
            net_contribution: net_contribution_base,
            cash_balance_base: total_value_base,
            investment_market_value_base: Decimal::ZERO,
            total_value_base,
            cost_basis_base: Decimal::ZERO,
            book_basis_base: net_contribution_base,
            net_contribution_base,
            external_inflow_base,
            external_outflow_base,
            external_flow_source: if external_inflow_base.is_zero()
                && external_outflow_base.is_zero()
            {
                ExternalFlowSource::NoFlow
            } else {
                ExternalFlowSource::StoredGross
            },
            performance_eligible_value_base: total_value_base,
            value_status: ValuationStatus::Complete,
            basis_status: BasisStatus::NotApplicable,
            calculated_at: DateTime::<Utc>::from_timestamp(0, 0).unwrap(),
        }
    }

    fn activity_time(date_str: &str) -> DateTime<Utc> {
        NaiveDate::parse_from_str(date_str, "%Y-%m-%d")
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc()
    }

    fn date(date_str: &str) -> NaiveDate {
        NaiveDate::parse_from_str(date_str, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn since_date_recalc_uses_previous_day_as_discarded_anchor() {
        let (start_date, anchor_date) = since_date_calculation_window(date("2025-03-02"));

        assert_eq!(start_date, date("2025-03-01"));
        assert_eq!(anchor_date, Some(date("2025-03-01")));
    }

    #[test]
    fn since_date_recalc_anchor_saturates_at_min_date() {
        let (start_date, anchor_date) = since_date_calculation_window(NaiveDate::MIN);

        assert_eq!(start_date, NaiveDate::MIN);
        assert_eq!(anchor_date, None);
    }

    fn transfer_activity_on_date(
        id: &str,
        activity_type: &str,
        activity_date: &str,
        account_id: &str,
    ) -> Activity {
        let activity_time = activity_time(activity_date);
        Activity {
            id: id.to_string(),
            account_id: account_id.to_string(),
            asset_id: Some("AAPL".to_string()),
            activity_type: activity_type.to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: None,
            status: ActivityStatus::Posted,
            activity_date: activity_time,
            settlement_date: None,
            quantity: Some(dec!(10)),
            unit_price: Some(dec!(8)),
            amount: None,
            fee: Some(Decimal::ZERO),
            tax: None,
            currency: "USD".to_string(),
            fx_rate: None,
            notes: None,
            metadata: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
            import_run_id: None,
            is_user_modified: false,
            needs_review: false,
            created_at: activity_time,
            updated_at: activity_time,
        }
    }

    fn split_activity_on_date(
        id: &str,
        account_id: &str,
        asset_id: &str,
        activity_date: &str,
        ratio: Decimal,
        source_system: Option<&str>,
    ) -> Activity {
        let mut activity = transfer_activity_on_date(id, "SPLIT", activity_date, account_id);
        activity.asset_id = Some(asset_id.to_string());
        activity.quantity = None;
        activity.unit_price = None;
        activity.amount = Some(ratio);
        activity.source_system = source_system.map(str::to_string);
        activity
    }

    fn transfer_activity(
        activity_type: &str,
        asset_id: Option<&str>,
        quantity: Option<Decimal>,
        unit_price: Option<Decimal>,
        amount: Option<Decimal>,
    ) -> Activity {
        let activity_time = activity_time("2026-06-01");
        Activity {
            id: "transfer-1".to_string(),
            account_id: "account-1".to_string(),
            asset_id: asset_id.map(str::to_string),
            activity_type: activity_type.to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: None,
            status: ActivityStatus::Posted,
            activity_date: activity_time,
            settlement_date: None,
            quantity,
            unit_price,
            amount,
            fee: Some(Decimal::ZERO),
            tax: None,
            currency: "USD".to_string(),
            fx_rate: None,
            notes: None,
            metadata: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
            import_run_id: None,
            is_user_modified: false,
            needs_review: false,
            created_at: activity_time,
            updated_at: activity_time,
        }
    }

    fn quote(asset_id: &str, close: Decimal, currency: &str) -> Quote {
        quote_on_date(asset_id, close, currency, "2026-06-01")
    }

    fn quote_on_date(asset_id: &str, close: Decimal, currency: &str, date_str: &str) -> Quote {
        Quote {
            id: format!("quote-{asset_id}"),
            asset_id: asset_id.to_string(),
            timestamp: activity_time(date_str),
            open: close,
            high: close,
            low: close,
            close,
            adjclose: close,
            volume: Decimal::ZERO,
            currency: currency.to_string(),
            data_source: "TEST".to_string(),
            created_at: activity_time(date_str),
            notes: None,
        }
    }

    fn snapshot_with_position(
        snapshot_date: &str,
        asset_id: &str,
        quantity: Decimal,
    ) -> AccountStateSnapshot {
        let date = date(snapshot_date);
        AccountStateSnapshot {
            id: format!("account-1-{snapshot_date}"),
            account_id: "account-1".to_string(),
            snapshot_date: date,
            currency: "USD".to_string(),
            positions: HashMap::from([(
                asset_id.to_string(),
                Position {
                    id: format!("POS-{asset_id}-account-1"),
                    account_id: "account-1".to_string(),
                    asset_id: asset_id.to_string(),
                    quantity,
                    average_cost: dec!(10),
                    total_cost_basis: quantity * dec!(10),
                    currency: "USD".to_string(),
                    inception_date: activity_time(snapshot_date),
                    ..Position::default()
                },
            )]),
            cash_balances: HashMap::new(),
            cost_basis: quantity * dec!(10),
            net_contribution: Decimal::ZERO,
            net_contribution_base: Decimal::ZERO,
            cash_total_account_currency: Decimal::ZERO,
            cash_total_base_currency: Decimal::ZERO,
            calculated_at: activity_time(snapshot_date).naive_utc(),
            source: SnapshotSource::Calculated,
        }
    }

    #[test]
    fn detects_split_adjusted_quote_series() {
        let quote_closes = ValuationService::quote_close_by_asset_date(&[
            quote_on_date("NFLX", dec!(111.22), "USD", "2025-11-14"),
            quote_on_date("NFLX", dec!(110.29), "USD", "2025-11-17"),
        ]);

        assert!(ValuationService::quotes_appear_split_adjusted(
            &quote_closes,
            "NFLX",
            date("2025-11-17"),
            dec!(10),
        ));
    }

    #[test]
    fn skips_raw_quote_series_around_split() {
        let quote_closes = ValuationService::quote_close_by_asset_date(&[
            quote_on_date("NFLX", dec!(1112.20), "USD", "2025-11-14"),
            quote_on_date("NFLX", dec!(110.29), "USD", "2025-11-17"),
        ]);

        assert!(!ValuationService::quotes_appear_split_adjusted(
            &quote_closes,
            "NFLX",
            date("2025-11-17"),
            dec!(10),
        ));
    }

    #[test]
    fn shared_split_selection_deduplicates_matching_account_rows() {
        let activities = vec![
            split_activity_on_date(
                "account-1-split",
                "account-1",
                "VGT",
                "2025-12-01",
                dec!(4),
                Some("MANUAL"),
            ),
            split_activity_on_date(
                "account-2-split",
                "account-2",
                "VGT",
                "2025-12-01",
                dec!(4),
                Some("SNAPTRADE"),
            ),
        ];

        let selected = ValuationService::select_shared_split_activities(activities, chrono_tz::UTC);

        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].0.id, "account-1-split");
        assert_eq!(selected[0].2, dec!(4));
    }

    #[test]
    fn shared_split_selection_uses_same_conflict_winner_for_every_account() {
        let activities = vec![
            split_activity_on_date(
                "losing-valued-account-row",
                "account-being-valued",
                "VGT",
                "2025-12-01",
                dec!(4.5),
                Some("SNAPTRADE"),
            ),
            split_activity_on_date(
                "manual-winner",
                "other-account",
                "VGT",
                "2025-12-01",
                dec!(4),
                Some("MANUAL"),
            ),
        ];

        let selected = ValuationService::select_shared_split_activities(activities, chrono_tz::UTC);

        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].0.id, "manual-winner");
        assert_eq!(selected[0].2, dec!(4));
        let factors = ValuationService::split_price_factors_for_date(
            date("2025-11-30"),
            &[QuoteAdjustedSplitEvent {
                asset_id: "VGT".to_string(),
                split_date: selected[0].1,
                ratio: selected[0].2,
            }],
        );
        assert_eq!(factors.get("VGT"), Some(&dec!(4)));
    }

    #[test]
    fn shared_split_selection_merges_adjacent_dates_for_same_event() {
        let activities = vec![
            split_activity_on_date(
                "broker-day-before",
                "account-1",
                "VGT",
                "2025-11-30",
                dec!(4),
                Some("SNAPTRADE"),
            ),
            split_activity_on_date(
                "manual-winner",
                "account-2",
                "VGT",
                "2025-12-01",
                dec!(4),
                Some("MANUAL"),
            ),
            split_activity_on_date(
                "earlier-distinct-split",
                "account-1",
                "VGT",
                "2025-06-15",
                dec!(2),
                Some("SNAPTRADE"),
            ),
        ];

        let selected = ValuationService::select_shared_split_activities(activities, chrono_tz::UTC);

        assert_eq!(selected.len(), 2);
        assert_eq!(selected[0].0.id, "earlier-distinct-split");
        assert_eq!(selected[0].1, date("2025-06-15"));
        assert_eq!(selected[1].0.id, "manual-winner");
        assert_eq!(selected[1].1, date("2025-12-01"));
        assert_eq!(selected[1].2, dec!(4));
    }

    #[test]
    fn split_recorded_in_other_account_corrects_pre_sale_valuation() {
        let selected = ValuationService::select_shared_split_activities(
            vec![split_activity_on_date(
                "other-account-split",
                "other-account",
                "VGT",
                "2025-12-01",
                dec!(4),
                Some("MANUAL"),
            )],
            chrono_tz::UTC,
        );
        let quote_closes = ValuationService::quote_close_by_asset_date(&[
            quote_on_date("VGT", dec!(25), "USD", "2025-11-28"),
            quote_on_date("VGT", dec!(26), "USD", "2025-12-01"),
        ]);
        let (_, split_date, ratio) = &selected[0];
        assert!(ValuationService::quotes_appear_split_adjusted(
            &quote_closes,
            "VGT",
            *split_date,
            *ratio,
        ));

        let factors = ValuationService::split_price_factors_for_date(
            date("2025-11-28"),
            &[QuoteAdjustedSplitEvent {
                asset_id: "VGT".to_string(),
                split_date: *split_date,
                ratio: *ratio,
            }],
        );
        let snapshot = snapshot_with_position("2025-11-28", "VGT", dec!(10));
        let valuation = calculate_valuation_with_price_factors(
            &snapshot,
            &HashMap::from([(
                "VGT".to_string(),
                quote_on_date("VGT", dec!(25), "USD", "2025-11-28"),
            )]),
            &HashMap::new(),
            &HashMap::new(),
            date("2025-11-28"),
            "USD",
            &factors,
        )
        .unwrap();

        assert_eq!(valuation.investment_market_value, dec!(1000));
    }

    #[test]
    fn quote_adjusted_split_event_builds_pre_split_price_factor_only() {
        let before_split = snapshot_with_position("2025-11-14", "NFLX", dec!(20));
        let split_day = snapshot_with_position("2025-11-17", "NFLX", dec!(200));
        let events = vec![QuoteAdjustedSplitEvent {
            asset_id: "NFLX".to_string(),
            split_date: date("2025-11-17"),
            ratio: dec!(10),
        }];

        let before_factors =
            ValuationService::split_price_factors_for_date(date("2025-11-14"), &events);
        let split_day_factors =
            ValuationService::split_price_factors_for_date(date("2025-11-17"), &events);

        assert_eq!(before_factors.get("NFLX"), Some(&dec!(10)));
        assert!(split_day_factors.is_empty());
        assert_eq!(
            before_split.positions.get("NFLX").unwrap().quantity,
            dec!(20)
        );
        assert_eq!(
            before_split.positions.get("NFLX").unwrap().average_cost,
            dec!(10)
        );
        assert_eq!(split_day.positions.get("NFLX").unwrap().quantity, dec!(200));
        assert_eq!(
            split_day.positions.get("NFLX").unwrap().average_cost,
            dec!(10)
        );
    }

    #[test]
    fn split_price_factors_multiply_future_splits_and_exclude_split_day() {
        let events = vec![
            QuoteAdjustedSplitEvent {
                asset_id: "AAPL".to_string(),
                split_date: date("2025-01-10"),
                ratio: dec!(2),
            },
            QuoteAdjustedSplitEvent {
                asset_id: "AAPL".to_string(),
                split_date: date("2025-01-20"),
                ratio: dec!(3),
            },
            QuoteAdjustedSplitEvent {
                asset_id: "REV".to_string(),
                split_date: date("2025-01-20"),
                ratio: dec!(0.02),
            },
        ];

        let before_all =
            ValuationService::split_price_factors_for_date(date("2025-01-01"), &events);
        let on_first_split =
            ValuationService::split_price_factors_for_date(date("2025-01-10"), &events);

        assert_eq!(before_all.get("AAPL"), Some(&dec!(6)));
        assert_eq!(before_all.get("REV"), Some(&dec!(0.02)));
        assert_eq!(on_first_split.get("AAPL"), Some(&dec!(3)));
        assert_eq!(on_first_split.get("REV"), Some(&dec!(0.02)));
    }

    #[test]
    fn all_time_disposal_query_bounds_include_first_activity_day() {
        let activities = vec![
            transfer_activity_on_date(
                "transfer-out",
                ACTIVITY_TYPE_TRANSFER_OUT,
                "2026-06-02",
                "account-1",
            ),
            transfer_activity_on_date(
                "transfer-in",
                ACTIVITY_TYPE_TRANSFER_IN,
                "2026-06-10",
                "account-2",
            ),
        ];

        let bounds = ValuationService::disposal_query_bounds_from_activities(
            &activities,
            chrono_tz::UTC,
            None,
            None,
        )
        .expect("posted activities should produce disposal query bounds");

        assert_eq!(bounds.0, date("2026-06-01"));
        assert_eq!(bounds.1, date("2026-06-10"));
    }

    #[test]
    fn disposal_query_bounds_respect_explicit_period_start() {
        let activities = vec![transfer_activity_on_date(
            "transfer-out",
            ACTIVITY_TYPE_TRANSFER_OUT,
            "2026-06-02",
            "account-1",
        )];

        let bounds = ValuationService::disposal_query_bounds_from_activities(
            &activities,
            chrono_tz::UTC,
            Some(date("2026-06-01")),
            None,
        )
        .expect("posted activities should produce disposal query bounds");

        assert_eq!(bounds.0, date("2026-06-01"));
        assert_eq!(bounds.1, date("2026-06-02"));
    }

    #[test]
    fn security_transfer_flow_uses_quote_value_not_cost_basis() {
        let activity = transfer_activity(
            ACTIVITY_TYPE_TRANSFER_IN,
            Some("AAPL"),
            Some(dec!(10)),
            Some(dec!(8)),
            None,
        );
        let quote = quote("AAPL", dec!(12), "USD");

        let economics = ValuationService::resolve_activity_economics_for_boundary(
            &activity,
            Some(&quote),
            TransferBoundary::External,
        );

        assert_eq!(economics.lot_cost_basis_value, dec!(80));
        assert_eq!(economics.performance_flow_value, dec!(120));
        assert_eq!(economics.performance_flow_currency, "USD");
        assert_eq!(
            economics.performance_flow_source,
            ExternalFlowSource::QuoteDerivedMarketValue
        );
    }

    #[test]
    fn security_transfer_economics_apply_unit_multiplier_to_basis_and_flow() {
        let activity = transfer_activity(
            ACTIVITY_TYPE_TRANSFER_IN,
            Some("AAPL240119C00150000"),
            Some(dec!(2)),
            Some(dec!(5)),
            Some(dec!(999)),
        );
        let quote = quote("AAPL240119C00150000", dec!(6), "USD");

        let economics =
            ValuationService::resolve_activity_economics_for_boundary_with_unit_multiplier(
                &activity,
                Some(&quote),
                TransferBoundary::External,
                dec!(100),
            );

        assert_eq!(economics.lot_cost_basis_value, dec!(1000));
        assert_eq!(economics.performance_flow_value, dec!(1200));
        assert_eq!(
            economics.performance_flow_source,
            ExternalFlowSource::QuoteDerivedMarketValue
        );
    }

    #[test]
    fn security_transfer_amount_does_not_override_lot_cost_basis_when_quote_exists() {
        let activity = transfer_activity(
            ACTIVITY_TYPE_TRANSFER_IN,
            Some("AAPL"),
            Some(dec!(10)),
            Some(dec!(8)),
            Some(dec!(999)),
        );
        let quote = quote("AAPL", dec!(12), "USD");

        let economics = ValuationService::resolve_activity_economics_for_boundary(
            &activity,
            Some(&quote),
            TransferBoundary::External,
        );

        assert_eq!(economics.lot_cost_basis_value, dec!(80));
        assert_eq!(economics.performance_flow_value, dec!(120));
        assert_eq!(
            economics.performance_flow_source,
            ExternalFlowSource::QuoteDerivedMarketValue
        );
    }

    #[test]
    fn security_transfer_without_quote_falls_back_to_cost_basis() {
        let activity = transfer_activity(
            ACTIVITY_TYPE_TRANSFER_IN,
            Some("AAPL"),
            Some(dec!(10)),
            Some(dec!(8)),
            None,
        );

        let economics = ValuationService::resolve_activity_economics_for_boundary(
            &activity,
            None,
            TransferBoundary::External,
        );

        assert_eq!(economics.lot_cost_basis_value, dec!(80));
        assert_eq!(economics.performance_flow_value, dec!(80));
        assert_eq!(
            economics.performance_flow_source,
            ExternalFlowSource::CostBasisFallback
        );
    }

    #[test]
    fn security_transfer_amount_without_quote_does_not_override_cost_basis() {
        let activity = transfer_activity(
            ACTIVITY_TYPE_TRANSFER_IN,
            Some("AAPL"),
            Some(dec!(10)),
            Some(dec!(8)),
            Some(dec!(999)),
        );

        let economics = ValuationService::resolve_activity_economics_for_boundary(
            &activity,
            None,
            TransferBoundary::External,
        );

        assert_eq!(economics.lot_cost_basis_value, dec!(80));
        assert_eq!(economics.performance_flow_value, dec!(80));
        assert_eq!(
            economics.performance_flow_source,
            ExternalFlowSource::CostBasisFallback
        );
    }

    #[test]
    fn external_transfer_out_without_quote_defers_to_removed_lot_basis_even_with_entered_basis() {
        let activity = transfer_activity(
            ACTIVITY_TYPE_TRANSFER_OUT,
            Some("AAPL"),
            Some(dec!(10)),
            Some(dec!(8)),
            Some(dec!(999)),
        );

        let economics = ValuationService::resolve_activity_economics_for_boundary(
            &activity,
            None,
            TransferBoundary::External,
        );

        assert_eq!(economics.lot_cost_basis_value, dec!(80));
        assert_eq!(economics.performance_flow_value, Decimal::ZERO);
        assert_eq!(
            economics.performance_flow_source,
            ExternalFlowSource::Unknown
        );
    }

    #[test]
    fn legacy_security_transfer_without_cost_basis_can_use_activity_amount() {
        let activity = transfer_activity(
            ACTIVITY_TYPE_TRANSFER_IN,
            Some("AAPL"),
            Some(dec!(10)),
            None,
            Some(dec!(250)),
        );

        let economics = ValuationService::resolve_activity_economics_for_boundary(
            &activity,
            None,
            TransferBoundary::External,
        );

        assert_eq!(economics.lot_cost_basis_value, dec!(250));
        assert_eq!(economics.performance_flow_value, dec!(250));
        assert_eq!(
            economics.performance_flow_source,
            ExternalFlowSource::LegacyActivityAmountFallback
        );
    }

    #[test]
    fn cash_transfer_flow_uses_activity_amount() {
        let activity =
            transfer_activity(ACTIVITY_TYPE_TRANSFER_IN, None, None, None, Some(dec!(250)));

        let economics = ValuationService::resolve_activity_economics_for_boundary(
            &activity,
            None,
            TransferBoundary::External,
        );

        assert_eq!(economics.lot_cost_basis_value, Decimal::ZERO);
        assert_eq!(economics.performance_flow_value, dec!(250));
        assert_eq!(
            economics.performance_flow_source,
            ExternalFlowSource::CashAmount
        );
    }

    #[test]
    fn internal_cash_transfer_compiles_without_performance_flow() {
        let activity =
            transfer_activity(ACTIVITY_TYPE_TRANSFER_IN, None, None, None, Some(dec!(250)));

        let economics = ValuationService::resolve_activity_economics_for_boundary(
            &activity,
            None,
            TransferBoundary::Internal,
        );

        assert_eq!(economics.lot_cost_basis_value, Decimal::ZERO);
        assert_eq!(economics.performance_flow_value, Decimal::ZERO);
        assert_eq!(
            economics.performance_flow_source,
            ExternalFlowSource::Unknown
        );
    }

    #[test]
    fn internal_security_transfer_keeps_lot_basis_but_has_no_performance_flow() {
        let activity = transfer_activity(
            ACTIVITY_TYPE_TRANSFER_IN,
            Some("AAPL"),
            Some(dec!(10)),
            Some(dec!(8)),
            Some(dec!(999)),
        );
        let quote = quote("AAPL", dec!(12), "USD");

        let economics = ValuationService::resolve_activity_economics_for_boundary(
            &activity,
            Some(&quote),
            TransferBoundary::Internal,
        );

        assert_eq!(economics.lot_cost_basis_value, dec!(80));
        assert_eq!(economics.performance_flow_value, Decimal::ZERO);
        assert_eq!(
            economics.performance_flow_source,
            ExternalFlowSource::Unknown
        );
    }

    #[test]
    fn transfer_multiplier_snapshot_fetch_starts_before_requested_window() {
        let requested_start = date("2026-06-02");

        assert_eq!(
            ValuationService::transfer_multiplier_snapshot_start(Some(requested_start)),
            Some(date("2026-06-01"))
        );
        assert_eq!(
            ValuationService::transfer_multiplier_snapshot_start(None),
            None
        );
    }

    #[test]
    fn transfer_multiplier_context_is_needed_only_for_security_transfers_in_range() {
        let cash_transfer =
            transfer_activity(ACTIVITY_TYPE_TRANSFER_IN, None, None, None, Some(dec!(250)));
        let security_transfer = transfer_activity(
            ACTIVITY_TYPE_TRANSFER_IN,
            Some("AAPL"),
            Some(dec!(10)),
            Some(dec!(8)),
            None,
        );

        assert!(!ValuationService::has_posted_security_transfer_in_range(
            &[cash_transfer],
            chrono_tz::UTC,
            None,
            None,
        ));
        assert!(ValuationService::has_posted_security_transfer_in_range(
            std::slice::from_ref(&security_transfer),
            chrono_tz::UTC,
            None,
            None,
        ));
        assert!(!ValuationService::has_posted_security_transfer_in_range(
            &[security_transfer],
            chrono_tz::UTC,
            Some(date("2026-06-02")),
            None,
        ));
    }

    #[test]
    fn unclassified_cash_transfer_has_unknown_boundary_flow() {
        let activity =
            transfer_activity(ACTIVITY_TYPE_TRANSFER_IN, None, None, None, Some(dec!(250)));

        let economics = ValuationService::resolve_activity_economics_for_boundary(
            &activity,
            None,
            TransferBoundary::Unknown,
        );

        assert_eq!(economics.lot_cost_basis_value, Decimal::ZERO);
        assert_eq!(economics.performance_flow_value, Decimal::ZERO);
        assert_eq!(
            economics.performance_flow_source,
            ExternalFlowSource::UnknownBoundaryTransfer
        );
        assert!(!economics.diagnostics.is_empty());
    }

    #[test]
    fn unclassified_transfer_has_unknown_boundary_flow() {
        let activity = transfer_activity(
            ACTIVITY_TYPE_TRANSFER_IN,
            Some("AAPL"),
            Some(dec!(10)),
            Some(dec!(8)),
            Some(dec!(250)),
        );

        let economics = ValuationService::resolve_activity_economics_for_boundary(
            &activity,
            None,
            TransferBoundary::Unknown,
        );

        assert_eq!(economics.lot_cost_basis_value, dec!(80));
        assert_eq!(economics.performance_flow_value, dec!(80));
        assert_eq!(
            economics.performance_flow_source,
            ExternalFlowSource::UnknownBoundaryTransfer
        );
        assert!(!economics.diagnostics.is_empty());
    }

    #[test]
    fn unclassified_transfer_out_without_quote_keeps_unknown_boundary_source_for_lot_feedback() {
        let activity = transfer_activity(
            ACTIVITY_TYPE_TRANSFER_OUT,
            Some("AAPL"),
            Some(dec!(10)),
            None,
            None,
        );

        let economics = ValuationService::resolve_activity_economics_for_boundary(
            &activity,
            None,
            TransferBoundary::Unknown,
        );

        assert_eq!(economics.lot_cost_basis_value, Decimal::ZERO);
        assert_eq!(economics.performance_flow_value, Decimal::ZERO);
        assert_eq!(
            economics.performance_flow_source,
            ExternalFlowSource::UnknownBoundaryTransfer
        );
        assert!(!economics.diagnostics.is_empty());
    }

    #[test]
    fn removed_lot_basis_fallback_uses_explicit_removed_basis_not_net_delta() {
        let start_date = NaiveDate::parse_from_str("2026-06-01", "%Y-%m-%d").unwrap();
        let flow_date = NaiveDate::parse_from_str("2026-06-02", "%Y-%m-%d").unwrap();
        let mut values = vec![
            valuation(
                "account-1",
                &start_date.to_string(),
                dec!(1000),
                dec!(1000),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            valuation(
                "account-1",
                &flow_date.to_string(),
                dec!(600),
                dec!(600),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
        ];
        let mut flows_by_date = HashMap::new();
        flows_by_date.insert(
            flow_date,
            DailyFlowAmounts {
                inflow: Decimal::ZERO,
                outflow: dec!(250),
                source: ExternalFlowSource::RemovedLotBasisFallback,
            },
        );

        ValuationService::set_external_flows_from_activity_map_or_net_contribution_base(
            &mut values,
            &flows_by_date,
        );

        assert_eq!(values[1].external_inflow_base, Decimal::ZERO);
        assert_eq!(values[1].external_outflow_base, dec!(250));
        assert_eq!(
            values[1].external_flow_source,
            ExternalFlowSource::RemovedLotBasisFallback
        );
    }

    #[test]
    fn boundary_external_flow_survives_after_since_date_anchor_is_removed() {
        let anchor_date = date("2025-03-01");
        let flow_date = date("2025-03-02");
        let mut values = vec![
            valuation(
                "account-1",
                &anchor_date.to_string(),
                dec!(49840.28),
                dec!(36246.26),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            valuation(
                "account-1",
                &flow_date.to_string(),
                dec!(81805.52),
                dec!(68214.49),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
        ];
        let mut flows_by_date = HashMap::new();
        flows_by_date.insert(
            flow_date,
            DailyFlowAmounts {
                inflow: dec!(31968.23),
                outflow: Decimal::ZERO,
                source: ExternalFlowSource::QuoteDerivedMarketValue,
            },
        );

        ValuationService::set_external_flows_from_activity_map_or_net_contribution_base(
            &mut values,
            &flows_by_date,
        );
        values.retain(|valuation| valuation.valuation_date != anchor_date);

        assert_eq!(values.len(), 1);
        assert_eq!(values[0].valuation_date, flow_date);
        assert_eq!(values[0].external_inflow_base, dec!(31968.23));
        assert_eq!(values[0].external_outflow_base, Decimal::ZERO);
        assert_eq!(
            values[0].external_flow_source,
            ExternalFlowSource::QuoteDerivedMarketValue
        );
    }

    #[test]
    fn removed_lot_basis_fallback_survives_same_day_explicit_cash_flow() {
        let start_date = NaiveDate::parse_from_str("2026-06-01", "%Y-%m-%d").unwrap();
        let flow_date = NaiveDate::parse_from_str("2026-06-02", "%Y-%m-%d").unwrap();
        let mut values = vec![
            valuation(
                "account-1",
                &start_date.to_string(),
                dec!(1000),
                dec!(1000),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            valuation(
                "account-1",
                &flow_date.to_string(),
                dec!(700),
                dec!(700),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
        ];
        let mut flows_by_date = HashMap::new();
        flows_by_date.insert(
            flow_date,
            DailyFlowAmounts {
                inflow: dec!(100),
                outflow: Decimal::ZERO,
                source: ExternalFlowSource::RemovedLotBasisFallback,
            },
        );

        ValuationService::set_external_flows_from_activity_map_or_net_contribution_base(
            &mut values,
            &flows_by_date,
        );

        assert_eq!(values[1].external_inflow_base, dec!(100));
        assert_eq!(values[1].external_outflow_base, Decimal::ZERO);
        assert_eq!(
            values[1].external_flow_source,
            ExternalFlowSource::RemovedLotBasisFallback
        );
    }

    #[test]
    fn quote_gating_ignores_alternative_positions() {
        let market_position = Position {
            quantity: dec!(1),
            is_alternative: false,
            ..Position::default()
        };
        let alternative_position = Position {
            quantity: dec!(1),
            is_alternative: true,
            ..Position::default()
        };

        assert!(ValuationService::position_requires_price_quote(
            &market_position
        ));
        assert!(ValuationService::position_counts_for_quote_gating(
            &market_position
        ));
        assert!(!ValuationService::position_requires_price_quote(
            &alternative_position
        ));
        assert!(!ValuationService::position_counts_for_quote_gating(
            &alternative_position
        ));
    }

    #[test]
    fn scoped_aggregation_sums_base_values_and_preserves_child_gross_flows() {
        let histories = vec![
            vec![
                valuation(
                    "a1",
                    "2026-05-01",
                    dec!(100),
                    dec!(100),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
                valuation(
                    "a1",
                    "2026-05-02",
                    dec!(50),
                    dec!(50),
                    Decimal::ZERO,
                    dec!(50),
                ),
                valuation(
                    "a1",
                    "2026-05-03",
                    dec!(50),
                    dec!(50),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
            ],
            vec![
                valuation(
                    "a2",
                    "2026-05-01",
                    Decimal::ZERO,
                    Decimal::ZERO,
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
                valuation(
                    "a2",
                    "2026-05-02",
                    dec!(50),
                    dec!(50),
                    dec!(50),
                    Decimal::ZERO,
                ),
                valuation(
                    "a2",
                    "2026-05-03",
                    dec!(70),
                    dec!(70),
                    dec!(20),
                    Decimal::ZERO,
                ),
            ],
        ];

        let account_ids = vec!["a1".to_string(), "a2".to_string()];
        let aggregate = ValuationService::aggregate_scoped_valuations(
            "accounts:test",
            &account_ids,
            "USD",
            histories,
            None,
            None,
        )
        .expect("complete scoped histories should aggregate");

        assert_eq!(aggregate.len(), 3);
        assert_eq!(aggregate[0].account_id, "accounts:test");
        assert_eq!(aggregate[0].account_currency, "USD");
        assert_eq!(aggregate[0].total_value, dec!(100));
        assert_eq!(aggregate[0].total_value_base, dec!(100));
        assert_eq!(aggregate[1].net_contribution_base, dec!(100));
        assert_eq!(aggregate[1].external_inflow_base, dec!(50));
        assert_eq!(aggregate[1].external_outflow_base, dec!(50));
        assert_eq!(aggregate[2].net_contribution_base, dec!(120));
        assert_eq!(aggregate[2].external_inflow_base, dec!(20));
        assert_eq!(aggregate[2].external_outflow_base, Decimal::ZERO);
    }

    #[test]
    fn scoped_aggregation_counts_late_start_explicit_zero_row_as_inflow() {
        let mut late_start_valuation = valuation(
            "a2",
            "2026-05-10",
            dec!(10000),
            dec!(10000),
            Decimal::ZERO,
            Decimal::ZERO,
        );
        late_start_valuation.external_flow_source = ExternalFlowSource::ActivityDerived;

        let histories = vec![
            vec![
                valuation(
                    "a1",
                    "2026-05-01",
                    dec!(100),
                    dec!(100),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
                valuation(
                    "a1",
                    "2026-05-10",
                    dec!(110),
                    dec!(100),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
            ],
            vec![late_start_valuation],
        ];
        let account_ids = vec!["a1".to_string(), "a2".to_string()];

        let aggregate = ValuationService::aggregate_scoped_valuations(
            "accounts:test",
            &account_ids,
            "USD",
            histories,
            None,
            None,
        )
        .expect("late-start account should aggregate");

        assert_eq!(aggregate[1].valuation_date.to_string(), "2026-05-10");
        assert_eq!(aggregate[1].net_contribution_base, dec!(10100));
        assert_eq!(aggregate[1].external_inflow_base, dec!(10000));
        assert_eq!(aggregate[1].external_outflow_base, Decimal::ZERO);
        assert_eq!(
            aggregate[1].external_flow_source,
            ExternalFlowSource::NetContributionFallback
        );
    }

    #[test]
    fn scoped_aggregation_removes_both_sides_of_internal_transfer_flows() {
        let histories = vec![
            vec![
                valuation(
                    "a1",
                    "2026-05-01",
                    dec!(100),
                    dec!(100),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
                valuation(
                    "a1",
                    "2026-05-02",
                    Decimal::ZERO,
                    Decimal::ZERO,
                    Decimal::ZERO,
                    dec!(100),
                ),
            ],
            vec![
                valuation(
                    "a2",
                    "2026-05-01",
                    Decimal::ZERO,
                    Decimal::ZERO,
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
                valuation(
                    "a2",
                    "2026-05-02",
                    dec!(98),
                    dec!(98),
                    dec!(98),
                    Decimal::ZERO,
                ),
            ],
        ];
        let account_ids = vec!["a1".to_string(), "a2".to_string()];
        let flow_date = NaiveDate::parse_from_str("2026-05-02", "%Y-%m-%d").unwrap();
        let mut internal_transfer_adjustments = HashMap::new();
        internal_transfer_adjustments.insert(flow_date, (dec!(98), dec!(100)));

        let aggregate = ValuationService::aggregate_scoped_valuations(
            "accounts:test",
            &account_ids,
            "USD",
            histories,
            None,
            Some(&internal_transfer_adjustments),
        )
        .expect("complete scoped histories should aggregate");

        assert_eq!(aggregate[1].external_inflow_base, Decimal::ZERO);
        assert_eq!(aggregate[1].external_outflow_base, Decimal::ZERO);
        assert_eq!(aggregate[1].external_flow_source, ExternalFlowSource::Mixed);
    }

    #[test]
    fn scoped_aggregation_preserves_unknown_boundary_transfer_source() {
        let mut unknown_transfer_day = valuation(
            "a1",
            "2026-05-02",
            dec!(120),
            dec!(100),
            dec!(25),
            Decimal::ZERO,
        );
        unknown_transfer_day.external_flow_source = ExternalFlowSource::UnknownBoundaryTransfer;

        let mut cash_flow_day = valuation(
            "a2",
            "2026-05-02",
            dec!(210),
            dec!(200),
            dec!(10),
            Decimal::ZERO,
        );
        cash_flow_day.external_flow_source = ExternalFlowSource::CashAmount;

        let histories = vec![
            vec![
                valuation(
                    "a1",
                    "2026-05-01",
                    dec!(100),
                    dec!(100),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
                unknown_transfer_day,
            ],
            vec![
                valuation(
                    "a2",
                    "2026-05-01",
                    dec!(200),
                    dec!(200),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
                cash_flow_day,
            ],
        ];
        let account_ids = vec!["a1".to_string(), "a2".to_string()];

        let aggregate = ValuationService::aggregate_scoped_valuations(
            "accounts:test",
            &account_ids,
            "USD",
            histories,
            None,
            None,
        )
        .expect("complete scoped histories should aggregate");

        assert_eq!(aggregate[1].external_inflow_base, dec!(35));
        assert_eq!(aggregate[1].external_outflow_base, Decimal::ZERO);
        assert_eq!(
            aggregate[1].external_flow_source,
            ExternalFlowSource::UnknownBoundaryTransfer
        );
    }

    #[test]
    fn scoped_aggregation_preserves_removed_lot_basis_fallback_source() {
        let mut removed_lot_flow_day = valuation(
            "a1",
            "2026-05-02",
            dec!(80),
            dec!(100),
            Decimal::ZERO,
            dec!(20),
        );
        removed_lot_flow_day.external_flow_source = ExternalFlowSource::RemovedLotBasisFallback;

        let mut cash_flow_day = valuation(
            "a2",
            "2026-05-02",
            dec!(210),
            dec!(200),
            dec!(10),
            Decimal::ZERO,
        );
        cash_flow_day.external_flow_source = ExternalFlowSource::CashAmount;

        let histories = vec![
            vec![
                valuation(
                    "a1",
                    "2026-05-01",
                    dec!(100),
                    dec!(100),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
                removed_lot_flow_day,
            ],
            vec![
                valuation(
                    "a2",
                    "2026-05-01",
                    dec!(200),
                    dec!(200),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
                cash_flow_day,
            ],
        ];
        let account_ids = vec!["a1".to_string(), "a2".to_string()];

        let aggregate = ValuationService::aggregate_scoped_valuations(
            "accounts:test",
            &account_ids,
            "USD",
            histories,
            None,
            None,
        )
        .expect("complete scoped histories should aggregate");

        assert_eq!(aggregate[1].external_inflow_base, dec!(10));
        assert_eq!(aggregate[1].external_outflow_base, dec!(20));
        assert_eq!(
            aggregate[1].external_flow_source,
            ExternalFlowSource::RemovedLotBasisFallback
        );
    }

    #[test]
    fn scoped_aggregation_keeps_activity_external_flow_when_internal_transfer_same_day() {
        let histories = vec![
            vec![
                valuation(
                    "a1",
                    "2026-05-01",
                    dec!(100),
                    dec!(100),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
                valuation(
                    "a1",
                    "2026-05-02",
                    Decimal::ZERO,
                    Decimal::ZERO,
                    Decimal::ZERO,
                    dec!(100),
                ),
            ],
            vec![
                valuation(
                    "a2",
                    "2026-05-01",
                    Decimal::ZERO,
                    Decimal::ZERO,
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
                valuation(
                    "a2",
                    "2026-05-02",
                    dec!(150),
                    dec!(150),
                    dec!(150),
                    Decimal::ZERO,
                ),
            ],
        ];
        let account_ids = vec!["a1".to_string(), "a2".to_string()];
        let flow_date = NaiveDate::parse_from_str("2026-05-02", "%Y-%m-%d").unwrap();
        let mut flows_by_date = HashMap::new();
        flows_by_date.insert(
            flow_date,
            DailyFlowAmounts {
                inflow: dec!(50),
                outflow: Decimal::ZERO,
                source: ExternalFlowSource::CashAmount,
            },
        );
        let mut internal_transfer_adjustments = HashMap::new();
        internal_transfer_adjustments.insert(flow_date, (dec!(100), dec!(100)));

        let aggregate = ValuationService::aggregate_scoped_valuations(
            "accounts:test",
            &account_ids,
            "USD",
            histories,
            Some(&flows_by_date),
            Some(&internal_transfer_adjustments),
        )
        .expect("complete scoped histories should aggregate");

        assert_eq!(aggregate[1].net_contribution_base, dec!(150));
        assert_eq!(aggregate[1].external_inflow_base, dec!(50));
        assert_eq!(aggregate[1].external_outflow_base, Decimal::ZERO);
        assert_eq!(
            aggregate[1].external_flow_source,
            ExternalFlowSource::CashAmount
        );
    }

    #[test]
    fn scoped_aggregation_uses_activity_external_flows_when_available() {
        let histories = vec![
            vec![
                valuation(
                    "a1",
                    "2026-05-01",
                    dec!(100),
                    dec!(100),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
                valuation(
                    "a1",
                    "2026-05-02",
                    Decimal::ZERO,
                    Decimal::ZERO,
                    Decimal::ZERO,
                    dec!(100),
                ),
            ],
            vec![
                valuation(
                    "a2",
                    "2026-05-01",
                    Decimal::ZERO,
                    Decimal::ZERO,
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
                valuation(
                    "a2",
                    "2026-05-02",
                    dec!(100),
                    dec!(100),
                    dec!(100),
                    Decimal::ZERO,
                ),
            ],
        ];
        let account_ids = vec!["a1".to_string(), "a2".to_string()];
        let flow_date = NaiveDate::parse_from_str("2026-05-02", "%Y-%m-%d").unwrap();
        let mut flows_by_date = HashMap::new();
        flows_by_date.insert(
            flow_date,
            DailyFlowAmounts {
                inflow: dec!(100),
                outflow: dec!(100),
                source: ExternalFlowSource::CashAmount,
            },
        );

        let aggregate = ValuationService::aggregate_scoped_valuations(
            "accounts:test",
            &account_ids,
            "USD",
            histories,
            Some(&flows_by_date),
            None,
        )
        .expect("complete scoped histories should aggregate");

        assert_eq!(aggregate[1].net_contribution_base, dec!(100));
        assert_eq!(aggregate[1].external_inflow_base, dec!(100));
        assert_eq!(aggregate[1].external_outflow_base, dec!(100));
        assert_eq!(
            aggregate[1].external_flow_source,
            ExternalFlowSource::CashAmount
        );
    }

    #[test]
    fn net_contribution_fallback_marks_source_even_for_zero_net_flow() {
        let mut values = vec![
            valuation(
                "a1",
                "2026-05-01",
                dec!(100),
                dec!(100),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            valuation(
                "a1",
                "2026-05-02",
                dec!(110),
                dec!(100),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
        ];

        ValuationService::set_external_flows_from_net_contribution_base(&mut values);

        assert_eq!(values[1].external_inflow_base, Decimal::ZERO);
        assert_eq!(values[1].external_outflow_base, Decimal::ZERO);
        assert_eq!(
            values[1].external_flow_source,
            ExternalFlowSource::NetContributionFallback
        );
    }

    #[test]
    fn activity_flow_map_marks_absent_zero_flow_days_as_no_flow() {
        let mut values = vec![
            valuation(
                "a1",
                "2026-05-01",
                dec!(100),
                dec!(100),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            valuation(
                "a1",
                "2026-05-02",
                dec!(110),
                dec!(100),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
        ];
        let flows_by_date = HashMap::new();

        ValuationService::set_external_flows_from_activity_map_or_net_contribution_base(
            &mut values,
            &flows_by_date,
        );

        assert_eq!(values[1].external_inflow_base, Decimal::ZERO);
        assert_eq!(values[1].external_outflow_base, Decimal::ZERO);
        assert_eq!(values[0].external_flow_source, ExternalFlowSource::NoFlow);
        assert_eq!(values[1].external_flow_source, ExternalFlowSource::NoFlow);
    }

    #[test]
    fn scoped_aggregation_does_not_add_residual_snapshot_flow_on_activity_flow_date() {
        let histories = vec![
            vec![
                valuation(
                    "transactions",
                    "2026-05-01",
                    dec!(100),
                    Decimal::ZERO,
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
                valuation(
                    "transactions",
                    "2026-05-02",
                    dec!(200),
                    dec!(100),
                    dec!(100),
                    Decimal::ZERO,
                ),
            ],
            vec![
                valuation(
                    "holdings",
                    "2026-05-01",
                    dec!(1000),
                    dec!(1000),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
                valuation(
                    "holdings",
                    "2026-05-02",
                    dec!(1100),
                    dec!(1100),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
            ],
        ];
        let account_ids = vec!["transactions".to_string(), "holdings".to_string()];
        let flow_date = NaiveDate::parse_from_str("2026-05-02", "%Y-%m-%d").unwrap();
        let mut flows_by_date = HashMap::new();
        flows_by_date.insert(
            flow_date,
            DailyFlowAmounts {
                inflow: dec!(100),
                outflow: Decimal::ZERO,
                source: ExternalFlowSource::CashAmount,
            },
        );

        let aggregate = ValuationService::aggregate_scoped_valuations(
            "accounts:mixed",
            &account_ids,
            "USD",
            histories,
            Some(&flows_by_date),
            None,
        )
        .expect("mixed scoped histories should aggregate");

        assert_eq!(aggregate[1].net_contribution_base, dec!(1200));
        assert_eq!(aggregate[1].external_inflow_base, dec!(100));
        assert_eq!(aggregate[1].external_outflow_base, Decimal::ZERO);
    }

    #[test]
    fn scoped_aggregation_rejects_interior_account_history_gaps() {
        let histories = vec![
            vec![
                valuation(
                    "a1",
                    "2026-05-01",
                    dec!(100),
                    dec!(100),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
                valuation(
                    "a1",
                    "2026-05-03",
                    dec!(120),
                    dec!(100),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
            ],
            vec![
                valuation(
                    "a2",
                    "2026-05-01",
                    dec!(50),
                    dec!(50),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
                valuation(
                    "a2",
                    "2026-05-02",
                    dec!(55),
                    dec!(50),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
                valuation(
                    "a2",
                    "2026-05-03",
                    dec!(60),
                    dec!(50),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
            ],
        ];
        let account_ids = vec!["a1".to_string(), "a2".to_string()];

        let err = ValuationService::aggregate_scoped_valuations(
            "accounts:test",
            &account_ids,
            "USD",
            histories,
            None,
            None,
        )
        .expect_err("missing account valuation date should be rejected");

        assert!(err
            .to_string()
            .contains("Incomplete scoped valuation history for account 'a1'"));
        assert!(err.to_string().contains("2026-05-02"));
    }

    #[test]
    fn scoped_aggregation_rejects_stale_nonzero_account_tail() {
        let histories = vec![
            vec![
                valuation(
                    "a1",
                    "2026-05-01",
                    dec!(100),
                    dec!(100),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
                valuation(
                    "a1",
                    "2026-05-02",
                    dec!(100),
                    dec!(100),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
            ],
            vec![
                valuation(
                    "a2",
                    "2026-05-01",
                    dec!(50),
                    dec!(50),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
                valuation(
                    "a2",
                    "2026-05-02",
                    dec!(55),
                    dec!(50),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
                valuation(
                    "a2",
                    "2026-05-03",
                    dec!(60),
                    dec!(50),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
            ],
        ];
        let account_ids = vec!["a1".to_string(), "a2".to_string()];

        let err = ValuationService::aggregate_scoped_valuations(
            "accounts:test",
            &account_ids,
            "USD",
            histories,
            None,
            None,
        )
        .expect_err("stale nonzero account tail should be rejected");

        assert!(err.to_string().contains("latest valuation is 2026-05-02"));
    }

    #[test]
    fn incremental_anchor_preserves_next_day_external_flow_delta() {
        let anchor_date = NaiveDate::parse_from_str("2026-05-01", "%Y-%m-%d").unwrap();
        let mut values = vec![
            valuation(
                "a1",
                "2026-05-01",
                dec!(100),
                dec!(100),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            valuation(
                "a1",
                "2026-05-02",
                dec!(150),
                dec!(125),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
        ];

        ValuationService::set_external_flows_from_net_contribution_base(&mut values);
        values.retain(|valuation| valuation.valuation_date != anchor_date);

        assert_eq!(values.len(), 1);
        assert_eq!(values[0].valuation_date.to_string(), "2026-05-02");
        assert_eq!(values[0].external_inflow_base, dec!(25));
        assert_eq!(values[0].external_outflow_base, Decimal::ZERO);
    }
}
