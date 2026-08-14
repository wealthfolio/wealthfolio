use async_trait::async_trait;
use chrono::{NaiveDate, Utc};
use diesel::prelude::*;
use diesel::r2d2::{ConnectionManager, Pool};
use diesel::sqlite::SqliteConnection;
use log::debug;
use std::collections::HashMap;
use std::sync::Arc;

use super::model::{QuoteSyncStateDB, QuoteSyncStateUpdateDB};
use crate::db::{get_connection, WriteHandle};
use crate::errors::StorageError;
use crate::schema::quote_sync_state::dsl as qss_dsl;
use crate::utils::chunk_for_sqlite;
use wealthfolio_core::quotes::{
    profile_enrichment_cutoff, profile_enrichment_ttl, ProviderSyncStats, QuoteSyncState,
    SyncStateStore,
};
use wealthfolio_core::Result;

pub struct QuoteSyncStateRepository {
    pool: Arc<Pool<ConnectionManager<SqliteConnection>>>,
    writer: WriteHandle,
}

impl QuoteSyncStateRepository {
    pub fn new(pool: Arc<Pool<ConnectionManager<SqliteConnection>>>, writer: WriteHandle) -> Self {
        Self { pool, writer }
    }
}

#[async_trait]
impl SyncStateStore for QuoteSyncStateRepository {
    fn get_provider_sync_stats(&self) -> Result<Vec<ProviderSyncStats>> {
        use diesel::sql_types::{BigInt, Nullable, Text};

        #[derive(QueryableByName)]
        struct ProviderSyncStatsRow {
            #[diesel(sql_type = Text)]
            provider_id: String,
            #[diesel(sql_type = BigInt)]
            asset_count: i64,
            #[diesel(sql_type = BigInt)]
            error_count: i64,
            #[diesel(sql_type = Nullable<Text>)]
            last_synced_at: Option<String>,
            #[diesel(sql_type = Nullable<Text>)]
            last_error: Option<String>,
            #[diesel(sql_type = Nullable<Text>)]
            unique_errors: Option<String>,
        }

        let mut conn = get_connection(&self.pool)?;

        let results: Vec<ProviderSyncStatsRow> = diesel::sql_query(
            r#"
            SELECT
                data_source as provider_id,
                COUNT(*) as asset_count,
                SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) as error_count,
                MAX(last_synced_at) as last_synced_at,
                (
                    SELECT qss2.last_error
                    FROM quote_sync_state qss2
                    WHERE qss2.data_source = quote_sync_state.data_source
                      AND qss2.last_error IS NOT NULL
                    ORDER BY qss2.updated_at DESC
                    LIMIT 1
                ) as last_error,
                (
                    SELECT GROUP_CONCAT(DISTINCT qss3.last_error)
                    FROM quote_sync_state qss3
                    WHERE qss3.data_source = quote_sync_state.data_source
                      AND qss3.last_error IS NOT NULL
                ) as unique_errors
            FROM quote_sync_state
            GROUP BY data_source
            ORDER BY data_source
            "#,
        )
        .load(&mut conn)
        .map_err(StorageError::from)?;

