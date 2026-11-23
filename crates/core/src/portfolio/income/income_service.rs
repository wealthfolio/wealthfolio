use crate::constants::DISPLAY_DECIMAL_PRECISION;
use crate::utils::time_utils::{activity_date_in_tz, parse_user_timezone_or_default, user_today};
use crate::{
    activities::{ActivityError, ActivityRepositoryTrait, IncomeData},
    Error, Result,
};
use chrono::Datelike;
use chrono_tz::Tz;

use super::IncomeSummary;
use crate::fx::FxServiceTrait;
use log::{debug, error};
use num_traits::Zero;
use rust_decimal::Decimal;
use std::sync::{Arc, RwLock};
// Define the trait for the income service
pub trait IncomeServiceTrait: Send + Sync {
    fn get_income_summary(&self, account_ids: Option<&[String]>) -> Result<Vec<IncomeSummary>>;
}

pub struct IncomeService {
    fx_service: Arc<dyn FxServiceTrait>,
    activity_repository: Arc<dyn ActivityRepositoryTrait>,
    base_currency: Arc<RwLock<String>>,
    timezone: Arc<RwLock<String>>,
}

impl IncomeService {
    pub fn new(
        fx_service: Arc<dyn FxServiceTrait>,
        activity_repository: Arc<dyn ActivityRepositoryTrait>,
        base_currency: Arc<RwLock<String>>,
    ) -> Self {
        Self::new_with_timezone(
            fx_service,
            activity_repository,
            base_currency,
            Arc::new(RwLock::new(String::new())),
        )
    }

    pub fn new_with_timezone(
        fx_service: Arc<dyn FxServiceTrait>,
        activity_repository: Arc<dyn ActivityRepositoryTrait>,
        base_currency: Arc<RwLock<String>>,
        timezone: Arc<RwLock<String>>,
    ) -> Self {
        IncomeService {
            fx_service,
            activity_repository,
            base_currency,
            timezone,
        }
    }

    fn user_timezone(&self) -> Tz {
        parse_user_timezone_or_default(
            &self
                .timezone
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        )
    }

    /// `None` when the previous period has no income to compare with,
    /// including when all of it was left out for lack of an exchange rate.
    fn calculate_yoy_growth(current: Decimal, previous: Decimal) -> Option<Decimal> {
        if previous > Decimal::zero() {
            Some((current - previous) / previous)
        } else {
            None
        }
    }
}

