use crate::activities::{
    Activity, ActivityRepositoryTrait, TransferPairResolution, ACTIVITY_TYPE_TRANSFER_IN,
    ACTIVITY_TYPE_TRANSFER_OUT, ACTIVITY_TYPE_WITHDRAWAL,
};
use crate::errors::{CalculatorError, Error as CoreError, Result as CoreResult, ValidationError};
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
use crate::portfolio::recalculation_gate::{
    PortfolioRecalculationGate, PortfolioRecalculationPermit,
};
use crate::portfolio::snapshot::{
    min_supported_snapshot_date, validate_snapshot_read_date, HoldingsTimeline, Position,
    SnapshotServiceTrait, SnapshotSource,
};
use crate::portfolio::valuation::valuation_calculator::calculate_valuation_with_price_factors;
use crate::portfolio::valuation::valuation_model::{
    DailyAccountValuation, ExternalFlowSource, NegativeBalanceInfo, ValuationStatus,
};
use crate::portfolio::valuation::ValuationRepositoryTrait;
use crate::quotes::{Quote, QuoteServiceTrait};
use crate::utils::time_utils;
use async_trait::async_trait;
use chrono::{DateTime, Duration, NaiveDate, Utc};
use futures::stream::{self, StreamExt};
use log::{debug, warn};
use rust_decimal::Decimal;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock, Weak};

use super::DailyFxRateMap;

static VALUATION_SERVICE_INSTANCE_COUNTER: AtomicU64 = AtomicU64::new(1);
const SCOPED_HISTORY_CACHE_LIMIT_PER_MODE: usize = 2;
const SCOPED_HISTORY_IN_FLIGHT_LIMIT: usize = SCOPED_HISTORY_CACHE_LIMIT_PER_MODE * 2;

#[derive(Clone)]
struct PreparedValuationAccount {
    account_id: String,
    timeline: HoldingsTimeline,
    incremental_anchor_date: Option<NaiveDate>,
    replace_since_date: Option<Option<NaiveDate>>,
    required_asset_ids: HashSet<String>,
    required_fx_pairs: HashSet<(String, String)>,
    acquisition_fx_requests: HashSet<(String, String, NaiveDate)>,
    base_currency: String,
    account_currency: String,
}

#[derive(Clone, Default)]
struct SharedValuationFacts {
    quotes_by_asset: HashMap<String, Vec<ValuationQuoteFact>>,
    assets_with_quotes: HashSet<String>,
    split_events: Vec<QuoteAdjustedSplitEvent>,
    fx_rates_by_pair: BTreeMap<(String, String), BTreeMap<NaiveDate, Option<Decimal>>>,
}

impl SharedValuationFacts {
    fn fx_rates_for_date(
        &self,
        pairs: &HashSet<(String, String)>,
        date: NaiveDate,
    ) -> DailyFxRateMap {
        let mut ordered_pairs: Vec<_> = pairs.iter().collect();
        ordered_pairs.sort();
        ordered_pairs
            .into_iter()
            .filter_map(|pair| {
                self.fx_rates_by_pair
                    .get(pair)
                    .and_then(|series| series.get(&date))
                    .copied()
                    .flatten()
                    .map(|rate| (pair.clone(), rate))
            })
            .collect()
    }

    fn acquisition_fx_rates_by_date(
        &self,
        requests: &HashSet<(String, String, NaiveDate)>,
    ) -> HashMap<NaiveDate, DailyFxRateMap> {
        let mut ordered_requests: Vec<_> = requests.iter().collect();
        ordered_requests.sort();
        let mut rates_by_date: HashMap<NaiveDate, DailyFxRateMap> = HashMap::new();
        for (from, to, date) in ordered_requests {
            let pair = (from.clone(), to.clone());
            if let Some(rate) = self
                .fx_rates_by_pair
                .get(&pair)
                .and_then(|series| series.get(date))
                .copied()
                .flatten()
            {
                rates_by_date.entry(*date).or_default().insert(pair, rate);
            }
        }
        rates_by_date
    }
}

#[derive(Clone)]
struct ValuationQuoteFact {
    timestamp: DateTime<Utc>,
    close: Decimal,
    currency: String,
}

impl ValuationQuoteFact {
    fn to_quote(&self, asset_id: &str) -> Quote {
        Quote {
            asset_id: asset_id.to_string(),
            timestamp: self.timestamp,
            close: self.close,
            currency: self.currency.clone(),
            ..Quote::default()
        }
    }
}

enum ValuationPersistence {
    Noop,
    Replace(Option<NaiveDate>),
    Append,
}

struct AccountValuationCalculation {
    account_id: String,
    valuations: Vec<DailyAccountValuation>,
    persistence: ValuationPersistence,
}

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

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValuationAccountFailure {
    pub account_id: String,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<NaiveDate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_date: Option<NaiveDate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_date: Option<NaiveDate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_source: Option<String>,
}

impl ValuationAccountFailure {
    fn from_error(account_id: &str, error: &CoreError) -> Self {
        match error {
            CoreError::Validation(ValidationError::InvalidSnapshotDate {
                date,
                min_date,
                max_date,
                snapshot_source,
                ..
            }) => Self {
                account_id: account_id.to_string(),
                code: "INVALID_SNAPSHOT_DATE".to_string(),
                message: error.to_string(),
                date: Some(*date),
                min_date: Some(*min_date),
                max_date: Some(*max_date),
                snapshot_source: Some(snapshot_source.clone()),
            },
            _ => Self {
                account_id: account_id.to_string(),
                code: "VALUATION_CALCULATION_FAILED".to_string(),
                message: error.to_string(),
                date: None,
                min_date: None,
                max_date: None,
                snapshot_source: None,
            },
        }
    }

    fn from_fact_loading_error(account_id: &str, error: &CoreError) -> Self {
        Self {
            account_id: account_id.to_string(),
            code: "VALUATION_FACT_LOADING_FAILED".to_string(),
            message: error.to_string(),
            date: None,
            min_date: None,
            max_date: None,
            snapshot_source: None,
        }
    }
}

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValuationBatchOutcome {
    pub successful_accounts: Vec<String>,
    pub failures: Vec<ValuationAccountFailure>,
}

struct ValuationBatchExecution {
    outcome: ValuationBatchOutcome,
    account_errors: HashMap<String, CoreError>,
    global_error: Option<CoreError>,
}

#[async_trait]
pub trait ValuationServiceTrait: Send + Sync {
    async fn calculate_valuation_histories(
        &self,
        account_ids: &[String],
        mode: ValuationRecalcMode,
    ) -> CoreResult<ValuationBatchOutcome> {
        let mut outcome = ValuationBatchOutcome::default();
        for account_id in account_ids {
            match self
                .calculate_valuation_history(account_id, mode.clone())
                .await
            {
                Ok(()) => outcome.successful_accounts.push(account_id.clone()),
                Err(error) => outcome
                    .failures
                    .push(ValuationAccountFailure::from_error(account_id, &error)),
            }
        }
        Ok(outcome)
    }

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

    #[cfg(test)]
    async fn calculate_valuation_history_dense_reference(
        &self,
        account_id: &str,
        mode: ValuationRecalcMode,
    ) -> CoreResult<()> {
        self.calculate_valuation_history(account_id, mode).await
    }

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
    let start_date = date
        .checked_sub_signed(Duration::days(1))
        .filter(|candidate| *candidate >= min_supported_snapshot_date())
        .unwrap_or(date);
    let anchor_date = if start_date < date {
        Some(start_date)
    } else {
        None
    };

    (start_date, anchor_date)
}

