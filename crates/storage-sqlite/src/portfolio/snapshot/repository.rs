use async_trait::async_trait;
use chrono::NaiveDate;
use diesel::prelude::*;
use diesel::r2d2::{ConnectionManager, Pool};
use diesel::sql_query;
use diesel::sql_types::Text;
use diesel::sqlite::Sqlite;
use diesel::SqliteConnection;
use log::{debug, warn};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use super::model::{AccountStateSnapshotDB, NewSnapshotPositionRecord, SnapshotPositionRecord};
use crate::db::{get_connection, WriteHandle};
use crate::errors::StorageError;
use wealthfolio_core::errors::{Error, Result};
use wealthfolio_core::portfolio::snapshot::{
    AccountStateSnapshot, Position, SnapshotRepositoryTrait,
};

pub struct SnapshotRepository {
    pool: Arc<Pool<ConnectionManager<SqliteConnection>>>,
    writer: WriteHandle,
}

impl SnapshotRepository {
    pub fn new(pool: Arc<Pool<ConnectionManager<SqliteConnection>>>, writer: WriteHandle) -> Self {
        Self { pool, writer }
    }

    // --- Implement Snapshot Storage/Retrieval Logic ---
    // Methods adapted from the intended ValuationRepository implementation

    pub async fn save_snapshots(&self, snapshots: &[AccountStateSnapshot]) -> Result<()> {
        use crate::schema::holdings_snapshots::dsl::*;

        let snapshots_to_save: Vec<AccountStateSnapshot> = snapshots.to_vec();

        if snapshots_to_save.is_empty() {
            debug!("save_snapshots called with no snapshots. Nothing to save.");
            return Ok(());
        }

        // Capture positions for the snapshot_positions dual-write. Include
        // empty maps so replacing a snapshot with no positions clears stale
        // relational rows for that snapshot.
        let positions_to_write: Vec<(String, HashMap<String, Position>)> = snapshots_to_save
            .iter()
            .map(|s| (s.id.clone(), s.positions.clone()))
            .collect();

        let db_models: Vec<AccountStateSnapshotDB> = snapshots_to_save
            .iter()
            .cloned()
            .map(AccountStateSnapshotDB::from)
            .collect();
        debug!(
            "Saving {} snapshots to DB via SnapshotRepository",
            db_models.len()
        );
        self.writer
            .exec(move |conn| {
                diesel::replace_into(holdings_snapshots)
                    .values(&db_models)
                    .execute(conn)
                    .map_err(StorageError::from)?;

                // Dual-write positions to the relational table.
                for (snap_id, pos_map) in &positions_to_write {
                    Self::write_snapshot_positions(conn, snap_id, pos_map)?;
                }

                Ok(())
            })
            .await
    }

