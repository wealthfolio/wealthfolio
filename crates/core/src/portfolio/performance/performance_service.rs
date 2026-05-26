use crate::accounts::TrackingMode;
use crate::constants::DECIMAL_PRECISION;
use crate::errors::{self, Result, ValidationError};
use crate::performance::ReturnData;
use crate::quotes::QuoteServiceTrait;
use crate::utils::time_utils::{parse_user_timezone_or_default, user_today};
use crate::valuation::ValuationServiceTrait;

use async_trait::async_trait;
use chrono::{Duration, NaiveDate};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use log::{debug, warn};
use rust_decimal::Decimal;
use rust_decimal::MathematicalOps;
use rust_decimal_macros::dec;

use super::{PerformanceMetrics, ReturnMethod, SimplePerformanceMetrics};
use crate::portfolio::valuation::DailyAccountValuation;

#[async_trait]
pub trait PerformanceServiceTrait: Send + Sync {
    async fn calculate_performance_history(
        &self,
        item_type: &str,
        item_id: &str,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
        tracking_mode: Option<TrackingMode>,
    ) -> Result<PerformanceMetrics>;

    async fn calculate_performance_history_for_accounts(
        &self,
        scope_id: &str,
        account_ids: &[String],
        base_currency: &str,
        account_tracking_modes: &HashMap<String, TrackingMode>,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
    ) -> Result<PerformanceMetrics>;

    async fn calculate_performance_summary(
        &self,
        item_type: &str,
        item_id: &str,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
        tracking_mode: Option<TrackingMode>,
    ) -> Result<PerformanceMetrics>;

    async fn calculate_performance_summary_for_accounts(
        &self,
        scope_id: &str,
        account_ids: &[String],
        base_currency: &str,
        account_tracking_modes: &HashMap<String, TrackingMode>,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
    ) -> Result<PerformanceMetrics>;

    /// Calculates simple performance metrics (daily returns, cumulative returns, portfolio weights) for multiple accounts.
    /// This method efficiently fetches the latest and previous day's valuations in bulk to minimize database queries.
    /// Can be used for a single account by passing a slice with one ID.
    fn calculate_accounts_simple_performance(
        &self,
        account_ids: &[String],
    ) -> Result<Vec<SimplePerformanceMetrics>>;
}

pub struct PerformanceService {
    valuation_service: Arc<dyn ValuationServiceTrait + Send + Sync>,
    quote_service: Arc<dyn QuoteServiceTrait + Send + Sync>,
    timezone: Arc<RwLock<String>>,
}

const TRADING_DAYS_PER_YEAR: u32 = 252;
const DAYS_PER_YEAR_DECIMAL: Decimal = dec!(365.25);
const SQRT_TRADING_DAYS_APPROX: Decimal = dec!(15.874507866); // sqrt(252)

/// One day's return sample emitted by `compute_compounded_daily_returns`.
///
/// `twr` is that day's time-weighted return (e.g. `0.01` = +1%).
/// `cumulative_twr_to_date` is the compounded TWR from the first day of the
/// series up to and including this day.
///
/// Daily Modified Dietz is computed internally by
/// `compute_compounded_daily_returns` but not surfaced here — no caller
/// currently needs a per-day series; the final cumulative Modified Dietz is
/// returned by the function itself.
#[derive(Clone, Copy, Debug)]
struct DailyReturnSample {
    twr: Decimal,
    cumulative_twr_to_date: Decimal,
    excluded_from_compounding: bool,
}