fn latest_valuation_requires_full_rebuild(last_saved: NaiveDate, today: NaiveDate) -> bool {
    last_saved > today
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
    scoped_history_in_flight: Arc<Mutex<HashMap<ScopedValuationCacheKey, Weak<Mutex<()>>>>>,
    service_instance_id: u64,
    recalculation_gate: Option<Arc<PortfolioRecalculationGate>>,
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
struct TransferMarketFacts {
    quotes_by_request: HashMap<(String, NaiveDate), Quote>,
    multipliers_by_asset_id: HashMap<String, Decimal>,
}

impl TransferMarketFacts {
    fn multiplier_for(&self, activity: &Activity) -> Decimal {
        activity
            .asset_id
            .as_ref()
            .and_then(|asset_id| self.multipliers_by_asset_id.get(asset_id))
            .copied()
            .unwrap_or(Decimal::ONE)
    }
}

struct ScopedFlowInputs {
    scope_account_ids: HashSet<String>,
    timezone: chrono_tz::Tz,
    merged_activities: Vec<Activity>,
    external_transfer_resolution: TransferPairResolution,
    internal_transfer_resolution: TransferPairResolution,
    market_facts: TransferMarketFacts,
    removed_lot_basis_by_activity: HashMap<String, Decimal>,
}

struct ScopedFlowMaps {
    external_flows_by_date: HashMap<NaiveDate, DailyFlowAmounts>,
    internal_adjustments_by_date: HashMap<NaiveDate, (Decimal, Decimal)>,
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
            scoped_history_in_flight: Arc::new(Mutex::new(HashMap::new())),
            service_instance_id: VALUATION_SERVICE_INSTANCE_COUNTER.fetch_add(1, Ordering::Relaxed),
            recalculation_gate: None,
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

    pub fn with_recalculation_gate(
        mut self,
        recalculation_gate: Arc<PortfolioRecalculationGate>,
    ) -> Self {
        self.recalculation_gate = Some(recalculation_gate);
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

    fn scoped_history_cache_get(
        &self,
        cache_key: &ScopedValuationCacheKey,
    ) -> Option<Vec<DailyAccountValuation>> {
        self.scoped_history_cache
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(cache_key)
            .cloned()
    }

    fn acquire_scoped_history_in_flight(
        &self,
        cache_key: &ScopedValuationCacheKey,
    ) -> Option<Arc<Mutex<()>>> {
        let mut registry = self
            .scoped_history_in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        registry.retain(|_, in_flight| in_flight.strong_count() > 0);

        if let Some(in_flight) = registry.get(cache_key).and_then(Weak::upgrade) {
            return Some(in_flight);
        }
        if registry.len() >= SCOPED_HISTORY_IN_FLIGHT_LIMIT {
            return None;
        }

        let in_flight = Arc::new(Mutex::new(()));
        registry.insert(cache_key.clone(), Arc::downgrade(&in_flight));
        Some(in_flight)
    }

    fn release_scoped_history_in_flight(
        &self,
        cache_key: &ScopedValuationCacheKey,
        in_flight: &Arc<Mutex<()>>,
    ) {
        let mut registry = self
            .scoped_history_in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let is_same_entry = registry
            .get(cache_key)
            .and_then(Weak::upgrade)
            .is_some_and(|registered| Arc::ptr_eq(&registered, in_flight));
        if is_same_entry && Arc::strong_count(in_flight) == 1 {
            registry.remove(cache_key);
        }
    }

    fn with_scoped_history_single_flight<F>(
        &self,
        cache_key: ScopedValuationCacheKey,
        calculate: F,
    ) -> CoreResult<Vec<DailyAccountValuation>>
    where
        F: FnOnce() -> CoreResult<Vec<DailyAccountValuation>>,
    {
        if let Some(cached) = self.scoped_history_cache_get(&cache_key) {
            return Ok(cached);
        }

        let Some(in_flight) = self.acquire_scoped_history_in_flight(&cache_key) else {
            // All registered keys are active. Bypass coalescing instead of evicting
            // a live mutex and allowing duplicate work for its existing waiters.
            return calculate();
        };

        // These synchronous waiters occupy blocking-pool threads. All production
        // entry points invoke scoped performance work through spawn_blocking.
        let guard = in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let result = match self.scoped_history_cache_get(&cache_key) {
            Some(cached) => Ok(cached),
            None => calculate(),
        };
        drop(guard);
        self.release_scoped_history_in_flight(&cache_key, &in_flight);
        result
    }

    fn position_requires_price_quote(position: &Position) -> bool {
        !position.is_alternative
    }

    fn position_counts_for_quote_gating(position: &Position) -> bool {
        Self::position_requires_price_quote(position) && !position.quantity.is_zero()
    }

    fn load_fx_rate(
        &self,
        facts: &mut SharedValuationFacts,
        from_curr: &str,
        to_curr: &str,
        date: NaiveDate,
    ) {
        let pair = (from_curr.to_string(), to_curr.to_string());
        if facts
            .fx_rates_by_pair
            .get(&pair)
            .is_some_and(|series| series.contains_key(&date))
        {
            return;
        }

        let rate = match self
            .fx_service
            .get_exchange_rate_for_date(from_curr, to_curr, date)
        {
            Ok(rate) => Some(rate),
            Err(error) => {
                warn!(
                    "Failed to get FX rate {}->{} for date {}: {}. Valuation for this date might be affected.",
                    from_curr, to_curr, date, error
                );
                None
            }
        };
        facts
            .fx_rates_by_pair
            .entry(pair)
            .or_default()
            .insert(date, rate);
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
                    true,
                );
            }
            None => Self::set_external_flows_from_net_contribution_base(&mut values, true),
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

    /// HOLDINGS-mode keyframes record positions and cash but no cash flows, so
    /// a deposit, withdrawal, or trade between two snapshots is otherwise
    /// indistinguishable from market movement. Infer the external flow at each
    /// keyframe transition by pricing BOTH keyframes at the transition day's
    /// quotes: flow = V(new, day) - V(old, day). Position changes then enter
    /// and exit at market value (a sale's accrued gain stays in the period)
    /// while cash deltas count as flows. Only manual-family keyframes
    /// participate; Calculated keyframes get their flows from activities.
    fn apply_inferred_holdings_external_flows(
        valuations: &mut [DailyAccountValuation],
        account: &PreparedValuationAccount,
        facts: &SharedValuationFacts,
    ) {
        if valuations.len() < 2 {
            return;
        }
        valuations.sort_by_key(|valuation| valuation.valuation_date);
        let acquisition_fx_rates_by_date =
            facts.acquisition_fx_rates_by_date(&account.acquisition_fx_requests);
        let mut quote_assets: Vec<_> = account.required_asset_ids.iter().cloned().collect();
        quote_assets.sort();
        for index in 1..valuations.len() {
            let prev_date = valuations[index - 1].valuation_date;
            let curr_date = valuations[index].valuation_date;
            let Some(prev_keyframe) = account.timeline.snapshot_at(prev_date) else {
                continue;
            };
            let Some(curr_keyframe) = account.timeline.snapshot_at(curr_date) else {
                continue;
            };
            if prev_keyframe.snapshot_date == curr_keyframe.snapshot_date
                || prev_keyframe.source == SnapshotSource::Calculated
                || curr_keyframe.source == SnapshotSource::Calculated
            {
                continue;
            }
            let quotes_today: HashMap<_, _> = quote_assets
                .iter()
                .filter_map(|asset_id| {
                    facts
                        .quotes_by_asset
                        .get(asset_id)
                        .and_then(|quotes| {
                            quotes
                                .iter()
                                .rev()
                                .find(|quote| quote.timestamp.date_naive() <= curr_date)
                        })
                        .map(|quote| (asset_id.clone(), quote.to_quote(asset_id)))
                })
                .collect();
            let fx_today = facts.fx_rates_for_date(&account.required_fx_pairs, curr_date);
            // The old keyframe's quantities are stated as of ITS OWN snapshot
            // date, so bridge every split after that: factors for the keyframe
            // date compose the quantity restatement for splits in
            // (snapshot_date, curr] with the quote un-adjustment for splits
            // after curr. Anchoring on the previous ROW date instead would
            // miss a split that happened before a delayed snapshot and
            // fabricate a flow.
            let split_factors = Self::split_price_factors_for_date(
                prev_keyframe.snapshot_date,
                &facts.split_events,
            );
            let priced_prev = calculate_valuation_with_price_factors(
                prev_keyframe,
                &quotes_today,
                &fx_today,
                &acquisition_fx_rates_by_date,
                curr_date,
                &account.base_currency,
                &split_factors,
            );
            // Inference is only trustworthy when both sides are fully priced:
            // comparing a partially priced valuation would classify an
            // unpriced position's cost as a flow and its later quote arrival
            // as gain. Mark the transition Unknown so period performance is
            // reported as unavailable instead of wrong.
            let prev_at_curr = match priced_prev {
                Ok(prev_at_curr)
                    if prev_at_curr.value_status == ValuationStatus::Complete
                        && valuations[index].value_status == ValuationStatus::Complete =>
                {
                    prev_at_curr
                }
                _ => {
                    valuations[index].external_inflow_base = Decimal::ZERO;
                    valuations[index].external_outflow_base = Decimal::ZERO;
                    valuations[index].external_flow_source =
                        ExternalFlowSource::UnpricedHoldingsTransition;
                    continue;
                }
            };
            let flow_base = valuations[index].total_value_base - prev_at_curr.total_value_base;
            if flow_base.is_zero() {
                continue;
            }
            let (inflow, outflow) = Self::split_external_flow(flow_base);
            valuations[index].external_inflow_base = inflow;
            valuations[index].external_outflow_base = outflow;
            valuations[index].external_flow_source = ExternalFlowSource::QuoteDerivedMarketValue;
        }
    }

    fn set_external_flows_from_net_contribution_base(
        values: &mut [DailyAccountValuation],
        preserve_unavailable: bool,
    ) {
        if values.is_empty() {
            return;
        }

        values.sort_by_key(|valuation| valuation.valuation_date);
        values[0].external_inflow_base = rust_decimal::Decimal::ZERO;
        values[0].external_outflow_base = rust_decimal::Decimal::ZERO;
        values[0].external_flow_source = ExternalFlowSource::NetContributionFallback;

        for index in 1..values.len() {
            // The plain Unknown marker (an unpriceable holdings transition
            // summed into an aggregate row) is sticky: it must keep gating
            // returns, never be relabeled into a trustworthy source.
            // UnknownBoundaryTransfer is NOT sticky — resolving it is the
            // transfer machinery's job.
            if preserve_unavailable
                && values[index].external_flow_source
                    == ExternalFlowSource::UnpricedHoldingsTransition
            {
                continue;
            }
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
        preserve_unavailable: bool,
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
            // The activity map is authoritative: scope-aware flow inputs
            // deliberately resolve Unknown transfer boundaries into valued
            // flows, so it applies before the unavailable-stickiness guard.
            if let Some(flow) = flows_by_date.get(&values[index].valuation_date) {
                values[index].external_inflow_base = flow.inflow;
                values[index].external_outflow_base = flow.outflow;
                values[index].external_flow_source = flow.source;
                continue;
            }
            // The plain Unknown marker is sticky against the fallback paths
            // (see the net-contribution variant): with no authoritative flow
            // for the day, an unpriceable holdings transition summed into an
            // aggregate row must keep gating returns, never be relabeled
            // NoFlow. Holdings-only scopes have no activities, so their
            // markers always take this path; UnknownBoundaryTransfer stays
            // resolvable by the transfer machinery.
            if preserve_unavailable
                && values[index].external_flow_source
                    == ExternalFlowSource::UnpricedHoldingsTransition
            {
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
            // Netting removes scope-internal legs; it does not introduce a
            // differently-valued flow, so the day keeps the provenance of the
            // flows that survive. Stamping a source here would invent one.
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

    fn transfer_market_facts_for_activities(
        &self,
        activities: &[Activity],
        timezone: chrono_tz::Tz,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> CoreResult<TransferMarketFacts> {
        let mut requests = HashSet::new();

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
                requests.insert((asset_id.clone(), activity_date));
            }
        }

        if requests.is_empty() {
            return Ok(TransferMarketFacts::default());
        }

        let mut requests: Vec<(String, NaiveDate)> = requests.into_iter().collect();
        requests.sort();
        let sparse_facts = self
            .quote_service
            .get_sparse_asset_market_facts(&requests)?;

        let mut asset_ids: Vec<String> = requests
            .iter()
            .map(|(asset_id, _)| asset_id.clone())
            .collect();
        asset_ids.dedup();
        let mut multipliers_by_asset_id = HashMap::with_capacity(asset_ids.len());
        for asset_id in asset_ids {
            let multiplier = match sparse_facts.assets_by_id.get(&asset_id) {
                Some(asset) => {
                    let multiplier = asset.contract_multiplier();
                    if multiplier > Decimal::ZERO {
                        multiplier
                    } else {
                        warn!(
                            "Asset '{}' has a non-positive contract multiplier; using 1 for transfer economics.",
                            asset_id
                        );
                        Decimal::ONE
                    }
                }
                None => {
                    warn!(
                        "Asset '{}' was not found while loading transfer economics; using contract multiplier 1.",
                        asset_id
                    );
                    Decimal::ONE
                }
            };
            multipliers_by_asset_id.insert(asset_id, multiplier);
        }

        Ok(TransferMarketFacts {
            quotes_by_request: sparse_facts.quotes_by_request,
            multipliers_by_asset_id,
        })
    }

    fn prepare_scoped_flow_inputs(
        &self,
        account_ids: &[String],
        base_currency: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> CoreResult<Option<ScopedFlowInputs>> {
        let Some(activity_repository) = &self.activity_repository else {
            return Ok(None);
        };

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
        // The two consumers intentionally retain their existing activity populations:
        // external-flow recomputation sees the scoped rows plus touching transfers,
        // while internal correction only resolves the touching-transfer population.
        let internal_transfer_resolution =
            TransferPairResolution::from_activities(&transfer_activities);
        let merged_activities =
            Self::merge_activities_by_id(scoped_activities, transfer_activities);
        let external_transfer_resolution =
            TransferPairResolution::from_activities(&merged_activities);
        let market_facts = self.transfer_market_facts_for_activities(
            &merged_activities,
            timezone,
            start_date_opt,
            end_date_opt,
        )?;
        let removed_lot_basis_by_activity = match Self::disposal_query_bounds_from_activities(
            &merged_activities,
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

        Ok(Some(ScopedFlowInputs {
            scope_account_ids,
            timezone,
            merged_activities,
            external_transfer_resolution,
            internal_transfer_resolution,
            market_facts,
            removed_lot_basis_by_activity,
        }))
    }

    fn external_flows_from_scoped_inputs(
        &self,
        inputs: &ScopedFlowInputs,
        base_currency: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> CoreResult<HashMap<NaiveDate, DailyFlowAmounts>> {
        let mut flows_by_date: HashMap<NaiveDate, DailyFlowAmounts> = HashMap::new();
        for activity in inputs
            .merged_activities
            .iter()
            .filter(|activity| inputs.scope_account_ids.contains(&activity.account_id))
        {
            if !activity.is_posted() {
                continue;
            }
            let activity_date =
                time_utils::activity_date_in_tz(activity.activity_date, inputs.timezone);
            if !Self::activity_date_in_range(activity_date, start_date_opt, end_date_opt) {
                continue;
            }

            let effective_type = activity.effective_type();
            let transfer_boundary = if effective_type == ACTIVITY_TYPE_TRANSFER_IN
                || effective_type == ACTIVITY_TYPE_TRANSFER_OUT
            {
                if let Some(pair) = inputs
                    .external_transfer_resolution
                    .pair_for_activity(&activity.id)
                {
                    classify_transfer_boundary_for_account_scope(
                        activity,
                        &inputs.scope_account_ids,
                        pair.counterparty_account_id(&activity.id),
                    )
                } else {
                    if let Some(group) = inputs
                        .external_transfer_resolution
                        .invalid_group_for_activity(&activity.id)
                    {
                        warn!(
                            "Invalid transfer group {} ({}) includes activity {}; marking scoped flow as unknown.",
                            group.group_id, group.reason, activity.id
                        );
                    } else if inputs
                        .external_transfer_resolution
                        .is_ungrouped_transfer(&activity.id)
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
                inputs
                    .market_facts
                    .quotes_by_request
                    .get(&(asset_id.clone(), activity_date))
            });
            let unit_multiplier = inputs.market_facts.multiplier_for(activity);
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
                match inputs
                    .removed_lot_basis_by_activity
                    .get(&activity.id)
                    .copied()
                {
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

        Ok(flows_by_date)
    }

    fn internal_transfer_adjustments_from_scoped_inputs(
        &self,
        inputs: &ScopedFlowInputs,
        base_currency: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> CoreResult<HashMap<NaiveDate, (Decimal, Decimal)>> {
        let mut adjustments_by_date: HashMap<NaiveDate, (Decimal, Decimal)> = HashMap::new();
        for pair in inputs.internal_transfer_resolution.pairs() {
            if !pair.both_accounts_in_scope(&inputs.scope_account_ids) {
                continue;
            }

            for activity in [&pair.transfer_in, &pair.transfer_out] {
                let activity_date =
                    time_utils::activity_date_in_tz(activity.activity_date, inputs.timezone);
                if !Self::activity_date_in_range(activity_date, start_date_opt, end_date_opt) {
                    continue;
                }
                let quote = activity.asset_id.as_ref().and_then(|asset_id| {
                    inputs
                        .market_facts
                        .quotes_by_request
                        .get(&(asset_id.clone(), activity_date))
                });
                let unit_multiplier = inputs.market_facts.multiplier_for(activity);
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

        Ok(adjustments_by_date)
    }

    fn scoped_flow_maps_by_date(
        &self,
        account_ids: &[String],
        base_currency: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> CoreResult<Option<ScopedFlowMaps>> {
        if account_ids.is_empty() {
            return Ok(Some(ScopedFlowMaps {
                external_flows_by_date: HashMap::new(),
                internal_adjustments_by_date: HashMap::new(),
            }));
        }
        let Some(inputs) = self.prepare_scoped_flow_inputs(
            account_ids,
            base_currency,
            start_date_opt,
            end_date_opt,
        )?
        else {
            return Ok(None);
        };
        let external_flows_by_date = self.external_flows_from_scoped_inputs(
            &inputs,
            base_currency,
            start_date_opt,
            end_date_opt,
        )?;
        let internal_adjustments_by_date = self.internal_transfer_adjustments_from_scoped_inputs(
            &inputs,
            base_currency,
            start_date_opt,
            end_date_opt,
        )?;
        Ok(Some(ScopedFlowMaps {
            external_flows_by_date,
            internal_adjustments_by_date,
        }))
    }

    fn account_external_flows_by_date(
        &self,
        account_ids: &[String],
        base_currency: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> CoreResult<Option<HashMap<NaiveDate, DailyFlowAmounts>>> {
        if account_ids.is_empty() {
            return Ok(Some(HashMap::new()));
        }
        let Some(inputs) = self.prepare_scoped_flow_inputs(
            account_ids,
            base_currency,
            start_date_opt,
            end_date_opt,
        )?
        else {
            return Ok(None);
        };
        self.external_flows_from_scoped_inputs(&inputs, base_currency, start_date_opt, end_date_opt)
            .map(Some)
    }

    fn prepare_valuation_account(
        &self,
        account_id: &str,
        mode: &ValuationRecalcMode,
        base_currency: &str,
    ) -> CoreResult<PreparedValuationAccount> {
        let today = {
            let timezone = self.timezone.read().unwrap();
            time_utils::user_today(time_utils::parse_user_timezone_or_default(&timezone))
        };
        let mut calculation_start_date = None;
        let mut incremental_anchor_date = None;
        let mut replace_since_date = match mode {
            ValuationRecalcMode::Full => Some(None),
            ValuationRecalcMode::SinceDate(date) => Some(Some(*date)),
            ValuationRecalcMode::IncrementalFromLast => None,
        };

        match mode {
            ValuationRecalcMode::Full => {}
            ValuationRecalcMode::SinceDate(date) => {
                validate_snapshot_read_date(
                    account_id,
                    *date,
                    SnapshotSource::Calculated.as_str(),
                    today,
                )?;
                let (start_date, anchor_date) = since_date_calculation_window(*date);
                calculation_start_date = Some(start_date);
                incremental_anchor_date = anchor_date;
            }
            ValuationRecalcMode::IncrementalFromLast => {
                if let Some(last_saved) = self
                    .valuation_repository
                    .load_latest_valuation_date(account_id)?
                {
                    if latest_valuation_requires_full_rebuild(last_saved, today) {
                        replace_since_date = Some(None);
                    } else {
                        validate_snapshot_read_date(
                            account_id,
                            last_saved,
                            SnapshotSource::Calculated.as_str(),
                            today,
                        )?;
                        calculation_start_date = Some(last_saved);
                        incremental_anchor_date = Some(last_saved);
                    }
                }
            }
        }

        let timeline = self.snapshot_service.get_holdings_timeline(
            account_id,
            calculation_start_date,
            None,
        )?;
        let mut required_asset_ids = HashSet::new();
        let mut required_fx_pairs = HashSet::new();
        let mut acquisition_fx_requests = HashSet::new();
        let mut account_currency = None;

        for snapshot in timeline.keyframes() {
            let account_curr = normalize_currency_code(&snapshot.currency);
            account_currency.get_or_insert_with(|| account_curr.to_string());
            if account_curr != base_currency {
                required_fx_pairs.insert((account_curr.to_string(), base_currency.to_string()));
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
                if position_currency != base_currency {
                    required_fx_pairs
                        .insert((position_currency.to_string(), base_currency.to_string()));
                }
                if !position.lots.is_empty() {
                    for lot in &position.lots {
                        let acquisition_date = lot.acquisition_date_key();
                        if position_currency != account_curr {
                            acquisition_fx_requests.insert((
                                position_currency.to_string(),
                                account_curr.to_string(),
                                acquisition_date,
                            ));
                        }
                        if position_currency != base_currency {
                            acquisition_fx_requests.insert((
                                position_currency.to_string(),
                                base_currency.to_string(),
                                acquisition_date,
                            ));
                        }
                    }
                }
            }
            for cash_currency in snapshot.cash_balances.keys() {
                let cash_currency = normalize_currency_code(cash_currency);
                if cash_currency != account_curr {
                    required_fx_pairs.insert((cash_currency.to_string(), account_curr.to_string()));
                }
            }
        }

        Ok(PreparedValuationAccount {
            account_id: account_id.to_string(),
            timeline,
            incremental_anchor_date,
            replace_since_date,
            required_asset_ids,
            required_fx_pairs,
            acquisition_fx_requests,
            base_currency: base_currency.to_string(),
            account_currency: account_currency.unwrap_or_else(|| base_currency.to_string()),
        })
    }

    async fn load_shared_valuation_facts(
        &self,
        accounts: &mut [PreparedValuationAccount],
    ) -> CoreResult<SharedValuationFacts> {
        let mut asset_start_dates = BTreeMap::new();
        let mut global_start: Option<NaiveDate> = None;
        let mut global_end: Option<NaiveDate> = None;
        for account in accounts.iter() {
            if let (Some(start), Some(end)) =
                (account.timeline.start_date(), account.timeline.end_date())
            {
                for asset_id in &account.required_asset_ids {
                    asset_start_dates
                        .entry(asset_id.clone())
                        .and_modify(|current: &mut NaiveDate| *current = (*current).min(start))
                        .or_insert(start);
                }
                global_start = Some(global_start.map_or(start, |current| current.min(start)));
                global_end = Some(global_end.map_or(end, |current| current.max(end)));
            }
        }

        let mut facts = SharedValuationFacts::default();
        let (Some(global_start), Some(global_end)) = (global_start, global_end) else {
            return Ok(facts);
        };

        let quotes = self
            .quote_service
            .get_sparse_quotes_in_range_by_asset(&asset_start_dates, global_end)?;
        let all_asset_ids: HashSet<_> = asset_start_dates.keys().cloned().collect();
        let quote_closes = Self::quote_close_by_asset_date(&quotes);
        facts.split_events = self.quote_adjusted_split_events_for_assets(
            &all_asset_ids,
            global_start,
            global_end,
            &quote_closes,
        )?;
        for quote in quotes {
            facts
                .quotes_by_asset
                .entry(quote.asset_id.clone())
                .or_default()
                .push(ValuationQuoteFact {
                    timestamp: quote.timestamp,
                    close: quote.close,
                    currency: quote.currency,
                });
        }
        for quotes in facts.quotes_by_asset.values_mut() {
            quotes.sort_by_key(|quote| quote.timestamp);
        }
        facts.assets_with_quotes = facts.quotes_by_asset.keys().cloned().collect();

        for account in accounts.iter_mut() {
            for asset_id in &account.required_asset_ids {
                let Some(quotes) = facts.quotes_by_asset.get(asset_id) else {
                    continue;
                };
                for quote in quotes {
                    let quote_currency = normalize_currency_code(&quote.currency);
                    if quote_currency != account.account_currency {
                        account
                            .required_fx_pairs
                            .insert((quote_currency.to_string(), account.account_currency.clone()));
                    }
                }
            }
        }

        for account in accounts.iter() {
            let mut required_pairs: Vec<_> = account.required_fx_pairs.iter().cloned().collect();
            required_pairs.sort();
            if let (Some(start), Some(end)) =
                (account.timeline.start_date(), account.timeline.end_date())
            {
                for date in time_utils::get_days_between(start, end) {
                    for (from, to) in &required_pairs {
                        self.load_fx_rate(&mut facts, from, to, date);
                    }
                }
            }
            let mut acquisition_requests: Vec<_> =
                account.acquisition_fx_requests.iter().cloned().collect();
            acquisition_requests.sort();
            for (from, to, date) in acquisition_requests {
                self.load_fx_rate(&mut facts, &from, &to, date);
            }
        }
        Ok(facts)
    }

    fn calculate_prepared_valuation_account(
        &self,
        account: PreparedValuationAccount,
        facts: &SharedValuationFacts,
    ) -> CoreResult<AccountValuationCalculation> {
        let flows = match (account.timeline.start_date(), account.timeline.end_date()) {
            (Some(start), Some(end)) => self.account_external_flows_by_date(
                std::slice::from_ref(&account.account_id),
                &account.base_currency,
                Some(start),
                Some(end),
            )?,
            _ => None,
        };
        Self::calculate_prepared_valuation_account_from_facts(account, facts, flows.as_ref())
    }

    fn calculate_prepared_valuation_account_from_facts(
        account: PreparedValuationAccount,
        facts: &SharedValuationFacts,
        flows: Option<&HashMap<NaiveDate, DailyFlowAmounts>>,
    ) -> CoreResult<AccountValuationCalculation> {
        if account.timeline.is_empty() {
            let persistence = if account.timeline.has_deferred_future_snapshots() {
                ValuationPersistence::Noop
            } else if let Some(since_date) = account.replace_since_date {
                ValuationPersistence::Replace(since_date)
            } else {
                ValuationPersistence::Noop
            };
            return Ok(AccountValuationCalculation {
                account_id: account.account_id,
                valuations: Vec::new(),
                persistence,
            });
        }

        let mut quote_cursors: HashMap<String, usize> = HashMap::new();
        let mut active_quotes: HashMap<String, usize> = HashMap::new();
        let mut quote_assets: Vec<_> = account.required_asset_ids.iter().cloned().collect();
        quote_assets.sort();
        let acquisition_fx_rates_by_date =
            facts.acquisition_fx_rates_by_date(&account.acquisition_fx_requests);
        let mut skipped_dates = Vec::new();
        let mut valuations: Vec<DailyAccountValuation> = account
            .timeline
            .iter()
            .filter_map(|day| {
                let mut quotes_today = HashMap::new();
                for asset_id in &quote_assets {
                    let Some(quotes) = facts.quotes_by_asset.get(asset_id) else {
                        continue;
                    };
                    let cursor = quote_cursors.entry(asset_id.clone()).or_insert(0);
                    while *cursor < quotes.len()
                        && quotes[*cursor].timestamp.date_naive() <= day.date
                    {
                        active_quotes.insert(asset_id.clone(), *cursor);
                        *cursor += 1;
                    }
                    if let Some(active_index) = active_quotes.get(asset_id) {
                        quotes_today
                            .insert(asset_id.clone(), quotes[*active_index].to_quote(asset_id));
                    }
                }

                let mut quotable_positions: Vec<_> = day
                    .snapshot
                    .positions
                    .iter()
                    .filter(|(_, position)| Self::position_counts_for_quote_gating(position))
                    .map(|(asset_id, _)| asset_id)
                    .filter(|asset_id| facts.assets_with_quotes.contains(*asset_id))
                    .cloned()
                    .collect();
                quotable_positions.sort();
                let missing_quotes: Vec<_> = quotable_positions
                    .iter()
                    .filter(|asset_id| !quotes_today.contains_key(*asset_id))
                    .cloned()
                    .collect();
                if !quotable_positions.is_empty()
                    && missing_quotes.len() == quotable_positions.len()
                {
                    debug!(
                        "No quotes available on or before {} for any quotable position in account '{}'; emitting an unavailable valuation row.",
                        day.date, account.account_id
                    );
                }

                let fx_today = facts.fx_rates_for_date(&account.required_fx_pairs, day.date);
                if day.snapshot.currency != account.base_currency
                    && !fx_today.contains_key(&(
                        day.snapshot.currency.clone(),
                        account.base_currency.clone(),
                    ))
                {
                    skipped_dates.push((
                        day.date,
                        format!(
                            "missing base-currency FX rate {}->{}",
                            day.snapshot.currency, account.base_currency
                        ),
                    ));
                    return None;
                }
                let split_factors =
                    Self::split_price_factors_for_date(day.date, &facts.split_events);
                match calculate_valuation_with_price_factors(
                    day.snapshot,
                    &quotes_today,
                    &fx_today,
                    &acquisition_fx_rates_by_date,
                    day.date,
                    &account.base_currency,
                    &split_factors,
                ) {
                    Ok(valuation) => Some(valuation),
                    Err(error) => {
                        skipped_dates.push((day.date, error.to_string()));
                        None
                    }
                }
            })
            .collect();

        if !skipped_dates.is_empty() {
            let preview = skipped_dates
                .iter()
                .take(5)
                .map(|(date, reason)| format!("{} ({})", date, reason))
                .collect::<Vec<_>>()
                .join(", ");
            return Err(CoreError::Calculation(CalculatorError::Calculation(
                format!(
                    "Incomplete valuation history for account '{}': {} date(s) could not be calculated. First skipped dates: {}",
                    account.account_id,
                    skipped_dates.len(),
                    preview
                ),
            )));
        }

        if let Some(flows) = flows {
            Self::set_external_flows_from_activity_map_or_net_contribution_base(
                &mut valuations,
                flows,
                false,
            );
        } else {
            Self::set_external_flows_from_net_contribution_base(&mut valuations, false);
        }
        // After generic flow stamping so inferred transitions (including the
        // Unknown marker for unpriceable ones) are authoritative on holdings
        // rows and can't be relabeled by the fallback pass.
        Self::apply_inferred_holdings_external_flows(&mut valuations, &account, facts);
        if let Some(anchor_date) = account.incremental_anchor_date {
            valuations.retain(|valuation| valuation.valuation_date != anchor_date);
        }
        let persistence = account
            .replace_since_date
            .map(ValuationPersistence::Replace)
            .unwrap_or(ValuationPersistence::Append);
        Ok(AccountValuationCalculation {
            account_id: account.account_id,
            valuations,
            persistence,
        })
    }

    #[cfg(test)]
    fn calculate_prepared_valuation_account_dense_reference(
        account: PreparedValuationAccount,
        facts: &SharedValuationFacts,
        flows: Option<&HashMap<NaiveDate, DailyFlowAmounts>>,
    ) -> CoreResult<AccountValuationCalculation> {
        if account.timeline.is_empty() {
            let persistence = if account.timeline.has_deferred_future_snapshots() {
                ValuationPersistence::Noop
            } else if let Some(since_date) = account.replace_since_date {
                ValuationPersistence::Replace(since_date)
            } else {
                ValuationPersistence::Noop
            };
            return Ok(AccountValuationCalculation {
                account_id: account.account_id,
                valuations: Vec::new(),
                persistence,
            });
        }

        let start = account.timeline.start_date().unwrap();
        let end = account.timeline.end_date().unwrap();
        let dense_days: Vec<_> = time_utils::get_days_between(start, end)
            .into_iter()
            .filter_map(|date| {
                account
                    .timeline
                    .snapshot_at(date)
                    .cloned()
                    .map(|snapshot| (date, snapshot))
            })
            .collect();
        let mut quote_assets: Vec<_> = account.required_asset_ids.iter().cloned().collect();
        quote_assets.sort();
        let acquisition_fx_rates_by_date =
            facts.acquisition_fx_rates_by_date(&account.acquisition_fx_requests);

        let mut skipped_dates = Vec::new();
        let mut valuations: Vec<DailyAccountValuation> = dense_days
            .iter()
            .filter_map(|(date, snapshot)| {
                let quotes_today: HashMap<_, _> = quote_assets
                    .iter()
                    .filter_map(|asset_id| {
                        facts
                            .quotes_by_asset
                            .get(asset_id)
                            .and_then(|quotes| {
                                quotes
                                    .iter()
                                    .rev()
                                    .find(|quote| quote.timestamp.date_naive() <= *date)
                            })
                            .map(|quote| (asset_id.clone(), quote.to_quote(asset_id)))
                    })
                    .collect();
                let mut quotable_positions: Vec<_> = snapshot
                    .positions
                    .iter()
                    .filter(|(_, position)| Self::position_counts_for_quote_gating(position))
                    .map(|(asset_id, _)| asset_id)
                    .filter(|asset_id| facts.assets_with_quotes.contains(*asset_id))
                    .cloned()
                    .collect();
                quotable_positions.sort();
                let missing_quotes = quotable_positions
                    .iter()
                    .filter(|asset_id| !quotes_today.contains_key(*asset_id))
                    .count();
                if !quotable_positions.is_empty() && missing_quotes == quotable_positions.len() {
                    debug!(
                        "No quotes available on or before {} for any quotable position in account '{}'; emitting an unavailable valuation row.",
                        date, account.account_id
                    );
                }

                let fx_today = facts.fx_rates_for_date(&account.required_fx_pairs, *date);
                if snapshot.currency != account.base_currency
                    && !fx_today
                        .contains_key(&(snapshot.currency.clone(), account.base_currency.clone()))
                {
                    skipped_dates.push((
                        *date,
                        format!(
                            "missing base-currency FX rate {}->{}",
                            snapshot.currency, account.base_currency
                        ),
                    ));
                    return None;
                }
                let split_factors = Self::split_price_factors_for_date(*date, &facts.split_events);
                match calculate_valuation_with_price_factors(
                    snapshot,
                    &quotes_today,
                    &fx_today,
                    &acquisition_fx_rates_by_date,
                    *date,
                    &account.base_currency,
                    &split_factors,
                ) {
                    Ok(valuation) => Some(valuation),
                    Err(error) => {
                        skipped_dates.push((*date, error.to_string()));
                        None
                    }
                }
            })
            .collect();

        if !skipped_dates.is_empty() {
            let preview = skipped_dates
                .iter()
                .take(5)
                .map(|(date, reason)| format!("{} ({})", date, reason))
                .collect::<Vec<_>>()
                .join(", ");
            return Err(CoreError::Calculation(CalculatorError::Calculation(
                format!(
                    "Incomplete valuation history for account '{}': {} date(s) could not be calculated. First skipped dates: {}",
                    account.account_id,
                    skipped_dates.len(),
                    preview
                ),
            )));
        }

        if let Some(flows) = flows {
            Self::set_external_flows_from_activity_map_or_net_contribution_base(
                &mut valuations,
                flows,
                false,
            );
        } else {
            Self::set_external_flows_from_net_contribution_base(&mut valuations, false);
        }
        // After generic flow stamping so inferred transitions (including the
        // Unknown marker for unpriceable ones) are authoritative on holdings
        // rows and can't be relabeled by the fallback pass.
        Self::apply_inferred_holdings_external_flows(&mut valuations, &account, facts);
        if let Some(anchor_date) = account.incremental_anchor_date {
            valuations.retain(|valuation| valuation.valuation_date != anchor_date);
        }
        let persistence = account
            .replace_since_date
            .map(ValuationPersistence::Replace)
            .unwrap_or(ValuationPersistence::Append);
        Ok(AccountValuationCalculation {
            account_id: account.account_id,
            valuations,
            persistence,
        })
    }

    async fn persist_account_valuation(
        &self,
        calculation: AccountValuationCalculation,
    ) -> CoreResult<()> {
        match calculation.persistence {
            ValuationPersistence::Noop => Ok(()),
            ValuationPersistence::Replace(since_date) => {
                self.valuation_repository
                    .replace_valuations_for_account(
                        &calculation.account_id,
                        since_date,
                        &calculation.valuations,
                    )
                    .await
            }
            ValuationPersistence::Append if calculation.valuations.is_empty() => Ok(()),
            ValuationPersistence::Append => {
                self.valuation_repository
                    .save_valuations(&calculation.valuations)
                    .await
            }
        }
    }

    async fn execute_valuation_batch(
        &self,
        account_ids: &[String],
        mode: ValuationRecalcMode,
    ) -> ValuationBatchExecution {
        let recalculation_permit: Option<PortfolioRecalculationPermit> =
            match &self.recalculation_gate {
                Some(gate) => Some(gate.acquire(account_ids).await),
                None => None,
            };
        let mode = if recalculation_permit
            .as_ref()
            .is_some_and(PortfolioRecalculationPermit::force_full)
        {
            ValuationRecalcMode::Full
        } else {
            mode
        };
        let base_currency = normalize_currency_code(
            &self
                .base_currency
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        )
        .to_string();
        let mut outcome = ValuationBatchOutcome::default();
        let mut account_errors = HashMap::new();
        let mut prepared = Vec::new();
        let mut ordered_account_ids = account_ids.to_vec();
        ordered_account_ids.sort();
        ordered_account_ids.dedup();
        for account_id in ordered_account_ids {
            match self.prepare_valuation_account(&account_id, &mode, &base_currency) {
                Ok(account) => prepared.push(account),
                Err(error) => {
                    outcome
                        .failures
                        .push(ValuationAccountFailure::from_error(&account_id, &error));
                    account_errors.insert(account_id, error);
                }
            }
        }

        // Fact loading finishes before any account writes. If it fails, report every
        // prepared account as failed while retaining diagnostics gathered above.
        let shared_facts = match self.load_shared_valuation_facts(&mut prepared).await {
            Ok(facts) => Arc::new(facts),
            Err(error) => {
                return Self::fact_loading_failure_execution(
                    outcome,
                    account_errors,
                    &prepared,
                    error,
                );
            }
        };
        let concurrency = std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(1)
            .clamp(1, 4);
        let mut results = stream::iter(prepared.into_iter().map(|account| {
            let account_id = account.account_id.clone();
            let service = self.clone();
            let facts = shared_facts.clone();
            async move {
                let result = tokio::task::spawn_blocking(move || {
                    service.calculate_prepared_valuation_account(account, &facts)
                })
                .await;
                (account_id, result)
            }
        }))
        .buffer_unordered(concurrency);

        while let Some((account_id, result)) = results.next().await {
            let account_error = match result {
                Ok(Ok(calculation)) => match self.persist_account_valuation(calculation).await {
                    Ok(()) => {
                        outcome.successful_accounts.push(account_id);
                        continue;
                    }
                    Err(error) => error,
                },
                Ok(Err(error)) => error,
                Err(error) => CoreError::Calculation(CalculatorError::Calculation(format!(
                    "Valuation worker failed: {}",
                    error
                ))),
            };
            outcome.failures.push(ValuationAccountFailure::from_error(
                &account_id,
                &account_error,
            ));
            account_errors.insert(account_id, account_error);
        }
        Self::sort_batch_outcome(&mut outcome);
        ValuationBatchExecution {
            outcome,
            account_errors,
            global_error: None,
        }
    }

    fn sort_batch_outcome(outcome: &mut ValuationBatchOutcome) {
        outcome.successful_accounts.sort();
        outcome
            .failures
            .sort_by(|left, right| left.account_id.cmp(&right.account_id));
    }

    fn fact_loading_failure_execution(
        mut outcome: ValuationBatchOutcome,
        account_errors: HashMap<String, CoreError>,
        prepared: &[PreparedValuationAccount],
        error: CoreError,
    ) -> ValuationBatchExecution {
        for account in prepared {
            outcome
                .failures
                .push(ValuationAccountFailure::from_fact_loading_error(
                    &account.account_id,
                    &error,
                ));
        }
        Self::sort_batch_outcome(&mut outcome);
        ValuationBatchExecution {
            outcome,
            account_errors,
            global_error: Some(error),
        }
    }

    fn single_account_result(
        mut execution: ValuationBatchExecution,
        account_id: &str,
    ) -> CoreResult<()> {
        if let Some(error) = execution.global_error {
            return Err(error);
        }
        match execution.account_errors.remove(account_id) {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

#[async_trait]
impl ValuationServiceTrait for ValuationService {
    async fn calculate_valuation_histories(
        &self,
        account_ids: &[String],
        mode: ValuationRecalcMode,
    ) -> CoreResult<ValuationBatchOutcome> {
        Ok(self
            .execute_valuation_batch(account_ids, mode)
            .await
            .outcome)
    }

    async fn calculate_valuation_history(
        &self,
        account_id: &str,
        mode: ValuationRecalcMode,
    ) -> CoreResult<()> {
        let execution = self
            .execute_valuation_batch(&[account_id.to_string()], mode)
            .await;
        Self::single_account_result(execution, account_id)
    }

    #[cfg(test)]
    async fn calculate_valuation_history_dense_reference(
        &self,
        account_id: &str,
        mode: ValuationRecalcMode,
    ) -> CoreResult<()> {
        let base_currency = normalize_currency_code(
            &self
                .base_currency
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        )
        .to_string();
        let account = self.prepare_valuation_account(account_id, &mode, &base_currency)?;
        let mut accounts = vec![account];
        let facts = self.load_shared_valuation_facts(&mut accounts).await?;
        let account = accounts.pop().unwrap();
        let flows = match (account.timeline.start_date(), account.timeline.end_date()) {
            (Some(start), Some(end)) => self.account_external_flows_by_date(
                std::slice::from_ref(&account.account_id),
                &account.base_currency,
                Some(start),
                Some(end),
            )?,
            _ => None,
        };
        let calculation = Self::calculate_prepared_valuation_account_dense_reference(
            account,
            &facts,
            flows.as_ref(),
        )?;
        self.persist_account_valuation(calculation).await
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
        let cache_key = ScopedValuationCacheKey {
            service_instance_id: self.service_instance_id,
            mode: ScopedValuationHistoryMode::PerformanceFlows,
            scope_id: scope_id.to_string(),
            membership_hash: Self::membership_hash(account_ids),
            base_currency: base_currency.to_string(),
            start_date: start_date_opt,
            end_date: end_date_opt,
            max_calculated_at,
        };
        let single_flight_key = cache_key.clone();
        self.with_scoped_history_single_flight(single_flight_key, || {
            let mut cache_key = cache_key;
            let records = self
                .valuation_repository
                .get_historical_valuations_for_accounts(
                    account_ids,
                    start_date_opt,
                    end_date_opt,
                )?;

            let loaded_max_calculated_at = records
                .iter()
                .map(|valuation| valuation.calculated_at.to_rfc3339())
                .max()
                .unwrap_or_default();
            if loaded_max_calculated_at != cache_key.max_calculated_at {
                cache_key.max_calculated_at = loaded_max_calculated_at;
                if let Some(cached) = self.scoped_history_cache_get(&cache_key) {
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

            let scoped_flow_maps = self.scoped_flow_maps_by_date(
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
                scoped_flow_maps
                    .as_ref()
                    .map(|maps| &maps.external_flows_by_date),
                scoped_flow_maps
                    .as_ref()
                    .map(|maps| &maps.internal_adjustments_by_date),
            )?;

            self.insert_scoped_history_cache(cache_key, &aggregate);
            Ok(aggregate)
        })
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
        let cache_key = ScopedValuationCacheKey {
            service_instance_id: self.service_instance_id,
            mode: ScopedValuationHistoryMode::TotalsOnly,
            scope_id: scope_id.to_string(),
            membership_hash: Self::membership_hash(account_ids),
            base_currency: base_currency.to_string(),
            start_date: start_date_opt,
            end_date: end_date_opt,
            max_calculated_at,
        };
        let single_flight_key = cache_key.clone();
        self.with_scoped_history_single_flight(single_flight_key, || {
            let mut cache_key = cache_key;
            let records = self
                .valuation_repository
                .get_historical_valuations_for_accounts(
                    account_ids,
                    start_date_opt,
                    end_date_opt,
                )?;

            let loaded_max_calculated_at = records
                .iter()
                .map(|valuation| valuation.calculated_at.to_rfc3339())
                .max()
                .unwrap_or_default();
            if loaded_max_calculated_at != cache_key.max_calculated_at {
                cache_key.max_calculated_at = loaded_max_calculated_at;
                if let Some(cached) = self.scoped_history_cache_get(&cache_key) {
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
        })
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
    use crate::portfolio::snapshot::{AccountStateSnapshot, HoldingsTimeline, SnapshotSource};
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

    // The enum's own exhaustive list, so a new variant is covered here too.
    const ALL_FLOW_SOURCES: [ExternalFlowSource; 14] = ExternalFlowSource::ALL;

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
        // Both inputs are exact, so the mixture is the exact one (#1609).
        assert_eq!(
            ValuationService::combine_activity_flow_sources(
                ExternalFlowSource::CashAmount,
                ExternalFlowSource::QuoteDerivedMarketValue,
            ),
            ExternalFlowSource::MixedExact,
        );
        assert_eq!(
            ValuationService::combine_activity_flow_sources(
                ExternalFlowSource::QuoteDerivedMarketValue,
                ExternalFlowSource::CashAmount,
            ),
            ExternalFlowSource::MixedExact,
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
    fn since_date_recalc_at_supported_floor_has_no_anchor() {
        let floor = min_supported_snapshot_date();
        let (start_date, anchor_date) = since_date_calculation_window(floor);

        assert_eq!(start_date, floor);
        assert_eq!(anchor_date, None);
    }

    #[test]
    fn future_latest_valuation_requires_full_rebuild() {
        let today = date("2025-03-02");

        assert!(latest_valuation_requires_full_rebuild(
            date("2025-03-03"),
            today
        ));
        assert!(!latest_valuation_requires_full_rebuild(today, today));
        assert!(!latest_valuation_requires_full_rebuild(
            date("2025-03-01"),
            today
        ));
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
    fn interval_valuation_matches_dense_reference_with_sparse_facts() {
        let start = date("2026-06-01");
        let end = date("2026-06-06");
        let mut first = snapshot_with_position("2026-06-01", "AAPL", dec!(10));
        first.currency = "CAD".to_string();
        let mut second = snapshot_with_position("2026-06-04", "AAPL", dec!(20));
        second.currency = "CAD".to_string();
        let timeline = HoldingsTimeline::new(Some(start), end, vec![first, second], None, false);
        let account = PreparedValuationAccount {
            account_id: "account-1".to_string(),
            timeline,
            incremental_anchor_date: Some(start),
            replace_since_date: Some(Some(date("2026-06-02"))),
            required_asset_ids: HashSet::from(["AAPL".to_string()]),
            required_fx_pairs: HashSet::from([
                ("CAD".to_string(), "USD".to_string()),
                ("USD".to_string(), "CAD".to_string()),
            ]),
            acquisition_fx_requests: HashSet::new(),
            base_currency: "USD".to_string(),
            account_currency: "CAD".to_string(),
        };

        let quote_facts = [
            ("2026-06-01", dec!(100)),
            ("2026-06-03", dec!(102)),
            ("2026-06-05", dec!(52)),
        ]
        .into_iter()
        .map(|(quote_date, close)| ValuationQuoteFact {
            timestamp: activity_time(quote_date),
            close,
            currency: "USD".to_string(),
        })
        .collect();
        let mut facts = SharedValuationFacts {
            quotes_by_asset: HashMap::from([("AAPL".to_string(), quote_facts)]),
            assets_with_quotes: HashSet::from(["AAPL".to_string()]),
            split_events: vec![QuoteAdjustedSplitEvent {
                asset_id: "AAPL".to_string(),
                split_date: date("2026-06-05"),
                ratio: dec!(2),
            }],
            fx_rates_by_pair: BTreeMap::new(),
        };
        for pair_rate in [
            (("CAD", "USD"), dec!(0.75)),
            (("USD", "CAD"), dec!(1.333333)),
        ] {
            let ((from, to), rate) = pair_rate;
            facts.fx_rates_by_pair.insert(
                (from.to_string(), to.to_string()),
                time_utils::get_days_between(start, end)
                    .into_iter()
                    .map(|day| (day, Some(rate)))
                    .collect(),
            );
        }
        let flows = HashMap::from([(
            date("2026-06-04"),
            DailyFlowAmounts {
                inflow: dec!(250),
                outflow: Decimal::ZERO,
                source: ExternalFlowSource::CashAmount,
            },
        )]);

        let mut interval = ValuationService::calculate_prepared_valuation_account_from_facts(
            account.clone(),
            &facts,
            Some(&flows),
        )
        .expect("interval valuation should succeed")
        .valuations;
        let mut dense = ValuationService::calculate_prepared_valuation_account_dense_reference(
            account,
            &facts,
            Some(&flows),
        )
        .expect("dense reference valuation should succeed")
        .valuations;

        let stable_calculated_at = DateTime::<Utc>::from_timestamp(0, 0).unwrap();
        for valuation in interval.iter_mut().chain(dense.iter_mut()) {
            valuation.calculated_at = stable_calculated_at;
        }
        assert_eq!(interval, dense);
        assert_eq!(
            interval
                .first()
                .expect("anchor day should be discarded")
                .valuation_date,
            date("2026-06-02")
        );
        assert_eq!(
            interval
                .iter()
                .find(|valuation| valuation.valuation_date == date("2026-06-04"))
                .expect("flow day should be present")
                .external_inflow_base,
            dec!(250)
        );
    }

    #[test]
    fn full_quote_gap_emits_current_snapshot_values_for_scoped_aggregation() {
        let start = date("2026-06-01");
        let end = date("2026-06-03");
        let first = snapshot_with_position("2026-06-01", "OLD", dec!(10));
        let mut second = snapshot_with_position("2026-06-02", "NEW", dec!(5));
        second.cash_balances = HashMap::from([("USD".to_string(), dec!(100))]);
        second.net_contribution = dec!(100);
        second.net_contribution_base = dec!(100);
        let timeline = HoldingsTimeline::new(Some(start), end, vec![first, second], None, false);
        let account = PreparedValuationAccount {
            account_id: "account-1".to_string(),
            timeline,
            incremental_anchor_date: None,
            replace_since_date: None,
            required_asset_ids: HashSet::from(["OLD".to_string(), "NEW".to_string()]),
            required_fx_pairs: HashSet::new(),
            acquisition_fx_requests: HashSet::new(),
            base_currency: "USD".to_string(),
            account_currency: "USD".to_string(),
        };
        let facts = SharedValuationFacts {
            quotes_by_asset: HashMap::from([
                (
                    "OLD".to_string(),
                    vec![ValuationQuoteFact {
                        timestamp: activity_time("2026-06-01"),
                        close: dec!(10),
                        currency: "USD".to_string(),
                    }],
                ),
                (
                    "NEW".to_string(),
                    vec![ValuationQuoteFact {
                        timestamp: activity_time("2026-06-03"),
                        close: dec!(20),
                        currency: "USD".to_string(),
                    }],
                ),
            ]),
            assets_with_quotes: HashSet::from(["OLD".to_string(), "NEW".to_string()]),
            split_events: Vec::new(),
            fx_rates_by_pair: BTreeMap::new(),
        };
        let flows = HashMap::from([(
            date("2026-06-02"),
            DailyFlowAmounts {
                inflow: dec!(100),
                outflow: Decimal::ZERO,
                source: ExternalFlowSource::CashAmount,
            },
        )]);

        let mut interval = ValuationService::calculate_prepared_valuation_account_from_facts(
            account.clone(),
            &facts,
            Some(&flows),
        )
        .expect("interval valuation should retain the unpriced day")
        .valuations;
        let mut dense = ValuationService::calculate_prepared_valuation_account_dense_reference(
            account,
            &facts,
            Some(&flows),
        )
        .expect("dense valuation should retain the unpriced day")
        .valuations;
        let stable_calculated_at = DateTime::<Utc>::from_timestamp(0, 0).unwrap();
        for valuation in interval.iter_mut().chain(dense.iter_mut()) {
            valuation.calculated_at = stable_calculated_at;
        }
        assert_eq!(interval, dense);
        assert_eq!(interval.len(), 3);

        let gap_day = interval
            .iter()
            .find(|valuation| valuation.valuation_date == date("2026-06-02"))
            .expect("the full quote-gap day should be represented");
        assert_eq!(gap_day.cash_balance_base, dec!(100));
        assert_eq!(gap_day.total_value_base, dec!(100));
        assert_eq!(gap_day.net_contribution_base, dec!(100));
        assert_eq!(gap_day.external_inflow_base, dec!(100));
        assert_eq!(gap_day.external_outflow_base, Decimal::ZERO);
        assert_eq!(gap_day.external_flow_source, ExternalFlowSource::CashAmount);
        assert_eq!(gap_day.value_status, ValuationStatus::PartialUnpriced);

        let other_history = vec![
            valuation(
                "account-2",
                "2026-06-01",
                dec!(50),
                dec!(50),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            valuation(
                "account-2",
                "2026-06-02",
                dec!(50),
                dec!(50),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            valuation(
                "account-2",
                "2026-06-03",
                dec!(50),
                dec!(50),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
        ];
        let aggregate = ValuationService::aggregate_scoped_valuations(
            "accounts:test",
            &["account-1".to_string(), "account-2".to_string()],
            "USD",
            vec![interval, other_history],
            Some(&flows),
            None,
        )
        .expect("the scoped history should not contain an interior gap");
        let aggregate_gap_day = aggregate
            .iter()
            .find(|valuation| valuation.valuation_date == date("2026-06-02"))
            .expect("the aggregate should contain the full quote-gap day");
        assert_eq!(aggregate_gap_day.total_value_base, dec!(150));
        assert_eq!(aggregate_gap_day.net_contribution_base, dec!(150));
        assert_eq!(aggregate_gap_day.external_inflow_base, dec!(100));
        assert_eq!(
            aggregate_gap_day.value_status,
            ValuationStatus::PartialUnpriced
        );
    }

    fn holdings_prepared_account(timeline: HoldingsTimeline) -> PreparedValuationAccount {
        PreparedValuationAccount {
            account_id: "account-1".to_string(),
            timeline,
            incremental_anchor_date: None,
            replace_since_date: None,
            required_asset_ids: HashSet::from(["AAPL".to_string()]),
            required_fx_pairs: HashSet::new(),
            acquisition_fx_requests: HashSet::new(),
            base_currency: "USD".to_string(),
            account_currency: "USD".to_string(),
        }
    }

    fn holdings_quote_facts() -> SharedValuationFacts {
        let quote_facts = [("2026-06-01", dec!(100)), ("2026-06-03", dec!(102))]
            .into_iter()
            .map(|(quote_date, close)| ValuationQuoteFact {
                timestamp: activity_time(quote_date),
                close,
                currency: "USD".to_string(),
            })
            .collect();
        SharedValuationFacts {
            quotes_by_asset: HashMap::from([("AAPL".to_string(), quote_facts)]),
            assets_with_quotes: HashSet::from(["AAPL".to_string()]),
            split_events: Vec::new(),
            fx_rates_by_pair: BTreeMap::new(),
        }
    }

    #[test]
    fn holdings_keyframe_transition_infers_explicit_external_flow() {
        let start = date("2026-06-01");
        let end = date("2026-06-06");
        let mut first = snapshot_with_position("2026-06-01", "AAPL", dec!(10));
        first.source = SnapshotSource::ManualEntry;
        // Deposit-buy on 06-04: 10 -> 20 shares, plus 300 deposited as cash.
        let mut second = snapshot_with_position("2026-06-04", "AAPL", dec!(20));
        second.source = SnapshotSource::ManualEntry;
        second.cash_balances = HashMap::from([("USD".to_string(), dec!(300))]);
        let timeline = HoldingsTimeline::new(Some(start), end, vec![first, second], None, false);
        let account = holdings_prepared_account(timeline);
        let facts = holdings_quote_facts();
        let flows: HashMap<NaiveDate, DailyFlowAmounts> = HashMap::new();

        let valuations = ValuationService::calculate_prepared_valuation_account_from_facts(
            account.clone(),
            &facts,
            Some(&flows),
        )
        .expect("valuation should succeed")
        .valuations;

        // Transition day priced at the 06-03 quote (102):
        // flow = (20 * 102 + 300 cash) - 10 * 102 = 1320.
        let transition = valuations
            .iter()
            .find(|valuation| valuation.valuation_date == date("2026-06-04"))
            .expect("transition day should be present");
        assert_eq!(transition.external_inflow_base, dec!(1320));
        assert_eq!(transition.external_outflow_base, Decimal::ZERO);
        assert_eq!(
            transition.external_flow_source,
            ExternalFlowSource::QuoteDerivedMarketValue
        );
        assert_eq!(transition.net_contribution_base, Decimal::ZERO);

        let quiet = valuations
            .iter()
            .find(|valuation| valuation.valuation_date == date("2026-06-03"))
            .expect("quiet day should be present");
        assert_eq!(quiet.external_inflow_base, Decimal::ZERO);
        assert_eq!(quiet.external_flow_source, ExternalFlowSource::NoFlow);

        let dense = ValuationService::calculate_prepared_valuation_account_dense_reference(
            account,
            &facts,
            Some(&flows),
        )
        .expect("dense reference valuation should succeed")
        .valuations;
        let dense_transition = dense
            .iter()
            .find(|valuation| valuation.valuation_date == date("2026-06-04"))
            .expect("dense transition day should be present");
        assert_eq!(dense_transition.external_inflow_base, dec!(1320));
        assert_eq!(
            dense_transition.external_flow_source,
            ExternalFlowSource::QuoteDerivedMarketValue
        );
    }

    #[test]
    fn holdings_keyframe_sale_at_market_infers_no_flow() {
        // 10 shares exit on 06-04 with proceeds parked as cash at the day's
        // quote: the position leaves at market value, so no external flow is
        // inferred and the accrued price gain stays in the period.
        let start = date("2026-06-01");
        let end = date("2026-06-06");
        let mut first = snapshot_with_position("2026-06-01", "AAPL", dec!(10));
        first.source = SnapshotSource::ManualEntry;
        let mut second = snapshot_with_position("2026-06-04", "AAPL", Decimal::ZERO);
        second.source = SnapshotSource::ManualEntry;
        second.cash_balances = HashMap::from([("USD".to_string(), dec!(1020))]);
        let timeline = HoldingsTimeline::new(Some(start), end, vec![first, second], None, false);

        let valuations = ValuationService::calculate_prepared_valuation_account_from_facts(
            holdings_prepared_account(timeline),
            &holdings_quote_facts(),
            Some(&HashMap::new()),
        )
        .expect("valuation should succeed")
        .valuations;

        let transition = valuations
            .iter()
            .find(|valuation| valuation.valuation_date == date("2026-06-04"))
            .expect("transition day should be present");
        assert_eq!(transition.external_inflow_base, Decimal::ZERO);
        assert_eq!(transition.external_outflow_base, Decimal::ZERO);
        assert_eq!(transition.external_flow_source, ExternalFlowSource::NoFlow);
    }

    #[test]
    fn holdings_keyframe_transition_across_split_infers_no_flow() {
        // 2:1 split effective on the transition day: the user's next snapshot
        // records 20 (post-split) shares where the previous one had 10. The
        // holdings are economically unchanged, so no flow may be inferred.
        // Quotes are provider back-adjusted (post-split terms throughout).
        let start = date("2026-06-01");
        let end = date("2026-06-06");
        let mut first = snapshot_with_position("2026-06-01", "AAPL", dec!(10));
        first.source = SnapshotSource::ManualEntry;
        let mut second = snapshot_with_position("2026-06-04", "AAPL", dec!(20));
        second.source = SnapshotSource::ManualEntry;
        let timeline = HoldingsTimeline::new(Some(start), end, vec![first, second], None, false);
        let account = holdings_prepared_account(timeline);

        let quote_facts = [("2026-06-01", dec!(50)), ("2026-06-03", dec!(51))]
            .into_iter()
            .map(|(quote_date, close)| ValuationQuoteFact {
                timestamp: activity_time(quote_date),
                close,
                currency: "USD".to_string(),
            })
            .collect();
        let facts = SharedValuationFacts {
            quotes_by_asset: HashMap::from([("AAPL".to_string(), quote_facts)]),
            assets_with_quotes: HashSet::from(["AAPL".to_string()]),
            split_events: vec![QuoteAdjustedSplitEvent {
                asset_id: "AAPL".to_string(),
                split_date: date("2026-06-04"),
                ratio: dec!(2),
            }],
            fx_rates_by_pair: BTreeMap::new(),
        };

        let valuations = ValuationService::calculate_prepared_valuation_account_from_facts(
            account,
            &facts,
            Some(&HashMap::new()),
        )
        .expect("valuation should succeed")
        .valuations;

        // Series is smooth across the split: 10 x 51 x 2 = 20 x 51 = 1020.
        let pre_split = valuations
            .iter()
            .find(|valuation| valuation.valuation_date == date("2026-06-03"))
            .expect("pre-split day should be present");
        assert_eq!(pre_split.total_value_base, dec!(1020));
        let transition = valuations
            .iter()
            .find(|valuation| valuation.valuation_date == date("2026-06-04"))
            .expect("transition day should be present");
        assert_eq!(transition.total_value_base, dec!(1020));
        // Old keyframe priced with prev-day split factors: no fabricated flow.
        assert_eq!(transition.external_inflow_base, Decimal::ZERO);
        assert_eq!(transition.external_outflow_base, Decimal::ZERO);
        assert_eq!(transition.external_flow_source, ExternalFlowSource::NoFlow);
    }

    #[test]
    fn holdings_keyframe_delayed_after_split_infers_no_flow() {
        // Split on 06-04, but the user's next snapshot lands on 06-06. The
        // old keyframe's quantities are stated as of ITS snapshot date
        // (06-01), so the split must still be bridged even though the
        // previous valuation row (06-05) is already past the split date.
        let start = date("2026-06-01");
        let end = date("2026-06-08");
        let mut first = snapshot_with_position("2026-06-01", "AAPL", dec!(10));
        first.source = SnapshotSource::ManualEntry;
        let mut second = snapshot_with_position("2026-06-06", "AAPL", dec!(20));
        second.source = SnapshotSource::ManualEntry;
        let timeline = HoldingsTimeline::new(Some(start), end, vec![first, second], None, false);
        let account = holdings_prepared_account(timeline);

        let quote_facts = [("2026-06-01", dec!(50)), ("2026-06-05", dec!(51))]
            .into_iter()
            .map(|(quote_date, close)| ValuationQuoteFact {
                timestamp: activity_time(quote_date),
                close,
                currency: "USD".to_string(),
            })
            .collect();
        let facts = SharedValuationFacts {
            quotes_by_asset: HashMap::from([("AAPL".to_string(), quote_facts)]),
            assets_with_quotes: HashSet::from(["AAPL".to_string()]),
            split_events: vec![QuoteAdjustedSplitEvent {
                asset_id: "AAPL".to_string(),
                split_date: date("2026-06-04"),
                ratio: dec!(2),
            }],
            fx_rates_by_pair: BTreeMap::new(),
        };

        let valuations = ValuationService::calculate_prepared_valuation_account_from_facts(
            account,
            &facts,
            Some(&HashMap::new()),
        )
        .expect("valuation should succeed")
        .valuations;

        // Old keyframe at 06-06: 10 x 51 x 2 = new keyframe 20 x 51 = 1020.
        let transition = valuations
            .iter()
            .find(|valuation| valuation.valuation_date == date("2026-06-06"))
            .expect("transition day should be present");
        assert_eq!(transition.total_value_base, dec!(1020));
        assert_eq!(transition.external_inflow_base, Decimal::ZERO);
        assert_eq!(transition.external_outflow_base, Decimal::ZERO);
        assert_eq!(transition.external_flow_source, ExternalFlowSource::NoFlow);
    }

    #[test]
    fn holdings_keyframe_transition_with_unpriced_position_marks_flow_unknown() {
        // 06-04 snapshot buys an asset that has no quotes at all with existing
        // cash. Neither side of the transition can be fully priced, so no
        // explicit flow may be inferred: the cash-funded buy must not read as
        // a withdrawal (and the asset's later quote arrival as gain). The
        // transition is marked Unknown so period performance reports as
        // unavailable instead.
        let start = date("2026-06-01");
        let end = date("2026-06-06");
        let mut first = snapshot_with_position("2026-06-01", "AAPL", dec!(10));
        first.source = SnapshotSource::ManualEntry;
        first.cash_balances = HashMap::from([("USD".to_string(), dec!(500))]);
        let mut second = snapshot_with_position("2026-06-04", "AAPL", dec!(10));
        second.source = SnapshotSource::ManualEntry;
        second.positions.insert(
            "PRIVATE-CO".to_string(),
            Position {
                id: "POS-PRIVATE-CO-account-1".to_string(),
                account_id: "account-1".to_string(),
                asset_id: "PRIVATE-CO".to_string(),
                quantity: dec!(5),
                average_cost: dec!(100),
                total_cost_basis: dec!(500),
                currency: "USD".to_string(),
                inception_date: activity_time("2026-06-04"),
                ..Position::default()
            },
        );
        let timeline = HoldingsTimeline::new(Some(start), end, vec![first, second], None, false);
        let account = holdings_prepared_account(timeline);
        let facts = holdings_quote_facts();

        let valuations = ValuationService::calculate_prepared_valuation_account_from_facts(
            account,
            &facts,
            Some(&HashMap::new()),
        )
        .expect("valuation should succeed")
        .valuations;

        let transition = valuations
            .iter()
            .find(|valuation| valuation.valuation_date == date("2026-06-04"))
            .expect("transition day should be present");
        assert_eq!(transition.external_inflow_base, Decimal::ZERO);
        assert_eq!(transition.external_outflow_base, Decimal::ZERO);
        assert_eq!(
            transition.external_flow_source,
            ExternalFlowSource::UnpricedHoldingsTransition
        );
    }

    #[test]
    fn holdings_pipeline_keyframes_to_period_performance_excludes_deposit() {
        // Full pipeline: keyframes -> daily valuations (with inferred flows)
        // -> dated-range performance. This crosses the layer seam where unit
        // tests hand-build valuation rows and can silently disagree with what
        // the builder actually produces.
        let start = date("2026-06-01");
        let end = date("2026-06-06");
        let mut first = snapshot_with_position("2026-06-01", "AAPL", dec!(10));
        first.source = SnapshotSource::ManualEntry;
        // Mid-period: buy 10 more shares and deposit 300 cash.
        let mut second = snapshot_with_position("2026-06-04", "AAPL", dec!(20));
        second.source = SnapshotSource::ManualEntry;
        second.cash_balances = HashMap::from([("USD".to_string(), dec!(300))]);
        let timeline = HoldingsTimeline::new(Some(start), end, vec![first, second], None, false);
        let account = holdings_prepared_account(timeline);

        let quote_facts = [
            ("2026-06-01", dec!(100)),
            ("2026-06-03", dec!(102)),
            ("2026-06-05", dec!(105)),
        ]
        .into_iter()
        .map(|(quote_date, close)| ValuationQuoteFact {
            timestamp: activity_time(quote_date),
            close,
            currency: "USD".to_string(),
        })
        .collect();
        let facts = SharedValuationFacts {
            quotes_by_asset: HashMap::from([("AAPL".to_string(), quote_facts)]),
            assets_with_quotes: HashSet::from(["AAPL".to_string()]),
            split_events: Vec::new(),
            fx_rates_by_pair: BTreeMap::new(),
        };

        let valuations = ValuationService::calculate_prepared_valuation_account_from_facts(
            account,
            &facts,
            Some(&HashMap::new()),
        )
        .expect("valuation should succeed")
        .valuations;

        let result =
            crate::portfolio::performance::PerformanceService::compute_account_performance(
                &valuations,
                Some(crate::accounts::TrackingMode::Holdings),
                Some(start),
                true,
            )
            .expect("performance should compute");

        // Only price movement counts: 10 sh x (105 - 100) + 10 new sh x
        // (105 - 102) = 80. The 1,320 deposit-buy plus 300 cash deposit
        // (inferred flow 1,320 at the 06-04 quote) is excluded.
        assert_eq!(result.summary.amount, Some(dec!(80)));
        // Chained daily returns: 1.02 x (2400 / 2340) - 1.
        assert_eq!(
            result.returns.value_return.unwrap().round_dp(4),
            dec!(0.0462)
        );
        // Headline percent equals the chart's final point.
        let last_series_point = result.series.last().expect("series should be present");
        assert_eq!(
            last_series_point.value.round_dp(4),
            result.returns.value_return.unwrap().round_dp(4)
        );
    }

    #[test]
    fn holdings_split_transition_infers_no_flow_for_any_snapshot_delay() {
        // The split invariant must hold wherever the split falls relative to
        // the next snapshot: recorded the same day or days late. Sweeping the
        // gap guards the whole input space, not one sampled scenario.
        for gap_days in 0..=3u32 {
            let start = date("2026-06-01");
            let end = date("2026-06-08");
            let snapshot_date = format!("2026-06-{:02}", 4 + gap_days);
            let mut first = snapshot_with_position("2026-06-01", "AAPL", dec!(10));
            first.source = SnapshotSource::ManualEntry;
            let mut second = snapshot_with_position(&snapshot_date, "AAPL", dec!(20));
            second.source = SnapshotSource::ManualEntry;
            let timeline =
                HoldingsTimeline::new(Some(start), end, vec![first, second], None, false);
            let account = holdings_prepared_account(timeline);

            let quote_facts = [("2026-06-01", dec!(50)), ("2026-06-03", dec!(51))]
                .into_iter()
                .map(|(quote_date, close)| ValuationQuoteFact {
                    timestamp: activity_time(quote_date),
                    close,
                    currency: "USD".to_string(),
                })
                .collect();
            let facts = SharedValuationFacts {
                quotes_by_asset: HashMap::from([("AAPL".to_string(), quote_facts)]),
                assets_with_quotes: HashSet::from(["AAPL".to_string()]),
                split_events: vec![QuoteAdjustedSplitEvent {
                    asset_id: "AAPL".to_string(),
                    split_date: date("2026-06-04"),
                    ratio: dec!(2),
                }],
                fx_rates_by_pair: BTreeMap::new(),
            };

            let valuations = ValuationService::calculate_prepared_valuation_account_from_facts(
                account,
                &facts,
                Some(&HashMap::new()),
            )
            .expect("valuation should succeed")
            .valuations;

            let transition = valuations
                .iter()
                .find(|valuation| valuation.valuation_date == date(&snapshot_date))
                .expect("transition day should be present");
            assert_eq!(
                transition.external_inflow_base,
                Decimal::ZERO,
                "no inflow for split-to-snapshot gap of {gap_days} day(s)"
            );
            assert_eq!(
                transition.external_outflow_base,
                Decimal::ZERO,
                "no outflow for split-to-snapshot gap of {gap_days} day(s)"
            );
            assert_eq!(
                transition.external_flow_source,
                ExternalFlowSource::NoFlow,
                "no flow source for split-to-snapshot gap of {gap_days} day(s)"
            );
        }
    }

    #[test]
    fn aggregate_flow_stamping_preserves_unavailable_provenance() {
        // A zero-amount Unknown marker (unpriceable holdings transition summed
        // into an aggregate row) must survive both stamping variants when
        // preserve_unavailable is set — relabeling it NoFlow would let scoped
        // performance report a number from incomplete data.
        let mut values = vec![
            valuation(
                "agg",
                "2026-05-01",
                dec!(100),
                dec!(100),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            valuation(
                "agg",
                "2026-05-02",
                dec!(110),
                dec!(100),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
        ];
        values[1].external_flow_source = ExternalFlowSource::UnpricedHoldingsTransition;

        ValuationService::set_external_flows_from_net_contribution_base(&mut values, true);
        assert_eq!(
            values[1].external_flow_source,
            ExternalFlowSource::UnpricedHoldingsTransition
        );
        assert_eq!(values[1].external_inflow_base, Decimal::ZERO);

        // The activity-map variant is sticky too when the map has no entry
        // for the day (always the case for holdings-only scopes, which have
        // no activities).
        ValuationService::set_external_flows_from_activity_map_or_net_contribution_base(
            &mut values,
            &HashMap::new(),
            true,
        );
        assert_eq!(
            values[1].external_flow_source,
            ExternalFlowSource::UnpricedHoldingsTransition
        );
        assert_eq!(values[1].external_inflow_base, Decimal::ZERO);

        // An authoritative activity flow for the day still wins: scope-aware
        // flow inputs deliberately resolve unknown boundaries.
        let flows = HashMap::from([(
            date("2026-05-02"),
            DailyFlowAmounts {
                inflow: dec!(10),
                outflow: Decimal::ZERO,
                source: ExternalFlowSource::CashAmount,
            },
        )]);
        ValuationService::set_external_flows_from_activity_map_or_net_contribution_base(
            &mut values,
            &flows,
            true,
        );
        assert_eq!(
            values[1].external_flow_source,
            ExternalFlowSource::CashAmount
        );
        assert_eq!(values[1].external_inflow_base, dec!(10));
    }

    #[test]
    fn calculated_keyframe_transitions_do_not_infer_flows() {
        // Transactions-mode keyframes (source Calculated) must never receive
        // inferred flows: their flows come from activities.
        let start = date("2026-06-01");
        let end = date("2026-06-06");
        let first = snapshot_with_position("2026-06-01", "AAPL", dec!(10));
        let second = snapshot_with_position("2026-06-04", "AAPL", dec!(20));
        let timeline = HoldingsTimeline::new(Some(start), end, vec![first, second], None, false);

        let valuations = ValuationService::calculate_prepared_valuation_account_from_facts(
            holdings_prepared_account(timeline),
            &holdings_quote_facts(),
            Some(&HashMap::new()),
        )
        .expect("valuation should succeed")
        .valuations;

        let transition = valuations
            .iter()
            .find(|valuation| valuation.valuation_date == date("2026-06-04"))
            .expect("transition day should be present");
        assert_eq!(transition.external_inflow_base, Decimal::ZERO);
        assert_eq!(transition.external_flow_source, ExternalFlowSource::NoFlow);
    }

    #[test]
    fn single_account_result_preserves_the_original_error_kind() {
        let execution = ValuationBatchExecution {
            outcome: ValuationBatchOutcome::default(),
            account_errors: HashMap::from([(
                "account-1".to_string(),
                CoreError::Repository("repository unavailable".to_string()),
            )]),
            global_error: None,
        };

        let error = ValuationService::single_account_result(execution, "account-1")
            .expect_err("account failure should be returned");

        assert!(
            matches!(error, CoreError::Repository(message) if message == "repository unavailable")
        );
    }

    #[test]
    fn shared_fact_failure_keeps_prepare_diagnostics_in_the_batch_outcome() {
        let prior_failure = ValuationAccountFailure {
            account_id: "poisoned-account".to_string(),
            code: "INVALID_SNAPSHOT_DATE".to_string(),
            message: "invalid snapshot date".to_string(),
            date: Some(date("1969-12-31")),
            min_date: Some(date("1970-01-01")),
            max_date: Some(date("2026-08-07")),
            snapshot_source: Some("CSV_IMPORT".to_string()),
        };
        let prepared = PreparedValuationAccount {
            account_id: "prepared-account".to_string(),
            timeline: HoldingsTimeline::new(None, date("2026-08-05"), Vec::new(), None, false),
            incremental_anchor_date: None,
            replace_since_date: None,
            required_asset_ids: HashSet::new(),
            required_fx_pairs: HashSet::new(),
            acquisition_fx_requests: HashSet::new(),
            base_currency: "USD".to_string(),
            account_currency: "USD".to_string(),
        };

        let execution = ValuationService::fact_loading_failure_execution(
            ValuationBatchOutcome {
                successful_accounts: Vec::new(),
                failures: vec![prior_failure],
            },
            HashMap::new(),
            &[prepared],
            CoreError::Repository("quote facts unavailable".to_string()),
        );

        assert_eq!(execution.outcome.failures.len(), 2);
        assert!(execution.outcome.failures.iter().any(|failure| {
            failure.account_id == "poisoned-account" && failure.code == "INVALID_SNAPSHOT_DATE"
        }));
        assert!(execution.outcome.failures.iter().any(|failure| {
            failure.account_id == "prepared-account"
                && failure.code == "VALUATION_FACT_LOADING_FAILED"
        }));
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
            false,
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
            false,
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
            false,
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
        // Netting only subtracts; the row keeps the provenance it had before
        // (the stored-gross marker the fixture rows carry), never a stamped one.
        assert_eq!(
            aggregate[1].external_flow_source,
            ExternalFlowSource::StoredGross
        );
    }

    /// Two-account scope where an internal transfer moves 100 from `a1` to
    /// `a2` on 2026-05-02 and every per-account leg carries `source`.
    fn internal_transfer_histories(source: ExternalFlowSource) -> Vec<Vec<DailyAccountValuation>> {
        let mut out_leg = valuation(
            "a1",
            "2026-05-02",
            Decimal::ZERO,
            Decimal::ZERO,
            Decimal::ZERO,
            dec!(100),
        );
        out_leg.external_flow_source = source;
        let mut in_leg = valuation(
            "a2",
            "2026-05-02",
            dec!(100),
            dec!(100),
            dec!(100),
            Decimal::ZERO,
        );
        in_leg.external_flow_source = source;
        vec![
            vec![
                valuation(
                    "a1",
                    "2026-05-01",
                    dec!(100),
                    dec!(100),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
                out_leg,
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
                in_leg,
            ],
        ]
    }

    fn internal_transfer_adjustments() -> HashMap<NaiveDate, (Decimal, Decimal)> {
        let flow_date = NaiveDate::parse_from_str("2026-05-02", "%Y-%m-%d").unwrap();
        HashMap::from([(flow_date, (dec!(100), dec!(100)))])
    }

    // Issue #1609, defect 2: an in-kind transfer whose both legs sit inside the
    // scope never reaches the authoritative activity map, so the netting pass
    // runs. It must leave the quote-derived provenance alone instead of
    // stamping CashAmount and manufacturing a degraded Mixed day.
    #[test]
    fn netting_keeps_quote_derived_source_for_in_kind_internal_transfer() {
        let account_ids = vec!["a1".to_string(), "a2".to_string()];
        let no_authoritative_flows: HashMap<NaiveDate, DailyFlowAmounts> = HashMap::new();
        let adjustments = internal_transfer_adjustments();

        let aggregate = ValuationService::aggregate_scoped_valuations(
            "accounts:test",
            &account_ids,
            "USD",
            internal_transfer_histories(ExternalFlowSource::QuoteDerivedMarketValue),
            Some(&no_authoritative_flows),
            Some(&adjustments),
        )
        .expect("complete scoped histories should aggregate");

        assert_eq!(aggregate[1].external_inflow_base, Decimal::ZERO);
        assert_eq!(aggregate[1].external_outflow_base, Decimal::ZERO);
        assert_eq!(
            aggregate[1].external_flow_source,
            ExternalFlowSource::QuoteDerivedMarketValue
        );
        assert!(!aggregate[1].external_flow_source.is_degraded());
        assert!(!aggregate[1]
            .external_flow_source
            .is_unavailable_for_returns());
    }

    #[test]
    fn netting_keeps_cash_source_for_cash_internal_transfer() {
        let account_ids = vec!["a1".to_string(), "a2".to_string()];
        let no_authoritative_flows: HashMap<NaiveDate, DailyFlowAmounts> = HashMap::new();
        let adjustments = internal_transfer_adjustments();

        let aggregate = ValuationService::aggregate_scoped_valuations(
            "accounts:test",
            &account_ids,
            "USD",
            internal_transfer_histories(ExternalFlowSource::CashAmount),
            Some(&no_authoritative_flows),
            Some(&adjustments),
        )
        .expect("complete scoped histories should aggregate");

        assert_eq!(aggregate[1].external_inflow_base, Decimal::ZERO);
        assert_eq!(aggregate[1].external_outflow_base, Decimal::ZERO);
        assert_eq!(
            aggregate[1].external_flow_source,
            ExternalFlowSource::CashAmount
        );
        assert!(!aggregate[1].external_flow_source.is_degraded());
    }

    // Absorbing markers must survive the netting pass untouched: it may only
    // shrink amounts, never relabel a day that still gates returns.
    #[test]
    fn netting_preserves_absorbing_sources() {
        for source in [
            ExternalFlowSource::Unknown,
            ExternalFlowSource::UnknownBoundaryTransfer,
            ExternalFlowSource::UnpricedHoldingsTransition,
            ExternalFlowSource::RemovedLotBasisFallback,
        ] {
            let mut histories = internal_transfer_histories(ExternalFlowSource::CashAmount);
            histories[0][1].external_flow_source = source;
            let account_ids = vec!["a1".to_string(), "a2".to_string()];
            let no_authoritative_flows: HashMap<NaiveDate, DailyFlowAmounts> = HashMap::new();
            let adjustments = internal_transfer_adjustments();

            let aggregate = ValuationService::aggregate_scoped_valuations(
                "accounts:test",
                &account_ids,
                "USD",
                histories,
                Some(&no_authoritative_flows),
                Some(&adjustments),
            )
            .expect("complete scoped histories should aggregate");

            assert_eq!(
                aggregate[1].external_flow_source, source,
                "netting must not relabel {source:?}",
            );
        }
    }

    // A quiet day (no stored flows, no net-contribution movement) that happens
    // to have an adjustment entry stays NoFlow; it used to be stamped CashAmount.
    #[test]
    fn netting_leaves_no_flow_row_untouched() {
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
                    dec!(50),
                    dec!(50),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
            ],
        ];
        let account_ids = vec!["a1".to_string(), "a2".to_string()];
        let no_authoritative_flows: HashMap<NaiveDate, DailyFlowAmounts> = HashMap::new();
        let adjustments = internal_transfer_adjustments();

        let aggregate = ValuationService::aggregate_scoped_valuations(
            "accounts:test",
            &account_ids,
            "USD",
            histories,
            Some(&no_authoritative_flows),
            Some(&adjustments),
        )
        .expect("complete scoped histories should aggregate");

        assert_eq!(aggregate[1].external_inflow_base, Decimal::ZERO);
        assert_eq!(aggregate[1].external_outflow_base, Decimal::ZERO);
        assert_eq!(
            aggregate[1].external_flow_source,
            ExternalFlowSource::NoFlow
        );
    }

    // Legacy rows (pre-compiler `UNKNOWN` with empty flow columns) fall back to
    // the net-contribution delta. The netting pass must not promote that
    // fallback to an explicit-gross Mixed row, or the performance layer would
    // trust the floored amounts instead of re-deriving the delta.
    #[test]
    fn netting_leaves_net_contribution_fallback_row_untouched() {
        let legacy = |account_id: &str, date: &str, total: Decimal| {
            let mut row = valuation(account_id, date, total, total, Decimal::ZERO, Decimal::ZERO);
            row.external_flow_source = ExternalFlowSource::Unknown;
            row
        };
        let histories = vec![
            vec![
                legacy("a1", "2026-05-01", dec!(100)),
                legacy("a1", "2026-05-02", Decimal::ZERO),
            ],
            vec![
                legacy("a2", "2026-05-01", Decimal::ZERO),
                legacy("a2", "2026-05-02", dec!(100)),
            ],
            vec![
                legacy("a3", "2026-05-01", Decimal::ZERO),
                legacy("a3", "2026-05-02", dec!(50)),
            ],
        ];
        let account_ids = vec!["a1".to_string(), "a2".to_string(), "a3".to_string()];
        let no_authoritative_flows: HashMap<NaiveDate, DailyFlowAmounts> = HashMap::new();
        let adjustments = internal_transfer_adjustments();

        let aggregate = ValuationService::aggregate_scoped_valuations(
            "accounts:test",
            &account_ids,
            "USD",
            histories,
            Some(&no_authoritative_flows),
            Some(&adjustments),
        )
        .expect("complete scoped histories should aggregate");

        assert_eq!(
            aggregate[1].external_flow_source,
            ExternalFlowSource::NetContributionFallback
        );
        assert!(!aggregate[1].external_flow_source.is_explicit_gross());
    }

    // Issue #1609 "Evidence": the same transfer day must not flip between
    // degraded and clean depending on which unrelated accounts share the
    // scope. P = {a1, a2} runs the netting pass; Q = {a1, a2, a3} has an
    // unrelated cash withdrawal that makes the day authoritative and skips it.
    #[test]
    fn netting_is_deterministic_across_scope_membership() {
        let flow_date = NaiveDate::parse_from_str("2026-05-02", "%Y-%m-%d").unwrap();
        let adjustments = internal_transfer_adjustments();

        let smaller_scope_ids = vec!["a1".to_string(), "a2".to_string()];
        let no_authoritative_flows: HashMap<NaiveDate, DailyFlowAmounts> = HashMap::new();
        let smaller_scope = ValuationService::aggregate_scoped_valuations(
            "accounts:p",
            &smaller_scope_ids,
            "USD",
            internal_transfer_histories(ExternalFlowSource::QuoteDerivedMarketValue),
            Some(&no_authoritative_flows),
            Some(&adjustments),
        )
        .expect("complete scoped histories should aggregate");

        let mut withdrawal_day = valuation(
            "a3",
            "2026-05-02",
            dec!(50),
            dec!(50),
            Decimal::ZERO,
            dec!(50),
        );
        withdrawal_day.external_flow_source = ExternalFlowSource::CashAmount;
        let mut superset_histories =
            internal_transfer_histories(ExternalFlowSource::QuoteDerivedMarketValue);
        superset_histories.push(vec![
            valuation(
                "a3",
                "2026-05-01",
                dec!(100),
                dec!(100),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            withdrawal_day,
        ]);
        let superset_scope_ids = vec!["a1".to_string(), "a2".to_string(), "a3".to_string()];
        let authoritative_flows = HashMap::from([(
            flow_date,
            DailyFlowAmounts {
                inflow: Decimal::ZERO,
                outflow: dec!(50),
                source: ExternalFlowSource::CashAmount,
            },
        )]);
        let superset_scope = ValuationService::aggregate_scoped_valuations(
            "accounts:q",
            &superset_scope_ids,
            "USD",
            superset_histories,
            Some(&authoritative_flows),
            Some(&adjustments),
        )
        .expect("complete scoped histories should aggregate");

        assert_eq!(
            smaller_scope[1].external_flow_source,
            ExternalFlowSource::QuoteDerivedMarketValue
        );
        assert_eq!(smaller_scope[1].external_outflow_base, Decimal::ZERO);
        assert_eq!(
            superset_scope[1].external_flow_source,
            ExternalFlowSource::CashAmount
        );
        assert_eq!(superset_scope[1].external_outflow_base, dec!(50));
        assert!(!smaller_scope[1].external_flow_source.is_degraded());
        assert!(!superset_scope[1].external_flow_source.is_degraded());
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

        ValuationService::set_external_flows_from_net_contribution_base(&mut values, false);

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
            false,
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

        ValuationService::set_external_flows_from_net_contribution_base(&mut values, false);
        values.retain(|valuation| valuation.valuation_date != anchor_date);

        assert_eq!(values.len(), 1);
        assert_eq!(values[0].valuation_date.to_string(), "2026-05-02");
        assert_eq!(values[0].external_inflow_base, dec!(25));
        assert_eq!(values[0].external_outflow_base, Decimal::ZERO);
    }
}