    pub fn get_snapshots_by_account(
        &self,
        input_account_id: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> Result<Vec<AccountStateSnapshot>> {
        use crate::schema::holdings_snapshots::dsl::*;
        let mut conn = get_connection(&self.pool)?;
        let mut query = holdings_snapshots
            .into_boxed()
            .filter(account_id.eq(input_account_id));
        if let Some(start) = start_date_opt {
            query = query.filter(snapshot_date.ge(start.format("%Y-%m-%d").to_string()));
        }
        if let Some(end) = end_date_opt {
            query = query.filter(snapshot_date.le(end.format("%Y-%m-%d").to_string()));
        }
        let result_db = query
            .order(snapshot_date.asc())
            .load::<AccountStateSnapshotDB>(&mut conn)
            .map_err(StorageError::from)?;
        if !result_db.is_empty() {
            debug!(
                "Loaded {} snapshots for account {} from DB via SnapshotRepository (range: {:?}..={:?})",
                result_db.len(),
                input_account_id,
                start_date_opt,
                end_date_opt
            );
        }
        Ok(result_db
            .into_iter()
            .map(AccountStateSnapshot::from)
            .collect())
    }

    pub fn get_latest_snapshot_before_date(
        &self,
        input_account_id: &str,
        target_date: NaiveDate,
    ) -> Result<Option<AccountStateSnapshot>> {
        use crate::schema::holdings_snapshots::dsl::*;
        let mut conn = get_connection(&self.pool)?;
        let target_date_str = target_date.format("%Y-%m-%d").to_string();
        let result_db = holdings_snapshots
            .filter(account_id.eq(input_account_id))
            .filter(snapshot_date.le(&target_date_str))
            .order(snapshot_date.desc())
            .first::<AccountStateSnapshotDB>(&mut conn)
            .optional()
            .map_err(StorageError::from)?;
        Ok(result_db.map(AccountStateSnapshot::from))
    }

    pub fn get_latest_snapshots_before_date(
        &self,
        account_ids_vec: &[String],
        target_date: NaiveDate,
    ) -> Result<HashMap<String, AccountStateSnapshot>> {
        if account_ids_vec.is_empty() {
            return Ok(HashMap::new());
        }

        let mut conn = get_connection(&self.pool)?;
        let target_date_str = target_date.format("%Y-%m-%d").to_string(); // SQLite expects date strings

        let placeholders: String = account_ids_vec
            .iter()
            .map(|_| "?")
            .collect::<Vec<&str>>()
            .join(", ");

        // Fields: id, account_id, snapshot_date, currency, positions, cash_balances, cost_basis, net_contribution, calculated_at, net_contribution_base, cash_total_account_currency, cash_total_base_currency, source
        let sql = format!(
            "WITH RankedSnapshots AS ( \
                SELECT \
                    id, account_id, snapshot_date, currency, positions, \
                    cash_balances, cost_basis, net_contribution, calculated_at, net_contribution_base, \
                    cash_total_account_currency, cash_total_base_currency, source, \
                    ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY snapshot_date DESC) as rn \
                FROM {} \
                WHERE account_id IN ({}) AND snapshot_date <= ? \
            ) \
            SELECT \
                id, account_id, snapshot_date, currency, positions, \
                cash_balances, cost_basis, net_contribution, calculated_at, net_contribution_base, \
                cash_total_account_currency, cash_total_base_currency, source \
            FROM RankedSnapshots \
            WHERE rn = 1",
            "holdings_snapshots", // Use direct table name string
            placeholders
        );

        let mut query_builder = sql_query(sql).into_boxed::<Sqlite>();

        for acc_id_str in account_ids_vec {
            query_builder = query_builder.bind::<Text, _>(acc_id_str);
        }
        // Bind the target_date_str as the last parameter
        query_builder = query_builder.bind::<Text, _>(target_date_str); // SQLite uses TEXT for dates

        let latest_snapshots_db: Vec<AccountStateSnapshotDB> = query_builder
            .load::<AccountStateSnapshotDB>(&mut conn)
            .map_err(StorageError::from)?;

        let results_map: HashMap<String, AccountStateSnapshot> = latest_snapshots_db
            .into_iter()
            .map(|db_item| {
                (
                    db_item.account_id.clone(),
                    AccountStateSnapshot::from(db_item),
                )
            })
            .collect();

        Ok(results_map)
    }

    pub fn get_all_latest_snapshots(
        &self,
        account_ids_vec: &[String],
    ) -> Result<HashMap<String, AccountStateSnapshot>> {
        if account_ids_vec.is_empty() {
            return Ok(HashMap::new());
        }

        let mut conn = get_connection(&self.pool)?;

        let placeholders: String = account_ids_vec
            .iter()
            .map(|_| "?")
            .collect::<Vec<&str>>()
            .join(", ");

        // Fields: id, account_id, snapshot_date, currency, positions, cash_balances, cost_basis, net_contribution, calculated_at, net_contribution_base, cash_total_account_currency, cash_total_base_currency, source
        let sql = format!(
            "WITH RankedSnapshots AS ( \
                SELECT \
                    id, account_id, snapshot_date, currency, positions, \
                    cash_balances, cost_basis, net_contribution, calculated_at, net_contribution_base, \
                    cash_total_account_currency, cash_total_base_currency, source, \
                    ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY snapshot_date DESC) as rn \
                FROM {} \
                WHERE account_id IN ({}) \
            ) \
            SELECT \
                id, account_id, snapshot_date, currency, positions, \
                cash_balances, cost_basis, net_contribution, calculated_at, net_contribution_base, \
                cash_total_account_currency, cash_total_base_currency, source \
            FROM RankedSnapshots \
            WHERE rn = 1",
            "holdings_snapshots",
            placeholders
        );

        let mut query_builder = sql_query(sql).into_boxed::<Sqlite>();

        for acc_id_str in account_ids_vec {
            query_builder = query_builder.bind::<Text, _>(acc_id_str);
        }

        let latest_snapshots_db: Vec<AccountStateSnapshotDB> = query_builder
            .load::<AccountStateSnapshotDB>(&mut conn)
            .map_err(StorageError::from)?;

        let results_map: HashMap<String, AccountStateSnapshot> = latest_snapshots_db
            .into_iter()
            .map(|db_item| {
                (
                    db_item.account_id.clone(),
                    AccountStateSnapshot::from(db_item),
                )
            })
            .collect();

        Ok(results_map)
    }

    /// Deletes only CALCULATED snapshots for the given account IDs.
    /// Manual, CSV-imported, and broker-imported snapshots are preserved.
    pub async fn delete_snapshots_by_account_ids(
        &self,
        account_ids_to_delete: &[String],
    ) -> Result<usize> {
        use crate::schema::holdings_snapshots::dsl::*;
        if account_ids_to_delete.is_empty() {
            return Ok(0);
        }

        // Clone the input slice
        let final_ids = account_ids_to_delete.to_vec();

        self.writer
            .exec(move |conn| {
                // Only delete CALCULATED snapshots - preserve manual/imported snapshots
                let deleted_count = diesel::delete(
                    holdings_snapshots
                        .filter(account_id.eq_any(final_ids))
                        .filter(source.eq("CALCULATED")),
                )
                .execute(conn)
                .map_err(StorageError::from)?;
                Ok(deleted_count)
            })
            .await
    }

    pub async fn delete_snapshots_for_account_and_dates(
        &self,
        input_account_id: &str,
        dates_to_delete: &[NaiveDate],
    ) -> Result<()> {
        use crate::schema::holdings_snapshots::dsl::*;
        if dates_to_delete.is_empty() {
            debug!("delete_snapshots_for_account_and_dates: No dates specified for account {}. Nothing to delete.", input_account_id);
            return Ok(());
        }

        let account_id_owned = input_account_id.to_string();
        let date_strings: Vec<String> = dates_to_delete
            .iter()
            .map(|d| d.format("%Y-%m-%d").to_string())
            .collect();

        self.writer
            .exec_tx(move |tx| {
                debug!(
                    "Deleting snapshots for account {} on dates: {:?} via SnapshotRepository",
                    account_id_owned,
                    date_strings // Use the moved date_strings
                );

                // Capture existing rows before delete; writer-side outbox model policy decides emission.
                let existing_rows: Vec<AccountStateSnapshotDB> = holdings_snapshots
                    .filter(account_id.eq(&account_id_owned))
                    .filter(snapshot_date.eq_any(&date_strings))
                    .load::<AccountStateSnapshotDB>(tx.conn())
                    .map_err(StorageError::from)?;

                diesel::delete(
                    holdings_snapshots
                        .filter(account_id.eq(&account_id_owned))
                        .filter(snapshot_date.eq_any(&date_strings)),
                )
                .execute(tx.conn())
                .map_err(StorageError::from)?;

                for row in &existing_rows {
                    tx.delete_model(row);
                }

                Ok(())
            })
            .await
    }

    pub async fn delete_snapshots_for_account_in_range(
        &self,
        input_account_id: &str,
        start_date_val: NaiveDate,
        end_date_val: NaiveDate,
    ) -> Result<()> {
        use crate::schema::holdings_snapshots::dsl::*;

        let account_id_owned = input_account_id.to_string();
        let start_date_str = start_date_val.format("%Y-%m-%d").to_string();
        let end_date_str = end_date_val.format("%Y-%m-%d").to_string();

        self.writer
            .exec(move |conn| {
                diesel::delete(
                    holdings_snapshots
                        .filter(account_id.eq(account_id_owned))
                        .filter(snapshot_date.ge(start_date_str))
                        .filter(snapshot_date.le(end_date_str)),
                )
                .execute(conn)
                .map_err(StorageError::from)?;
                Ok(())
            })
            .await
    }

    pub async fn overwrite_snapshots_for_account_in_range(
        &self,
        target_account_id: &str,
        range_start_date: NaiveDate,
        range_end_date: NaiveDate,
        snapshots_to_save: &[AccountStateSnapshot],
    ) -> Result<()> {
        // It's crucial that these operations appear atomic for a given account's range.
        // The current writer.exec handles individual Diesel calls transactionally.
        // For true atomicity of delete + save, this whole block should be one transaction.
        // However, self.writer.exec itself creates a transaction for each call.
        // For now, we rely on sequential execution. A deeper refactor of WriteHandle might be needed for true multi-statement transactions.

        // Only delete CALCULATED snapshots - preserve manual/broker/CSV imported ones
        self.delete_calculated_snapshots_for_account_in_range(
            target_account_id,
            range_start_date,
            range_end_date,
        )
        .await?;

        let anchor_dates = self
            .get_anchor_snapshot_dates_for_account_in_range(
                target_account_id,
                range_start_date,
                range_end_date,
            )
            .await?;

        if !snapshots_to_save.is_empty() {
            // Filter snapshots_to_save to ensure they are indeed for the target_account_id
            // although the caller should guarantee this.
            let mut account_specific_snapshots: Vec<AccountStateSnapshot> = snapshots_to_save
                .iter()
                .filter(|s| s.account_id == target_account_id)
                .cloned()
                .collect();

            if account_specific_snapshots.len() != snapshots_to_save.len() {
                warn!(
                    "overwrite_snapshots_for_account_in_range: Mismatch between provided snapshots and target_account_id {}. Expected all {} for this account.",
                    target_account_id, snapshots_to_save.len()
                );
                // Decide on error handling: proceed with filtered, or error out?
                // For now, proceed with filtered, but this indicates a caller issue.
            }

            if !anchor_dates.is_empty() {
                account_specific_snapshots.retain(|s| {
                    let date_key = s.snapshot_date.format("%Y-%m-%d").to_string();
                    !anchor_dates.contains(&date_key)
                });
            }

            if !account_specific_snapshots.is_empty() {
                self.save_snapshots(&account_specific_snapshots).await?;
            } else if snapshots_to_save.is_empty() {
                debug!("overwrite_snapshots_for_account_in_range: No new snapshots provided for account {} after deleting range. Only delete was performed.", target_account_id);
            } else {
                warn!("overwrite_snapshots_for_account_in_range: All provided snapshots were filtered out for account {}. No save performed after delete.", target_account_id);
            }
        } else {
            debug!("overwrite_snapshots_for_account_in_range: No new snapshots provided for account {}. Only delete was performed for range [{}, {}].", target_account_id, range_start_date, range_end_date);
        }
        Ok(())
    }

    pub async fn overwrite_multiple_account_snapshot_ranges(
        &self,
        new_snapshots: &[AccountStateSnapshot],
    ) -> Result<()> {
        if new_snapshots.is_empty() {
            return Ok(());
        }

        let mut snapshots_by_account: HashMap<String, Vec<AccountStateSnapshot>> = HashMap::new();
        for snapshot in new_snapshots {
            snapshots_by_account
                .entry(snapshot.account_id.clone())
                .or_default()
                .push(snapshot.clone());
        }

        for (acc_id, acc_snapshots) in snapshots_by_account {
            if acc_snapshots.is_empty() {
                // Should not happen if new_snapshots was not empty
                continue;
            }

            // Determine min/max date for this account's specific snapshots
            // Panics if acc_snapshots is empty, but we checked above.
            let mut min_date = acc_snapshots.first().unwrap().snapshot_date;
            let mut max_date = acc_snapshots.first().unwrap().snapshot_date;

            for snapshot in acc_snapshots.iter().skip(1) {
                if snapshot.snapshot_date < min_date {
                    min_date = snapshot.snapshot_date;
                }
                if snapshot.snapshot_date > max_date {
                    max_date = snapshot.snapshot_date;
                }
            }

            // Now call the per-account overwrite method
            self.overwrite_snapshots_for_account_in_range(
                &acc_id,
                min_date,
                max_date,
                &acc_snapshots, // Pass the already filtered and cloned vec for this account
            )
            .await?;
        }
        Ok(())
    }

    pub fn get_all_non_archived_account_snapshots(
        &self,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> Result<Vec<AccountStateSnapshot>> {
        use crate::schema::accounts::dsl as accounts_dsl;
        use crate::schema::holdings_snapshots::dsl::*;
        let mut conn = get_connection(&self.pool)?;
        // Use is_archived=false instead of is_active=true to include closed accounts.
        let non_archived_account_ids: Vec<String> = accounts_dsl::accounts
            .filter(accounts_dsl::is_archived.eq(false))
            .select(accounts_dsl::id)
            .load::<String>(&mut conn)
            .map_err(StorageError::from)?;
        if non_archived_account_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut query = holdings_snapshots
            .into_boxed()
            .filter(account_id.eq_any(non_archived_account_ids));
        if let Some(start) = start_date_opt {
            query = query.filter(snapshot_date.ge(start.format("%Y-%m-%d").to_string()));
        }
        if let Some(end) = end_date_opt {
            query = query.filter(snapshot_date.le(end.format("%Y-%m-%d").to_string()));
        }
        let result_db = query
            .order(snapshot_date.asc())
            .load::<AccountStateSnapshotDB>(&mut conn)
            .map_err(StorageError::from)?;
        Ok(result_db
            .into_iter()
            .map(AccountStateSnapshot::from)
            .collect())
    }

    pub fn get_earliest_snapshot_date(&self, input_account_id: &str) -> Result<Option<NaiveDate>> {
        use crate::schema::holdings_snapshots::dsl::*;
        let mut conn = get_connection(&self.pool)?;

        let earliest_date_str = holdings_snapshots
            .filter(account_id.eq(input_account_id))
            .select(snapshot_date)
            .order(snapshot_date.asc())
            .first::<String>(&mut conn)
            .optional()
            .map_err(StorageError::from)?;

        match earliest_date_str {
            Some(date_str) => NaiveDate::parse_from_str(&date_str, "%Y-%m-%d")
                .map(Some)
                .map_err(|e| {
                    Error::Unexpected(format!(
                        "Failed to parse earliest date '{}': {}",
                        date_str, e
                    ))
                }),
            None => Ok(None), // No snapshots found for this account
        }
    }

    /// Update the source field for all snapshots of an account.
    /// Used when switching tracking modes (e.g., from HOLDINGS to TRANSACTIONS).
    pub async fn update_snapshots_source(
        &self,
        input_account_id: &str,
        new_source: &str,
    ) -> Result<usize> {
        use crate::schema::holdings_snapshots::dsl::*;

        let account_id_owned = input_account_id.to_string();
        let new_source_owned = new_source.to_string();

        self.writer
            .exec(move |conn| {
                let updated_count =
                    diesel::update(holdings_snapshots.filter(account_id.eq(&account_id_owned)))
                        .set(source.eq(&new_source_owned))
                        .execute(conn)
                        .map_err(StorageError::from)?;

                debug!(
                    "Updated {} snapshots for account {} to source {}",
                    updated_count, account_id_owned, new_source_owned
                );
                Ok(updated_count)
            })
            .await
    }

    /// Delete CALCULATED snapshots only for account in a date range.
    /// Preserves MANUAL_ENTRY, BROKER_IMPORTED, CSV_IMPORT snapshots.
    pub async fn delete_calculated_snapshots_for_account_in_range(
        &self,
        input_account_id: &str,
        start_date_val: NaiveDate,
        end_date_val: NaiveDate,
    ) -> Result<usize> {
        use crate::schema::holdings_snapshots::dsl::*;

        let account_id_owned = input_account_id.to_string();
        let start_date_str = start_date_val.format("%Y-%m-%d").to_string();
        let end_date_str = end_date_val.format("%Y-%m-%d").to_string();

        self.writer
            .exec(move |conn| {
                let deleted_count = diesel::delete(
                    holdings_snapshots
                        .filter(account_id.eq(&account_id_owned))
                        .filter(snapshot_date.ge(&start_date_str))
                        .filter(snapshot_date.le(&end_date_str))
                        .filter(source.eq(SOURCE_CALCULATED)),
                )
                .execute(conn)
                .map_err(StorageError::from)?;

                debug!(
                    "Deleted {} CALCULATED snapshots for account {} in range {} to {}",
                    deleted_count, account_id_owned, start_date_str, end_date_str
                );
                Ok(deleted_count)
            })
            .await
    }

    pub async fn overwrite_all_snapshots_for_account(
        &self,
        target_account_id: &str,
        snapshots_to_save: &[AccountStateSnapshot],
    ) -> Result<()> {
        use crate::schema::holdings_snapshots::dsl::*;
        let account_id_owned = target_account_id.to_string();
        let anchor_dates = self
            .get_anchor_snapshot_dates_for_account(target_account_id)
            .await?;

        let filtered_snapshots: Vec<AccountStateSnapshot> = if anchor_dates.is_empty() {
            snapshots_to_save.to_vec()
        } else {
            snapshots_to_save
                .iter()
                .filter(|s| {
                    let date_key = s.snapshot_date.format("%Y-%m-%d").to_string();
                    !anchor_dates.contains(&date_key)
                })
                .cloned()
                .collect()
        };

        // Capture positions for the snapshot_positions dual-write before the
        // AccountStateSnapshotDB::from conversion. Mirrors save_snapshots:
        // without this, the FK ON DELETE CASCADE wipes snapshot_positions
        // rows tied to the deleted CALCULATED snapshots, and the replacement
        // INSERT below never repopulates them — breaking the dual-write
        // invariant for every Full recalc.
        let positions_to_write: Vec<(String, HashMap<String, Position>)> = filtered_snapshots
            .iter()
            .map(|s| (s.id.clone(), s.positions.clone()))
            .collect();

        let db_models: Vec<AccountStateSnapshotDB> = filtered_snapshots
            .iter()
            .cloned()
            .map(AccountStateSnapshotDB::from)
            .collect();

        self.writer
            .exec(move |conn| {
                // Delete only CALCULATED snapshots for this account
                // Preserves MANUAL_ENTRY, BROKER_IMPORTED, CSV_IMPORT snapshots
                diesel::delete(
                    holdings_snapshots
                        .filter(account_id.eq(&account_id_owned))
                        .filter(source.eq(SOURCE_CALCULATED)),
                )
                .execute(conn)
                .map_err(StorageError::from)?;

                // Save new ones (using replace_into to handle conflicts)
                if !db_models.is_empty() {
                    diesel::replace_into(holdings_snapshots)
                        .values(&db_models)
                        .execute(conn)
                        .map_err(StorageError::from)?;
                }

                // Dual-write positions to the relational table.
                for (snap_id, pos_map) in &positions_to_write {
                    Self::write_snapshot_positions(conn, snap_id, pos_map)?;
                }

                Ok(())
            })
            .await
    }

    async fn get_anchor_snapshot_dates_for_account_in_range(
        &self,
        target_account_id: &str,
        range_start_date: NaiveDate,
        range_end_date: NaiveDate,
    ) -> Result<HashSet<String>> {
        use crate::schema::holdings_snapshots::dsl::*;

        let account_id_owned = target_account_id.to_string();
        let start_date_str = range_start_date.format("%Y-%m-%d").to_string();
        let end_date_str = range_end_date.format("%Y-%m-%d").to_string();

        self.writer
            .exec(move |conn| {
                let dates = holdings_snapshots
                    .select(snapshot_date)
                    .filter(account_id.eq(&account_id_owned))
                    .filter(snapshot_date.ge(start_date_str))
                    .filter(snapshot_date.le(end_date_str))
                    .filter(source.ne(SOURCE_CALCULATED))
                    .load::<String>(conn)
                    .map_err(|e| Error::from(StorageError::from(e)))?;
                Ok(dates.into_iter().collect())
            })
            .await
    }

    async fn get_anchor_snapshot_dates_for_account(
        &self,
        target_account_id: &str,
    ) -> Result<HashSet<String>> {
        use crate::schema::holdings_snapshots::dsl::*;

        let account_id_owned = target_account_id.to_string();

        self.writer
            .exec(move |conn| {
                let dates = holdings_snapshots
                    .select(snapshot_date)
                    .filter(account_id.eq(&account_id_owned))
                    .filter(source.ne(SOURCE_CALCULATED))
                    .load::<String>(conn)
                    .map_err(|e| Error::from(StorageError::from(e)))?;
                Ok(dates.into_iter().collect())
            })
            .await
    }

    /// Save or update a single snapshot.
    /// Uses replace_into to handle both insert and update cases.
    /// If a snapshot with the same id (account_id + date) exists, it is replaced.
    pub async fn save_or_update_snapshot_impl(
        &self,
        snapshot: &AccountStateSnapshot,
    ) -> Result<()> {
        use crate::schema::holdings_snapshots::dsl::*;

        let snap_id = snapshot.id.clone();
        let positions_to_write = snapshot.positions.clone();
        let db_model = AccountStateSnapshotDB::from(snapshot.clone());
        debug!(
            "Saving/updating snapshot for account {} on date {}",
            snapshot.account_id, snapshot.snapshot_date
        );

        self.writer
            .exec_tx(move |tx| {
                diesel::replace_into(holdings_snapshots)
                    .values(&db_model)
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;

                tx.insert(&db_model)?;

                // Dual-write positions to the relational table. Empty maps
                // intentionally clear any stale relational rows.
                Self::write_snapshot_positions(tx.conn(), &snap_id, &positions_to_write)?;

                Ok(())
            })
            .await
    }

    /// Get count of non-calculated snapshots for an account.
    pub fn get_non_calculated_snapshot_count_impl(&self, target_account_id: &str) -> Result<usize> {
        use crate::schema::holdings_snapshots::dsl::*;

        let mut conn = get_connection(&self.pool)?;
        let count: i64 = holdings_snapshots
            .filter(account_id.eq(target_account_id))
            .filter(source.ne(SOURCE_CALCULATED))
            .count()
            .get_result(&mut conn)
            .map_err(StorageError::from)?;

        Ok(count as usize)
    }

    /// Get the earliest non-calculated snapshot for an account.
    pub fn get_earliest_non_calculated_snapshot_impl(
        &self,
        target_account_id: &str,
    ) -> Result<Option<AccountStateSnapshot>> {
        use crate::schema::holdings_snapshots::dsl::*;

        let mut conn = get_connection(&self.pool)?;
        let result = holdings_snapshots
            .filter(account_id.eq(target_account_id))
            .filter(source.ne(SOURCE_CALCULATED))
            .order(snapshot_date.asc())
            .first::<AccountStateSnapshotDB>(&mut conn)
            .optional()
            .map_err(StorageError::from)?;

        Ok(result.map(AccountStateSnapshot::from))
    }

    // --- snapshot_positions helpers ---
    //
    // The relational table is dual-written alongside the legacy positions JSON.
    // Reads prefer the relational table and fall back to the JSON column when
    // no rows exist for a snapshot — keeps older snapshots, synced peers on
    // prior schema versions, and rollback scenarios working.

    /// Load positions from the `snapshot_positions` table for a single
    /// snapshot, with a JSON-column fallback.
    fn get_snapshot_positions_impl(
        &self,
        snapshot_id_param: &str,
    ) -> Result<HashMap<String, Position>> {
        use crate::schema::snapshot_positions::dsl::*;

        let mut conn = get_connection(&self.pool)?;

        let rows: Vec<SnapshotPositionRecord> = snapshot_positions
            .filter(snapshot_id.eq(snapshot_id_param))
            .load(&mut conn)
            .map_err(StorageError::from)?;

        // account_id is needed to reconstruct Position.id; positions JSON is
        // the fallback when the relational table has no rows for this
        // snapshot (e.g. snapshot written before this PR landed).
        let snap_meta: Option<(String, String)> = {
            use crate::schema::holdings_snapshots::dsl as hs;
            hs::holdings_snapshots
                .select((hs::account_id, hs::positions))
                .filter(hs::id.eq(snapshot_id_param))
                .first::<(String, String)>(&mut conn)
                .optional()
                .map_err(StorageError::from)?
        };
        let (acct_id, positions_json) = snap_meta.unwrap_or_default();

        if rows.is_empty() {
            return Ok(deserialize_positions_json(&positions_json, &acct_id));
        }

        let mut map = HashMap::new();
        for row in rows {
            let pos = row.to_position(&acct_id);
            map.insert(pos.asset_id.clone(), pos);
        }
        Ok(map)
    }

    /// Batch-load positions for multiple snapshot IDs. Uses the same
    /// JSON-fallback semantics as `get_snapshot_positions_impl`.
    fn get_snapshot_positions_batch_impl(
        &self,
        snapshot_ids_param: &[String],
    ) -> Result<HashMap<String, HashMap<String, Position>>> {
        use crate::schema::snapshot_positions::dsl::*;

        if snapshot_ids_param.is_empty() {
            return Ok(HashMap::new());
        }

        let mut conn = get_connection(&self.pool)?;

        let rows: Vec<SnapshotPositionRecord> = snapshot_positions
            .filter(snapshot_id.eq_any(snapshot_ids_param))
            .load(&mut conn)
            .map_err(StorageError::from)?;

        let snap_meta: HashMap<String, (String, String)> = {
            use crate::schema::holdings_snapshots::dsl as hs;
            let triples: Vec<(String, String, String)> = hs::holdings_snapshots
                .select((hs::id, hs::account_id, hs::positions))
                .filter(hs::id.eq_any(snapshot_ids_param))
                .load(&mut conn)
                .map_err(StorageError::from)?;
            triples
                .into_iter()
                .map(|(sid, acct, pj)| (sid, (acct, pj)))
                .collect()
        };

        let mut result: HashMap<String, HashMap<String, Position>> = HashMap::new();
        for row in rows {
            let acct_id = snap_meta
                .get(&row.snapshot_id)
                .map(|(a, _)| a.clone())
                .unwrap_or_default();
            let snap_id = row.snapshot_id.clone();
            let pos = row.to_position(&acct_id);
            result
                .entry(snap_id)
                .or_default()
                .insert(pos.asset_id.clone(), pos);
        }

        // Fallback for snapshots without any rows in the relational table.
        for sid in snapshot_ids_param {
            if result.contains_key(sid) {
                continue;
            }
            if let Some((acct, pj)) = snap_meta.get(sid) {
                let map = deserialize_positions_json(pj, acct);
                if !map.is_empty() {
                    result.insert(sid.clone(), map);
                }
            }
        }

        Ok(result)
    }

    /// Replace the rows in `snapshot_positions` for a given snapshot_id.
    /// Deletes existing rows first, then inserts new ones. Called inside the
    /// same transaction as the holdings_snapshots write so both representations
    /// move together.
    ///
    /// Positions whose `asset_id` no longer exists in `assets` are silently
    /// dropped with a warning. The legacy positions JSON has no FK constraint,
    /// so a snapshot can carry references to assets that have since been
    /// deleted; the relational table does enforce the FK, so attempting to
    /// insert an orphan row would abort the whole save. Drop them here so the
    /// JSON write (which still happens in AccountStateSnapshotDB) keeps the
    /// historical reference while the relational view stays clean.
    fn write_snapshot_positions(
        conn: &mut SqliteConnection,
        snap_id: &str,
        positions: &HashMap<String, Position>,
    ) -> std::result::Result<(), StorageError> {
        use crate::schema::snapshot_positions::dsl::*;

        diesel::delete(snapshot_positions.filter(snapshot_id.eq(snap_id)))
            .execute(conn)
            .map_err(StorageError::from)?;

        if positions.is_empty() {
            return Ok(());
        }

        let existing_asset_ids =
            Self::existing_asset_ids(conn, positions.values().map(|p| p.asset_id.as_str()))?;

        let mut records: Vec<NewSnapshotPositionRecord> = Vec::with_capacity(positions.len());
        for pos in positions.values() {
            if !existing_asset_ids.contains(pos.asset_id.as_str()) {
                warn!(
                    "Dropping snapshot position for missing asset {} (snapshot {})",
                    pos.asset_id, snap_id
                );
                continue;
            }
            records.push(NewSnapshotPositionRecord::from_position(snap_id, pos));
        }

        if records.is_empty() {
            return Ok(());
        }

        diesel::insert_into(snapshot_positions)
            .values(&records)
            .execute(conn)
            .map_err(StorageError::from)?;

        Ok(())
    }

    /// Returns the subset of `candidate_ids` that exist in `assets`.
    /// Used by write paths that mirror data from the legacy positions JSON
    /// (which has no FK constraint) into FK-enforced relational tables.
    fn existing_asset_ids<'a, I>(
        conn: &mut SqliteConnection,
        candidate_ids: I,
    ) -> std::result::Result<HashSet<String>, StorageError>
    where
        I: IntoIterator<Item = &'a str>,
    {
        use crate::schema::assets::dsl as a;

        let unique: HashSet<String> = candidate_ids.into_iter().map(|s| s.to_string()).collect();
        if unique.is_empty() {
            return Ok(HashSet::new());
        }
        let needles: Vec<String> = unique.iter().cloned().collect();
        let found: Vec<String> = a::assets
            .select(a::id)
            .filter(a::id.eq_any(&needles))
            .load(conn)
            .map_err(StorageError::from)?;
        Ok(found.into_iter().collect())
    }
}

/// Deserialize the legacy `holdings_snapshots.positions` JSON column into a
/// position map. Returns empty for "{}" or unparseable input. `acct_id` is
/// stamped onto each Position so callers see a consistent account_id even
/// if older serialized payloads lacked the field.
fn deserialize_positions_json(json: &str, acct_id: &str) -> HashMap<String, Position> {
    if json.is_empty() || json == "{}" {
        return HashMap::new();
    }
    match serde_json::from_str::<HashMap<String, Position>>(json) {
        Ok(mut map) => {
            for pos in map.values_mut() {
                if pos.account_id.is_empty() {
                    pos.account_id = acct_id.to_string();
                }
            }
            map
        }
        Err(e) => {
            warn!(
                "Failed to parse positions JSON fallback (acct {}): {}",
                acct_id, e
            );
            HashMap::new()
        }
    }
}

// --- Constant for CALCULATED source ---
const SOURCE_CALCULATED: &str = "CALCULATED";

// Implement the trait methods for SnapshotRepository
#[async_trait]
impl SnapshotRepositoryTrait for SnapshotRepository {
    async fn save_snapshots(&self, snapshots: &[AccountStateSnapshot]) -> Result<()> {
        SnapshotRepository::save_snapshots(self, snapshots).await
    }

