//! Performance served from stored rows through the kernel's `measure`
//! stage: load valuations, lots and disposals, recompile the facts, measure.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};
use std::time::Instant;

use async_trait::async_trait;
use chrono::{Duration, NaiveDate};
use futures::stream::{self, StreamExt};
use log::{debug, warn};
use rust_decimal::Decimal;
use wealthfolio_portfolio_engine as engine;
use wealthfolio_portfolio_engine::model::{AccountId, Currency};

use super::performance_model::*;
use crate::accounts::{Account, TrackingMode};
use crate::constants::DECIMAL_PRECISION;
use crate::errors::{Error, Result, ValidationError};
use crate::lots::LotRepositoryTrait;
use crate::portfolio::coordinator::{rows, FactSources};
use crate::portfolio::economic_events::BasisStatus;
use crate::portfolio::valuation::{DailyAccountValuation, ValuationRepositoryTrait};
use crate::quotes::QuoteServiceTrait;
use crate::utils::time_utils::{parse_user_timezone_or_default, user_today};

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

/// What `measure` evaluates: one account's own history, or a scope.
#[derive(Clone, Copy)]
enum MeasureTarget<'a> {
    Account(&'a str),
    Scope { id: &'a str, accounts: &'a [String] },
}

pub struct PerformanceService {
    base_currency: Arc<RwLock<String>>,
    timezone: Arc<RwLock<String>>,
    sources: FactSources,
    quotes: Arc<dyn QuoteServiceTrait>,
    valuations: Arc<dyn ValuationRepositoryTrait>,
    lots: Arc<dyn LotRepositoryTrait>,
}

impl PerformanceService {
    pub fn new(
        base_currency: Arc<RwLock<String>>,
        timezone: Arc<RwLock<String>>,
        sources: FactSources,
        valuations: Arc<dyn ValuationRepositoryTrait>,
        lots: Arc<dyn LotRepositoryTrait>,
    ) -> Self {
        let quotes = sources.quotes.clone();
        Self {
            base_currency,
            timezone,
            sources,
            quotes,
            valuations,
            lots,
        }
    }

