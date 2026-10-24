//! Storage adapter for spending::activity_events — Diesel impl over the
//! `activity_events` join table.
//!
//! This repository owns both read paths and tag writes so the core activity
//! repository does not need to know about spending events.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use diesel::prelude::*;
use serde::{Deserialize, Serialize};

use crate::db::{get_connection, DbPool, WriteHandle};
use crate::errors::StorageError;
use crate::schema::spending_activity_events;
use crate::spending::activity_sync::should_sync_activity_local_id_outbox;
use wealthfolio_core::sync::SyncEntity;
use wealthfolio_spending::activity_events::{ActivityEvent, ActivityEventsRepositoryTrait};

#[derive(Queryable, Selectable, Serialize, Deserialize, Debug, Clone)]
#[diesel(table_name = crate::schema::spending_activity_events)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct ActivityEventDB {
    pub activity_id: String,
    pub event_id: String,
    pub created_at: String,
    pub updated_at: String,
}

impl crate::sync::SyncOutboxModel for ActivityEventDB {
    const ENTITY: SyncEntity = SyncEntity::SpendingActivityEvent;
    fn sync_entity_id(&self) -> &str {
        // PK is `activity_id` — one tag per activity.
        &self.activity_id
    }
}

fn parse_dt(s: &str) -> chrono::NaiveDateTime {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.naive_utc())
        .unwrap_or_else(|_| chrono::Utc::now().naive_utc())
}

impl From<ActivityEventDB> for ActivityEvent {
    fn from(db: ActivityEventDB) -> Self {
        Self {
            activity_id: db.activity_id,
            event_id: db.event_id,
            created_at: parse_dt(&db.created_at),
            updated_at: parse_dt(&db.updated_at),
        }
    }
}

pub struct ActivityEventsRepository {
    pool: Arc<DbPool>,
    writer: WriteHandle,
}

impl ActivityEventsRepository {
    pub fn new(pool: Arc<DbPool>, writer: WriteHandle) -> Self {
        Self { pool, writer }
    }
}

#[async_trait]
impl ActivityEventsRepositoryTrait for ActivityEventsRepository {
    async fn list_for_activities(&self, ids: &[String]) -> Result<HashMap<String, String>> {
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let mut conn = get_connection(&self.pool).map_err(|e| anyhow::anyhow!(e))?;
        const CHUNK: usize = 500;
        let mut out = HashMap::new();
        for chunk in ids.chunks(CHUNK) {
            let rows: Vec<ActivityEventDB> = spending_activity_events::table
                .filter(spending_activity_events::activity_id.eq_any(chunk))
                .select(ActivityEventDB::as_select())
                .load(&mut conn)
                .map_err(StorageError::from)
                .map_err(|e| anyhow::anyhow!(e))?;
            out.extend(rows.into_iter().map(|r| (r.activity_id, r.event_id)));
        }
        Ok(out)
    }

    async fn list_for_event(&self, event_id: &str) -> Result<Vec<String>> {
        let mut conn = get_connection(&self.pool).map_err(|e| anyhow::anyhow!(e))?;
        let rows: Vec<String> = spending_activity_events::table
            .filter(spending_activity_events::event_id.eq(event_id))
            .select(spending_activity_events::activity_id)
            .load(&mut conn)
            .map_err(StorageError::from)
            .map_err(|e| anyhow::anyhow!(e))?;
        Ok(rows)
    }

    async fn list_for_events(&self, event_ids: &[String]) -> Result<HashMap<String, String>> {
        if event_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let mut conn = get_connection(&self.pool).map_err(|e| anyhow::anyhow!(e))?;
        const CHUNK: usize = 500;
        let mut out = HashMap::new();
        for chunk in event_ids.chunks(CHUNK) {
            let rows: Vec<ActivityEventDB> = spending_activity_events::table
                .filter(spending_activity_events::event_id.eq_any(chunk))
                .select(ActivityEventDB::as_select())
                .load(&mut conn)
                .map_err(StorageError::from)
                .map_err(|e| anyhow::anyhow!(e))?;
            out.extend(rows.into_iter().map(|r| (r.activity_id, r.event_id)));
        }
        Ok(out)
    }