    fn get_snapshots_by_account(
        &self,
        account_id_param: &str,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
    ) -> Result<Vec<AccountStateSnapshot>> {
        self.get_snapshots_by_account(account_id_param, start_date, end_date)
    }

    fn get_latest_snapshot_before_date(
        &self,
        account_id_param: &str,
        date: NaiveDate,
    ) -> Result<Option<AccountStateSnapshot>> {
        self.get_latest_snapshot_before_date(account_id_param, date)
    }

    fn get_latest_snapshots_before_date(
        &self,
        account_ids_param: &[String],
        date: NaiveDate,
    ) -> Result<HashMap<String, AccountStateSnapshot>> {
        self.get_latest_snapshots_before_date(account_ids_param, date)
    }

    fn get_all_latest_snapshots(
        &self,
        account_ids_param: &[String],
    ) -> Result<HashMap<String, AccountStateSnapshot>> {
        self.get_all_latest_snapshots(account_ids_param)
    }

    async fn delete_snapshots_by_account_ids(&self, account_ids_param: &[String]) -> Result<usize> {
        Ok(self
            .delete_snapshots_by_account_ids(account_ids_param)
            .await?)
    }

    async fn delete_snapshots_for_account_and_dates(
        &self,
        account_id_param: &str,
        dates_to_delete: &[NaiveDate],
    ) -> Result<()> {
        self.delete_snapshots_for_account_and_dates(account_id_param, dates_to_delete)
            .await
    }

