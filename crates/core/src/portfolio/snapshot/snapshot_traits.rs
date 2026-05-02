//! Repository traits for portfolio snapshots.

use async_trait::async_trait;
use chrono::NaiveDate;
use std::collections::HashMap;

use super::{AccountStateSnapshot, Position};
use crate::errors::Result;

/// Repository trait for managing account state snapshots.
#[async_trait]
pub trait SnapshotRepositoryTrait: Send + Sync {
    /// Save multiple snapshots to the database.
    async fn save_snapshots(&self, snapshots: &[AccountStateSnapshot]) -> Result<()>;

    /// Get snapshots for a specific account within optional date range.
    fn get_snapshots_by_account(
        &self,
        account_id: &str,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
    ) -> Result<Vec<AccountStateSnapshot>>;

    /// Get the latest snapshot before or on the given date.
    fn get_latest_snapshot_before_date(
        &self,
        account_id: &str,
        date: NaiveDate,
    ) -> Result<Option<AccountStateSnapshot>>;

    /// Get the latest snapshots for multiple accounts before or on the given date.
    fn get_latest_snapshots_before_date(
        &self,
        account_ids: &[String],
        date: NaiveDate,
    ) -> Result<HashMap<String, AccountStateSnapshot>>;

    /// Get the latest snapshots for multiple accounts (no date filter).
    fn get_all_latest_snapshots(
        &self,
        account_ids: &[String],
    ) -> Result<HashMap<String, AccountStateSnapshot>>;

    /// Delete all snapshots for the given account IDs.
    async fn delete_snapshots_by_account_ids(&self, account_ids: &[String]) -> Result<usize>;

    /// Delete snapshots for a specific account on specific dates.
    async fn delete_snapshots_for_account_and_dates(
        &self,
        account_id: &str,
        dates_to_delete: &[NaiveDate],
    ) -> Result<()>;

    /// Delete snapshots for a specific account within a date range.
    async fn delete_snapshots_for_account_in_range(
        &self,
        account_id: &str,
        start_date: NaiveDate,
        end_date: NaiveDate,
    ) -> Result<()>;

    /// Delete all snapshots in range and save new ones atomically.
    async fn overwrite_snapshots_for_account_in_range(
        &self,
        account_id: &str,
        start_date: NaiveDate,
        end_date: NaiveDate,
        snapshots_to_save: &[AccountStateSnapshot],
    ) -> Result<()>;

    /// Overwrite snapshot ranges for multiple accounts.
    async fn overwrite_multiple_account_snapshot_ranges(
        &self,
        new_snapshots: &[AccountStateSnapshot],
    ) -> Result<()>;

    /// Get all non-archived account snapshots.
    /// Uses is_archived=false filtering to include closed accounts in TOTAL aggregates.
    fn get_all_non_archived_account_snapshots(
        &self,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
    ) -> Result<Vec<AccountStateSnapshot>>;

    /// Get the earliest snapshot date for an account.
    fn get_earliest_snapshot_date(&self, account_id: &str) -> Result<Option<NaiveDate>>;

    /// Delete all snapshots for an account and save new ones atomically.
    async fn overwrite_all_snapshots_for_account(
        &self,
        account_id: &str,
        snapshots_to_save: &[AccountStateSnapshot],
    ) -> Result<()>;

    /// Update the source field of all snapshots for an account.
    /// Returns the number of rows updated.
    async fn update_snapshots_source(&self, account_id: &str, new_source: &str) -> Result<usize>;

    /// Save or update a snapshot for a specific date.
    /// If a snapshot exists for the same date, it is replaced.
    /// If the date is different from existing snapshots, a new one is created.
    async fn save_or_update_snapshot(&self, snapshot: &AccountStateSnapshot) -> Result<()>;

    /// Get the count of non-calculated snapshots for an account.
    /// Non-calculated sources include: ManualEntry, BrokerImported, CsvImport, Synthetic.
    fn get_non_calculated_snapshot_count(&self, account_id: &str) -> Result<usize>;

    /// Get the earliest non-calculated snapshot for an account.
    /// Used for creating synthetic backfill snapshots.
    fn get_earliest_non_calculated_snapshot(
        &self,
        account_id: &str,
    ) -> Result<Option<AccountStateSnapshot>>;

    /// Load positions from the `snapshot_positions` table for a given snapshot.
    /// Returns a HashMap keyed by asset_id, matching the in-memory
    /// `AccountStateSnapshot.positions` shape.
    fn get_snapshot_positions(&self, snapshot_id: &str) -> Result<HashMap<String, Position>>;

    /// Batch-load positions for multiple snapshot IDs at once.
    /// Returns a map of snapshot_id -> (asset_id -> Position).
    fn get_snapshot_positions_batch(
        &self,
        snapshot_ids: &[String],
    ) -> Result<HashMap<String, HashMap<String, Position>>>;
}