    async fn set_activity_event_tag(
        &self,
        activity_id: &str,
        event_id: Option<String>,
    ) -> Result<()> {
        let activity_id = activity_id.to_string();
        self.writer
            .exec_tx(move |tx| {
                let now = chrono::Utc::now().to_rfc3339();
                let should_sync = should_sync_activity_local_id_outbox(tx.conn(), &activity_id)?;
                match &event_id {
                    Some(eid) => {
                        diesel::insert_into(spending_activity_events::table)
                            .values((
                                spending_activity_events::activity_id.eq(&activity_id),
                                spending_activity_events::event_id.eq(eid),
                                spending_activity_events::created_at.eq(&now),
                                spending_activity_events::updated_at.eq(&now),
                            ))
                            .on_conflict(spending_activity_events::activity_id)
                            .do_update()
                            .set((
                                spending_activity_events::event_id.eq(eid),
                                spending_activity_events::updated_at.eq(&now),
                            ))
                            .execute(tx.conn())
                            .map_err(StorageError::from)?;
                        if should_sync {
                            tx.update(&ActivityEventDB {
                                activity_id: activity_id.clone(),
                                event_id: eid.clone(),
                                created_at: now.clone(),
                                updated_at: now.clone(),
                            })?;
                        }
                    }
                    None => {
                        // Only emit the sync tombstone when an actual row
                        // was removed. Calling tx.delete unconditionally on
                        // a no-op DELETE writes `last_op = Delete` in the
                        // sync metadata for an entity the network never saw
                        // — and a subsequent Create from another device
                        // would then get rejected by LWW as resurrection.
                        let removed = diesel::delete(
                            spending_activity_events::table
                                .filter(spending_activity_events::activity_id.eq(&activity_id)),
                        )
                        .execute(tx.conn())
                        .map_err(StorageError::from)?;
                        if removed > 0 && should_sync {
                            tx.delete::<ActivityEventDB>(activity_id.clone());
                        }
                    }
                }

                Ok(())
            })
            .await
            .map_err(|e| anyhow::anyhow!(e))
    }

    async fn delete_by_event(&self, event_id: &str) -> Result<usize> {
        let event_id = event_id.to_string();
        self.writer
            .exec_tx(move |tx| {
                // Capture affected rows so we can mark them deleted in the
                // sync outbox (each row was previously sent with its
                // activity_id as the entity id).
                let affected_ids: Vec<String> = spending_activity_events::table
                    .filter(spending_activity_events::event_id.eq(&event_id))
                    .select(spending_activity_events::activity_id)
                    .load::<String>(tx.conn())
                    .map_err(StorageError::from)?;
                let removed = diesel::delete(
                    spending_activity_events::table
                        .filter(spending_activity_events::event_id.eq(&event_id)),
                )
                .execute(tx.conn())
                .map_err(StorageError::from)?;
                for id in affected_ids {
                    if should_sync_activity_local_id_outbox(tx.conn(), &id)? {
                        tx.delete::<ActivityEventDB>(id);
                    }
                }
                Ok(removed)
            })
            .await
            .map_err(|e| anyhow::anyhow!(e))
    }