    async fn delete_snapshots_for_account_in_range(
        &self,
        account_id_param: &str,
        start_date_param: NaiveDate,
        end_date_param: NaiveDate,
    ) -> Result<()> {
        self.delete_snapshots_for_account_in_range(
            account_id_param,
            start_date_param,
            end_date_param,
        )
        .await
    }

    async fn overwrite_snapshots_for_account_in_range(
        &self,
        target_account_id: &str,
        range_start_date: NaiveDate,
        range_end_date: NaiveDate,
        snapshots_to_save: &[AccountStateSnapshot],
    ) -> Result<()> {
        self.overwrite_snapshots_for_account_in_range(
            target_account_id,
            range_start_date,
            range_end_date,
            snapshots_to_save,
        )
        .await
    }

    async fn overwrite_multiple_account_snapshot_ranges(
        &self,
        new_snapshots: &[AccountStateSnapshot],
    ) -> Result<()> {
        self.overwrite_multiple_account_snapshot_ranges(new_snapshots)
            .await
    }

    fn get_all_non_archived_account_snapshots(
        &self,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
    ) -> Result<Vec<AccountStateSnapshot>> {
        self.get_all_non_archived_account_snapshots(start_date, end_date)
    }

    fn get_earliest_snapshot_date(&self, account_id_param: &str) -> Result<Option<NaiveDate>> {
        self.get_earliest_snapshot_date(account_id_param)
    }

