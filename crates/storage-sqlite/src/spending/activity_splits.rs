//! Storage adapter for spending::activity_splits.

use std::str::FromStr;
use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use chrono::NaiveDateTime;
use diesel::prelude::*;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::db::{get_connection, write_actor::DbWriteTx, DbPool, WriteHandle};
use crate::errors::StorageError;
use crate::schema::{activity_taxonomy_assignments, spending_activity_splits, taxonomy_categories};
use crate::spending::activity_assignments::ActivityTaxonomyAssignmentDB;
use crate::spending::activity_sync::should_sync_activity_local_id_outbox;
use wealthfolio_core::sync::SyncEntity;
use wealthfolio_spending::activity_splits::{
    ActivitySplit, ActivitySplitRepositoryTrait, NewActivitySplit,
};

#[derive(Queryable, Identifiable, Selectable, Serialize, Deserialize, Debug, Clone)]
#[diesel(table_name = crate::schema::spending_activity_splits)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct ActivitySplitDB {
    pub id: String,
    pub activity_id: String,
    pub taxonomy_id: String,
    pub category_id: String,
    pub amount: String,
    pub note: Option<String>,
    pub sort_order: i32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Insertable, Serialize, Deserialize, Debug, Clone)]
#[diesel(table_name = crate::schema::spending_activity_splits)]
pub struct NewActivitySplitDB {
    pub id: String,
    pub activity_id: String,
    pub taxonomy_id: String,
    pub category_id: String,
    pub amount: String,
    pub note: Option<String>,
    pub sort_order: i32,
    pub created_at: String,
    pub updated_at: String,
}

impl crate::sync::SyncOutboxModel for ActivitySplitDB {
    const ENTITY: SyncEntity = SyncEntity::SpendingActivitySplit;

    fn sync_entity_id(&self) -> &str {
        &self.id
    }
}

fn parse_dt(s: &str) -> NaiveDateTime {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.naive_utc())
        .unwrap_or_else(|_| chrono::Utc::now().naive_utc())
}

impl From<ActivitySplitDB> for ActivitySplit {
    fn from(db: ActivitySplitDB) -> Self {
        Self {
            id: db.id,
            activity_id: db.activity_id,
            taxonomy_id: db.taxonomy_id,
            category_id: db.category_id,
            amount: Decimal::from_str(&db.amount).unwrap_or(Decimal::ZERO),
            note: db.note,
            sort_order: db.sort_order,
            created_at: parse_dt(&db.created_at),
            updated_at: parse_dt(&db.updated_at),
        }
    }
}

pub struct ActivitySplitRepository {
    pool: Arc<DbPool>,
    writer: WriteHandle,
}

impl ActivitySplitRepository {
    pub fn new(pool: Arc<DbPool>, writer: WriteHandle) -> Self {
        Self { pool, writer }
    }
}

fn replace_splits_for_activity_tx(
    tx: &mut DbWriteTx<'_>,
    activity_id: &str,
    splits: Vec<NewActivitySplit>,
    now: &str,
) -> wealthfolio_core::Result<Vec<ActivitySplitDB>> {
    let existing_ids = spending_activity_splits::table
        .filter(spending_activity_splits::activity_id.eq(activity_id))
        .select(spending_activity_splits::id)
        .load::<String>(tx.conn())
        .map_err(StorageError::from)?;
    let should_sync = should_sync_activity_local_id_outbox(tx.conn(), activity_id)?;

    diesel::delete(
        spending_activity_splits::table
            .filter(spending_activity_splits::activity_id.eq(activity_id)),
    )
    .execute(tx.conn())
    .map_err(StorageError::from)?;

    let rows = splits
        .into_iter()
        .enumerate()
        .map(|(index, split)| NewActivitySplitDB {
            id: Uuid::new_v4().to_string(),
            activity_id: activity_id.to_string(),
            taxonomy_id: split.taxonomy_id,
            category_id: split.category_id,
            amount: split.amount.normalize().to_string(),
            note: split.note,
            sort_order: split.sort_order.unwrap_or(index as i32),
            created_at: now.to_string(),
            updated_at: now.to_string(),
        })
        .collect::<Vec<_>>();

    let mut inserted = Vec::with_capacity(rows.len());
    for row in rows {
        let inserted_row = diesel::insert_into(spending_activity_splits::table)
            .values(&row)
            .returning(ActivitySplitDB::as_returning())
            .get_result(tx.conn())
            .map_err(StorageError::from)?;
        inserted.push(inserted_row);
    }

    if should_sync {
        for id in existing_ids {
            tx.delete::<ActivitySplitDB>(id);
        }
        for row in &inserted {
            tx.insert(row)?;
        }
    }

    Ok(inserted)
}

