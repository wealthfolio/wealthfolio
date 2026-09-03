//! Repository traits for portfolio snapshots.

use async_trait::async_trait;
use chrono::NaiveDate;
use std::collections::HashMap;

use super::{AccountStateSnapshot, Position, SnapshotMetadata};
use crate::errors::{DatabaseError, Error, Result};

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

    /// Get raw snapshot metadata without requiring the stored date or source
    /// to deserialize successfully. Storage implementations should override
    /// this method so malformed rows remain available to remediation flows.
    fn get_snapshot_metadata_by_account(
        &self,
        account_id: &str,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
    ) -> Result<Vec<SnapshotMetadata>> {
        self.get_snapshots_by_account(account_id, start_date, end_date)
            .map(|snapshots| snapshots.iter().map(SnapshotMetadata::from).collect())
    }

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

    /// Delete one snapshot by its stable row ID. Storage implementations
    /// should override this to support rows with malformed dates.
    async fn delete_snapshot_for_account_by_id(
        &self,
        account_id: &str,
        snapshot_id: &str,
    ) -> Result<()> {
        let metadata = self
            .get_snapshot_metadata_by_account(account_id, None, None)?
            .into_iter()
            .find(|snapshot| snapshot.id == snapshot_id)
            .ok_or_else(|| {
                Error::Database(DatabaseError::NotFound(format!(
                    "Snapshot {snapshot_id} for account {account_id}"
                )))
            })?;
        let date = NaiveDate::parse_from_str(&metadata.snapshot_date, "%Y-%m-%d")
            .map_err(|error| Error::Repository(error.to_string()))?;
        self.delete_snapshots_for_account_and_dates(account_id, &[date])
            .await
    }

    /// Get all non-archived account snapshots.
    /// Uses is_archived=false filtering to include closed accounts.
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

    /// Save or update a snapshot for a specific date.
    /// If a snapshot exists for the same date, it is replaced.
    /// If the date is different from existing snapshots, a new one is created.
    async fn save_or_update_snapshot(&self, snapshot: &AccountStateSnapshot) -> Result<()>;

    /// Load positions from the `snapshot_positions` table for a given snapshot.
    /// Falls back to deserializing the legacy `holdings_snapshots.positions`
    /// JSON column when the relational table has no rows for the snapshot
    /// (e.g. snapshots written by an older app version, or HOLDINGS-mode
    /// snapshots that pre-date this PR).
    fn get_snapshot_positions(&self, snapshot_id: &str) -> Result<HashMap<String, Position>>;

    /// Batch-load positions for multiple snapshot IDs at once. Uses the same
    /// JSON-fallback semantics as `get_snapshot_positions`.
    fn get_snapshot_positions_batch(
        &self,
        snapshot_ids: &[String],
    ) -> Result<HashMap<String, HashMap<String, Position>>>;
}