    async fn overwrite_all_snapshots_for_account(
        &self,
        account_id: &str,
        snapshots_to_save: &[AccountStateSnapshot],
    ) -> Result<()> {
        self.overwrite_all_snapshots_for_account(account_id, snapshots_to_save)
            .await
    }

    async fn update_snapshots_source(&self, account_id: &str, new_source: &str) -> Result<usize> {
        self.update_snapshots_source(account_id, new_source).await
    }

    async fn save_or_update_snapshot(&self, snapshot: &AccountStateSnapshot) -> Result<()> {
        self.save_or_update_snapshot_impl(snapshot).await
    }

    fn get_non_calculated_snapshot_count(&self, account_id: &str) -> Result<usize> {
        self.get_non_calculated_snapshot_count_impl(account_id)
    }

    fn get_earliest_non_calculated_snapshot(
        &self,
        account_id: &str,
    ) -> Result<Option<AccountStateSnapshot>> {
        self.get_earliest_non_calculated_snapshot_impl(account_id)
    }

    fn get_snapshot_positions(&self, snapshot_id: &str) -> Result<HashMap<String, Position>> {
        self.get_snapshot_positions_impl(snapshot_id)
    }

    fn get_snapshot_positions_batch(
        &self,
        snapshot_ids: &[String],
    ) -> Result<HashMap<String, HashMap<String, Position>>> {
        self.get_snapshot_positions_batch_impl(snapshot_ids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{create_pool, get_connection, run_migrations, write_actor::spawn_writer};
    use crate::schema::sync_outbox;
    use chrono::NaiveDate;
    use diesel::dsl::count_star;
    use diesel::RunQueryDsl;
    use rust_decimal::Decimal;
    use std::collections::HashMap;
    use tempfile::tempdir;
    use wealthfolio_core::portfolio::snapshot::SnapshotSource;

    /// Creates a test repository with an in-memory-like temp database
    /// Returns the repository, pool (for creating test accounts), and temp dir (to keep it alive)
    async fn create_test_repository() -> (
        SnapshotRepository,
        Arc<Pool<ConnectionManager<SqliteConnection>>>,
        tempfile::TempDir,
    ) {
        std::env::set_var("CONNECT_API_URL", "http://test.local");

        let temp_dir = tempdir().expect("Failed to create temp directory");
        let db_path = temp_dir.path().join("test.db");
        let db_path_str = db_path.to_string_lossy().to_string();

        run_migrations(&db_path_str).expect("Failed to run migrations");

        // create_pool returns Arc<DbPool>
        let pool = create_pool(&db_path_str).expect("Failed to create pool");

        // spawn_writer expects DbPool (not Arc<DbPool>), so we need to clone the inner pool
        // Since pool is Arc<DbPool>, we dereference to get DbPool, then clone it
        let writer = spawn_writer((*pool).clone()).expect("Failed to spawn writer actor");

        let repo = SnapshotRepository::new(Arc::clone(&pool), writer);
        (repo, pool, temp_dir)
    }

    fn count_pending_outbox(pool: &Arc<Pool<ConnectionManager<SqliteConnection>>>) -> i64 {
        let mut conn = get_connection(pool).expect("Failed to get connection");
        sync_outbox::table
            .select(count_star())
            .first::<i64>(&mut conn)
            .expect("Failed to count outbox rows")
    }

    /// Creates a test account in the database to satisfy foreign key constraints
    fn create_test_account(
        pool: &Arc<Pool<ConnectionManager<SqliteConnection>>>,
        account_id: &str,
    ) {
        let mut conn = get_connection(pool).expect("Failed to get connection");
        diesel::sql_query(format!(
            "INSERT INTO accounts (id, name, account_type, currency, is_default, is_active, created_at, updated_at) \
             VALUES ('{}', 'Test Account', 'REGULAR', 'USD', false, true, datetime('now'), datetime('now'))",
            account_id
        ))
        .execute(&mut conn)
        .expect("Failed to create test account");
    }

    fn create_test_asset(pool: &Arc<Pool<ConnectionManager<SqliteConnection>>>, asset_id: &str) {
        let mut conn = get_connection(pool).expect("Failed to get connection");
        diesel::sql_query(format!(
            "INSERT INTO assets (id, kind, name, display_code, notes, metadata, is_active, quote_mode, quote_ccy, instrument_type, instrument_symbol, instrument_exchange_mic, provider_config, created_at, updated_at) \
             VALUES ('{}', 'INVESTMENT', 'Test Asset', 'TEST', NULL, NULL, 1, 'MANUAL', 'USD', NULL, NULL, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
            asset_id
        ))
        .execute(&mut conn)
        .expect("Failed to create test asset");
    }

    fn create_test_position(account_id: &str, asset_id: &str) -> Position {
        let now = chrono::Utc::now();
        Position {
            id: format!("POS-{}-{}", account_id, asset_id),
            account_id: account_id.to_string(),
            asset_id: asset_id.to_string(),
            quantity: Decimal::from(10),
            average_cost: Decimal::from(25),
            total_cost_basis: Decimal::from(250),
            currency: "USD".to_string(),
            inception_date: now,
            lots: Default::default(),
            created_at: now,
            last_updated: now,
            is_alternative: false,
            contract_multiplier: Decimal::ONE,
        }
    }

    fn count_snapshot_positions(
        pool: &Arc<Pool<ConnectionManager<SqliteConnection>>>,
        snapshot_id_value: &str,
    ) -> i64 {
        use crate::schema::snapshot_positions::dsl as sp;

        let mut conn = get_connection(pool).expect("Failed to get connection");
        sp::snapshot_positions
            .filter(sp::snapshot_id.eq(snapshot_id_value))
            .select(count_star())
            .first::<i64>(&mut conn)
            .expect("Failed to count snapshot positions")
    }

    /// Helper to create a test snapshot with specific source
    fn create_test_snapshot(
        account_id: &str,
        date: NaiveDate,
        source: SnapshotSource,
    ) -> AccountStateSnapshot {
        AccountStateSnapshot {
            id: AccountStateSnapshot::stable_id(account_id, date),
            account_id: account_id.to_string(),
            snapshot_date: date,
            currency: "USD".to_string(),
            positions: HashMap::new(),
            cash_balances: HashMap::new(),
            cost_basis: Decimal::ZERO,
            net_contribution: Decimal::ZERO,
            net_contribution_base: Decimal::ZERO,
            cash_total_account_currency: Decimal::ZERO,
            cash_total_base_currency: Decimal::ZERO,
            calculated_at: chrono::Utc::now().naive_utc(),
            source,
        }
    }

    #[tokio::test]
    async fn test_save_or_update_snapshot_clears_positions_when_empty() {
        let (repo, pool, _temp_dir) = create_test_repository().await;
        let account_id = "test-account-empty-update";
        let asset_id = "asset-empty-update";
        create_test_account(&pool, account_id);
        create_test_asset(&pool, asset_id);

        let mut snapshot = create_test_snapshot(
            account_id,
            NaiveDate::from_ymd_opt(2024, 5, 1).unwrap(),
            SnapshotSource::ManualEntry,
        );
        snapshot.positions.insert(
            asset_id.to_string(),
            create_test_position(account_id, asset_id),
        );

        repo.save_or_update_snapshot(&snapshot)
            .await
            .expect("save snapshot with position");
        assert_eq!(count_snapshot_positions(&pool, &snapshot.id), 1);

        snapshot.positions.clear();
        repo.save_or_update_snapshot(&snapshot)
            .await
            .expect("save snapshot with no positions");

        assert_eq!(
            count_snapshot_positions(&pool, &snapshot.id),
            0,
            "empty snapshot updates must clear stale relational positions"
        );
    }

    #[tokio::test]
    async fn test_save_snapshots_clears_positions_when_empty() {
        let (repo, pool, _temp_dir) = create_test_repository().await;
        let account_id = "test-account-empty-batch";
        let asset_id = "asset-empty-batch";
        create_test_account(&pool, account_id);
        create_test_asset(&pool, asset_id);

        let mut snapshot = create_test_snapshot(
            account_id,
            NaiveDate::from_ymd_opt(2024, 5, 2).unwrap(),
            SnapshotSource::Calculated,
        );
        snapshot.positions.insert(
            asset_id.to_string(),
            create_test_position(account_id, asset_id),
        );

        repo.save_snapshots(std::slice::from_ref(&snapshot))
            .await
            .expect("save batch snapshot with position");
        assert_eq!(count_snapshot_positions(&pool, &snapshot.id), 1);

        snapshot.positions.clear();
        repo.save_snapshots(std::slice::from_ref(&snapshot))
            .await
            .expect("save batch snapshot with no positions");

        assert_eq!(
            count_snapshot_positions(&pool, &snapshot.id),
            0,
            "empty batch snapshot writes must clear stale relational positions"
        );
    }

    #[tokio::test]
    async fn test_overwrite_all_preserves_manual_snapshots() {
        let (repo, pool, _temp_dir) = create_test_repository().await;
        let account_id = "test-account-1";
        create_test_account(&pool, account_id);

        // Create initial snapshots with different sources
        let calculated_snapshot = create_test_snapshot(
            account_id,
            NaiveDate::from_ymd_opt(2024, 1, 1).unwrap(),
            SnapshotSource::Calculated,
        );
        let manual_snapshot = create_test_snapshot(
            account_id,
            NaiveDate::from_ymd_opt(2024, 1, 2).unwrap(),
            SnapshotSource::ManualEntry,
        );
        let broker_snapshot = create_test_snapshot(
            account_id,
            NaiveDate::from_ymd_opt(2024, 1, 3).unwrap(),
            SnapshotSource::BrokerImported,
        );

        // Save all initial snapshots
        repo.save_snapshots(&[
            calculated_snapshot.clone(),
            manual_snapshot.clone(),
            broker_snapshot.clone(),
        ])
        .await
        .expect("Failed to save initial snapshots");

        // Verify all 3 are saved
        let all_snapshots = repo
            .get_snapshots_by_account(account_id, None, None)
            .expect("Failed to get snapshots");
        assert_eq!(all_snapshots.len(), 3, "Should have 3 initial snapshots");

        // Create new calculated snapshot
        let new_calculated_snapshot = create_test_snapshot(
            account_id,
            NaiveDate::from_ymd_opt(2024, 1, 4).unwrap(),
            SnapshotSource::Calculated,
        );

        // Overwrite - this should only delete CALCULATED, keeping MANUAL_ENTRY and BROKER_IMPORTED
        repo.overwrite_all_snapshots_for_account(
            account_id,
            std::slice::from_ref(&new_calculated_snapshot),
        )
        .await
        .expect("Failed to overwrite snapshots");

        // Verify: should have 3 snapshots (2 preserved + 1 new)
        let final_snapshots = repo
            .get_snapshots_by_account(account_id, None, None)
            .expect("Failed to get final snapshots");
        assert_eq!(
            final_snapshots.len(),
            3,
            "Should have 3 snapshots after overwrite: manual + broker + new calculated"
        );

        // Verify the manual and broker snapshots are preserved
        let sources: Vec<SnapshotSource> = final_snapshots.iter().map(|s| s.source).collect();
        assert!(
            sources.contains(&SnapshotSource::ManualEntry),
            "Manual snapshot should be preserved"
        );
        assert!(
            sources.contains(&SnapshotSource::BrokerImported),
            "Broker snapshot should be preserved"
        );
        assert!(
            sources.contains(&SnapshotSource::Calculated),
            "New calculated snapshot should exist"
        );
    }

    #[tokio::test]
    async fn test_overwrite_in_range_preserves_manual_snapshots() {
        let (repo, pool, _temp_dir) = create_test_repository().await;
        let account_id = "test-account-2";
        create_test_account(&pool, account_id);

        let start_date = NaiveDate::from_ymd_opt(2024, 1, 1).unwrap();
        let end_date = NaiveDate::from_ymd_opt(2024, 1, 31).unwrap();

        // Create snapshots within range with different sources
        let calculated_snapshot = create_test_snapshot(
            account_id,
            NaiveDate::from_ymd_opt(2024, 1, 10).unwrap(),
            SnapshotSource::Calculated,
        );
        let csv_snapshot = create_test_snapshot(
            account_id,
            NaiveDate::from_ymd_opt(2024, 1, 15).unwrap(),
            SnapshotSource::CsvImport,
        );

        repo.save_snapshots(&[calculated_snapshot, csv_snapshot.clone()])
            .await
            .expect("Failed to save initial snapshots");

        // Overwrite in range with new calculated snapshot
        let new_snapshot = create_test_snapshot(
            account_id,
            NaiveDate::from_ymd_opt(2024, 1, 20).unwrap(),
            SnapshotSource::Calculated,
        );

        repo.overwrite_snapshots_for_account_in_range(
            account_id,
            start_date,
            end_date,
            std::slice::from_ref(&new_snapshot),
        )
        .await
        .expect("Failed to overwrite in range");

        // Should have 2 snapshots: preserved CSV + new calculated
        let final_snapshots = repo
            .get_snapshots_by_account(account_id, None, None)
            .expect("Failed to get final snapshots");
        assert_eq!(final_snapshots.len(), 2, "Should have 2 snapshots");

        // Verify CSV is preserved
        let csv_preserved = final_snapshots
            .iter()
            .any(|s| s.source == SnapshotSource::CsvImport);
        assert!(csv_preserved, "CSV import snapshot should be preserved");
    }

    #[tokio::test]
    async fn test_update_snapshots_source() {
        let (repo, pool, _temp_dir) = create_test_repository().await;
        let account_id = "test-account-3";
        create_test_account(&pool, account_id);

        // Create calculated snapshots
        let snapshot1 = create_test_snapshot(
            account_id,
            NaiveDate::from_ymd_opt(2024, 1, 1).unwrap(),
            SnapshotSource::Calculated,
        );
        let snapshot2 = create_test_snapshot(
            account_id,
            NaiveDate::from_ymd_opt(2024, 1, 2).unwrap(),
            SnapshotSource::Calculated,
        );

        repo.save_snapshots(&[snapshot1, snapshot2])
            .await
            .expect("Failed to save snapshots");

        // Update source to MANUAL_ENTRY
        let updated_count = repo
            .update_snapshots_source(account_id, "MANUAL_ENTRY")
            .await
            .expect("Failed to update source");

        assert_eq!(updated_count, 2, "Should update 2 snapshots");

        // Verify source was updated
        let snapshots = repo
            .get_snapshots_by_account(account_id, None, None)
            .expect("Failed to get snapshots");

        for snapshot in &snapshots {
            assert_eq!(
                snapshot.source,
                SnapshotSource::ManualEntry,
                "Source should be updated to ManualEntry"
            );
        }
    }

    #[tokio::test]
    async fn test_rebuild_only_deletes_calculated_not_broker() {
        let (repo, pool, _temp_dir) = create_test_repository().await;
        let account_id = "test-account-4";
        create_test_account(&pool, account_id);

        // Simulate broker-imported holdings
        let broker1 = create_test_snapshot(
            account_id,
            NaiveDate::from_ymd_opt(2024, 1, 1).unwrap(),
            SnapshotSource::BrokerImported,
        );
        let broker2 = create_test_snapshot(
            account_id,
            NaiveDate::from_ymd_opt(2024, 1, 2).unwrap(),
            SnapshotSource::BrokerImported,
        );
        // Old calculated that should be replaced
        let old_calculated = create_test_snapshot(
            account_id,
            NaiveDate::from_ymd_opt(2024, 1, 3).unwrap(),
            SnapshotSource::Calculated,
        );

        repo.save_snapshots(&[broker1.clone(), broker2.clone(), old_calculated])
            .await
            .expect("Failed to save initial");

        // Rebuild with new calculated snapshots
        let new_calculated = create_test_snapshot(
            account_id,
            NaiveDate::from_ymd_opt(2024, 1, 3).unwrap(),
            SnapshotSource::Calculated,
        );

        repo.overwrite_all_snapshots_for_account(account_id, std::slice::from_ref(&new_calculated))
            .await
            .expect("Failed to rebuild");

        let final_snapshots = repo
            .get_snapshots_by_account(account_id, None, None)
            .expect("Failed to get final");

        // Should have 3: broker1, broker2, new_calculated
        assert_eq!(final_snapshots.len(), 3);

        // Verify broker snapshots preserved
        let broker_count = final_snapshots
            .iter()
            .filter(|s| s.source == SnapshotSource::BrokerImported)
            .count();
        assert_eq!(broker_count, 2, "Both broker snapshots should be preserved");
    }

    #[tokio::test]
    async fn test_delete_calculated_snapshots_in_range() {
        let (repo, pool, _temp_dir) = create_test_repository().await;
        let account_id = "test-account-5";
        create_test_account(&pool, account_id);

        // Create mix of snapshots
        let calc1 = create_test_snapshot(
            account_id,
            NaiveDate::from_ymd_opt(2024, 1, 10).unwrap(),
            SnapshotSource::Calculated,
        );
        let manual = create_test_snapshot(
            account_id,
            NaiveDate::from_ymd_opt(2024, 1, 15).unwrap(),
            SnapshotSource::ManualEntry,
        );
        let calc2 = create_test_snapshot(
            account_id,
            NaiveDate::from_ymd_opt(2024, 1, 20).unwrap(),
            SnapshotSource::Calculated,
        );

        repo.save_snapshots(&[calc1, manual.clone(), calc2])
            .await
            .expect("Failed to save");

        // Delete calculated in range
        let deleted = repo
            .delete_calculated_snapshots_for_account_in_range(
                account_id,
                NaiveDate::from_ymd_opt(2024, 1, 1).unwrap(),
                NaiveDate::from_ymd_opt(2024, 1, 31).unwrap(),
            )
            .await
            .expect("Failed to delete");

        assert_eq!(deleted, 2, "Should delete 2 calculated snapshots");

        // Verify only manual remains
        let remaining = repo
            .get_snapshots_by_account(account_id, None, None)
            .expect("Failed to get");

        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].source, SnapshotSource::ManualEntry);
    }

