//! Repository traits for portfolio valuations.

use async_trait::async_trait;
use chrono::NaiveDate;

use super::{DailyAccountValuation, NegativeBalanceInfo};
use crate::errors::Result;

/// Repository trait for managing daily account valuations.
#[async_trait]
pub trait ValuationRepositoryTrait: Send + Sync {
    /// Atomically replace valuation rows for an account/date range.
    /// If `since_date` is `None`, replaces all rows for the account.
    async fn replace_valuations_for_account(
        &self,
        account_id: &str,
        since_date: Option<NaiveDate>,
        valuation_records: &[DailyAccountValuation],
    ) -> Result<()>;

    /// Get historical valuations for a specific account within optional date range.
    fn get_historical_valuations(
        &self,
        account_id: &str,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
    ) -> Result<Vec<DailyAccountValuation>>;

    /// Get historical valuations for multiple real accounts in one ordered read.
    fn get_historical_valuations_for_accounts(
        &self,
        account_ids: &[String],
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
    ) -> Result<Vec<DailyAccountValuation>>;

    /// Returns the latest calculation timestamp for a scoped history read.
    ///
    /// Implementations can answer this with a cheap aggregate query so callers can
    /// check aggregate-history caches before loading the full valuation rows.
    fn get_max_calculated_at_for_accounts(
        &self,
        account_ids: &[String],
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
    ) -> Result<Option<String>> {
        let max_calculated_at = self
            .get_historical_valuations_for_accounts(account_ids, start_date, end_date)?
            .into_iter()
            .map(|valuation| valuation.calculated_at.to_rfc3339())
            .max();
        Ok(max_calculated_at)
    }

    /// Delete valuations for a specific account.
    /// If `since_date` is `Some(date)`, deletes only records on or after that date.
    /// If `since_date` is `None`, deletes all records for the account.
    async fn delete_valuations_for_account(
        &self,
        account_id: &str,
        since_date: Option<NaiveDate>,
    ) -> Result<()>;

    /// Get the latest valuations for multiple accounts.
    fn get_latest_valuations(&self, account_ids: &[String]) -> Result<Vec<DailyAccountValuation>>;

    /// Get valuations for multiple accounts on a specific date.
    fn get_valuations_on_date(
        &self,
        account_ids: &[String],
        date: NaiveDate,
    ) -> Result<Vec<DailyAccountValuation>>;

    /// Returns info about accounts that have at least one negative total_value in their history.
    fn get_accounts_with_negative_balance(
        &self,
        account_ids: &[String],
    ) -> Result<Vec<NegativeBalanceInfo>>;
}