// Implement the trait for IncomeService
impl IncomeServiceTrait for IncomeService {
    fn get_income_summary(&self, account_ids: Option<&[String]>) -> Result<Vec<IncomeSummary>> {
        debug!("Getting income summary...");

        let activities = match self
            .activity_repository
            .get_income_activities_data(account_ids)
        {
            Ok(activity) => activity,
            Err(e) => {
                error!("Error getting aggregated income data: {:?}", e);
                return Err(Error::Activity(ActivityError::InvalidData(e.to_string())));
            }
        };

        if activities.is_empty() {
            return Ok(Vec::new());
        }

        let base_currency = self
            .base_currency
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let timezone = self.user_timezone();
        let current_date = user_today(timezone);
        let current_year = current_date.year();
        let last_year = current_year - 1;
        let two_years_ago = current_year - 2;
        let current_month = current_date.month();

        // Scope baseline date to member accounts so monthly-average denominators are correct.
        // Falls back to portfolio-wide when no filter.
        let oldest_date = if let Some(ids) = account_ids.filter(|ids| !ids.is_empty()) {
            match self.activity_repository.get_first_activity_date(Some(ids)) {
                Ok(Some(date)) => date,
                Ok(None) => return Ok(Vec::new()),
                Err(e) => {
                    error!("Error getting first activity date for accounts: {:?}", e);
                    return Err(e);
                }
            }
        } else {
            match self.activity_repository.get_first_activity_date_overall() {
                Ok(date) => date,
                Err(e) => {
                    error!("Error getting first transaction date: {:?}", e);
                    return Err(e);
                }
            }
        };
        // Months count in the user's timezone, as the income below does.
        let oldest_date = activity_date_in_tz(oldest_date, timezone);

        // Every period averages over the same months: from the later of its
        // start and the first activity's month through the earlier of its end
        // and the current month, both included.
        let month_index = |year: i32, month: u32| year * 12 + month as i32 - 1;
        let first_month = month_index(oldest_date.year(), oldest_date.month());
        let this_month = month_index(current_year, current_month);
        let months_between = |start: i32, end: i32| -> u32 {
            let start = start.max(first_month);
            let end = end.min(this_month);
            u32::try_from(end - start + 1).unwrap_or(0)
        };
        let months_since_first_transaction = months_between(first_month, this_month);
        let months_this_year = months_between(month_index(current_year, 1), this_month);
        let months_in_last_year =
            months_between(month_index(last_year, 1), month_index(last_year, 12));
        let months_two_years_ago = months_between(
            month_index(two_years_ago, 1),
            month_index(two_years_ago, 12),
        );

        let mut total_summary = IncomeSummary::new("ALL", base_currency.clone());
        let mut ytd_summary = IncomeSummary::new("YTD", base_currency.clone());
        let mut last_year_summary = IncomeSummary::new("LAST_YEAR", base_currency.clone());
        let mut two_years_ago_summary = IncomeSummary::new("TWO_YEARS_AGO", base_currency.clone());

        for activity in activities {
            // Income counts toward the month and year of the day it was
            // received in the user's timezone, the date the activity list
            // shows, not its UTC date.
            let date = activity_date_in_tz(activity.activity_date, timezone);
            let month = date.format("%Y-%m").to_string();

            // Income converts at the rate on the day it was received, as the
            // holdings income column does, so past totals don't move with
            // today's rate.
            let converted_amount = match self.fx_service.convert_currency_for_date(
                activity.amount,
                &activity.currency,
                &base_currency,
                date,
            ) {
                Ok(amount) => Some(amount),
                Err(e) => {
                    // Counting the amount as if it were already in the base
                    // currency would misstate every total, so it is left out
                    // and the summary names its currency instead.
                    error!("Error converting currency: {:?}", e);
                    None
                }
            };

            // Create a copy of the activity with cloned fields to avoid ownership issues
            let activity_copy = IncomeData {
                activity_date: activity.activity_date,
                income_type: activity.income_type.clone(),
                asset_id: activity.asset_id.clone(),
                asset_kind: activity.asset_kind.clone(),
                symbol: activity.symbol.clone(),
                symbol_name: activity.symbol_name.clone(),
                currency: activity.currency.clone(),
                amount: activity.amount,
                account_id: activity.account_id.clone(),
                account_name: activity.account_name.clone(),
            };

            let add = |summary: &mut IncomeSummary| match converted_amount {
                Some(amount) => summary.add_income(&activity_copy, &month, amount),
                None => summary.add_unconverted_income(&activity_copy),
            };
            add(&mut total_summary);

            if date.year() == current_year {
                add(&mut ytd_summary);
            } else if date.year() == last_year {
                add(&mut last_year_summary);
            } else if date.year() == two_years_ago {
                add(&mut two_years_ago_summary);
            }
        }

        total_summary.calculate_monthly_average(Some(months_since_first_transaction));
        ytd_summary.calculate_monthly_average(Some(months_this_year));
        last_year_summary.calculate_monthly_average(Some(months_in_last_year));
        two_years_ago_summary.calculate_monthly_average(Some(months_two_years_ago));

        // Calculate Year-over-Year Growth using the static helper method
        let ytd_yoy_growth = IncomeService::calculate_yoy_growth(
            ytd_summary.total_income,
            last_year_summary.total_income,
        );
        let last_year_yoy_growth = IncomeService::calculate_yoy_growth(
            last_year_summary.total_income,
            two_years_ago_summary.total_income,
        );

        ytd_summary.yoy_growth = ytd_yoy_growth;
        last_year_summary.yoy_growth = last_year_yoy_growth;

        // Two years ago YoY growth can't be calculated without activity from three years ago
        two_years_ago_summary.yoy_growth = None;

        // YoY growth and the page's previous-period comparison read the
        // previous period's totals, so its left-out currencies apply too.
        ytd_summary
            .unconverted_currencies
            .extend(last_year_summary.unconverted_currencies.iter().cloned());
        last_year_summary
            .unconverted_currencies
            .extend(two_years_ago_summary.unconverted_currencies.iter().cloned());

        // Round monetary values before returning, not the ratios formatted as percentages.
        let summaries = vec![
            total_summary,
            ytd_summary,
            last_year_summary,
            two_years_ago_summary,
        ];

        let rounded_summaries = summaries
            .into_iter()
            .map(|mut summary| {
                summary.total_income = summary.total_income.round_dp(DISPLAY_DECIMAL_PRECISION);
                summary.monthly_average =
                    summary.monthly_average.round_dp(DISPLAY_DECIMAL_PRECISION);
                for val in summary.by_month.values_mut() {
                    *val = val.round_dp(DISPLAY_DECIMAL_PRECISION);
                }
                for val in summary.by_type.values_mut() {
                    *val = val.round_dp(DISPLAY_DECIMAL_PRECISION);
                }
                for entry in summary.by_asset.values_mut() {
                    entry.income = entry.income.round_dp(DISPLAY_DECIMAL_PRECISION);
                    entry.dividend_income =
                        entry.dividend_income.round_dp(DISPLAY_DECIMAL_PRECISION);
                }
                for val in summary.by_currency.values_mut() {
                    *val = val.round_dp(DISPLAY_DECIMAL_PRECISION);
                }
                for val in summary.by_currency_base.values_mut() {
                    *val = val.round_dp(DISPLAY_DECIMAL_PRECISION);
                }
                for entry in summary.by_account.values_mut() {
                    entry.total = entry.total.round_dp(DISPLAY_DECIMAL_PRECISION);
                    for val in entry.by_month.values_mut() {
                        *val = val.round_dp(DISPLAY_DECIMAL_PRECISION);
                    }
                }
                summary
            })
            .collect();

        debug!("Income summary calculation and rounding completed successfully");
        Ok(rounded_summaries)
    }
}