    // ==================== Tests for Holdings Mode Snapshot Rules ====================

    #[tokio::test]
    async fn test_get_non_calculated_snapshot_count_empty() {
        let (repo, pool, _temp_dir) = create_test_repository().await;
        let account_id = "test-account-count-1";
        create_test_account(&pool, account_id);

        let count = repo
            .get_non_calculated_snapshot_count(account_id)
            .expect("Failed to get count");
        assert_eq!(count, 0, "Should have 0 non-calculated snapshots");
    }

    #[tokio::test]
    async fn test_get_non_calculated_snapshot_count_only_calculated() {
        let (repo, pool, _temp_dir) = create_test_repository().await;
        let account_id = "test-account-count-2";
        create_test_account(&pool, account_id);

        // Add only calculated snapshots
        let calc1 = create_test_snapshot(
            account_id,
            NaiveDate::from_ymd_opt(2024, 1, 1).unwrap(),
            SnapshotSource::Calculated,
        );
        let calc2 = create_test_snapshot(
            account_id,
            NaiveDate::from_ymd_opt(2024, 1, 2).unwrap(),
            SnapshotSource::Calculated,
        );

        repo.save_snapshots(&[calc1, calc2])
            .await
            .expect("Failed to save");

        let count = repo
            .get_non_calculated_snapshot_count(account_id)
            .expect("Failed to get count");
        assert_eq!(count, 0, "Calculated snapshots should not be counted");
    }

