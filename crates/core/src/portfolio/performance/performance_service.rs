use crate::accounts::{account_types, Account, TrackingMode};
use crate::activities::{Activity, ActivityRepositoryTrait, ActivityType, TransferPairResolution};
use crate::constants::DECIMAL_PRECISION;
use crate::errors::{self, Result, ValidationError};
use crate::fx::FxServiceTrait;
use crate::lots::{LotDisposal, LotRecord, LotRepositoryTrait};
use crate::performance::ReturnData;
use crate::portfolio::economic_events::{
    ActivityEconomicsResolver, BasisStatus, EconomicEventEffect, EconomicEventKind,
    TransferBoundary,
};
use crate::quotes::QuoteServiceTrait;
use crate::utils::occ_symbol::looks_like_occ_symbol;
use crate::utils::time_utils::{activity_date_in_tz, parse_user_timezone_or_default, user_today};
use crate::valuation::ValuationServiceTrait;

use async_trait::async_trait;
use chrono::{DateTime, Duration, NaiveDate, Utc};
use futures::stream::{self, StreamExt};
use num_traits::ToPrimitive;
use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use std::sync::{Arc, RwLock};
use std::time::Instant;

use log::{debug, warn};
use rust_decimal::prelude::FromPrimitive;
use rust_decimal::Decimal;
use rust_decimal::MathematicalOps;
use rust_decimal_macros::dec;

use super::{
    empty_performance_metrics, is_external_transfer, performance_account_ids_from_map,
    performance_account_tracking_modes_from_map, performance_account_types_from_map,
    performance_summary_scope_key, performance_tracking_composition,
    sync_performance_summary_quality, unavailable_performance_metrics, DataQualityStatus,
    PerformanceAttribution, PerformanceDataQuality, PerformancePeriod, PerformanceResult,
    PerformanceReturns, PerformanceRisk, PerformanceScopeDescriptor, PerformanceSummary,
    PerformanceSummaryBasis, PerformanceSummaryBatchResult, PerformanceSummaryBatchScope,
    PerformanceSummaryProfile, PerformanceSummaryScopeTiming, PerformanceSummaryStatus,
    ReturnMethod, SimplePerformanceMetrics,
};
use crate::portfolio::valuation::{
    DailyAccountValuation, ExternalFlowSource as ValuationExternalFlowSource,
};

#[allow(clippy::too_many_arguments)]
#[async_trait]
pub trait PerformanceServiceTrait: Send + Sync {
    async fn calculate_performance_history(
        &self,
        item_type: &str,
        item_id: &str,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
        tracking_mode: Option<TrackingMode>,
        account_type: Option<&str>,
    ) -> Result<PerformanceResult>;

    async fn calculate_performance_history_for_accounts(
        &self,
        scope_id: &str,
        account_ids: &[String],
        base_currency: &str,
        account_tracking_modes: &HashMap<String, TrackingMode>,
        account_types: &HashMap<String, String>,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
    ) -> Result<PerformanceResult>;

    async fn calculate_performance_summary(
        &self,
        item_type: &str,
        item_id: &str,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
        tracking_mode: Option<TrackingMode>,
        account_type: Option<&str>,
        profile: PerformanceSummaryProfile,
    ) -> Result<PerformanceResult>;

    #[allow(clippy::too_many_arguments)]
    async fn calculate_performance_summary_for_accounts(
        &self,
        scope_id: &str,
        account_ids: &[String],
        base_currency: &str,
        account_tracking_modes: &HashMap<String, TrackingMode>,
        account_types: &HashMap<String, String>,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
        profile: PerformanceSummaryProfile,
    ) -> Result<PerformanceResult>;

    /// Calculates lightweight account performance metrics (cumulative returns and portfolio weights) for multiple accounts.
    /// This method efficiently fetches the latest and previous day's valuations in bulk to minimize database queries.
    /// Can be used for a single account by passing a slice with one ID.
    fn calculate_accounts_simple_performance(
        &self,
        account_ids: &[String],
    ) -> Result<Vec<SimplePerformanceMetrics>>;
}

pub const PERFORMANCE_SUMMARY_BATCH_PARALLELISM: usize = 4;

struct PerformanceSummaryBatchScopeResult {
    key: String,
    result: PerformanceResult,
    timing: PerformanceSummaryScopeTiming,
}

pub async fn calculate_performance_summary_batch_for_accounts<T>(
    performance_service: Arc<T>,
    scopes: Vec<PerformanceSummaryBatchScope>,
    accounts_by_id: HashMap<String, Account>,
    base_currency: String,
    start_date: Option<NaiveDate>,
    end_date: Option<NaiveDate>,
    profile: PerformanceSummaryProfile,
) -> PerformanceSummaryBatchResult
where
    T: PerformanceServiceTrait + ?Sized + 'static,
{
    let total_scope_count = scopes.len();
    let batch_start = Instant::now();
    let mut results = HashMap::new();
    let mut scope_results = stream::iter(scopes.into_iter().enumerate())
        .map(|(scope_index, scope)| {
            let performance_service = Arc::clone(&performance_service);
            let accounts_by_id = accounts_by_id.clone();
            let base_currency = base_currency.clone();
            async move {
                let key = performance_summary_scope_key(&scope.account_ids);
                let account_ids =
                    performance_account_ids_from_map(&accounts_by_id, &scope.account_ids);
                let scope_start = Instant::now();

                if account_ids.is_empty() {
                    let mut result = empty_performance_metrics(
                        &key,
                        base_currency.clone(),
                        start_date,
                        end_date,
                    );
                    if !scope.account_ids.is_empty() {
                        result.data_quality.warnings.push(
                            "Requested accounts were excluded because they are archived or not eligible for performance."
                                .to_string(),
                        );
                        sync_performance_summary_quality(&mut result);
                    }
                    let timing = PerformanceSummaryScopeTiming {
                        index: scope_index + 1,
                        total: total_scope_count,
                        key: key.clone(),
                        requested_accounts: scope.account_ids.len(),
                        eligible_accounts: 0,
                        tracking_composition: "none".to_string(),
                        warnings: result.data_quality.warnings.len(),
                        skipped: true,
                        failed: false,
                        elapsed_ms: scope_start.elapsed().as_secs_f64() * 1000.0,
                    };
                    return PerformanceSummaryBatchScopeResult {
                        key,
                        result,
                        timing,
                    };
                }

                let tracking_modes =
                    performance_account_tracking_modes_from_map(&accounts_by_id, &account_ids);
                let account_types =
                    performance_account_types_from_map(&accounts_by_id, &account_ids);
                let tracking_composition =
                    performance_tracking_composition(&tracking_modes, &account_ids);
                let requested_account_count = scope.account_ids.len();
                let handle = tokio::runtime::Handle::current();
                let key_for_task = key.clone();
                let account_ids_for_task = account_ids.clone();
                let base_currency_for_task = base_currency.clone();
                let tracking_modes_for_task = tracking_modes.clone();
                let account_types_for_task = account_types.clone();
                let calculation = match tokio::task::spawn_blocking(move || {
                    handle.block_on(async move {
                        performance_service
                            .calculate_performance_summary_for_accounts(
                                &key_for_task,
                                &account_ids_for_task,
                                &base_currency_for_task,
                                &tracking_modes_for_task,
                                &account_types_for_task,
                                start_date,
                                end_date,
                                profile,
                            )
                            .await
                    })
                })
                .await
                {
                    Ok(result) => result
                        .map_err(|e| format!("Failed to calculate performance summary: {}", e)),
                    Err(error) => Err(format!(
                        "Failed to join performance summary calculation for {}: {}",
                        key, error
                    )),
                };

                let mut result = match calculation {
                    Ok(result) => result,
                    Err(error) => {
                        let mut result = unavailable_performance_metrics(
                            &key,
                            base_currency.clone(),
                            start_date,
                            end_date,
                            format!("Performance unavailable for this scope: {error}"),
                        );
                        result.data_quality.status = DataQualityStatus::Partial;
                        sync_performance_summary_quality(&mut result);
                        let timing = PerformanceSummaryScopeTiming {
                            index: scope_index + 1,
                            total: total_scope_count,
                            key: key.clone(),
                            requested_accounts: requested_account_count,
                            eligible_accounts: account_ids.len(),
                            tracking_composition,
                            warnings: result.data_quality.warnings.len(),
                            skipped: false,
                            failed: true,
                            elapsed_ms: scope_start.elapsed().as_secs_f64() * 1000.0,
                        };
                        return PerformanceSummaryBatchScopeResult {
                            key,
                            result,
                            timing,
                        };
                    }
                };

                if account_ids.len() != requested_account_count {
                    result.data_quality.warnings.push(
                        "Some requested accounts were excluded because they are archived or not eligible for performance."
                            .to_string(),
                    );
                    result.data_quality.status = DataQualityStatus::Partial;
                    sync_performance_summary_quality(&mut result);
                }

                let timing = PerformanceSummaryScopeTiming {
                    index: scope_index + 1,
                    total: total_scope_count,
                    key: key.clone(),
                    requested_accounts: requested_account_count,
                    eligible_accounts: account_ids.len(),
                    tracking_composition,
                    warnings: result.data_quality.warnings.len(),
                    skipped: false,
                    failed: false,
                    elapsed_ms: scope_start.elapsed().as_secs_f64() * 1000.0,
                };
                PerformanceSummaryBatchScopeResult {
                    key,
                    result,
                    timing,
                }
            }
        })
        .buffer_unordered(PERFORMANCE_SUMMARY_BATCH_PARALLELISM);

    let mut failed_scope_count = 0usize;
    let mut scope_timings = Vec::new();
    while let Some(scope_result) = scope_results.next().await {
        if scope_result.timing.failed {
            failed_scope_count += 1;
        }
        scope_timings.push(scope_result.timing);
        results.insert(scope_result.key, scope_result.result);
    }

    PerformanceSummaryBatchResult {
        results,
        failed_scope_count,
        scope_timings,
        elapsed_ms: batch_start.elapsed().as_secs_f64() * 1000.0,
    }
}

pub struct PerformanceService {
    valuation_service: Arc<dyn ValuationServiceTrait + Send + Sync>,
    quote_service: Arc<dyn QuoteServiceTrait + Send + Sync>,
    timezone: Arc<RwLock<String>>,
    lot_repository: Option<Arc<dyn LotRepositoryTrait>>,
    activity_repository: Option<Arc<dyn ActivityRepositoryTrait>>,
    fx_service: Option<Arc<dyn FxServiceTrait>>,
}

const DAYS_PER_YEAR_DECIMAL: Decimal = dec!(365.25);
const SQRT_DAYS_PER_YEAR_APPROX: Decimal = dec!(19.111514854); // sqrt(365.25)
const MIN_ANNUALIZATION_DAYS: i64 = 30;
const ATTRIBUTION_RESIDUAL_TOLERANCE_RATE: Decimal = dec!(0.002);
const ATTRIBUTION_RESIDUAL_LEGACY_WARNING_PREFIX: &str = "Attribution residual ";
const ATTRIBUTION_INCOMPLETE_WARNING_PREFIX: &str = "Performance attribution is incomplete";

fn parse_decimal_lossy(value: &str) -> Decimal {
    value.parse::<Decimal>().unwrap_or(Decimal::ZERO)
}

#[derive(Clone, Copy, Debug)]
struct DailyReturnSample {
    twr: Decimal,
    cumulative_twr_to_date: Decimal,
    excluded_from_compounding: bool,
}

#[derive(Clone, Copy, Debug)]
struct RiskSample {
    date: NaiveDate,
    simple_return: Decimal,
}

#[derive(Clone, Debug)]
struct TwrComputation {
    cumulative_twr: Option<Decimal>,
    samples: Vec<(NaiveDate, DailyReturnSample)>,
    warnings: Vec<String>,
    not_applicable_reasons: Vec<String>,
}

#[derive(Clone, Debug)]
struct IrrComputation {
    annualized_irr: Option<Decimal>,
    warnings: Vec<String>,
    not_applicable_reasons: Vec<String>,
}

#[derive(Clone, Debug)]
struct DrawdownComputation {
    max_drawdown: Option<Decimal>,
    peak_date: Option<NaiveDate>,
    trough_date: Option<NaiveDate>,
    recovery_date: Option<NaiveDate>,
    duration_days: Option<i64>,
}

#[derive(Clone, Debug)]
struct ScopedUnrealizedAttribution {
    unrealized_pnl_change: Decimal,
    fx_effect: Decimal,
    warnings: Vec<String>,
    complete: bool,
}

struct ScopedPerformanceRequest<'a> {
    scope_id: &'a str,
    account_ids: &'a [String],
    base_currency: &'a str,
    account_tracking_modes: &'a HashMap<String, TrackingMode>,
    account_types: &'a HashMap<String, String>,
    start_date: Option<NaiveDate>,
    end_date: Option<NaiveDate>,
    include_returns_series: bool,
    profile: PerformanceSummaryProfile,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ScopedTrackingComposition {
    TransactionsOnly,
    HoldingsOnly,
    Mixed,
}

struct MixedScopeAccountHistory<'a> {
    account_id: &'a str,
    tracking_mode: TrackingMode,
    account_type: Option<&'a str>,
    history: &'a [DailyAccountValuation],
}

#[derive(Clone, Debug)]
struct MixedScopeComponentMetrics {
    account_id: String,
    start_date: NaiveDate,
    end_date: NaiveDate,
    amount: Option<Decimal>,
    denominator: Option<Decimal>,
    contributes_to_scope: bool,
    basis_status: BasisStatus,
    attribution: PerformanceAttribution,
    warnings: Vec<String>,
    not_applicable_reasons: Vec<String>,
}

#[derive(Clone, Debug)]
struct MixedScopeSeriesPoint {
    date: NaiveDate,
    amount: Decimal,
    denominator: Option<Decimal>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[allow(dead_code)]
enum ExternalFlowBasis {
    AccountCurrency,
    BaseCurrency,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AttributionBaseline {
    PeriodStart,
    Inception,
}

#[derive(Clone, Debug)]
struct AttributionEffectSet {
    effects: Vec<EconomicEventEffect>,
    warnings: Vec<String>,
    complete: bool,
}

impl Default for AttributionEffectSet {
    fn default() -> Self {
        Self {
            effects: Vec::new(),
            warnings: Vec::new(),
            complete: true,
        }
    }
}

#[derive(Clone, Debug)]
struct AttributionEffectSeed {
    include_base_market_movement: bool,
    effects: Vec<EconomicEventEffect>,
    warnings: Vec<String>,
}

impl Default for AttributionEffectSeed {
    fn default() -> Self {
        Self {
            include_base_market_movement: true,
            effects: Vec::new(),
            warnings: Vec::new(),
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct DailyExternalFlow {
    date: NaiveDate,
    inflow: Decimal,
    outflow: Decimal,
    source: ValuationExternalFlowSource,
}

impl DailyExternalFlow {
    fn net(self) -> Decimal {
        self.inflow - self.outflow
    }
}

impl PerformanceService {
    pub fn new(
        valuation_service: Arc<dyn ValuationServiceTrait + Send + Sync>,
        quote_service: Arc<dyn QuoteServiceTrait + Send + Sync>,
    ) -> Self {
        Self::new_with_timezone(
            valuation_service,
            quote_service,
            Arc::new(RwLock::new(String::new())),
        )
    }

    pub fn new_with_timezone(
        valuation_service: Arc<dyn ValuationServiceTrait + Send + Sync>,
        quote_service: Arc<dyn QuoteServiceTrait + Send + Sync>,
        timezone: Arc<RwLock<String>>,
    ) -> Self {
        Self {
            valuation_service,
            quote_service,
            timezone,
            lot_repository: None,
            activity_repository: None,
            fx_service: None,
        }
    }

    pub fn with_lot_repository(mut self, lot_repository: Arc<dyn LotRepositoryTrait>) -> Self {
        self.lot_repository = Some(lot_repository);
        self
    }

    pub fn with_activity_repository(
        mut self,
        activity_repository: Arc<dyn ActivityRepositoryTrait>,
        fx_service: Arc<dyn FxServiceTrait>,
    ) -> Self {
        self.activity_repository = Some(activity_repository);
        self.fx_service = Some(fx_service);
        self
    }

    fn empty_risk() -> PerformanceRisk {
        PerformanceRisk {
            volatility: None,
            max_drawdown: None,
            peak_date: None,
            trough_date: None,
            recovery_date: None,
            drawdown_duration_days: None,
        }
    }

    fn today_in_user_timezone(&self) -> NaiveDate {
        let tz = parse_user_timezone_or_default(&self.timezone.read().unwrap());
        user_today(tz)
    }

    fn activity_local_date(&self, activity: &Activity) -> NaiveDate {
        let tz = parse_user_timezone_or_default(&self.timezone.read().unwrap());
        activity_date_in_tz(activity.activity_date, tz)
    }

    fn activity_query_utc_bounds(
        start_date: NaiveDate,
        end_date: NaiveDate,
    ) -> (DateTime<Utc>, DateTime<Utc>) {
        let start_utc = (start_date - Duration::days(1))
            .and_hms_opt(0, 0, 0)
            .expect("midnight is valid")
            .and_utc();
        let end_exclusive_utc = (end_date + Duration::days(2))
            .and_hms_opt(0, 0, 0)
            .expect("midnight is valid")
            .and_utc();
        (start_utc, end_exclusive_utc)
    }

    // =========================================================================
    // Shared performance math
    //
    // These helpers are the single source of truth for the formulas used by
    // both the "full" and "summary" account-performance paths. Having two
    // slightly-diverging copies of this math was the root cause of the
    // dashboard-vs-account-page percentage mismatch — keep them consolidated.
    // =========================================================================

    fn compute_time_weighted_returns(
        history: &[DailyAccountValuation],
        daily_flows: &[DailyExternalFlow],
        flow_basis: ExternalFlowBasis,
    ) -> Result<TwrComputation> {
        let mut cumulative_twr_factor = Decimal::ONE;
        let mut samples = Vec::new();
        let mut warnings = Vec::new();
        let mut not_applicable_reasons = Vec::new();
        let mut chain_started = false;
        let mut warned_partial_value_coverage = false;

        for (window, flow) in history.windows(2).zip(daily_flows.iter()) {
            let prev_point = &window[0];
            let curr_point = &window[1];

            let prev_value = Self::return_total_value(prev_point, flow_basis);
            let curr_value = Self::return_total_value(curr_point, flow_basis);

            if Self::is_unavailable_external_flow_source(flow.source) {
                not_applicable_reasons.push(format!(
                    "TWR unavailable for {} because an external flow amount or transfer boundary is unknown.",
                    curr_point.valuation_date
                ));
                samples.push((
                    curr_point.valuation_date,
                    DailyReturnSample {
                        twr: Decimal::ZERO,
                        cumulative_twr_to_date: cumulative_twr_factor - Decimal::ONE,
                        excluded_from_compounding: true,
                    },
                ));
                continue;
            }

            if prev_point.value_status.is_unavailable_for_returns()
                || curr_point.value_status.is_unavailable_for_returns()
            {
                not_applicable_reasons.push(format!(
                    "TWR unavailable for {} because valuation coverage is unavailable; review missing prices or manual valuations.",
                    curr_point.valuation_date
                ));
                samples.push((
                    curr_point.valuation_date,
                    DailyReturnSample {
                        twr: Decimal::ZERO,
                        cumulative_twr_to_date: cumulative_twr_factor - Decimal::ONE,
                        excluded_from_compounding: true,
                    },
                ));
                continue;
            }

            if !warned_partial_value_coverage
                && (prev_point.value_status.is_degraded() || curr_point.value_status.is_degraded())
            {
                warnings.push(
                    "Some valuation rows exclude unpriced held positions; returns are computed on the priced subset and may not represent the full scope."
                        .to_string(),
                );
                warned_partial_value_coverage = true;
            }

            if prev_value.is_sign_negative() || curr_value.is_sign_negative() {
                not_applicable_reasons.push(format!(
                    "TWR unavailable for {} because portfolio value is negative. Review the underlying transactions, prices, and cash balances.",
                    curr_point.valuation_date
                ));
                samples.push((
                    curr_point.valuation_date,
                    DailyReturnSample {
                        twr: Decimal::ZERO,
                        cumulative_twr_to_date: cumulative_twr_factor - Decimal::ONE,
                        excluded_from_compounding: true,
                    },
                ));
                continue;
            }

            let twr_denominator = prev_value + flow.inflow;
            if !chain_started && (prev_value <= Decimal::ZERO || twr_denominator < Decimal::ONE) {
                if prev_value > Decimal::ZERO && twr_denominator < Decimal::ONE {
                    not_applicable_reasons.push(format!(
                        "TWR unavailable for {}: denominator {} is below 1 base currency unit before the return chain starts.",
                        curr_point.valuation_date, twr_denominator
                    ));
                }
                let sample = DailyReturnSample {
                    twr: Decimal::ZERO,
                    cumulative_twr_to_date: Decimal::ZERO,
                    excluded_from_compounding: true,
                };
                samples.push((curr_point.valuation_date, sample));
                continue;
            }

            chain_started = true;

            let excluded_from_compounding = twr_denominator < Decimal::ONE;
            let twr = if excluded_from_compounding {
                let reason = format!(
                    "TWR unavailable for {}: denominator {} is below 1 base currency unit.",
                    curr_point.valuation_date, twr_denominator
                );
                warn!("{}", reason);
                not_applicable_reasons.push(reason);
                Decimal::ZERO
            } else {
                let numerator = curr_value + flow.outflow - prev_value - flow.inflow;
                numerator / twr_denominator
            };

            if !excluded_from_compounding {
                cumulative_twr_factor *= Decimal::ONE + twr;
            }

            let sample = DailyReturnSample {
                twr,
                cumulative_twr_to_date: cumulative_twr_factor - Decimal::ONE,
                excluded_from_compounding,
            };
            samples.push((curr_point.valuation_date, sample));
        }

        let cumulative_twr = if !chain_started {
            not_applicable_reasons.push(
                "TWR unavailable: no period starts with positive opening value and denominator of at least 1 base currency unit.".to_string(),
            );
            None
        } else if !not_applicable_reasons.is_empty() {
            None
        } else {
            Some(cumulative_twr_factor - Decimal::ONE)
        };

        Ok(TwrComputation {
            cumulative_twr,
            samples,
            warnings,
            not_applicable_reasons,
        })
    }

    fn daily_external_flows(
        prev_point: &DailyAccountValuation,
        curr_point: &DailyAccountValuation,
        flow_basis: ExternalFlowBasis,
    ) -> DailyExternalFlow {
        let date = curr_point.valuation_date;
        let cash_flow = match flow_basis {
            ExternalFlowBasis::AccountCurrency => {
                curr_point.net_contribution - prev_point.net_contribution
            }
            ExternalFlowBasis::BaseCurrency => {
                if curr_point.external_flow_source
                    == ValuationExternalFlowSource::UnknownBoundaryTransfer
                {
                    return DailyExternalFlow {
                        date,
                        inflow: curr_point.external_inflow_base,
                        outflow: curr_point.external_outflow_base,
                        source: ValuationExternalFlowSource::UnknownBoundaryTransfer,
                    };
                }

                if curr_point.external_flow_source == ValuationExternalFlowSource::Unknown {
                    // A row only carries `Unknown` when a real flow event could not
                    // be valued (quiet days get `NoFlow`/`CashAmount`). Preserve it so
                    // the TWR/IRR availability gate fires; never synthesize it away.
                    return DailyExternalFlow {
                        date,
                        inflow: curr_point.external_inflow_base,
                        outflow: curr_point.external_outflow_base,
                        source: ValuationExternalFlowSource::Unknown,
                    };
                }

                if curr_point.external_flow_source.is_explicit_gross() {
                    return DailyExternalFlow {
                        date,
                        inflow: curr_point.external_inflow_base,
                        outflow: curr_point.external_outflow_base,
                        source: curr_point.external_flow_source,
                    };
                }

                if !curr_point.external_inflow_base.is_zero()
                    || !curr_point.external_outflow_base.is_zero()
                {
                    return DailyExternalFlow {
                        date,
                        inflow: curr_point.external_inflow_base,
                        outflow: curr_point.external_outflow_base,
                        source: ValuationExternalFlowSource::StoredGross,
                    };
                }

                curr_point.net_contribution_base - prev_point.net_contribution_base
            }
        };
        let (inflow, outflow) = if cash_flow.is_sign_negative() {
            (Decimal::ZERO, -cash_flow)
        } else {
            (cash_flow, Decimal::ZERO)
        };
        DailyExternalFlow {
            date,
            inflow,
            outflow,
            source: ValuationExternalFlowSource::NetContributionFallback,
        }
    }

    fn daily_external_flow_series(
        history: &[DailyAccountValuation],
        flow_basis: ExternalFlowBasis,
    ) -> Vec<DailyExternalFlow> {
        history
            .windows(2)
            .map(|window| Self::daily_external_flows(&window[0], &window[1], flow_basis))
            .collect()
    }

    fn external_flow_quality_warnings(daily_flows: &[DailyExternalFlow]) -> Vec<String> {
        let used_net_fallback = daily_flows
            .iter()
            .any(|flow| flow.source == ValuationExternalFlowSource::NetContributionFallback);
        let used_degraded_gross = daily_flows.iter().any(|flow| flow.source.is_degraded());

        let mut warnings = Vec::new();
        if used_net_fallback {
            warnings.push(
                "External cash flows were inferred from net contribution deltas for part of this period because gross daily flow data was unavailable; same-day deposits and withdrawals may be netted.".to_string(),
            );
        }
        if used_degraded_gross {
            warnings.push(
                "External cash flow provenance is incomplete for part of this period; return and attribution results may include degraded flow data.".to_string(),
            );
        }
        warnings
    }

    fn return_total_value(point: &DailyAccountValuation, flow_basis: ExternalFlowBasis) -> Decimal {
        match flow_basis {
            ExternalFlowBasis::AccountCurrency => point.total_value,
            ExternalFlowBasis::BaseCurrency => point.total_value_base,
        }
    }

    fn return_net_contribution(
        point: &DailyAccountValuation,
        flow_basis: ExternalFlowBasis,
    ) -> Decimal {
        match flow_basis {
            ExternalFlowBasis::AccountCurrency => point.net_contribution,
            ExternalFlowBasis::BaseCurrency => point.net_contribution_base,
        }
    }

    fn return_investment_market_value(
        point: &DailyAccountValuation,
        flow_basis: ExternalFlowBasis,
    ) -> Decimal {
        match flow_basis {
            ExternalFlowBasis::AccountCurrency => point.investment_market_value,
            ExternalFlowBasis::BaseCurrency => point.investment_market_value_base,
        }
    }

    fn return_cost_basis(point: &DailyAccountValuation, flow_basis: ExternalFlowBasis) -> Decimal {
        match flow_basis {
            ExternalFlowBasis::AccountCurrency => point.cost_basis,
            ExternalFlowBasis::BaseCurrency => point.cost_basis_base,
        }
    }

    fn return_book_basis(point: &DailyAccountValuation, flow_basis: ExternalFlowBasis) -> Decimal {
        match flow_basis {
            ExternalFlowBasis::AccountCurrency => point.book_basis,
            ExternalFlowBasis::BaseCurrency => point.book_basis_base,
        }
    }

    fn holdings_basis_is_complete(point: &DailyAccountValuation) -> bool {
        matches!(
            point.basis_status,
            BasisStatus::Complete | BasisStatus::NotApplicable
        )
    }

    fn holdings_basis_status(point: &DailyAccountValuation) -> BasisStatus {
        point.basis_status
    }

    fn combine_basis_statuses(statuses: impl IntoIterator<Item = BasisStatus>) -> BasisStatus {
        let mut has_complete = false;
        let mut has_partial = false;
        let mut has_unknown = false;

        for status in statuses {
            match status {
                BasisStatus::Complete => has_complete = true,
                BasisStatus::PartialUnknown => has_partial = true,
                BasisStatus::Unknown => has_unknown = true,
                BasisStatus::NotApplicable => {}
            }
        }

        if has_partial || (has_complete && has_unknown) {
            BasisStatus::PartialUnknown
        } else if has_unknown {
            BasisStatus::Unknown
        } else if has_complete {
            BasisStatus::Complete
        } else {
            BasisStatus::NotApplicable
        }
    }

    fn holdings_all_time_unavailable_reason(
        end_point: &DailyAccountValuation,
        flow_basis: ExternalFlowBasis,
        metric_label: &str,
        subject_label: &str,
    ) -> Option<String> {
        if Self::return_book_basis(end_point, flow_basis) <= Decimal::ZERO {
            return Some(format!(
                "{} unavailable for {} because ending book basis is zero or negative.",
                metric_label, subject_label
            ));
        }

        if !Self::holdings_basis_is_complete(end_point) {
            return Some(format!(
                "{} unavailable for {} because book basis is incomplete.",
                metric_label, subject_label
            ));
        }

        None
    }

    fn is_cash_only_history(history: &[DailyAccountValuation]) -> bool {
        history.iter().all(|point| {
            point.investment_market_value.is_zero()
                && point.investment_market_value_base.is_zero()
                && point.cost_basis.is_zero()
                && point.cost_basis_base.is_zero()
        })
    }

    fn is_cash_account_type(account_type: Option<&str>) -> bool {
        matches!(account_type, Some(account_types::CASH))
    }

    fn all_accounts_are_cash(
        account_ids: &[String],
        account_types: &HashMap<String, String>,
    ) -> bool {
        !account_ids.is_empty()
            && account_ids.iter().all(|account_id| {
                account_types
                    .get(account_id)
                    .is_some_and(|account_type| account_type == account_types::CASH)
            })
    }

    fn cash_fx_effect_for_window(
        prev_point: &DailyAccountValuation,
        curr_point: &DailyAccountValuation,
        flow_basis: ExternalFlowBasis,
    ) -> Decimal {
        if !matches!(flow_basis, ExternalFlowBasis::BaseCurrency) {
            return Decimal::ZERO;
        }

        let cash_delta_base = curr_point.cash_balance_base - prev_point.cash_balance_base;
        let cash_delta_at_current_fx =
            (curr_point.cash_balance - prev_point.cash_balance) * curr_point.fx_rate_to_base;
        (cash_delta_base - cash_delta_at_current_fx).round_dp(DECIMAL_PRECISION)
    }

    fn cash_fx_effect_from_history(
        history: &[DailyAccountValuation],
        flow_basis: ExternalFlowBasis,
    ) -> Decimal {
        history
            .windows(2)
            .map(|window| Self::cash_fx_effect_for_window(&window[0], &window[1], flow_basis))
            .sum::<Decimal>()
            .round_dp(DECIMAL_PRECISION)
    }

    fn cash_only_fx_effect_from_history(
        history: &[DailyAccountValuation],
        flow_basis: ExternalFlowBasis,
        cash_fx_attribution_enabled: bool,
    ) -> Decimal {
        if cash_fx_attribution_enabled && Self::is_cash_only_history(history) {
            Self::cash_fx_effect_from_history(history, flow_basis)
        } else {
            Decimal::ZERO
        }
    }

    fn compute_simple_value_return(
        full_history: &[DailyAccountValuation],
        daily_flows: &[DailyExternalFlow],
        flow_basis: ExternalFlowBasis,
    ) -> Option<Decimal> {
        let start_point = full_history.first()?;
        let start_value = Self::return_total_value(start_point, flow_basis);
        if start_value <= Decimal::ZERO {
            return None;
        }

        Self::compute_simple_value_return_amount(full_history, daily_flows, flow_basis)
            .map(|amount| amount / start_value)
    }

    fn compute_simple_value_return_amount(
        full_history: &[DailyAccountValuation],
        daily_flows: &[DailyExternalFlow],
        flow_basis: ExternalFlowBasis,
    ) -> Option<Decimal> {
        let start_point = full_history.first()?;
        let end_point = full_history.last()?;
        let net_cash_flow: Decimal = daily_flows.iter().map(|flow| flow.net()).sum();

        Some(
            Self::return_total_value(end_point, flow_basis)
                - Self::return_total_value(start_point, flow_basis)
                - net_cash_flow,
        )
    }

    fn total_external_flows(daily_flows: &[DailyExternalFlow]) -> (Decimal, Decimal) {
        daily_flows.iter().fold(
            (Decimal::ZERO, Decimal::ZERO),
            |(inflows, outflows), flow| (inflows + flow.inflow, outflows + flow.outflow),
        )
    }

    fn attribution_pnl(attribution: &PerformanceAttribution) -> Decimal {
        attribution.income
            + attribution.realized_pnl
            + attribution.unrealized_pnl_change
            + attribution.fx_effect
            - attribution.fees
            - attribution.taxes
    }

    fn attribution_from_event_effects(effects: &[EconomicEventEffect]) -> PerformanceAttribution {
        let mut attribution = PerformanceAttribution::default();
        for effect in effects {
            if effect.external_flow.is_sign_positive() {
                attribution.contributions += effect.external_flow;
            } else if effect.external_flow.is_sign_negative() {
                attribution.distributions += effect.external_flow.abs();
            }
            attribution.income += effect.income;
            attribution.realized_pnl += effect.realized_pnl;
            attribution.unrealized_pnl_change += effect.unrealized_movement;
            attribution.fx_effect += effect.fx_effect;
            attribution.fees += effect.fee;
            attribution.taxes += effect.tax;
        }
        attribution.contributions = attribution.contributions.round_dp(DECIMAL_PRECISION);
        attribution.distributions = attribution.distributions.round_dp(DECIMAL_PRECISION);
        attribution.income = attribution.income.round_dp(DECIMAL_PRECISION);
        attribution.realized_pnl = attribution.realized_pnl.round_dp(DECIMAL_PRECISION);
        attribution.unrealized_pnl_change = attribution
            .unrealized_pnl_change
            .round_dp(DECIMAL_PRECISION);
        attribution.fx_effect = attribution.fx_effect.round_dp(DECIMAL_PRECISION);
        attribution.fees = attribution.fees.round_dp(DECIMAL_PRECISION);
        attribution.taxes = attribution.taxes.round_dp(DECIMAL_PRECISION);
        attribution
    }

    fn add_attribution(target: &mut PerformanceAttribution, source: &PerformanceAttribution) {
        target.contributions += source.contributions;
        target.distributions += source.distributions;
        target.income += source.income;
        target.realized_pnl += source.realized_pnl;
        target.unrealized_pnl_change += source.unrealized_pnl_change;
        target.fx_effect += source.fx_effect;
        target.fees += source.fees;
        target.taxes += source.taxes;
    }

    fn attribution_baseline(
        is_holdings_mode: bool,
        start_date_opt: Option<NaiveDate>,
    ) -> AttributionBaseline {
        if !is_holdings_mode && start_date_opt.is_none() {
            AttributionBaseline::Inception
        } else {
            AttributionBaseline::PeriodStart
        }
    }

    fn total_external_flows_for_attribution(
        daily_flows: &[DailyExternalFlow],
        start_point: &DailyAccountValuation,
        flow_basis: ExternalFlowBasis,
        baseline: AttributionBaseline,
    ) -> (Decimal, Decimal) {
        let (mut contributions, mut distributions) = Self::total_external_flows(daily_flows);

        if matches!(baseline, AttributionBaseline::Inception) {
            let opening_net_contribution = Self::return_net_contribution(start_point, flow_basis);
            if opening_net_contribution.is_sign_negative() {
                distributions += -opening_net_contribution;
            } else {
                contributions += opening_net_contribution;
            }
        }

        (contributions, distributions)
    }

    fn attribution_total_value_delta(
        start_point: &DailyAccountValuation,
        end_point: &DailyAccountValuation,
        flow_basis: ExternalFlowBasis,
        baseline: AttributionBaseline,
    ) -> Decimal {
        let end_value = Self::return_total_value(end_point, flow_basis);
        if matches!(baseline, AttributionBaseline::Inception) {
            end_value
        } else {
            end_value - Self::return_total_value(start_point, flow_basis)
        }
    }

    fn attribution_residual_threshold(delta_total_value: Decimal, end_value: Decimal) -> Decimal {
        Decimal::ONE.max(
            delta_total_value
                .abs()
                .max(end_value.abs())
                .max(Decimal::ONE)
                * ATTRIBUTION_RESIDUAL_TOLERANCE_RATE,
        )
    }

    fn is_attribution_residual_warning(warning: &str) -> bool {
        warning.starts_with(ATTRIBUTION_RESIDUAL_LEGACY_WARNING_PREFIX)
            || warning.starts_with(ATTRIBUTION_INCOMPLETE_WARNING_PREFIX)
    }

    fn attribution_residual_warning(residual: Decimal, threshold: Decimal) -> String {
        format!(
            "Performance attribution is incomplete for this period. Difference: {}; tolerance: {}. Review Health Center for possible data issues.",
            residual.round_dp(DECIMAL_PRECISION),
            threshold.round_dp(DECIMAL_PRECISION)
        )
    }

    fn attribution_component_total(attribution: &PerformanceAttribution) -> Decimal {
        attribution.contributions - attribution.distributions + Self::attribution_pnl(attribution)
    }

    fn attribution_unreconciled_delta(
        delta_total_value: Decimal,
        attribution: &PerformanceAttribution,
    ) -> Decimal {
        (delta_total_value - Self::attribution_component_total(attribution))
            .round_dp(DECIMAL_PRECISION)
    }

    fn push_attribution_diagnostic_if_needed(
        data_quality: &mut PerformanceDataQuality,
        unreconciled_delta: Decimal,
        delta_total_value: Decimal,
        end_value: Decimal,
    ) {
        data_quality
            .warnings
            .retain(|warning| !Self::is_attribution_residual_warning(warning));
        let residual_threshold = Self::attribution_residual_threshold(delta_total_value, end_value);
        if unreconciled_delta.abs() > residual_threshold {
            data_quality
                .warnings
                .push(Self::attribution_residual_warning(
                    unreconciled_delta,
                    residual_threshold.round_dp(DECIMAL_PRECISION),
                ));
        }
    }

    fn calculate_xirr(
        history: &[DailyAccountValuation],
        daily_flows: &[DailyExternalFlow],
        flow_basis: ExternalFlowBasis,
    ) -> IrrComputation {
        if history.len() < 2 {
            return IrrComputation {
                annualized_irr: None,
                warnings: Vec::new(),
                not_applicable_reasons: vec![
                    "IRR unavailable: at least two valuation points are required.".to_string(),
                ],
            };
        }
        if daily_flows
            .iter()
            .any(|flow| Self::is_unavailable_external_flow_source(flow.source))
        {
            return IrrComputation {
                annualized_irr: None,
                warnings: Vec::new(),
                not_applicable_reasons: vec![
                    "IRR unavailable because an external flow amount or transfer boundary is unknown.".to_string(),
                ],
            };
        }

        let start = history.first().expect("len checked");
        let end = history.last().expect("len checked");
        let mut cash_flows: Vec<(NaiveDate, f64)> = Vec::new();

        if let Some(start_value) = Self::return_total_value(start, flow_basis).to_f64() {
            if start_value > 0.0 {
                cash_flows.push((start.valuation_date, -start_value));
            }
        }

        for flow in daily_flows {
            if let Some(inflow) = flow.inflow.to_f64() {
                if inflow > 0.0 {
                    cash_flows.push((flow.date, -inflow));
                }
            }
            if let Some(outflow) = flow.outflow.to_f64() {
                if outflow > 0.0 {
                    cash_flows.push((flow.date, outflow));
                }
            }
        }

        if let Some(end_value) = Self::return_total_value(end, flow_basis).to_f64() {
            if end_value > 0.0 {
                cash_flows.push((end.valuation_date, end_value));
            }
        }

        if cash_flows.len() < 2 {
            return IrrComputation {
                annualized_irr: None,
                warnings: Vec::new(),
                not_applicable_reasons: vec![
                    "IRR unavailable: insufficient dated cash flows.".to_string()
                ],
            };
        }

        let has_positive = cash_flows.iter().any(|(_, amount)| *amount > 0.0);
        let has_negative = cash_flows.iter().any(|(_, amount)| *amount < 0.0);
        if !has_positive || !has_negative {
            return IrrComputation {
                annualized_irr: None,
                warnings: vec!["IRR unavailable: cash flows do not change sign.".to_string()],
                not_applicable_reasons: Vec::new(),
            };
        }

        let origin = cash_flows[0].0;
        let npv = |rate: f64| -> Option<f64> {
            if rate <= -0.999_999_999 {
                return None;
            }
            let base = 1.0 + rate;
            let mut total = 0.0;
            for (date, amount) in &cash_flows {
                let years = (*date - origin).num_days() as f64 / 365.25;
                total += amount / base.powf(years);
            }
            if total.is_finite() {
                Some(total)
            } else {
                None
            }
        };

        let mut low = -0.999_999;
        let mut high = 10.0;
        let mut npv_low = match npv(low) {
            Some(value) => value,
            None => {
                return IrrComputation {
                    annualized_irr: None,
                    warnings: vec![
                        "IRR unavailable: solver could not evaluate cash flows.".to_string()
                    ],
                    not_applicable_reasons: Vec::new(),
                };
            }
        };
        let mut npv_high = npv(high).unwrap_or(f64::NAN);

        let mut expanded = 0;
        while npv_low.signum() == npv_high.signum() && expanded < 16 {
            high *= 2.0;
            npv_high = npv(high).unwrap_or(f64::NAN);
            if !npv_high.is_finite() {
                break;
            }
            expanded += 1;
        }

        if !npv_high.is_finite() || npv_low.signum() == npv_high.signum() {
            return IrrComputation {
                annualized_irr: None,
                warnings: vec!["IRR unavailable: solver did not converge.".to_string()],
                not_applicable_reasons: Vec::new(),
            };
        }

        for _ in 0..128 {
            let mid = (low + high) / 2.0;
            let Some(npv_mid) = npv(mid) else {
                return IrrComputation {
                    annualized_irr: None,
                    warnings: vec!["IRR unavailable: solver did not converge.".to_string()],
                    not_applicable_reasons: Vec::new(),
                };
            };
            if npv_mid.abs() < 1e-7 || (high - low).abs() < 1e-10 {
                return IrrComputation {
                    annualized_irr: Decimal::from_f64(mid)
                        .map(|value| value.round_dp(DECIMAL_PRECISION)),
                    warnings: Vec::new(),
                    not_applicable_reasons: Vec::new(),
                };
            }

            if npv_low.signum() == npv_mid.signum() {
                low = mid;
                npv_low = npv_mid;
            } else {
                high = mid;
            }
        }

        IrrComputation {
            annualized_irr: None,
            warnings: vec!["IRR unavailable: solver did not converge.".to_string()],
            not_applicable_reasons: Vec::new(),
        }
    }

    fn is_unavailable_external_flow_source(source: ValuationExternalFlowSource) -> bool {
        source.is_unavailable_for_returns()
    }

    fn annualize_optional_return(
        start_date: NaiveDate,
        end_date: NaiveDate,
        value: Option<Decimal>,
    ) -> Option<Decimal> {
        if (end_date - start_date).num_days() < MIN_ANNUALIZATION_DAYS {
            return None;
        }
        value.map(|return_value| {
            Self::calculate_annualized_return(start_date, end_date, return_value)
                .round_dp(DECIMAL_PRECISION)
        })
    }

    fn data_quality(
        warnings: Vec<String>,
        not_applicable_reasons: Vec<String>,
        no_data: bool,
    ) -> PerformanceDataQuality {
        let status = if no_data {
            DataQualityStatus::NoData
        } else if !warnings.is_empty() || !not_applicable_reasons.is_empty() {
            DataQualityStatus::Partial
        } else {
            DataQualityStatus::Ok
        };
        PerformanceDataQuality {
            status,
            warnings,
            not_applicable_reasons,
        }
    }

    fn refresh_data_quality_status(data_quality: &mut PerformanceDataQuality) {
        if matches!(
            data_quality.status,
            DataQualityStatus::NoData | DataQualityStatus::NotApplicable
        ) {
            return;
        }

        data_quality.status =
            if data_quality.warnings.is_empty() && data_quality.not_applicable_reasons.is_empty() {
                DataQualityStatus::Ok
            } else {
                DataQualityStatus::Partial
            };
    }

    fn risk_from_samples(
        samples: &[RiskSample],
        opening_date: Option<NaiveDate>,
    ) -> PerformanceRisk {
        let returns: Vec<Decimal> = samples.iter().map(|sample| sample.simple_return).collect();
        let drawdown = Self::calculate_max_drawdown(samples, opening_date);
        PerformanceRisk {
            volatility: Self::calculate_volatility(&returns),
            max_drawdown: drawdown.max_drawdown,
            peak_date: drawdown.peak_date,
            trough_date: drawdown.trough_date,
            recovery_date: drawdown.recovery_date,
            drawdown_duration_days: drawdown.duration_days,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn build_result(
        id: String,
        currency: String,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
        mode: ReturnMethod,
        returns: PerformanceReturns,
        attribution: PerformanceAttribution,
        risk: PerformanceRisk,
        data_quality: PerformanceDataQuality,
        series: Vec<ReturnData>,
        is_holdings_mode: bool,
        is_mixed_tracking_mode: bool,
    ) -> PerformanceResult {
        let basis_status = Self::basis_status_for_result(
            mode,
            &data_quality,
            is_holdings_mode,
            is_mixed_tracking_mode,
        );
        let mut result = PerformanceResult {
            scope: PerformanceScopeDescriptor { id, currency },
            period: PerformancePeriod {
                start_date,
                end_date,
            },
            mode,
            returns,
            attribution,
            risk,
            data_quality,
            basis_status,
            summary: PerformanceSummary {
                amount_status: PerformanceSummaryStatus::Complete,
                percent_status: PerformanceSummaryStatus::Complete,
                ..PerformanceSummary::default()
            },
            series,
            is_holdings_mode,
            is_mixed_tracking_mode,
        };
        Self::refresh_summary(&mut result);
        result
    }

    fn refresh_summary(result: &mut PerformanceResult) {
        let mut amount_available =
            result.summary.amount_status == PerformanceSummaryStatus::Complete;
        let mut percent_available =
            result.summary.percent_status == PerformanceSummaryStatus::Complete;
        if result.is_holdings_mode
            && matches!(
                result.basis_status,
                BasisStatus::Unknown | BasisStatus::PartialUnknown
            )
        {
            amount_available = false;
            percent_available = false;
        }
        let reasons = result
            .data_quality
            .warnings
            .iter()
            .chain(result.data_quality.not_applicable_reasons.iter())
            .cloned()
            .collect();
        let percent = Self::summary_percent(result, percent_available);
        let amount = Self::summary_amount(result, amount_available);
        result.summary = PerformanceSummary {
            amount,
            percent,
            method: result.mode,
            basis: Self::summary_basis(result),
            quality: result.data_quality.status.clone(),
            amount_status: if amount.is_some() {
                PerformanceSummaryStatus::Complete
            } else {
                PerformanceSummaryStatus::Unavailable
            },
            percent_status: if percent.is_some() {
                PerformanceSummaryStatus::Complete
            } else {
                PerformanceSummaryStatus::Unavailable
            },
            basis_status: result.basis_status,
            reasons,
        };
    }

    fn summary_percent(result: &PerformanceResult, percent_available: bool) -> Option<Decimal> {
        if result.is_holdings_mode
            && matches!(
                result.basis_status,
                BasisStatus::Unknown | BasisStatus::PartialUnknown
            )
        {
            return None;
        }

        if !percent_available {
            return None;
        }

        match result.mode {
            ReturnMethod::TimeWeighted => result.returns.twr,
            ReturnMethod::ValueReturn | ReturnMethod::SymbolPriceBased => {
                result.returns.value_return
            }
            ReturnMethod::NotApplicable => None,
        }
    }

    fn summary_amount(result: &PerformanceResult, amount_available: bool) -> Option<Decimal> {
        if matches!(
            result.mode,
            ReturnMethod::NotApplicable | ReturnMethod::SymbolPriceBased
        ) || matches!(
            result.data_quality.status,
            DataQualityStatus::NoData | DataQualityStatus::NotApplicable
        ) {
            return None;
        }

        if result.is_holdings_mode
            && matches!(
                result.basis_status,
                BasisStatus::Unknown | BasisStatus::PartialUnknown
            )
        {
            return None;
        }

        if !amount_available {
            return None;
        }

        Some(Self::attribution_pnl(&result.attribution))
    }

    fn summary_basis(result: &PerformanceResult) -> PerformanceSummaryBasis {
        if result.is_mixed_tracking_mode {
            PerformanceSummaryBasis::Mixed
        } else if result.is_holdings_mode || result.mode == ReturnMethod::ValueReturn {
            PerformanceSummaryBasis::BookBasis
        } else if result.mode == ReturnMethod::SymbolPriceBased
            || result.mode == ReturnMethod::TimeWeighted
        {
            PerformanceSummaryBasis::MarketValue
        } else {
            PerformanceSummaryBasis::NotApplicable
        }
    }

    fn basis_status_for_result(
        mode: ReturnMethod,
        _data_quality: &PerformanceDataQuality,
        is_holdings_mode: bool,
        is_mixed_tracking_mode: bool,
    ) -> BasisStatus {
        if is_holdings_mode || is_mixed_tracking_mode || mode == ReturnMethod::ValueReturn {
            BasisStatus::Complete
        } else {
            BasisStatus::NotApplicable
        }
    }

    async fn finalize_attribution_from_event_effects(
        &self,
        result: &mut PerformanceResult,
        account_ids: &[String],
        history: &[DailyAccountValuation],
        baseline: AttributionBaseline,
        seed: AttributionEffectSeed,
    ) {
        let mut effects = Self::base_attribution_event_effects(
            result,
            history,
            seed.include_base_market_movement,
        );
        effects.extend(seed.effects);
        let mut warnings = seed.warnings;
        let activity_effects = self
            .collect_activity_attribution_event_effects(result, account_ids)
            .await;
        effects.extend(activity_effects.effects);
        warnings.extend(activity_effects.warnings);
        let period_disposals = self
            .load_period_lot_disposals_for_attribution(result, account_ids)
            .await;
        let realized_effects =
            Self::collect_realized_attribution_event_effects(period_disposals.as_deref());
        effects.extend(realized_effects.effects);
        warnings.extend(realized_effects.warnings);
        let charge_effects = self
            .collect_trade_charge_pnl_gross_up_event_effects(
                result,
                account_ids,
                period_disposals.as_deref(),
            )
            .await;
        effects.extend(charge_effects.effects);
        warnings.extend(charge_effects.warnings);

        for effect in &effects {
            warnings.extend(effect.diagnostics.clone());
        }

        result.attribution = Self::attribution_from_event_effects(&effects);
        if !warnings.is_empty() {
            result.data_quality.warnings.extend(warnings);
        }
        Self::recompute_attribution_residual(
            result,
            history,
            ExternalFlowBasis::BaseCurrency,
            baseline,
        );
        Self::refresh_summary(result);
    }

    fn base_attribution_event_effects(
        result: &PerformanceResult,
        history: &[DailyAccountValuation],
        include_market_movement: bool,
    ) -> Vec<EconomicEventEffect> {
        let Some(effect_date) = result
            .period
            .end_date
            .or_else(|| history.last().map(|point| point.valuation_date))
            .or(result.period.start_date)
        else {
            return Vec::new();
        };

        let mut effects = Vec::new();
        if !result.attribution.contributions.is_zero() {
            let mut effect = Self::synthetic_attribution_effect(
                "__valuation_external_inflow__",
                result,
                effect_date,
                EconomicEventKind::CashFlow,
            );
            effect.external_flow = result.attribution.contributions;
            effects.push(effect);
        }
        if !result.attribution.distributions.is_zero() {
            let mut effect = Self::synthetic_attribution_effect(
                "__valuation_external_outflow__",
                result,
                effect_date,
                EconomicEventKind::CashFlow,
            );
            effect.external_flow = -result.attribution.distributions;
            effects.push(effect);
        }
        if include_market_movement
            && (!result.attribution.unrealized_pnl_change.is_zero()
                || !result.attribution.fx_effect.is_zero())
        {
            let mut effect = Self::synthetic_attribution_effect(
                "__valuation_market_movement__",
                result,
                effect_date,
                EconomicEventKind::Other,
            );
            effect.unrealized_movement = result.attribution.unrealized_pnl_change;
            effect.fx_effect = result.attribution.fx_effect;
            effects.push(effect);
        }

        effects
    }

    fn synthetic_attribution_effect(
        id: &str,
        result: &PerformanceResult,
        date: NaiveDate,
        event_kind: EconomicEventKind,
    ) -> EconomicEventEffect {
        EconomicEventEffect {
            activity_id: id.to_string(),
            account_id: result.scope.id.clone(),
            asset_id: None,
            date,
            event_kind,
            external_flow: Decimal::ZERO,
            realized_pnl: Decimal::ZERO,
            unrealized_movement: Decimal::ZERO,
            income: Decimal::ZERO,
            fee: Decimal::ZERO,
            tax: Decimal::ZERO,
            fx_effect: Decimal::ZERO,
            diagnostics: Vec::new(),
        }
    }

    async fn load_period_lot_disposals_for_attribution(
        &self,
        result: &PerformanceResult,
        account_ids: &[String],
    ) -> Option<Vec<LotDisposal>> {
        let lot_repository = self.lot_repository.as_ref()?;
        let start_date = result.period.start_date?;
        let end_date = result.period.end_date?;
        if account_ids.is_empty() {
            return Some(Vec::new());
        }

        let mut disposals = match lot_repository
            .get_lot_disposals_for_accounts_in_date_range(account_ids, start_date, end_date)
            .await
        {
            Ok(disposals) => disposals,
            Err(e) => {
                warn!(
                    "Failed to load lot disposals for performance attribution scope {}: {}",
                    result.scope.id, e
                );
                return None;
            }
        };

        if let Some(trade_activity_ids) =
            self.disposal_trade_activity_ids_for_period(account_ids, start_date, end_date)
        {
            disposals
                .retain(|disposal| trade_activity_ids.contains(&disposal.disposal_activity_id));
        }

        Some(disposals)
    }

    fn disposal_trade_activity_ids_for_period(
        &self,
        account_ids: &[String],
        start_date: NaiveDate,
        end_date: NaiveDate,
    ) -> Option<HashSet<String>> {
        let activity_repository = self.activity_repository.as_ref()?;
        let (start_utc, end_utc) = Self::activity_query_utc_bounds(start_date, end_date);
        let activities = match activity_repository.get_activities_by_account_ids_in_date_range(
            account_ids,
            start_utc,
            end_utc,
        ) {
            Ok(activities) => activities,
            Err(e) => {
                warn!(
                    "Failed to load activities for trade disposal filtering: {}. Lot disposals remain unfiltered.",
                    e
                );
                return None;
            }
        };

        Some(
            activities
                .into_iter()
                .filter(|activity| activity.is_posted())
                .filter(|activity| {
                    let activity_date = self.activity_local_date(activity);
                    activity_date > start_date && activity_date <= end_date
                })
                .filter(|activity| {
                    ActivityType::from_str(activity.effective_type()).is_ok_and(|activity_type| {
                        matches!(activity_type, ActivityType::Buy | ActivityType::Sell)
                    })
                })
                .map(|activity| activity.id)
                .collect(),
        )
    }

    async fn collect_scoped_unrealized_attribution_event_effects(
        &self,
        result: &PerformanceResult,
        account_ids: &[String],
        baseline: AttributionBaseline,
    ) -> AttributionEffectSet {
        let Some(start_date) = result.period.start_date else {
            return AttributionEffectSet::default();
        };
        let Some(end_date) = result.period.end_date else {
            return AttributionEffectSet::default();
        };
        if account_ids.is_empty() {
            return AttributionEffectSet::default();
        }

        let histories_by_account = match self
            .valuation_service
            .get_historical_valuations_by_account(account_ids, Some(start_date), Some(end_date))
        {
            Ok(histories) => histories,
            Err(e) => {
                return AttributionEffectSet {
                    effects: Vec::new(),
                    warnings: vec![format!(
                        "Scoped FX attribution skipped because valuation history failed: {}",
                        e
                    )],
                    complete: false,
                };
            }
        };
        let account_histories: Vec<Vec<DailyAccountValuation>> = account_ids
            .iter()
            .map(|account_id| {
                histories_by_account
                    .get(account_id)
                    .cloned()
                    .unwrap_or_default()
            })
            .collect();

        let attribution = Self::scoped_unrealized_attribution_components(
            &account_histories,
            start_date,
            end_date,
            baseline,
        );
        if !attribution.complete {
            return AttributionEffectSet {
                effects: Vec::new(),
                warnings: attribution.warnings,
                complete: false,
            };
        }

        let mut effect = Self::synthetic_attribution_effect(
            "__scoped_unrealized_movement__",
            result,
            end_date,
            EconomicEventKind::Other,
        );
        effect.unrealized_movement = attribution.unrealized_pnl_change;
        effect.fx_effect = attribution.fx_effect;
        let effects = if effect.unrealized_movement.is_zero() && effect.fx_effect.is_zero() {
            Vec::new()
        } else {
            vec![effect]
        };
        AttributionEffectSet {
            effects,
            warnings: attribution.warnings,
            complete: true,
        }
    }

    async fn collect_scoped_transfer_pair_attribution_event_effects(
        &self,
        result: &PerformanceResult,
        account_ids: &[String],
    ) -> AttributionEffectSet {
        let Some(activity_repository) = &self.activity_repository else {
            return AttributionEffectSet::default();
        };
        let Some(start_date) = result.period.start_date else {
            return AttributionEffectSet::default();
        };
        let Some(end_date) = result.period.end_date else {
            return AttributionEffectSet::default();
        };
        if account_ids.is_empty() {
            return AttributionEffectSet::default();
        }

        let (start_utc, end_exclusive_utc) = Self::activity_query_utc_bounds(start_date, end_date);
        let transfer_activities = match activity_repository
            .get_transfer_activities_touching_account_ids_in_date_range(
                account_ids,
                Some(start_utc),
                Some(end_exclusive_utc),
            ) {
            Ok(activities) => activities,
            Err(e) => {
                warn!(
                    "Failed to load transfer pairs for performance attribution scope {}: {}",
                    result.scope.id, e
                );
                return AttributionEffectSet::default();
            }
        };

        let transfer_resolution = TransferPairResolution::from_activities(&transfer_activities);
        let scope_account_ids: HashSet<String> = account_ids.iter().cloned().collect();
        let mut warnings = Vec::new();
        let mut warned_invalid_groups = HashSet::new();
        let mut warned_unresolved_activities = HashSet::new();
        let transfer_asset_ids: HashSet<String> = transfer_activities
            .iter()
            .filter_map(|activity| activity.asset_id.clone())
            .collect();
        let mut transfer_quotes_by_key = HashMap::new();
        if !transfer_asset_ids.is_empty() {
            match self
                .quote_service
                .get_quotes_in_range_filled(&transfer_asset_ids, start_date, end_date)
            {
                Ok(quotes) => {
                    for quote in quotes {
                        transfer_quotes_by_key
                            .insert((quote.asset_id.clone(), quote.timestamp.date_naive()), quote);
                    }
                }
                Err(e) => warnings.push(format!(
                    "Transfer FX attribution will use degraded flow values because transfer-date quotes could not be loaded: {}",
                    e
                )),
            }
        }

        for activity in &transfer_activities {
            if !scope_account_ids.contains(&activity.account_id) {
                continue;
            }
            let activity_date = self.activity_local_date(activity);
            if activity_date <= start_date || activity_date > end_date {
                continue;
            }
            if transfer_resolution
                .pair_for_activity(&activity.id)
                .is_some()
            {
                continue;
            }

            if let Some(group) = transfer_resolution.invalid_group_for_activity(&activity.id) {
                if warned_invalid_groups.insert(group.group_id.clone()) {
                    warnings.push(format!(
                        "Transfer group {} is invalid ({}); affected transfer activity flows were treated as external.",
                        group.group_id, group.reason
                    ));
                }
            } else if transfer_resolution.is_ungrouped_transfer(&activity.id)
                && !is_external_transfer(activity)
                && warned_unresolved_activities.insert(activity.id.clone())
            {
                warnings.push(format!(
                    "Transfer activity {} has no valid linked transfer pair and no external intent; it was treated as external.",
                    activity.id
                ));
            }
        }

        let mut processed_groups = HashSet::new();
        let mut transfer_fx_effect = Decimal::ZERO;
        for pair in transfer_resolution.pairs() {
            if !pair.both_accounts_in_scope(&scope_account_ids)
                || !processed_groups.insert(pair.group_id.clone())
            {
                continue;
            }

            let transfer_in_date = self.activity_local_date(&pair.transfer_in);
            let transfer_out_date = self.activity_local_date(&pair.transfer_out);
            let touches_period = [
                (&pair.transfer_in, transfer_in_date),
                (&pair.transfer_out, transfer_out_date),
            ]
            .iter()
            .any(|(activity, activity_date)| {
                scope_account_ids.contains(&activity.account_id)
                    && *activity_date > start_date
                    && *activity_date <= end_date
            });
            if !touches_period {
                continue;
            }
            if is_external_transfer(&pair.transfer_in) || is_external_transfer(&pair.transfer_out) {
                warnings.push(format!(
                    "Transfer group {} ignored external transfer metadata because the valid pair is internal to the selected scope.",
                    pair.group_id
                ));
            }
            if pair
                .transfer_in
                .currency
                .eq_ignore_ascii_case(&pair.transfer_out.currency)
            {
                continue;
            }

            let in_quote = pair.transfer_in.asset_id.as_ref().and_then(|asset_id| {
                transfer_quotes_by_key.get(&(asset_id.clone(), transfer_in_date))
            });
            let out_quote = pair.transfer_out.asset_id.as_ref().and_then(|asset_id| {
                transfer_quotes_by_key.get(&(asset_id.clone(), transfer_out_date))
            });
            let in_economics = ActivityEconomicsResolver::compile_activity_with_unit_multiplier(
                &pair.transfer_in,
                in_quote,
                TransferBoundary::External,
                Self::attribution_unit_multiplier(&pair.transfer_in),
            );
            let out_economics = ActivityEconomicsResolver::compile_activity_with_unit_multiplier(
                &pair.transfer_out,
                out_quote,
                TransferBoundary::External,
                Self::attribution_unit_multiplier(&pair.transfer_out),
            );
            if in_economics.performance_flow_value.is_zero()
                && out_economics.performance_flow_value.is_zero()
            {
                continue;
            }

            let Some(in_base) = self.convert_amount_for_attribution(
                &pair.transfer_in.id,
                in_economics.performance_flow_value.abs(),
                &in_economics.performance_flow_currency,
                &result.scope.currency,
                transfer_in_date,
            ) else {
                warnings.push(format!(
                    "Transfer FX attribution skipped for activity {} because FX conversion failed.",
                    pair.transfer_in.id
                ));
                continue;
            };
            let Some(out_base) = self.convert_amount_for_attribution(
                &pair.transfer_out.id,
                out_economics.performance_flow_value.abs(),
                &out_economics.performance_flow_currency,
                &result.scope.currency,
                transfer_out_date,
            ) else {
                warnings.push(format!(
                    "Transfer FX attribution skipped for activity {} because FX conversion failed.",
                    pair.transfer_out.id
                ));
                continue;
            };

            transfer_fx_effect += in_base - out_base;
        }

        let effects = if transfer_fx_effect.is_zero() {
            Vec::new()
        } else {
            let mut effect = Self::synthetic_attribution_effect(
                "__scoped_internal_transfer_fx__",
                result,
                end_date,
                EconomicEventKind::InternalSecurityTransfer,
            );
            effect.fx_effect = transfer_fx_effect.round_dp(DECIMAL_PRECISION);
            vec![effect]
        };

        AttributionEffectSet {
            effects,
            warnings,
            complete: true,
        }
    }

    async fn collect_activity_attribution_event_effects(
        &self,
        result: &PerformanceResult,
        account_ids: &[String],
    ) -> AttributionEffectSet {
        let Some(activity_repository) = &self.activity_repository else {
            return AttributionEffectSet::default();
        };
        let Some(start_date) = result.period.start_date else {
            return AttributionEffectSet::default();
        };
        let Some(end_date) = result.period.end_date else {
            return AttributionEffectSet::default();
        };
        if account_ids.is_empty() {
            return AttributionEffectSet::default();
        }

        let (start_utc, end_utc) = Self::activity_query_utc_bounds(start_date, end_date);

        let activities = match activity_repository.get_activities_by_account_ids_in_date_range(
            account_ids,
            start_utc,
            end_utc,
        ) {
            Ok(activities) => activities,
            Err(e) => {
                warn!(
                    "Failed to load activities for performance attribution scope {}: {}",
                    result.scope.id, e
                );
                return AttributionEffectSet::default();
            }
        };

        let mut effects = Vec::new();
        let mut warnings = Vec::new();

        for activity in activities {
            if !activity.is_posted() {
                continue;
            }

            let activity_date = self.activity_local_date(&activity);
            if activity_date <= start_date || activity_date > end_date {
                continue;
            }

            let Ok(activity_type) = ActivityType::from_str(activity.effective_type()) else {
                continue;
            };
            let (raw_income, raw_fees, raw_taxes) =
                Self::activity_attribution_components(&activity, &activity_type);
            let event_kind = match activity_type {
                ActivityType::Dividend | ActivityType::Interest => EconomicEventKind::Income,
                ActivityType::Fee => EconomicEventKind::Fee,
                ActivityType::Tax => EconomicEventKind::Tax,
                ActivityType::Buy | ActivityType::Sell => EconomicEventKind::Trade,
                _ => EconomicEventKind::Other,
            };
            let mut effect = EconomicEventEffect::empty(&activity, activity_date, event_kind);
            let mut has_effect = false;

            if !raw_income.is_zero() {
                match self.convert_activity_amount_for_attribution(
                    &activity,
                    raw_income,
                    &result.scope.currency,
                    activity_date,
                ) {
                    Some(amount) => {
                        effect.income = amount;
                        has_effect = true;
                    }
                    None => warnings.push(format!(
                        "Income attribution skipped for activity {} because FX conversion failed.",
                        activity.id
                    )),
                }
            }

            if !raw_fees.is_zero() {
                match self.convert_activity_amount_for_attribution(
                    &activity,
                    raw_fees,
                    &result.scope.currency,
                    activity_date,
                ) {
                    Some(amount) => {
                        effect.fee = amount;
                        has_effect = true;
                    }
                    None => warnings.push(format!(
                        "Fee attribution skipped for activity {} because FX conversion failed.",
                        activity.id
                    )),
                }
            }

            if !raw_taxes.is_zero() {
                match self.convert_activity_amount_for_attribution(
                    &activity,
                    raw_taxes,
                    &result.scope.currency,
                    activity_date,
                ) {
                    Some(amount) => {
                        effect.tax = amount;
                        has_effect = true;
                    }
                    None => warnings.push(format!(
                        "Tax attribution skipped for activity {} because FX conversion failed.",
                        activity.id
                    )),
                }
            }

            if has_effect {
                effects.push(effect);
            }
        }

        AttributionEffectSet {
            effects,
            warnings,
            complete: true,
        }
    }

    fn activity_attribution_components(
        activity: &Activity,
        activity_type: &ActivityType,
    ) -> (Decimal, Decimal, Decimal) {
        match activity_type {
            ActivityType::Dividend | ActivityType::Interest => {
                (activity.amt(), activity.fee_amt(), activity.tax_amt())
            }
            ActivityType::Fee => (
                Decimal::ZERO,
                activity.charge_amt_for(activity_type),
                Decimal::ZERO,
            ),
            ActivityType::Buy | ActivityType::Sell => {
                (Decimal::ZERO, activity.fee_amt(), activity.tax_amt())
            }
            ActivityType::Tax => (
                Decimal::ZERO,
                Decimal::ZERO,
                activity.charge_amt_for(activity_type),
            ),
            // Note: fees on these cash flows (and cash transfers below) are booked
            // to cash but knowingly not attributed — only trade and income fees are
            // treated as performance costs today.
            ActivityType::Credit | ActivityType::Deposit | ActivityType::Withdrawal => {
                (Decimal::ZERO, Decimal::ZERO, activity.tax_amt())
            }
            // Cash transfers book tax to cash; asset transfers book only the fee.
            // Attribute tax only when it was actually booked (empty asset_id = cash),
            // so "attributed ⇔ booked" stays in sync and no phantom residual appears.
            ActivityType::TransferIn | ActivityType::TransferOut
                if activity.asset_id.as_deref().unwrap_or("").is_empty() =>
            {
                (Decimal::ZERO, Decimal::ZERO, activity.tax_amt())
            }
            _ => (Decimal::ZERO, Decimal::ZERO, Decimal::ZERO),
        }
    }

    fn attribution_unit_multiplier(activity: &Activity) -> Decimal {
        if activity
            .asset_id
            .as_deref()
            .is_some_and(looks_like_occ_symbol)
        {
            Decimal::new(100, 0)
        } else {
            Decimal::ONE
        }
    }

    fn convert_activity_amount_for_attribution(
        &self,
        activity: &Activity,
        amount: Decimal,
        target_currency: &str,
        activity_date: NaiveDate,
    ) -> Option<Decimal> {
        self.convert_amount_for_attribution(
            &activity.id,
            amount,
            &activity.currency,
            target_currency,
            activity_date,
        )
    }

    fn convert_amount_for_attribution(
        &self,
        activity_id: &str,
        amount: Decimal,
        source_currency: &str,
        target_currency: &str,
        activity_date: NaiveDate,
    ) -> Option<Decimal> {
        if source_currency.eq_ignore_ascii_case(target_currency) {
            return Some(amount);
        }

        let Some(fx_service) = &self.fx_service else {
            warn!(
                "Missing FX service for performance attribution conversion {} -> {} on activity {}",
                source_currency, target_currency, activity_id
            );
            return None;
        };

        match fx_service.convert_currency_for_date(
            amount,
            source_currency,
            target_currency,
            activity_date,
        ) {
            Ok(converted) => Some(converted),
            Err(e) => {
                warn!(
                    "Failed performance attribution FX conversion for activity {}: {} {} -> {} on {}: {}",
                    activity_id, amount, source_currency, target_currency, activity_date, e
                );
                None
            }
        }
    }

    fn realized_pnl_base_from_disposal(
        disposal: &LotDisposal,
    ) -> std::result::Result<Decimal, String> {
        let fx_rate_to_base = parse_decimal_lossy(&disposal.fx_rate_to_base);
        if disposal.currency != disposal.base_currency && fx_rate_to_base <= Decimal::ZERO {
            return Err(format!(
                "Realized P&L attribution skipped for disposal {} because FX conversion was unavailable.",
                disposal.id
            ));
        }

        let cost_basis = parse_decimal_lossy(&disposal.cost_basis);
        let cost_basis_base = parse_decimal_lossy(&disposal.cost_basis_base);
        let cost_basis_sign_mismatch = (cost_basis.is_sign_positive()
            && cost_basis_base.is_sign_negative())
            || (cost_basis.is_sign_negative() && cost_basis_base.is_sign_positive());
        if disposal.currency != disposal.base_currency
            && !cost_basis.is_zero()
            && (cost_basis_base.is_zero() || cost_basis_sign_mismatch)
        {
            return Err(format!(
                "Realized P&L attribution skipped for disposal {} because acquisition FX conversion was unavailable.",
                disposal.id
            ));
        }

        Ok(parse_decimal_lossy(&disposal.realized_pnl_base))
    }

    fn collect_realized_attribution_event_effects(
        period_disposals: Option<&[LotDisposal]>,
    ) -> AttributionEffectSet {
        let Some(disposals) = period_disposals else {
            return AttributionEffectSet::default();
        };

        let mut effects = Vec::new();
        let mut warnings = Vec::new();
        for disposal in disposals {
            match Self::realized_pnl_base_from_disposal(disposal) {
                Ok(amount) => {
                    if amount.is_zero() {
                        continue;
                    }
                    let Ok(disposal_date) =
                        NaiveDate::parse_from_str(&disposal.disposal_date, "%Y-%m-%d")
                    else {
                        warnings.push(format!(
                            "Realized P&L attribution skipped for disposal {} because disposal date was invalid.",
                            disposal.id
                        ));
                        continue;
                    };
                    effects.push(EconomicEventEffect {
                        activity_id: disposal.disposal_activity_id.clone(),
                        account_id: disposal.account_id.clone(),
                        asset_id: Some(disposal.asset_id.clone()),
                        date: disposal_date,
                        event_kind: EconomicEventKind::Trade,
                        external_flow: Decimal::ZERO,
                        realized_pnl: amount,
                        unrealized_movement: Decimal::ZERO,
                        income: Decimal::ZERO,
                        fee: Decimal::ZERO,
                        tax: Decimal::ZERO,
                        fx_effect: Decimal::ZERO,
                        diagnostics: Vec::new(),
                    });
                }
                Err(warning) => warnings.push(warning),
            }
        }

        AttributionEffectSet {
            effects,
            warnings,
            complete: true,
        }
    }

    async fn collect_trade_charge_pnl_gross_up_event_effects(
        &self,
        result: &PerformanceResult,
        account_ids: &[String],
        period_disposals: Option<&[LotDisposal]>,
    ) -> AttributionEffectSet {
        let Some(activity_repository) = &self.activity_repository else {
            return AttributionEffectSet::default();
        };
        let disposals = period_disposals.unwrap_or(&[]);
        let Some(start_date) = result.period.start_date else {
            return AttributionEffectSet::default();
        };
        let Some(end_date) = result.period.end_date else {
            return AttributionEffectSet::default();
        };
        if account_ids.is_empty() {
            return AttributionEffectSet::default();
        }

        #[derive(Clone, Copy)]
        struct TradeChargeAttributionInput {
            charge: Decimal,
            quantity: Decimal,
        }

        let start_utc = (start_date - Duration::days(1))
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc();
        let end_utc = (end_date + Duration::days(1))
            .and_hms_opt(23, 59, 59)
            .unwrap()
            .and_utc();

        let activities = match activity_repository.get_activities_by_account_ids_in_date_range(
            account_ids,
            start_utc,
            end_utc,
        ) {
            Ok(activities) => activities,
            Err(e) => {
                warn!(
                    "Failed to load activities for trade-charge performance attribution scope {}: {}",
                    result.scope.id, e
                );
                return AttributionEffectSet::default();
            }
        };

        let mut trade_charge_by_activity = HashMap::<String, TradeChargeAttributionInput>::new();
        let mut fallback_buy_charge_by_activity = HashMap::<String, Decimal>::new();
        for activity in activities {
            let raw_charge = activity.fee_amt() + activity.tax_amt();
            if !activity.is_posted() || raw_charge.is_zero() {
                continue;
            }

            let activity_date = self.activity_local_date(&activity);
            if activity_date <= start_date || activity_date > end_date {
                continue;
            }

            let Ok(activity_type) = ActivityType::from_str(activity.effective_type()) else {
                continue;
            };
            if !matches!(activity_type, ActivityType::Buy | ActivityType::Sell) {
                continue;
            }

            let Some(charge) = self.convert_activity_amount_for_attribution(
                &activity,
                raw_charge,
                &result.scope.currency,
                activity_date,
            ) else {
                continue;
            };

            if matches!(activity_type, ActivityType::Buy) {
                fallback_buy_charge_by_activity.insert(activity.id.clone(), charge);
            }
            let quantity = activity.qty();
            trade_charge_by_activity.insert(
                activity.id,
                TradeChargeAttributionInput { charge, quantity },
            );
        }

        if trade_charge_by_activity.is_empty() {
            return AttributionEffectSet::default();
        }

        let mut lot_by_account_and_id = HashMap::<(String, String), LotRecord>::new();
        let mut loaded_lots = false;
        if !disposals.is_empty() || !trade_charge_by_activity.is_empty() {
            if let Some(lot_repository) = &self.lot_repository {
                for account_id in account_ids {
                    match lot_repository.get_all_lots_for_account(account_id).await {
                        Ok(lots) => {
                            loaded_lots = true;
                            for lot in lots {
                                lot_by_account_and_id
                                    .insert((account_id.clone(), lot.id.clone()), lot);
                            }
                        }
                        Err(e) => warn!(
                            "Failed to load lots for trade-charge performance attribution account {}: {}",
                            account_id, e
                        ),
                    }
                }
            } else {
                warn!(
                    "Lot repository unavailable while grossing up disposed acquisition trade charges for performance attribution scope {}",
                    result.scope.id
                );
            }
        }

        let mut period_open_charge_by_activity = HashMap::<String, Decimal>::new();
        let mut saw_period_open_lot_records = false;
        let mut remaining_open_charges_from_lots = Decimal::ZERO;
        if loaded_lots {
            for lot in lot_by_account_and_id.values() {
                let Some(open_activity_id) = lot.open_activity_id.as_ref() else {
                    continue;
                };
                if !trade_charge_by_activity.contains_key(open_activity_id) {
                    continue;
                }
                let Ok(open_date) = NaiveDate::parse_from_str(&lot.open_date, "%Y-%m-%d") else {
                    continue;
                };
                if open_date <= start_date || open_date > end_date {
                    continue;
                }

                saw_period_open_lot_records = true;
                let full_charge = parse_decimal_lossy(&lot.fee_allocated_base)
                    + parse_decimal_lossy(&lot.tax_allocated_base);
                if full_charge.is_zero() {
                    continue;
                }
                *period_open_charge_by_activity
                    .entry(open_activity_id.clone())
                    .or_default() += full_charge;

                let remaining_quantity = parse_decimal_lossy(&lot.remaining_quantity);
                if remaining_quantity.is_zero() {
                    continue;
                }

                let original_quantity = parse_decimal_lossy(&lot.original_quantity).abs();
                let remaining_charge = if original_quantity > Decimal::ZERO {
                    full_charge * remaining_quantity.abs() / original_quantity
                } else {
                    let original_cost_basis_base =
                        parse_decimal_lossy(&lot.original_cost_basis_base).abs();
                    let remaining_cost_basis_base =
                        parse_decimal_lossy(&lot.remaining_cost_basis_base).abs();
                    if original_cost_basis_base > Decimal::ZERO {
                        full_charge * remaining_cost_basis_base / original_cost_basis_base
                    } else {
                        full_charge
                    }
                };

                remaining_open_charges_from_lots += remaining_charge;
            }
        }

        let mut acquisition_charges_disposed = Decimal::ZERO;
        let mut disposal_activity_ids = HashSet::<String>::new();
        let mut disposal_quantity_by_activity = HashMap::<String, Decimal>::new();
        for disposal in disposals {
            disposal_activity_ids.insert(disposal.disposal_activity_id.clone());
            *disposal_quantity_by_activity
                .entry(disposal.disposal_activity_id.clone())
                .or_default() += parse_decimal_lossy(&disposal.quantity).abs();

            let Some(lot) =
                lot_by_account_and_id.get(&(disposal.account_id.clone(), disposal.lot_id.clone()))
            else {
                continue;
            };
            let Ok(open_date) = NaiveDate::parse_from_str(&lot.open_date, "%Y-%m-%d") else {
                continue;
            };
            if open_date <= start_date || open_date > end_date {
                continue;
            }

            let Some(open_activity_id) = lot.open_activity_id.as_ref() else {
                continue;
            };
            if !trade_charge_by_activity.contains_key(open_activity_id) {
                continue;
            }

            let fee_allocated_base = parse_decimal_lossy(&lot.fee_allocated_base);
            let tax_allocated_base = parse_decimal_lossy(&lot.tax_allocated_base);
            let charge_allocated_base = fee_allocated_base + tax_allocated_base;
            if charge_allocated_base.is_zero() {
                continue;
            }

            let original_quantity = parse_decimal_lossy(&lot.original_quantity).abs();
            let disposed_quantity = parse_decimal_lossy(&disposal.quantity).abs();
            if original_quantity > Decimal::ZERO {
                acquisition_charges_disposed +=
                    charge_allocated_base * disposed_quantity / original_quantity;
            } else {
                let original_cost_basis_base =
                    parse_decimal_lossy(&lot.original_cost_basis_base).abs();
                let disposal_cost_basis_base = parse_decimal_lossy(&disposal.cost_basis_base).abs();
                if original_cost_basis_base > Decimal::ZERO {
                    acquisition_charges_disposed +=
                        disposal_cost_basis_base * charge_allocated_base / original_cost_basis_base;
                }
            }
        }

        let mut period_open_charges = period_open_charge_by_activity
            .values()
            .copied()
            .sum::<Decimal>()
            .round_dp(DECIMAL_PRECISION);
        if period_open_charges.is_zero() && !saw_period_open_lot_records {
            period_open_charges = fallback_buy_charge_by_activity
                .iter()
                .filter(|(activity_id, _)| !disposal_activity_ids.contains(*activity_id))
                .map(|(_, charge)| *charge)
                .sum::<Decimal>()
                .round_dp(DECIMAL_PRECISION);
        }
        let period_disposal_charges = disposal_quantity_by_activity
            .iter()
            .filter_map(|(activity_id, disposed_quantity)| {
                let charge_input = trade_charge_by_activity.get(activity_id)?;
                if charge_input.quantity > Decimal::ZERO {
                    Some(
                        (charge_input.charge * *disposed_quantity / charge_input.quantity)
                            .min(charge_input.charge),
                    )
                } else {
                    Some(charge_input.charge)
                }
            })
            .sum::<Decimal>()
            .round_dp(DECIMAL_PRECISION);
        let acquisition_charges_disposed = acquisition_charges_disposed
            .min(period_open_charges)
            .round_dp(DECIMAL_PRECISION);
        let remaining_period_open_charges = if saw_period_open_lot_records {
            remaining_open_charges_from_lots
                .min(period_open_charges)
                .round_dp(DECIMAL_PRECISION)
        } else {
            (period_open_charges - acquisition_charges_disposed).round_dp(DECIMAL_PRECISION)
        };

        if period_disposal_charges.is_zero()
            && acquisition_charges_disposed.is_zero()
            && remaining_period_open_charges.is_zero()
        {
            return AttributionEffectSet::default();
        }

        let mut effects = Vec::new();
        if !period_disposal_charges.is_zero() || !acquisition_charges_disposed.is_zero() {
            let mut effect = Self::synthetic_attribution_effect(
                "__trade_charge_realized_gross_up__",
                result,
                end_date,
                EconomicEventKind::Trade,
            );
            effect.realized_pnl = (period_disposal_charges + acquisition_charges_disposed)
                .round_dp(DECIMAL_PRECISION);
            effects.push(effect);
        }
        if !remaining_period_open_charges.is_zero() {
            let mut effect = Self::synthetic_attribution_effect(
                "__trade_charge_unrealized_gross_up__",
                result,
                end_date,
                EconomicEventKind::Trade,
            );
            effect.unrealized_movement = remaining_period_open_charges.round_dp(DECIMAL_PRECISION);
            effects.push(effect);
        }

        AttributionEffectSet {
            effects,
            warnings: Vec::new(),
            complete: true,
        }
    }

    fn recompute_attribution_residual(
        result: &mut PerformanceResult,
        history: &[DailyAccountValuation],
        flow_basis: ExternalFlowBasis,
        baseline: AttributionBaseline,
    ) {
        let Some(start_point) = history.first() else {
            return;
        };
        let Some(end_point) = history.last() else {
            return;
        };

        let end_value = Self::return_total_value(end_point, flow_basis);
        let delta_total_value =
            Self::attribution_total_value_delta(start_point, end_point, flow_basis, baseline);
        result.attribution.residual = Decimal::ZERO;
        let unreconciled_delta =
            Self::attribution_unreconciled_delta(delta_total_value, &result.attribution);
        Self::push_attribution_diagnostic_if_needed(
            &mut result.data_quality,
            unreconciled_delta,
            delta_total_value,
            end_value,
        );
        Self::refresh_data_quality_status(&mut result.data_quality);
    }

    /// HOLDINGS-mode period gain and return.
    ///
    /// HOLDINGS mode doesn't track cash flows at the transaction level, so
    /// TWR/IRR aren't meaningful — we measure unrealized P&L growth instead.
    ///
    /// * `is_all_time` — when `true`, measures gain versus ending book basis
    ///   (the recorded invested capital). When `false`, measures total value
    ///   change over starting value. Non-positive denominators make the
    ///   percentage undefined, so the return is omitted rather than reported as
    ///   0%.
    fn compute_holdings_value_return(
        start_point: &DailyAccountValuation,
        end_point: &DailyAccountValuation,
        is_all_time: bool,
        flow_basis: ExternalFlowBasis,
    ) -> (Option<Decimal>, Option<Decimal>) {
        if is_all_time {
            let end_book_basis = Self::return_book_basis(end_point, flow_basis);
            if end_book_basis <= Decimal::ZERO || !Self::holdings_basis_is_complete(end_point) {
                return (None, None);
            } else {
                let gain_vs_book_basis =
                    Self::return_total_value(end_point, flow_basis) - end_book_basis;
                return (
                    Some(gain_vs_book_basis),
                    Some(gain_vs_book_basis / end_book_basis),
                );
            }
        }

        let start_value = Self::return_total_value(start_point, flow_basis);
        let value_change = Self::return_total_value(end_point, flow_basis)
            - Self::return_total_value(start_point, flow_basis);
        let value_return = if start_value <= Decimal::ZERO {
            None
        } else {
            Some(value_change / start_value)
        };

        (Some(value_change), value_return)
    }

    fn unrealized_attribution_components(
        start_point: &DailyAccountValuation,
        end_point: &DailyAccountValuation,
        flow_basis: ExternalFlowBasis,
        baseline: AttributionBaseline,
    ) -> (Decimal, Decimal) {
        let end_base_unrealized = Self::return_investment_market_value(end_point, flow_basis)
            - Self::return_cost_basis(end_point, flow_basis);
        let start_base_unrealized = if matches!(baseline, AttributionBaseline::Inception) {
            Decimal::ZERO
        } else {
            Self::return_investment_market_value(start_point, flow_basis)
                - Self::return_cost_basis(start_point, flow_basis)
        };
        let base_unrealized_change = end_base_unrealized - start_base_unrealized;

        if !matches!(flow_basis, ExternalFlowBasis::BaseCurrency)
            || start_point.account_currency == start_point.base_currency
        {
            return (base_unrealized_change, Decimal::ZERO);
        }

        let start_local_unrealized = if matches!(baseline, AttributionBaseline::Inception) {
            Decimal::ZERO
        } else {
            start_point.investment_market_value - start_point.cost_basis
        };
        let local_unrealized_change =
            (end_point.investment_market_value - end_point.cost_basis) - start_local_unrealized;
        let local_change_at_end_fx = local_unrealized_change * end_point.fx_rate_to_base;
        (
            local_change_at_end_fx.round_dp(DECIMAL_PRECISION),
            (base_unrealized_change - local_change_at_end_fx).round_dp(DECIMAL_PRECISION),
        )
    }

    fn account_unrealized_local(point: &DailyAccountValuation) -> Decimal {
        point.investment_market_value - point.cost_basis
    }

    fn account_unrealized_base(point: &DailyAccountValuation) -> Decimal {
        point.investment_market_value_base - point.cost_basis_base
    }

    fn scoped_unrealized_attribution_components(
        account_histories: &[Vec<DailyAccountValuation>],
        start_date: NaiveDate,
        end_date: NaiveDate,
        baseline: AttributionBaseline,
    ) -> ScopedUnrealizedAttribution {
        let mut unrealized_pnl_change = Decimal::ZERO;
        let mut fx_effect = Decimal::ZERO;
        let mut warnings = Vec::new();
        let mut saw_account = false;
        let mut complete = true;

        for history in account_histories {
            if history.is_empty() {
                continue;
            }

            let start_index = if matches!(baseline, AttributionBaseline::Inception) {
                None
            } else {
                history
                    .iter()
                    .rposition(|point| point.valuation_date <= start_date)
            };
            let start_point = start_index.map(|index| &history[index]);
            let Some(end_index) = history
                .iter()
                .rposition(|point| point.valuation_date <= end_date)
            else {
                continue;
            };
            let end_point = &history[end_index];

            let end_fx_rate = if end_point.account_currency == end_point.base_currency {
                Decimal::ONE
            } else {
                end_point.fx_rate_to_base
            };
            if end_fx_rate <= Decimal::ZERO {
                complete = false;
                warnings.push(format!(
                    "Scoped FX attribution skipped for account {} because its end-date FX rate is unavailable.",
                    end_point.account_id
                ));
                continue;
            }

            let start_unrealized_local =
                start_point.map_or(Decimal::ZERO, Self::account_unrealized_local);
            let start_unrealized_base =
                start_point.map_or(Decimal::ZERO, Self::account_unrealized_base);
            let local_unrealized_change =
                Self::account_unrealized_local(end_point) - start_unrealized_local;
            let base_unrealized_change =
                Self::account_unrealized_base(end_point) - start_unrealized_base;
            let local_change_at_end_fx = local_unrealized_change * end_fx_rate;

            unrealized_pnl_change += local_change_at_end_fx;
            fx_effect += base_unrealized_change - local_change_at_end_fx;
            saw_account = true;
        }

        ScopedUnrealizedAttribution {
            unrealized_pnl_change: unrealized_pnl_change.round_dp(DECIMAL_PRECISION),
            fx_effect: fx_effect.round_dp(DECIMAL_PRECISION),
            warnings,
            complete: complete && saw_account,
        }
    }

    /// Full account performance calculation including per-day `returns[]`,
    /// volatility, and max-drawdown. Used by the account-detail page.
    async fn calculate_account_performance(
        &self,
        account_id: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
        tracking_mode: Option<TrackingMode>,
        account_type: Option<&str>,
    ) -> Result<PerformanceResult> {
        if let (Some(start), Some(end)) = (start_date_opt, end_date_opt) {
            if start > end {
                return Err(errors::Error::Validation(ValidationError::InvalidInput(
                    "Start date must be before end date".to_string(),
                )));
            }
        }

        let full_history = self.valuation_service.get_historical_valuations(
            account_id,
            start_date_opt,
            end_date_opt,
        )?;

        if full_history.len() < 2 {
            warn!(
                "Performance calculation for account '{}': Not enough valuation data ({} points). Returning empty response.",
                account_id,
                full_history.len()
            );
            let currency = full_history
                .first()
                .map(|point| point.base_currency.as_str())
                .unwrap_or("");
            let start_date = full_history
                .first()
                .map(|point| point.valuation_date)
                .or(start_date_opt);
            let end_date = full_history
                .last()
                .map(|point| point.valuation_date)
                .or(end_date_opt);
            return Ok(PerformanceService::empty_response_with_context(
                account_id,
                currency,
                start_date,
                end_date,
                "Performance unavailable: at least two valuation points are required.",
            ));
        }

        let mut metrics = Self::compute_account_performance_with_flow_basis(
            &full_history,
            tracking_mode,
            start_date_opt,
            true,
            ExternalFlowBasis::BaseCurrency,
            PerformanceSummaryProfile::Full,
            Self::is_cash_account_type(account_type),
        )?;
        metrics.scope.id = account_id.to_string();
        let attribution_baseline = Self::attribution_baseline(
            matches!(tracking_mode, Some(TrackingMode::Holdings)),
            start_date_opt,
        );
        self.finalize_attribution_from_event_effects(
            &mut metrics,
            &[account_id.to_string()],
            &full_history,
            attribution_baseline,
            AttributionEffectSeed::default(),
        )
        .await;
        Ok(metrics)
    }

    /// Summary account performance calculation. `Full` keeps the rich scalar
    /// metrics; `Summary` keeps dashboard-visible return/P&L fields only.
    async fn calculate_account_performance_summary(
        &self,
        account_id: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
        tracking_mode: Option<TrackingMode>,
        account_type: Option<&str>,
        profile: PerformanceSummaryProfile,
    ) -> Result<PerformanceResult> {
        if let (Some(start), Some(end)) = (start_date_opt, end_date_opt) {
            if start > end {
                return Err(errors::Error::Validation(ValidationError::InvalidInput(
                    "Start date must be before end date".to_string(),
                )));
            }
        }

        let full_history = self.valuation_service.get_historical_valuations(
            account_id,
            start_date_opt,
            end_date_opt,
        )?;

        if full_history.len() < 2 {
            warn!(
                "Account '{}': Not enough history data ({} points). Returning empty performance response.",
                account_id,
                full_history.len()
            );
            let currency = full_history
                .first()
                .map(|point| point.base_currency.as_str())
                .unwrap_or("");
            let start_date = full_history
                .first()
                .map(|point| point.valuation_date)
                .or(start_date_opt);
            let end_date = full_history
                .last()
                .map(|point| point.valuation_date)
                .or(end_date_opt);
            return Ok(PerformanceService::empty_response_with_context(
                account_id,
                currency,
                start_date,
                end_date,
                "Performance unavailable: at least two valuation points are required.",
            ));
        }

        let mut metrics = Self::compute_account_performance_with_flow_basis(
            &full_history,
            tracking_mode,
            start_date_opt,
            false,
            ExternalFlowBasis::BaseCurrency,
            profile,
            Self::is_cash_account_type(account_type),
        )?;
        metrics.scope.id = account_id.to_string();
        if profile == PerformanceSummaryProfile::Dashboard {
            return Ok(metrics);
        }

        let attribution_baseline = Self::attribution_baseline(
            matches!(tracking_mode, Some(TrackingMode::Holdings)),
            start_date_opt,
        );
        self.finalize_attribution_from_event_effects(
            &mut metrics,
            &[account_id.to_string()],
            &full_history,
            attribution_baseline,
            AttributionEffectSeed::default(),
        )
        .await;
        Ok(metrics)
    }

    async fn calculate_scoped_performance(
        &self,
        request: ScopedPerformanceRequest<'_>,
    ) -> Result<PerformanceResult> {
        let ScopedPerformanceRequest {
            scope_id,
            account_ids,
            base_currency,
            account_tracking_modes,
            account_types,
            start_date: start_date_opt,
            end_date: end_date_opt,
            include_returns_series,
            profile,
        } = request;

        if let (Some(start), Some(end)) = (start_date_opt, end_date_opt) {
            if start > end {
                return Err(errors::Error::Validation(ValidationError::InvalidInput(
                    "Start date must be before end date".to_string(),
                )));
            }
        }

        if account_ids.is_empty() {
            return Ok(PerformanceService::empty_response_with_context(
                scope_id,
                base_currency,
                start_date_opt,
                end_date_opt,
                "Performance unavailable: no accounts selected.",
            ));
        }
        let scoped_tracking_composition =
            Self::scoped_tracking_composition(account_ids, account_tracking_modes);

        if scoped_tracking_composition == ScopedTrackingComposition::Mixed {
            let histories_by_account = match self
                .valuation_service
                .get_historical_valuations_by_account(account_ids, start_date_opt, end_date_opt)
            {
                Ok(histories) => histories,
                Err(errors::Error::Calculation(error)) => {
                    let warning = format!(
                        "Performance is partially unavailable for this scope because account valuation history is incomplete: {}",
                        error
                    );
                    warn!("{}", warning);
                    return Ok(PerformanceService::partial_response(
                        scope_id,
                        base_currency,
                        start_date_opt,
                        end_date_opt,
                        warning,
                    ));
                }
                Err(error) => return Err(error),
            };
            let empty_history: &[DailyAccountValuation] = &[];
            let account_histories: Vec<MixedScopeAccountHistory<'_>> = account_ids
                .iter()
                .map(|account_id| MixedScopeAccountHistory {
                    account_id,
                    tracking_mode: account_tracking_modes
                        .get(account_id)
                        .copied()
                        .unwrap_or(TrackingMode::Transactions),
                    account_type: account_types.get(account_id).map(String::as_str),
                    history: histories_by_account
                        .get(account_id)
                        .map(Vec::as_slice)
                        .unwrap_or(empty_history),
                })
                .collect();
            let mut metrics = self
                .compute_mixed_scope_performance_from_account_histories_with_attribution(
                    &account_histories,
                    base_currency,
                    start_date_opt,
                    include_returns_series,
                    profile,
                )
                .await?;
            metrics.scope.id = scope_id.to_string();
            return Ok(metrics);
        }

        let full_history = match self
            .valuation_service
            .get_historical_valuations_for_accounts(
                scope_id,
                account_ids,
                base_currency,
                start_date_opt,
                end_date_opt,
            ) {
            Ok(history) => history,
            Err(errors::Error::Calculation(error)) => {
                let warning = format!(
                    "Performance is partially unavailable for this scope because valuation history is incomplete: {}",
                    error
                );
                warn!("{}", warning);
                return Ok(PerformanceService::partial_response(
                    scope_id,
                    base_currency,
                    start_date_opt,
                    end_date_opt,
                    warning,
                ));
            }
            Err(error) => return Err(error),
        };

        if full_history.len() < 2 {
            let start_date = full_history
                .first()
                .map(|point| point.valuation_date)
                .or(start_date_opt);
            let end_date = full_history
                .last()
                .map(|point| point.valuation_date)
                .or(end_date_opt);
            return Ok(PerformanceService::empty_response_with_context(
                scope_id,
                base_currency,
                start_date,
                end_date,
                "Performance unavailable: at least two valuation points are required.",
            ));
        }

        let mut metrics = match scoped_tracking_composition {
            ScopedTrackingComposition::TransactionsOnly => {
                let cash_fx_attribution_enabled =
                    Self::all_accounts_are_cash(account_ids, account_types);
                Self::compute_scoped_account_performance(
                    &full_history,
                    Some(TrackingMode::Transactions),
                    start_date_opt,
                    include_returns_series,
                    profile,
                    cash_fx_attribution_enabled,
                )?
            }
            ScopedTrackingComposition::HoldingsOnly => {
                let cash_fx_attribution_enabled =
                    Self::all_accounts_are_cash(account_ids, account_types);
                Self::compute_scoped_account_performance(
                    &full_history,
                    Some(TrackingMode::Holdings),
                    start_date_opt,
                    include_returns_series,
                    profile,
                    cash_fx_attribution_enabled,
                )?
            }
            ScopedTrackingComposition::Mixed => {
                unreachable!("mixed scopes return before aggregate history calculation")
            }
        };

        metrics.scope.id = scope_id.to_string();
        if profile == PerformanceSummaryProfile::Dashboard {
            return Ok(metrics);
        }

        // Transaction-only all-time scopes can use inception attribution; holdings-only
        // scopes stay period-based because holdings snapshots do not carry cash-flow history.
        let attribution_baseline = if scoped_tracking_composition
            == ScopedTrackingComposition::TransactionsOnly
            && start_date_opt.is_none()
        {
            AttributionBaseline::Inception
        } else {
            AttributionBaseline::PeriodStart
        };
        let scoped_unrealized_effects = self
            .collect_scoped_unrealized_attribution_event_effects(
                &metrics,
                account_ids,
                attribution_baseline,
            )
            .await;
        let scoped_transfer_effects = self
            .collect_scoped_transfer_pair_attribution_event_effects(&metrics, account_ids)
            .await;
        let mut effect_seed = AttributionEffectSeed::default();
        if scoped_unrealized_effects.complete {
            effect_seed.include_base_market_movement = false;
            effect_seed
                .effects
                .extend(scoped_unrealized_effects.effects);
        }
        effect_seed
            .warnings
            .extend(scoped_unrealized_effects.warnings);
        effect_seed.effects.extend(scoped_transfer_effects.effects);
        effect_seed
            .warnings
            .extend(scoped_transfer_effects.warnings);
        self.finalize_attribution_from_event_effects(
            &mut metrics,
            account_ids,
            &full_history,
            attribution_baseline,
            effect_seed,
        )
        .await;
        Ok(metrics)
    }

    fn scoped_tracking_composition(
        account_ids: &[String],
        account_tracking_modes: &HashMap<String, TrackingMode>,
    ) -> ScopedTrackingComposition {
        let mut has_holdings = false;
        let mut has_transactions = false;

        for account_id in account_ids {
            if matches!(
                account_tracking_modes.get(account_id),
                Some(TrackingMode::Holdings)
            ) {
                has_holdings = true;
            } else {
                has_transactions = true;
            }
        }

        match (has_transactions, has_holdings) {
            (true, true) => ScopedTrackingComposition::Mixed,
            (false, true) => ScopedTrackingComposition::HoldingsOnly,
            _ => ScopedTrackingComposition::TransactionsOnly,
        }
    }

    /// Pure computation shared by the full and summary paths. Takes a
    /// pre-fetched valuation history and produces the same `PerformanceResult`
    /// both call sites need.
    ///
    /// * `include_returns_series` — when `true`, populates `returns[]` with a
    ///   per-day cumulative TWR.
    ///
    /// `id` is left empty — callers set it after.
    ///
    /// # Precondition
    /// `full_history.len() >= 2`. Callers check this first so they can respond
    /// differently to insufficient history (empty response vs. error).
    #[cfg(test)]
    fn compute_account_performance(
        full_history: &[DailyAccountValuation],
        tracking_mode: Option<TrackingMode>,
        start_date_opt: Option<NaiveDate>,
        include_returns_series: bool,
    ) -> Result<PerformanceResult> {
        Self::compute_account_performance_with_flow_basis(
            full_history,
            tracking_mode,
            start_date_opt,
            include_returns_series,
            ExternalFlowBasis::BaseCurrency,
            PerformanceSummaryProfile::Full,
            false,
        )
    }

    fn compute_scoped_account_performance(
        full_history: &[DailyAccountValuation],
        tracking_mode: Option<TrackingMode>,
        start_date_opt: Option<NaiveDate>,
        include_returns_series: bool,
        profile: PerformanceSummaryProfile,
        cash_fx_attribution_enabled: bool,
    ) -> Result<PerformanceResult> {
        Self::compute_account_performance_with_flow_basis(
            full_history,
            tracking_mode,
            start_date_opt,
            include_returns_series,
            ExternalFlowBasis::BaseCurrency,
            profile,
            cash_fx_attribution_enabled,
        )
    }

    fn compute_account_performance_with_flow_basis(
        full_history: &[DailyAccountValuation],
        tracking_mode: Option<TrackingMode>,
        start_date_opt: Option<NaiveDate>,
        include_returns_series: bool,
        flow_basis: ExternalFlowBasis,
        profile: PerformanceSummaryProfile,
        cash_fx_attribution_enabled: bool,
    ) -> Result<PerformanceResult> {
        debug_assert!(full_history.len() >= 2);

        let start_point = full_history.first().unwrap();
        let end_point = full_history.last().unwrap();
        let actual_start_date = start_point.valuation_date;
        let actual_end_date = end_point.valuation_date;
        let currency = match flow_basis {
            ExternalFlowBasis::AccountCurrency => start_point.account_currency.clone(),
            ExternalFlowBasis::BaseCurrency => start_point.base_currency.clone(),
        };
        let is_holdings_mode = matches!(tracking_mode, Some(TrackingMode::Holdings));
        let attribution_baseline = Self::attribution_baseline(is_holdings_mode, start_date_opt);
        let include_irr = profile == PerformanceSummaryProfile::Full;
        let include_risk = profile == PerformanceSummaryProfile::Full;
        let include_annualized_returns = profile == PerformanceSummaryProfile::Full;

        let end_value = Self::return_total_value(end_point, flow_basis);
        let daily_flows = Self::daily_external_flow_series(full_history, flow_basis);

        let twr = if is_holdings_mode {
            TwrComputation {
                cumulative_twr: None,
                samples: Vec::new(),
                warnings: Vec::new(),
                not_applicable_reasons: vec![
                    "TWR unavailable for holdings-only scopes because transaction cash flows are not tracked.".to_string(),
                ],
            }
        } else {
            Self::compute_time_weighted_returns(full_history, &daily_flows, flow_basis)?
        };
        let irr = if is_holdings_mode && include_irr {
            IrrComputation {
                annualized_irr: None,
                warnings: Vec::new(),
                not_applicable_reasons: vec![
                    "IRR unavailable for holdings-only scopes because transaction cash flows are not tracked.".to_string(),
                ],
            }
        } else if include_irr {
            Self::calculate_xirr(full_history, &daily_flows, flow_basis)
        } else {
            IrrComputation {
                annualized_irr: None,
                warnings: Vec::new(),
                not_applicable_reasons: Vec::new(),
            }
        };

        let mut risk_samples = Vec::new();
        let mut series = Vec::new();
        if include_returns_series {
            series.push(ReturnData {
                date: actual_start_date,
                value: Decimal::ZERO,
            });
        }

        if is_holdings_mode && (include_risk || include_returns_series) {
            let mut cumulative_value_factor = Decimal::ONE;
            for (index, window) in full_history.windows(2).enumerate() {
                let prev = &window[0];
                let curr = &window[1];
                let prev_value = Self::return_total_value(prev, flow_basis);
                let curr_value = Self::return_total_value(curr, flow_basis);
                let flow = daily_flows[index];
                let day_gain = curr_value + flow.outflow - prev_value - flow.inflow;
                if prev_value > Decimal::ZERO {
                    let daily_return = day_gain / prev_value;
                    cumulative_value_factor *= Decimal::ONE + daily_return;
                    if include_risk {
                        risk_samples.push(RiskSample {
                            date: curr.valuation_date,
                            simple_return: daily_return,
                        });
                    }
                    if include_returns_series {
                        series.push(ReturnData {
                            date: curr.valuation_date,
                            value: (cumulative_value_factor - Decimal::ONE)
                                .round_dp(DECIMAL_PRECISION),
                        });
                    }
                } else if include_returns_series {
                    series.push(ReturnData {
                        date: curr.valuation_date,
                        value: Decimal::ZERO,
                    });
                }
            }
        } else if !is_holdings_mode {
            for (date, sample) in &twr.samples {
                if include_risk && !sample.excluded_from_compounding {
                    risk_samples.push(RiskSample {
                        date: *date,
                        simple_return: sample.twr,
                    });
                }
                if include_returns_series {
                    series.push(ReturnData {
                        date: *date,
                        value: sample.cumulative_twr_to_date.round_dp(DECIMAL_PRECISION),
                    });
                }
            }
        }

        let risk = if include_risk {
            Self::risk_from_samples(&risk_samples, Some(actual_start_date))
        } else {
            Self::empty_risk()
        };

        let holdings_value_return = if is_holdings_mode {
            Some(Self::compute_holdings_value_return(
                start_point,
                end_point,
                start_date_opt.is_none(),
                flow_basis,
            ))
        } else {
            None
        };

        let (mode, value_return, value_return_not_applicable_reason) = if is_holdings_mode {
            let (_amount, ret) = holdings_value_return.unwrap();
            let reason = if ret.is_none() {
                Some(if start_date_opt.is_none() {
                    Self::holdings_all_time_unavailable_reason(
                        end_point,
                        flow_basis,
                        "Value return",
                        "holdings-only scope",
                    )
                    .unwrap_or_else(|| {
                        "Value return unavailable for holdings-only scope.".to_string()
                    })
                } else {
                    "Value return unavailable for holdings-only scope because starting total value is zero or negative."
                        .to_string()
                })
            } else {
                None
            };
            (ReturnMethod::ValueReturn, ret, reason)
        } else {
            let value_return =
                Self::compute_simple_value_return(full_history, &daily_flows, flow_basis);
            let reason = if value_return.is_none() {
                Some(
                    "Value return unavailable for transaction-mode scope because starting value is zero or negative."
                        .to_string(),
                )
            } else {
                None
            };
            (ReturnMethod::TimeWeighted, value_return, reason)
        };
        let holdings_pnl_not_applicable_reason = holdings_value_return.and_then(|(amount, _)| {
            if amount.is_none() && start_date_opt.is_none() {
                Self::holdings_all_time_unavailable_reason(
                    end_point,
                    flow_basis,
                    "P&L",
                    "holdings-only scope",
                )
            } else {
                None
            }
        });

        let (contributions, distributions, unrealized_pnl_change, fx_effect) =
            if let Some((holdings_amount, _)) = holdings_value_return {
                (
                    Decimal::ZERO,
                    Decimal::ZERO,
                    holdings_amount
                        .unwrap_or(Decimal::ZERO)
                        .round_dp(DECIMAL_PRECISION),
                    Decimal::ZERO,
                )
            } else if profile == PerformanceSummaryProfile::Dashboard {
                (
                    Decimal::ZERO,
                    Decimal::ZERO,
                    Self::compute_simple_value_return_amount(
                        full_history,
                        &daily_flows,
                        flow_basis,
                    )
                    .unwrap_or(Decimal::ZERO)
                    .round_dp(DECIMAL_PRECISION),
                    Decimal::ZERO,
                )
            } else {
                let (contributions, distributions) = Self::total_external_flows_for_attribution(
                    &daily_flows,
                    start_point,
                    flow_basis,
                    attribution_baseline,
                );
                let (unrealized_pnl_change, investment_fx_effect) =
                    Self::unrealized_attribution_components(
                        start_point,
                        end_point,
                        flow_basis,
                        attribution_baseline,
                    );
                let fx_effect = (investment_fx_effect
                    + Self::cash_only_fx_effect_from_history(
                        full_history,
                        flow_basis,
                        cash_fx_attribution_enabled,
                    ))
                .round_dp(DECIMAL_PRECISION);
                (
                    contributions,
                    distributions,
                    unrealized_pnl_change,
                    fx_effect,
                )
            };
        let delta_total_value = Self::attribution_total_value_delta(
            start_point,
            end_point,
            flow_basis,
            attribution_baseline,
        );
        let attribution = PerformanceAttribution {
            contributions,
            distributions,
            unrealized_pnl_change,
            fx_effect,
            ..PerformanceAttribution::default()
        };

        let mut warnings = Self::external_flow_quality_warnings(&daily_flows);
        warnings.extend(twr.warnings);
        warnings.extend(irr.warnings);
        let mut not_applicable_reasons = twr.not_applicable_reasons;
        not_applicable_reasons.extend(irr.not_applicable_reasons);
        if let Some(reason) = value_return_not_applicable_reason {
            not_applicable_reasons.push(reason);
        }
        if let Some(reason) = holdings_pnl_not_applicable_reason {
            not_applicable_reasons.push(reason);
        }
        let mut data_quality = Self::data_quality(warnings, not_applicable_reasons, false);
        if !is_holdings_mode {
            let unreconciled_delta =
                Self::attribution_unreconciled_delta(delta_total_value, &attribution);
            Self::push_attribution_diagnostic_if_needed(
                &mut data_quality,
                unreconciled_delta,
                delta_total_value,
                end_value,
            );
            Self::refresh_data_quality_status(&mut data_quality);
        }

        let mut result = Self::build_result(
            String::new(),
            currency,
            Some(actual_start_date),
            Some(actual_end_date),
            mode,
            PerformanceReturns {
                twr: twr
                    .cumulative_twr
                    .map(|value| value.round_dp(DECIMAL_PRECISION)),
                annualized_twr: if include_annualized_returns {
                    Self::annualize_optional_return(
                        actual_start_date,
                        actual_end_date,
                        twr.cumulative_twr,
                    )
                } else {
                    None
                },
                irr: Self::period_return_from_annualized_optional(
                    actual_start_date,
                    actual_end_date,
                    irr.annualized_irr,
                ),
                annualized_irr: if include_annualized_returns {
                    irr.annualized_irr
                } else {
                    None
                },
                value_return: value_return.map(|value| value.round_dp(DECIMAL_PRECISION)),
                annualized_value_return: if include_annualized_returns {
                    Self::annualize_optional_return(
                        actual_start_date,
                        actual_end_date,
                        value_return,
                    )
                } else {
                    None
                },
            },
            attribution,
            risk,
            data_quality,
            series,
            is_holdings_mode,
            false,
        );
        if is_holdings_mode {
            result.basis_status = Self::holdings_basis_status(end_point);
            Self::refresh_summary(&mut result);
        }
        Ok(result)
    }

    fn mixed_scope_component_denominator(
        history: &[DailyAccountValuation],
        tracking_mode: TrackingMode,
        is_all_time: bool,
        flow_basis: ExternalFlowBasis,
    ) -> Option<Decimal> {
        let denominator = if matches!(tracking_mode, TrackingMode::Holdings) && is_all_time {
            history
                .last()
                .filter(|point| Self::holdings_basis_is_complete(point))
                .map(|point| Self::return_book_basis(point, flow_basis))
                .unwrap_or(Decimal::ZERO)
        } else if is_all_time {
            history
                .iter()
                .map(|point| Self::return_total_value(point, flow_basis))
                .find(|value| *value > Decimal::ZERO)
                .unwrap_or(Decimal::ZERO)
        } else {
            history
                .first()
                .map(|point| Self::return_total_value(point, flow_basis))
                .unwrap_or(Decimal::ZERO)
        };

        if denominator > Decimal::ZERO {
            Some(denominator)
        } else {
            None
        }
    }

    fn compute_mixed_scope_transaction_component_result(
        component: &MixedScopeAccountHistory<'_>,
        start_date_opt: Option<NaiveDate>,
        flow_basis: ExternalFlowBasis,
        profile: PerformanceSummaryProfile,
    ) -> Result<PerformanceResult> {
        Self::compute_account_performance_with_flow_basis(
            component.history,
            Some(TrackingMode::Transactions),
            start_date_opt,
            false,
            flow_basis,
            profile,
            Self::is_cash_account_type(component.account_type),
        )
    }

    fn mixed_scope_component_not_applicable_reasons(
        reasons: Vec<String>,
        tracking_mode: TrackingMode,
    ) -> Vec<String> {
        if matches!(tracking_mode, TrackingMode::Holdings) {
            return reasons;
        }

        reasons
            .into_iter()
            .filter(|reason| {
                !reason.starts_with("Value return unavailable for transaction-mode scope")
            })
            .collect()
    }

    fn compute_mixed_scope_component_metrics(
        component: &MixedScopeAccountHistory<'_>,
        start_date_opt: Option<NaiveDate>,
        profile: PerformanceSummaryProfile,
        flow_basis: ExternalFlowBasis,
        is_all_time: bool,
    ) -> Result<MixedScopeComponentMetrics> {
        debug_assert!(component.history.len() >= 2);

        let start_point = component.history.first().expect("len checked");
        let end_point = component.history.last().expect("len checked");
        let contributes_to_scope = Self::return_total_value(start_point, flow_basis)
            > Decimal::ZERO
            || Self::return_total_value(end_point, flow_basis) > Decimal::ZERO;
        let denominator = Self::mixed_scope_component_denominator(
            component.history,
            component.tracking_mode,
            is_all_time,
            flow_basis,
        );
        let mut warnings = Vec::new();
        let mut not_applicable_reasons = Vec::new();

        let component_basis_status = if matches!(component.tracking_mode, TrackingMode::Holdings) {
            Self::holdings_basis_status(end_point)
        } else {
            BasisStatus::NotApplicable
        };
        let (amount, attribution) = if matches!(component.tracking_mode, TrackingMode::Holdings) {
            let (amount, _) = Self::compute_holdings_value_return(
                start_point,
                end_point,
                is_all_time,
                flow_basis,
            );
            let mut attribution = PerformanceAttribution::default();
            if let Some(amount) = amount {
                attribution.unrealized_pnl_change = amount.round_dp(DECIMAL_PRECISION);
            } else {
                let subject = format!("holdings account {}", component.account_id);
                let pnl_reason = Self::holdings_all_time_unavailable_reason(
                    end_point, flow_basis, "P&L", &subject,
                )
                .unwrap_or_else(|| format!("P&L unavailable for {}.", subject));
                warnings.push(format!(
                    "Mixed performance excluded account {} from all-time gain/loss because its holdings basis is incomplete or unavailable.",
                    component.account_id
                ));
                not_applicable_reasons.push(pnl_reason);
            }
            (amount, attribution)
        } else {
            let component_result = Self::compute_mixed_scope_transaction_component_result(
                component,
                start_date_opt,
                flow_basis,
                profile,
            )?;
            warnings.extend(component_result.data_quality.warnings);
            not_applicable_reasons.extend(Self::mixed_scope_component_not_applicable_reasons(
                component_result.data_quality.not_applicable_reasons,
                component.tracking_mode,
            ));
            (
                Some(Self::attribution_pnl(&component_result.attribution)),
                component_result.attribution,
            )
        };

        Ok(MixedScopeComponentMetrics {
            account_id: component.account_id.to_string(),
            start_date: start_point.valuation_date,
            end_date: end_point.valuation_date,
            amount,
            denominator,
            contributes_to_scope,
            basis_status: component_basis_status,
            attribution,
            warnings,
            not_applicable_reasons,
        })
    }

    fn mixed_scope_component_bounded_series(
        component: &MixedScopeAccountHistory<'_>,
        flow_basis: ExternalFlowBasis,
    ) -> Vec<MixedScopeSeriesPoint> {
        if component.history.len() < 2
            || component
                .history
                .iter()
                .any(|point| Self::return_total_value(point, flow_basis).is_sign_negative())
        {
            return Vec::new();
        }

        let denominator = Self::mixed_scope_component_denominator(
            component.history,
            component.tracking_mode,
            false,
            flow_basis,
        );
        let start_point = component.history.first().expect("len checked");
        let start_value = Self::return_total_value(start_point, flow_basis);

        if matches!(component.tracking_mode, TrackingMode::Holdings) {
            return component
                .history
                .iter()
                .skip(1)
                .map(|point| MixedScopeSeriesPoint {
                    date: point.valuation_date,
                    amount: Self::return_total_value(point, flow_basis) - start_value,
                    denominator,
                })
                .collect();
        }

        let daily_flows = Self::daily_external_flow_series(component.history, flow_basis);
        let mut net_flow = Decimal::ZERO;
        component
            .history
            .iter()
            .skip(1)
            .zip(daily_flows.iter())
            .map(|(point, flow)| {
                net_flow += flow.net();
                MixedScopeSeriesPoint {
                    date: point.valuation_date,
                    amount: Self::return_total_value(point, flow_basis) - start_value - net_flow,
                    denominator,
                }
            })
            .collect()
    }

    fn mixed_scope_bounded_return_series(
        account_histories: &[MixedScopeAccountHistory<'_>],
        actual_start_date: NaiveDate,
    ) -> Vec<ReturnData> {
        let flow_basis = ExternalFlowBasis::BaseCurrency;
        let component_series: Vec<Vec<MixedScopeSeriesPoint>> = account_histories
            .iter()
            .map(|component| Self::mixed_scope_component_bounded_series(component, flow_basis))
            .collect();
        let mut dates: Vec<NaiveDate> = component_series
            .iter()
            .flat_map(|series| series.iter().map(|point| point.date))
            .filter(|date| *date >= actual_start_date)
            .collect();
        dates.push(actual_start_date);
        dates.sort_unstable();
        dates.dedup();

        let mut series = Vec::with_capacity(dates.len());
        let mut component_indexes: Vec<Option<usize>> = vec![None; component_series.len()];
        for date in dates {
            if date == actual_start_date {
                series.push(ReturnData {
                    date,
                    value: Decimal::ZERO,
                });
                continue;
            }

            let mut cumulative_amount = Decimal::ZERO;
            let mut denominator = Decimal::ZERO;
            for (component_index, points) in component_series.iter().enumerate() {
                let mut next_index =
                    component_indexes[component_index].map_or(0, |index| index + 1);
                while next_index < points.len() && points[next_index].date <= date {
                    component_indexes[component_index] = Some(next_index);
                    next_index += 1;
                }

                if let Some(point_index) = component_indexes[component_index] {
                    let point = &points[point_index];
                    cumulative_amount += point.amount;
                    if let Some(value) = point.denominator {
                        denominator += value;
                    }
                }
            }

            if denominator > Decimal::ZERO {
                series.push(ReturnData {
                    date,
                    value: (cumulative_amount / denominator).round_dp(DECIMAL_PRECISION),
                });
            }
        }

        series
    }

    fn build_mixed_scope_performance_from_component_metrics(
        account_histories: &[MixedScopeAccountHistory<'_>],
        component_metrics: Vec<MixedScopeComponentMetrics>,
        skipped_warnings: Vec<String>,
        currency: &str,
        start_date_opt: Option<NaiveDate>,
        include_returns_series: bool,
        profile: PerformanceSummaryProfile,
    ) -> Result<PerformanceResult> {
        let is_all_time = start_date_opt.is_none();
        let include_annualized_returns = profile == PerformanceSummaryProfile::Full;
        let mut attribution = PerformanceAttribution::default();
        let mut summary_amount = Decimal::ZERO;
        let mut denominator = Decimal::ZERO;
        let mut warnings = vec![if profile == PerformanceSummaryProfile::Full {
            "This scope mixes transaction-mode and holdings-mode accounts, so TWR and IRR are unavailable. The return is a value return over account-level components.".to_string()
        } else {
            "This scope mixes transaction-mode and holdings-mode accounts, so TWR is unavailable. The return is a value return over account-level components.".to_string()
        }];
        warnings.extend(skipped_warnings);
        let mut not_applicable_reasons =
            vec!["TWR unavailable for mixed transaction and holdings scopes.".to_string()];
        if profile == PerformanceSummaryProfile::Full {
            not_applicable_reasons
                .push("IRR unavailable for mixed transaction and holdings scopes.".to_string());
        }
        let mut percent_coverage_complete = true;

        if component_metrics.is_empty() {
            not_applicable_reasons.push(
                "Performance unavailable: at least two valuation points are required.".to_string(),
            );
            let mut result = Self::build_result(
                String::new(),
                currency.to_string(),
                start_date_opt,
                None,
                ReturnMethod::NotApplicable,
                PerformanceReturns {
                    twr: None,
                    annualized_twr: None,
                    irr: None,
                    annualized_irr: None,
                    value_return: None,
                    annualized_value_return: None,
                },
                PerformanceAttribution::default(),
                Self::empty_risk(),
                Self::data_quality(warnings, not_applicable_reasons, true),
                Vec::new(),
                false,
                true,
            );
            result.basis_status = BasisStatus::Unknown;
            Self::refresh_summary(&mut result);
            return Ok(result);
        }

        let mut actual_start_date = component_metrics[0].start_date;
        let mut actual_end_date = component_metrics[0].end_date;
        for component in &component_metrics {
            actual_start_date = actual_start_date.min(component.start_date);
            actual_end_date = actual_end_date.max(component.end_date);

            warnings.extend(component.warnings.clone());
            not_applicable_reasons.extend(component.not_applicable_reasons.clone());

            let amount_available = component.amount.is_some();
            if let Some(amount) = component.amount {
                summary_amount += amount;
                Self::add_attribution(&mut attribution, &component.attribution);
            }

            match component.denominator {
                Some(value) if amount_available => denominator += value,
                Some(_) => {
                    percent_coverage_complete = false;
                    warnings.push(format!(
                        "Mixed performance percentage excluded account {} because its summary amount is unavailable.",
                        component.account_id
                    ));
                }
                None if amount_available => {
                    percent_coverage_complete = false;
                    warnings.push(format!(
                        "Mixed performance percentage unavailable because account {} contributes to the summary amount but has no valid return denominator.",
                        component.account_id
                    ));
                }
                None if component.contributes_to_scope => {
                    percent_coverage_complete = false;
                    warnings.push(format!(
                        "Mixed performance percentage unavailable because account {} is in scope but has no complete summary amount or return denominator.",
                        component.account_id
                    ));
                }
                None => {}
            }
        }

        let value_return = if !percent_coverage_complete {
            not_applicable_reasons.push(
                "Value return unavailable for mixed scope because summary amount and denominator coverage differ."
                    .to_string(),
            );
            None
        } else if denominator > Decimal::ZERO {
            Some(summary_amount / denominator)
        } else {
            not_applicable_reasons.push(
                "Value return unavailable for mixed scope because all account-level denominators are zero or negative."
                    .to_string(),
            );
            None
        };

        let mut series = Vec::new();
        if include_returns_series && value_return.is_some() {
            if is_all_time {
                warnings.push(
                    "Return series unavailable for all-time mixed scopes because transaction and holdings components use different baselines."
                        .to_string(),
                );
            } else {
                series =
                    Self::mixed_scope_bounded_return_series(account_histories, actual_start_date);
            }
        }

        let display_pnl = Self::attribution_pnl(&attribution);
        let residual_delta = summary_amount - display_pnl;
        if !residual_delta.is_zero() {
            warnings.push(format!(
                "Mixed performance attribution did not reconcile to the summary amount; unreconciled delta is {}.",
                residual_delta.round_dp(DECIMAL_PRECISION)
            ));
        }

        let mut result = Self::build_result(
            String::new(),
            currency.to_string(),
            Some(actual_start_date),
            Some(actual_end_date),
            ReturnMethod::ValueReturn,
            PerformanceReturns {
                twr: None,
                annualized_twr: None,
                irr: None,
                annualized_irr: None,
                value_return: value_return.map(|value| value.round_dp(DECIMAL_PRECISION)),
                annualized_value_return: if include_annualized_returns {
                    Self::annualize_optional_return(
                        actual_start_date,
                        actual_end_date,
                        value_return,
                    )
                } else {
                    None
                },
            },
            attribution,
            Self::empty_risk(),
            Self::data_quality(warnings, not_applicable_reasons, false),
            series,
            false,
            true,
        );
        result.basis_status = Self::combine_basis_statuses(
            component_metrics.iter().map(|metric| metric.basis_status),
        );
        let amount_available = component_metrics
            .iter()
            .any(|component| component.amount.is_some());
        result.summary.amount_status = if amount_available {
            PerformanceSummaryStatus::Complete
        } else {
            PerformanceSummaryStatus::Unavailable
        };
        result.summary.percent_status = if value_return.is_some() && percent_coverage_complete {
            PerformanceSummaryStatus::Complete
        } else {
            PerformanceSummaryStatus::Unavailable
        };
        Self::refresh_summary(&mut result);
        Ok(result)
    }

    #[cfg(test)]
    fn compute_mixed_scope_performance_from_account_histories(
        account_histories: &[MixedScopeAccountHistory<'_>],
        currency: &str,
        start_date_opt: Option<NaiveDate>,
        include_returns_series: bool,
        profile: PerformanceSummaryProfile,
    ) -> Result<PerformanceResult> {
        let flow_basis = ExternalFlowBasis::BaseCurrency;
        let is_all_time = start_date_opt.is_none();
        let mut component_metrics = Vec::new();
        let mut skipped_warnings = Vec::new();

        for component in account_histories {
            if component.history.len() < 2 {
                skipped_warnings.push(format!(
                    "Mixed performance skipped account {} because at least two valuation points are required.",
                    component.account_id
                ));
                continue;
            }

            if component
                .history
                .iter()
                .any(|point| Self::return_total_value(point, flow_basis).is_sign_negative())
            {
                skipped_warnings.push(format!(
                    "Mixed performance skipped account {} because it has negative portfolio value in its history. Please review the underlying transactions and holdings.",
                    component.account_id
                ));
                continue;
            }

            component_metrics.push(Self::compute_mixed_scope_component_metrics(
                component,
                start_date_opt,
                profile,
                flow_basis,
                is_all_time,
            )?);
        }

        Self::build_mixed_scope_performance_from_component_metrics(
            account_histories,
            component_metrics,
            skipped_warnings,
            currency,
            start_date_opt,
            include_returns_series,
            profile,
        )
    }

    async fn compute_mixed_scope_performance_from_account_histories_with_attribution(
        &self,
        account_histories: &[MixedScopeAccountHistory<'_>],
        currency: &str,
        start_date_opt: Option<NaiveDate>,
        include_returns_series: bool,
        profile: PerformanceSummaryProfile,
    ) -> Result<PerformanceResult> {
        let flow_basis = ExternalFlowBasis::BaseCurrency;
        let is_all_time = start_date_opt.is_none();
        let mut component_metrics = Vec::new();
        let mut skipped_warnings = Vec::new();

        for component in account_histories {
            if component.history.len() < 2 {
                skipped_warnings.push(format!(
                    "Mixed performance skipped account {} because at least two valuation points are required.",
                    component.account_id
                ));
                continue;
            }

            if component
                .history
                .iter()
                .any(|point| Self::return_total_value(point, flow_basis).is_sign_negative())
            {
                skipped_warnings.push(format!(
                    "Mixed performance skipped account {} because it has negative portfolio value in its history. Please review the underlying transactions and holdings.",
                    component.account_id
                ));
                continue;
            }

            let component_profile = if profile == PerformanceSummaryProfile::Dashboard {
                PerformanceSummaryProfile::Dashboard
            } else {
                PerformanceSummaryProfile::Summary
            };
            let mut metrics = Self::compute_mixed_scope_component_metrics(
                component,
                start_date_opt,
                component_profile,
                flow_basis,
                is_all_time,
            )?;

            if profile != PerformanceSummaryProfile::Dashboard
                && matches!(component.tracking_mode, TrackingMode::Transactions)
            {
                let mut component_result = Self::compute_mixed_scope_transaction_component_result(
                    component,
                    start_date_opt,
                    flow_basis,
                    PerformanceSummaryProfile::Summary,
                )?;
                component_result.scope.id = component.account_id.to_string();
                self.finalize_attribution_from_event_effects(
                    &mut component_result,
                    &[component.account_id.to_string()],
                    component.history,
                    Self::attribution_baseline(false, start_date_opt),
                    AttributionEffectSeed::default(),
                )
                .await;
                metrics.amount = Some(Self::attribution_pnl(&component_result.attribution));
                metrics.attribution = component_result.attribution;
                metrics.warnings = component_result.data_quality.warnings;
                metrics.not_applicable_reasons = Self::mixed_scope_component_not_applicable_reasons(
                    component_result.data_quality.not_applicable_reasons,
                    component.tracking_mode,
                );
            }

            metrics.denominator = Self::mixed_scope_component_denominator(
                component.history,
                component.tracking_mode,
                is_all_time,
                flow_basis,
            );
            component_metrics.push(metrics);
        }

        Self::build_mixed_scope_performance_from_component_metrics(
            account_histories,
            component_metrics,
            skipped_warnings,
            currency,
            start_date_opt,
            include_returns_series,
            profile,
        )
    }

    #[cfg(test)]
    fn compute_mixed_scope_performance(
        full_history: &[DailyAccountValuation],
        include_returns_series: bool,
    ) -> Result<PerformanceResult> {
        Self::compute_mixed_scope_performance_with_profile(
            full_history,
            include_returns_series,
            PerformanceSummaryProfile::Full,
        )
    }

    #[cfg(test)]
    fn compute_mixed_scope_performance_with_profile(
        full_history: &[DailyAccountValuation],
        include_returns_series: bool,
        profile: PerformanceSummaryProfile,
    ) -> Result<PerformanceResult> {
        debug_assert!(full_history.len() >= 2);

        let start_point = full_history.first().unwrap();
        let end_point = full_history.last().unwrap();
        let actual_start_date = start_point.valuation_date;
        let actual_end_date = end_point.valuation_date;
        let currency = start_point.base_currency.clone();
        let flow_basis = ExternalFlowBasis::BaseCurrency;
        let start_value = Self::return_total_value(start_point, flow_basis);
        let end_value = Self::return_total_value(end_point, flow_basis);
        let daily_flows = Self::daily_external_flow_series(full_history, flow_basis);
        let net_cash_flow: Decimal = daily_flows.iter().map(|flow| flow.net()).sum();
        let gain_loss_amount = end_value - start_value - net_cash_flow;
        let include_risk = profile == PerformanceSummaryProfile::Full;
        let include_annualized_returns = profile == PerformanceSummaryProfile::Full;
        let has_negative_value = full_history
            .iter()
            .any(|point| Self::return_total_value(point, flow_basis).is_sign_negative());
        let value_return = if !has_negative_value && start_value > Decimal::ZERO {
            Some(gain_loss_amount / start_value)
        } else {
            None
        };

        let mut returns = Vec::new();
        let mut risk_samples = Vec::new();

        if include_returns_series && value_return.is_some() {
            returns.reserve(full_history.len());
            returns.push(ReturnData {
                date: actual_start_date,
                value: Decimal::ZERO,
            });
        }

        if include_risk || include_returns_series {
            let mut cumulative_external_flow = Decimal::ZERO;
            for (window, flow) in full_history.windows(2).zip(daily_flows.iter()) {
                let prev_point = &window[0];
                let curr_point = &window[1];
                let prev_value = Self::return_total_value(prev_point, flow_basis);
                let curr_value = Self::return_total_value(curr_point, flow_basis);
                if prev_value.is_sign_negative() || curr_value.is_sign_negative() {
                    continue;
                }

                cumulative_external_flow += flow.net();
                let cumulative_return = if start_value > Decimal::ZERO {
                    let cumulative_gain = curr_value - start_value - cumulative_external_flow;
                    Some(cumulative_gain / start_value)
                } else {
                    None
                };

                let day_gain = curr_value + flow.outflow - prev_value - flow.inflow;
                if include_risk && prev_value > Decimal::ZERO {
                    let daily_return = day_gain / prev_value;
                    risk_samples.push(RiskSample {
                        date: curr_point.valuation_date,
                        simple_return: daily_return,
                    });
                }

                if include_returns_series {
                    let Some(cumulative_return) = cumulative_return else {
                        continue;
                    };
                    returns.push(ReturnData {
                        date: curr_point.valuation_date,
                        value: cumulative_return.round_dp(DECIMAL_PRECISION),
                    });
                }
            }
        }

        let (contributions, distributions) = Self::total_external_flows(&daily_flows);
        let (unrealized_pnl_change, fx_effect) = Self::unrealized_attribution_components(
            start_point,
            end_point,
            flow_basis,
            AttributionBaseline::PeriodStart,
        );
        let delta_total_value = end_value - start_value;
        let attribution = PerformanceAttribution {
            contributions,
            distributions,
            unrealized_pnl_change,
            fx_effect,
            ..PerformanceAttribution::default()
        };
        let risk = if include_risk {
            Self::risk_from_samples(&risk_samples, Some(actual_start_date))
        } else {
            Self::empty_risk()
        };
        let mut warnings = vec![if profile == PerformanceSummaryProfile::Full {
            "This scope mixes transaction-mode and holdings-mode accounts, so TWR and IRR are unavailable. The return is a value return over the selected scope.".to_string()
        } else {
            "This scope mixes transaction-mode and holdings-mode accounts, so TWR is unavailable. The return is a value return over the selected scope.".to_string()
        }];
        if has_negative_value {
            warnings.push(
                "Mixed performance value return unavailable because the scope has negative portfolio value in its history. Review the underlying transactions, prices, and cash balances."
                    .to_string(),
            );
        }
        warnings.extend(Self::external_flow_quality_warnings(&daily_flows));
        let mut not_applicable_reasons =
            vec!["TWR unavailable for mixed transaction and holdings scopes.".to_string()];
        if profile == PerformanceSummaryProfile::Full {
            not_applicable_reasons
                .push("IRR unavailable for mixed transaction and holdings scopes.".to_string());
        }
        if value_return.is_none() {
            let reason = if has_negative_value {
                "Value return unavailable for mixed scope because portfolio value is negative during the period."
            } else {
                "Value return unavailable for mixed scope because starting value is zero or negative."
            };
            not_applicable_reasons.push(reason.to_string());
        }
        let unreconciled_delta =
            Self::attribution_unreconciled_delta(delta_total_value, &attribution);
        if !unreconciled_delta.is_zero() {
            warnings.push(format!(
                "Mixed performance attribution did not reconcile to the summary amount; unreconciled delta is {}.",
                unreconciled_delta.round_dp(DECIMAL_PRECISION)
            ));
        }

        let mut result = Self::build_result(
            String::new(),
            currency,
            Some(actual_start_date),
            Some(actual_end_date),
            ReturnMethod::ValueReturn,
            PerformanceReturns {
                twr: None,
                annualized_twr: None,
                irr: None,
                annualized_irr: None,
                value_return: value_return.map(|value| value.round_dp(DECIMAL_PRECISION)),
                annualized_value_return: if include_annualized_returns {
                    Self::annualize_optional_return(
                        actual_start_date,
                        actual_end_date,
                        value_return,
                    )
                } else {
                    None
                },
            },
            attribution,
            risk,
            Self::data_quality(warnings, not_applicable_reasons, false),
            returns,
            false,
            true,
        );
        result.basis_status = Self::holdings_basis_status(end_point);
        Self::refresh_summary(&mut result);
        Ok(result)
    }

    /// Internal function for calculating symbol/benchmark performance (Full)
    /// asset_id can be a canonical ID like "SEC:^GSPC:INDEX" or a raw symbol
    async fn calculate_symbol_performance(
        &self,
        asset_id: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> Result<PerformanceResult> {
        let effective_end_date = end_date_opt.unwrap_or_else(|| self.today_in_user_timezone());
        let effective_start_date =
            start_date_opt.unwrap_or_else(|| effective_end_date - chrono::Duration::days(365));

        if effective_start_date > effective_end_date {
            return Err(errors::Error::Validation(ValidationError::InvalidInput(
                format!(
                    "Effective start date {} must be before effective end date {}",
                    effective_start_date, effective_end_date
                ),
            )));
        }

        // Use fetch_quotes_for_symbol which handles both existing assets and canonical IDs
        let quote_history = self
            .quote_service
            .fetch_quotes_for_symbol(asset_id, "USD", effective_start_date, effective_end_date)
            .await?;

        if quote_history.is_empty() {
            warn!(
                "Asset '{}': No quote data found between {} and {}. Returning empty response.",
                asset_id, effective_start_date, effective_end_date
            );
            return Ok(PerformanceService::empty_response_with_context(
                asset_id,
                "USD",
                Some(effective_start_date),
                Some(effective_end_date),
                "Performance unavailable: no quote data found for the selected period.",
            ));
        }

        let currency = quote_history.first().unwrap().currency.clone();
        let mut quote_points: Vec<(NaiveDate, Decimal)> = quote_history
            .into_iter()
            .map(|quote| {
                (
                    quote.timestamp.date_naive(),
                    quote.close.round_dp(DECIMAL_PRECISION),
                )
            })
            .collect();
        quote_points.sort_by_key(|(date, _)| *date);
        quote_points.dedup_by_key(|(date, _)| *date);

        if quote_points.len() < 2 {
            warn!(
                "Asset '{}': Only one quote data point found between {} and {}. Returning empty response.",
                asset_id, effective_start_date, effective_end_date
            );
            return Ok(PerformanceService::empty_response_with_context(
                asset_id,
                &currency,
                Some(effective_start_date),
                Some(effective_end_date),
                "Performance unavailable: at least two quote points are required.",
            ));
        }

        let Some((actual_start_date, start_price)) = quote_points.first().copied() else {
            return Ok(PerformanceService::empty_response_with_context(
                asset_id,
                &currency,
                Some(effective_start_date),
                Some(effective_end_date),
                "Performance unavailable: no quote data found for the selected period.",
            ));
        };
        let Some((actual_end_date, end_price)) = quote_points.last().copied() else {
            return Ok(PerformanceService::empty_response_with_context(
                asset_id,
                &currency,
                Some(effective_start_date),
                Some(effective_end_date),
                "Performance unavailable: no quote data found for the selected period.",
            ));
        };
        if start_price <= Decimal::ZERO {
            warn!(
                "Asset '{}': starting quote price is non-positive on {}. Returning empty response.",
                asset_id, actual_start_date
            );
            return Ok(PerformanceService::empty_response_with_context(
                asset_id,
                &currency,
                Some(actual_start_date),
                Some(actual_end_date),
                "Performance unavailable: starting quote price is non-positive.",
            ));
        }
        let mut returns = Vec::with_capacity(quote_points.len());
        let mut risk_samples = Vec::with_capacity(quote_points.len().saturating_sub(1));
        let mut cumulative_value = Decimal::ONE;
        let mut prev_price = start_price;
        returns.push(ReturnData {
            date: actual_start_date,
            value: Decimal::ZERO,
        });

        for (date, price) in quote_points.iter().copied().skip(1) {
            if price <= Decimal::ZERO || prev_price <= Decimal::ZERO {
                prev_price = price;
                continue;
            }
            let daily_return = (price / prev_price) - Decimal::ONE;
            risk_samples.push(RiskSample {
                date,
                simple_return: daily_return,
            });
            cumulative_value *= Decimal::ONE + daily_return;
            returns.push(ReturnData {
                date,
                value: (cumulative_value - Decimal::ONE).round_dp(DECIMAL_PRECISION),
            });
            prev_price = price;
        }

        let total_return = if start_price.is_zero() {
            Decimal::ZERO
        } else {
            (end_price / start_price) - Decimal::ONE
        };
        let annualized_return =
            Self::annualize_optional_return(actual_start_date, actual_end_date, Some(total_return));
        let result = Self::build_result(
            asset_id.to_string(),
            currency,
            Some(actual_start_date),
            Some(actual_end_date),
            ReturnMethod::SymbolPriceBased,
            PerformanceReturns {
                twr: None,
                annualized_twr: None,
                irr: None,
                annualized_irr: None,
                value_return: Some(total_return.round_dp(DECIMAL_PRECISION)),
                annualized_value_return: annualized_return,
            },
            PerformanceAttribution::default(),
            Self::risk_from_samples(&risk_samples, Some(actual_start_date)),
            Self::data_quality(
                vec!["Symbol-only performance uses price quotes only; dividends and distributions are excluded unless the quote series is total-return adjusted.".to_string()],
                vec![
                    "TWR unavailable for symbol-only price performance because there is no portfolio cash-flow scope.".to_string(),
                    "IRR unavailable for symbol-only price performance because there are no user cash flows.".to_string(),
                ],
                false,
            ),
            returns,
            false,
            false,
        );

        Ok(result)
    }

    fn empty_response_with_context(
        id: &str,
        currency: &str,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
        reason: impl Into<String>,
    ) -> PerformanceResult {
        Self::build_result(
            id.to_string(),
            currency.to_string(),
            start_date,
            end_date,
            ReturnMethod::NotApplicable,
            PerformanceReturns {
                twr: None,
                annualized_twr: None,
                irr: None,
                annualized_irr: None,
                value_return: None,
                annualized_value_return: None,
            },
            PerformanceAttribution::default(),
            PerformanceRisk {
                volatility: None,
                max_drawdown: None,
                peak_date: None,
                trough_date: None,
                recovery_date: None,
                drawdown_duration_days: None,
            },
            PerformanceDataQuality::no_data(reason),
            Vec::new(),
            false,
            false,
        )
    }

    fn partial_response(
        id: &str,
        currency: &str,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
        warning: String,
    ) -> PerformanceResult {
        Self::build_result(
            id.to_string(),
            currency.to_string(),
            start_date,
            end_date,
            ReturnMethod::NotApplicable,
            PerformanceReturns {
                twr: None,
                annualized_twr: None,
                irr: None,
                annualized_irr: None,
                value_return: None,
                annualized_value_return: None,
            },
            PerformanceAttribution::default(),
            PerformanceRisk {
                volatility: None,
                max_drawdown: None,
                peak_date: None,
                trough_date: None,
                recovery_date: None,
                drawdown_duration_days: None,
            },
            PerformanceDataQuality {
                status: DataQualityStatus::Partial,
                warnings: vec![warning],
                not_applicable_reasons: vec![
                    "Performance metrics unavailable because scoped valuation history is incomplete."
                        .to_string(),
                ],
            },
            Vec::new(),
            false,
            false,
        )
    }

    fn calculate_annualized_return(
        start_date: NaiveDate,
        end_date: NaiveDate,
        total_return: Decimal,
    ) -> Decimal {
        if start_date > end_date {
            return Decimal::ZERO;
        }

        // If total_return is -100% or less, base would be 0 or negative.
        // powd might handle base = 0, but negative base for non-integer exponent is problematic.
        // Directly returning -1.0 (i.e., -100% loss) is a sensible cap.
        if total_return <= dec!(-1.0) {
            return dec!(-1.0);
        }

        let days = (end_date - start_date).num_days();

        if days <= 0 {
            return total_return;
        }

        let years = Decimal::from(days) / DAYS_PER_YEAR_DECIMAL;

        let base = Decimal::ONE + total_return;

        // This check is theoretically covered by `total_return <= dec!(-1.0)`,
        // but as a safeguard if `total_return` was just slightly above -1.0,
        // leading to `base` being zero or negative due to precision.
        if base <= Decimal::ZERO {
            return dec!(-1.0);
        }

        let exponent = Decimal::ONE / years;

        base.powd(exponent) - Decimal::ONE
    }

    fn period_return_from_annualized_optional(
        start_date: NaiveDate,
        end_date: NaiveDate,
        annualized_return: Option<Decimal>,
    ) -> Option<Decimal> {
        annualized_return.map(|value| {
            Self::calculate_period_return_from_annualized(start_date, end_date, value)
                .round_dp(DECIMAL_PRECISION)
        })
    }

    fn calculate_period_return_from_annualized(
        start_date: NaiveDate,
        end_date: NaiveDate,
        annualized_return: Decimal,
    ) -> Decimal {
        if start_date > end_date {
            return Decimal::ZERO;
        }

        if annualized_return <= dec!(-1.0) {
            return dec!(-1.0);
        }

        let days = (end_date - start_date).num_days();

        if days <= 0 {
            return annualized_return;
        }

        let years = Decimal::from(days) / DAYS_PER_YEAR_DECIMAL;
        let base = Decimal::ONE + annualized_return;

        if base <= Decimal::ZERO {
            return dec!(-1.0);
        }

        base.powd(years) - Decimal::ONE
    }

    fn calculate_volatility(daily_returns: &[Decimal]) -> Option<Decimal> {
        if daily_returns.len() < 2 {
            return None;
        }

        let log_returns: Vec<Decimal> = daily_returns
            .iter()
            .filter_map(|daily_return| {
                let factor = Decimal::ONE + *daily_return;
                if factor <= Decimal::ZERO {
                    return None;
                }
                factor
                    .to_f64()
                    .and_then(|factor| Decimal::from_f64(factor.ln()))
            })
            .collect();

        if log_returns.len() < 2 {
            return None;
        }

        let count = Decimal::from(log_returns.len());
        let sum: Decimal = log_returns.iter().sum();
        let mean = sum / count;

        let sum_squared_diff: Decimal = log_returns
            .iter()
            .map(|&r| {
                let diff = r - mean;
                diff * diff
            })
            .sum();

        let variance = sum_squared_diff / (count - Decimal::ONE);
        if variance.is_sign_negative() {
            return None;
        }

        let daily_volatility = variance.sqrt().unwrap_or(Decimal::ZERO);

        let annualization_factor = DAYS_PER_YEAR_DECIMAL
            .sqrt()
            .unwrap_or(SQRT_DAYS_PER_YEAR_APPROX);

        Some((daily_volatility * annualization_factor).round_dp(DECIMAL_PRECISION))
    }

    fn calculate_max_drawdown(
        samples: &[RiskSample],
        opening_date: Option<NaiveDate>,
    ) -> DrawdownComputation {
        if samples.is_empty() {
            return DrawdownComputation {
                max_drawdown: None,
                peak_date: None,
                trough_date: None,
                recovery_date: None,
                duration_days: None,
            };
        }

        let mut cumulative_value = Decimal::ONE;
        let mut peak_value = Decimal::ONE;
        let mut peak_date = opening_date.unwrap_or(samples[0].date);
        let mut max_drawdown = Decimal::ZERO;
        let mut max_peak_date = peak_date;
        let mut trough_date = samples[0].date;
        let mut recovery_date = None;
        let mut in_max_drawdown = false;

        for sample in samples {
            cumulative_value *= Decimal::ONE + sample.simple_return;
            if cumulative_value >= peak_value {
                peak_value = cumulative_value;
                peak_date = sample.date;
                if in_max_drawdown && recovery_date.is_none() {
                    recovery_date = Some(sample.date);
                }
            }

            if peak_value > Decimal::ZERO {
                let drawdown = (cumulative_value - peak_value) / peak_value;
                if drawdown < max_drawdown {
                    max_drawdown = drawdown;
                    max_peak_date = peak_date;
                    trough_date = sample.date;
                    recovery_date = None;
                    in_max_drawdown = true;
                }
            }
        }

        let duration_end = recovery_date.unwrap_or(trough_date);
        DrawdownComputation {
            max_drawdown: Some(max_drawdown.round_dp(DECIMAL_PRECISION)),
            peak_date: Some(max_peak_date),
            trough_date: Some(trough_date),
            recovery_date,
            duration_days: Some((duration_end - max_peak_date).num_days()),
        }
    }

    pub fn calculate_simple_performance(
        current: &DailyAccountValuation,
        _previous: Option<&DailyAccountValuation>,
        total_portfolio_value_base: Option<Decimal>,
    ) -> SimplePerformanceMetrics {
        // Use self for the current valuation data
        let total_gain_loss_amount = current.total_value - current.net_contribution;
        let denominator_cumulative_return = current.net_contribution;
        let cumulative_return_percent = if !denominator_cumulative_return.is_zero() {
            Some((total_gain_loss_amount / denominator_cumulative_return).round_dp(4))
        } else if total_gain_loss_amount.is_zero() {
            Some(Decimal::ZERO)
        } else {
            None
        };

        let total_value_base = current.total_value_base;
        let portfolio_weight = if let Some(total_portfolio) = total_portfolio_value_base {
            if !total_portfolio.is_zero() {
                Some(
                    (total_value_base / total_portfolio)
                        .max(Decimal::ZERO)
                        .min(Decimal::ONE)
                        .round_dp(4),
                )
            } else if total_value_base.is_zero() {
                Some(Decimal::ZERO)
            } else {
                None
            }
        } else {
            None
        };

        SimplePerformanceMetrics {
            account_id: current.account_id.clone(),
            total_value: Some(current.total_value),
            account_currency: Some(current.account_currency.clone()),
            base_currency: Some(current.base_currency.clone()),
            fx_rate_to_base: Some(current.fx_rate_to_base),
            total_gain_loss_amount: Some(total_gain_loss_amount.round_dp(2)),
            cumulative_return_percent,
            portfolio_weight,
        }
    }
}

#[async_trait::async_trait]
impl PerformanceServiceTrait for PerformanceService {
    /// Calculates cumulative returns for a given item (account or symbol)
    async fn calculate_performance_history(
        &self,
        item_type: &str,
        item_id: &str,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
        tracking_mode: Option<TrackingMode>,
        account_type: Option<&str>,
    ) -> Result<PerformanceResult> {
        match item_type {
            "account" => {
                self.calculate_account_performance(
                    item_id,
                    start_date,
                    end_date,
                    tracking_mode,
                    account_type,
                )
                .await
            }
            "symbol" => {
                self.calculate_symbol_performance(item_id, start_date, end_date)
                    .await
            }
            _ => Err(errors::Error::Validation(ValidationError::InvalidInput(
                "Invalid item type".to_string(),
            ))),
        }
    }

    async fn calculate_performance_history_for_accounts(
        &self,
        scope_id: &str,
        account_ids: &[String],
        base_currency: &str,
        account_tracking_modes: &HashMap<String, TrackingMode>,
        account_types: &HashMap<String, String>,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
    ) -> Result<PerformanceResult> {
        self.calculate_scoped_performance(ScopedPerformanceRequest {
            scope_id,
            account_ids,
            base_currency,
            account_tracking_modes,
            account_types,
            start_date,
            end_date,
            include_returns_series: true,
            profile: PerformanceSummaryProfile::Full,
        })
        .await
    }

    /// Calculates summary performance metrics. The `Summary` profile is used by
    /// dashboard cards to avoid unused IRR/risk work.
    async fn calculate_performance_summary(
        &self,
        item_type: &str,
        item_id: &str,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
        tracking_mode: Option<TrackingMode>,
        account_type: Option<&str>,
        profile: PerformanceSummaryProfile,
    ) -> Result<PerformanceResult> {
        match item_type {
            "account" => {
                self.calculate_account_performance_summary(
                    item_id,
                    start_date,
                    end_date,
                    tracking_mode,
                    account_type,
                    profile,
                )
                .await
            }
            "symbol" => {
                self.calculate_symbol_performance(item_id, start_date, end_date)
                    .await
            }
            _ => Err(errors::Error::Validation(ValidationError::InvalidInput(
                "Invalid item type".to_string(),
            ))),
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn calculate_performance_summary_for_accounts(
        &self,
        scope_id: &str,
        account_ids: &[String],
        base_currency: &str,
        account_tracking_modes: &HashMap<String, TrackingMode>,
        account_types: &HashMap<String, String>,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
        profile: PerformanceSummaryProfile,
    ) -> Result<PerformanceResult> {
        self.calculate_scoped_performance(ScopedPerformanceRequest {
            scope_id,
            account_ids,
            base_currency,
            account_tracking_modes,
            account_types,
            start_date,
            end_date,
            include_returns_series: false,
            profile,
        })
        .await
    }

    fn calculate_accounts_simple_performance(
        &self,
        account_ids: &[String],
    ) -> Result<Vec<SimplePerformanceMetrics>> {
        if account_ids.is_empty() {
            return Ok(Vec::new());
        }

        // 1. Fetch the *absolute* latest record for each account
        let latest_daily_valuations = self.valuation_service.get_latest_valuations(account_ids)?;

        let latest_daily_map: HashMap<String, DailyAccountValuation> = latest_daily_valuations
            .into_iter()
            .map(|d| (d.account_id.clone(), d))
            .collect();

        // 2. Determine the previous date for each account based on its absolute latest found date
        //    and group accounts by the previous date needed.
        let mut prev_dates_needed: HashMap<NaiveDate, Vec<String>> = HashMap::new();
        for account_id in account_ids {
            // Iterate over original requested IDs
            if let Some(latest_record) = latest_daily_map.get(account_id) {
                let prev_date = latest_record.valuation_date - Duration::days(1);
                prev_dates_needed
                    .entry(prev_date)
                    .or_default()
                    .push(account_id.clone());
            }
        }

        // 3. Fetch the previous day's records in bulk for all needed dates
        let mut previous_daily_map: HashMap<String, DailyAccountValuation> = HashMap::new();
        for (prev_date, ids) in prev_dates_needed {
            match self
                .valuation_service
                .get_valuations_on_date(&ids, prev_date)
            {
                Ok(records) => {
                    for record in records {
                        previous_daily_map.insert(record.account_id.clone(), record);
                    }
                }
                Err(e) => {
                    warn!(
                        "Failed to fetch valuation data for date {}: {}",
                        prev_date, e
                    );
                }
            }
        }

        // 4. Calculate total portfolio value by summing real-account base values.
        let total_portfolio_value_base: Decimal = account_ids
            .iter()
            .filter_map(|account_id| latest_daily_map.get(account_id))
            .map(|p| p.total_value_base)
            .sum();
        let total_portfolio_value_base = Some(total_portfolio_value_base);

        // 5. Construct results using the absolute latest and previous-to-latest records
        let mut results = Vec::with_capacity(account_ids.len());
        for account_id in account_ids {
            if let Some(current) = latest_daily_map.get(account_id) {
                let previous = previous_daily_map.get(account_id);
                let performance_metrics = Self::calculate_simple_performance(
                    current,
                    previous,
                    total_portfolio_value_base,
                );
                results.push(performance_metrics);
            } else {
                // This case might happen if history calculation failed or account is new
                debug!(
                    "No DailyAccountValuation found for account '{}' when fetching latest",
                    account_id
                );
            }
        }

        Ok(results)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assets::{
        Asset, AssetKind, AssetRepositoryTrait, NewAsset, ProviderProfile, QuoteMode,
        UpdateAssetProfile,
    };
    use crate::fx::{ExchangeRate, FxServiceTrait, NewExchangeRate};
    use crate::lots::{AssetLotView, LotClosure};
    use crate::portfolio::snapshot::{
        AccountStateSnapshot, HoldingsCalculator, Lot, Position, ProjectionRun,
    };
    use crate::portfolio::valuation::ValuationStatus;
    use crate::portfolio::valuation::{
        ExternalFlowSource, NegativeBalanceInfo, ValuationRecalcMode,
    };
    use crate::quotes::{
        FetchDividendsParams, LatestQuotePair, LatestQuoteSnapshot, ProviderInfo, Quote,
        QuoteImport, QuoteSyncState, ResolvedQuote, SymbolSearchResult, SymbolSyncPlan, SyncMode,
        SyncResult,
    };
    use chrono::{DateTime, Utc};
    use serde_json::json;
    use std::collections::VecDeque;
    use wealthfolio_market_data::DividendEvent;

    fn attribution_pnl(result: &PerformanceResult) -> Decimal {
        result.attribution.income
            + result.attribution.realized_pnl
            + result.attribution.unrealized_pnl_change
            + result.attribution.fx_effect
            - result.attribution.fees
            - result.attribution.taxes
    }

    fn valuation(
        date: &str,
        total_value: Decimal,
        net_contribution: Decimal,
        investment_market_value: Decimal,
        cost_basis: Decimal,
    ) -> DailyAccountValuation {
        DailyAccountValuation {
            id: format!("acct-{}", date),
            account_id: "acct".to_string(),
            valuation_date: NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap(),
            account_currency: "CAD".to_string(),
            base_currency: "CAD".to_string(),
            fx_rate_to_base: Decimal::ONE,
            cash_balance: total_value - investment_market_value,
            investment_market_value,
            total_value,
            cost_basis,
            book_basis: net_contribution,
            net_contribution,
            cash_balance_base: total_value - investment_market_value,
            investment_market_value_base: investment_market_value,
            total_value_base: total_value,
            cost_basis_base: cost_basis,
            book_basis_base: net_contribution,
            net_contribution_base: net_contribution,
            external_inflow_base: Decimal::ZERO,
            external_outflow_base: Decimal::ZERO,
            // No explicit flow provenance set: neutral by default (a quiet day).
            external_flow_source: ValuationExternalFlowSource::NoFlow,
            performance_eligible_value_base: total_value,
            value_status: ValuationStatus::Complete,
            basis_status: if investment_market_value.is_zero() {
                BasisStatus::NotApplicable
            } else {
                BasisStatus::Complete
            },
            calculated_at: DateTime::<Utc>::from_timestamp(0, 0).unwrap(),
        }
    }

    fn account_valuation(
        account_id: &str,
        date: &str,
        total_value: Decimal,
        net_contribution: Decimal,
        investment_market_value: Decimal,
        cost_basis: Decimal,
    ) -> DailyAccountValuation {
        let mut valuation = valuation(
            date,
            total_value,
            net_contribution,
            investment_market_value,
            cost_basis,
        );
        valuation.id = format!("{}-{}", account_id, date);
        valuation.account_id = account_id.to_string();
        valuation
    }

    fn lot_disposal(
        currency: &str,
        base_currency: &str,
        fx_rate_to_base: &str,
        cost_basis: &str,
        cost_basis_base: &str,
        realized_pnl_base: &str,
    ) -> LotDisposal {
        LotDisposal {
            id: "disposal-1".to_string(),
            lot_id: "lot-1".to_string(),
            account_id: "acct".to_string(),
            asset_id: "asset".to_string(),
            disposal_activity_id: "sell-1".to_string(),
            disposal_date: "2026-05-02".to_string(),
            quantity: "1".to_string(),
            proceeds: "120".to_string(),
            cost_basis: cost_basis.to_string(),
            realized_pnl: "20".to_string(),
            proceeds_base: "132".to_string(),
            cost_basis_base: cost_basis_base.to_string(),
            realized_pnl_base: realized_pnl_base.to_string(),
            currency: currency.to_string(),
            base_currency: base_currency.to_string(),
            fx_rate_to_base: fx_rate_to_base.to_string(),
            cost_basis_method: "FIFO".to_string(),
            created_at: "2026-05-02T00:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn activity_date_window_includes_user_timezone_midnight_edges() {
        let activity_time = DateTime::parse_from_rfc3339("2026-06-02T02:30:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let tz = parse_user_timezone_or_default("America/Toronto");
        let local_date = activity_date_in_tz(activity_time, tz);
        let (start_utc, end_exclusive_utc) =
            PerformanceService::activity_query_utc_bounds(date("2026-06-01"), date("2026-06-01"));

        assert_eq!(local_date, date("2026-06-01"));
        assert!(activity_time >= start_utc);
        assert!(activity_time < end_exclusive_utc);
    }

    #[derive(Clone)]
    struct TestValuationService {
        history: Vec<DailyAccountValuation>,
        fail_aggregate_scope_history: bool,
    }

    impl TestValuationService {
        fn new(history: Vec<DailyAccountValuation>) -> Self {
            Self {
                history,
                fail_aggregate_scope_history: false,
            }
        }

        fn new_with_aggregate_failure(history: Vec<DailyAccountValuation>) -> Self {
            Self {
                history,
                fail_aggregate_scope_history: true,
            }
        }

        fn filtered_history(
            &self,
            start_date_opt: Option<NaiveDate>,
            end_date_opt: Option<NaiveDate>,
        ) -> Vec<DailyAccountValuation> {
            self.history
                .iter()
                .filter(|valuation| {
                    start_date_opt.is_none_or(|start| valuation.valuation_date >= start)
                        && end_date_opt.is_none_or(|end| valuation.valuation_date <= end)
                })
                .cloned()
                .collect()
        }
    }

    #[async_trait]
    impl ValuationServiceTrait for TestValuationService {
        async fn calculate_valuation_history(
            &self,
            _account_id: &str,
            _mode: ValuationRecalcMode,
        ) -> Result<()> {
            Ok(())
        }

        fn get_historical_valuations(
            &self,
            account_id: &str,
            start_date_opt: Option<NaiveDate>,
            end_date_opt: Option<NaiveDate>,
        ) -> Result<Vec<DailyAccountValuation>> {
            Ok(self
                .filtered_history(start_date_opt, end_date_opt)
                .into_iter()
                .filter(|valuation| valuation.account_id == account_id)
                .collect())
        }

        fn get_historical_valuations_for_accounts(
            &self,
            _scope_id: &str,
            account_ids: &[String],
            _base_currency: &str,
            start_date_opt: Option<NaiveDate>,
            end_date_opt: Option<NaiveDate>,
        ) -> Result<Vec<DailyAccountValuation>> {
            if self.fail_aggregate_scope_history {
                return Err(errors::Error::Unexpected(
                    "aggregate scoped history should not be loaded".to_string(),
                ));
            }

            Ok(self
                .filtered_history(start_date_opt, end_date_opt)
                .into_iter()
                .filter(|valuation| account_ids.contains(&valuation.account_id))
                .collect())
        }

        fn get_latest_valuations(
            &self,
            account_ids: &[String],
        ) -> Result<Vec<DailyAccountValuation>> {
            Ok(account_ids
                .iter()
                .filter_map(|account_id| {
                    self.history
                        .iter()
                        .rev()
                        .find(|valuation| valuation.account_id == *account_id)
                        .cloned()
                })
                .collect())
        }

        fn get_valuations_on_date(
            &self,
            account_ids: &[String],
            date: NaiveDate,
        ) -> Result<Vec<DailyAccountValuation>> {
            Ok(self
                .history
                .iter()
                .filter(|valuation| {
                    valuation.valuation_date == date && account_ids.contains(&valuation.account_id)
                })
                .cloned()
                .collect())
        }

        fn get_accounts_with_negative_balance(
            &self,
            _account_ids: &[String],
        ) -> Result<Vec<NegativeBalanceInfo>> {
            Ok(Vec::new())
        }
    }

    #[derive(Clone, Default)]
    struct TestQuoteService;

    #[async_trait]
    impl QuoteServiceTrait for TestQuoteService {
        fn get_latest_quote(&self, _symbol: &str) -> Result<Quote> {
            Err(errors::Error::Unexpected(
                "TestQuoteService::get_latest_quote should not be called".to_string(),
            ))
        }

        fn get_latest_quotes(&self, _symbols: &[String]) -> Result<HashMap<String, Quote>> {
            Ok(HashMap::new())
        }

        fn get_latest_quotes_as_of(
            &self,
            _symbols: &[String],
            _as_of: NaiveDate,
        ) -> Result<HashMap<String, Quote>> {
            Ok(HashMap::new())
        }

        fn get_latest_quotes_snapshot(
            &self,
            _asset_ids: &[String],
        ) -> Result<HashMap<String, LatestQuoteSnapshot>> {
            Ok(HashMap::new())
        }

        fn get_latest_quotes_pair(
            &self,
            _symbols: &[String],
        ) -> Result<HashMap<String, LatestQuotePair>> {
            Ok(HashMap::new())
        }

        fn get_historical_quotes(&self, _symbol: &str) -> Result<Vec<Quote>> {
            Ok(Vec::new())
        }

        fn get_all_historical_quotes(&self) -> Result<HashMap<String, Vec<(NaiveDate, Quote)>>> {
            Ok(HashMap::new())
        }

        fn get_quotes_in_range(
            &self,
            _symbols: &HashSet<String>,
            _start: NaiveDate,
            _end: NaiveDate,
        ) -> Result<Vec<Quote>> {
            Ok(Vec::new())
        }

        fn get_quotes_in_range_filled(
            &self,
            symbols: &HashSet<String>,
            start: NaiveDate,
            end: NaiveDate,
        ) -> Result<Vec<Quote>> {
            let quote_date = date("2026-05-02");
            if !symbols.contains("AAPL240119C00150000") || quote_date < start || quote_date > end {
                return Ok(Vec::new());
            }

            let timestamp = quote_date.and_hms_opt(0, 0, 0).unwrap().and_utc();
            Ok(vec![Quote {
                id: "quote-AAPL240119C00150000".to_string(),
                asset_id: "AAPL240119C00150000".to_string(),
                timestamp,
                open: dec!(5),
                high: dec!(5),
                low: dec!(5),
                close: dec!(5),
                adjclose: dec!(5),
                volume: Decimal::ZERO,
                currency: "USD".to_string(),
                data_source: "TEST".to_string(),
                created_at: timestamp,
                notes: None,
            }])
        }

        async fn get_daily_quotes(
            &self,
            _asset_ids: &HashSet<String>,
            _start: NaiveDate,
            _end: NaiveDate,
        ) -> Result<HashMap<NaiveDate, HashMap<String, Quote>>> {
            Ok(HashMap::new())
        }

        async fn add_quote(&self, _quote: &Quote) -> Result<Quote> {
            Err(errors::Error::Unexpected(
                "TestQuoteService::add_quote should not be called".to_string(),
            ))
        }

        async fn update_quote(&self, quote: Quote) -> Result<Quote> {
            Ok(quote)
        }

        async fn delete_quote(&self, _quote_id: &str) -> Result<()> {
            Ok(())
        }

        async fn bulk_upsert_quotes(&self, _quotes: Vec<Quote>) -> Result<usize> {
            Ok(0)
        }

        async fn search_symbol(&self, _query: &str) -> Result<Vec<SymbolSearchResult>> {
            Ok(Vec::new())
        }

        async fn search_symbol_with_currency(
            &self,
            _query: &str,
            _account_currency: Option<&str>,
        ) -> Result<Vec<SymbolSearchResult>> {
            Ok(Vec::new())
        }

        async fn resolve_symbol_quote(
            &self,
            _symbol: &str,
            _exchange_mic: Option<&str>,
            _instrument_type: Option<&crate::assets::InstrumentType>,
            _quote_ccy: Option<&str>,
            _preferred_provider: Option<&str>,
        ) -> Result<ResolvedQuote> {
            Ok(ResolvedQuote::default())
        }

        async fn get_asset_profile(&self, _asset: &Asset) -> Result<ProviderProfile> {
            Ok(ProviderProfile::default())
        }

        async fn fetch_quotes_from_provider(
            &self,
            _asset_id: &str,
            _start: NaiveDate,
            _end: NaiveDate,
        ) -> Result<Vec<Quote>> {
            Ok(Vec::new())
        }

        async fn fetch_quotes_for_symbol(
            &self,
            _asset_id: &str,
            _currency: &str,
            _start: NaiveDate,
            _end: NaiveDate,
        ) -> Result<Vec<Quote>> {
            Ok(Vec::new())
        }

        async fn fetch_dividends(
            &self,
            _params: FetchDividendsParams,
        ) -> Result<Vec<DividendEvent>> {
            Ok(Vec::new())
        }

        async fn sync(
            &self,
            _mode: SyncMode,
            _asset_ids: Option<Vec<String>>,
        ) -> Result<SyncResult> {
            Err(errors::Error::Unexpected(
                "TestQuoteService::sync should not be called".to_string(),
            ))
        }

        async fn resync(&self, _asset_ids: Option<Vec<String>>) -> Result<SyncResult> {
            Err(errors::Error::Unexpected(
                "TestQuoteService::resync should not be called".to_string(),
            ))
        }

        async fn refresh_sync_state(&self) -> Result<()> {
            Ok(())
        }

        fn get_sync_plan(&self) -> Result<Vec<SymbolSyncPlan>> {
            Ok(Vec::new())
        }

        async fn handle_activity_created(
            &self,
            _symbol: &str,
            _activity_date: NaiveDate,
        ) -> Result<()> {
            Ok(())
        }

        async fn handle_activity_deleted(&self, _symbol: &str) -> Result<()> {
            Ok(())
        }

        async fn delete_sync_state(&self, _symbol: &str) -> Result<()> {
            Ok(())
        }

        fn get_symbols_needing_sync(&self) -> Result<Vec<QuoteSyncState>> {
            Ok(Vec::new())
        }

        fn get_sync_state(&self, _symbol: &str) -> Result<Option<QuoteSyncState>> {
            Ok(None)
        }

        async fn mark_profile_enriched(&self, _symbol: &str) -> Result<()> {
            Ok(())
        }

        fn get_assets_needing_profile_enrichment(&self) -> Result<Vec<QuoteSyncState>> {
            Ok(Vec::new())
        }

        fn get_sync_states_with_errors(&self) -> Result<Vec<QuoteSyncState>> {
            Ok(Vec::new())
        }

        async fn reset_sync_errors(&self, _asset_ids: &[String]) -> Result<()> {
            Ok(())
        }

        async fn reset_sync_state_for_profile_change(&self, _asset_id: &str) -> Result<()> {
            Ok(())
        }

        async fn update_position_status_from_holdings(
            &self,
            _current_holdings: &HashMap<String, Decimal>,
        ) -> Result<()> {
            Ok(())
        }

        async fn get_providers_info(&self) -> Result<Vec<ProviderInfo>> {
            Ok(Vec::new())
        }

        async fn update_provider_settings(
            &self,
            _provider_id: &str,
            _priority: i32,
            _enabled: bool,
        ) -> Result<()> {
            Ok(())
        }

        async fn check_quotes_import(
            &self,
            _content: &[u8],
            _has_header_row: bool,
        ) -> Result<Vec<QuoteImport>> {
            Ok(Vec::new())
        }

        async fn import_quotes(
            &self,
            quotes: Vec<QuoteImport>,
            _overwrite: bool,
        ) -> Result<Vec<QuoteImport>> {
            Ok(quotes)
        }
    }

    #[derive(Clone, Default)]
    struct TestFxService;

    #[async_trait]
    impl FxServiceTrait for TestFxService {
        fn initialize(&self) -> Result<()> {
            Ok(())
        }

        fn get_historical_rates(
            &self,
            _from_currency: &str,
            _to_currency: &str,
            _days: i64,
        ) -> Result<Vec<ExchangeRate>> {
            Ok(Vec::new())
        }

        fn get_latest_exchange_rate(
            &self,
            from_currency: &str,
            to_currency: &str,
        ) -> Result<Decimal> {
            if from_currency == to_currency {
                Ok(Decimal::ONE)
            } else if from_currency == "CAD" && to_currency == "USD" {
                Ok(dec!(0.75))
            } else if from_currency == "USD" && to_currency == "CAD" {
                Ok(dec!(1.3333333333333333333333333333))
            } else {
                Err(errors::Error::Unexpected(
                    "TestFxService only supports same-currency and CAD/USD conversion".to_string(),
                ))
            }
        }

        fn get_exchange_rate_for_date(
            &self,
            from_currency: &str,
            to_currency: &str,
            _date: NaiveDate,
        ) -> Result<Decimal> {
            self.get_latest_exchange_rate(from_currency, to_currency)
        }

        fn convert_currency(
            &self,
            amount: Decimal,
            from_currency: &str,
            to_currency: &str,
        ) -> Result<Decimal> {
            self.convert_currency_for_date(amount, from_currency, to_currency, date("2026-05-01"))
        }

        fn convert_currency_for_date(
            &self,
            amount: Decimal,
            from_currency: &str,
            to_currency: &str,
            _date: NaiveDate,
        ) -> Result<Decimal> {
            if from_currency == to_currency {
                Ok(amount)
            } else if from_currency == "CAD" && to_currency == "USD" {
                Ok(amount * dec!(0.75))
            } else if from_currency == "USD" && to_currency == "CAD" {
                Ok(amount * dec!(1.3333333333333333333333333333))
            } else {
                Err(errors::Error::Unexpected(
                    "TestFxService only supports same-currency and CAD/USD conversion".to_string(),
                ))
            }
        }

        fn get_latest_exchange_rates(&self) -> Result<Vec<ExchangeRate>> {
            Ok(Vec::new())
        }

        async fn add_exchange_rate(&self, _new_rate: NewExchangeRate) -> Result<ExchangeRate> {
            Err(errors::Error::Unexpected(
                "TestFxService::add_exchange_rate should not be called".to_string(),
            ))
        }

        async fn update_exchange_rate(
            &self,
            _from_currency: &str,
            _to_currency: &str,
            _rate: Decimal,
        ) -> Result<ExchangeRate> {
            Err(errors::Error::Unexpected(
                "TestFxService::update_exchange_rate should not be called".to_string(),
            ))
        }

        async fn delete_exchange_rate(&self, _rate_id: &str) -> Result<()> {
            Ok(())
        }

        async fn register_currency_pair(
            &self,
            _from_currency: &str,
            _to_currency: &str,
        ) -> Result<()> {
            Ok(())
        }

        async fn register_currency_pair_manual(
            &self,
            _from_currency: &str,
            _to_currency: &str,
        ) -> Result<()> {
            Ok(())
        }

        async fn ensure_fx_pairs(&self, _pairs: Vec<(String, String)>) -> Result<()> {
            Ok(())
        }
    }

    #[derive(Clone, Default)]
    struct TestAssetRepository;

    #[async_trait]
    impl AssetRepositoryTrait for TestAssetRepository {
        async fn create(&self, _new_asset: NewAsset) -> Result<Asset> {
            Err(errors::Error::Unexpected(
                "TestAssetRepository::create should not be called".to_string(),
            ))
        }

        async fn create_batch(&self, _new_assets: Vec<NewAsset>) -> Result<Vec<Asset>> {
            Err(errors::Error::Unexpected(
                "TestAssetRepository::create_batch should not be called".to_string(),
            ))
        }

        async fn update_profile(
            &self,
            _asset_id: &str,
            _payload: UpdateAssetProfile,
        ) -> Result<Asset> {
            Err(errors::Error::Unexpected(
                "TestAssetRepository::update_profile should not be called".to_string(),
            ))
        }

        async fn update_quote_mode(&self, _asset_id: &str, _quote_mode: &str) -> Result<Asset> {
            Err(errors::Error::Unexpected(
                "TestAssetRepository::update_quote_mode should not be called".to_string(),
            ))
        }

        fn get_by_id(&self, asset_id: &str) -> Result<Asset> {
            if asset_id == "AAPL" {
                Ok(Asset {
                    id: "AAPL".to_string(),
                    display_code: Some("AAPL".to_string()),
                    quote_ccy: "USD".to_string(),
                    name: Some("Apple Inc.".to_string()),
                    kind: AssetKind::Investment,
                    quote_mode: QuoteMode::Market,
                    created_at: Utc::now().naive_utc(),
                    updated_at: Utc::now().naive_utc(),
                    ..Default::default()
                })
            } else {
                Err(errors::Error::Repository(format!(
                    "Test asset not found: {}",
                    asset_id
                )))
            }
        }

        fn list(&self) -> Result<Vec<Asset>> {
            Ok(vec![self.get_by_id("AAPL")?])
        }

        fn list_by_asset_ids(&self, asset_ids: &[String]) -> Result<Vec<Asset>> {
            Ok(asset_ids
                .iter()
                .filter_map(|asset_id| self.get_by_id(asset_id).ok())
                .collect())
        }

        async fn delete(&self, _asset_id: &str) -> Result<()> {
            Ok(())
        }

        fn search_by_symbol(&self, _query: &str) -> Result<Vec<Asset>> {
            Ok(Vec::new())
        }

        fn find_by_instrument_key(&self, _instrument_key: &str) -> Result<Option<Asset>> {
            Ok(None)
        }

        async fn cleanup_legacy_metadata(&self, _asset_id: &str) -> Result<()> {
            Ok(())
        }

        async fn deactivate(&self, _asset_id: &str) -> Result<()> {
            Ok(())
        }

        async fn reactivate(&self, _asset_id: &str) -> Result<()> {
            Ok(())
        }

        async fn copy_user_metadata(&self, _source_id: &str, _target_id: &str) -> Result<()> {
            Ok(())
        }

        async fn deactivate_orphaned_investments(&self) -> Result<Vec<String>> {
            Ok(Vec::new())
        }
    }

    #[derive(Clone, Default)]
    struct TestLotRepository {
        disposals: Vec<LotDisposal>,
        lots: Vec<LotRecord>,
    }

    #[async_trait]
    impl LotRepositoryTrait for TestLotRepository {
        async fn replace_lots_for_account(
            &self,
            _account_id: &str,
            _lots: &[LotRecord],
        ) -> Result<()> {
            Ok(())
        }

        async fn get_open_lots_for_account(&self, _account_id: &str) -> Result<Vec<LotRecord>> {
            Ok(Vec::new())
        }

        async fn get_all_open_lots(&self) -> Result<Vec<LotRecord>> {
            Ok(Vec::new())
        }

        async fn get_lots_as_of_date(
            &self,
            _account_ids: &[String],
            _date: NaiveDate,
        ) -> Result<Vec<LotRecord>> {
            Ok(Vec::new())
        }

        async fn get_all_lots_for_account(&self, account_id: &str) -> Result<Vec<LotRecord>> {
            Ok(self
                .lots
                .iter()
                .filter(|lot| lot.account_id == account_id)
                .cloned()
                .collect())
        }

        async fn get_lots_for_asset(&self, _asset_id: &str) -> Result<Vec<LotRecord>> {
            Ok(Vec::new())
        }

        async fn get_asset_lot_view(
            &self,
            _asset_id: &str,
            _include_snapshot_positions: bool,
        ) -> Result<Vec<AssetLotView>> {
            Ok(Vec::new())
        }

        async fn get_all_lots(&self) -> Result<Vec<LotRecord>> {
            Ok(Vec::new())
        }

        async fn sync_lots_for_account(
            &self,
            _account_id: &str,
            _open_lots: &[LotRecord],
            _closures: &[LotClosure],
        ) -> Result<()> {
            Ok(())
        }

        async fn get_lot_disposals_for_account(
            &self,
            account_id: &str,
        ) -> Result<Vec<LotDisposal>> {
            Ok(self
                .disposals
                .iter()
                .filter(|disposal| disposal.account_id == account_id)
                .cloned()
                .collect())
        }

        fn get_lot_disposals_for_accounts_in_date_range_sync(
            &self,
            account_ids: &[String],
            start_date_exclusive: NaiveDate,
            end_date_inclusive: NaiveDate,
        ) -> Result<Vec<LotDisposal>> {
            Ok(self
                .disposals
                .iter()
                .filter(|disposal| account_ids.contains(&disposal.account_id))
                .filter(|disposal| {
                    NaiveDate::parse_from_str(&disposal.disposal_date, "%Y-%m-%d")
                        .is_ok_and(|date| date > start_date_exclusive && date <= end_date_inclusive)
                })
                .cloned()
                .collect())
        }

        async fn get_open_position_quantities(&self) -> Result<HashMap<String, Decimal>> {
            Ok(HashMap::new())
        }

        fn count_lots(&self) -> Result<i64> {
            Ok(0)
        }
    }

    #[derive(Clone)]
    struct TestActivityRepository {
        activities: Vec<Activity>,
    }

    impl TestActivityRepository {
        fn new(activities: Vec<Activity>) -> Self {
            Self { activities }
        }
    }

    #[async_trait]
    impl ActivityRepositoryTrait for TestActivityRepository {
        fn get_activity(&self, activity_id: &str) -> Result<Activity> {
            self.activities
                .iter()
                .find(|activity| activity.id == activity_id)
                .cloned()
                .ok_or_else(|| {
                    errors::Error::Unexpected(format!("activity {} not found", activity_id))
                })
        }

        fn find_transfer_counterpart(
            &self,
            group_id: &str,
            exclude_id: &str,
        ) -> Result<Option<Activity>> {
            Ok(self
                .activities
                .iter()
                .find(|activity| {
                    activity.source_group_id.as_deref() == Some(group_id)
                        && activity.id != exclude_id
                })
                .cloned())
        }

        fn get_activities(&self) -> Result<Vec<Activity>> {
            Ok(self.activities.clone())
        }

        fn get_activities_by_account_id(&self, account_id: &str) -> Result<Vec<Activity>> {
            Ok(self
                .activities
                .iter()
                .filter(|activity| activity.account_id == account_id)
                .cloned()
                .collect())
        }

        fn get_activities_by_account_ids(&self, account_ids: &[String]) -> Result<Vec<Activity>> {
            Ok(self
                .activities
                .iter()
                .filter(|activity| account_ids.contains(&activity.account_id))
                .cloned()
                .collect())
        }

        fn get_trading_activities(&self) -> Result<Vec<Activity>> {
            Ok(self
                .activities
                .iter()
                .filter(|activity| {
                    matches!(
                        activity.effective_type(),
                        crate::activities::ACTIVITY_TYPE_BUY
                            | crate::activities::ACTIVITY_TYPE_SELL
                            | crate::activities::ACTIVITY_TYPE_SPLIT
                    )
                })
                .cloned()
                .collect())
        }

        fn get_income_activities(&self) -> Result<Vec<Activity>> {
            Ok(self
                .activities
                .iter()
                .filter(|activity| {
                    matches!(
                        activity.effective_type(),
                        crate::activities::ACTIVITY_TYPE_DIVIDEND
                            | crate::activities::ACTIVITY_TYPE_INTEREST
                    )
                })
                .cloned()
                .collect())
        }

        fn get_contribution_activities(
            &self,
            _account_ids: &[String],
            _start_utc: DateTime<Utc>,
            _end_exclusive_utc: DateTime<Utc>,
        ) -> Result<Vec<crate::limits::ContributionActivity>> {
            Ok(Vec::new())
        }

        fn search_activities(
            &self,
            _page: i64,
            _page_size: i64,
            _account_id_filter: Option<Vec<String>>,
            _activity_type_filter: Option<Vec<String>>,
            _asset_id_keyword: Option<String>,
            _sort: Option<crate::activities::Sort>,
            _needs_review_filter: Option<bool>,
            _date_from: Option<NaiveDate>,
            _date_to: Option<NaiveDate>,
            _instrument_type_filter: Option<Vec<String>>,
            _activity_id_filter: Option<Vec<String>>,
        ) -> Result<crate::activities::ActivitySearchResponse> {
            Err(errors::Error::Unexpected(
                "TestActivityRepository::search_activities should not be called".to_string(),
            ))
        }

        async fn create_activity(
            &self,
            _new_activity: crate::activities::NewActivity,
        ) -> Result<Activity> {
            Err(errors::Error::Unexpected(
                "TestActivityRepository::create_activity should not be called".to_string(),
            ))
        }

        async fn update_activity(
            &self,
            _activity_update: crate::activities::ActivityUpdate,
        ) -> Result<Activity> {
            Err(errors::Error::Unexpected(
                "TestActivityRepository::update_activity should not be called".to_string(),
            ))
        }

        async fn delete_activity(&self, _activity_id: String) -> Result<Activity> {
            Err(errors::Error::Unexpected(
                "TestActivityRepository::delete_activity should not be called".to_string(),
            ))
        }

        async fn link_transfer_activities(
            &self,
            _activity_a_id: String,
            _activity_b_id: String,
        ) -> Result<(Activity, Activity)> {
            Err(errors::Error::Unexpected(
                "TestActivityRepository::link_transfer_activities should not be called".to_string(),
            ))
        }

        async fn unlink_transfer_activities(
            &self,
            _activity_a_id: String,
            _activity_b_id: String,
        ) -> Result<(Activity, Activity)> {
            Err(errors::Error::Unexpected(
                "TestActivityRepository::unlink_transfer_activities should not be called"
                    .to_string(),
            ))
        }

        async fn bulk_mutate_activities(
            &self,
            _creates: Vec<crate::activities::NewActivity>,
            _updates: Vec<crate::activities::ActivityUpdate>,
            _delete_ids: Vec<String>,
        ) -> Result<crate::activities::ActivityBulkMutationResult> {
            Err(errors::Error::Unexpected(
                "TestActivityRepository::bulk_mutate_activities should not be called".to_string(),
            ))
        }

        async fn create_activities(
            &self,
            _activities: Vec<crate::activities::NewActivity>,
        ) -> Result<usize> {
            Err(errors::Error::Unexpected(
                "TestActivityRepository::create_activities should not be called".to_string(),
            ))
        }

        fn get_first_activity_date(
            &self,
            account_ids: Option<&[String]>,
        ) -> Result<Option<DateTime<Utc>>> {
            let first = self
                .activities
                .iter()
                .filter(|activity| {
                    account_ids
                        .map(|ids| ids.contains(&activity.account_id))
                        .unwrap_or(true)
                })
                .map(|activity| activity.activity_date)
                .min();
            Ok(first)
        }

        fn get_import_mapping(
            &self,
            _account_id: &str,
            _context_kind: &str,
        ) -> Result<Option<crate::activities::ImportMapping>> {
            Ok(None)
        }

        async fn save_import_mapping(
            &self,
            _mapping: &crate::activities::ImportMapping,
        ) -> Result<()> {
            Ok(())
        }

        async fn link_account_template(
            &self,
            _account_id: &str,
            _template_id: &str,
            _context_kind: &str,
        ) -> Result<()> {
            Ok(())
        }

        fn list_import_templates(&self) -> Result<Vec<crate::activities::ImportTemplate>> {
            Ok(Vec::new())
        }

        fn get_import_template(
            &self,
            _template_id: &str,
        ) -> Result<Option<crate::activities::ImportTemplate>> {
            Ok(None)
        }

        async fn save_import_template(
            &self,
            _template: &crate::activities::ImportTemplate,
        ) -> Result<()> {
            Ok(())
        }

        async fn delete_import_template(&self, _template_id: &str) -> Result<()> {
            Ok(())
        }

        fn get_broker_sync_profile(
            &self,
            _account_id: &str,
            _source_system: &str,
        ) -> Result<Option<crate::activities::ImportTemplate>> {
            Ok(None)
        }

        async fn save_broker_sync_profile(
            &self,
            _template: &crate::activities::ImportTemplate,
        ) -> Result<()> {
            Ok(())
        }

        async fn link_broker_sync_profile(
            &self,
            _account_id: &str,
            _template_id: &str,
            _source_system: &str,
        ) -> Result<()> {
            Ok(())
        }

        fn calculate_average_cost(&self, _account_id: &str, _asset_id: &str) -> Result<Decimal> {
            Err(errors::Error::Unexpected(
                "TestActivityRepository::calculate_average_cost should not be called".to_string(),
            ))
        }

        fn get_income_activities_data(
            &self,
            _account_ids: Option<&[String]>,
        ) -> Result<Vec<crate::activities::IncomeData>> {
            Ok(Vec::new())
        }

        fn get_first_activity_date_overall(&self) -> Result<DateTime<Utc>> {
            self.activities
                .iter()
                .map(|activity| activity.activity_date)
                .min()
                .ok_or_else(|| errors::Error::Unexpected("no activities".to_string()))
        }

        fn get_activity_bounds_for_assets(
            &self,
            _asset_ids: &[String],
        ) -> Result<HashMap<String, (Option<NaiveDate>, Option<NaiveDate>)>> {
            Ok(HashMap::new())
        }

        fn get_holdings_snapshot_bounds_for_assets(
            &self,
            _asset_ids: &[String],
        ) -> Result<HashMap<String, (Option<NaiveDate>, Option<NaiveDate>)>> {
            Ok(HashMap::new())
        }

        fn check_existing_duplicates(
            &self,
            _idempotency_keys: &[String],
        ) -> Result<HashMap<String, String>> {
            Ok(HashMap::new())
        }

        async fn bulk_upsert(
            &self,
            _activities: Vec<crate::activities::ActivityUpsert>,
        ) -> Result<crate::activities::BulkUpsertResult> {
            Err(errors::Error::Unexpected(
                "TestActivityRepository::bulk_upsert should not be called".to_string(),
            ))
        }

        async fn reassign_asset(&self, _old_asset_id: &str, _new_asset_id: &str) -> Result<u32> {
            Err(errors::Error::Unexpected(
                "TestActivityRepository::reassign_asset should not be called".to_string(),
            ))
        }

        async fn get_activity_accounts_and_currencies_by_asset_id(
            &self,
            _asset_id: &str,
        ) -> Result<(Vec<String>, Vec<String>)> {
            Ok((Vec::new(), Vec::new()))
        }
    }

    /// Build the fixture used by the divergence / invariant tests: Feb 15 seed
    /// of 100 CAD, Mar 15 deposit of 2000 CAD + buy of 7 × 260, then a synthetic
    /// linear drift in holdings value to 1809.16 by Apr 14. Mirrors the shape
    /// of the user's Reproduce account that originally surfaced the bug.
    fn fixture_small_seed_then_large_deposit() -> Vec<DailyAccountValuation> {
        let mut history = Vec::new();

        // Feb 15 → Mar 14: $100 cash, no activity.
        let mut d = NaiveDate::parse_from_str("2026-02-15", "%Y-%m-%d").unwrap();
        let pre_deposit_end = NaiveDate::parse_from_str("2026-03-14", "%Y-%m-%d").unwrap();
        while d <= pre_deposit_end {
            history.push(valuation(
                &d.format("%Y-%m-%d").to_string(),
                dec!(100),
                dec!(100),
                Decimal::ZERO,
                Decimal::ZERO,
            ));
            d = d.succ_opt().unwrap();
        }

        // Mar 15: deposit 2000, buy 7 × 260 = 1820 same day. Net contribution
        // 2100, total_value 2100 (cash 280 + holdings at cost 1820).
        let mut deposit_day =
            valuation("2026-03-15", dec!(2100), dec!(2100), dec!(1820), dec!(1820));
        deposit_day.external_inflow_base = dec!(2000);
        deposit_day.external_flow_source = ValuationExternalFlowSource::CashAmount;
        history.push(deposit_day);

        // Mar 16 → Apr 13: holdings drift down by ~0.7/day (~$20 total over ~29 days).
        let mut d = NaiveDate::parse_from_str("2026-03-16", "%Y-%m-%d").unwrap();
        let drift_end = NaiveDate::parse_from_str("2026-04-13", "%Y-%m-%d").unwrap();
        let mut imv = dec!(1820);
        while d <= drift_end {
            imv -= dec!(0.7);
            history.push(valuation(
                &d.format("%Y-%m-%d").to_string(),
                dec!(280) + imv,
                dec!(2100),
                imv,
                dec!(1820),
            ));
            d = d.succ_opt().unwrap();
        }

        // Apr 14: final row — value matches the dashboard screenshot.
        history.push(valuation(
            "2026-04-14",
            dec!(2089.16),
            dec!(2100),
            dec!(1809.16),
            dec!(1820),
        ));

        history
    }

    fn date(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    fn activity_time(date_str: &str) -> DateTime<Utc> {
        date(date_str).and_hms_opt(0, 0, 0).unwrap().and_utc()
    }

    fn test_activity(
        id: &str,
        account_id: &str,
        activity_type: ActivityType,
        date_str: &str,
    ) -> Activity {
        let activity_time = activity_time(date_str);
        Activity {
            id: id.to_string(),
            account_id: account_id.to_string(),
            asset_id: None,
            activity_type: activity_type.as_str().to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: None,
            status: crate::activities::ActivityStatus::Posted,
            activity_date: activity_time,
            settlement_date: None,
            quantity: None,
            unit_price: None,
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

    fn sell_activity_on(
        id: &str,
        account_id: &str,
        date_str: &str,
        quantity: Decimal,
        price: Decimal,
    ) -> Activity {
        let mut activity = test_activity(id, account_id, ActivityType::Sell, date_str);
        activity.asset_id = Some("AAPL".to_string());
        activity.quantity = Some(quantity);
        activity.unit_price = Some(price);
        activity
    }

    fn buy_activity_on(
        id: &str,
        account_id: &str,
        date_str: &str,
        quantity: Decimal,
        price: Decimal,
    ) -> Activity {
        let mut activity = test_activity(id, account_id, ActivityType::Buy, date_str);
        activity.asset_id = Some("AAPL".to_string());
        activity.quantity = Some(quantity);
        activity.unit_price = Some(price);
        activity
    }

    fn sell_activity(id: &str, account_id: &str, quantity: Decimal, price: Decimal) -> Activity {
        sell_activity_on(id, account_id, "2026-05-02", quantity, price)
    }

    fn split_activity_on(id: &str, account_id: &str, date_str: &str, ratio: Decimal) -> Activity {
        let mut activity = test_activity(id, account_id, ActivityType::Split, date_str);
        activity.asset_id = Some("AAPL".to_string());
        activity.amount = Some(ratio);
        activity
    }

    fn income_activity_on(
        id: &str,
        account_id: &str,
        date_str: &str,
        activity_type: ActivityType,
        amount: Decimal,
    ) -> Activity {
        let mut activity = test_activity(id, account_id, activity_type, date_str);
        activity.amount = Some(amount);
        activity
    }

    fn transfer_out_activity_on(
        id: &str,
        account_id: &str,
        date_str: &str,
        quantity: Decimal,
    ) -> Activity {
        let mut activity = test_activity(id, account_id, ActivityType::TransferOut, date_str);
        activity.asset_id = Some("AAPL".to_string());
        activity.quantity = Some(quantity);
        activity.unit_price = Some(Decimal::ZERO);
        activity
    }

    fn lot_record_for_fee_gross_up(
        id: &str,
        account_id: &str,
        open_activity_id: &str,
    ) -> LotRecord {
        LotRecord {
            id: id.to_string(),
            account_id: account_id.to_string(),
            asset_id: "AAPL".to_string(),
            open_date: "2026-05-02".to_string(),
            open_activity_id: Some(open_activity_id.to_string()),
            original_quantity: "1".to_string(),
            remaining_quantity: "0".to_string(),
            cost_per_unit: "100".to_string(),
            original_cost_basis: "110".to_string(),
            remaining_cost_basis: "0".to_string(),
            original_cost_basis_base: "110".to_string(),
            remaining_cost_basis_base: "0".to_string(),
            fee_allocated: "10".to_string(),
            fee_allocated_base: "10".to_string(),
            tax_allocated: "0".to_string(),
            tax_allocated_base: "0".to_string(),
            currency: "USD".to_string(),
            base_currency: "USD".to_string(),
            fx_rate_to_base: "1".to_string(),
            cost_basis_method: "FIFO".to_string(),
            split_ratio: "1".to_string(),
            is_closed: true,
            close_date: Some("2026-05-03".to_string()),
            close_activity_id: Some("transfer-out-1".to_string()),
            created_at: "2026-05-02T00:00:00.000Z".to_string(),
            updated_at: "2026-05-03T00:00:00.000Z".to_string(),
        }
    }

    fn generate_fifo_sell_disposal() -> LotDisposal {
        let account_id = "acct";
        let start_date = date("2026-05-01");
        let sell_date = date("2026-05-02");
        let acquisition_time = start_date.and_hms_opt(0, 0, 0).unwrap().and_utc();

        let mut position = Position::new(
            account_id.to_string(),
            "AAPL".to_string(),
            "USD".to_string(),
            acquisition_time,
        );
        position.quantity = dec!(10);
        position.average_cost = dec!(100);
        position.total_cost_basis = dec!(1000);
        position.lots = VecDeque::from([Lot {
            id: "lot-1".to_string(),
            position_id: position.id.clone(),
            acquisition_date: acquisition_time,
            acquisition_local_date: None,
            quantity: dec!(10),
            original_quantity: dec!(10),
            cost_basis: dec!(1000),
            acquisition_price: dec!(100),
            acquisition_fees: Decimal::ZERO,
            original_acquisition_fees: Decimal::ZERO,
            acquisition_taxes: Decimal::ZERO,
            original_acquisition_taxes: Decimal::ZERO,
            fx_rate_to_position: None,
            fx_rate_to_account: None,
            account_currency: None,
            fx_rate_to_base: None,
            base_currency: None,
            source_activity_id: Some("buy-1".to_string()),
            split_ratio: Decimal::ONE,
        }]);

        let previous_snapshot = AccountStateSnapshot {
            id: AccountStateSnapshot::stable_id(account_id, start_date),
            account_id: account_id.to_string(),
            snapshot_date: start_date,
            currency: "USD".to_string(),
            positions: HashMap::from([("AAPL".to_string(), position)]),
            cost_basis: dec!(1000),
            net_contribution: dec!(1000),
            net_contribution_base: dec!(1000),
            calculated_at: start_date.and_hms_opt(0, 0, 0).unwrap(),
            ..Default::default()
        };

        let calculator = HoldingsCalculator::new(
            Arc::new(TestFxService),
            Arc::new(RwLock::new("USD".to_string())),
            Arc::new(TestAssetRepository),
        );
        let mut run = ProjectionRun::new();
        let result = calculator
            .calculate_next_holdings(
                &mut run,
                &previous_snapshot,
                &[sell_activity("sell-1", account_id, dec!(4), dec!(120))],
                sell_date,
            )
            .expect("sell should reduce FIFO lots");

        let position = result
            .snapshot
            .positions
            .get("AAPL")
            .expect("remaining AAPL position should exist");
        assert_eq!(position.quantity, dec!(6));
        assert_eq!(position.total_cost_basis, dec!(600));

        let disposals = run.take_lot_disposals(account_id, "FIFO");
        assert_eq!(disposals.len(), 1);
        disposals.into_iter().next().unwrap()
    }

    fn generate_split_sell_disposal() -> LotDisposal {
        let account_id = "acct";
        let start_date = date("2026-05-01");
        let split_date = date("2026-05-02");
        let sell_date = date("2026-05-03");
        let acquisition_time = activity_time("2026-05-01");

        let mut position = Position::new(
            account_id.to_string(),
            "AAPL".to_string(),
            "USD".to_string(),
            acquisition_time,
        );
        position.quantity = dec!(10);
        position.average_cost = dec!(100);
        position.total_cost_basis = dec!(1000);
        position.lots = VecDeque::from([Lot {
            id: "lot-1".to_string(),
            position_id: position.id.clone(),
            acquisition_date: acquisition_time,
            acquisition_local_date: None,
            quantity: dec!(10),
            original_quantity: dec!(10),
            cost_basis: dec!(1000),
            acquisition_price: dec!(100),
            acquisition_fees: Decimal::ZERO,
            original_acquisition_fees: Decimal::ZERO,
            acquisition_taxes: Decimal::ZERO,
            original_acquisition_taxes: Decimal::ZERO,
            fx_rate_to_position: None,
            fx_rate_to_account: None,
            account_currency: None,
            fx_rate_to_base: None,
            base_currency: None,
            source_activity_id: Some("buy-1".to_string()),
            split_ratio: Decimal::ONE,
        }]);

        let previous_snapshot = AccountStateSnapshot {
            id: AccountStateSnapshot::stable_id(account_id, start_date),
            account_id: account_id.to_string(),
            snapshot_date: start_date,
            currency: "USD".to_string(),
            positions: HashMap::from([("AAPL".to_string(), position)]),
            cost_basis: dec!(1000),
            net_contribution: dec!(1000),
            net_contribution_base: dec!(1000),
            calculated_at: start_date.and_hms_opt(0, 0, 0).unwrap(),
            ..Default::default()
        };

        let calculator = HoldingsCalculator::new(
            Arc::new(TestFxService),
            Arc::new(RwLock::new("USD".to_string())),
            Arc::new(TestAssetRepository),
        );
        let mut run = ProjectionRun::new();
        let split_result = calculator
            .calculate_next_holdings(
                &mut run,
                &previous_snapshot,
                &[split_activity_on(
                    "split-1",
                    account_id,
                    "2026-05-02",
                    dec!(2),
                )],
                split_date,
            )
            .expect("split should adjust the open lot");
        let split_position = split_result
            .snapshot
            .positions
            .get("AAPL")
            .expect("split AAPL position should exist");
        assert_eq!(split_position.quantity, dec!(20));
        assert_eq!(split_position.average_cost, dec!(50));
        assert_eq!(split_position.total_cost_basis, dec!(1000));
        assert_eq!(split_position.lots[0].quantity, dec!(10));
        assert_eq!(split_position.lots[0].split_ratio, dec!(2));

        let sell_result = calculator
            .calculate_next_holdings(
                &mut run,
                &split_result.snapshot,
                &[sell_activity_on(
                    "sell-split-1",
                    account_id,
                    "2026-05-03",
                    dec!(6),
                    dec!(70),
                )],
                sell_date,
            )
            .expect("post-split sell should reduce FIFO lots");
        let position = sell_result
            .snapshot
            .positions
            .get("AAPL")
            .expect("remaining AAPL position should exist");
        assert_eq!(position.quantity, dec!(14));
        assert_eq!(position.average_cost, dec!(50));
        assert_eq!(position.total_cost_basis, dec!(700));
        assert_eq!(position.lots[0].quantity, dec!(7));
        assert_eq!(position.lots[0].split_ratio, dec!(2));

        let disposals = run.take_lot_disposals(account_id, "FIFO");
        assert_eq!(disposals.len(), 1);
        disposals.into_iter().next().unwrap()
    }

    #[tokio::test]
    async fn sell_lot_disposal_feeds_realized_pnl_and_cashflow_into_performance() {
        let disposal = generate_fifo_sell_disposal();
        assert_eq!(disposal.disposal_activity_id, "sell-1");
        assert_eq!(disposal.cost_basis_method, "FIFO");
        assert_eq!(Decimal::from_str(&disposal.proceeds).unwrap(), dec!(480));
        assert_eq!(Decimal::from_str(&disposal.cost_basis).unwrap(), dec!(400));
        assert_eq!(Decimal::from_str(&disposal.realized_pnl).unwrap(), dec!(80));
        assert_eq!(
            Decimal::from_str(&disposal.proceeds_base).unwrap(),
            dec!(480)
        );
        assert_eq!(
            Decimal::from_str(&disposal.cost_basis_base).unwrap(),
            dec!(400)
        );
        assert_eq!(
            Decimal::from_str(&disposal.realized_pnl_base).unwrap(),
            dec!(80)
        );

        let mut start = valuation("2026-05-01", dec!(1000), dec!(1000), dec!(1000), dec!(1000));
        start.account_currency = "USD".to_string();
        start.base_currency = "USD".to_string();
        start.external_flow_source = ExternalFlowSource::ActivityDerived;

        let mut after_sell = valuation("2026-05-02", dec!(1200), dec!(1000), dec!(720), dec!(600));
        after_sell.account_currency = "USD".to_string();
        after_sell.base_currency = "USD".to_string();
        after_sell.external_flow_source = ExternalFlowSource::ActivityDerived;

        let mut after_withdrawal =
            valuation("2026-05-03", dec!(1000), dec!(800), dec!(720), dec!(600));
        after_withdrawal.account_currency = "USD".to_string();
        after_withdrawal.base_currency = "USD".to_string();
        after_withdrawal.external_outflow_base = dec!(200);
        after_withdrawal.external_flow_source = ExternalFlowSource::ActivityDerived;

        let valuation_service = Arc::new(TestValuationService::new(vec![
            start,
            after_sell,
            after_withdrawal,
        ]));
        let performance_service =
            PerformanceService::new(valuation_service, Arc::new(TestQuoteService))
                .with_lot_repository(Arc::new(TestLotRepository {
                    disposals: vec![disposal],
                    ..Default::default()
                }));
        let account_ids = vec!["acct".to_string()];

        let performance = performance_service
            .calculate_performance_history_for_accounts(
                "scope:acct",
                &account_ids,
                "USD",
                &HashMap::new(),
                &HashMap::new(),
                Some(date("2026-05-01")),
                Some(date("2026-05-03")),
            )
            .await
            .expect("performance should include lot disposal attribution");

        assert_eq!(performance.attribution.contributions, Decimal::ZERO);
        assert_eq!(performance.attribution.distributions, dec!(200));
        assert_eq!(performance.attribution.realized_pnl, dec!(80));
        assert_eq!(performance.attribution.unrealized_pnl_change, dec!(120));
        assert_eq!(performance.attribution.residual, Decimal::ZERO);
        assert_eq!(attribution_pnl(&performance), dec!(200));
        assert_eq!(performance.summary.amount, Some(dec!(200)));
        assert_eq!(performance.returns.twr.unwrap().round_dp(4), dec!(0.2));
        assert_eq!(
            performance.returns.value_return.unwrap().round_dp(4),
            dec!(0.2)
        );
        assert_eq!(
            performance.series.last().unwrap().value.round_dp(4),
            dec!(0.2)
        );
    }

    #[tokio::test]
    async fn buy_to_cover_lot_disposal_feeds_realized_pnl_into_performance() {
        let mut start = valuation("2026-05-01", dec!(1000), dec!(1000), dec!(1000), dec!(1000));
        start.account_currency = "USD".to_string();
        start.base_currency = "USD".to_string();
        start.external_flow_source = ExternalFlowSource::ActivityDerived;

        let mut after_cover =
            valuation("2026-05-03", dec!(1080), dec!(1000), dec!(1000), dec!(1000));
        after_cover.account_currency = "USD".to_string();
        after_cover.base_currency = "USD".to_string();
        after_cover.external_flow_source = ExternalFlowSource::ActivityDerived;

        let mut cover_disposal = lot_disposal("USD", "USD", "1", "-400", "-400", "80");
        cover_disposal.id = "cover-disposal-1".to_string();
        cover_disposal.disposal_activity_id = "cover-1".to_string();
        cover_disposal.disposal_date = "2026-05-02".to_string();
        cover_disposal.quantity = "-4".to_string();

        let valuation_service = Arc::new(TestValuationService::new(vec![start, after_cover]));
        let performance_service =
            PerformanceService::new(valuation_service, Arc::new(TestQuoteService))
                .with_lot_repository(Arc::new(TestLotRepository {
                    disposals: vec![cover_disposal],
                    ..Default::default()
                }))
                .with_activity_repository(
                    Arc::new(TestActivityRepository::new(vec![buy_activity_on(
                        "cover-1",
                        "acct",
                        "2026-05-02",
                        dec!(4),
                        dec!(80),
                    )])),
                    Arc::new(TestFxService),
                );

        let performance = performance_service
            .calculate_performance_history_for_accounts(
                "scope:acct",
                &["acct".to_string()],
                "USD",
                &HashMap::new(),
                &HashMap::new(),
                Some(date("2026-05-01")),
                Some(date("2026-05-03")),
            )
            .await
            .expect("performance should include buy-to-cover disposal attribution");

        assert_eq!(performance.attribution.contributions, Decimal::ZERO);
        assert_eq!(performance.attribution.distributions, Decimal::ZERO);
        assert_eq!(performance.attribution.realized_pnl, dec!(80));
        assert_eq!(performance.attribution.unrealized_pnl_change, Decimal::ZERO);
        assert_eq!(performance.attribution.residual, Decimal::ZERO);
        assert_eq!(attribution_pnl(&performance), dec!(80));
        assert_eq!(performance.summary.amount, Some(dec!(80)));
    }

    #[tokio::test]
    async fn split_sell_disposal_dividend_and_interest_feed_performance_attribution() {
        let disposal = generate_split_sell_disposal();
        assert_eq!(disposal.disposal_activity_id, "sell-split-1");
        assert_eq!(disposal.cost_basis_method, "FIFO");
        assert_eq!(Decimal::from_str(&disposal.quantity).unwrap(), dec!(6));
        assert_eq!(Decimal::from_str(&disposal.proceeds).unwrap(), dec!(420));
        assert_eq!(Decimal::from_str(&disposal.cost_basis).unwrap(), dec!(300));
        assert_eq!(
            Decimal::from_str(&disposal.realized_pnl).unwrap(),
            dec!(120)
        );
        assert_eq!(
            Decimal::from_str(&disposal.proceeds_base).unwrap(),
            dec!(420)
        );
        assert_eq!(
            Decimal::from_str(&disposal.cost_basis_base).unwrap(),
            dec!(300)
        );
        assert_eq!(
            Decimal::from_str(&disposal.realized_pnl_base).unwrap(),
            dec!(120)
        );

        let mut start = valuation("2026-05-01", dec!(1000), dec!(1000), dec!(1000), dec!(1000));
        start.account_currency = "USD".to_string();
        start.base_currency = "USD".to_string();
        start.external_flow_source = ExternalFlowSource::ActivityDerived;

        let mut after_split =
            valuation("2026-05-02", dec!(1000), dec!(1000), dec!(1000), dec!(1000));
        after_split.account_currency = "USD".to_string();
        after_split.base_currency = "USD".to_string();
        after_split.external_flow_source = ExternalFlowSource::ActivityDerived;

        let mut after_sell = valuation("2026-05-03", dec!(1470), dec!(1000), dec!(1050), dec!(700));
        after_sell.account_currency = "USD".to_string();
        after_sell.base_currency = "USD".to_string();
        after_sell.external_flow_source = ExternalFlowSource::ActivityDerived;

        let mut after_income_withdrawal =
            valuation("2026-05-04", dec!(1420), dec!(900), dec!(1050), dec!(700));
        after_income_withdrawal.account_currency = "USD".to_string();
        after_income_withdrawal.base_currency = "USD".to_string();
        after_income_withdrawal.external_outflow_base = dec!(100);
        after_income_withdrawal.external_flow_source = ExternalFlowSource::ActivityDerived;

        let valuation_service = Arc::new(TestValuationService::new(vec![
            start,
            after_split,
            after_sell,
            after_income_withdrawal,
        ]));
        let activity_repo = Arc::new(TestActivityRepository::new(vec![
            split_activity_on("split-1", "acct", "2026-05-02", dec!(2)),
            sell_activity_on("sell-split-1", "acct", "2026-05-03", dec!(6), dec!(70)),
            income_activity_on(
                "dividend-1",
                "acct",
                "2026-05-04",
                ActivityType::Dividend,
                dec!(30),
            ),
            income_activity_on(
                "interest-1",
                "acct",
                "2026-05-04",
                ActivityType::Interest,
                dec!(20),
            ),
        ]));
        let performance_service =
            PerformanceService::new(valuation_service, Arc::new(TestQuoteService))
                .with_lot_repository(Arc::new(TestLotRepository {
                    disposals: vec![disposal],
                    ..Default::default()
                }))
                .with_activity_repository(activity_repo, Arc::new(TestFxService));
        let account_ids = vec!["acct".to_string()];

        let performance = performance_service
            .calculate_performance_history_for_accounts(
                "scope:acct",
                &account_ids,
                "USD",
                &HashMap::new(),
                &HashMap::new(),
                Some(date("2026-05-01")),
                Some(date("2026-05-04")),
            )
            .await
            .expect("performance should include split-aware disposal and income attribution");

        assert_eq!(performance.attribution.contributions, Decimal::ZERO);
        assert_eq!(performance.attribution.distributions, dec!(100));
        assert_eq!(performance.attribution.income, dec!(50));
        assert_eq!(performance.attribution.realized_pnl, dec!(120));
        assert_eq!(performance.attribution.unrealized_pnl_change, dec!(350));
        assert_eq!(performance.attribution.fees, Decimal::ZERO);
        assert_eq!(performance.attribution.taxes, Decimal::ZERO);
        assert_eq!(performance.attribution.residual, Decimal::ZERO);
        assert_eq!(attribution_pnl(&performance), dec!(520));
        assert_eq!(performance.summary.amount, Some(dec!(520)));
        assert_eq!(performance.returns.twr.unwrap().round_dp(4), dec!(0.52));
        assert_eq!(
            performance.returns.value_return.unwrap().round_dp(4),
            dec!(0.52)
        );
        assert_eq!(
            performance.series.last().unwrap().value.round_dp(4),
            dec!(0.52)
        );
    }

    #[tokio::test]
    async fn transfer_out_lot_feedback_does_not_feed_realized_pnl() {
        let mut start = valuation("2026-05-01", dec!(1000), dec!(1000), dec!(1000), dec!(1000));
        start.account_currency = "USD".to_string();
        start.base_currency = "USD".to_string();
        start.external_flow_source = ExternalFlowSource::ActivityDerived;

        let mut after_transfer =
            valuation("2026-05-03", dec!(1000), dec!(1000), dec!(1000), dec!(1000));
        after_transfer.account_currency = "USD".to_string();
        after_transfer.base_currency = "USD".to_string();
        after_transfer.external_flow_source = ExternalFlowSource::ActivityDerived;

        let mut transfer_disposal = lot_disposal("USD", "USD", "1", "100", "100", "33");
        transfer_disposal.id = "transfer-disposal-1".to_string();
        transfer_disposal.disposal_activity_id = "transfer-out-1".to_string();
        transfer_disposal.disposal_date = "2026-05-02".to_string();

        let transfer_out =
            transfer_out_activity_on("transfer-out-1", "acct", "2026-05-02", dec!(1));
        let valuation_service = Arc::new(TestValuationService::new(vec![start, after_transfer]));
        let performance_service =
            PerformanceService::new(valuation_service, Arc::new(TestQuoteService))
                .with_lot_repository(Arc::new(TestLotRepository {
                    disposals: vec![transfer_disposal],
                    ..Default::default()
                }))
                .with_activity_repository(
                    Arc::new(TestActivityRepository::new(vec![transfer_out])),
                    Arc::new(TestFxService),
                );

        let performance = performance_service
            .calculate_performance_history_for_accounts(
                "scope:acct",
                &["acct".to_string()],
                "USD",
                &HashMap::new(),
                &HashMap::new(),
                Some(date("2026-05-01")),
                Some(date("2026-05-03")),
            )
            .await
            .expect("transfer lot feedback should not be realized P&L");

        assert_eq!(performance.attribution.realized_pnl, Decimal::ZERO);
        assert_eq!(attribution_pnl(&performance), Decimal::ZERO);
    }

    #[tokio::test]
    async fn transfer_out_lot_feedback_does_not_realize_trade_fee_gross_up() {
        let mut start = valuation("2026-05-01", dec!(1000), dec!(1000), dec!(1000), dec!(1000));
        start.account_currency = "USD".to_string();
        start.base_currency = "USD".to_string();
        start.external_flow_source = ExternalFlowSource::ActivityDerived;

        let mut after_transfer =
            valuation("2026-05-03", dec!(1000), dec!(1000), dec!(1000), dec!(1000));
        after_transfer.account_currency = "USD".to_string();
        after_transfer.base_currency = "USD".to_string();
        after_transfer.external_flow_source = ExternalFlowSource::ActivityDerived;

        let mut transfer_disposal = lot_disposal("USD", "USD", "1", "110", "110", "0");
        transfer_disposal.id = "transfer-disposal-fees".to_string();
        transfer_disposal.lot_id = "lot-fee".to_string();
        transfer_disposal.disposal_activity_id = "transfer-out-1".to_string();
        transfer_disposal.disposal_date = "2026-05-03".to_string();

        let mut buy = test_activity("buy-1", "acct", ActivityType::Buy, "2026-05-02");
        buy.asset_id = Some("AAPL".to_string());
        buy.quantity = Some(dec!(1));
        buy.unit_price = Some(dec!(100));
        buy.fee = Some(dec!(10));
        let transfer_out =
            transfer_out_activity_on("transfer-out-1", "acct", "2026-05-03", dec!(1));

        let valuation_service = Arc::new(TestValuationService::new(vec![start, after_transfer]));
        let performance_service =
            PerformanceService::new(valuation_service, Arc::new(TestQuoteService))
                .with_lot_repository(Arc::new(TestLotRepository {
                    disposals: vec![transfer_disposal],
                    lots: vec![lot_record_for_fee_gross_up("lot-fee", "acct", "buy-1")],
                }))
                .with_activity_repository(
                    Arc::new(TestActivityRepository::new(vec![buy, transfer_out])),
                    Arc::new(TestFxService),
                );

        let performance = performance_service
            .calculate_performance_history_for_accounts(
                "scope:acct",
                &["acct".to_string()],
                "USD",
                &HashMap::new(),
                &HashMap::new(),
                Some(date("2026-05-01")),
                Some(date("2026-05-03")),
            )
            .await
            .expect("transfer lot feedback should not gross up buy fees as realized P&L");

        assert_eq!(performance.attribution.realized_pnl, Decimal::ZERO);
        assert_eq!(performance.attribution.unrealized_pnl_change, Decimal::ZERO);
        assert_eq!(performance.attribution.fees, dec!(10));
        assert_eq!(attribution_pnl(&performance), dec!(-10));
        assert_eq!(performance.summary.amount, Some(dec!(-10)));
    }

    #[tokio::test]
    async fn open_buy_trade_charges_are_grossed_up_as_unrealized_without_disposals() {
        let mut buy = buy_activity_on("buy-open-charge", "acct", "2026-05-02", dec!(1), dec!(100));
        buy.fee = Some(dec!(5));
        buy.tax = Some(dec!(2));

        let performance_service = PerformanceService::new(
            Arc::new(TestValuationService::new(Vec::new())),
            Arc::new(TestQuoteService),
        )
        .with_activity_repository(
            Arc::new(TestActivityRepository::new(vec![buy.clone()])),
            Arc::new(TestFxService),
        );
        let result = PerformanceService::build_result(
            "scope:acct".to_string(),
            "USD".to_string(),
            Some(date("2026-05-01")),
            Some(date("2026-05-02")),
            ReturnMethod::ValueReturn,
            PerformanceReturns {
                twr: None,
                annualized_twr: None,
                irr: None,
                annualized_irr: None,
                value_return: None,
                annualized_value_return: None,
            },
            PerformanceAttribution::default(),
            PerformanceService::empty_risk(),
            PerformanceDataQuality {
                status: DataQualityStatus::Ok,
                warnings: Vec::new(),
                not_applicable_reasons: Vec::new(),
            },
            Vec::new(),
            false,
            false,
        );

        let empty_disposals: Vec<LotDisposal> = Vec::new();
        for period_disposals in [None, Some(empty_disposals.as_slice())] {
            let effects = performance_service
                .collect_trade_charge_pnl_gross_up_event_effects(
                    &result,
                    &["acct".to_string()],
                    period_disposals,
                )
                .await;

            assert!(effects.complete);
            assert_eq!(effects.effects.len(), 1);
            assert_eq!(effects.effects[0].realized_pnl, Decimal::ZERO);
            assert_eq!(effects.effects[0].unrealized_movement, dec!(7));
        }

        let mut open_lot =
            lot_record_for_fee_gross_up("lot-open-charge", "acct", "buy-open-charge");
        open_lot.remaining_quantity = "1".to_string();
        open_lot.original_cost_basis = "107".to_string();
        open_lot.remaining_cost_basis = "107".to_string();
        open_lot.original_cost_basis_base = "107".to_string();
        open_lot.remaining_cost_basis_base = "107".to_string();
        open_lot.fee_allocated = "5".to_string();
        open_lot.fee_allocated_base = "5".to_string();
        open_lot.tax_allocated = "2".to_string();
        open_lot.tax_allocated_base = "2".to_string();
        open_lot.is_closed = false;
        open_lot.close_date = None;
        open_lot.close_activity_id = None;

        let performance_service_with_lot = PerformanceService::new(
            Arc::new(TestValuationService::new(Vec::new())),
            Arc::new(TestQuoteService),
        )
        .with_lot_repository(Arc::new(TestLotRepository {
            lots: vec![open_lot],
            ..Default::default()
        }))
        .with_activity_repository(
            Arc::new(TestActivityRepository::new(vec![buy])),
            Arc::new(TestFxService),
        );

        let effects = performance_service_with_lot
            .collect_trade_charge_pnl_gross_up_event_effects(
                &result,
                &["acct".to_string()],
                Some(empty_disposals.as_slice()),
            )
            .await;

        assert!(effects.complete);
        assert_eq!(effects.effects.len(), 1);
        assert_eq!(effects.effects[0].realized_pnl, Decimal::ZERO);
        assert_eq!(effects.effects[0].unrealized_movement, dec!(7));
    }

    #[tokio::test]
    async fn open_short_trade_charges_are_grossed_up_as_unrealized_without_disposals() {
        let mut sell = sell_activity_on(
            "sell-open-short-charge",
            "acct",
            "2026-05-02",
            dec!(1),
            dec!(100),
        );
        sell.fee = Some(dec!(5));
        sell.tax = Some(dec!(2));

        let mut open_lot =
            lot_record_for_fee_gross_up("lot-open-short-charge", "acct", "sell-open-short-charge");
        open_lot.original_quantity = "-1".to_string();
        open_lot.remaining_quantity = "-1".to_string();
        open_lot.original_cost_basis = "-93".to_string();
        open_lot.remaining_cost_basis = "-93".to_string();
        open_lot.original_cost_basis_base = "-93".to_string();
        open_lot.remaining_cost_basis_base = "-93".to_string();
        open_lot.fee_allocated = "5".to_string();
        open_lot.fee_allocated_base = "5".to_string();
        open_lot.tax_allocated = "2".to_string();
        open_lot.tax_allocated_base = "2".to_string();
        open_lot.is_closed = false;
        open_lot.close_date = None;
        open_lot.close_activity_id = None;

        let performance_service = PerformanceService::new(
            Arc::new(TestValuationService::new(Vec::new())),
            Arc::new(TestQuoteService),
        )
        .with_lot_repository(Arc::new(TestLotRepository {
            lots: vec![open_lot],
            ..Default::default()
        }))
        .with_activity_repository(
            Arc::new(TestActivityRepository::new(vec![sell])),
            Arc::new(TestFxService),
        );
        let result = PerformanceService::build_result(
            "scope:acct".to_string(),
            "USD".to_string(),
            Some(date("2026-05-01")),
            Some(date("2026-05-02")),
            ReturnMethod::ValueReturn,
            PerformanceReturns {
                twr: None,
                annualized_twr: None,
                irr: None,
                annualized_irr: None,
                value_return: None,
                annualized_value_return: None,
            },
            PerformanceAttribution::default(),
            PerformanceService::empty_risk(),
            PerformanceDataQuality {
                status: DataQualityStatus::Ok,
                warnings: Vec::new(),
                not_applicable_reasons: Vec::new(),
            },
            Vec::new(),
            false,
            false,
        );

        let empty_disposals: Vec<LotDisposal> = Vec::new();
        let effects = performance_service
            .collect_trade_charge_pnl_gross_up_event_effects(
                &result,
                &["acct".to_string()],
                Some(empty_disposals.as_slice()),
            )
            .await;

        assert!(effects.complete);
        assert_eq!(effects.effects.len(), 1);
        assert_eq!(effects.effects[0].realized_pnl, Decimal::ZERO);
        assert_eq!(effects.effects[0].unrealized_movement, dec!(7));
    }

    #[tokio::test]
    async fn partial_same_period_buy_sell_prorates_trade_charge_gross_up() {
        let mut buy = buy_activity_on(
            "buy-partial-charge",
            "acct",
            "2026-05-02",
            dec!(10),
            dec!(100),
        );
        buy.fee = Some(dec!(5));
        buy.tax = Some(dec!(2));
        let sell = sell_activity_on(
            "sell-partial-charge",
            "acct",
            "2026-05-03",
            dec!(4),
            dec!(110),
        );

        let mut open_lot =
            lot_record_for_fee_gross_up("lot-partial-charge", "acct", "buy-partial-charge");
        open_lot.original_quantity = "10".to_string();
        open_lot.remaining_quantity = "6".to_string();
        open_lot.original_cost_basis = "1007".to_string();
        open_lot.remaining_cost_basis = "604.2".to_string();
        open_lot.original_cost_basis_base = "1007".to_string();
        open_lot.remaining_cost_basis_base = "604.2".to_string();
        open_lot.fee_allocated = "5".to_string();
        open_lot.fee_allocated_base = "5".to_string();
        open_lot.tax_allocated = "2".to_string();
        open_lot.tax_allocated_base = "2".to_string();
        open_lot.is_closed = false;
        open_lot.close_date = None;
        open_lot.close_activity_id = None;

        let mut disposal = lot_disposal("USD", "USD", "1", "402.8", "402.8", "37.2");
        disposal.id = "partial-charge-disposal".to_string();
        disposal.lot_id = open_lot.id.clone();
        disposal.asset_id = "AAPL".to_string();
        disposal.disposal_activity_id = sell.id.clone();
        disposal.disposal_date = "2026-05-03".to_string();
        disposal.quantity = "4".to_string();
        let period_disposals = vec![disposal.clone()];

        let performance_service = PerformanceService::new(
            Arc::new(TestValuationService::new(Vec::new())),
            Arc::new(TestQuoteService),
        )
        .with_lot_repository(Arc::new(TestLotRepository {
            disposals: vec![disposal],
            lots: vec![open_lot],
        }))
        .with_activity_repository(
            Arc::new(TestActivityRepository::new(vec![buy, sell])),
            Arc::new(TestFxService),
        );
        let result = PerformanceService::build_result(
            "scope:acct".to_string(),
            "USD".to_string(),
            Some(date("2026-05-01")),
            Some(date("2026-05-03")),
            ReturnMethod::ValueReturn,
            PerformanceReturns {
                twr: None,
                annualized_twr: None,
                irr: None,
                annualized_irr: None,
                value_return: None,
                annualized_value_return: None,
            },
            PerformanceAttribution::default(),
            PerformanceService::empty_risk(),
            PerformanceDataQuality {
                status: DataQualityStatus::Ok,
                warnings: Vec::new(),
                not_applicable_reasons: Vec::new(),
            },
            Vec::new(),
            false,
            false,
        );

        let effects = performance_service
            .collect_trade_charge_pnl_gross_up_event_effects(
                &result,
                &["acct".to_string()],
                Some(period_disposals.as_slice()),
            )
            .await;

        assert!(effects.complete);
        assert_eq!(effects.effects.len(), 2);
        let realized = effects
            .effects
            .iter()
            .map(|effect| effect.realized_pnl)
            .sum::<Decimal>();
        let unrealized = effects
            .effects
            .iter()
            .map(|effect| effect.unrealized_movement)
            .sum::<Decimal>();
        assert_eq!(realized.round_dp(2), dec!(2.80));
        assert_eq!(unrealized.round_dp(2), dec!(4.20));
        assert_eq!((realized + unrealized).round_dp(2), dec!(7.00));
    }

    #[tokio::test]
    async fn mixed_sell_close_and_open_prorates_activity_trade_charge_gross_up() {
        let mut sell = sell_activity_on(
            "sell-mixed-charge",
            "acct",
            "2026-05-02",
            dec!(10),
            dec!(100),
        );
        sell.fee = Some(dec!(8));
        sell.tax = Some(dec!(2));

        let mut closed_long_lot =
            lot_record_for_fee_gross_up("lot-prior-long", "acct", "buy-before-period");
        closed_long_lot.open_date = "2026-04-15".to_string();
        closed_long_lot.open_activity_id = Some("buy-before-period".to_string());
        closed_long_lot.original_quantity = "4".to_string();
        closed_long_lot.remaining_quantity = "0".to_string();
        closed_long_lot.original_cost_basis = "400".to_string();
        closed_long_lot.remaining_cost_basis = "0".to_string();
        closed_long_lot.original_cost_basis_base = "400".to_string();
        closed_long_lot.remaining_cost_basis_base = "0".to_string();
        closed_long_lot.fee_allocated = "0".to_string();
        closed_long_lot.fee_allocated_base = "0".to_string();
        closed_long_lot.tax_allocated = "0".to_string();
        closed_long_lot.tax_allocated_base = "0".to_string();
        closed_long_lot.is_closed = true;
        closed_long_lot.close_date = Some("2026-05-02".to_string());
        closed_long_lot.close_activity_id = Some(sell.id.clone());

        let mut open_short_lot =
            lot_record_for_fee_gross_up("lot-open-short-mixed", "acct", &sell.id);
        open_short_lot.original_quantity = "-6".to_string();
        open_short_lot.remaining_quantity = "-6".to_string();
        open_short_lot.original_cost_basis = "-594".to_string();
        open_short_lot.remaining_cost_basis = "-594".to_string();
        open_short_lot.original_cost_basis_base = "-594".to_string();
        open_short_lot.remaining_cost_basis_base = "-594".to_string();
        open_short_lot.fee_allocated = "4.8".to_string();
        open_short_lot.fee_allocated_base = "4.8".to_string();
        open_short_lot.tax_allocated = "1.2".to_string();
        open_short_lot.tax_allocated_base = "1.2".to_string();
        open_short_lot.is_closed = false;
        open_short_lot.close_date = None;
        open_short_lot.close_activity_id = None;

        let mut disposal = lot_disposal("USD", "USD", "1", "400", "400", "0");
        disposal.id = "mixed-sell-close-disposal".to_string();
        disposal.lot_id = closed_long_lot.id.clone();
        disposal.asset_id = "AAPL".to_string();
        disposal.disposal_activity_id = sell.id.clone();
        disposal.disposal_date = "2026-05-02".to_string();
        disposal.quantity = "4".to_string();
        let period_disposals = vec![disposal.clone()];

        let performance_service = PerformanceService::new(
            Arc::new(TestValuationService::new(Vec::new())),
            Arc::new(TestQuoteService),
        )
        .with_lot_repository(Arc::new(TestLotRepository {
            disposals: vec![disposal],
            lots: vec![closed_long_lot, open_short_lot],
        }))
        .with_activity_repository(
            Arc::new(TestActivityRepository::new(vec![sell])),
            Arc::new(TestFxService),
        );
        let result = PerformanceService::build_result(
            "scope:acct".to_string(),
            "USD".to_string(),
            Some(date("2026-05-01")),
            Some(date("2026-05-02")),
            ReturnMethod::ValueReturn,
            PerformanceReturns {
                twr: None,
                annualized_twr: None,
                irr: None,
                annualized_irr: None,
                value_return: None,
                annualized_value_return: None,
            },
            PerformanceAttribution::default(),
            PerformanceService::empty_risk(),
            PerformanceDataQuality {
                status: DataQualityStatus::Ok,
                warnings: Vec::new(),
                not_applicable_reasons: Vec::new(),
            },
            Vec::new(),
            false,
            false,
        );

        let effects = performance_service
            .collect_trade_charge_pnl_gross_up_event_effects(
                &result,
                &["acct".to_string()],
                Some(period_disposals.as_slice()),
            )
            .await;

        assert!(effects.complete);
        assert_eq!(effects.effects.len(), 2);
        let realized = effects
            .effects
            .iter()
            .map(|effect| effect.realized_pnl)
            .sum::<Decimal>();
        let unrealized = effects
            .effects
            .iter()
            .map(|effect| effect.unrealized_movement)
            .sum::<Decimal>();
        assert_eq!(realized.round_dp(2), dec!(4.00));
        assert_eq!(unrealized.round_dp(2), dec!(6.00));
        assert_eq!((realized + unrealized).round_dp(2), dec!(10.00));
    }

    #[tokio::test]
    async fn mixed_buy_cover_and_open_prorates_activity_trade_charge_gross_up() {
        let mut buy = buy_activity_on(
            "buy-mixed-charge",
            "acct",
            "2026-05-02",
            dec!(10),
            dec!(100),
        );
        buy.fee = Some(dec!(8));
        buy.tax = Some(dec!(2));

        let mut closed_short_lot =
            lot_record_for_fee_gross_up("lot-prior-short", "acct", "sell-before-period");
        closed_short_lot.open_date = "2026-04-15".to_string();
        closed_short_lot.open_activity_id = Some("sell-before-period".to_string());
        closed_short_lot.original_quantity = "-4".to_string();
        closed_short_lot.remaining_quantity = "0".to_string();
        closed_short_lot.original_cost_basis = "-400".to_string();
        closed_short_lot.remaining_cost_basis = "0".to_string();
        closed_short_lot.original_cost_basis_base = "-400".to_string();
        closed_short_lot.remaining_cost_basis_base = "0".to_string();
        closed_short_lot.fee_allocated = "0".to_string();
        closed_short_lot.fee_allocated_base = "0".to_string();
        closed_short_lot.tax_allocated = "0".to_string();
        closed_short_lot.tax_allocated_base = "0".to_string();
        closed_short_lot.is_closed = true;
        closed_short_lot.close_date = Some("2026-05-02".to_string());
        closed_short_lot.close_activity_id = Some(buy.id.clone());

        let mut open_long_lot = lot_record_for_fee_gross_up("lot-open-long-mixed", "acct", &buy.id);
        open_long_lot.original_quantity = "6".to_string();
        open_long_lot.remaining_quantity = "6".to_string();
        open_long_lot.original_cost_basis = "606".to_string();
        open_long_lot.remaining_cost_basis = "606".to_string();
        open_long_lot.original_cost_basis_base = "606".to_string();
        open_long_lot.remaining_cost_basis_base = "606".to_string();
        open_long_lot.fee_allocated = "4.8".to_string();
        open_long_lot.fee_allocated_base = "4.8".to_string();
        open_long_lot.tax_allocated = "1.2".to_string();
        open_long_lot.tax_allocated_base = "1.2".to_string();
        open_long_lot.is_closed = false;
        open_long_lot.close_date = None;
        open_long_lot.close_activity_id = None;

        let mut disposal = lot_disposal("USD", "USD", "1", "-400", "-400", "0");
        disposal.id = "mixed-buy-cover-disposal".to_string();
        disposal.lot_id = closed_short_lot.id.clone();
        disposal.asset_id = "AAPL".to_string();
        disposal.disposal_activity_id = buy.id.clone();
        disposal.disposal_date = "2026-05-02".to_string();
        disposal.quantity = "-4".to_string();
        let period_disposals = vec![disposal.clone()];

        let performance_service = PerformanceService::new(
            Arc::new(TestValuationService::new(Vec::new())),
            Arc::new(TestQuoteService),
        )
        .with_lot_repository(Arc::new(TestLotRepository {
            disposals: vec![disposal],
            lots: vec![closed_short_lot, open_long_lot],
        }))
        .with_activity_repository(
            Arc::new(TestActivityRepository::new(vec![buy])),
            Arc::new(TestFxService),
        );
        let result = PerformanceService::build_result(
            "scope:acct".to_string(),
            "USD".to_string(),
            Some(date("2026-05-01")),
            Some(date("2026-05-02")),
            ReturnMethod::ValueReturn,
            PerformanceReturns {
                twr: None,
                annualized_twr: None,
                irr: None,
                annualized_irr: None,
                value_return: None,
                annualized_value_return: None,
            },
            PerformanceAttribution::default(),
            PerformanceService::empty_risk(),
            PerformanceDataQuality {
                status: DataQualityStatus::Ok,
                warnings: Vec::new(),
                not_applicable_reasons: Vec::new(),
            },
            Vec::new(),
            false,
            false,
        );

        let effects = performance_service
            .collect_trade_charge_pnl_gross_up_event_effects(
                &result,
                &["acct".to_string()],
                Some(period_disposals.as_slice()),
            )
            .await;

        assert!(effects.complete);
        assert_eq!(effects.effects.len(), 2);
        let realized = effects
            .effects
            .iter()
            .map(|effect| effect.realized_pnl)
            .sum::<Decimal>();
        let unrealized = effects
            .effects
            .iter()
            .map(|effect| effect.unrealized_movement)
            .sum::<Decimal>();
        assert_eq!(realized.round_dp(2), dec!(4.00));
        assert_eq!(unrealized.round_dp(2), dec!(6.00));
        assert_eq!((realized + unrealized).round_dp(2), dec!(10.00));
    }

    #[tokio::test]
    async fn transfer_pair_fx_attribution_uses_compiled_security_economics() {
        let mut start = valuation("2026-05-01", dec!(1000), dec!(1000), dec!(1000), dec!(1000));
        start.account_currency = "USD".to_string();
        start.base_currency = "USD".to_string();

        let mut after_transfer =
            valuation("2026-05-02", dec!(1000), dec!(1000), dec!(1000), dec!(1000));
        after_transfer.account_currency = "USD".to_string();
        after_transfer.base_currency = "USD".to_string();

        let mut transfer_out = test_activity(
            "transfer-out",
            "from-acct",
            ActivityType::TransferOut,
            "2026-05-02",
        );
        transfer_out.asset_id = Some("AAPL240119C00150000".to_string());
        transfer_out.quantity = Some(dec!(2));
        transfer_out.unit_price = Some(dec!(5));
        transfer_out.amount = Some(dec!(888));
        transfer_out.currency = "USD".to_string();
        transfer_out.source_group_id = Some("transfer-pair-1".to_string());

        let mut transfer_in = test_activity(
            "transfer-in",
            "to-acct",
            ActivityType::TransferIn,
            "2026-05-02",
        );
        transfer_in.asset_id = Some("AAPL240119C00150000".to_string());
        transfer_in.quantity = Some(dec!(2));
        transfer_in.unit_price = Some(dec!(5));
        transfer_in.amount = Some(dec!(999));
        transfer_in.currency = "CAD".to_string();
        transfer_in.source_group_id = Some("transfer-pair-1".to_string());

        let history = vec![start, after_transfer];
        let valuation_service = Arc::new(TestValuationService::new(history.clone()));
        let activity_repo = Arc::new(TestActivityRepository::new(vec![transfer_out, transfer_in]));
        let performance_service =
            PerformanceService::new(valuation_service, Arc::new(TestQuoteService))
                .with_activity_repository(activity_repo, Arc::new(TestFxService));
        let account_ids = vec!["from-acct".to_string(), "to-acct".to_string()];
        let mut result = PerformanceService::build_result(
            "scope:acct".to_string(),
            "USD".to_string(),
            Some(date("2026-05-01")),
            Some(date("2026-05-02")),
            ReturnMethod::ValueReturn,
            PerformanceReturns {
                twr: None,
                annualized_twr: None,
                irr: None,
                annualized_irr: None,
                value_return: None,
                annualized_value_return: None,
            },
            PerformanceAttribution::default(),
            PerformanceService::empty_risk(),
            PerformanceDataQuality {
                status: DataQualityStatus::Ok,
                warnings: Vec::new(),
                not_applicable_reasons: Vec::new(),
            },
            Vec::new(),
            false,
            false,
        );

        let transfer_effects = performance_service
            .collect_scoped_transfer_pair_attribution_event_effects(&result, &account_ids)
            .await;
        performance_service
            .finalize_attribution_from_event_effects(
                &mut result,
                &account_ids,
                &history,
                AttributionBaseline::PeriodStart,
                AttributionEffectSeed {
                    effects: transfer_effects.effects,
                    warnings: transfer_effects.warnings,
                    ..Default::default()
                },
            )
            .await;

        assert_eq!(result.attribution.fx_effect, Decimal::ZERO);
        assert_eq!(result.attribution.residual, Decimal::ZERO);
        assert_eq!(attribution_pnl(&result), Decimal::ZERO);
    }

    #[tokio::test]
    async fn paired_transfer_with_external_metadata_emits_conflict_diagnostic() {
        let mut start = valuation("2026-05-01", dec!(1000), dec!(1000), dec!(1000), dec!(1000));
        start.account_currency = "USD".to_string();
        start.base_currency = "USD".to_string();

        let mut after_transfer =
            valuation("2026-05-02", dec!(1000), dec!(1000), dec!(1000), dec!(1000));
        after_transfer.account_currency = "USD".to_string();
        after_transfer.base_currency = "USD".to_string();

        let mut transfer_out = test_activity(
            "transfer-out-conflict",
            "from-acct",
            ActivityType::TransferOut,
            "2026-05-02",
        );
        transfer_out.asset_id = Some("AAPL".to_string());
        transfer_out.quantity = Some(dec!(1));
        transfer_out.unit_price = Some(dec!(100));
        transfer_out.source_group_id = Some("transfer-pair-conflict".to_string());
        transfer_out.metadata = Some(json!({ "flow": { "is_external": true } }));

        let mut transfer_in = test_activity(
            "transfer-in-conflict",
            "to-acct",
            ActivityType::TransferIn,
            "2026-05-02",
        );
        transfer_in.asset_id = Some("AAPL".to_string());
        transfer_in.quantity = Some(dec!(1));
        transfer_in.unit_price = Some(dec!(100));
        transfer_in.source_group_id = Some("transfer-pair-conflict".to_string());

        let history = vec![start, after_transfer];
        let valuation_service = Arc::new(TestValuationService::new(history.clone()));
        let activity_repo = Arc::new(TestActivityRepository::new(vec![transfer_out, transfer_in]));
        let performance_service =
            PerformanceService::new(valuation_service, Arc::new(TestQuoteService))
                .with_activity_repository(activity_repo, Arc::new(TestFxService));
        let account_ids = vec!["from-acct".to_string(), "to-acct".to_string()];
        let mut result = PerformanceService::build_result(
            "scope:acct".to_string(),
            "USD".to_string(),
            Some(date("2026-05-01")),
            Some(date("2026-05-02")),
            ReturnMethod::ValueReturn,
            PerformanceReturns {
                twr: None,
                annualized_twr: None,
                irr: None,
                annualized_irr: None,
                value_return: None,
                annualized_value_return: None,
            },
            PerformanceAttribution::default(),
            PerformanceService::empty_risk(),
            PerformanceDataQuality {
                status: DataQualityStatus::Ok,
                warnings: Vec::new(),
                not_applicable_reasons: Vec::new(),
            },
            Vec::new(),
            false,
            false,
        );

        let transfer_effects = performance_service
            .collect_scoped_transfer_pair_attribution_event_effects(&result, &account_ids)
            .await;
        performance_service
            .finalize_attribution_from_event_effects(
                &mut result,
                &account_ids,
                &history,
                AttributionBaseline::PeriodStart,
                AttributionEffectSeed {
                    effects: transfer_effects.effects,
                    warnings: transfer_effects.warnings,
                    ..Default::default()
                },
            )
            .await;

        assert_eq!(result.attribution.contributions, Decimal::ZERO);
        assert_eq!(result.attribution.distributions, Decimal::ZERO);
        assert!(result.data_quality.warnings.iter().any(|warning| {
            warning.contains("ignored external transfer metadata")
                && warning.contains("transfer-pair-conflict")
        }));
    }

    #[tokio::test]
    async fn activity_attribution_uses_configured_timezone_for_period_window() {
        let mut start = valuation("2026-05-31", dec!(1000), dec!(1000), dec!(1000), dec!(1000));
        start.account_id = "acct".to_string();
        start.external_flow_source = ExternalFlowSource::ActivityDerived;

        let mut end = valuation("2026-06-01", dec!(1020), dec!(1000), dec!(1000), dec!(1000));
        end.account_id = "acct".to_string();
        end.external_flow_source = ExternalFlowSource::ActivityDerived;

        let activity_time = DateTime::parse_from_rfc3339("2026-06-02T02:30:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut dividend = income_activity_on(
            "dividend-midnight",
            "acct",
            "2026-06-02",
            ActivityType::Dividend,
            dec!(20),
        );
        dividend.activity_date = activity_time;
        dividend.created_at = activity_time;
        dividend.updated_at = activity_time;
        dividend.currency = "CAD".to_string();

        let valuation_service = Arc::new(TestValuationService::new(vec![start, end]));
        let activity_repo = Arc::new(TestActivityRepository::new(vec![dividend]));
        let timezone = Arc::new(RwLock::new("America/Toronto".to_string()));
        let performance_service = PerformanceService::new_with_timezone(
            valuation_service,
            Arc::new(TestQuoteService),
            timezone,
        )
        .with_activity_repository(activity_repo, Arc::new(TestFxService));

        let performance = performance_service
            .calculate_account_performance(
                "acct",
                Some(date("2026-05-31")),
                Some(date("2026-06-01")),
                Some(TrackingMode::Transactions),
                Some(account_types::SECURITIES),
            )
            .await
            .expect("performance should include local-date dividend attribution");

        assert_eq!(performance.attribution.income, dec!(20));
        assert_eq!(performance.attribution.residual, Decimal::ZERO);
    }

    #[tokio::test]
    async fn event_effect_finalization_refreshes_headline_after_income_effects() {
        let mut start = valuation("2026-05-01", dec!(1000), dec!(1000), dec!(1000), dec!(1000));
        start.account_id = "acct".to_string();
        start.account_currency = "USD".to_string();
        start.base_currency = "USD".to_string();
        start.external_flow_source = ExternalFlowSource::ActivityDerived;

        let mut end = valuation("2026-05-02", dec!(1015), dec!(1000), dec!(1000), dec!(1000));
        end.account_id = "acct".to_string();
        end.account_currency = "USD".to_string();
        end.base_currency = "USD".to_string();
        end.external_flow_source = ExternalFlowSource::ActivityDerived;

        let mut dividend = income_activity_on(
            "dividend-summary",
            "acct",
            "2026-05-02",
            ActivityType::Dividend,
            dec!(20),
        );
        dividend.tax = Some(dec!(5));
        let activity_repo = Arc::new(TestActivityRepository::new(vec![dividend]));
        let valuation_service = Arc::new(TestValuationService::new(vec![start, end]));
        let performance_service =
            PerformanceService::new(valuation_service, Arc::new(TestQuoteService))
                .with_activity_repository(activity_repo, Arc::new(TestFxService));

        let performance = performance_service
            .calculate_account_performance(
                "acct",
                Some(date("2026-05-01")),
                Some(date("2026-05-02")),
                Some(TrackingMode::Transactions),
                Some(account_types::SECURITIES),
            )
            .await
            .expect("performance should finalize attribution before building summary");

        assert_eq!(performance.attribution.income, dec!(20));
        assert_eq!(performance.attribution.taxes, dec!(5));
        assert_eq!(performance.attribution.residual, Decimal::ZERO);
        assert_eq!(performance.summary.amount, Some(dec!(15)));
        assert!(!performance
            .summary
            .reasons
            .iter()
            .any(|reason| PerformanceService::is_attribution_residual_warning(reason)));
    }

    fn activity_fixture(activity_type: ActivityType, amount: Decimal, fee: Decimal) -> Activity {
        let now = DateTime::<Utc>::from_timestamp(0, 0).unwrap();
        Activity {
            id: format!("activity-{}", activity_type.as_str()),
            account_id: "acct".to_string(),
            asset_id: None,
            activity_type: activity_type.as_str().to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: None,
            status: crate::activities::ActivityStatus::Posted,
            activity_date: now,
            settlement_date: None,
            quantity: None,
            unit_price: None,
            amount: Some(amount),
            fee: Some(fee),
            tax: None,
            currency: "CAD".to_string(),
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
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn activity_attribution_components_separate_income_fees_and_taxes() {
        let mut dividend = activity_fixture(ActivityType::Dividend, dec!(50), dec!(2));
        dividend.tax = Some(dec!(3));
        assert_eq!(
            PerformanceService::activity_attribution_components(&dividend, &ActivityType::Dividend),
            (dec!(50), dec!(2), dec!(3))
        );

        let explicit_fee = activity_fixture(ActivityType::Fee, dec!(4), Decimal::ZERO);
        assert_eq!(
            PerformanceService::activity_attribution_components(&explicit_fee, &ActivityType::Fee),
            (Decimal::ZERO, dec!(4), Decimal::ZERO)
        );

        let tax = activity_fixture(ActivityType::Tax, dec!(7), Decimal::ZERO);
        assert_eq!(
            PerformanceService::activity_attribution_components(&tax, &ActivityType::Tax),
            (Decimal::ZERO, Decimal::ZERO, dec!(7))
        );

        let mut explicit_tax = activity_fixture(ActivityType::Tax, Decimal::ZERO, Decimal::ZERO);
        explicit_tax.tax = Some(dec!(9));
        assert_eq!(
            PerformanceService::activity_attribution_components(&explicit_tax, &ActivityType::Tax),
            (Decimal::ZERO, Decimal::ZERO, dec!(9))
        );

        let buy = activity_fixture(ActivityType::Buy, dec!(100), dec!(1));
        assert_eq!(
            PerformanceService::activity_attribution_components(&buy, &ActivityType::Buy),
            (Decimal::ZERO, dec!(1), Decimal::ZERO)
        );

        let mut taxable_buy = activity_fixture(ActivityType::Buy, dec!(100), dec!(1));
        taxable_buy.tax = Some(dec!(3));
        assert_eq!(
            PerformanceService::activity_attribution_components(&taxable_buy, &ActivityType::Buy),
            (Decimal::ZERO, dec!(1), dec!(3))
        );

        // Cash activity types book tax to cash, so their tax is attributed.
        for cash_type in [
            ActivityType::Credit,
            ActivityType::Deposit,
            ActivityType::Withdrawal,
        ] {
            let mut cash = activity_fixture(cash_type.clone(), dec!(100), dec!(2));
            cash.tax = Some(dec!(10));
            assert_eq!(
                PerformanceService::activity_attribution_components(&cash, &cash_type),
                (Decimal::ZERO, Decimal::ZERO, dec!(10)),
                "{} tax should be attributed",
                cash_type.as_str()
            );
        }

        // Cash transfers (no asset_id) book tax to cash, so tax is attributed.
        for transfer_type in [ActivityType::TransferIn, ActivityType::TransferOut] {
            let mut cash_transfer = activity_fixture(transfer_type.clone(), dec!(100), dec!(2));
            cash_transfer.tax = Some(dec!(10));
            assert_eq!(
                cash_transfer.asset_id, None,
                "fixture should default to a cash transfer"
            );
            assert_eq!(
                PerformanceService::activity_attribution_components(&cash_transfer, &transfer_type),
                (Decimal::ZERO, Decimal::ZERO, dec!(10)),
                "cash {} tax should be attributed",
                transfer_type.as_str()
            );

            // Asset transfers book only the fee to cash — tax must NOT be attributed,
            // otherwise attribution reports a tax that never hit cash (phantom residual).
            let mut asset_transfer = activity_fixture(transfer_type.clone(), dec!(100), dec!(2));
            asset_transfer.asset_id = Some("AAPL".to_string());
            asset_transfer.tax = Some(dec!(10));
            assert_eq!(
                PerformanceService::activity_attribution_components(
                    &asset_transfer,
                    &transfer_type
                ),
                (Decimal::ZERO, Decimal::ZERO, Decimal::ZERO),
                "asset {} tax must not be attributed",
                transfer_type.as_str()
            );
        }
    }

    #[test]
    fn event_effects_aggregate_attribution_without_residual() {
        let effect_date = date("2026-06-02");
        let effects = vec![
            EconomicEventEffect {
                activity_id: "deposit-1".to_string(),
                account_id: "acct".to_string(),
                asset_id: None,
                date: effect_date,
                event_kind: EconomicEventKind::CashFlow,
                external_flow: dec!(1000),
                realized_pnl: Decimal::ZERO,
                unrealized_movement: Decimal::ZERO,
                income: Decimal::ZERO,
                fee: Decimal::ZERO,
                tax: Decimal::ZERO,
                fx_effect: Decimal::ZERO,
                diagnostics: Vec::new(),
            },
            EconomicEventEffect {
                activity_id: "effect-1".to_string(),
                account_id: "acct".to_string(),
                asset_id: Some("AAPL".to_string()),
                date: effect_date,
                event_kind: EconomicEventKind::Trade,
                external_flow: dec!(-250),
                realized_pnl: dec!(40),
                unrealized_movement: dec!(15),
                income: dec!(5),
                fee: dec!(2),
                tax: dec!(3),
                fx_effect: dec!(1),
                diagnostics: Vec::new(),
            },
        ];

        let attribution = PerformanceService::attribution_from_event_effects(&effects);

        assert_eq!(attribution.contributions, dec!(1000));
        assert_eq!(attribution.distributions, dec!(250));
        assert_eq!(attribution.realized_pnl, dec!(40));
        assert_eq!(attribution.unrealized_pnl_change, dec!(15));
        assert_eq!(attribution.income, dec!(5));
        assert_eq!(attribution.fees, dec!(2));
        assert_eq!(attribution.taxes, dec!(3));
        assert_eq!(attribution.fx_effect, dec!(1));
        assert_eq!(attribution.residual, Decimal::ZERO);
        assert_eq!(PerformanceService::attribution_pnl(&attribution), dec!(56));
    }

    /// Regression test for the reporter's bug. Pre-fix, the summary return was
    /// `gain / start_value` = -10.84/100 = -10.84%. Post-fix, it's daily-linked
    /// TWR — should end up near zero, dominated by the synthetic ~1.1% AAPL
    /// drift between Mar 15 and Apr 14.
    #[test]
    fn perf_does_not_explode_when_start_value_tiny_vs_cash_flow() {
        let history = fixture_small_seed_then_large_deposit();

        let result = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Transactions),
            Some(date("2026-01-01")),
            false, // summary path — matches the dashboard
        )
        .expect("summary should compute");

        let twr = result.returns.twr.expect("TWR should be Some");

        // Old formula: -0.1084. New: small (market-drift-dominated). Bounds are
        // wide — the fixture uses synthetic linear drift and exact precision
        // isn't what we're testing; we're testing that the percentage is sane.
        assert!(
            twr > dec!(-0.05),
            "TWR = {} should be > -5% (was -10.84% with the old formula)",
            twr
        );
        assert!(
            twr < dec!(0.01),
            "TWR = {} should be < 1% (asset drifted down slightly)",
            twr
        );

        // $ gain is unchanged — end - start - cash_flow = 2089.16 - 100 - 2000.
        assert_eq!(attribution_pnl(&result), dec!(-10.84));
        assert_eq!(
            result.returns.value_return.unwrap().round_dp(4),
            dec!(-0.1084)
        );
        assert!(!result
            .data_quality
            .not_applicable_reasons
            .iter()
            .any(|reason| reason.contains("transaction-mode")));
        assert!(result.returns.twr.is_some());
    }

    /// Invariant: summary and full paths must agree on summary returns. This is
    /// the core guarantee the refactor is meant to enforce — the dashboard card
    /// and account-detail page showing different percentages for the same
    /// account / range was the original user complaint.
    #[test]
    fn perf_full_and_summary_paths_agree_on_summary_return() {
        let history = fixture_small_seed_then_large_deposit();
        let start = Some(date("2026-01-01"));

        let full = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Transactions),
            start,
            true,
        )
        .expect("full should compute");

        let summary = PerformanceService::compute_account_performance_with_flow_basis(
            &history,
            Some(TrackingMode::Transactions),
            start,
            false,
            ExternalFlowBasis::BaseCurrency,
            PerformanceSummaryProfile::Summary,
            false,
        )
        .expect("summary should compute");

        // Summary percentage must match exactly — that's the user-visible
        // invariant. Everything else (returns series, risk metrics) is summary
        // vs full differentiation.
        assert_eq!(full.mode, ReturnMethod::TimeWeighted);
        assert_eq!(summary.mode, ReturnMethod::TimeWeighted);
        assert_eq!(full.returns.twr, summary.returns.twr);
        assert_eq!(full.summary.percent, summary.summary.percent);
        assert_eq!(attribution_pnl(&full), attribution_pnl(&summary));
        assert_eq!(full.returns.value_return, summary.returns.value_return);
        assert_eq!(full.summary.amount, summary.summary.amount);
        assert!(summary.returns.irr.is_none());

        // Differentiation: full path populates returns[] and risk metrics;
        // summary stays empty/zero to save allocation on the dashboard.
        assert!(!full.series.is_empty());
        assert!(summary.series.is_empty());
        assert!(full.risk.volatility.unwrap() > Decimal::ZERO);
        assert!(summary.returns.irr.is_none());
        assert!(summary.returns.annualized_twr.is_none());
        assert!(summary.risk.volatility.is_none());
    }

    /// Well-formed account (`start_value == net_contribution`) stays sane —
    /// the common case shouldn't regress.
    #[test]
    fn perf_well_formed_account_remains_sane() {
        let history = vec![
            valuation(
                "2026-02-15",
                dec!(1000),
                dec!(1000),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            valuation(
                "2026-02-16",
                dec!(1000),
                dec!(1000),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            valuation("2026-04-14", dec!(999.48), dec!(1000), dec!(259), dec!(260)),
        ];

        let result = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Transactions),
            Some(date("2026-01-01")),
            false,
        )
        .expect("summary should compute");

        let twr = result.returns.twr.expect("TWR should be Some");
        assert!(
            twr.abs() < dec!(0.01),
            "TWR = {} should be small for well-formed account",
            twr
        );
        assert_eq!(attribution_pnl(&result).round_dp(2), dec!(-1.00));
    }

    #[test]
    fn perf_all_time_transactions_pnl_uses_inception_baseline() {
        let history = vec![
            valuation("2026-01-10", dec!(1015), dec!(1000), dec!(915), dec!(900)),
            valuation("2026-01-11", dec!(1025), dec!(1000), dec!(925), dec!(900)),
            valuation("2026-01-12", dec!(1040), dec!(1000), dec!(940), dec!(900)),
        ];

        let result = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Transactions),
            None,
            false,
        )
        .expect("all-time performance should compute");

        assert_eq!(result.mode, ReturnMethod::TimeWeighted);
        assert_eq!(result.attribution.contributions, dec!(1000));
        assert_eq!(result.attribution.distributions, Decimal::ZERO);
        assert_eq!(result.attribution.unrealized_pnl_change, dec!(40));
        assert_eq!(result.attribution.residual, Decimal::ZERO);
        assert_eq!(attribution_pnl(&result), dec!(40));
        assert_eq!(result.returns.twr.unwrap().round_dp(4), dec!(0.0246));
        assert!(!result
            .data_quality
            .warnings
            .iter()
            .any(|warning| PerformanceService::is_attribution_residual_warning(warning)));
    }

    #[test]
    fn perf_all_time_recompute_preserves_inception_baseline_after_attribution_enrichment() {
        let history = vec![
            valuation("2026-01-10", dec!(1015), dec!(1000), dec!(915), dec!(900)),
            valuation("2026-01-12", dec!(1040), dec!(1000), dec!(940), dec!(900)),
        ];

        let mut result = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Transactions),
            None,
            false,
        )
        .expect("all-time performance should compute");

        result.attribution.income = dec!(5);
        result.attribution.unrealized_pnl_change -= dec!(5);
        PerformanceService::recompute_attribution_residual(
            &mut result,
            &history,
            ExternalFlowBasis::BaseCurrency,
            AttributionBaseline::Inception,
        );

        assert_eq!(result.attribution.residual, Decimal::ZERO);
        assert_eq!(attribution_pnl(&result), dec!(40));
    }

    #[test]
    fn attribution_residual_tolerance_uses_two_tenths_percent() {
        let history = vec![
            valuation(
                "2026-05-01",
                dec!(1000),
                dec!(1000),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            valuation(
                "2026-05-02",
                dec!(1001.5),
                dec!(1000),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
        ];

        let result = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Transactions),
            None,
            false,
        )
        .expect("performance should compute");

        assert_eq!(result.attribution.residual, Decimal::ZERO);
        assert!(!result
            .data_quality
            .warnings
            .iter()
            .any(|warning| PerformanceService::is_attribution_residual_warning(warning)));
    }

    #[test]
    fn attribution_residual_is_diagnostic_not_display_component() {
        let history = vec![
            valuation(
                "2026-05-01",
                dec!(1000),
                dec!(1000),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            valuation(
                "2026-05-02",
                dec!(1003),
                dec!(1000),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
        ];

        let result = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Transactions),
            None,
            false,
        )
        .expect("performance should compute");

        assert_eq!(result.attribution.residual, Decimal::ZERO);
        assert!(result.data_quality.warnings.iter().any(|warning| {
            warning.starts_with("Performance attribution is incomplete for this period")
                && warning.contains("Difference: 3")
        }));
    }

    #[test]
    fn attribution_residual_warning_uses_user_facing_message() {
        let history = vec![
            valuation(
                "2026-05-01",
                dec!(1000),
                dec!(1000),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            valuation(
                "2026-05-02",
                dec!(1003),
                dec!(1000),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
        ];

        let result = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Transactions),
            None,
            false,
        )
        .expect("performance should compute");

        assert_eq!(result.attribution.residual, Decimal::ZERO);
        assert!(result.data_quality.warnings.iter().any(|warning| {
            warning.starts_with("Performance attribution is incomplete for this period")
                && warning.contains("Difference: 3")
                && warning.contains("Review Health Center")
        }));
    }

    #[test]
    fn perf_bounded_transactions_pnl_keeps_period_start_baseline() {
        let history = vec![
            valuation("2026-01-10", dec!(1015), dec!(1000), dec!(915), dec!(900)),
            valuation("2026-01-11", dec!(1025), dec!(1000), dec!(925), dec!(900)),
            valuation("2026-01-12", dec!(1040), dec!(1000), dec!(940), dec!(900)),
        ];

        let result = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Transactions),
            Some(date("2026-01-10")),
            false,
        )
        .expect("bounded performance should compute");

        assert_eq!(result.attribution.contributions, Decimal::ZERO);
        assert_eq!(result.attribution.distributions, Decimal::ZERO);
        assert_eq!(result.attribution.unrealized_pnl_change, dec!(25));
        assert_eq!(result.attribution.residual, Decimal::ZERO);
        assert_eq!(attribution_pnl(&result), dec!(25));
    }

    #[test]
    fn perf_all_time_transactions_with_negative_net_contribution_keeps_lifetime_pnl() {
        let mut history = vec![
            valuation("2026-02-01", dec!(1030), dec!(1000), dec!(930), dec!(900)),
            valuation("2026-02-10", dec!(1400), dec!(1000), dec!(1200), dec!(900)),
            valuation("2026-02-20", dec!(50), dec!(-400), dec!(50), Decimal::ZERO),
        ];
        history[2].external_flow_source = ExternalFlowSource::NetContributionFallback;

        let result = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Transactions),
            None,
            false,
        )
        .expect("all-time performance should compute");

        assert_eq!(result.attribution.contributions, dec!(1000));
        assert_eq!(result.attribution.distributions, dec!(1400));
        assert_eq!(result.attribution.unrealized_pnl_change, dec!(50));
        assert_eq!(result.attribution.residual, Decimal::ZERO);
        assert_eq!(attribution_pnl(&result), dec!(50));
        assert!(result
            .data_quality
            .warnings
            .iter()
            .any(|warning| PerformanceService::is_attribution_residual_warning(warning)));
    }

    #[test]
    fn twr_uses_start_of_day_inflow_convention() {
        let mut history = vec![
            valuation(
                "2026-05-01",
                dec!(100),
                dec!(100),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            valuation(
                "2026-05-02",
                dec!(210),
                dec!(200),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
        ];
        history[1].external_flow_source = ExternalFlowSource::NetContributionFallback;

        let result = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Transactions),
            None,
            true,
        )
        .expect("performance should compute");

        assert_eq!(result.returns.twr.unwrap().round_dp(4), dec!(0.05));
    }

    #[test]
    fn twr_uses_end_of_day_outflow_convention() {
        let mut history = vec![
            valuation(
                "2026-05-01",
                dec!(200),
                dec!(200),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            valuation(
                "2026-05-02",
                dec!(110),
                dec!(100),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
        ];
        history[1].external_flow_source = ExternalFlowSource::NetContributionFallback;

        let result = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Transactions),
            None,
            true,
        )
        .expect("performance should compute");

        assert_eq!(result.returns.twr.unwrap().round_dp(4), dec!(0.05));
    }

    #[test]
    fn twr_and_irr_handle_zero_start_then_early_deposit() {
        let mut history = vec![
            valuation(
                "2026-05-01",
                Decimal::ZERO,
                Decimal::ZERO,
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            valuation(
                "2026-05-02",
                dec!(100),
                dec!(100),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            valuation(
                "2027-05-02",
                dec!(110),
                dec!(100),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
        ];
        history[1].external_inflow_base = dec!(100);
        history[1].external_flow_source = ExternalFlowSource::CashAmount;

        let result = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Transactions),
            None,
            true,
        )
        .expect("performance should compute");

        assert_eq!(result.returns.twr.unwrap().round_dp(4), dec!(0.1));
        assert!(result.returns.irr.is_some());
        assert!(result.returns.value_return.is_none());
        assert!(result
            .data_quality
            .not_applicable_reasons
            .iter()
            .any(|reason| reason.contains("starting value is zero or negative")));
        assert_eq!(result.series.last().unwrap().value.round_dp(4), dec!(0.1));
    }

    #[test]
    fn twr_and_irr_keep_same_day_deposit_and_withdrawal_gross() {
        let mut history = vec![
            valuation(
                "2026-05-01",
                dec!(100),
                dec!(100),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            valuation(
                "2027-05-01",
                dec!(168),
                dec!(160),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
        ];
        history[1].external_inflow_base = dec!(100);
        history[1].external_outflow_base = dec!(40);
        history[1].external_flow_source = ExternalFlowSource::CashAmount;

        let result = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Transactions),
            None,
            true,
        )
        .expect("performance should compute");

        let daily_flows = PerformanceService::daily_external_flow_series(
            &history,
            ExternalFlowBasis::BaseCurrency,
        );
        let (contributions, distributions) = PerformanceService::total_external_flows(&daily_flows);
        assert_eq!(contributions, dec!(100));
        assert_eq!(distributions, dec!(40));
        assert_eq!(result.returns.twr.unwrap().round_dp(4), dec!(0.04));
        assert!(result.returns.irr.is_some());
        assert!(!result
            .data_quality
            .warnings
            .iter()
            .any(|warning| warning.contains("inferred from net contribution")));
    }

    #[test]
    fn net_flow_fallback_is_shared_by_twr_irr_value_return_and_attribution() {
        let mut history = vec![
            valuation("2026-05-01", dec!(100), dec!(100), dec!(100), dec!(100)),
            valuation("2027-05-01", dec!(160), dec!(150), dec!(160), dec!(150)),
        ];
        history[1].external_flow_source = ExternalFlowSource::NetContributionFallback;

        let result = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Transactions),
            None,
            true,
        )
        .expect("performance should compute");

        assert_eq!(result.attribution.contributions, dec!(150));
        assert_eq!(result.attribution.distributions, Decimal::ZERO);
        assert_eq!(result.attribution.unrealized_pnl_change, dec!(10));
        assert_eq!(result.attribution.residual, Decimal::ZERO);
        assert_eq!(result.returns.twr.unwrap().round_dp(4), dec!(0.0667));
        assert_eq!(result.returns.value_return.unwrap().round_dp(4), dec!(0.1));
        assert!(result.returns.irr.is_some());
        assert!(result
            .data_quality
            .warnings
            .iter()
            .any(|warning| warning.contains("inferred from net contribution")));
    }

    #[test]
    fn zero_net_fallback_flow_warns_across_account_return_paths() {
        let mut history = vec![
            valuation("2026-05-01", dec!(100), dec!(100), dec!(100), dec!(100)),
            valuation("2027-05-01", dec!(110), dec!(100), dec!(110), dec!(100)),
        ];
        history[1].external_flow_source = ExternalFlowSource::NetContributionFallback;

        let result = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Transactions),
            None,
            true,
        )
        .expect("performance should compute");

        assert_eq!(result.attribution.contributions, dec!(100));
        assert_eq!(result.attribution.distributions, Decimal::ZERO);
        assert_eq!(result.attribution.unrealized_pnl_change, dec!(10));
        assert_eq!(result.attribution.residual, Decimal::ZERO);
        assert_eq!(result.returns.twr.unwrap().round_dp(4), dec!(0.1));
        assert_eq!(result.returns.value_return.unwrap().round_dp(4), dec!(0.1));
        assert!(result.returns.irr.is_some());
        assert!(result
            .data_quality
            .warnings
            .iter()
            .any(|warning| warning.contains("inferred from net contribution")));
    }

    #[test]
    fn explicit_gross_same_day_flows_feed_all_account_return_paths() {
        let mut history = vec![
            valuation("2026-05-01", dec!(100), dec!(100), dec!(100), dec!(100)),
            valuation("2027-05-01", dec!(120), dec!(100), dec!(120), dec!(100)),
        ];
        history[1].external_inflow_base = dec!(100);
        history[1].external_outflow_base = dec!(100);
        history[1].external_flow_source = ExternalFlowSource::ActivityDerived;

        let result = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Transactions),
            None,
            true,
        )
        .expect("performance should compute");

        assert_eq!(result.attribution.contributions, dec!(200));
        assert_eq!(result.attribution.distributions, dec!(100));
        assert_eq!(result.attribution.unrealized_pnl_change, dec!(20));
        assert_eq!(result.attribution.residual, Decimal::ZERO);
        assert_eq!(result.returns.twr.unwrap().round_dp(4), dec!(0.1));
        assert_eq!(result.returns.value_return.unwrap().round_dp(4), dec!(0.2));
        assert!(result.returns.irr.is_some());
        assert!(!result
            .data_quality
            .warnings
            .iter()
            .any(|warning| warning.contains("inferred from net contribution")));
    }

    #[test]
    fn account_performance_reports_period_irr_and_annualized_xirr() {
        let history = vec![
            valuation("2026-01-01", dec!(100), dec!(100), dec!(100), dec!(100)),
            valuation("2026-07-02", dec!(110), dec!(100), dec!(110), dec!(100)),
        ];

        let result = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Transactions),
            None,
            true,
        )
        .expect("performance should compute");

        let irr = result.returns.irr.expect("period IRR should be present");
        let annualized_irr = result
            .returns
            .annualized_irr
            .expect("annualized XIRR should be present");
        let expected_annualized = PerformanceService::calculate_annualized_return(
            date("2026-01-01"),
            date("2026-07-02"),
            dec!(0.1),
        );

        assert_eq!(irr.round_dp(4), dec!(0.1));
        assert_eq!(annualized_irr.round_dp(4), expected_annualized.round_dp(4));
        assert!(annualized_irr > irr);
    }

    #[test]
    fn realized_pnl_attribution_warns_when_acquisition_fx_is_missing() {
        let disposal = lot_disposal("USD", "CAD", "1.1", "100", "0", "0");

        let warning = PerformanceService::realized_pnl_base_from_disposal(&disposal)
            .expect_err("missing acquisition FX should make base realized P&L unusable");

        assert!(warning.contains("acquisition FX conversion was unavailable"));
    }

    #[test]
    fn realized_pnl_attribution_warns_when_short_cover_acquisition_fx_is_missing() {
        let disposal = lot_disposal("USD", "CAD", "1.1", "-100", "0", "0");

        let warning = PerformanceService::realized_pnl_base_from_disposal(&disposal)
            .expect_err("missing acquisition FX should make base realized P&L unusable");

        assert!(warning.contains("acquisition FX conversion was unavailable"));
    }

    #[test]
    fn realized_pnl_attribution_accepts_complete_base_disposal() {
        let disposal = lot_disposal("USD", "CAD", "1.1", "100", "110", "22");

        let realized_pnl_base = PerformanceService::realized_pnl_base_from_disposal(&disposal)
            .expect("complete FX facts should be usable");

        assert_eq!(realized_pnl_base, dec!(22));
    }

    #[test]
    fn irr_returns_none_when_cash_flows_have_no_sign_change() {
        let mut history = vec![
            valuation(
                "2026-05-01",
                Decimal::ZERO,
                Decimal::ZERO,
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            valuation(
                "2026-05-02",
                dec!(10),
                dec!(-10),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
        ];
        history[1].external_outflow_base = dec!(10);
        history[1].external_flow_source = ExternalFlowSource::CashAmount;

        let daily_flows = PerformanceService::daily_external_flow_series(
            &history,
            ExternalFlowBasis::BaseCurrency,
        );
        let irr = PerformanceService::calculate_xirr(
            &history,
            &daily_flows,
            ExternalFlowBasis::BaseCurrency,
        );

        assert!(irr.annualized_irr.is_none());
        assert!(irr
            .warnings
            .iter()
            .any(|warning| warning.contains("do not change sign")));
    }

    #[test]
    fn irr_returns_none_when_solver_does_not_converge() {
        let history = vec![
            valuation("2026-05-01", dec!(1), dec!(1), Decimal::ZERO, Decimal::ZERO),
            valuation(
                "2026-05-02",
                dec!(1000000000000),
                dec!(1),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
        ];

        let daily_flows = PerformanceService::daily_external_flow_series(
            &history,
            ExternalFlowBasis::BaseCurrency,
        );
        let irr = PerformanceService::calculate_xirr(
            &history,
            &daily_flows,
            ExternalFlowBasis::BaseCurrency,
        );

        assert!(irr.annualized_irr.is_none());
        assert!(irr
            .warnings
            .iter()
            .any(|warning| warning.contains("did not converge")));
    }

    #[test]
    fn return_period_with_non_positive_denominator_is_excluded() {
        let history = vec![
            valuation(
                "2026-05-01",
                dec!(0.5),
                dec!(0.5),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            valuation(
                "2026-05-02",
                dec!(0.5),
                dec!(0.5),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
        ];

        let result = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Transactions),
            None,
            true,
        )
        .expect("performance should compute");

        assert!(result.returns.twr.is_none());
        assert_eq!(result.series.last().unwrap().value, Decimal::ZERO);
        assert!(!result.data_quality.not_applicable_reasons.is_empty());
    }

    #[test]
    fn twr_tiny_denominator_before_chain_makes_result_not_applicable() {
        let mut history = vec![
            valuation(
                "2026-05-01",
                dec!(0.5),
                dec!(0.5),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            valuation(
                "2026-05-02",
                dec!(0.5),
                dec!(0.5),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            valuation("2026-05-03", dec!(2), dec!(2), Decimal::ZERO, Decimal::ZERO),
        ];
        history[2].external_inflow_base = dec!(1.5);

        let result = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Transactions),
            None,
            true,
        )
        .expect("performance should compute");

        assert!(result.returns.twr.is_none());
        assert!(result
            .data_quality
            .not_applicable_reasons
            .iter()
            .any(|reason| reason.contains("below 1 base currency unit")));
    }

    #[test]
    fn attribution_separates_account_currency_fx_from_unrealized_pnl() {
        let mut start = valuation("2026-05-01", dec!(100), dec!(100), dec!(100), dec!(100));
        start.account_currency = "USD".to_string();
        start.base_currency = "CAD".to_string();
        start.fx_rate_to_base = dec!(1.3);
        start.total_value_base = dec!(130);
        start.investment_market_value_base = dec!(130);
        start.cost_basis_base = dec!(130);
        start.net_contribution_base = dec!(130);

        let mut end = valuation("2026-05-02", dec!(100), dec!(100), dec!(100), dec!(100));
        end.account_currency = "USD".to_string();
        end.base_currency = "CAD".to_string();
        end.fx_rate_to_base = dec!(1.4);
        end.total_value_base = dec!(140);
        end.investment_market_value_base = dec!(140);
        end.cost_basis_base = dec!(130);
        end.net_contribution_base = dec!(130);

        let result = PerformanceService::compute_account_performance(
            &[start, end],
            Some(TrackingMode::Transactions),
            None,
            false,
        )
        .expect("performance should compute");

        assert_eq!(result.attribution.unrealized_pnl_change, Decimal::ZERO);
        assert_eq!(result.attribution.fx_effect, dec!(10));
        assert_eq!(result.attribution.residual, Decimal::ZERO);
    }

    #[test]
    fn attribution_includes_foreign_cash_fx_effect() {
        let mut start = valuation(
            "2026-05-01",
            dec!(1000),
            dec!(1000),
            Decimal::ZERO,
            Decimal::ZERO,
        );
        start.account_currency = "USD".to_string();
        start.base_currency = "CAD".to_string();
        start.fx_rate_to_base = dec!(1.3);
        start.cash_balance_base = dec!(1300);
        start.total_value_base = dec!(1300);
        start.net_contribution_base = dec!(1300);
        start.performance_eligible_value_base = dec!(1300);

        let mut end = valuation(
            "2026-05-02",
            dec!(1000),
            dec!(1000),
            Decimal::ZERO,
            Decimal::ZERO,
        );
        end.account_currency = "USD".to_string();
        end.base_currency = "CAD".to_string();
        end.fx_rate_to_base = dec!(1.4);
        end.cash_balance_base = dec!(1400);
        end.total_value_base = dec!(1400);
        end.net_contribution_base = dec!(1300);
        end.performance_eligible_value_base = dec!(1400);

        let result = PerformanceService::compute_account_performance_with_flow_basis(
            &[start, end],
            Some(TrackingMode::Transactions),
            None,
            false,
            ExternalFlowBasis::BaseCurrency,
            PerformanceSummaryProfile::Full,
            true,
        )
        .expect("foreign cash performance should compute");

        assert_eq!(result.attribution.contributions, dec!(1300));
        assert_eq!(result.attribution.fx_effect, dec!(100));
        assert_eq!(result.attribution.residual, Decimal::ZERO);
        assert_eq!(attribution_pnl(&result), dec!(100));
        assert!(!result
            .data_quality
            .warnings
            .iter()
            .any(|warning| PerformanceService::is_attribution_residual_warning(warning)));
    }

    #[test]
    fn cash_shaped_non_cash_account_does_not_apply_cash_fx_reconciliation() {
        let mut start = valuation(
            "2026-05-01",
            dec!(1000),
            dec!(1000),
            Decimal::ZERO,
            Decimal::ZERO,
        );
        start.account_currency = "USD".to_string();
        start.base_currency = "CAD".to_string();
        start.fx_rate_to_base = dec!(1.3);
        start.cash_balance_base = dec!(1300);
        start.total_value_base = dec!(1300);
        start.net_contribution_base = dec!(1300);
        start.performance_eligible_value_base = dec!(1300);

        let mut end = valuation(
            "2026-05-02",
            dec!(1000),
            dec!(1000),
            Decimal::ZERO,
            Decimal::ZERO,
        );
        end.account_currency = "USD".to_string();
        end.base_currency = "CAD".to_string();
        end.fx_rate_to_base = dec!(1.4);
        end.cash_balance_base = dec!(1400);
        end.total_value_base = dec!(1400);
        end.net_contribution_base = dec!(1300);
        end.performance_eligible_value_base = dec!(1400);

        let result = PerformanceService::compute_account_performance(
            &[start, end],
            Some(TrackingMode::Transactions),
            None,
            false,
        )
        .expect("performance should compute");

        assert_eq!(result.attribution.fx_effect, Decimal::ZERO);
        assert_eq!(result.attribution.residual, Decimal::ZERO);
        assert!(result
            .data_quality
            .warnings
            .iter()
            .any(|warning| PerformanceService::is_attribution_residual_warning(warning)));
    }

    #[test]
    fn attribution_includes_cash_fx_after_period_deposit() {
        let mut start = valuation(
            "2026-05-01",
            Decimal::ZERO,
            Decimal::ZERO,
            Decimal::ZERO,
            Decimal::ZERO,
        );
        start.account_currency = "USD".to_string();
        start.base_currency = "CAD".to_string();
        start.fx_rate_to_base = dec!(1.3);

        let mut funded = valuation(
            "2026-05-02",
            dec!(1000),
            dec!(1000),
            Decimal::ZERO,
            Decimal::ZERO,
        );
        funded.account_currency = "USD".to_string();
        funded.base_currency = "CAD".to_string();
        funded.fx_rate_to_base = dec!(1.3);
        funded.cash_balance_base = dec!(1300);
        funded.total_value_base = dec!(1300);
        funded.net_contribution_base = dec!(1300);
        funded.external_inflow_base = dec!(1300);
        funded.external_flow_source = ExternalFlowSource::ActivityDerived;
        funded.performance_eligible_value_base = dec!(1300);

        let mut end = valuation(
            "2026-05-03",
            dec!(1000),
            dec!(1000),
            Decimal::ZERO,
            Decimal::ZERO,
        );
        end.account_currency = "USD".to_string();
        end.base_currency = "CAD".to_string();
        end.fx_rate_to_base = dec!(1.4);
        end.cash_balance_base = dec!(1400);
        end.total_value_base = dec!(1400);
        end.net_contribution_base = dec!(1300);
        end.performance_eligible_value_base = dec!(1400);

        let result = PerformanceService::compute_account_performance_with_flow_basis(
            &[start, funded, end],
            Some(TrackingMode::Transactions),
            Some(date("2026-05-01")),
            false,
            ExternalFlowBasis::BaseCurrency,
            PerformanceSummaryProfile::Full,
            true,
        )
        .expect("foreign cash performance should compute");

        assert_eq!(result.attribution.contributions, dec!(1300));
        assert_eq!(result.attribution.fx_effect, dec!(100));
        assert_eq!(result.attribution.residual, Decimal::ZERO);
        assert_eq!(attribution_pnl(&result), dec!(100));
    }

    #[test]
    fn securities_attribution_does_not_apply_cash_only_fx_reconciliation() {
        let mut start = valuation("2026-05-01", dec!(1500), dec!(1500), dec!(500), dec!(500));
        start.account_currency = "USD".to_string();
        start.base_currency = "CAD".to_string();
        start.fx_rate_to_base = dec!(1.3);
        start.cash_balance_base = dec!(1300);
        start.investment_market_value_base = dec!(650);
        start.cost_basis_base = dec!(650);
        start.total_value_base = dec!(1950);
        start.net_contribution_base = dec!(2100);
        start.performance_eligible_value_base = dec!(1950);

        let mut end = valuation("2026-05-02", dec!(1500), dec!(1500), dec!(500), dec!(500));
        end.account_currency = "USD".to_string();
        end.base_currency = "CAD".to_string();
        end.fx_rate_to_base = dec!(1.4);
        end.cash_balance_base = dec!(1400);
        end.investment_market_value_base = dec!(700);
        end.cost_basis_base = dec!(700);
        end.total_value_base = dec!(2100);
        end.net_contribution_base = dec!(2100);
        end.performance_eligible_value_base = dec!(2100);

        let result = PerformanceService::compute_account_performance(
            &[start, end],
            Some(TrackingMode::Transactions),
            None,
            false,
        )
        .expect("securities performance should compute");

        assert_eq!(result.attribution.fx_effect, Decimal::ZERO);
        assert_eq!(result.attribution.residual, Decimal::ZERO);
        assert!(!result
            .data_quality
            .warnings
            .iter()
            .any(|warning| PerformanceService::is_attribution_residual_warning(warning)));
    }

    #[test]
    fn scoped_attribution_separates_fx_per_account_before_aggregation() {
        let mut usd_start = valuation("2026-05-01", dec!(100), dec!(100), dec!(100), dec!(100));
        usd_start.account_id = "usd".to_string();
        usd_start.account_currency = "USD".to_string();
        usd_start.base_currency = "CAD".to_string();
        usd_start.fx_rate_to_base = dec!(1.3);
        usd_start.total_value_base = dec!(130);
        usd_start.investment_market_value_base = dec!(130);
        usd_start.cost_basis_base = dec!(130);
        usd_start.net_contribution_base = dec!(130);

        let mut usd_end = valuation("2026-05-02", dec!(110), dec!(100), dec!(110), dec!(100));
        usd_end.account_id = "usd".to_string();
        usd_end.account_currency = "USD".to_string();
        usd_end.base_currency = "CAD".to_string();
        usd_end.fx_rate_to_base = dec!(1.4);
        usd_end.total_value_base = dec!(154);
        usd_end.investment_market_value_base = dec!(154);
        usd_end.cost_basis_base = dec!(130);
        usd_end.net_contribution_base = dec!(130);

        let mut cad_start = valuation("2026-05-01", dec!(100), dec!(100), dec!(100), dec!(100));
        cad_start.account_id = "cad".to_string();
        let mut cad_end = valuation("2026-05-02", dec!(120), dec!(100), dec!(120), dec!(100));
        cad_end.account_id = "cad".to_string();

        let attribution = PerformanceService::scoped_unrealized_attribution_components(
            &[vec![usd_start, usd_end], vec![cad_start, cad_end]],
            date("2026-05-01"),
            date("2026-05-02"),
            AttributionBaseline::PeriodStart,
        );

        assert!(attribution.complete);
        assert_eq!(attribution.unrealized_pnl_change, dec!(34));
        assert_eq!(attribution.fx_effect, dec!(10));
    }

    #[test]
    fn scoped_attribution_does_not_add_foreign_cash_fx() {
        let mut start = valuation(
            "2026-05-01",
            dec!(1000),
            dec!(1000),
            Decimal::ZERO,
            Decimal::ZERO,
        );
        start.account_id = "usd".to_string();
        start.account_currency = "USD".to_string();
        start.base_currency = "CAD".to_string();
        start.fx_rate_to_base = dec!(1.3);
        start.cash_balance_base = dec!(1300);
        start.total_value_base = dec!(1300);
        start.net_contribution_base = dec!(1300);
        start.performance_eligible_value_base = dec!(1300);

        let mut end = valuation(
            "2026-05-02",
            dec!(1000),
            dec!(1000),
            Decimal::ZERO,
            Decimal::ZERO,
        );
        end.account_id = "usd".to_string();
        end.account_currency = "USD".to_string();
        end.base_currency = "CAD".to_string();
        end.fx_rate_to_base = dec!(1.4);
        end.cash_balance_base = dec!(1400);
        end.total_value_base = dec!(1400);
        end.net_contribution_base = dec!(1300);
        end.performance_eligible_value_base = dec!(1400);

        let attribution = PerformanceService::scoped_unrealized_attribution_components(
            &[vec![start, end]],
            date("2026-05-01"),
            date("2026-05-02"),
            AttributionBaseline::PeriodStart,
        );

        assert!(attribution.complete);
        assert_eq!(attribution.unrealized_pnl_change, Decimal::ZERO);
        assert_eq!(attribution.fx_effect, Decimal::ZERO);
    }

    #[test]
    fn scoped_attribution_uses_inception_unrealized_pnl_for_all_time_transactions() {
        let history = vec![
            valuation("2026-01-10", dec!(1015), dec!(1000), dec!(915), dec!(900)),
            valuation("2026-01-12", dec!(1040), dec!(1000), dec!(940), dec!(900)),
        ];

        let all_time = PerformanceService::scoped_unrealized_attribution_components(
            std::slice::from_ref(&history),
            date("2026-01-10"),
            date("2026-01-12"),
            AttributionBaseline::Inception,
        );
        let bounded = PerformanceService::scoped_unrealized_attribution_components(
            &[history],
            date("2026-01-10"),
            date("2026-01-12"),
            AttributionBaseline::PeriodStart,
        );

        assert!(all_time.complete);
        assert_eq!(all_time.unrealized_pnl_change, dec!(40));
        assert_eq!(all_time.fx_effect, Decimal::ZERO);
        assert!(bounded.complete);
        assert_eq!(bounded.unrealized_pnl_change, dec!(25));
        assert_eq!(bounded.fx_effect, Decimal::ZERO);
    }

    /// Negative portfolio value (like TEST's unfunded-BUY shape) degrades
    /// return percentages instead of failing the whole response.
    #[test]
    fn perf_degrades_negative_portfolio_value() {
        let history = vec![
            valuation(
                "2026-04-01",
                dec!(100),
                dec!(100),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            valuation("2026-04-02", dec!(-50), dec!(100), dec!(-50), Decimal::ZERO),
        ];

        for include_series in [true, false] {
            let result = PerformanceService::compute_account_performance(
                &history,
                Some(TrackingMode::Transactions),
                None,
                include_series,
            )
            .expect("negative portfolio value should degrade, not fail");

            assert_eq!(result.returns.twr, None);
            assert_eq!(result.summary.percent, None);
            assert!(matches!(
                result.data_quality.status,
                DataQualityStatus::Partial
            ));
            assert!(result
                .data_quality
                .not_applicable_reasons
                .iter()
                .any(|reason| reason.contains("portfolio value is negative")));
        }
    }

    #[test]
    fn scoped_perf_uses_explicit_base_flows_for_foreign_currency_accounts() {
        let mut prev = valuation("2026-04-01", dec!(100), dec!(100), dec!(100), dec!(100));
        let mut curr = valuation("2026-04-02", dec!(210), dec!(200), dec!(210), dec!(200));
        prev.account_currency = "EUR".to_string();
        prev.base_currency = "USD".to_string();
        prev.fx_rate_to_base = dec!(1.1);
        prev.total_value_base = dec!(110);
        prev.net_contribution_base = dec!(110);
        curr.account_currency = "EUR".to_string();
        curr.base_currency = "USD".to_string();
        curr.fx_rate_to_base = dec!(1.1);
        curr.total_value_base = dec!(231);
        curr.net_contribution_base = dec!(220);
        curr.external_inflow_base = dec!(110);
        curr.external_flow_source = ExternalFlowSource::StoredGross;

        let flow =
            PerformanceService::daily_external_flows(&prev, &curr, ExternalFlowBasis::BaseCurrency);

        assert_eq!(flow.inflow, dec!(110));
        assert_eq!(flow.outflow, Decimal::ZERO);
        assert_eq!(flow.source, ExternalFlowSource::StoredGross);
    }

    #[test]
    fn daily_external_flows_do_not_infer_unknown_boundary_transfer_from_net_contribution() {
        let mut prev = valuation("2026-04-01", dec!(1000), dec!(1000), dec!(1000), dec!(1000));
        let mut curr = valuation("2026-04-02", dec!(1200), dec!(1200), dec!(1200), dec!(1200));
        prev.external_flow_source = ExternalFlowSource::UnknownBoundaryTransfer;
        curr.external_flow_source = ExternalFlowSource::UnknownBoundaryTransfer;

        let flow =
            PerformanceService::daily_external_flows(&prev, &curr, ExternalFlowBasis::BaseCurrency);

        assert_eq!(flow.inflow, Decimal::ZERO);
        assert_eq!(flow.outflow, Decimal::ZERO);
        assert_eq!(flow.source, ExternalFlowSource::UnknownBoundaryTransfer);
    }

    #[test]
    fn twr_unavailable_when_aggregate_source_has_unknown_boundary_transfer() {
        let mut history = vec![
            valuation("2026-04-01", dec!(1000), dec!(1000), dec!(1000), dec!(1000)),
            valuation("2026-04-02", dec!(1200), dec!(1100), dec!(1200), dec!(1000)),
        ];
        history[1].external_inflow_base = dec!(100);
        history[1].external_flow_source = ExternalFlowSource::UnknownBoundaryTransfer;

        let result = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Transactions),
            None,
            false,
        )
        .expect("performance should return a degraded result");

        assert!(result.returns.twr.is_none());
        assert!(result
            .data_quality
            .not_applicable_reasons
            .iter()
            .any(|reason| {
                reason.contains("external flow amount or transfer boundary is unknown")
            }));
    }

    #[test]
    fn mixed_flow_source_is_degraded_but_still_computable() {
        let mut history = vec![
            valuation("2026-04-01", dec!(1000), dec!(1000), dec!(1000), dec!(1000)),
            valuation("2026-04-02", dec!(1110), dec!(1100), dec!(1110), dec!(1000)),
        ];
        history[1].external_inflow_base = dec!(100);
        history[1].external_flow_source = ExternalFlowSource::Mixed;

        let result = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Transactions),
            None,
            false,
        )
        .expect("mixed known-source flow should compute");

        assert_eq!(result.returns.twr.unwrap().round_dp(4), dec!(0.0091));
        assert!(result
            .data_quality
            .warnings
            .iter()
            .any(|warning| { warning.contains("External cash flow provenance is incomplete") }));
        assert!(
            result
                .data_quality
                .not_applicable_reasons
                .iter()
                .all(|reason| !reason
                    .contains("external flow amount or transfer boundary is unknown"))
        );
    }

    #[test]
    fn partial_unpriced_valuation_warns_but_still_computes_priced_subset() {
        let mut history = vec![
            valuation("2026-04-01", dec!(1000), dec!(1000), dec!(1000), dec!(1000)),
            valuation("2026-04-02", dec!(1100), dec!(1000), dec!(1100), dec!(1000)),
        ];
        history[1].value_status = ValuationStatus::PartialUnpriced;

        let result = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Transactions),
            None,
            false,
        )
        .expect("partial valuation coverage should compute");

        assert_eq!(result.returns.twr.unwrap().round_dp(4), dec!(0.1));
        assert_eq!(result.data_quality.status, DataQualityStatus::Partial);
        assert!(result
            .data_quality
            .warnings
            .iter()
            .any(|warning| warning.contains("priced subset")));
    }

    #[test]
    fn unavailable_valuation_coverage_blocks_twr() {
        let mut history = vec![
            valuation("2026-04-01", dec!(1000), dec!(1000), dec!(1000), dec!(1000)),
            valuation(
                "2026-04-02",
                Decimal::ZERO,
                dec!(1000),
                Decimal::ZERO,
                dec!(1000),
            ),
        ];
        history[1].value_status = ValuationStatus::Unavailable;

        let result = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Transactions),
            None,
            false,
        )
        .expect("unavailable valuation coverage should return degraded result");

        assert!(result.returns.twr.is_none());
        assert!(result
            .data_quality
            .not_applicable_reasons
            .iter()
            .any(|reason| reason.contains("valuation coverage is unavailable")));
    }

    #[test]
    fn daily_external_flows_do_not_infer_unknown_compiled_flow_from_net_contribution() {
        let mut prev = valuation("2026-04-01", dec!(1000), dec!(1000), dec!(1000), dec!(1000));
        let mut curr = valuation("2026-04-02", dec!(1200), dec!(1200), dec!(1200), dec!(1200));
        prev.external_flow_source = ExternalFlowSource::CashAmount;
        curr.external_flow_source = ExternalFlowSource::Unknown;

        let flow =
            PerformanceService::daily_external_flows(&prev, &curr, ExternalFlowBasis::BaseCurrency);

        assert_eq!(flow.inflow, Decimal::ZERO);
        assert_eq!(flow.outflow, Decimal::ZERO);
        assert_eq!(flow.source, ExternalFlowSource::Unknown);
    }

    // A real `Unknown` daily flow (quiet days carry `NoFlow`/`CashAmount`, never
    // `Unknown`) must be preserved even with zero gross amounts and a zero
    // net-contribution delta, so the TWR/IRR availability gate fires.
    #[test]
    fn daily_external_flows_keep_unknown_on_zero_amount_zero_delta() {
        let prev = valuation("2026-04-01", dec!(1000), dec!(1000), dec!(1000), dec!(1000));
        let mut curr = valuation("2026-04-02", dec!(1200), dec!(1000), dec!(1200), dec!(1000));
        // Equal net contribution => zero delta; no gross amounts recorded.
        curr.external_flow_source = ExternalFlowSource::Unknown;
        curr.external_inflow_base = Decimal::ZERO;
        curr.external_outflow_base = Decimal::ZERO;

        let flow =
            PerformanceService::daily_external_flows(&prev, &curr, ExternalFlowBasis::BaseCurrency);

        assert_eq!(flow.source, ExternalFlowSource::Unknown);
    }

    // End to end: a zero-amount `Unknown` daily flow must make TWR unavailable
    // rather than reporting a return for a period whose flow we could not value.
    #[test]
    fn returns_unavailable_when_a_daily_flow_is_zero_amount_unknown() {
        let mut history = vec![
            valuation("2026-04-01", dec!(1000), dec!(1000), dec!(1000), dec!(1000)),
            valuation("2026-04-02", dec!(1200), dec!(1000), dec!(1200), dec!(1000)),
        ];
        // A real flow event we could not value: unchanged net contribution and
        // no gross amounts, but the provenance says the flow is unknown.
        history[1].external_flow_source = ExternalFlowSource::Unknown;

        let result = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Transactions),
            None,
            false,
        )
        .expect("performance should return a degraded result, not error");

        assert!(
            result.returns.twr.is_none(),
            "TWR must be unavailable when a daily flow source is Unknown",
        );
        assert!(result
            .data_quality
            .not_applicable_reasons
            .iter()
            .any(|reason| {
                reason.contains("external flow amount or transfer boundary is unknown")
            }));
    }

    // ── Phase 3 parity/closure gate ──────────────────────────────────────────
    //
    // The refactor's plan is to rebuild attribution by summing categorized
    // economic effects and *delete the residual*. That is only valid if the
    // current engine's attribution already reconciles to the value delta with no
    // residual. This test characterizes that on representative histories. If it
    // ever fails, "delete the residual" is the wrong design — the failing case is
    // a real economic effect the effect model must capture, not a rounding fudge.
    #[test]
    fn attribution_reconciles_to_value_delta_without_residual() {
        struct Case {
            name: &'static str,
            start: DailyAccountValuation,
            end: DailyAccountValuation,
        }

        let mut deposit_then_gain_end =
            valuation("2026-02-01", dec!(1500), dec!(1200), dec!(1500), dec!(1200));
        deposit_then_gain_end.external_inflow_base = dec!(200);
        deposit_then_gain_end.external_flow_source = ExternalFlowSource::CashAmount;

        let mut withdrawal_end =
            valuation("2026-02-01", dec!(850), dec!(800), dec!(850), dec!(800));
        withdrawal_end.external_outflow_base = dec!(200);
        withdrawal_end.external_flow_source = ExternalFlowSource::CashAmount;

        let cases = [
            Case {
                name: "pure unrealized gain, no flow",
                start: valuation("2026-01-01", dec!(1000), dec!(1000), dec!(1000), dec!(1000)),
                end: valuation("2026-02-01", dec!(1300), dec!(1000), dec!(1300), dec!(1000)),
            },
            Case {
                name: "deposit plus gain",
                start: valuation("2026-01-01", dec!(1000), dec!(1000), dec!(1000), dec!(1000)),
                end: deposit_then_gain_end,
            },
            Case {
                name: "withdrawal plus gain",
                start: valuation("2026-01-01", dec!(1000), dec!(1000), dec!(1000), dec!(1000)),
                end: withdrawal_end,
            },
        ];

        let tolerance = dec!(0.01);
        for case in cases {
            // All-time scope uses an inception baseline: the opening balance is
            // treated as initial capital, so the components explain the *ending
            // value*, not the period delta. (Bounded scopes would reconcile to the
            // delta instead — the closure identity is baseline-dependent, which is
            // exactly what the effect-summation rewrite must preserve.)
            let end_value = case.end.total_value_base;
            let result = PerformanceService::compute_account_performance(
                &[case.start, case.end],
                Some(TrackingMode::Transactions),
                None,
                false,
            )
            .expect("performance should compute");
            let a = &result.attribution;
            let explained = (a.contributions - a.distributions)
                + a.income
                + a.realized_pnl
                + a.unrealized_pnl_change
                + a.fx_effect
                - a.fees
                - a.taxes;
            let residual = end_value - explained;
            assert!(
                residual.abs() <= tolerance,
                "[{}] attribution did not reconcile: end_value={end_value}, explained={explained}, residual={residual}",
                case.name,
            );
            assert!(
                !result
                    .data_quality
                    .warnings
                    .iter()
                    .any(|w| w.starts_with("Attribution residual")),
                "[{}] engine emitted a residual warning",
                case.name,
            );
        }
    }

    #[test]
    fn basis_status_is_not_inferred_from_display_reasons() {
        let data_quality = PerformanceDataQuality {
            status: DataQualityStatus::Partial,
            warnings: vec!["Display copy mentions basis is missing.".to_string()],
            not_applicable_reasons: Vec::new(),
        };

        assert_eq!(
            PerformanceService::basis_status_for_result(
                ReturnMethod::TimeWeighted,
                &data_quality,
                false,
                false,
            ),
            BasisStatus::NotApplicable
        );
    }

    #[test]
    fn account_perf_uses_account_currency_flows_for_foreign_currency_accounts() {
        let mut prev = valuation("2026-04-01", dec!(100), dec!(100), dec!(100), dec!(100));
        let mut curr = valuation("2026-04-02", dec!(210), dec!(200), dec!(210), dec!(200));
        prev.account_currency = "EUR".to_string();
        prev.base_currency = "USD".to_string();
        prev.fx_rate_to_base = dec!(1.1);
        prev.total_value_base = dec!(110);
        prev.net_contribution_base = dec!(110);
        curr.account_currency = "EUR".to_string();
        curr.base_currency = "USD".to_string();
        curr.fx_rate_to_base = dec!(1.1);
        curr.total_value_base = dec!(231);
        curr.net_contribution_base = dec!(220);
        curr.external_inflow_base = dec!(110);
        curr.external_flow_source = ExternalFlowSource::StoredGross;

        let result = PerformanceService::compute_account_performance(
            &[prev, curr],
            Some(TrackingMode::Transactions),
            None,
            false,
        )
        .expect("foreign-currency account performance should compute");

        assert_eq!(result.scope.currency, "USD");
        assert_eq!(attribution_pnl(&result), dec!(10));
        assert_eq!(result.returns.twr.unwrap().round_dp(4), dec!(0.05));
    }

    /// HOLDINGS mode uses gain-vs-book-basis for all-time. TWR/IRR are returned
    /// as `None` because they aren't meaningful without per-transaction
    /// cash-flow tracking.
    #[test]
    fn perf_holdings_mode_uses_book_basis_formula() {
        let history = vec![
            valuation("2026-02-15", dec!(1250), dec!(1200), dec!(1000), dec!(1000)),
            valuation("2026-04-14", dec!(1170), dec!(1200), dec!(900), dec!(1000)),
        ];

        let result = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Holdings),
            None, // ALL-time branch
            false,
        )
        .expect("holdings should compute");

        // end P&L = total value 1170 - book basis 1200 = -30; return = -30 / 1200.
        assert_eq!(
            result.returns.value_return.unwrap().round_dp(4),
            dec!(-0.025)
        );
        assert_eq!(attribution_pnl(&result), dec!(-30));
        assert!(result.returns.twr.is_none());
        assert!(result.returns.irr.is_none());
        assert!(result.is_holdings_mode);
    }

    #[test]
    fn perf_holdings_mode_period_uses_value_change_not_book_basis_delta() {
        let history = vec![
            valuation(
                "2026-06-12",
                dec!(106237.35656319),
                Decimal::ZERO,
                dec!(40927.18483152),
                dec!(64350.62189612),
            ),
            valuation(
                "2026-06-19",
                dec!(107423.43363762),
                dec!(131508.39981717),
                dec!(41182.62224114),
                dec!(65267.58842069),
            ),
        ];

        let result = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Holdings),
            Some(date("2026-06-12")),
            false,
        )
        .expect("holdings period should compute");

        assert_eq!(
            result.returns.value_return.unwrap().round_dp(4),
            dec!(0.0112)
        );
        assert_eq!(attribution_pnl(&result).round_dp(2), dec!(1186.08));
        assert_eq!(result.attribution.contributions, Decimal::ZERO);
        assert_eq!(result.attribution.residual, Decimal::ZERO);
    }

    #[test]
    fn perf_holdings_period_partial_basis_suppresses_headline_amount_and_percent() {
        let mut history = vec![
            valuation("2026-06-12", dec!(1000), dec!(1000), dec!(800), dec!(800)),
            valuation("2026-06-19", dec!(1100), dec!(1000), dec!(900), dec!(800)),
        ];
        history[1].performance_eligible_value_base = dec!(700);
        history[1].basis_status = BasisStatus::PartialUnknown;

        let result = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Holdings),
            Some(date("2026-06-12")),
            false,
        )
        .expect("holdings period should compute with degraded basis quality");

        assert_eq!(result.basis_status, BasisStatus::PartialUnknown);
        assert_eq!(result.summary.amount, None);
        assert_eq!(result.summary.percent, None);
        assert_eq!(
            result.summary.amount_status,
            PerformanceSummaryStatus::Unavailable
        );
        assert_eq!(
            result.summary.percent_status,
            PerformanceSummaryStatus::Unavailable
        );
    }

    #[test]
    fn perf_holdings_mode_omits_value_return_when_denominator_is_undefined() {
        let history = vec![
            valuation(
                "2026-02-15",
                Decimal::ZERO,
                Decimal::ZERO,
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            valuation(
                "2026-04-14",
                dec!(50),
                Decimal::ZERO,
                dec!(50),
                Decimal::ZERO,
            ),
        ];

        let all_time = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Holdings),
            None,
            false,
        )
        .expect("holdings should compute");

        assert!(all_time.returns.value_return.is_none());
        assert!(all_time
            .data_quality
            .not_applicable_reasons
            .iter()
            .any(|reason| reason.contains("ending book basis")));
        assert!(all_time
            .data_quality
            .not_applicable_reasons
            .iter()
            .any(|reason| reason.contains("P&L unavailable")));

        let period = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Holdings),
            Some(date("2026-02-01")),
            false,
        )
        .expect("holdings should compute");

        assert!(period.returns.value_return.is_none());
        assert!(period
            .data_quality
            .not_applicable_reasons
            .iter()
            .any(|reason| reason.contains("starting total value")));
    }

    #[test]
    fn perf_holdings_mode_all_time_omits_return_when_basis_is_incomplete() {
        let mut history = vec![
            valuation("2026-02-15", dec!(500), dec!(500), dec!(500), dec!(500)),
            valuation("2026-04-14", dec!(600), dec!(100), dec!(600), dec!(100)),
        ];
        history[1].performance_eligible_value_base = dec!(100);
        history[1].basis_status = BasisStatus::PartialUnknown;

        let result = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Holdings),
            None,
            false,
        )
        .expect("holdings should compute with degraded basis quality");

        assert!(result.returns.value_return.is_none());
        assert_eq!(attribution_pnl(&result), Decimal::ZERO);
        assert!(result
            .data_quality
            .not_applicable_reasons
            .iter()
            .any(|reason| reason.contains("basis is incomplete")));
        assert!(result
            .data_quality
            .not_applicable_reasons
            .iter()
            .any(|reason| reason.contains("P&L unavailable")));
    }

    #[test]
    fn scoped_performance_uses_mixed_mode_without_dropping_holdings_accounts() {
        let account_ids = vec!["tx".to_string(), "holdings".to_string()];
        let mut modes = HashMap::new();
        modes.insert("tx".to_string(), TrackingMode::Transactions);
        modes.insert("holdings".to_string(), TrackingMode::Holdings);

        let composition = PerformanceService::scoped_tracking_composition(&account_ids, &modes);

        assert_eq!(composition, ScopedTrackingComposition::Mixed);
    }

    #[test]
    fn scoped_performance_uses_holdings_mode_when_all_accounts_are_holdings_mode() {
        let account_ids = vec!["holdings-a".to_string(), "holdings-b".to_string()];
        let mut modes = HashMap::new();
        modes.insert("holdings-a".to_string(), TrackingMode::Holdings);
        modes.insert("holdings-b".to_string(), TrackingMode::Holdings);

        let composition = PerformanceService::scoped_tracking_composition(&account_ids, &modes);

        assert_eq!(composition, ScopedTrackingComposition::HoldingsOnly);
    }

    #[test]
    fn mixed_scope_account_level_headline_ignores_holdings_book_basis_jump() {
        let cash_cad = vec![
            account_valuation(
                "cash-cad",
                "2026-06-12",
                dec!(85000),
                Decimal::ZERO,
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            account_valuation(
                "cash-cad",
                "2026-06-19",
                dec!(85000),
                dec!(85000),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
        ];
        let cash_usd = vec![
            account_valuation(
                "cash-usd",
                "2026-06-12",
                dec!(113176.44),
                Decimal::ZERO,
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            account_valuation(
                "cash-usd",
                "2026-06-19",
                dec!(114789.16),
                dec!(114789.16),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
        ];
        let invest_cad = vec![
            account_valuation(
                "invest-cad",
                "2026-06-12",
                dec!(45068.75),
                dec!(36000),
                dec!(45068.75),
                dec!(36000),
            ),
            account_valuation(
                "invest-cad",
                "2026-06-19",
                dec!(45986.16),
                dec!(36000),
                dec!(45986.16),
                dec!(36000),
            ),
        ];
        let invest_usd = vec![
            account_valuation(
                "invest-usd",
                "2026-06-12",
                dec!(62360.29),
                dec!(49298.88),
                dec!(62360.29),
                dec!(49298.88),
            ),
            account_valuation(
                "invest-usd",
                "2026-06-19",
                dec!(63803.10),
                dec!(49298.88),
                dec!(63803.10),
                dec!(49298.88),
            ),
        ];
        let components = vec![
            MixedScopeAccountHistory {
                account_id: "cash-cad",
                tracking_mode: TrackingMode::Holdings,
                account_type: Some(account_types::CASH),
                history: &cash_cad,
            },
            MixedScopeAccountHistory {
                account_id: "cash-usd",
                tracking_mode: TrackingMode::Holdings,
                account_type: Some(account_types::CASH),
                history: &cash_usd,
            },
            MixedScopeAccountHistory {
                account_id: "invest-cad",
                tracking_mode: TrackingMode::Transactions,
                account_type: None,
                history: &invest_cad,
            },
            MixedScopeAccountHistory {
                account_id: "invest-usd",
                tracking_mode: TrackingMode::Transactions,
                account_type: None,
                history: &invest_usd,
            },
        ];

        let result = PerformanceService::compute_mixed_scope_performance_from_account_histories(
            &components,
            "CAD",
            Some(date("2026-06-12")),
            true,
            PerformanceSummaryProfile::Summary,
        )
        .expect("mixed scope should compute from account-level components");

        assert!(result.is_mixed_tracking_mode);
        assert_eq!(result.mode, ReturnMethod::ValueReturn);
        assert_eq!(attribution_pnl(&result).round_dp(2), dec!(3972.94));
        assert_eq!(
            result.returns.value_return.unwrap().round_dp(4),
            dec!(0.0130)
        );
        assert_eq!(result.attribution.contributions, Decimal::ZERO);
        assert_eq!(
            result.series.last().unwrap().value.round_dp(4),
            dec!(0.0130)
        );
    }

    #[test]
    fn mixed_scope_account_level_headline_subtracts_transaction_flows_only() {
        let holdings = vec![
            account_valuation(
                "holdings",
                "2026-06-12",
                dec!(500),
                Decimal::ZERO,
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            account_valuation(
                "holdings",
                "2026-06-19",
                dec!(550),
                dec!(550),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
        ];
        let mut transaction = [
            account_valuation(
                "transaction",
                "2026-06-12",
                dec!(1000),
                dec!(1000),
                dec!(1000),
                dec!(1000),
            ),
            account_valuation(
                "transaction",
                "2026-06-19",
                dec!(1200),
                dec!(1100),
                dec!(1200),
                dec!(1100),
            ),
        ];
        transaction[1].external_inflow_base = dec!(100);
        transaction[1].external_flow_source = ValuationExternalFlowSource::StoredGross;
        let components = vec![
            MixedScopeAccountHistory {
                account_id: "holdings",
                tracking_mode: TrackingMode::Holdings,
                account_type: None,
                history: &holdings,
            },
            MixedScopeAccountHistory {
                account_id: "transaction",
                tracking_mode: TrackingMode::Transactions,
                account_type: None,
                history: &transaction,
            },
        ];

        let result = PerformanceService::compute_mixed_scope_performance_from_account_histories(
            &components,
            "CAD",
            Some(date("2026-06-12")),
            false,
            PerformanceSummaryProfile::Summary,
        )
        .expect("mixed scope should compute transaction flows at account level");

        assert_eq!(attribution_pnl(&result), dec!(150));
        assert_eq!(result.attribution.contributions, dec!(100));
        assert_eq!(result.returns.value_return.unwrap().round_dp(4), dec!(0.1));
    }

    #[test]
    fn mixed_scope_bounded_series_uses_account_component_timelines() {
        let mut transaction = [
            account_valuation(
                "transaction",
                "2026-06-12",
                dec!(1000),
                dec!(1000),
                dec!(1000),
                dec!(1000),
            ),
            account_valuation(
                "transaction",
                "2026-06-13",
                dec!(1100),
                dec!(1000),
                dec!(1100),
                dec!(1000),
            ),
            account_valuation(
                "transaction",
                "2026-06-14",
                dec!(1200),
                dec!(1000),
                dec!(1200),
                dec!(1000),
            ),
        ];
        transaction[1].external_flow_source = ValuationExternalFlowSource::StoredGross;
        transaction[2].external_flow_source = ValuationExternalFlowSource::StoredGross;
        let holdings = vec![
            account_valuation(
                "holdings",
                "2026-06-13",
                dec!(500),
                dec!(500),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            account_valuation(
                "holdings",
                "2026-06-14",
                dec!(550),
                dec!(500),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
        ];
        let components = vec![
            MixedScopeAccountHistory {
                account_id: "transaction",
                tracking_mode: TrackingMode::Transactions,
                account_type: None,
                history: &transaction,
            },
            MixedScopeAccountHistory {
                account_id: "holdings",
                tracking_mode: TrackingMode::Holdings,
                account_type: None,
                history: &holdings,
            },
        ];

        let result = PerformanceService::compute_mixed_scope_performance_from_account_histories(
            &components,
            "CAD",
            Some(date("2026-06-12")),
            true,
            PerformanceSummaryProfile::Summary,
        )
        .expect("mixed scope should build a component-level series");

        assert_eq!(attribution_pnl(&result), dec!(250));
        assert_eq!(
            result.returns.value_return.unwrap().round_dp(4),
            dec!(0.1667)
        );
        assert_eq!(result.series.len(), 3);
        assert_eq!(result.series[0].date, date("2026-06-12"));
        assert_eq!(result.series[0].value, Decimal::ZERO);
        assert_eq!(result.series[1].date, date("2026-06-13"));
        assert_eq!(result.series[1].value.round_dp(4), dec!(0.1));
        assert_eq!(result.series[2].date, date("2026-06-14"));
        assert_eq!(result.series[2].value.round_dp(4), dec!(0.1667));
    }

    #[test]
    fn mixed_scope_all_time_suppresses_combined_percent_when_holdings_basis_incomplete() {
        let transaction = [
            account_valuation(
                "transaction",
                "2026-06-12",
                dec!(1000),
                dec!(1000),
                dec!(1000),
                dec!(1000),
            ),
            account_valuation(
                "transaction",
                "2026-06-14",
                dec!(1100),
                dec!(1000),
                dec!(1100),
                dec!(1000),
            ),
        ];
        let mut holdings = vec![
            account_valuation(
                "holdings",
                "2026-06-12",
                dec!(500),
                dec!(500),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            account_valuation(
                "holdings",
                "2026-06-14",
                dec!(600),
                dec!(100),
                dec!(600),
                dec!(100),
            ),
        ];
        holdings[1].performance_eligible_value_base = dec!(100);
        holdings[1].basis_status = BasisStatus::PartialUnknown;
        let components = vec![
            MixedScopeAccountHistory {
                account_id: "transaction",
                tracking_mode: TrackingMode::Transactions,
                account_type: None,
                history: &transaction,
            },
            MixedScopeAccountHistory {
                account_id: "holdings",
                tracking_mode: TrackingMode::Holdings,
                account_type: None,
                history: &holdings,
            },
        ];

        let result = PerformanceService::compute_mixed_scope_performance_from_account_histories(
            &components,
            "CAD",
            None,
            true,
            PerformanceSummaryProfile::Summary,
        )
        .expect("mixed all-time scope should degrade incomplete holdings basis");

        assert_eq!(attribution_pnl(&result), dec!(100));
        assert_eq!(result.returns.value_return, None);
        assert_eq!(result.summary.amount, Some(dec!(100)));
        assert_eq!(result.summary.percent, None);
        assert_eq!(
            result.summary.amount_status,
            PerformanceSummaryStatus::Complete
        );
        assert_eq!(
            result.summary.percent_status,
            PerformanceSummaryStatus::Unavailable
        );
        assert!(result
            .data_quality
            .warnings
            .iter()
            .any(|warning| warning.contains("excluded account holdings")));
        assert!(result
            .data_quality
            .not_applicable_reasons
            .iter()
            .any(|reason| reason.contains("basis is incomplete")));
    }

    #[test]
    fn mixed_scope_returns_no_combined_percent_when_component_denominator_is_missing() {
        let holdings = vec![
            account_valuation(
                "holdings",
                "2026-06-12",
                Decimal::ZERO,
                Decimal::ZERO,
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            account_valuation(
                "holdings",
                "2026-06-19",
                dec!(50),
                dec!(50),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
        ];
        let transaction = [
            account_valuation(
                "transaction",
                "2026-06-12",
                dec!(1000),
                dec!(1000),
                dec!(1000),
                dec!(1000),
            ),
            account_valuation(
                "transaction",
                "2026-06-19",
                dec!(1100),
                dec!(1000),
                dec!(1100),
                dec!(1000),
            ),
        ];
        let components = vec![
            MixedScopeAccountHistory {
                account_id: "holdings",
                tracking_mode: TrackingMode::Holdings,
                account_type: None,
                history: &holdings,
            },
            MixedScopeAccountHistory {
                account_id: "transaction",
                tracking_mode: TrackingMode::Transactions,
                account_type: None,
                history: &transaction,
            },
        ];

        let result = PerformanceService::compute_mixed_scope_performance_from_account_histories(
            &components,
            "CAD",
            Some(date("2026-06-12")),
            true,
            PerformanceSummaryProfile::Summary,
        )
        .expect("mixed scope should compute with a degraded denominator");

        assert_eq!(attribution_pnl(&result), dec!(150));
        assert_eq!(result.returns.value_return, None);
        assert!(result.series.is_empty());
        assert!(result.data_quality.warnings.iter().any(|warning| {
            warning.contains("account holdings contributes to the summary amount")
        }));
        assert!(result
            .data_quality
            .not_applicable_reasons
            .iter()
            .any(|reason| reason.contains("summary amount and denominator coverage differ")));
    }

    #[test]
    fn mixed_scope_all_time_transactions_use_first_positive_value_denominator() {
        let mut transaction = vec![
            account_valuation(
                "transaction",
                "2026-01-01",
                Decimal::ZERO,
                Decimal::ZERO,
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            account_valuation(
                "transaction",
                "2026-01-02",
                dec!(1000),
                dec!(1000),
                dec!(1000),
                dec!(1000),
            ),
            account_valuation(
                "transaction",
                "2026-01-03",
                dec!(1100),
                dec!(1000),
                dec!(1100),
                dec!(1000),
            ),
        ];
        transaction[1].external_inflow_base = dec!(1000);
        transaction[1].external_flow_source = ValuationExternalFlowSource::StoredGross;
        let holdings = vec![
            account_valuation(
                "holdings",
                "2026-01-01",
                dec!(500),
                dec!(500),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            account_valuation(
                "holdings",
                "2026-01-03",
                dec!(550),
                dec!(500),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
        ];
        let components = vec![
            MixedScopeAccountHistory {
                account_id: "transaction",
                tracking_mode: TrackingMode::Transactions,
                account_type: None,
                history: &transaction,
            },
            MixedScopeAccountHistory {
                account_id: "holdings",
                tracking_mode: TrackingMode::Holdings,
                account_type: None,
                history: &holdings,
            },
        ];

        let result = PerformanceService::compute_mixed_scope_performance_from_account_histories(
            &components,
            "CAD",
            None,
            true,
            PerformanceSummaryProfile::Summary,
        )
        .expect("mixed all-time scope should compute");

        assert_eq!(attribution_pnl(&result), dec!(150));
        assert_eq!(result.returns.value_return.unwrap().round_dp(4), dec!(0.1));
        assert!(result.series.is_empty());
        assert!(result
            .data_quality
            .warnings
            .iter()
            .any(|warning| warning.contains("Return series unavailable")));
        assert!(!result
            .data_quality
            .not_applicable_reasons
            .iter()
            .any(|reason| reason.contains("transaction-mode scope because starting value")));
    }

    #[test]
    fn mixed_scope_skips_negative_component_instead_of_failing_scope() {
        let holdings = vec![
            account_valuation(
                "holdings",
                "2026-06-12",
                dec!(500),
                dec!(500),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            account_valuation(
                "holdings",
                "2026-06-19",
                dec!(550),
                dec!(500),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
        ];
        let negative_transaction = vec![
            account_valuation(
                "negative-transaction",
                "2026-06-12",
                dec!(100),
                dec!(100),
                dec!(100),
                dec!(100),
            ),
            account_valuation(
                "negative-transaction",
                "2026-06-19",
                dec!(-10),
                dec!(100),
                dec!(-10),
                dec!(100),
            ),
        ];
        let components = vec![
            MixedScopeAccountHistory {
                account_id: "holdings",
                tracking_mode: TrackingMode::Holdings,
                account_type: None,
                history: &holdings,
            },
            MixedScopeAccountHistory {
                account_id: "negative-transaction",
                tracking_mode: TrackingMode::Transactions,
                account_type: None,
                history: &negative_transaction,
            },
        ];

        let result = PerformanceService::compute_mixed_scope_performance_from_account_histories(
            &components,
            "CAD",
            Some(date("2026-06-12")),
            true,
            PerformanceSummaryProfile::Summary,
        )
        .expect("mixed scope should degrade negative component");

        assert_eq!(attribution_pnl(&result), dec!(50));
        assert_eq!(result.returns.value_return.unwrap().round_dp(4), dec!(0.1));
        assert_eq!(result.series.last().unwrap().value.round_dp(4), dec!(0.1));
        assert!(result
            .data_quality
            .warnings
            .iter()
            .any(|warning| warning.contains("negative portfolio value")));
    }

    #[tokio::test]
    async fn mixed_scope_summary_uses_account_histories_not_aggregate_scope_history() {
        let mut transaction = [
            account_valuation(
                "transaction",
                "2026-06-12",
                dec!(1000),
                dec!(1000),
                dec!(1000),
                dec!(1000),
            ),
            account_valuation(
                "transaction",
                "2026-06-19",
                dec!(1200),
                dec!(1100),
                dec!(1200),
                dec!(1100),
            ),
        ];
        transaction[1].external_inflow_base = dec!(100);
        transaction[1].external_flow_source = ValuationExternalFlowSource::StoredGross;
        let history = vec![
            account_valuation(
                "holdings",
                "2026-06-12",
                dec!(500),
                Decimal::ZERO,
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            account_valuation(
                "holdings",
                "2026-06-19",
                dec!(550),
                dec!(550),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            transaction[0].clone(),
            transaction[1].clone(),
        ];
        let service = PerformanceService::new(
            Arc::new(TestValuationService::new_with_aggregate_failure(history)),
            Arc::new(TestQuoteService),
        );
        let account_ids = vec!["holdings".to_string(), "transaction".to_string()];
        let mut modes = HashMap::new();
        modes.insert("holdings".to_string(), TrackingMode::Holdings);
        modes.insert("transaction".to_string(), TrackingMode::Transactions);
        let account_types = HashMap::new();

        let result = service
            .calculate_performance_summary_for_accounts(
                "mixed-scope",
                &account_ids,
                "CAD",
                &modes,
                &account_types,
                Some(date("2026-06-12")),
                Some(date("2026-06-19")),
                PerformanceSummaryProfile::Summary,
            )
            .await
            .expect("mixed summary should bypass aggregate scoped history");

        assert_eq!(result.scope.id, "mixed-scope");
        assert!(result.is_mixed_tracking_mode);
        assert_eq!(attribution_pnl(&result), dec!(150));
        assert_eq!(result.returns.value_return.unwrap().round_dp(4), dec!(0.1));
    }

    #[tokio::test]
    async fn mixed_scope_summary_enriches_transaction_component_attribution() {
        let transaction = [
            account_valuation(
                "transaction",
                "2026-06-12",
                dec!(1000),
                dec!(1000),
                dec!(1000),
                dec!(1000),
            ),
            account_valuation(
                "transaction",
                "2026-06-19",
                dec!(1050),
                dec!(1000),
                dec!(1000),
                dec!(1000),
            ),
        ];
        let holdings = [
            account_valuation(
                "holdings",
                "2026-06-12",
                dec!(500),
                dec!(500),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            account_valuation(
                "holdings",
                "2026-06-19",
                dec!(550),
                dec!(500),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
        ];
        let history = vec![
            transaction[0].clone(),
            transaction[1].clone(),
            holdings[0].clone(),
            holdings[1].clone(),
        ];
        let valuation_service = Arc::new(TestValuationService::new_with_aggregate_failure(history));
        let mut dividend = income_activity_on(
            "dividend-1",
            "transaction",
            "2026-06-19",
            ActivityType::Dividend,
            dec!(50),
        );
        dividend.currency = "CAD".to_string();
        let activity_repo = Arc::new(TestActivityRepository::new(vec![dividend]));
        let service = PerformanceService::new(valuation_service, Arc::new(TestQuoteService))
            .with_activity_repository(activity_repo, Arc::new(TestFxService));
        let account_ids = vec!["transaction".to_string(), "holdings".to_string()];
        let mut modes = HashMap::new();
        modes.insert("transaction".to_string(), TrackingMode::Transactions);
        modes.insert("holdings".to_string(), TrackingMode::Holdings);
        let account_types = HashMap::new();

        let result = service
            .calculate_performance_summary_for_accounts(
                "mixed-scope",
                &account_ids,
                "CAD",
                &modes,
                &account_types,
                Some(date("2026-06-12")),
                Some(date("2026-06-19")),
                PerformanceSummaryProfile::Summary,
            )
            .await
            .expect("mixed summary should enrich transaction attribution");

        assert_eq!(result.attribution.income, dec!(50));
        assert_eq!(result.attribution.unrealized_pnl_change, dec!(50));
        assert_eq!(result.attribution.residual, Decimal::ZERO);
        assert_eq!(attribution_pnl(&result), dec!(100));
        assert_eq!(
            result.returns.value_return.unwrap().round_dp(4),
            dec!(0.0667)
        );
    }

    #[tokio::test]
    async fn mixed_scope_dashboard_skips_transaction_component_attribution() {
        let transaction = [
            account_valuation(
                "transaction",
                "2026-06-12",
                dec!(1000),
                dec!(1000),
                dec!(1000),
                dec!(1000),
            ),
            account_valuation(
                "transaction",
                "2026-06-19",
                dec!(1050),
                dec!(1000),
                dec!(1000),
                dec!(1000),
            ),
        ];
        let holdings = [
            account_valuation(
                "holdings",
                "2026-06-12",
                dec!(500),
                dec!(500),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            account_valuation(
                "holdings",
                "2026-06-19",
                dec!(550),
                dec!(500),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
        ];
        let history = vec![
            transaction[0].clone(),
            transaction[1].clone(),
            holdings[0].clone(),
            holdings[1].clone(),
        ];
        let valuation_service = Arc::new(TestValuationService::new_with_aggregate_failure(history));
        let mut dividend = income_activity_on(
            "dividend-1",
            "transaction",
            "2026-06-19",
            ActivityType::Dividend,
            dec!(50),
        );
        dividend.currency = "CAD".to_string();
        let activity_repo = Arc::new(TestActivityRepository::new(vec![dividend]));
        let service = PerformanceService::new(valuation_service, Arc::new(TestQuoteService))
            .with_activity_repository(activity_repo, Arc::new(TestFxService));
        let account_ids = vec!["transaction".to_string(), "holdings".to_string()];
        let mut modes = HashMap::new();
        modes.insert("transaction".to_string(), TrackingMode::Transactions);
        modes.insert("holdings".to_string(), TrackingMode::Holdings);
        let account_types = HashMap::new();

        let result = service
            .calculate_performance_summary_for_accounts(
                "mixed-scope",
                &account_ids,
                "CAD",
                &modes,
                &account_types,
                Some(date("2026-06-12")),
                Some(date("2026-06-19")),
                PerformanceSummaryProfile::Dashboard,
            )
            .await
            .expect("mixed dashboard summary should skip detailed attribution");

        assert_eq!(result.attribution.income, Decimal::ZERO);
        assert_eq!(result.attribution.unrealized_pnl_change, dec!(100));
        assert_eq!(attribution_pnl(&result), dec!(100));
        assert_eq!(
            result.returns.value_return.unwrap().round_dp(4),
            dec!(0.0667)
        );
    }

    #[tokio::test]
    async fn dashboard_scope_preserves_time_weighted_return_percent() {
        let mut history = vec![
            account_valuation(
                "transaction",
                "2026-06-12",
                dec!(1000),
                dec!(1000),
                dec!(1000),
                dec!(1000),
            ),
            account_valuation(
                "transaction",
                "2026-06-19",
                dec!(1200),
                dec!(1100),
                dec!(1200),
                dec!(1100),
            ),
        ];
        history[1].external_inflow_base = dec!(100);
        history[1].external_flow_source = ValuationExternalFlowSource::StoredGross;
        let valuation_service = Arc::new(TestValuationService::new(history));
        let service = PerformanceService::new(valuation_service, Arc::new(TestQuoteService));
        let account_ids = vec!["transaction".to_string()];
        let mut modes = HashMap::new();
        modes.insert("transaction".to_string(), TrackingMode::Transactions);
        let account_types = HashMap::new();

        let result = service
            .calculate_performance_summary_for_accounts(
                "dashboard-scope",
                &account_ids,
                "CAD",
                &modes,
                &account_types,
                Some(date("2026-06-12")),
                Some(date("2026-06-19")),
                PerformanceSummaryProfile::Dashboard,
            )
            .await
            .expect("dashboard summary should preserve return semantics");

        assert_eq!(result.summary.amount, Some(dec!(100)));
        assert_eq!(result.summary.method, ReturnMethod::TimeWeighted);
        assert_eq!(result.returns.value_return.unwrap().round_dp(4), dec!(0.1));
        assert_eq!(result.returns.twr.unwrap().round_dp(4), dec!(0.0909));
        assert_eq!(
            result.summary.percent.unwrap().round_dp(4),
            result.returns.twr.unwrap().round_dp(4)
        );
    }

    #[test]
    fn mixed_scope_performance_is_value_complete_simple_return() {
        let mut history = vec![
            valuation("2026-05-01", dec!(1500), dec!(1500), dec!(1500), dec!(1500)),
            valuation("2026-05-02", dec!(1660), dec!(1600), dec!(1660), dec!(1600)),
        ];
        history[1].external_inflow_base = dec!(100);

        let result = PerformanceService::compute_mixed_scope_performance(&history, true)
            .expect("mixed scope should compute");

        assert!(result.is_mixed_tracking_mode);
        assert_eq!(result.mode, ReturnMethod::ValueReturn);
        assert_eq!(attribution_pnl(&result), dec!(60));
        assert_eq!(result.returns.value_return.unwrap().round_dp(4), dec!(0.04));
        assert_eq!(result.series.last().unwrap().value.round_dp(4), dec!(0.04));
        assert!(result.returns.twr.is_none());
        assert!(result.returns.irr.is_none());
        assert!(!result.data_quality.warnings.is_empty());
    }

    #[test]
    fn mixed_scope_performance_uses_base_currency_values() {
        let mut history = vec![
            valuation("2026-05-01", dec!(50), dec!(50), dec!(50), dec!(50)),
            valuation("2027-05-01", dec!(80), dec!(60), dec!(80), dec!(60)),
        ];
        history[0].base_currency = "CAD".to_string();
        history[0].total_value_base = dec!(100);
        history[0].investment_market_value_base = dec!(100);
        history[0].cost_basis_base = dec!(100);
        history[0].net_contribution_base = dec!(100);
        history[1].base_currency = "CAD".to_string();
        history[1].total_value_base = dec!(130);
        history[1].investment_market_value_base = dec!(130);
        history[1].cost_basis_base = dec!(110);
        history[1].net_contribution_base = dec!(110);
        history[1].external_inflow_base = dec!(10);

        let result = PerformanceService::compute_mixed_scope_performance(&history, true)
            .expect("mixed scope should compute from base values");

        assert_eq!(result.scope.currency, "CAD");
        assert_eq!(result.returns.value_return.unwrap().round_dp(4), dec!(0.2));
        assert_eq!(result.series.last().unwrap().value.round_dp(4), dec!(0.2));
        assert_eq!(result.attribution.contributions, dec!(10));
    }

    #[test]
    fn mixed_scope_degrades_negative_portfolio_value_without_series() {
        let history = vec![
            valuation("2026-05-01", dec!(100), dec!(100), dec!(100), dec!(100)),
            valuation("2026-05-02", dec!(-50), dec!(100), dec!(-50), dec!(100)),
        ];

        for include_series in [true, false] {
            let result =
                PerformanceService::compute_mixed_scope_performance(&history, include_series)
                    .expect("mixed scope should degrade negative portfolio value");

            assert_eq!(result.returns.value_return, None);
            assert_eq!(result.summary.percent, None);
            assert!(matches!(
                result.data_quality.status,
                DataQualityStatus::Partial
            ));
            assert!(result
                .data_quality
                .not_applicable_reasons
                .iter()
                .any(|reason| reason.contains("portfolio value is negative")));
        }
    }

    #[test]
    fn mixed_scope_with_zero_start_value_returns_not_applicable_value_return() {
        let mut history = vec![
            valuation(
                "2026-05-01",
                Decimal::ZERO,
                Decimal::ZERO,
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            valuation("2026-05-02", dec!(100), dec!(100), dec!(100), dec!(100)),
        ];
        history[1].external_inflow_base = dec!(100);

        let result = PerformanceService::compute_mixed_scope_performance(&history, true)
            .expect("mixed scope should compute P&L without a percentage denominator");

        assert!(result.returns.value_return.is_none());
        assert!(result.returns.annualized_value_return.is_none());
        assert!(result.series.is_empty());
        assert!(result
            .data_quality
            .not_applicable_reasons
            .iter()
            .any(|reason| reason.contains("starting value is zero or negative")));
    }

    #[test]
    fn drawdown_reports_unrecovered_decline_with_dates() {
        let samples = vec![
            RiskSample {
                date: date("2026-05-01"),
                simple_return: dec!(0.1),
            },
            RiskSample {
                date: date("2026-05-02"),
                simple_return: dec!(-0.2),
            },
            RiskSample {
                date: date("2026-05-03"),
                simple_return: dec!(-0.1),
            },
        ];

        let drawdown =
            PerformanceService::calculate_max_drawdown(&samples, Some(date("2026-04-30")));

        assert_eq!(drawdown.max_drawdown.unwrap().round_dp(4), dec!(-0.28));
        assert_eq!(drawdown.peak_date, Some(date("2026-05-01")));
        assert_eq!(drawdown.trough_date, Some(date("2026-05-03")));
        assert_eq!(drawdown.recovery_date, None);
        assert_eq!(drawdown.duration_days, Some(2));
    }

    #[test]
    fn drawdown_reports_recovery_date() {
        let samples = vec![
            RiskSample {
                date: date("2026-05-01"),
                simple_return: dec!(0.1),
            },
            RiskSample {
                date: date("2026-05-02"),
                simple_return: dec!(-0.1),
            },
            RiskSample {
                date: date("2026-05-03"),
                simple_return: dec!(0.12),
            },
        ];

        let drawdown =
            PerformanceService::calculate_max_drawdown(&samples, Some(date("2026-05-01")));

        assert_eq!(drawdown.max_drawdown.unwrap().round_dp(4), dec!(-0.1));
        assert_eq!(drawdown.peak_date, Some(date("2026-05-01")));
        assert_eq!(drawdown.trough_date, Some(date("2026-05-02")));
        assert_eq!(drawdown.recovery_date, Some(date("2026-05-03")));
        assert_eq!(drawdown.duration_days, Some(2));
    }

    #[test]
    fn drawdown_uses_opening_date_when_first_sample_declines() {
        let samples = vec![
            RiskSample {
                date: date("2026-05-02"),
                simple_return: dec!(-0.1),
            },
            RiskSample {
                date: date("2026-05-03"),
                simple_return: dec!(0.05),
            },
        ];

        let drawdown =
            PerformanceService::calculate_max_drawdown(&samples, Some(date("2026-05-01")));

        assert_eq!(drawdown.max_drawdown.unwrap().round_dp(4), dec!(-0.1));
        assert_eq!(drawdown.peak_date, Some(date("2026-05-01")));
        assert_eq!(drawdown.trough_date, Some(date("2026-05-02")));
        assert_eq!(drawdown.duration_days, Some(1));
    }

    #[test]
    fn risk_handles_flat_and_missing_series() {
        let empty_risk = PerformanceService::risk_from_samples(&[], None);
        assert!(empty_risk.volatility.is_none());
        assert!(empty_risk.max_drawdown.is_none());

        let flat_samples = vec![
            RiskSample {
                date: date("2026-05-01"),
                simple_return: Decimal::ZERO,
            },
            RiskSample {
                date: date("2026-05-02"),
                simple_return: Decimal::ZERO,
            },
        ];
        let flat_risk =
            PerformanceService::risk_from_samples(&flat_samples, Some(date("2026-05-01")));
        assert_eq!(flat_risk.volatility, Some(Decimal::ZERO));
        assert_eq!(flat_risk.max_drawdown, Some(Decimal::ZERO));
    }

    #[test]
    fn volatility_annualizes_calendar_daily_returns() {
        let volatility = PerformanceService::calculate_volatility(&[dec!(0), dec!(0.1)]);

        assert_eq!(volatility, Some(dec!(1.2880105)));
    }

    #[test]
    fn account_performance_keeps_zero_return_days_for_risk() {
        let history = vec![
            valuation("2026-05-01", dec!(100), dec!(100), dec!(100), dec!(100)),
            valuation("2026-05-02", dec!(100), dec!(100), dec!(100), dec!(100)),
            valuation("2026-05-03", dec!(100), dec!(100), dec!(100), dec!(100)),
        ];

        let result = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Transactions),
            None,
            true,
        )
        .expect("flat performance should compute");

        assert_eq!(result.risk.volatility, Some(Decimal::ZERO));
        assert_eq!(result.risk.max_drawdown, Some(Decimal::ZERO));
    }

    #[test]
    fn volatility_methodology_note_is_not_a_data_quality_warning() {
        let mut history = vec![
            valuation("2026-05-01", dec!(100), dec!(100), dec!(100), dec!(100)),
            valuation("2026-05-02", dec!(100), dec!(100), dec!(100), dec!(100)),
            valuation("2026-05-03", dec!(100), dec!(100), dec!(100), dec!(100)),
        ];
        for point in &mut history {
            point.external_flow_source = ExternalFlowSource::CashAmount;
        }

        let result = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Transactions),
            None,
            true,
        )
        .expect("performance should compute");

        assert!(result.risk.volatility.is_some());
        assert!(result.data_quality.warnings.is_empty());
        assert_eq!(result.data_quality.status, DataQualityStatus::Ok);
    }
}