    async fn list_all(&self) -> Result<Vec<ActivityEvent>> {
        let mut conn = get_connection(&self.pool).map_err(|e| anyhow::anyhow!(e))?;
        let rows: Vec<ActivityEventDB> = spending_activity_events::table
            .select(ActivityEventDB::as_select())
            .load(&mut conn)
            .map_err(StorageError::from)
            .map_err(|e| anyhow::anyhow!(e))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{
        create_pool, get_connection, init, run_migrations, write_actor::spawn_writer, TestDir,
    };
    use crate::schema::{activities, spending_activity_events, sync_outbox};
    use diesel::r2d2::{ConnectionManager, Pool};
    use diesel::sqlite::SqliteConnection;
    use std::sync::Arc;
    use wealthfolio_spending::activity_events::ActivityEventsRepositoryTrait;

    fn setup_db() -> (
        Arc<Pool<ConnectionManager<SqliteConnection>>>,
        WriteHandle,
        TestDir,
    ) {
        std::env::set_var("CONNECT_API_URL", "http://test.local");
        let dir = TestDir::new();
        let app_data = dir.path().to_string_lossy().to_string();
        let db_path = init(&app_data).expect("init db");
        run_migrations(&db_path).expect("migrate db");
        let pool = create_pool(&db_path).expect("create pool");
        let writer = spawn_writer(pool.as_ref().clone()).expect("spawn writer");
        (pool, writer, dir)
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

    fn insert_event_with_id(conn: &mut SqliteConnection, id: &str) {
        let event_type_id = format!("event-type-{id}");
        diesel::sql_query(format!(
            "INSERT INTO spending_event_types (id, key, name, color, created_at, updated_at) \
             VALUES ('{}', NULL, 'Test Event Type', '#000000', \
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            event_type_id
        ))
        .execute(conn)
        .expect("insert event type");

        diesel::sql_query(format!(
            "INSERT INTO spending_events \
             (id, name, description, event_type_id, start_date, end_date, created_at, updated_at) \
             VALUES ('{}', 'Test Event', NULL, '{}', '2026-01-01', '2026-01-31', \
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            id, event_type_id
        ))
        .execute(conn)
        .expect("insert event");
    }

    fn insert_event(conn: &mut SqliteConnection) {
        insert_event_with_id(conn, "event-test");
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

    #[tokio::test]
    async fn broker_activity_event_tag_is_local_only_but_manual_tag_still_syncs() {
        let (pool, writer, _dir) = setup_db();
        {
            let mut conn = get_connection(&pool).expect("conn");
            insert_account_and_activity(&mut conn, "broker-activity", "SNAPTRADE");
            mark_activity_user_modified(&mut conn, "broker-activity");
            insert_account_and_activity(&mut conn, "manual-activity", "MANUAL");
            insert_event(&mut conn);
        }

        let repo = ActivityEventsRepository::new(pool.clone(), writer);
        repo.set_activity_event_tag("broker-activity", Some("event-test".to_string()))
            .await
            .expect("tag broker activity");

        let mut conn = get_connection(&pool).expect("conn");
        assert_eq!(
            spending_activity_events::table
                .count()
                .get_result::<i64>(&mut conn)
                .expect("count event tags"),
            1
        );
        assert_eq!(outbox_count(&mut conn), 0);

        repo.set_activity_event_tag("manual-activity", Some("event-test".to_string()))
            .await
            .expect("tag manual activity");

        let entities = sync_outbox::table
            .select(sync_outbox::entity)
            .load::<String>(&mut conn)
            .expect("load outbox entities");
        assert_eq!(entities, vec!["spending_activity_event".to_string()]);
    }

    #[tokio::test]
    async fn list_for_events_returns_tags_for_requested_events_only() {
        let (pool, writer, _dir) = setup_db();
        {
            let mut conn = get_connection(&pool).expect("conn");
            insert_account_and_activity(&mut conn, "activity-a", "MANUAL");
            insert_account_and_activity(&mut conn, "activity-b", "MANUAL");
            insert_account_and_activity(&mut conn, "activity-c", "MANUAL");
            insert_event_with_id(&mut conn, "event-a");
            insert_event_with_id(&mut conn, "event-b");
            insert_event_with_id(&mut conn, "event-c");
        }

        let repo = ActivityEventsRepository::new(pool.clone(), writer);
        repo.set_activity_event_tag("activity-a", Some("event-a".to_string()))
            .await
            .expect("tag activity a");
        repo.set_activity_event_tag("activity-b", Some("event-b".to_string()))
            .await
            .expect("tag activity b");
        repo.set_activity_event_tag("activity-c", Some("event-c".to_string()))
            .await
            .expect("tag activity c");

        let tag_map = repo
            .list_for_events(&["event-a".to_string(), "event-b".to_string()])
            .await
            .expect("list event tags");

        assert_eq!(tag_map.len(), 2);
        assert_eq!(
            tag_map.get("activity-a").map(String::as_str),
            Some("event-a")
        );
        assert_eq!(
            tag_map.get("activity-b").map(String::as_str),
            Some("event-b")
        );
        assert!(!tag_map.contains_key("activity-c"));
    }
}