    #[tokio::test]
    async fn test_get_non_calculated_snapshot_count_mixed() {
        let (repo, pool, _temp_dir) = create_test_repository().await;
        let account_id = "test-account-count-3";
        create_test_account(&pool, account_id);

        // Add mix of sources
        let calc = create_test_snapshot(
            account_id,
            NaiveDate::from_ymd_opt(2024, 1, 1).unwrap(),
            SnapshotSource::Calculated,
        );
        let manual = create_test_snapshot(
            account_id,
            NaiveDate::from_ymd_opt(2024, 1, 2).unwrap(),
            SnapshotSource::ManualEntry,
        );
        let broker = create_test_snapshot(
            account_id,
            NaiveDate::from_ymd_opt(2024, 1, 3).unwrap(),
            SnapshotSource::BrokerImported,
        );
        let synthetic = create_test_snapshot(
            account_id,
            NaiveDate::from_ymd_opt(2024, 1, 4).unwrap(),
            SnapshotSource::Synthetic,
        );

        repo.save_snapshots(&[calc, manual, broker, synthetic])
            .await
            .expect("Failed to save");

        let count = repo
            .get_non_calculated_snapshot_count(account_id)
            .expect("Failed to get count");
        assert_eq!(
            count, 3,
            "Should count ManualEntry, BrokerImported, Synthetic"
        );
    }