fn clear_assignment_for_taxonomy_tx(
    tx: &mut DbWriteTx<'_>,
    activity_id: &str,
    taxonomy_id: &str,
) -> wealthfolio_core::Result<()> {
    let existing_ids = activity_taxonomy_assignments::table
        .filter(activity_taxonomy_assignments::activity_id.eq(activity_id))
        .filter(activity_taxonomy_assignments::taxonomy_id.eq(taxonomy_id))
        .select(activity_taxonomy_assignments::id)
        .load::<String>(tx.conn())
        .map_err(StorageError::from)?;
    if existing_ids.is_empty() {
        return Ok(());
    }

    let should_sync = should_sync_activity_local_id_outbox(tx.conn(), activity_id)?;
    diesel::delete(
        activity_taxonomy_assignments::table
            .filter(activity_taxonomy_assignments::activity_id.eq(activity_id))
            .filter(activity_taxonomy_assignments::taxonomy_id.eq(taxonomy_id)),
    )
    .execute(tx.conn())
    .map_err(StorageError::from)?;

    if should_sync {
        for id in existing_ids {
            tx.delete::<ActivityTaxonomyAssignmentDB>(id);
        }
    }

    Ok(())
}

#[async_trait]
impl ActivitySplitRepositoryTrait for ActivitySplitRepository {
    async fn list_for_activity(&self, activity_id: &str) -> Result<Vec<ActivitySplit>> {
        let mut conn = get_connection(&self.pool).map_err(|e| anyhow::anyhow!(e))?;
        let rows = spending_activity_splits::table
            .filter(spending_activity_splits::activity_id.eq(activity_id))
            .order((
                spending_activity_splits::sort_order.asc(),
                spending_activity_splits::created_at.asc(),
                spending_activity_splits::id.asc(),
            ))
            .load::<ActivitySplitDB>(&mut conn)
            .map_err(StorageError::from)
            .map_err(|e| anyhow::anyhow!(e))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    async fn list_for_activities(&self, activity_ids: &[String]) -> Result<Vec<ActivitySplit>> {
        if activity_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut conn = get_connection(&self.pool).map_err(|e| anyhow::anyhow!(e))?;
        const CHUNK: usize = 500;
        let mut out = Vec::new();
        for chunk in activity_ids.chunks(CHUNK) {
            let rows = spending_activity_splits::table
                .filter(spending_activity_splits::activity_id.eq_any(chunk))
                .order((
                    spending_activity_splits::activity_id.asc(),
                    spending_activity_splits::sort_order.asc(),
                    spending_activity_splits::created_at.asc(),
                    spending_activity_splits::id.asc(),
                ))
                .load::<ActivitySplitDB>(&mut conn)
                .map_err(StorageError::from)
                .map_err(|e| anyhow::anyhow!(e))?;
            out.extend(rows.into_iter().map(ActivitySplit::from));
        }
        Ok(out)
    }

    async fn categories_belong_to_taxonomy(
        &self,
        taxonomy_id: &str,
        category_ids: &[String],
    ) -> Result<bool> {
        if category_ids.is_empty() {
            return Ok(true);
        }

        let unique = category_ids
            .iter()
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        let mut conn = get_connection(&self.pool).map_err(|e| anyhow::anyhow!(e))?;
        let matched = taxonomy_categories::table
            .filter(taxonomy_categories::taxonomy_id.eq(taxonomy_id))
            .filter(taxonomy_categories::id.eq_any(unique.iter().collect::<Vec<_>>()))
            .select(taxonomy_categories::id)
            .load::<String>(&mut conn)
            .map_err(StorageError::from)
            .map_err(|e| anyhow::anyhow!(e))?
            .into_iter()
            .collect::<std::collections::HashSet<_>>();

        Ok(matched.len() == unique.len())
    }

    async fn replace_for_activity(
        &self,
        activity_id: &str,
        splits: Vec<NewActivitySplit>,
    ) -> Result<Vec<ActivitySplit>> {
        let activity_id = activity_id.to_string();
        let now = chrono::Utc::now().to_rfc3339();
        self.writer
            .exec_tx(move |tx| replace_splits_for_activity_tx(tx, &activity_id, splits, &now))
            .await
            .map(|rows| rows.into_iter().map(ActivitySplit::from).collect())
            .map_err(|e| anyhow::anyhow!(e))
    }

    async fn replace_for_activity_clearing_assignment(
        &self,
        activity_id: &str,
        taxonomy_id: &str,
        splits: Vec<NewActivitySplit>,
    ) -> Result<Vec<ActivitySplit>> {
        let activity_id = activity_id.to_string();
        let taxonomy_id = taxonomy_id.to_string();
        let now = chrono::Utc::now().to_rfc3339();
        self.writer
            .exec_tx(move |tx| {
                clear_assignment_for_taxonomy_tx(tx, &activity_id, &taxonomy_id)?;
                replace_splits_for_activity_tx(tx, &activity_id, splits, &now)
            })
            .await
            .map(|rows| rows.into_iter().map(ActivitySplit::from).collect())
            .map_err(|e| anyhow::anyhow!(e))
    }

    async fn clear_for_activity(&self, activity_id: &str) -> Result<()> {
        let activity_id = activity_id.to_string();
        self.writer
            .exec_tx(move |tx| {
                let existing_ids = spending_activity_splits::table
                    .filter(spending_activity_splits::activity_id.eq(&activity_id))
                    .select(spending_activity_splits::id)
                    .load::<String>(tx.conn())
                    .map_err(StorageError::from)?;
                let should_sync = should_sync_activity_local_id_outbox(tx.conn(), &activity_id)?;

                diesel::delete(
                    spending_activity_splits::table
                        .filter(spending_activity_splits::activity_id.eq(&activity_id)),
                )
                .execute(tx.conn())
                .map_err(StorageError::from)?;

                if should_sync {
                    for id in existing_ids {
                        tx.delete::<ActivitySplitDB>(id);
                    }
                }
                Ok(())
            })
            .await
            .map_err(|e| anyhow::anyhow!(e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{create_pool, get_connection, init, run_migrations, write_actor::spawn_writer};
    use crate::schema::{activity_taxonomy_assignments, spending_activity_splits};
    use diesel::r2d2::{ConnectionManager, Pool};
    use rust_decimal::Decimal;
    use std::sync::Arc;
    use tempfile::tempdir;
    use wealthfolio_spending::activity_splits::{ActivitySplitRepositoryTrait, NewActivitySplit};

    fn setup_db() -> (Arc<Pool<ConnectionManager<SqliteConnection>>>, WriteHandle) {
        std::env::set_var("CONNECT_API_URL", "http://test.local");
        let app_data = tempdir()
            .expect("tempdir")
            .keep()
            .to_string_lossy()
            .to_string();
        let db_path = init(&app_data).expect("init db");
        run_migrations(&db_path).expect("migrate db");
        let pool = create_pool(&db_path).expect("create pool");
        let writer = spawn_writer(pool.as_ref().clone()).expect("spawn writer");
        (pool, writer)
    }

    fn insert_account_and_activity(conn: &mut SqliteConnection) {
        diesel::sql_query(
            "INSERT INTO accounts \
             (id, name, account_type, `group`, currency, is_default, is_active, created_at, updated_at, \
              platform_id, account_number, meta, provider, provider_account_id, is_archived, tracking_mode) \
             VALUES ('account-1', 'Account 1', 'cash', NULL, 'USD', 0, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, \
                     NULL, NULL, NULL, NULL, NULL, 0, 'portfolio')",
        )
        .execute(conn)
        .expect("insert account");

        diesel::sql_query(
            "INSERT INTO activities \
             (id, account_id, asset_id, activity_type, activity_type_override, source_type, subtype, \
              status, activity_date, settlement_date, quantity, unit_price, amount, fee, currency, \
              fx_rate, notes, metadata, source_system, source_record_id, source_group_id, \
              idempotency_key, import_run_id, is_user_modified, needs_review, created_at, updated_at) \
             VALUES ('activity-1', 'account-1', NULL, 'WITHDRAWAL', NULL, NULL, NULL, 'POSTED', \
                     '2026-01-01T00:00:00Z', NULL, NULL, NULL, '100', NULL, 'USD', NULL, \
                     NULL, NULL, 'MANUAL', 'activity-1-source-record', NULL, NULL, NULL, 0, 0, \
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        )
        .execute(conn)
        .expect("insert activity");
    }

    fn insert_assignment(conn: &mut SqliteConnection) {
        diesel::sql_query(
            "INSERT INTO activity_taxonomy_assignments \
             (id, activity_id, taxonomy_id, category_id, weight, source, created_at, updated_at) \
             VALUES ('assignment-1', 'activity-1', 'spending_categories', 'cat_food', 10000, 'manual', \
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        )
        .execute(conn)
        .expect("insert assignment");
    }

    #[tokio::test]
    async fn replacing_splits_clears_existing_assignment_in_same_write() {
        let (pool, writer) = setup_db();
        {
            let mut conn = get_connection(&pool).expect("conn");
            insert_account_and_activity(&mut conn);
            insert_assignment(&mut conn);
        }

        let repo = ActivitySplitRepository::new(pool.clone(), writer);
        repo.replace_for_activity_clearing_assignment(
            "activity-1",
            "spending_categories",
            vec![NewActivitySplit {
                taxonomy_id: "spending_categories".to_string(),
                category_id: "cat_groceries".to_string(),
                amount: Decimal::new(100, 0),
                note: None,
                sort_order: None,
            }],
        )
        .await
        .expect("replace splits");

        let mut conn = get_connection(&pool).expect("conn");
        assert_eq!(
            activity_taxonomy_assignments::table
                .count()
                .get_result::<i64>(&mut conn)
                .expect("count assignments"),
            0
        );
        assert_eq!(
            spending_activity_splits::table
                .count()
                .get_result::<i64>(&mut conn)
                .expect("count splits"),
            1
        );
    }
}
