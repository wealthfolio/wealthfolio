use crate::accounts::TrackingMode;
use crate::constants::{DECIMAL_PRECISION, PORTFOLIO_TOTAL_ACCOUNT_ID};
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

use super::{PerformanceMetrics, SimplePerformanceMetrics};
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

    async fn calculate_performance_summary(
        &self,
        item_type: &str,
        item_id: &str,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
        tracking_mode: Option<TrackingMode>,
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

    fn get_account_boundary_data(
        &self,
        account_id: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> Result<(
        DailyAccountValuation,
        DailyAccountValuation,
        NaiveDate,
        NaiveDate,
        String,
    )> {
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

        let start_point: DailyAccountValuation = full_history.first().unwrap().clone();
        let end_point: DailyAccountValuation = full_history.last().unwrap().clone();

        let actual_start_date = start_point.valuation_date;
        let actual_end_date = end_point.valuation_date;
        let currency = start_point.account_currency.clone();

        Ok((
            start_point,
            end_point,
            actual_start_date,
            actual_end_date,
            currency,
        ))
    }

    /// Internal function for calculating account performance (Full)
    /// For HOLDINGS mode accounts, uses SOTA price-based performance calculations
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

        let start_point: &DailyAccountValuation = full_history.first().unwrap();
        let end_point: &DailyAccountValuation = full_history.last().unwrap();
        let actual_start_date = start_point.valuation_date;
        let actual_end_date = end_point.valuation_date;
        let currency = start_point.account_currency.clone();

        let is_holdings_mode = matches!(tracking_mode, Some(TrackingMode::Holdings));

        let capacity = full_history.len();
        let mut returns = Vec::with_capacity(capacity);
        let mut daily_twr_returns = Vec::with_capacity(capacity - 1);
        // Separate list for risk metrics that excludes days with holdings changes
        // (detected via cost_basis changes, which indicate position additions/removals)
        let mut daily_returns_for_risk = Vec::with_capacity(capacity - 1);

        returns.push(ReturnData {
            date: actual_start_date,
            value: Decimal::ZERO,
        });

        let one = Decimal::ONE;
        let two = dec!(2.0);
        let mut cumulative_twr_value = one;
        let mut cumulative_mwr_value = one;

        for window in full_history.windows(2) {
            let prev_point = &window[0];
            let curr_point = &window[1];

            if prev_point.total_value.is_sign_negative()
                || curr_point.total_value.is_sign_negative()
            {
                return Err(errors::Error::Validation(ValidationError::InvalidInput(
                    "Account has negative portfolio value in its history. This may be caused by missing buy activities. Please review your transactions on the Activities page.".to_string(),
                )));
            }

            let prev_total_value = prev_point.total_value;
            let prev_net_contribution = prev_point.net_contribution;
            let current_total_value = curr_point.total_value;
            let current_net_contribution = curr_point.net_contribution;

            let cash_flow = current_net_contribution - prev_net_contribution;

            let twr_period_return = {
                let denominator = prev_total_value + cash_flow;
                if denominator.is_zero() {
                    Decimal::ZERO
                } else {
                    (current_total_value / denominator) - one
                }
            };

            let mwr_period_return = {
                let numerator = current_total_value - prev_total_value - cash_flow;
                let denominator = prev_total_value + (cash_flow / two);
                if denominator.is_zero() {
                    Decimal::ZERO
                } else {
                    numerator / denominator
                }
            };

            daily_twr_returns.push(twr_period_return);

            // For risk metrics (volatility, max drawdown), filter logic depends on tracking mode:
            // - TRANSACTIONS mode: TWR already handles cash flows, use all daily returns
            // - HOLDINGS mode: exclude days with detected holdings/contribution changes
            //   (since we can't distinguish market returns from contribution-driven changes)
            let should_exclude = if is_holdings_mode {
                // Primary detection: cost_basis change indicates position additions/removals
                let cost_basis_changed = prev_point.cost_basis != curr_point.cost_basis;
                // Fallback detection: if cost_basis is zero/missing, check net_contribution
                // changes which indicate deposits/withdrawals
                let contribution_changed = prev_point.cost_basis.is_zero()
                    && prev_point.net_contribution != curr_point.net_contribution;
                cost_basis_changed || contribution_changed
            } else {
                // TRANSACTIONS mode: TWR is already cash-flow adjusted, no filtering needed
                false
            };

            if !should_exclude {
                daily_returns_for_risk.push(twr_period_return);
            }

            cumulative_twr_value *= one + twr_period_return;
            cumulative_mwr_value *= one + mwr_period_return;

            let cumulative_twr_to_date = cumulative_twr_value - one;

            returns.push(ReturnData {
                date: curr_point.valuation_date,
                value: cumulative_twr_to_date.round_dp(DECIMAL_PRECISION),
            });
        }

        let cumulative_twr = returns.last().map_or(Decimal::ZERO, |r| r.value);
        let annualized_twr =
            Self::calculate_annualized_return(actual_start_date, actual_end_date, cumulative_twr);
        // Risk metrics use filtered returns:
        // - TRANSACTIONS mode: all returns (TWR handles cash flows)
        // - HOLDINGS mode: excludes days with detected holdings/contribution changes
        let volatility = Self::calculate_volatility(&daily_returns_for_risk);
        let max_drawdown = Self::calculate_max_drawdown(&daily_returns_for_risk);

        let start_net_contribution = start_point.net_contribution;
        let end_net_contribution = end_point.net_contribution;
        let net_cash_flow = end_net_contribution - start_net_contribution;

        let start_value_for_gain_calc = start_point.total_value;

        let gain_loss_amount = end_point.total_value - start_value_for_gain_calc - net_cash_flow;

        let simple_total_return = if start_value_for_gain_calc.is_zero() {
            if gain_loss_amount.is_zero() {
                Decimal::ZERO
            } else {
                warn!("Simple total return calculation: start_value_for_gain_calc is zero but gain_loss_amount is non-zero for account_id: {}. Returning 0.", account_id);
                Decimal::ZERO
            }
        } else {
            gain_loss_amount / start_value_for_gain_calc
        };

        let annualized_simple_return = Self::calculate_annualized_return(
            actual_start_date,
            actual_end_date,
            simple_total_return,
        );

        let cumulative_mwr = cumulative_mwr_value - one;
        let annualized_mwr =
            Self::calculate_annualized_return(actual_start_date, actual_end_date, cumulative_mwr);

        // SOTA calculations for HOLDINGS mode
        // period_gain = Change in Unrealized P&L (excludes contributions)
        // period_return = period_gain / start_investment_value (rolling) or unrealized_pnl / cost_basis (ALL time)
        let (period_gain, period_return) = if is_holdings_mode {
            // Unrealized P&L = Investment Market Value - Cost Basis
            let start_unrealized_pnl = start_point.investment_market_value - start_point.cost_basis;
            let end_unrealized_pnl = end_point.investment_market_value - end_point.cost_basis;
            let period_gain = end_unrealized_pnl - start_unrealized_pnl;

            // Determine if this is ALL time (no start_date specified) or a rolling period
            let period_return = if start_date_opt.is_none() {
                // ALL time: return = unrealized_pnl / cost_basis
                if end_point.cost_basis.is_zero() {
                    Decimal::ZERO
                } else {
                    end_unrealized_pnl / end_point.cost_basis
                }
            } else {
                // Rolling period: return = period_gain / start_investment_value
                if start_point.investment_market_value.is_zero() {
                    Decimal::ZERO
                } else {
                    period_gain / start_point.investment_market_value
                }
            };

            (period_gain, Some(period_return))
        } else {
            // TRANSACTIONS mode: use standard calculations
            // Return is undefined when starting value is zero (division by zero)
            let period_return = if start_value_for_gain_calc.is_zero() {
                None
            } else {
                Some(simple_total_return)
            };
            (gain_loss_amount, period_return)
        };

        let result = PerformanceMetrics {
            id: account_id.to_string(),
            returns,
            period_start_date: Some(actual_start_date),
            period_end_date: Some(actual_end_date),
            currency,
            period_gain: period_gain.round_dp(DECIMAL_PRECISION),
            period_return: period_return.map(|r| r.round_dp(DECIMAL_PRECISION)),
            // For HOLDINGS mode, TWR/MWR are not meaningful (no cash flow tracking)
            cumulative_twr: if is_holdings_mode {
                None
            } else {
                Some(cumulative_twr.round_dp(DECIMAL_PRECISION))
            },
            gain_loss_amount: Some(gain_loss_amount.round_dp(DECIMAL_PRECISION)),
            annualized_twr: if is_holdings_mode {
                None
            } else {
                Some(annualized_twr.round_dp(DECIMAL_PRECISION))
            },
            simple_return: simple_total_return.round_dp(DECIMAL_PRECISION),
            annualized_simple_return: annualized_simple_return.round_dp(DECIMAL_PRECISION),
            cumulative_mwr: if is_holdings_mode {
                None
            } else {
                Some(cumulative_mwr.round_dp(DECIMAL_PRECISION))
            },
            annualized_mwr: if is_holdings_mode {
                None
            } else {
                Some(annualized_mwr.round_dp(DECIMAL_PRECISION))
            },
            volatility: volatility.round_dp(DECIMAL_PRECISION),
            max_drawdown: max_drawdown.round_dp(DECIMAL_PRECISION),
            is_holdings_mode,
        };

        Ok(result)
    }

    /// Internal function for calculating account performance (Summary)
    /// For HOLDINGS mode accounts, uses SOTA price-based performance calculations
    async fn calculate_account_performance_summary(
        &self,
        account_id: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
        tracking_mode: Option<TrackingMode>,
    ) -> Result<PerformanceMetrics> {
        let (start_point, end_point, actual_start_date, actual_end_date, currency): (
            DailyAccountValuation,
            DailyAccountValuation,
            NaiveDate,
            NaiveDate,
            String,
        ) = self.get_account_boundary_data(account_id, start_date_opt, end_date_opt)?;

        let is_holdings_mode = matches!(tracking_mode, Some(TrackingMode::Holdings));

        let start_value = start_point.total_value;
        let end_value = end_point.total_value;
        let start_net_contribution = start_point.net_contribution;
        let end_net_contribution = end_point.net_contribution;
        let net_cash_flow = end_net_contribution - start_net_contribution;

        let gain_loss_amount = end_value - start_value - net_cash_flow;

        let simple_total_return = if start_value <= Decimal::ZERO {
            Decimal::ZERO
        } else {
            (end_value - start_value - net_cash_flow) / start_value
        };

        let annualized_simple_return = Self::calculate_annualized_return(
            actual_start_date,
            actual_end_date,
            simple_total_return,
        );

        // SOTA calculations for HOLDINGS mode
        let (period_gain, period_return) = if is_holdings_mode {
            let start_unrealized_pnl = start_point.investment_market_value - start_point.cost_basis;
            let end_unrealized_pnl = end_point.investment_market_value - end_point.cost_basis;
            let period_gain = end_unrealized_pnl - start_unrealized_pnl;

            let period_return = if start_date_opt.is_none() {
                // ALL time: return = unrealized_pnl / cost_basis
                if end_point.cost_basis.is_zero() {
                    Decimal::ZERO
                } else {
                    end_unrealized_pnl / end_point.cost_basis
                }
            } else {
                // Rolling period: return = period_gain / start_investment_value
                if start_point.investment_market_value.is_zero() {
                    Decimal::ZERO
                } else {
                    period_gain / start_point.investment_market_value
                }
            };

            (period_gain, Some(period_return))
        } else {
            // Return is undefined when starting value is non-positive (division by zero or sign inversion)
            let period_return = if start_value <= Decimal::ZERO {
                None
            } else {
                Some(simple_total_return)
            };
            (gain_loss_amount, period_return)
        };

        let result = PerformanceMetrics {
            id: account_id.to_string(),
            returns: Vec::new(),
            period_start_date: Some(actual_start_date),
            period_end_date: Some(actual_end_date),
            currency,
            period_gain: period_gain.round_dp(DECIMAL_PRECISION),
            period_return: period_return.map(|r| r.round_dp(DECIMAL_PRECISION)),
            cumulative_twr: if is_holdings_mode {
                None
            } else {
                Some(Decimal::ZERO)
            },
            gain_loss_amount: Some(gain_loss_amount.round_dp(DECIMAL_PRECISION)),
            annualized_twr: if is_holdings_mode {
                None
            } else {
                Some(Decimal::ZERO)
            },
            simple_return: simple_total_return.round_dp(DECIMAL_PRECISION),
            annualized_simple_return: annualized_simple_return.round_dp(DECIMAL_PRECISION),
            cumulative_mwr: if is_holdings_mode {
                None
            } else {
                Some(Decimal::ZERO)
            },
            annualized_mwr: if is_holdings_mode {
                None
            } else {
                Some(Decimal::ZERO)
            },
            volatility: Decimal::ZERO,
            max_drawdown: Decimal::ZERO,
            is_holdings_mode,
        };

        Ok(result)
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
            cumulative_mwr: Some(Decimal::ZERO),
            annualized_mwr: Some(Decimal::ZERO),
            volatility: volatility.round_dp(DECIMAL_PRECISION),
            max_drawdown: max_drawdown.round_dp(DECIMAL_PRECISION),
            is_holdings_mode: false,
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
            cumulative_mwr: Some(Decimal::ZERO),
            annualized_mwr: Some(Decimal::ZERO),
            volatility: Decimal::ZERO,
            max_drawdown: Decimal::ZERO,
            is_holdings_mode: false,
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
        // "Cumulative gain" here means unrealized P&L on currently-held lots:
        // (market value of holdings) - (cost basis of those holdings). Cash is
        // included in market value but contributes nothing to cost basis, so
        // for a pure-cash account the percentage is undefined (None).
        //
        // The previous formula divided by `net_contribution`, which treats
        // internal account-to-account transfers as external deposits/
        // withdrawals. Accounts that received holdings via transfer-out from
        // a sibling end up with negative net_contribution, producing
        // nonsensical percentages (e.g. -4637%). Cost-basis is invariant
        // under internal transfers, so this denominator stays well-behaved.
        //
        // Trade-off: this metric does NOT include realized gains from past
        // sales — closed lots' cost basis is gone. A lifetime "total return"
        // metric requires implementing realized P&L separately.
        let cost_basis = current.cost_basis;
        let total_gain_loss_amount = current.investment_market_value - cost_basis;
        let cumulative_return_percent = if !cost_basis.is_zero() {
            Some((total_gain_loss_amount / cost_basis).round_dp(4))
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

        let total_value_base = current.total_value * current.fx_rate_to_base;
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

    fn calculate_accounts_simple_performance(
        &self,
        account_ids: &[String],
    ) -> Result<Vec<SimplePerformanceMetrics>> {
        if account_ids.is_empty() {
            return Ok(Vec::new());
        }

        // Include "TOTAL" to get the total portfolio value reference date
        let mut ids_to_fetch = account_ids.to_vec();
        if !account_ids.contains(&PORTFOLIO_TOTAL_ACCOUNT_ID.to_string()) {
            ids_to_fetch.push(PORTFOLIO_TOTAL_ACCOUNT_ID.to_string());
        }

        // 1. Fetch the *absolute* latest record for each account
        let latest_daily_valuations = self
            .valuation_service
            .get_latest_valuations(&ids_to_fetch)?;

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

        // 4. Calculate total portfolio value using the absolute latest "TOTAL" valuation
        let total_portfolio_value_base = latest_daily_map
            .get(PORTFOLIO_TOTAL_ACCOUNT_ID)
            .map(|p| p.total_value * p.fx_rate_to_base);

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
mod simple_performance_tests {
    use super::*;
    use chrono::{NaiveDate, TimeZone, Utc};
    use rust_decimal_macros::dec;

    fn val(
        total_value: Decimal,
        investment_market_value: Decimal,
        cost_basis: Decimal,
        net_contribution: Decimal,
    ) -> DailyAccountValuation {
        DailyAccountValuation {
            id: "id".to_string(),
            account_id: "acc".to_string(),
            valuation_date: NaiveDate::from_ymd_opt(2026, 5, 1).unwrap(),
            account_currency: "USD".to_string(),
            base_currency: "USD".to_string(),
            fx_rate_to_base: Decimal::ONE,
            cash_balance: total_value - investment_market_value,
            investment_market_value,
            total_value,
            cost_basis,
            net_contribution,
            calculated_at: Utc.with_ymd_and_hms(2026, 5, 1, 0, 0, 0).unwrap(),
            alternative_market_value: Decimal::ZERO,
        }
    }

    /// Holdings appreciated 10% above their cost basis.
    #[test]
    fn unrealized_gain_uses_cost_basis_denominator() {
        let v = val(dec!(110_000), dec!(110_000), dec!(100_000), dec!(100_000));
        let m = PerformanceService::calculate_simple_performance(&v, None, None);

        assert_eq!(m.total_gain_loss_amount, Some(dec!(10_000)));
        assert_eq!(m.cumulative_return_percent, Some(dec!(0.1000)));
    }

    /// Negative `net_contribution` (paired internal transfers leaving the
    /// account) used to produce wildly negative percentages like -4637% via
    /// `gain / net_contribution`. Cost-basis-based formula is invariant under
    /// internal transfers — the receiving account inherits the cost basis,
    /// the sending account loses it.
    #[test]
    fn negative_net_contribution_does_not_break_percentage() {
        // Real prod data: MS-7687 Triantos Trust Parametric on 2026-05-01.
        // total_value=785,239, IMV=782,956, cost_basis=453,816,
        // net_contribution=-17,305 (account had ~$17K of net transfers out).
        // Old formula: 802,544 / -17,305 = -4637%.
        // New formula: (782,956 - 453,816) / 453,816 ≈ +72.5%.
        let v = val(
            dec!(785_239.20),
            dec!(782_956.24),
            dec!(453_816.13),
            dec!(-17_305.00),
        );
        let m = PerformanceService::calculate_simple_performance(&v, None, None);

        let pct = m.cumulative_return_percent.expect("percent should be defined");
        assert!(
            pct > dec!(0.5) && pct < dec!(1.0),
            "expected 50%-100% range, got {}",
            pct
        );
        // Sanity: gain is positive and bounded by IMV (no inflation from net_cash_flow).
        let gain = m.total_gain_loss_amount.expect("gain present");
        assert!(gain > Decimal::ZERO);
        assert!(gain <= v.investment_market_value);
    }

    /// Pure-cash account (e.g. an old IRA that was rolled out): cost basis
    /// is zero, only residual cash remains. Old formula gave -100% via
    /// `cash / negative_net_contribution`. New formula reports 0% — there
    /// are no held positions to appreciate or depreciate. Critically, it
    /// does NOT inflate gain by `cash - net_contribution` like the old
    /// formula did.
    #[test]
    fn pure_cash_account_with_negative_nc_reports_zero_pct() {
        // Real prod data: MS-7257 Nick IRA Rollover after rollout.
        let v = val(dec!(144.56), Decimal::ZERO, Decimal::ZERO, dec!(-1_813_194));
        let m = PerformanceService::calculate_simple_performance(&v, None, None);

        assert_eq!(m.total_gain_loss_amount, Some(Decimal::ZERO));
        assert_eq!(m.cumulative_return_percent, Some(Decimal::ZERO));
    }

    /// Empty account (no holdings, no cash, no contributions): no data,
    /// no percent. Should not crash or report a return.
    #[test]
    fn empty_account_returns_zero_pct() {
        let v = val(Decimal::ZERO, Decimal::ZERO, Decimal::ZERO, Decimal::ZERO);
        let m = PerformanceService::calculate_simple_performance(&v, None, None);

        assert_eq!(m.total_gain_loss_amount, Some(Decimal::ZERO));
        assert_eq!(m.cumulative_return_percent, Some(Decimal::ZERO));
    }

    /// Holdings worth less than cost basis → loss expressed as a negative
    /// percentage (this is a real loss, not a calculation artifact).
    #[test]
    fn position_at_a_loss_reports_negative_pct() {
        let v = val(dec!(80_000), dec!(80_000), dec!(100_000), dec!(100_000));
        let m = PerformanceService::calculate_simple_performance(&v, None, None);

        assert_eq!(m.total_gain_loss_amount, Some(dec!(-20_000)));
        assert_eq!(m.cumulative_return_percent, Some(dec!(-0.2000)));
    }

    /// Account that received holdings via internal transfer (paired
    /// TRANSFER_OUT/TRANSFER_IN). Receiving side: net_contribution = 0
    /// (no external cash), but cost basis arrived with the lots. Should
    /// report the unrealized gain on those inherited lots correctly.
    #[test]
    fn transfer_in_recipient_reports_correct_pct() {
        // 100 shares @ $50 cost transferred in, now worth $80/share.
        // Receiving account: external net_contribution=0, cost_basis=5_000,
        // IMV=8_000. Old formula: gain/0 → None. New formula: 60% gain.
        let v = val(dec!(8_000), dec!(8_000), dec!(5_000), Decimal::ZERO);
        let m = PerformanceService::calculate_simple_performance(&v, None, None);

        assert_eq!(m.total_gain_loss_amount, Some(dec!(3_000)));
        assert_eq!(m.cumulative_return_percent, Some(dec!(0.6000)));
    }

    /// Account that transferred holdings out (paired TRANSFER_OUT). Sending
    /// side: lots are gone (cost_basis=0), but net_contribution went
    /// strongly negative because TRANSFER_OUT is treated as a withdrawal.
    /// Old formula: gain/negative_nc → wild negative %. New formula: 0%
    /// (no held positions, regardless of how negative net_contribution got).
    #[test]
    fn transfer_out_sender_with_residual_cash_reports_zero_pct() {
        // Account emptied via transfer; small residual cash sweep remains.
        let v = val(dec!(50.81), Decimal::ZERO, Decimal::ZERO, dec!(-471_086));
        let m = PerformanceService::calculate_simple_performance(&v, None, None);

        assert_eq!(m.total_gain_loss_amount, Some(Decimal::ZERO));
        assert_eq!(m.cumulative_return_percent, Some(Decimal::ZERO));
    }

    /// Cost basis is zero but somehow market value is positive (data
    /// integrity edge — e.g. an asset received via transfer with no cost
    /// basis recorded). Percent is genuinely undefined; gain is the full
    /// market value.
    #[test]
    fn imv_without_cost_basis_returns_none_pct() {
        let v = val(dec!(5_000), dec!(5_000), Decimal::ZERO, Decimal::ZERO);
        let m = PerformanceService::calculate_simple_performance(&v, None, None);

        assert_eq!(m.total_gain_loss_amount, Some(dec!(5_000)));
        assert_eq!(m.cumulative_return_percent, None);
    }

    /// `total_gain_loss_amount` and `cumulative_return_percent` must be
    /// derived from the same denominator (cost_basis). Mixing them — e.g.
    /// reporting `gain = value - net_contribution` while denominator is
    /// `cost_basis` — produces inconsistent gain / (gain ÷ %) ≠ %·denom
    /// relations. Lock that invariant down.
    #[test]
    fn gain_and_pct_share_denominator() {
        // Mismatched scenario the old code allowed: nc and cost_basis differ.
        let v = val(
            dec!(150_000), // value
            dec!(150_000), // imv
            dec!(80_000),  // cost_basis
            dec!(120_000), // net_contribution (different from cost_basis)
        );
        let m = PerformanceService::calculate_simple_performance(&v, None, None);

        let gain = m.total_gain_loss_amount.expect("gain present");
        let pct = m.cumulative_return_percent.expect("pct present");
        // Both must be cost-basis-relative.
        assert_eq!(gain, dec!(70_000)); // 150k - 80k cost_basis (NOT 150k - 120k nc)
        assert_eq!(pct, dec!(0.8750)); // 70k / 80k
        // Algebraic consistency: pct * cost_basis == gain.
        assert_eq!((pct * v.cost_basis).round_dp(2), gain.round_dp(2));
    }
}
