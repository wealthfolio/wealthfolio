//! Storage adapter for spending::activity_assignments — Diesel impl over the
//! `activity_taxonomy_assignments` table.

use std::collections::HashSet;
use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use chrono::NaiveDateTime;
use diesel::prelude::*;
use serde::{Deserialize, Serialize};

use crate::db::{get_connection, write_actor::DbWriteTx, DbPool, WriteHandle};
use crate::errors::StorageError;
use crate::schema::{activity_taxonomy_assignments, spending_activity_splits};
use crate::spending::activity_splits::ActivitySplitDB;
use crate::spending::activity_sync::should_sync_activity_local_id_outbox;
use crate::spending::deterministic_ids::activity_taxonomy_assignment_id;
use wealthfolio_core::sync::SyncEntity;
use wealthfolio_spending::activity_assignments::{
    ActivityTaxonomyAssignment, ActivityTaxonomyAssignmentRepositoryTrait,
    NewActivityTaxonomyAssignment,
};

#[derive(
    Queryable, Identifiable, AsChangeset, Selectable, Serialize, Deserialize, Debug, Clone,
)]
#[diesel(table_name = crate::schema::activity_taxonomy_assignments)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct ActivityTaxonomyAssignmentDB {
    pub id: String,
    pub activity_id: String,
    pub taxonomy_id: String,
    pub category_id: String,
    pub weight: i32,
    pub source: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Insertable, Serialize, Deserialize, Debug, Clone)]
#[diesel(table_name = crate::schema::activity_taxonomy_assignments)]
pub struct NewActivityTaxonomyAssignmentDB {
    pub id: String,
    pub activity_id: String,
    pub taxonomy_id: String,
    pub category_id: String,
    pub weight: i32,
    pub source: String,
    pub created_at: String,
    pub updated_at: String,
}

impl crate::sync::SyncOutboxModel for ActivityTaxonomyAssignmentDB {
    const ENTITY: SyncEntity = SyncEntity::ActivityTaxonomyAssignment;
    fn sync_entity_id(&self) -> &str {
        &self.id
    }
}

fn parse_dt(s: &str) -> NaiveDateTime {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.naive_utc())
        .unwrap_or_else(|_| chrono::Utc::now().naive_utc())
}

impl From<ActivityTaxonomyAssignmentDB> for ActivityTaxonomyAssignment {
    fn from(db: ActivityTaxonomyAssignmentDB) -> Self {
        Self {
            id: db.id,
            activity_id: db.activity_id,
            taxonomy_id: db.taxonomy_id,
            category_id: db.category_id,
            weight: db.weight,
            source: db.source,
            created_at: parse_dt(&db.created_at),
            updated_at: parse_dt(&db.updated_at),
        }
    }
}

pub struct ActivityTaxonomyAssignmentRepository {
    pool: Arc<DbPool>,
    writer: WriteHandle,
}

impl ActivityTaxonomyAssignmentRepository {
    pub fn new(pool: Arc<DbPool>, writer: WriteHandle) -> Self {
        Self { pool, writer }
    }
}

fn clear_splits_for_activities_tx(
    tx: &mut DbWriteTx<'_>,
    activity_ids: &[String],
) -> wealthfolio_core::Result<()> {
    if activity_ids.is_empty() {
        return Ok(());
    }

    const CHUNK: usize = 500;
    for chunk in activity_ids.chunks(CHUNK) {
        let existing: Vec<(String, String)> = spending_activity_splits::table
            .filter(spending_activity_splits::activity_id.eq_any(chunk))
            .select((
                spending_activity_splits::id,
                spending_activity_splits::activity_id,
            ))
            .load(tx.conn())
            .map_err(StorageError::from)?;
        if existing.is_empty() {
            continue;
        }

        let mut sync_activity_ids = HashSet::new();
        for activity_id in existing
            .iter()
            .map(|(_, activity_id)| activity_id.as_str())
            .collect::<HashSet<_>>()
        {
            if should_sync_activity_local_id_outbox(tx.conn(), activity_id)? {
                sync_activity_ids.insert(activity_id.to_string());
            }
        }

        diesel::delete(
            spending_activity_splits::table
                .filter(spending_activity_splits::activity_id.eq_any(chunk)),
        )
        .execute(tx.conn())
        .map_err(StorageError::from)?;

        for (split_id, activity_id) in existing {
            if sync_activity_ids.contains(&activity_id) {
                tx.delete::<ActivitySplitDB>(split_id);
            }
        }
    }

    Ok(())
}