struct ScopedPerformanceRequest<'a> {
    scope_id: &'a str,
    account_ids: &'a [String],
    base_currency: &'a str,
    account_tracking_modes: &'a HashMap<String, TrackingMode>,
    start_date: Option<NaiveDate>,
    end_date: Option<NaiveDate>,
    include_returns_series: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ScopedTrackingComposition {
    TransactionsOnly,
    HoldingsOnly,
    Mixed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ExternalFlowBasis {
    AccountCurrency,
    BaseCurrency,
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
        }
    }

    fn today_in_user_timezone(&self) -> NaiveDate {
        let tz = parse_user_timezone_or_default(&self.timezone.read().unwrap());
        user_today(tz)
    }

    // =========================================================================
    // Shared performance math
    //
    // These helpers are the single source of truth for the formulas used by
    // both the "full" and "summary" account-performance paths. Having two
    // slightly-diverging copies of this math was the root cause of the
    // dashboard-vs-account-page percentage mismatch — keep them consolidated.
    // =========================================================================

    /// Iterates consecutive valuation pairs and emits per-day TWR/Modified
    /// Dietz samples (and their compounded totals) to `visit`. The callback is
    /// the only thing that differs between callers: the full path records a
    /// `ReturnData` per day and collects daily returns for risk metrics; the
    /// summary path ignores the samples entirely.
    ///
    /// Returns `(cumulative_twr, cumulative_modified_dietz, warnings)` as
    /// returns (not factors): `0.05` == +5% for the whole series.
    ///
    /// # Errors
    /// Returns [`ValidationError::InvalidInput`] if any day's `total_value` is
    /// negative. A negative portfolio value almost always indicates missing
    /// activity data (e.g. a buy without a funding deposit), which makes every
    /// downstream percentage meaningless — better to surface that to the user
    /// than to emit an absurd number.
    fn compute_compounded_daily_returns<F>(
        history: &[DailyAccountValuation],
        flow_basis: ExternalFlowBasis,
        mut visit: F,
    ) -> Result<(Decimal, Decimal, Vec<String>)>
    where
        F: FnMut(&DailyAccountValuation, &DailyAccountValuation, &DailyReturnSample),
    {
        let one = Decimal::ONE;
        let two = dec!(2.0);
        let mut cumulative_twr_factor = one;
        let mut cumulative_modified_dietz_factor = one;
        let mut warnings = Vec::new();

        for window in history.windows(2) {
            let prev_point = &window[0];
            let curr_point = &window[1];

            if prev_point.total_value.is_sign_negative()
                || curr_point.total_value.is_sign_negative()
            {
                return Err(errors::Error::Validation(ValidationError::InvalidInput(
                    "Account has negative portfolio value in its history. This may be caused by missing buy activities. Please review your transactions on the Activities page.".to_string(),
                )));
            }

            let (inflow, outflow) = Self::daily_external_flows(prev_point, curr_point, flow_basis);

            let twr_denominator = prev_point.total_value + inflow;
            let modified_dietz_denominator = prev_point.total_value + ((inflow - outflow) / two);
            let excluded_from_compounding =
                twr_denominator <= Decimal::ZERO || modified_dietz_denominator <= Decimal::ZERO;

            let (twr, modified_dietz) = if excluded_from_compounding {
                let warning = format!(
                    "Skipping return compounding for {}: non-positive denominator (twr={}, modified_dietz={})",
                    curr_point.valuation_date,
                    twr_denominator,
                    modified_dietz_denominator
                );
                warn!("{}", warning);
                warnings.push(warning);
                (Decimal::ZERO, Decimal::ZERO)
            } else {
                let numerator = curr_point.total_value + outflow - prev_point.total_value - inflow;
                (
                    numerator / twr_denominator,
                    numerator / modified_dietz_denominator,
                )
            };

            if !excluded_from_compounding {
                cumulative_twr_factor *= one + twr;
                cumulative_modified_dietz_factor *= one + modified_dietz;
            }

            let sample = DailyReturnSample {
                twr,
                cumulative_twr_to_date: cumulative_twr_factor - one,
                excluded_from_compounding,
            };
            visit(prev_point, curr_point, &sample);
        }

        Ok((
            cumulative_twr_factor - one,
            cumulative_modified_dietz_factor - one,
            warnings,
        ))
    }

    fn daily_external_flows(
        prev_point: &DailyAccountValuation,
        curr_point: &DailyAccountValuation,
        flow_basis: ExternalFlowBasis,
    ) -> (Decimal, Decimal) {
        let cash_flow = match flow_basis {
            ExternalFlowBasis::AccountCurrency => {
                curr_point.net_contribution - prev_point.net_contribution
            }
            ExternalFlowBasis::BaseCurrency => {
                let explicit_base_flows = !curr_point.external_inflow_base.is_zero()
                    || !curr_point.external_outflow_base.is_zero();

                if explicit_base_flows {
                    return (
                        curr_point.external_inflow_base,
                        curr_point.external_outflow_base,
                    );
                }

                curr_point.net_contribution_base - prev_point.net_contribution_base
            }
        };
        if cash_flow.is_sign_negative() {
            (Decimal::ZERO, -cash_flow)
        } else {
            (cash_flow, Decimal::ZERO)
        }
    }

    /// Simple (start-to-end) total return. Returns zero when the starting
    /// portfolio value is non-positive — ratio is undefined there and the
    /// signed-division result would be misleading, so we surface zero and let
    /// the caller decide whether to display the percentage at all.
    fn compute_simple_total_return(start_value: Decimal, gain_loss_amount: Decimal) -> Decimal {
        if start_value <= Decimal::ZERO {
            Decimal::ZERO
        } else {
            gain_loss_amount / start_value
        }
    }

    /// HOLDINGS-mode period gain and return.
    ///
    /// HOLDINGS mode doesn't track cash flows at the transaction level, so
    /// TWR/MWR aren't meaningful — we measure unrealized P&L growth instead.
    ///
    /// * `is_all_time` — when `true`, divides by ending `cost_basis` (the full
    ///   amount invested). When `false`, divides by `investment_market_value`
    ///   at the period start. Zero-guard returns 0% in either case.
    fn compute_holdings_period_return(
        start_point: &DailyAccountValuation,
        end_point: &DailyAccountValuation,
        is_all_time: bool,
    ) -> (Decimal, Decimal) {
        let start_unrealized_pnl = start_point.investment_market_value - start_point.cost_basis;
        let end_unrealized_pnl = end_point.investment_market_value - end_point.cost_basis;
        let period_gain = end_unrealized_pnl - start_unrealized_pnl;

        let period_return = if is_all_time {
            if end_point.cost_basis.is_zero() {
                Decimal::ZERO
            } else {
                end_unrealized_pnl / end_point.cost_basis
            }
        } else if start_point.investment_market_value.is_zero() {
            Decimal::ZERO
        } else {
            period_gain / start_point.investment_market_value
        };

        (period_gain, period_return)
    }

    /// Full account performance calculation including per-day `returns[]`,
    /// volatility, and max-drawdown. Used by the account-detail page.
    async fn calculate_account_performance(
        &self,
        account_id: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
        tracking_mode: Option<TrackingMode>,
    ) -> Result<PerformanceMetrics> {
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
            warn!("Performance calculation for account '{}': Not enough valuation data ({} points). Returning empty response.", account_id, full_history.len());
            return Ok(PerformanceService::empty_response(account_id));
        }

        Self::compute_account_performance(&full_history, tracking_mode, start_date_opt, true).map(
            |mut metrics| {
                metrics.id = account_id.to_string();
                metrics
            },
        )
    }

    /// Summary account performance calculation (no `returns[]`, no risk
    /// metrics). Used by the dashboard card. Shares the same TWR/MWR chain as
    /// the full path so percentages match the account-detail page.
    async fn calculate_account_performance_summary(
        &self,
        account_id: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
        tracking_mode: Option<TrackingMode>,
    ) -> Result<PerformanceMetrics> {
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
                "Account '{}': Not enough history data ({} points). Cannot calculate performance.",
                account_id,
                full_history.len()
            );
            return Err(errors::Error::Calculation(
                errors::CalculatorError::Calculation(format!(
                    "Account '{}': Not enough history data ({} points).",
                    account_id,
                    full_history.len()
                )),
            ));
        }

        Self::compute_account_performance(&full_history, tracking_mode, start_date_opt, false).map(
            |mut metrics| {
                metrics.id = account_id.to_string();
                metrics
            },
        )
    }

    async fn calculate_scoped_performance(
        &self,
        request: ScopedPerformanceRequest<'_>,
    ) -> Result<PerformanceMetrics> {
        let ScopedPerformanceRequest {
            scope_id,
            account_ids,
            base_currency,
            account_tracking_modes,
            start_date: start_date_opt,
            end_date: end_date_opt,
            include_returns_series,
        } = request;

        if let (Some(start), Some(end)) = (start_date_opt, end_date_opt) {
            if start > end {
                return Err(errors::Error::Validation(ValidationError::InvalidInput(
                    "Start date must be before end date".to_string(),
                )));
            }
        }

        if account_ids.is_empty() {
            return Ok(PerformanceService::empty_response(scope_id));
        }
        let scoped_tracking_composition =
            Self::scoped_tracking_composition(account_ids, account_tracking_modes);

        let full_history = self
            .valuation_service
            .get_historical_valuations_for_accounts(
                scope_id,
                account_ids,
                base_currency,
                start_date_opt,
                end_date_opt,
            )?;

        if full_history.len() < 2 {
            return Ok(PerformanceService::empty_response(scope_id));
        }

        let mut metrics = match scoped_tracking_composition {
            ScopedTrackingComposition::TransactionsOnly => {
                Self::compute_scoped_account_performance(
                    &full_history,
                    Some(TrackingMode::Transactions),
                    start_date_opt,
                    include_returns_series,
                )?
            }
            ScopedTrackingComposition::HoldingsOnly => Self::compute_scoped_account_performance(
                &full_history,
                Some(TrackingMode::Holdings),
                start_date_opt,
                include_returns_series,
            )?,
            ScopedTrackingComposition::Mixed => {
                Self::compute_mixed_scope_performance(&full_history, include_returns_series)?
            }
        };

        metrics.id = scope_id.to_string();
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
    /// pre-fetched valuation history and produces the same `PerformanceMetrics`
    /// both call sites need.
    ///
    /// * `include_returns_series` — when `true`, populates `returns[]` with a
    ///   per-day cumulative TWR and computes volatility/max-drawdown. The full
    ///   path sets this; the summary doesn't to save allocation on dashboards
    ///   with many accounts.
    ///
    /// `id` is left empty — callers set it after.
    ///
    /// # Precondition
    /// `full_history.len() >= 2`. Callers check this first so they can respond
    /// differently to insufficient history (empty response vs. error).
    fn compute_account_performance(
        full_history: &[DailyAccountValuation],
        tracking_mode: Option<TrackingMode>,
        start_date_opt: Option<NaiveDate>,
        include_returns_series: bool,
    ) -> Result<PerformanceMetrics> {
        Self::compute_account_performance_with_flow_basis(
            full_history,
            tracking_mode,
            start_date_opt,
            include_returns_series,
            ExternalFlowBasis::AccountCurrency,
        )
    }

    fn compute_scoped_account_performance(
        full_history: &[DailyAccountValuation],
        tracking_mode: Option<TrackingMode>,
        start_date_opt: Option<NaiveDate>,
        include_returns_series: bool,
    ) -> Result<PerformanceMetrics> {
        Self::compute_account_performance_with_flow_basis(
            full_history,
            tracking_mode,
            start_date_opt,
            include_returns_series,
            ExternalFlowBasis::BaseCurrency,
        )
    }

    fn compute_account_performance_with_flow_basis(
        full_history: &[DailyAccountValuation],
        tracking_mode: Option<TrackingMode>,
        start_date_opt: Option<NaiveDate>,
        include_returns_series: bool,
        flow_basis: ExternalFlowBasis,
    ) -> Result<PerformanceMetrics> {
        debug_assert!(full_history.len() >= 2);

        let start_point = full_history.first().unwrap();
        let end_point = full_history.last().unwrap();
        let actual_start_date = start_point.valuation_date;
        let actual_end_date = end_point.valuation_date;
        let currency = start_point.account_currency.clone();

        let is_holdings_mode = matches!(tracking_mode, Some(TrackingMode::Holdings));

        // Set up per-day collectors. When we're not building the series, these
        // stay empty and the closure below skips the pushes entirely.
        let capacity = full_history.len();
        let mut returns: Vec<ReturnData> = Vec::new();
        let mut daily_returns_for_risk: Vec<Decimal> = Vec::new();
        if include_returns_series {
            returns.reserve(capacity);
            daily_returns_for_risk.reserve(capacity - 1);
            returns.push(ReturnData {
                date: actual_start_date,
                value: Decimal::ZERO,
            });
        }

        // Shared TWR/Modified Dietz chain. The closure decides what to record per day.
        let (cumulative_twr, cumulative_modified_dietz, warnings) =
            Self::compute_compounded_daily_returns(
                full_history,
                flow_basis,
                |prev_point, curr_point, sample| {
                    if !include_returns_series {
                        return;
                    }

                    // Risk metrics (volatility, max drawdown) use filtered daily
                    // TWR returns. TRANSACTIONS mode: TWR already nets out cash
                    // flows, use all days. HOLDINGS mode: drop days where the
                    // holdings set changed, since we can't separate market moves
                    // from position-change-driven value shifts.
                    let should_exclude_from_risk = if is_holdings_mode {
                        let cost_basis_changed = prev_point.cost_basis != curr_point.cost_basis;
                        let contribution_changed = prev_point.cost_basis.is_zero()
                            && prev_point.net_contribution != curr_point.net_contribution;
                        cost_basis_changed || contribution_changed
                    } else {
                        false
                    };
                    if !sample.excluded_from_compounding && !should_exclude_from_risk {
                        daily_returns_for_risk.push(sample.twr);
                    }

                    returns.push(ReturnData {
                        date: curr_point.valuation_date,
                        value: sample.cumulative_twr_to_date.round_dp(DECIMAL_PRECISION),
                    });
                },
            )?;

        let annualized_twr =
            Self::calculate_annualized_return(actual_start_date, actual_end_date, cumulative_twr);
        let annualized_modified_dietz = Self::calculate_annualized_return(
            actual_start_date,
            actual_end_date,
            cumulative_modified_dietz,
        );

        // Simple (start-to-end) total return. Always populated in the response
        // for consumers that want the unweighted figure (e.g. the account page
        // uses this for HOLDINGS mode and for the ALL-time interval).
        let start_value = start_point.total_value;
        let net_cash_flow = end_point.net_contribution - start_point.net_contribution;
        let gain_loss_amount = end_point.total_value - start_value - net_cash_flow;
        let simple_total_return = Self::compute_simple_total_return(start_value, gain_loss_amount);
        let annualized_simple_return = Self::calculate_annualized_return(
            actual_start_date,
            actual_end_date,
            simple_total_return,
        );

        // Risk metrics only make sense when we built the per-day series.
        let (volatility, max_drawdown) = if include_returns_series {
            (
                Self::calculate_volatility(&daily_returns_for_risk),
                Self::calculate_max_drawdown(&daily_returns_for_risk),
            )
        } else {
            (Decimal::ZERO, Decimal::ZERO)
        };

        // `period_return` is the headline number displayed on the card. Mode
        // matters:
        //
        // * HOLDINGS: unrealized-P&L-based, since we don't see cash flows at
        //   transaction granularity.
        // * TRANSACTIONS (full path / account page): Modified Dietz matches the dashboard
        //   and handles cash flows per-day without blow-ups when the initial
        //   value is small.
        // * TRANSACTIONS (summary): Modified Dietz for the same reason — prior use of
        //   `gain / start_value` was the source of the dashboard-side bug.
        let (period_gain, period_return) = if is_holdings_mode {
            let (gain, ret) = Self::compute_holdings_period_return(
                start_point,
                end_point,
                start_date_opt.is_none(),
            );
            (gain, Some(ret))
        } else {
            (gain_loss_amount, Some(cumulative_modified_dietz))
        };

        let wrap_non_holdings = |value: Decimal| {
            if is_holdings_mode {
                None
            } else {
                Some(value.round_dp(DECIMAL_PRECISION))
            }
        };

        Ok(PerformanceMetrics {
            id: String::new(),
            returns,
            period_start_date: Some(actual_start_date),
            period_end_date: Some(actual_end_date),
            currency,
            period_gain: period_gain.round_dp(DECIMAL_PRECISION),
            period_return: period_return.map(|r| r.round_dp(DECIMAL_PRECISION)),
            cumulative_twr: wrap_non_holdings(cumulative_twr),
            gain_loss_amount: Some(gain_loss_amount.round_dp(DECIMAL_PRECISION)),
            annualized_twr: wrap_non_holdings(annualized_twr),
            simple_return: simple_total_return.round_dp(DECIMAL_PRECISION),
            annualized_simple_return: annualized_simple_return.round_dp(DECIMAL_PRECISION),
            cumulative_modified_dietz: wrap_non_holdings(cumulative_modified_dietz),
            annualized_modified_dietz: wrap_non_holdings(annualized_modified_dietz),
            cumulative_mwr: wrap_non_holdings(cumulative_modified_dietz),
            annualized_mwr: wrap_non_holdings(annualized_modified_dietz),
            volatility: volatility.round_dp(DECIMAL_PRECISION),
            max_drawdown: max_drawdown.round_dp(DECIMAL_PRECISION),
            is_holdings_mode,
            return_method: if is_holdings_mode {
                ReturnMethod::SimpleReturn
            } else {
                ReturnMethod::ModifiedDietz
            },
            is_mixed_tracking_mode: false,
            warnings,
        })
    }

    fn compute_mixed_scope_performance(
        full_history: &[DailyAccountValuation],
        include_returns_series: bool,
    ) -> Result<PerformanceMetrics> {
        debug_assert!(full_history.len() >= 2);

        let start_point = full_history.first().unwrap();
        let end_point = full_history.last().unwrap();
        let actual_start_date = start_point.valuation_date;
        let actual_end_date = end_point.valuation_date;
        let currency = start_point.base_currency.clone();
        let start_value = start_point.total_value;
        let net_cash_flow: Decimal = full_history
            .iter()
            .skip(1)
            .map(|point| point.external_inflow_base - point.external_outflow_base)
            .sum();
        let gain_loss_amount = end_point.total_value - start_value - net_cash_flow;
        let simple_total_return = Self::compute_simple_total_return(start_value, gain_loss_amount);
        let annualized_simple_return = Self::calculate_annualized_return(
            actual_start_date,
            actual_end_date,
            simple_total_return,
        );
        if full_history
            .iter()
            .any(|point| point.total_value.is_sign_negative())
        {
            return Err(errors::Error::Validation(ValidationError::InvalidInput(
                "Account scope has negative portfolio value in its history. Please review the underlying transactions and holdings.".to_string(),
            )));
        }

        let mut returns = Vec::new();
        let mut daily_returns_for_risk = Vec::new();

        if include_returns_series {
            returns.reserve(full_history.len());
            daily_returns_for_risk.reserve(full_history.len().saturating_sub(1));
            returns.push(ReturnData {
                date: actual_start_date,
                value: Decimal::ZERO,
            });

            let mut cumulative_external_flow = Decimal::ZERO;
            for window in full_history.windows(2) {
                let prev_point = &window[0];
                let curr_point = &window[1];
                if prev_point.total_value.is_sign_negative()
                    || curr_point.total_value.is_sign_negative()
                {
                    return Err(errors::Error::Validation(ValidationError::InvalidInput(
                        "Account scope has negative portfolio value in its history. Please review the underlying transactions and holdings.".to_string(),
                    )));
                }

                let daily_external_flow =
                    curr_point.external_inflow_base - curr_point.external_outflow_base;
                cumulative_external_flow += daily_external_flow;
                let cumulative_gain =
                    curr_point.total_value - start_value - cumulative_external_flow;
                let cumulative_return =
                    Self::compute_simple_total_return(start_value, cumulative_gain);

                let day_gain = curr_point.total_value + curr_point.external_outflow_base
                    - prev_point.total_value
                    - curr_point.external_inflow_base;
                if prev_point.total_value > Decimal::ZERO {
                    daily_returns_for_risk.push(day_gain / prev_point.total_value);
                }

                returns.push(ReturnData {
                    date: curr_point.valuation_date,
                    value: cumulative_return.round_dp(DECIMAL_PRECISION),
                });
            }
        }

        let (volatility, max_drawdown) = if include_returns_series {
            (
                Self::calculate_volatility(&daily_returns_for_risk),
                Self::calculate_max_drawdown(&daily_returns_for_risk),
            )
        } else {
            (Decimal::ZERO, Decimal::ZERO)
        };

        Ok(PerformanceMetrics {
            id: String::new(),
            returns,
            period_start_date: Some(actual_start_date),
            period_end_date: Some(actual_end_date),
            currency,
            period_gain: gain_loss_amount.round_dp(DECIMAL_PRECISION),
            period_return: Some(simple_total_return.round_dp(DECIMAL_PRECISION)),
            cumulative_twr: None,
            gain_loss_amount: Some(gain_loss_amount.round_dp(DECIMAL_PRECISION)),
            annualized_twr: None,
            simple_return: simple_total_return.round_dp(DECIMAL_PRECISION),
            annualized_simple_return: annualized_simple_return.round_dp(DECIMAL_PRECISION),
            cumulative_modified_dietz: None,
            annualized_modified_dietz: None,
            cumulative_mwr: None,
            annualized_mwr: None,
            volatility: volatility.round_dp(DECIMAL_PRECISION),
            max_drawdown: max_drawdown.round_dp(DECIMAL_PRECISION),
            is_holdings_mode: false,
            return_method: ReturnMethod::SimpleReturn,
            is_mixed_tracking_mode: true,
            warnings: vec![
                "This scope mixes transaction-mode and holdings-mode accounts, so TWR and Modified Dietz are unavailable. The return is a value-complete simple return over the selected scope.".to_string(),
            ],
        })
    }

    /// Internal function for calculating symbol/benchmark performance (Full)
    /// asset_id can be a canonical ID like "SEC:^GSPC:INDEX" or a raw symbol
    async fn calculate_symbol_performance(
        &self,
        asset_id: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> Result<PerformanceMetrics> {
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
            return Ok(PerformanceService::empty_response(asset_id));
        }

        let actual_start_date = quote_history.first().unwrap().timestamp.date_naive();
        let actual_end_date = quote_history.last().unwrap().timestamp.date_naive();
        let currency = quote_history.first().unwrap().currency.clone();

        let quote_map: HashMap<NaiveDate, Decimal> = quote_history
            .into_iter()
            .map(|quote| {
                (
                    quote.timestamp.date_naive(),
                    quote.close.round_dp(DECIMAL_PRECISION),
                )
            })
            .collect();

        let mut current_loop_date = actual_start_date;
        let mut prev_price = Decimal::ZERO;
        let mut found_start_price = false;
        while current_loop_date <= actual_end_date {
            if let Some(price) = quote_map.get(&current_loop_date).copied() {
                prev_price = price;
                found_start_price = true;
                break;
            }
            if let Some(next_date) = current_loop_date.succ_opt() {
                current_loop_date = next_date;
            } else {
                break;
            }
        }

        if !found_start_price {
            warn!("Asset '{}': Could not find starting price point within quote map. Returning empty response.", asset_id);
            return Ok(PerformanceService::empty_response(asset_id));
        }

        let capacity = (actual_end_date - actual_start_date).num_days().max(0) as usize + 1;
        let mut returns = Vec::with_capacity(capacity);
        let mut daily_returns = Vec::with_capacity(capacity);
        let mut cumulative_value = Decimal::ONE;
        let mut current_date = actual_start_date;
        let mut last_known_price = prev_price;

        while current_date <= actual_end_date {
            let current_price = match quote_map.get(&current_date) {
                Some(price) => {
                    last_known_price = *price;
                    *price
                }
                None => last_known_price,
            };

            let daily_return = if prev_price.is_zero() {
                Decimal::ZERO
            } else {
                (current_price / prev_price) - Decimal::ONE
            };
            daily_returns.push(daily_return);
            cumulative_value *= Decimal::ONE + daily_return;
            let cumulative_return_to_date = cumulative_value - Decimal::ONE;

            returns.push(ReturnData {
                date: current_date,
                value: cumulative_return_to_date.round_dp(DECIMAL_PRECISION),
            });

            if let Some(price) = quote_map.get(&current_date) {
                prev_price = *price;
            }
            if let Some(next_date) = current_date.succ_opt() {
                current_date = next_date;
            } else {
                break;
            }
        }

        if returns.is_empty() {
            return Ok(PerformanceService::empty_response(asset_id));
        }

        let total_return = returns.last().map_or(Decimal::ZERO, |r| r.value);
        let annualized_return =
            Self::calculate_annualized_return(actual_start_date, actual_end_date, total_return);
        let volatility = Self::calculate_volatility(&daily_returns);
        let max_drawdown = Self::calculate_max_drawdown(&daily_returns);

        let result = PerformanceMetrics {
            id: asset_id.to_string(),
            returns,
            period_start_date: Some(actual_start_date),
            period_end_date: Some(actual_end_date),
            currency,
            period_gain: Decimal::ZERO, // Not applicable for symbol performance
            period_return: Some(total_return.round_dp(DECIMAL_PRECISION)),
            cumulative_twr: Some(total_return.round_dp(DECIMAL_PRECISION)),
            gain_loss_amount: None,
            annualized_twr: Some(annualized_return.round_dp(DECIMAL_PRECISION)),
            simple_return: Decimal::ZERO,
            annualized_simple_return: Decimal::ZERO,
            cumulative_modified_dietz: Some(Decimal::ZERO),
            annualized_modified_dietz: Some(Decimal::ZERO),
            cumulative_mwr: Some(Decimal::ZERO),
            annualized_mwr: Some(Decimal::ZERO),
            volatility: volatility.round_dp(DECIMAL_PRECISION),
            max_drawdown: max_drawdown.round_dp(DECIMAL_PRECISION),
            is_holdings_mode: false,
            return_method: ReturnMethod::SymbolPriceBased,
            is_mixed_tracking_mode: false,
            warnings: Vec::new(),
        };

        Ok(result)
    }

    fn empty_response(id: &str) -> PerformanceMetrics {
        PerformanceMetrics {
            id: id.to_string(),
            returns: Vec::new(),
            period_start_date: None,
            period_end_date: None,
            currency: "".to_string(),
            period_gain: Decimal::ZERO,
            period_return: Some(Decimal::ZERO),
            cumulative_twr: Some(Decimal::ZERO),
            gain_loss_amount: None,
            annualized_twr: Some(Decimal::ZERO),
            simple_return: Decimal::ZERO,
            annualized_simple_return: Decimal::ZERO,
            cumulative_modified_dietz: Some(Decimal::ZERO),
            annualized_modified_dietz: Some(Decimal::ZERO),
            cumulative_mwr: Some(Decimal::ZERO),
            annualized_mwr: Some(Decimal::ZERO),
            volatility: Decimal::ZERO,
            max_drawdown: Decimal::ZERO,
            is_holdings_mode: false,
            return_method: ReturnMethod::NotApplicable,
            is_mixed_tracking_mode: false,
            warnings: Vec::new(),
        }
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

        if years < Decimal::ONE {
            return total_return;
        }

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

    fn calculate_volatility(daily_returns: &[Decimal]) -> Decimal {
        if daily_returns.len() < 2 {
            return Decimal::ZERO;
        }

        let count = Decimal::from(daily_returns.len());
        let sum: Decimal = daily_returns.iter().sum();
        let mean = sum / count;

        let sum_squared_diff: Decimal = daily_returns
            .iter()
            .map(|&r| {
                let diff = r - mean;
                diff * diff
            })
            .sum();

        let variance = sum_squared_diff / (count - Decimal::ONE);
        if variance.is_sign_negative() {
            return Decimal::ZERO;
        }

        let daily_volatility = variance.sqrt().unwrap_or(Decimal::ZERO);

        let annualization_factor = Decimal::from(TRADING_DAYS_PER_YEAR)
            .sqrt()
            .unwrap_or(SQRT_TRADING_DAYS_APPROX);

        daily_volatility * annualization_factor
    }

    fn calculate_max_drawdown(daily_returns: &[Decimal]) -> Decimal {
        if daily_returns.is_empty() {
            return Decimal::ZERO;
        }

        let mut cumulative_value = Decimal::ONE;
        let mut peak_value = Decimal::ONE;
        let mut max_drawdown = Decimal::ZERO;

        for &daily_return in daily_returns {
            cumulative_value *= Decimal::ONE + daily_return;
            peak_value = peak_value.max(cumulative_value);
            if peak_value.is_zero() {
                max_drawdown = max_drawdown.max(Decimal::ONE);
            } else {
                let drawdown = (peak_value - cumulative_value) / peak_value;
                max_drawdown = max_drawdown.max(drawdown);
            }
        }

        max_drawdown.max(Decimal::ZERO)
    }

    pub fn calculate_simple_performance(
        current: &DailyAccountValuation,
        previous: Option<&DailyAccountValuation>,
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

        let (day_gain_loss_amount, day_return_percent_mod_dietz) = if let Some(prev) = previous {
            let start_value = prev.total_value;
            let end_value = current.total_value;
            let cash_flow_day = current.net_contribution - prev.net_contribution;
            let gain_day = end_value - start_value - cash_flow_day;

            let denominator_mod_dietz = start_value + (Decimal::new(5, 1) * cash_flow_day);

            let percent_day_mod_dietz = if !denominator_mod_dietz.is_zero() {
                Some((gain_day / denominator_mod_dietz).round_dp(4))
            } else if gain_day.is_zero() {
                Some(Decimal::ZERO)
            } else {
                None
            };
            (Some(gain_day.round_dp(2)), percent_day_mod_dietz)
        } else {
            (None, None)
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
            day_gain_loss_amount,
            day_return_percent_mod_dietz,
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
    ) -> Result<PerformanceMetrics> {
        match item_type {
            "account" => {
                self.calculate_account_performance(item_id, start_date, end_date, tracking_mode)
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
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
    ) -> Result<PerformanceMetrics> {
        self.calculate_scoped_performance(ScopedPerformanceRequest {
            scope_id,
            account_ids,
            base_currency,
            account_tracking_modes,
            start_date,
            end_date,
            include_returns_series: true,
        })
        .await
    }

    /// Calculates summary performance metrics only (no returns array, vol, maxDD)
    /// Currently only implemented for item_type = "account"
    async fn calculate_performance_summary(
        &self,
        item_type: &str,
        item_id: &str,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
        tracking_mode: Option<TrackingMode>,
    ) -> Result<PerformanceMetrics> {
        match item_type {
            "account" => {
                self.calculate_account_performance_summary(
                    item_id,
                    start_date,
                    end_date,
                    tracking_mode,
                )
                .await
            }
            "symbol" => {
                warn!("Performance summary calculation is not supported for symbols. Returning empty response.");
                Ok(PerformanceService::empty_response(item_id))
            }
            _ => Err(errors::Error::Validation(ValidationError::InvalidInput(
                "Invalid item type".to_string(),
            ))),
        }
    }

    async fn calculate_performance_summary_for_accounts(
        &self,
        scope_id: &str,
        account_ids: &[String],
        base_currency: &str,
        account_tracking_modes: &HashMap<String, TrackingMode>,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
    ) -> Result<PerformanceMetrics> {
        self.calculate_scoped_performance(ScopedPerformanceRequest {
            scope_id,
            account_ids,
            base_currency,
            account_tracking_modes,
            start_date,
            end_date,
            include_returns_series: false,
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
    use chrono::{DateTime, Utc};

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
            net_contribution,
            cash_balance_base: total_value - investment_market_value,
            investment_market_value_base: investment_market_value,
            total_value_base: total_value,
            cost_basis_base: cost_basis,
            net_contribution_base: net_contribution,
            external_inflow_base: Decimal::ZERO,
            external_outflow_base: Decimal::ZERO,
            performance_eligible_value_base: total_value,
            calculated_at: DateTime::<Utc>::from_timestamp(0, 0).unwrap(),
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
        history.push(valuation(
            "2026-03-15",
            dec!(2100),
            dec!(2100),
            dec!(1820),
            dec!(1820),
        ));

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

    /// Regression test for the reporter's bug. Pre-fix, `period_return` was
    /// `gain / start_value` = -10.84/100 = -10.84%. Post-fix, it's daily-linked
    /// MWR — should end up near zero, dominated by the synthetic ~1.1% AAPL
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

        let period_return = result.period_return.expect("period_return should be Some");

        // Old formula: -0.1084. New: small (market-drift-dominated). Bounds are
        // wide — the fixture uses synthetic linear drift and exact precision
        // isn't what we're testing; we're testing that the percentage is sane.
        assert!(
            period_return > dec!(-0.05),
            "period_return = {} should be > -5% (was -10.84% with the old formula)",
            period_return
        );
        assert!(
            period_return < dec!(0.01),
            "period_return = {} should be < 1% (asset drifted down slightly)",
            period_return
        );

        // $ gain is unchanged — end - start - cash_flow = 2089.16 - 100 - 2000.
        assert_eq!(result.period_gain, dec!(-10.84));
        // The legacy `simple_return` field preserves the start-based ratio so
        // any frontend reading it explicitly still gets consistent semantics.
        assert_eq!(result.simple_return.round_dp(4), dec!(-0.1084));
        // TWR and MWR are now populated (were zero placeholders in the summary
        // path before the refactor).
        assert!(result.cumulative_twr.is_some());
        assert!(result.cumulative_mwr.is_some());
    }

    /// Invariant: summary and full paths must agree on `period_return`. This is
    /// the core guarantee the refactor is meant to enforce — the dashboard card
    /// and account-detail page showing different percentages for the same
    /// account / range was the original user complaint.
    #[test]
    fn perf_full_and_summary_paths_agree_on_period_return() {
        let history = fixture_small_seed_then_large_deposit();
        let start = Some(date("2026-01-01"));

        let full = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Transactions),
            start,
            true,
        )
        .expect("full should compute");

        let summary = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Transactions),
            start,
            false,
        )
        .expect("summary should compute");

        // Headline percentage must match exactly — that's the user-visible
        // invariant. Everything else (returns series, risk metrics) is summary
        // vs full differentiation.
        assert_eq!(full.period_return, summary.period_return);
        assert_eq!(full.cumulative_mwr, summary.cumulative_mwr);
        assert_eq!(full.return_method, ReturnMethod::ModifiedDietz);
        assert_eq!(summary.return_method, ReturnMethod::ModifiedDietz);
        assert_eq!(full.cumulative_twr, summary.cumulative_twr);
        assert_eq!(full.period_gain, summary.period_gain);
        assert_eq!(full.simple_return, summary.simple_return);

        // Differentiation: full path populates returns[] and risk metrics;
        // summary stays empty/zero to save allocation on the dashboard.
        assert!(!full.returns.is_empty());
        assert!(summary.returns.is_empty());
        assert!(full.volatility > Decimal::ZERO);
        assert_eq!(summary.volatility, Decimal::ZERO);
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

        let period_return = result.period_return.expect("period_return should be Some");
        assert!(
            period_return.abs() < dec!(0.01),
            "period_return = {} should be small for well-formed account",
            period_return
        );
        assert_eq!(result.period_gain.round_dp(2), dec!(-0.52));
    }

    #[test]
    fn twr_uses_start_of_day_inflow_convention() {
        let history = vec![
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

        let result = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Transactions),
            None,
            true,
        )
        .expect("performance should compute");

        assert_eq!(result.cumulative_twr.unwrap().round_dp(4), dec!(0.05));
        assert_eq!(
            result.cumulative_modified_dietz.unwrap().round_dp(4),
            dec!(0.0667)
        );
        assert_eq!(result.cumulative_mwr, result.cumulative_modified_dietz);
    }

    #[test]
    fn twr_uses_end_of_day_outflow_convention() {
        let history = vec![
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

        let result = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Transactions),
            None,
            true,
        )
        .expect("performance should compute");

        assert_eq!(result.cumulative_twr.unwrap().round_dp(4), dec!(0.05));
        assert_eq!(
            result.cumulative_modified_dietz.unwrap().round_dp(4),
            dec!(0.0667)
        );
    }

    #[test]
    fn return_period_with_non_positive_denominator_is_excluded() {
        let history = vec![
            valuation(
                "2026-05-01",
                dec!(50),
                dec!(50),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            valuation(
                "2026-05-02",
                Decimal::ZERO,
                dec!(-50),
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

        assert_eq!(result.cumulative_twr.unwrap(), Decimal::ZERO);
        assert_eq!(result.cumulative_modified_dietz.unwrap(), Decimal::ZERO);
        assert_eq!(result.returns.last().unwrap().value, Decimal::ZERO);
        assert!(!result.warnings.is_empty());
    }

    /// Negative portfolio value (like TEST's unfunded-BUY shape) surfaces as a
    /// validation error in both paths — downstream percentages are meaningless
    /// when the underlying data is broken.
    #[test]
    fn perf_rejects_negative_portfolio_value() {
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
            let err = PerformanceService::compute_account_performance(
                &history,
                Some(TrackingMode::Transactions),
                None,
                include_series,
            )
            .expect_err("should error on negative portfolio value");

            assert!(
                format!("{}", err).contains("negative portfolio value"),
                "expected 'negative portfolio value' in error (include_series={}), got: {}",
                include_series,
                err
            );
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

        let (inflow, outflow) =
            PerformanceService::daily_external_flows(&prev, &curr, ExternalFlowBasis::BaseCurrency);

        assert_eq!(inflow, dec!(110));
        assert_eq!(outflow, Decimal::ZERO);
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

        let result = PerformanceService::compute_account_performance(
            &[prev, curr],
            Some(TrackingMode::Transactions),
            None,
            false,
        )
        .expect("foreign-currency account performance should compute");

        assert_eq!(result.currency, "EUR");
        assert_eq!(result.gain_loss_amount, Some(dec!(10)));
        assert_eq!(result.cumulative_modified_dietz, Some(dec!(0.06666667)));
    }

    /// HOLDINGS mode uses the cost-basis formula in both paths. TWR/MWR are
    /// returned as `None` because they aren't meaningful without per-transaction
    /// cash-flow tracking.
    #[test]
    fn perf_holdings_mode_uses_cost_basis_formula() {
        let history = vec![
            valuation("2026-02-15", dec!(1000), dec!(1000), dec!(1000), dec!(1000)),
            valuation("2026-04-14", dec!(900), dec!(1000), dec!(900), dec!(1000)),
        ];

        let result = PerformanceService::compute_account_performance(
            &history,
            Some(TrackingMode::Holdings),
            None, // ALL-time branch
            false,
        )
        .expect("holdings should compute");

        // end_unrealized_pnl = 900 - 1000 = -100; return = -100 / 1000 = -0.10.
        let period_return = result.period_return.expect("period_return should be Some");
        assert_eq!(period_return.round_dp(4), dec!(-0.1));
        assert!(result.cumulative_twr.is_none());
        assert!(result.cumulative_mwr.is_none());
        assert!(result.is_holdings_mode);
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
    fn mixed_scope_performance_is_value_complete_simple_return() {
        let mut history = vec![
            valuation("2026-05-01", dec!(1500), dec!(1500), dec!(1500), dec!(1500)),
            valuation("2026-05-02", dec!(1660), dec!(1600), dec!(1660), dec!(1600)),
        ];
        history[1].external_inflow_base = dec!(100);

        let result = PerformanceService::compute_mixed_scope_performance(&history, true)
            .expect("mixed scope should compute");

        assert!(result.is_mixed_tracking_mode);
        assert_eq!(result.return_method, ReturnMethod::SimpleReturn);
        assert_eq!(result.period_gain, dec!(60));
        assert_eq!(result.period_return.unwrap().round_dp(4), dec!(0.04));
        assert_eq!(result.returns.last().unwrap().value.round_dp(4), dec!(0.04));
        assert!(result.cumulative_twr.is_none());
        assert!(result.cumulative_modified_dietz.is_none());
        assert!(!result.warnings.is_empty());
    }

    #[test]
    fn mixed_scope_rejects_negative_portfolio_value_without_series() {
        let history = vec![
            valuation("2026-05-01", dec!(100), dec!(100), dec!(100), dec!(100)),
            valuation("2026-05-02", dec!(-50), dec!(100), dec!(-50), dec!(100)),
        ];

        for include_series in [true, false] {
            let err = PerformanceService::compute_mixed_scope_performance(&history, include_series)
                .expect_err("mixed scope should reject negative portfolio value");

            assert!(
                format!("{}", err).contains("negative portfolio value"),
                "expected 'negative portfolio value' in error (include_series={}), got: {}",
                include_series,
                err
            );
        }
    }
}
