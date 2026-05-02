//! Repository traits for portfolio valuations.

use async_trait::async_trait;
use chrono::NaiveDate;

use super::{DailyAccountValuation, NegativeBalanceInfo};
use crate::errors::Result;

/// Repository trait for managing daily account valuations.
#[async_trait]
pub trait ValuationRepositoryTrait: Send + Sync {
    /// Save multiple valuation records to the database.
    async fn save_valuations(&self, valuation_records: &[DailyAccountValuation]) -> Result<()>;

    /// Get historical valuations for a specific account within optional date range.
    fn get_historical_valuations(
        &self,
        account_id: &str,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
    ) -> Result<Vec<DailyAccountValuation>>;

    /// Get the latest valuation date for a specific account.
    fn load_latest_valuation_date(&self, account_id: &str) -> Result<Option<NaiveDate>>;

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

    /// Get all per-account valuations (excluding the synthesized TOTAL row),
    /// for portfolio aggregation.
    fn get_all_account_valuations(
        &self,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
    ) -> Result<Vec<DailyAccountValuation>>;
}