    #[tokio::test]
    async fn test_get_earliest_non_calculated_snapshot_empty() {
        let (repo, pool, _temp_dir) = create_test_repository().await;
        let account_id = "test-account-earliest-1";
        create_test_account(&pool, account_id);

        let earliest = repo
            .get_earliest_non_calculated_snapshot(account_id)
            .expect("Failed to get earliest");
        assert!(
            earliest.is_none(),
            "Should return None when no snapshots exist"
        );
    }

    #[tokio::test]
    async fn test_get_earliest_non_calculated_snapshot_only_calculated() {
        let (repo, pool, _temp_dir) = create_test_repository().await;
        let account_id = "test-account-earliest-2";
        create_test_account(&pool, account_id);

        let calc = create_test_snapshot(
            account_id,
            NaiveDate::from_ymd_opt(2024, 1, 1).unwrap(),
            SnapshotSource::Calculated,
        );

        repo.save_snapshots(&[calc]).await.expect("Failed to save");

        let earliest = repo
            .get_earliest_non_calculated_snapshot(account_id)
            .expect("Failed to get earliest");
        assert!(
            earliest.is_none(),
            "Should return None when only calculated exist"
        );
    }

    #[tokio::test]
    async fn test_get_earliest_non_calculated_snapshot_returns_earliest() {
        let (repo, pool, _temp_dir) = create_test_repository().await;
        let account_id = "test-account-earliest-3";
        create_test_account(&pool, account_id);

        // Add snapshots in non-chronological order
        let later_broker = create_test_snapshot(
            account_id,
            NaiveDate::from_ymd_opt(2024, 3, 15).unwrap(),
            SnapshotSource::BrokerImported,
        );
        let earliest_manual = create_test_snapshot(
            account_id,
            NaiveDate::from_ymd_opt(2024, 1, 10).unwrap(),
            SnapshotSource::ManualEntry,
        );
        let middle_synthetic = create_test_snapshot(
            account_id,
            NaiveDate::from_ymd_opt(2024, 2, 20).unwrap(),
            SnapshotSource::Synthetic,
        );
        let calc = create_test_snapshot(
            account_id,
            NaiveDate::from_ymd_opt(2024, 1, 1).unwrap(), // Earlier than manual but should be ignored
            SnapshotSource::Calculated,
        );

        repo.save_snapshots(&[
            later_broker,
            earliest_manual.clone(),
            middle_synthetic,
            calc,
        ])
        .await
        .expect("Failed to save");

        let earliest = repo
            .get_earliest_non_calculated_snapshot(account_id)
            .expect("Failed to get earliest")
            .expect("Should return Some");

        assert_eq!(
            earliest.snapshot_date,
            NaiveDate::from_ymd_opt(2024, 1, 10).unwrap(),
            "Should return the earliest non-calculated snapshot"
        );
        assert_eq!(earliest.source, SnapshotSource::ManualEntry);
    }

    #[tokio::test]
    async fn test_outbox_emits_only_for_user_managed_snapshot_sources() {
        let (repo, pool, _temp_dir) = create_test_repository().await;
        let account_id = "test-account-outbox-1";
        create_test_account(&pool, account_id);

        let manual = create_test_snapshot(
            account_id,
            NaiveDate::from_ymd_opt(2024, 4, 1).unwrap(),
            SnapshotSource::ManualEntry,
        );
        let broker = create_test_snapshot(
            account_id,
            NaiveDate::from_ymd_opt(2024, 4, 2).unwrap(),
            SnapshotSource::BrokerImported,
        );
        let csv = create_test_snapshot(
            account_id,
            NaiveDate::from_ymd_opt(2024, 4, 3).unwrap(),
            SnapshotSource::CsvImport,
        );
        let synthetic = create_test_snapshot(
            account_id,
            NaiveDate::from_ymd_opt(2024, 4, 4).unwrap(),
            SnapshotSource::Synthetic,
        );

        repo.save_or_update_snapshot(&manual)
            .await
            .expect("save manual snapshot");
        repo.save_or_update_snapshot(&broker)
            .await
            .expect("save broker snapshot");
        repo.save_or_update_snapshot(&csv)
            .await
            .expect("save csv snapshot");
        repo.save_or_update_snapshot(&synthetic)
            .await
            .expect("save synthetic snapshot");

        assert_eq!(
            count_pending_outbox(&pool),
            3,
            "Only manual/csv/synthetic snapshots should be enqueued"
        );
    }
}
