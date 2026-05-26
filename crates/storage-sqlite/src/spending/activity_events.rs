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

    async fn set_activity_event_tag(
        &self,
        activity_id: &str,
        event_id: Option<String>,
    ) -> Result<()> {
        let activity_id = activity_id.to_string();
        self.writer
            .exec_tx(move |tx| {
                let now = chrono::Utc::now().to_rfc3339();
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
                        tx.update(&ActivityEventDB {
                            activity_id: activity_id.clone(),
                            event_id: eid.clone(),
                            created_at: now.clone(),
                            updated_at: now.clone(),
                        })?;
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
                        if removed > 0 {
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
                    tx.delete::<ActivityEventDB>(id);
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