    fn base_currency(&self) -> String {
        self.base_currency
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    fn timezone(&self) -> String {
        self.timezone
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    fn today(&self) -> NaiveDate {
        user_today(parse_user_timezone_or_default(&self.timezone()))
    }

    fn validate_window(start: Option<NaiveDate>, end: Option<NaiveDate>) -> Result<()> {
        if let (Some(start), Some(end)) = (start, end) {
            if start > end {
                return Err(Error::Validation(ValidationError::InvalidInput(
                    "Start date must be before end date".to_string(),
                )));
            }
        }
        Ok(())
    }

    /// Measures the stored rows: `Account` is the single-account view,
    /// `Scope` the scoped aggregation (legacy always routed `_for_accounts`
    /// through the scoped path, even for one account, so same-account FX
    /// transfer pairs keep their attribution).
    async fn measure(
        &self,
        target: MeasureTarget<'_>,
        start: Option<NaiveDate>,
        end: Option<NaiveDate>,
        profile: PerformanceSummaryProfile,
    ) -> Result<PerformanceResult> {
        let single;
        let account_ids: &[String] = match target {
            MeasureTarget::Account(id) => {
                single = [id.to_string()];
                &single
            }
            MeasureTarget::Scope { accounts, .. } => accounts,
        };
        Self::validate_window(start, end)?;
        let base_currency = self.base_currency();
        let as_of = self.today();
        let measured = rows::MeasureFacts::load(
            &self.sources,
            account_ids,
            &base_currency,
            &self.timezone(),
            as_of,
        )?;
        let resolved = measured.resolved();

        let mut valuation_rows: Vec<DailyAccountValuation> = Vec::new();
        let mut lot_rows = Vec::new();
        let mut disposal_rows = Vec::new();
        for account_id in account_ids {
            valuation_rows.extend(
                self.valuations
                    .get_historical_valuations(account_id, None, None)?,
            );
            lot_rows.extend(self.lots.get_all_lots_for_account(account_id).await?);
            disposal_rows.extend(self.lots.get_lot_disposals_for_account(account_id).await?);
        }
        let series = rows::stored_series(&valuation_rows);
        let lots = rows::stored_lots(&lot_rows);
        let disposals = rows::stored_disposals(&disposal_rows);
        let inputs = engine::MeasureInputs {
            resolved,
            series: &series,
            lots: &lots,
            disposals: &disposals,
        };
        let window = engine::Window { start, end };
        let kernel_profile = match profile {
            PerformanceSummaryProfile::Full => engine::MeasureProfile::Full,
            PerformanceSummaryProfile::Summary => engine::MeasureProfile::Summary,
            PerformanceSummaryProfile::Dashboard => engine::MeasureProfile::Dashboard,
        };
        let result = match target {
            MeasureTarget::Account(id) => {
                engine::measure_account(&inputs, &AccountId::new(id), window, kernel_profile)?
            }
            MeasureTarget::Scope { id, accounts } => {
                let scope: Vec<AccountId> = accounts.iter().map(AccountId::new).collect();
                engine::measure_scope(&inputs, id, &scope, window, kernel_profile)?
            }
        };
        Ok(from_kernel(result))
    }

    async fn symbol_performance(
        &self,
        asset_id: &str,
        start: Option<NaiveDate>,
        end: Option<NaiveDate>,
    ) -> Result<PerformanceResult> {
        let end_date = end.unwrap_or_else(|| self.today());
        let start_date = start.unwrap_or_else(|| end_date - Duration::days(365));
        if start_date > end_date {
            return Err(Error::Validation(ValidationError::InvalidInput(format!(
                "Effective start date {} must be before effective end date {}",
                start_date, end_date
            ))));
        }
        let quotes = self
            .quotes
            .fetch_quotes_for_symbol(asset_id, "USD", start_date, end_date)
            .await?;
        if quotes.is_empty() {
            warn!(
                "Asset '{}': No quote data found between {} and {}.",
                asset_id, start_date, end_date
            );
            return Ok(unavailable_performance_metrics(
                asset_id,
                "USD".to_string(),
                Some(start_date),
                Some(end_date),
                "Performance unavailable: no quote data found for the selected period.",
            ));
        }
        let currency = quotes[0].currency.clone();
        let mut points: Vec<(NaiveDate, Decimal)> = quotes
            .into_iter()
            .map(|q| {
                (
                    q.timestamp.date_naive(),
                    q.close.round_dp(DECIMAL_PRECISION),
                )
            })
            .collect();
        points.sort_by_key(|(date, _)| *date);
        points.dedup_by_key(|(date, _)| *date);
        let currency = Currency::parse(&currency)
            .unwrap_or_else(|| Currency::parse("USD").expect("valid currency"));
        Ok(from_kernel(engine::measure_price_series(
            asset_id, &currency, &points,
        )))
    }

    /// Legacy `calculate_simple_performance`: latest-row gain and weight.
    pub fn calculate_simple_performance(
        current: &DailyAccountValuation,
        _previous: Option<&DailyAccountValuation>,
        total_portfolio_value_base: Option<Decimal>,
    ) -> SimplePerformanceMetrics {
        let total_gain_loss_amount = current.total_value - current.net_contribution;
        let denominator = current.net_contribution;
        let cumulative_return_percent = if !denominator.is_zero() {
            Some((total_gain_loss_amount / denominator).round_dp(4))
        } else if total_gain_loss_amount.is_zero() {
            Some(Decimal::ZERO)
        } else {
            None
        };
        let total_value_base = current.total_value_base;
        let portfolio_weight = match total_portfolio_value_base {
            Some(total) if !total.is_zero() => Some(
                (total_value_base / total)
                    .max(Decimal::ZERO)
                    .min(Decimal::ONE)
                    .round_dp(4),
            ),
            Some(_) if total_value_base.is_zero() => Some(Decimal::ZERO),
            _ => None,
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

fn return_method(method: engine::model::ReturnMethod) -> ReturnMethod {
    match method {
        engine::model::ReturnMethod::TimeWeighted => ReturnMethod::TimeWeighted,
        engine::model::ReturnMethod::ValueReturn => ReturnMethod::ValueReturn,
        engine::model::ReturnMethod::SymbolPriceBased => ReturnMethod::SymbolPriceBased,
        engine::model::ReturnMethod::NotApplicable => ReturnMethod::NotApplicable,
    }
}

fn quality(status: engine::model::QualityStatus) -> DataQualityStatus {
    match status {
        engine::model::QualityStatus::Ok => DataQualityStatus::Ok,
        engine::model::QualityStatus::Partial => DataQualityStatus::Partial,
        engine::model::QualityStatus::NoData => DataQualityStatus::NoData,
        engine::model::QualityStatus::NotApplicable => DataQualityStatus::NotApplicable,
    }
}

fn basis(status: engine::model::BasisStatus) -> BasisStatus {
    match status {
        engine::model::BasisStatus::Complete => BasisStatus::Complete,
        engine::model::BasisStatus::PartialUnknown => BasisStatus::PartialUnknown,
        engine::model::BasisStatus::Unknown => BasisStatus::Unknown,
        engine::model::BasisStatus::NotApplicable => BasisStatus::NotApplicable,
    }
}

fn summary_basis(basis: engine::model::SummaryBasis) -> PerformanceSummaryBasis {
    match basis {
        engine::model::SummaryBasis::MarketValue => PerformanceSummaryBasis::MarketValue,
        engine::model::SummaryBasis::BookBasis => PerformanceSummaryBasis::BookBasis,
        engine::model::SummaryBasis::Mixed => PerformanceSummaryBasis::Mixed,
        engine::model::SummaryBasis::NotApplicable => PerformanceSummaryBasis::NotApplicable,
    }
}

fn summary_status(status: engine::model::SummaryStatus) -> PerformanceSummaryStatus {
    match status {
        engine::model::SummaryStatus::Complete => PerformanceSummaryStatus::Complete,
        engine::model::SummaryStatus::Unavailable => PerformanceSummaryStatus::Unavailable,
    }
}

/// The kernel result in the API contract shape.
pub fn from_kernel(result: engine::model::PerformanceResult) -> PerformanceResult {
    PerformanceResult {
        scope: PerformanceScopeDescriptor {
            id: result.scope,
            currency: result.currency.as_str().to_string(),
        },
        period: PerformancePeriod {
            start_date: result.period_start,
            end_date: result.period_end,
        },
        mode: return_method(result.method),
        returns: PerformanceReturns {
            twr: result.returns.twr,
            annualized_twr: result.returns.annualized_twr,
            irr: result.returns.irr,
            annualized_irr: result.returns.annualized_irr,
            value_return: result.returns.value_return,
            annualized_value_return: result.returns.annualized_value_return,
        },
        attribution: PerformanceAttribution {
            contributions: result.attribution.contributions,
            distributions: result.attribution.distributions,
            income: result.attribution.income,
            realized_pnl: result.attribution.realized_pnl,
            unrealized_pnl_change: result.attribution.unrealized_pnl_change,
            fx_effect: result.attribution.fx_effect,
            fees: result.attribution.fees,
            taxes: result.attribution.taxes,
            residual: result.attribution.residual,
        },
        risk: PerformanceRisk {
            volatility: result.risk.volatility,
            max_drawdown: result.risk.max_drawdown,
            peak_date: result.risk.peak_date,
            trough_date: result.risk.trough_date,
            recovery_date: result.risk.recovery_date,
            drawdown_duration_days: result.risk.drawdown_duration_days,
        },
        data_quality: PerformanceDataQuality {
            status: quality(result.data_quality.status),
            warnings: result.data_quality.warnings,
            not_applicable_reasons: result.data_quality.not_applicable_reasons,
        },
        basis_status: basis(result.basis_status),
        summary: PerformanceSummary {
            amount: result.summary.amount,
            percent: result.summary.percent,
            method: return_method(result.summary.method),
            basis: summary_basis(result.summary.basis),
            quality: quality(result.summary.quality),
            amount_status: summary_status(result.summary.amount_status),
            percent_status: summary_status(result.summary.percent_status),
            basis_status: basis(result.summary.basis_status),
            reasons: result.summary.reasons,
        },
        series: result
            .series
            .into_iter()
            .map(|p| ReturnData {
                date: p.date,
                value: p.value,
            })
            .collect(),
        is_holdings_mode: result.is_holdings_mode,
        is_mixed_tracking_mode: result.is_mixed_tracking_mode,
        holdings_flows_unavailable: result.holdings_flows_unavailable,
    }
}

#[async_trait]
impl PerformanceServiceTrait for PerformanceService {
    async fn calculate_performance_history(
        &self,
        item_type: &str,
        item_id: &str,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
        _tracking_mode: Option<TrackingMode>,
        _account_type: Option<&str>,
    ) -> Result<PerformanceResult> {
        match item_type {
            "account" => {
                self.measure(
                    MeasureTarget::Account(item_id),
                    start_date,
                    end_date,
                    PerformanceSummaryProfile::Full,
                )
                .await
            }
            "symbol" => self.symbol_performance(item_id, start_date, end_date).await,
            _ => Err(Error::Validation(ValidationError::InvalidInput(
                "Invalid item type".to_string(),
            ))),
        }
    }

    async fn calculate_performance_history_for_accounts(
        &self,
        scope_id: &str,
        account_ids: &[String],
        _base_currency: &str,
        _account_tracking_modes: &HashMap<String, TrackingMode>,
        _account_types: &HashMap<String, String>,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
    ) -> Result<PerformanceResult> {
        if account_ids.is_empty() {
            return Ok(unavailable_performance_metrics(
                scope_id,
                self.base_currency(),
                start_date,
                end_date,
                "Performance unavailable: no accounts selected.",
            ));
        }
        self.measure(
            MeasureTarget::Scope {
                id: scope_id,
                accounts: account_ids,
            },
            start_date,
            end_date,
            PerformanceSummaryProfile::Full,
        )
        .await
    }

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
                self.measure(
                    MeasureTarget::Account(item_id),
                    start_date,
                    end_date,
                    profile,
                )
                .await
            }
            _ => {
                self.calculate_performance_history(
                    item_type,
                    item_id,
                    start_date,
                    end_date,
                    tracking_mode,
                    account_type,
                )
                .await
            }
        }
    }

    async fn calculate_performance_summary_for_accounts(
        &self,
        scope_id: &str,
        account_ids: &[String],
        _base_currency: &str,
        _account_tracking_modes: &HashMap<String, TrackingMode>,
        _account_types: &HashMap<String, String>,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
        profile: PerformanceSummaryProfile,
    ) -> Result<PerformanceResult> {
        if account_ids.is_empty() {
            return Ok(unavailable_performance_metrics(
                scope_id,
                self.base_currency(),
                start_date,
                end_date,
                "Performance unavailable: no accounts selected.",
            ));
        }
        self.measure(
            MeasureTarget::Scope {
                id: scope_id,
                accounts: account_ids,
            },
            start_date,
            end_date,
            profile,
        )
        .await
    }

    fn calculate_accounts_simple_performance(
        &self,
        account_ids: &[String],
    ) -> Result<Vec<SimplePerformanceMetrics>> {
        if account_ids.is_empty() {
            return Ok(Vec::new());
        }
        let latest: HashMap<String, DailyAccountValuation> = self
            .valuations
            .get_latest_valuations(account_ids)?
            .into_iter()
            .map(|row| (row.account_id.clone(), row))
            .collect();
        let mut previous_dates: HashMap<NaiveDate, Vec<String>> = HashMap::new();
        for account_id in account_ids {
            if let Some(row) = latest.get(account_id) {
                previous_dates
                    .entry(row.valuation_date - Duration::days(1))
                    .or_default()
                    .push(account_id.clone());
            }
        }
        let mut previous: HashMap<String, DailyAccountValuation> = HashMap::new();
        for (date, ids) in previous_dates {
            match self.valuations.get_valuations_on_date(&ids, date) {
                Ok(rows) => previous.extend(rows.into_iter().map(|r| (r.account_id.clone(), r))),
                Err(error) => warn!(
                    "Failed to fetch valuation data for date {}: {}",
                    date, error
                ),
            }
        }
        let total_base: Decimal = account_ids
            .iter()
            .filter_map(|id| latest.get(id))
            .map(|row| row.total_value_base)
            .sum();
        let requested: HashSet<&str> = account_ids.iter().map(String::as_str).collect();
        let mut results = Vec::with_capacity(requested.len());
        for account_id in account_ids {
            match latest.get(account_id) {
                Some(current) => results.push(Self::calculate_simple_performance(
                    current,
                    previous.get(account_id),
                    Some(total_base),
                )),
                None => debug!(
                    "No DailyAccountValuation found for account '{}' when fetching latest",
                    account_id
                ),
            }
        }
        Ok(results)
    }
}