        Ok(results
            .into_iter()
            .map(|row| {
                let last_synced_at = row
                    .last_synced_at
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok())
                    .map(|dt| dt.with_timezone(&Utc));

                // GROUP_CONCAT uses comma as default separator
                let unique_errors: Vec<String> = row
                    .unique_errors
                    .map(|s| s.split(',').map(|e| e.trim().to_string()).collect())
                    .unwrap_or_default();

                ProviderSyncStats {
                    provider_id: row.provider_id,
                    asset_count: row.asset_count,
                    error_count: row.error_count,
                    last_synced_at,
                    last_error: row.last_error,
                    unique_errors,
                }
            })
            .collect())
    }

    fn get_all(&self) -> Result<Vec<QuoteSyncState>> {
        let mut conn = get_connection(&self.pool)?;

        let results = qss_dsl::quote_sync_state
            .order(qss_dsl::sync_priority.desc())
            .load::<QuoteSyncStateDB>(&mut conn)
            .map_err(StorageError::from)?;

        Ok(results.into_iter().map(QuoteSyncState::from).collect())
    }

    fn get_by_asset_id(&self, asset_id: &str) -> Result<Option<QuoteSyncState>> {
        let mut conn = get_connection(&self.pool)?;

        let result = qss_dsl::quote_sync_state
            .filter(qss_dsl::asset_id.eq(asset_id))
            .first::<QuoteSyncStateDB>(&mut conn)
            .optional()
            .map_err(StorageError::from)?;

        Ok(result.map(QuoteSyncState::from))
    }

    fn get_by_asset_ids(&self, asset_ids: &[String]) -> Result<HashMap<String, QuoteSyncState>> {
        if asset_ids.is_empty() {
            return Ok(HashMap::new());
        }

        let mut conn = get_connection(&self.pool)?;
        let mut result_map = HashMap::new();

        // Chunk the asset_ids to avoid SQLite parameter limits
        for chunk in chunk_for_sqlite(asset_ids) {
            let results = qss_dsl::quote_sync_state
                .filter(qss_dsl::asset_id.eq_any(chunk))
                .load::<QuoteSyncStateDB>(&mut conn)
                .map_err(StorageError::from)?;

            for db in results {
                let state = QuoteSyncState::from(db);
                result_map.insert(state.asset_id.clone(), state);
            }
        }

        Ok(result_map)
    }

    fn get_active_assets(&self) -> Result<Vec<QuoteSyncState>> {
        let mut conn = get_connection(&self.pool)?;

        // Active = position_closed_date IS NULL
        let results = qss_dsl::quote_sync_state
            .filter(qss_dsl::position_closed_date.is_null())
            .order(qss_dsl::sync_priority.desc())
            .load::<QuoteSyncStateDB>(&mut conn)
            .map_err(StorageError::from)?;

        Ok(results.into_iter().map(QuoteSyncState::from).collect())
    }

    fn get_assets_needing_sync(&self, grace_period_days: i64) -> Result<Vec<QuoteSyncState>> {
        let mut conn = get_connection(&self.pool)?;
        let today = Utc::now().date_naive();
        let grace_cutoff = today - chrono::Duration::days(grace_period_days);
        let grace_cutoff_str = grace_cutoff.format("%Y-%m-%d").to_string();

        // Get active assets (position_closed_date IS NULL) OR recently closed assets (within grace period)
        let results = qss_dsl::quote_sync_state
            .filter(
                qss_dsl::position_closed_date
                    .is_null()
                    .or(qss_dsl::position_closed_date.ge(&grace_cutoff_str)),
            )
            .order(qss_dsl::sync_priority.desc())
            .load::<QuoteSyncStateDB>(&mut conn)
            .map_err(StorageError::from)?;

        Ok(results.into_iter().map(QuoteSyncState::from).collect())
    }

    async fn upsert(&self, state: &QuoteSyncState) -> Result<QuoteSyncState> {
        let db_state = QuoteSyncStateDB::from(state);

        self.writer
            .exec(
                move |conn: &mut SqliteConnection| -> Result<QuoteSyncState> {
                    diesel::replace_into(qss_dsl::quote_sync_state)
                        .values(&db_state)
                        .execute(conn)
                        .map_err(StorageError::from)?;

                    let result = qss_dsl::quote_sync_state
                        .filter(qss_dsl::asset_id.eq(&db_state.asset_id))
                        .first::<QuoteSyncStateDB>(conn)
                        .map_err(StorageError::from)?;

                    Ok(QuoteSyncState::from(result))
                },
            )
            .await
    }

    async fn upsert_batch(&self, states: &[QuoteSyncState]) -> Result<usize> {
        if states.is_empty() {
            return Ok(0);
        }

        let db_states: Vec<QuoteSyncStateDB> = states.iter().map(QuoteSyncStateDB::from).collect();

        self.writer
            .exec(move |conn: &mut SqliteConnection| -> Result<usize> {
                let mut total = 0;
                for chunk in db_states.chunks(500) {
                    total += diesel::replace_into(qss_dsl::quote_sync_state)
                        .values(chunk)
                        .execute(conn)
                        .map_err(StorageError::from)?;
                }
                Ok(total)
            })
            .await
    }

    async fn update_after_sync(&self, asset_id: &str) -> Result<()> {
        let asset_id_owned = asset_id.to_string();
        let now = Utc::now().to_rfc3339();

        self.writer
            .exec(move |conn: &mut SqliteConnection| -> Result<()> {
                let update = QuoteSyncStateUpdateDB {
                    last_synced_at: Some(Some(now.clone())),
                    error_count: Some(0),
                    last_error: Some(None),
                    updated_at: Some(now),
                    ..Default::default()
                };

                diesel::update(
                    qss_dsl::quote_sync_state.filter(qss_dsl::asset_id.eq(&asset_id_owned)),
                )
                .set(&update)
                .execute(conn)
                .map_err(StorageError::from)?;

                Ok(())
            })
            .await
    }

    async fn update_after_failure(&self, asset_id: &str, error: &str) -> Result<()> {
        let asset_id_owned = asset_id.to_string();
        let error_owned = error.to_string();
        let now = Utc::now().to_rfc3339();

        self.writer
            .exec(move |conn: &mut SqliteConnection| -> Result<()> {
                // First get current error count
                let current: Option<QuoteSyncStateDB> = qss_dsl::quote_sync_state
                    .filter(qss_dsl::asset_id.eq(&asset_id_owned))
                    .first(conn)
                    .optional()
                    .map_err(StorageError::from)?;

                let new_error_count = current.map(|s| s.error_count + 1).unwrap_or(1);

                let update = QuoteSyncStateUpdateDB {
                    error_count: Some(new_error_count),
                    last_error: Some(Some(error_owned)),
                    updated_at: Some(now),
                    ..Default::default()
                };

                diesel::update(
                    qss_dsl::quote_sync_state.filter(qss_dsl::asset_id.eq(&asset_id_owned)),
                )
                .set(&update)
                .execute(conn)
                .map_err(StorageError::from)?;

                Ok(())
            })
            .await
    }

    async fn mark_inactive(&self, asset_id: &str, closed_date: NaiveDate) -> Result<()> {
        let asset_id_owned = asset_id.to_string();
        let closed_date_str = closed_date.format("%Y-%m-%d").to_string();
        let now = Utc::now().to_rfc3339();

        debug!(
            "Marking asset {} as inactive (closed: {})",
            asset_id, closed_date
        );

        self.writer
            .exec(move |conn: &mut SqliteConnection| -> Result<()> {
                // Setting position_closed_date marks the asset as inactive
                let update = QuoteSyncStateUpdateDB {
                    position_closed_date: Some(Some(closed_date_str)),
                    sync_priority: Some(50), // RecentlyClosed priority
                    updated_at: Some(now),
                    ..Default::default()
                };

                diesel::update(
                    qss_dsl::quote_sync_state.filter(qss_dsl::asset_id.eq(&asset_id_owned)),
                )
                .set(&update)
                .execute(conn)
                .map_err(StorageError::from)?;

                Ok(())
            })
            .await
    }

    async fn mark_inactive_batch(
        &self,
        asset_ids: &[String],
        closed_date: NaiveDate,
    ) -> Result<()> {
        if asset_ids.is_empty() {
            return Ok(());
        }

        let asset_ids = asset_ids.to_vec();
        let closed_date_str = closed_date.format("%Y-%m-%d").to_string();
        let now = Utc::now().to_rfc3339();

        self.writer
            .exec(move |conn: &mut SqliteConnection| -> Result<()> {
                for chunk in chunk_for_sqlite(&asset_ids) {
                    let update = QuoteSyncStateUpdateDB {
                        position_closed_date: Some(Some(closed_date_str.clone())),
                        sync_priority: Some(50), // RecentlyClosed priority
                        updated_at: Some(now.clone()),
                        ..Default::default()
                    };

                    diesel::update(
                        qss_dsl::quote_sync_state.filter(qss_dsl::asset_id.eq_any(chunk)),
                    )
                    .set(&update)
                    .execute(conn)
                    .map_err(StorageError::from)?;
                }

                Ok(())
            })
            .await
    }

    async fn mark_active(&self, asset_id: &str) -> Result<()> {
        let asset_id_owned = asset_id.to_string();
        let now = Utc::now().to_rfc3339();

        debug!("Marking asset {} as active", asset_id);

        self.writer
            .exec(move |conn: &mut SqliteConnection| -> Result<()> {
                // Clearing position_closed_date marks the asset as active
                let update = QuoteSyncStateUpdateDB {
                    position_closed_date: Some(None),
                    sync_priority: Some(100), // Active priority
                    updated_at: Some(now),
                    ..Default::default()
                };

                diesel::update(
                    qss_dsl::quote_sync_state.filter(qss_dsl::asset_id.eq(&asset_id_owned)),
                )
                .set(&update)
                .execute(conn)
                .map_err(StorageError::from)?;

                Ok(())
            })
            .await
    }

    async fn mark_active_batch(&self, asset_ids: &[String]) -> Result<()> {
        if asset_ids.is_empty() {
            return Ok(());
        }

        let asset_ids = asset_ids.to_vec();
        let now = Utc::now().to_rfc3339();

        self.writer
            .exec(move |conn: &mut SqliteConnection| -> Result<()> {
                for chunk in chunk_for_sqlite(&asset_ids) {
                    let update = QuoteSyncStateUpdateDB {
                        position_closed_date: Some(None),
                        sync_priority: Some(100), // Active priority
                        updated_at: Some(now.clone()),
                        ..Default::default()
                    };

                    diesel::update(
                        qss_dsl::quote_sync_state.filter(qss_dsl::asset_id.eq_any(chunk)),
                    )
                    .set(&update)
                    .execute(conn)
                    .map_err(StorageError::from)?;
                }

                Ok(())
            })
            .await
    }

    async fn delete(&self, asset_id: &str) -> Result<()> {
        let asset_id_owned = asset_id.to_string();

        self.writer
            .exec(move |conn: &mut SqliteConnection| -> Result<()> {
                diesel::delete(
                    qss_dsl::quote_sync_state.filter(qss_dsl::asset_id.eq(&asset_id_owned)),
                )
                .execute(conn)
                .map_err(StorageError::from)?;
                Ok(())
            })
            .await
    }

    async fn delete_all(&self) -> Result<usize> {
        self.writer
            .exec(move |conn: &mut SqliteConnection| -> Result<usize> {
                let count = diesel::delete(qss_dsl::quote_sync_state)
                    .execute(conn)
                    .map_err(StorageError::from)?;
                Ok(count)
            })
            .await
    }

    async fn mark_profile_enriched(&self, asset_id: &str) -> Result<()> {
        let asset_id_owned = asset_id.to_string();
        let now = Utc::now().to_rfc3339();

        debug!("Marking profile enriched for asset {}", asset_id);

        self.writer
            .exec(move |conn: &mut SqliteConnection| -> Result<()> {
                let update = QuoteSyncStateUpdateDB {
                    profile_enriched_at: Some(Some(now.clone())),
                    updated_at: Some(now),
                    ..Default::default()
                };

                diesel::update(
                    qss_dsl::quote_sync_state.filter(qss_dsl::asset_id.eq(&asset_id_owned)),
                )
                .set(&update)
                .execute(conn)
                .map_err(StorageError::from)?;

                Ok(())
            })
            .await
    }

    fn get_assets_needing_profile_enrichment(&self) -> Result<Vec<QuoteSyncState>> {
        let mut conn = get_connection(&self.pool)?;

        // Assets never enriched, plus those whose profile has aged past the TTL.
        // The cutoff must match `QuoteSyncState::needs_profile_enrichment`, which
        // `enrich_assets` re-applies to every id this returns — if the two diverge,
        // selected assets are silently skipped and nothing ever refreshes.
        //
        // `profile_enriched_at` is stored as RFC3339 in UTC, so lexicographic
        // comparison matches chronological order (same pattern as the
        // `position_closed_date` grace cutoff above).
        let cutoff = profile_enrichment_cutoff(Utc::now(), profile_enrichment_ttl())
            .map(|cutoff| cutoff.to_rfc3339())
            // TTL disabled: an empty cutoff sorts below every RFC3339 timestamp, so
            // the `le` arm matches nothing and only never-enriched rows are returned
            // — the legacy one-shot behaviour, with one query shape instead of two.
            .unwrap_or_default();

        let results = qss_dsl::quote_sync_state
            .filter(
                qss_dsl::profile_enriched_at
                    .is_null()
                    .or(qss_dsl::profile_enriched_at.le(cutoff)),
            )
            .order(qss_dsl::sync_priority.desc())
            .load::<QuoteSyncStateDB>(&mut conn)
            .map_err(StorageError::from)?;

        Ok(results.into_iter().map(QuoteSyncState::from).collect())
    }

    fn get_with_errors(&self) -> Result<Vec<QuoteSyncState>> {
        let mut conn = get_connection(&self.pool)?;

        // Get sync states where error_count > 0
        let results = qss_dsl::quote_sync_state
            .filter(qss_dsl::error_count.gt(0))
            .order(qss_dsl::error_count.desc())
            .load::<QuoteSyncStateDB>(&mut conn)
            .map_err(StorageError::from)?;

        Ok(results.into_iter().map(QuoteSyncState::from).collect())
    }
}