#[async_trait]
impl ActivityTaxonomyAssignmentRepositoryTrait for ActivityTaxonomyAssignmentRepository {
    async fn list_for_activity(
        &self,
        activity_id: &str,
    ) -> Result<Vec<ActivityTaxonomyAssignment>> {
        let mut conn = get_connection(&self.pool).map_err(|e| anyhow::anyhow!(e))?;
        let rows = activity_taxonomy_assignments::table
            .filter(activity_taxonomy_assignments::activity_id.eq(activity_id))
            .load::<ActivityTaxonomyAssignmentDB>(&mut conn)
            .map_err(StorageError::from)
            .map_err(|e| anyhow::anyhow!(e))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    async fn list_for_activities(
        &self,
        activity_ids: &[String],
    ) -> Result<Vec<ActivityTaxonomyAssignment>> {
        if activity_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut conn = get_connection(&self.pool).map_err(|e| anyhow::anyhow!(e))?;
        // SQLite has a default 999-parameter cap; chunk to stay safely under.
        const CHUNK: usize = 500;
        let mut out = Vec::new();
        for chunk in activity_ids.chunks(CHUNK) {
            let rows = activity_taxonomy_assignments::table
                .filter(activity_taxonomy_assignments::activity_id.eq_any(chunk))
                .load::<ActivityTaxonomyAssignmentDB>(&mut conn)
                .map_err(StorageError::from)
                .map_err(|e| anyhow::anyhow!(e))?;
            out.extend(rows.into_iter().map(ActivityTaxonomyAssignment::from));
        }
        Ok(out)
    }

    async fn upsert(
        &self,
        new: NewActivityTaxonomyAssignment,
    ) -> Result<ActivityTaxonomyAssignment> {
        let now = chrono::Utc::now().to_rfc3339();
        let NewActivityTaxonomyAssignment {
            id,
            activity_id,
            taxonomy_id,
            category_id,
            weight,
            source,
        } = new;
        let id = id.unwrap_or_else(|| activity_taxonomy_assignment_id(&activity_id, &taxonomy_id));
        let row = NewActivityTaxonomyAssignmentDB {
            id,
            activity_id,
            taxonomy_id,
            category_id,
            weight,
            source,
            created_at: now.clone(),
            updated_at: now,
        };

        self.writer
            .exec_tx(move |tx| {
                let result = diesel::insert_into(activity_taxonomy_assignments::table)
                    .values(&row)
                    .on_conflict((
                        activity_taxonomy_assignments::activity_id,
                        activity_taxonomy_assignments::taxonomy_id,
                    ))
                    .do_update()
                    .set((
                        activity_taxonomy_assignments::category_id.eq(&row.category_id),
                        activity_taxonomy_assignments::weight.eq(&row.weight),
                        activity_taxonomy_assignments::source.eq(&row.source),
                        activity_taxonomy_assignments::updated_at.eq(&row.updated_at),
                    ))
                    .returning(ActivityTaxonomyAssignmentDB::as_returning())
                    .get_result(tx.conn())
                    .map_err(StorageError::from)?;

                if should_sync_activity_local_id_outbox(tx.conn(), &result.activity_id)? {
                    tx.update(&result)?;
                }
                Ok(result)
            })
            .await
            .map(ActivityTaxonomyAssignment::from)
            .map_err(|e| anyhow::anyhow!(e))
    }

    async fn assign_many_single_select(
        &self,
        items: Vec<NewActivityTaxonomyAssignment>,
    ) -> Result<Vec<ActivityTaxonomyAssignment>> {
        if items.is_empty() {
            return Ok(Vec::new());
        }
        let now = chrono::Utc::now().to_rfc3339();
        let inserted_dbs: Vec<ActivityTaxonomyAssignmentDB> = self
            .writer
            .exec_tx(move |tx| {
                let mut out = Vec::with_capacity(items.len());
                for item in items {
                    let NewActivityTaxonomyAssignment {
                        id,
                        activity_id,
                        taxonomy_id,
                        category_id,
                        weight,
                        source,
                    } = item;
                    let existing_id = activity_taxonomy_assignments::table
                        .filter(activity_taxonomy_assignments::activity_id.eq(&activity_id))
                        .filter(activity_taxonomy_assignments::taxonomy_id.eq(&taxonomy_id))
                        .select(activity_taxonomy_assignments::id)
                        .first::<String>(tx.conn())
                        .optional()
                        .map_err(StorageError::from)?;

                    let id = id.unwrap_or_else(|| {
                        activity_taxonomy_assignment_id(&activity_id, &taxonomy_id)
                    });
                    let row = NewActivityTaxonomyAssignmentDB {
                        id,
                        activity_id,
                        taxonomy_id,
                        category_id,
                        weight,
                        source,
                        created_at: now.clone(),
                        updated_at: now.clone(),
                    };

                    let inserted = diesel::insert_into(activity_taxonomy_assignments::table)
                        .values(&row)
                        .on_conflict((
                            activity_taxonomy_assignments::activity_id,
                            activity_taxonomy_assignments::taxonomy_id,
                        ))
                        .do_update()
                        .set((
                            activity_taxonomy_assignments::category_id.eq(&row.category_id),
                            activity_taxonomy_assignments::weight.eq(&row.weight),
                            activity_taxonomy_assignments::source.eq(&row.source),
                            activity_taxonomy_assignments::updated_at.eq(&row.updated_at),
                        ))
                        .returning(ActivityTaxonomyAssignmentDB::as_returning())
                        .get_result::<ActivityTaxonomyAssignmentDB>(tx.conn())
                        .map_err(StorageError::from)?;

                    if should_sync_activity_local_id_outbox(tx.conn(), &inserted.activity_id)? {
                        if existing_id.is_some() {
                            tx.update(&inserted)?;
                        } else {
                            tx.insert(&inserted)?;
                        }
                    }
                    out.push(inserted);
                }
                Ok(out)
            })
            .await
            .map_err(|e| anyhow::anyhow!(e))?;

        Ok(inserted_dbs
            .into_iter()
            .map(ActivityTaxonomyAssignment::from)
            .collect())
    }

    async fn assign_many_single_select_clearing_splits(
        &self,
        items: Vec<NewActivityTaxonomyAssignment>,
    ) -> Result<Vec<ActivityTaxonomyAssignment>> {
        if items.is_empty() {
            return Ok(Vec::new());
        }

        let mut seen_activity_ids = HashSet::new();
        let activity_ids = items
            .iter()
            .filter_map(|item| {
                if seen_activity_ids.insert(item.activity_id.clone()) {
                    Some(item.activity_id.clone())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();

        let now = chrono::Utc::now().to_rfc3339();
        let inserted_dbs: Vec<ActivityTaxonomyAssignmentDB> = self
            .writer
            .exec_tx(move |tx| {
                clear_splits_for_activities_tx(tx, &activity_ids)?;

                let mut out = Vec::with_capacity(items.len());
                for item in items {
                    let NewActivityTaxonomyAssignment {
                        id,
                        activity_id,
                        taxonomy_id,
                        category_id,
                        weight,
                        source,
                    } = item;
                    let existing_id = activity_taxonomy_assignments::table
                        .filter(activity_taxonomy_assignments::activity_id.eq(&activity_id))
                        .filter(activity_taxonomy_assignments::taxonomy_id.eq(&taxonomy_id))
                        .select(activity_taxonomy_assignments::id)
                        .first::<String>(tx.conn())
                        .optional()
                        .map_err(StorageError::from)?;

                    let id = id.unwrap_or_else(|| {
                        activity_taxonomy_assignment_id(&activity_id, &taxonomy_id)
                    });
                    let row = NewActivityTaxonomyAssignmentDB {
                        id,
                        activity_id,
                        taxonomy_id,
                        category_id,
                        weight,
                        source,
                        created_at: now.clone(),
                        updated_at: now.clone(),
                    };

                    let inserted = diesel::insert_into(activity_taxonomy_assignments::table)
                        .values(&row)
                        .on_conflict((
                            activity_taxonomy_assignments::activity_id,
                            activity_taxonomy_assignments::taxonomy_id,
                        ))
                        .do_update()
                        .set((
                            activity_taxonomy_assignments::category_id.eq(&row.category_id),
                            activity_taxonomy_assignments::weight.eq(&row.weight),
                            activity_taxonomy_assignments::source.eq(&row.source),
                            activity_taxonomy_assignments::updated_at.eq(&row.updated_at),
                        ))
                        .returning(ActivityTaxonomyAssignmentDB::as_returning())
                        .get_result::<ActivityTaxonomyAssignmentDB>(tx.conn())
                        .map_err(StorageError::from)?;

                    if should_sync_activity_local_id_outbox(tx.conn(), &inserted.activity_id)? {
                        if existing_id.is_some() {
                            tx.update(&inserted)?;
                        } else {
                            tx.insert(&inserted)?;
                        }
                    }
                    out.push(inserted);
                }
                Ok(out)
            })
            .await
            .map_err(|e| anyhow::anyhow!(e))?;

        Ok(inserted_dbs
            .into_iter()
            .map(ActivityTaxonomyAssignment::from)
            .collect())
    }

    async fn assign_rule_many_single_select(
        &self,
        items: Vec<NewActivityTaxonomyAssignment>,
        only_uncategorized: bool,
    ) -> Result<Vec<ActivityTaxonomyAssignment>> {
        if items.is_empty() {
            return Ok(Vec::new());
        }
        let now = chrono::Utc::now().to_rfc3339();
        let inserted_dbs: Vec<ActivityTaxonomyAssignmentDB> = self
            .writer
            .exec_tx(move |tx| {
                let mut out = Vec::with_capacity(items.len());
                for item in items {
                    let NewActivityTaxonomyAssignment {
                        id,
                        activity_id,
                        taxonomy_id,
                        category_id,
                        weight,
                        source,
                    } = item;
                    let existing: Vec<ActivityTaxonomyAssignmentDB> =
                        activity_taxonomy_assignments::table
                            .filter(activity_taxonomy_assignments::activity_id.eq(&activity_id))
                            .filter(activity_taxonomy_assignments::taxonomy_id.eq(&taxonomy_id))
                            .load::<ActivityTaxonomyAssignmentDB>(tx.conn())
                            .map_err(StorageError::from)?;

                    if existing
                        .iter()
                        .any(|row| row.source.eq_ignore_ascii_case("manual"))
                    {
                        continue;
                    }
                    if only_uncategorized && !existing.is_empty() {
                        continue;
                    }

                    let had_existing = !existing.is_empty();
                    let id = id.unwrap_or_else(|| {
                        activity_taxonomy_assignment_id(&activity_id, &taxonomy_id)
                    });
                    let row = NewActivityTaxonomyAssignmentDB {
                        id,
                        activity_id,
                        taxonomy_id,
                        category_id,
                        weight,
                        source,
                        created_at: now.clone(),
                        updated_at: now.clone(),
                    };

                    let inserted = diesel::insert_into(activity_taxonomy_assignments::table)
                        .values(&row)
                        .on_conflict((
                            activity_taxonomy_assignments::activity_id,
                            activity_taxonomy_assignments::taxonomy_id,
                        ))
                        .do_update()
                        .set((
                            activity_taxonomy_assignments::category_id.eq(&row.category_id),
                            activity_taxonomy_assignments::weight.eq(&row.weight),
                            activity_taxonomy_assignments::source.eq(&row.source),
                            activity_taxonomy_assignments::updated_at.eq(&row.updated_at),
                        ))
                        .returning(ActivityTaxonomyAssignmentDB::as_returning())
                        .get_result::<ActivityTaxonomyAssignmentDB>(tx.conn())
                        .map_err(StorageError::from)?;

                    if should_sync_activity_local_id_outbox(tx.conn(), &inserted.activity_id)? {
                        if had_existing {
                            tx.update(&inserted)?;
                        } else {
                            tx.insert(&inserted)?;
                        }
                    }
                    out.push(inserted);
                }
                Ok(out)
            })
            .await
            .map_err(|e| anyhow::anyhow!(e))?;

        Ok(inserted_dbs
            .into_iter()
            .map(ActivityTaxonomyAssignment::from)
            .collect())
    }

    async fn delete(&self, id: &str) -> Result<()> {
        let id = id.to_string();
        self.writer
            .exec_tx(move |tx| {
                let existing = activity_taxonomy_assignments::table
                    .find(&id)
                    .first::<ActivityTaxonomyAssignmentDB>(tx.conn())
                    .optional()
                    .map_err(StorageError::from)?;
                let should_sync = match &existing {
                    Some(row) => should_sync_activity_local_id_outbox(tx.conn(), &row.activity_id)?,
                    None => false,
                };
                let affected = diesel::delete(activity_taxonomy_assignments::table.find(&id))
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;
                if affected > 0 && should_sync {
                    tx.delete::<ActivityTaxonomyAssignmentDB>(id.clone());
                }
                Ok(())
            })
            .await
            .map_err(|e| anyhow::anyhow!(e))
    }

    async fn clear_for_taxonomy(&self, activity_id: &str, taxonomy_id: &str) -> Result<()> {
        let activity_id = activity_id.to_string();
        let taxonomy_id = taxonomy_id.to_string();
        self.writer
            .exec_tx(move |tx| {
                let existing_ids = activity_taxonomy_assignments::table
                    .filter(activity_taxonomy_assignments::activity_id.eq(&activity_id))
                    .filter(activity_taxonomy_assignments::taxonomy_id.eq(&taxonomy_id))
                    .select(activity_taxonomy_assignments::id)
                    .load::<String>(tx.conn())
                    .map_err(StorageError::from)?;
                let should_sync = should_sync_activity_local_id_outbox(tx.conn(), &activity_id)?;

                diesel::delete(
                    activity_taxonomy_assignments::table
                        .filter(activity_taxonomy_assignments::activity_id.eq(&activity_id))
                        .filter(activity_taxonomy_assignments::taxonomy_id.eq(&taxonomy_id)),
                )
                .execute(tx.conn())
                .map_err(StorageError::from)?;

                if should_sync {
                    for assignment_id in existing_ids {
                        tx.delete::<ActivityTaxonomyAssignmentDB>(assignment_id);
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
    use crate::schema::{
        activities, activity_taxonomy_assignments, spending_activity_splits, sync_outbox,
    };
    use diesel::r2d2::{ConnectionManager, Pool};
    use std::sync::Arc;
    use tempfile::tempdir;
    use wealthfolio_spending::activity_assignments::{
        ActivityTaxonomyAssignmentRepositoryTrait, NewActivityTaxonomyAssignment,
    };

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

    fn insert_account_and_activity(conn: &mut SqliteConnection, id: &str, source_system: &str) {
        let account_id = format!("account-{id}");
        diesel::sql_query(format!(
            "INSERT INTO accounts \
             (id, name, account_type, `group`, currency, is_default, is_active, created_at, updated_at, \
              platform_id, account_number, meta, provider, provider_account_id, is_archived, tracking_mode) \
             VALUES ('{}', 'Account {}', 'cash', NULL, 'USD', 0, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, \
                     NULL, NULL, NULL, NULL, NULL, 0, 'portfolio')",
            account_id, id
        ))
        .execute(conn)
        .expect("insert account");

        diesel::sql_query(format!(
            "INSERT INTO activities \
             (id, account_id, asset_id, activity_type, activity_type_override, source_type, subtype, \
              status, activity_date, settlement_date, quantity, unit_price, amount, fee, currency, \
              fx_rate, notes, metadata, source_system, source_record_id, source_group_id, \
              idempotency_key, import_run_id, is_user_modified, needs_review, created_at, updated_at) \
             VALUES ('{}', '{}', NULL, 'BUY', NULL, NULL, NULL, 'POSTED', \
                     '2026-01-01T00:00:00Z', NULL, NULL, NULL, '10', NULL, 'USD', NULL, \
                     NULL, NULL, '{}', '{}-source-record', NULL, NULL, NULL, 0, 0, \
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            id, account_id, source_system, id
        ))
        .execute(conn)
        .expect("insert activity");
    }

    fn outbox_count(conn: &mut SqliteConnection) -> i64 {
        sync_outbox::table
            .count()
            .get_result::<i64>(conn)
            .expect("count outbox")
    }

    fn mark_activity_user_modified(conn: &mut SqliteConnection, activity_id: &str) {
        diesel::update(activities::table.find(activity_id))
            .set(activities::is_user_modified.eq(1))
            .execute(conn)
            .expect("mark activity user modified");
    }

    fn insert_split(conn: &mut SqliteConnection, id: &str, activity_id: &str) {
        diesel::sql_query(format!(
            "INSERT INTO spending_activity_splits \
             (id, activity_id, taxonomy_id, category_id, amount, note, sort_order, created_at, updated_at) \
             VALUES ('{}', '{}', 'spending_categories', 'cat_food', '10', NULL, 0, \
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            id, activity_id
        ))
        .execute(conn)
        .expect("insert split");
    }

    #[tokio::test]
    async fn assigning_category_clears_existing_splits_in_same_write() {
        let (pool, writer) = setup_db();
        {
            let mut conn = get_connection(&pool).expect("conn");
            insert_account_and_activity(&mut conn, "manual-activity", "MANUAL");
            insert_split(&mut conn, "split-1", "manual-activity");
        }

        let repo = ActivityTaxonomyAssignmentRepository::new(pool.clone(), writer);
        repo.assign_many_single_select_clearing_splits(vec![NewActivityTaxonomyAssignment {
            id: None,
            activity_id: "manual-activity".to_string(),
            taxonomy_id: "spending_categories".to_string(),
            category_id: "cat_groceries".to_string(),
            weight: 10_000,
            source: "manual".to_string(),
        }])
        .await
        .expect("assign category");

        let mut conn = get_connection(&pool).expect("conn");
        assert_eq!(
            spending_activity_splits::table
                .count()
                .get_result::<i64>(&mut conn)
                .expect("count splits"),
            0
        );
        assert_eq!(
            activity_taxonomy_assignments::table
                .count()
                .get_result::<i64>(&mut conn)
                .expect("count assignments"),
            1
        );
    }

    #[tokio::test]
    async fn broker_activity_assignment_is_local_only_but_manual_assignment_still_syncs() {
        let (pool, writer) = setup_db();
        {
            let mut conn = get_connection(&pool).expect("conn");
            insert_account_and_activity(&mut conn, "broker-activity", "SNAPTRADE");
            mark_activity_user_modified(&mut conn, "broker-activity");
            insert_account_and_activity(&mut conn, "manual-activity", "MANUAL");
        }

        let repo = ActivityTaxonomyAssignmentRepository::new(pool.clone(), writer);
        repo.upsert(NewActivityTaxonomyAssignment {
            id: None,
            activity_id: "broker-activity".to_string(),
            taxonomy_id: "spending_categories".to_string(),
            category_id: "cat_food".to_string(),
            weight: 10_000,
            source: "manual".to_string(),
        })
        .await
        .expect("assign broker activity");

        let mut conn = get_connection(&pool).expect("conn");
        assert_eq!(
            activity_taxonomy_assignments::table
                .count()
                .get_result::<i64>(&mut conn)
                .expect("count assignments"),
            1
        );
        assert_eq!(outbox_count(&mut conn), 0);

        repo.upsert(NewActivityTaxonomyAssignment {
            id: None,
            activity_id: "manual-activity".to_string(),
            taxonomy_id: "spending_categories".to_string(),
            category_id: "cat_groceries".to_string(),
            weight: 10_000,
            source: "manual".to_string(),
        })
        .await
        .expect("assign manual activity");

        let entities = sync_outbox::table
            .select(sync_outbox::entity)
            .load::<String>(&mut conn)
            .expect("load outbox entities");
        assert_eq!(entities, vec!["activity_taxonomy_assignment".to_string()]);
    }
}
