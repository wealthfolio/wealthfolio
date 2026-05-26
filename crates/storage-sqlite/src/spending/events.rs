//! Storage adapters for spending::events (Event, EventType).

use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use chrono::NaiveDateTime;
use diesel::prelude::*;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::db::{get_connection, DbPool, WriteHandle};
use crate::errors::StorageError;
use crate::schema::{spending_activity_events, spending_event_types, spending_events};
use crate::spending::activity_events::ActivityEventDB;
use wealthfolio_core::sync::{SyncEntity, SyncOperation};
use wealthfolio_spending::events::{
    Event, EventType, EventTypesRepositoryTrait, EventsRepositoryTrait, NewEvent, NewEventType,
    UpdateEvent,
};

// ----------------------------- event_types -----------------------------

#[derive(Queryable, Identifiable, Selectable, Serialize, Deserialize, Debug, Clone)]
#[diesel(table_name = crate::schema::spending_event_types)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct EventTypeDB {
    pub id: String,
    pub key: Option<String>,
    pub name: String,
    pub color: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Insertable, Serialize, Deserialize, Debug, Clone)]
#[diesel(table_name = crate::schema::spending_event_types)]
pub struct NewEventTypeDB {
    pub id: String,
    pub key: Option<String>,
    pub name: String,
    pub color: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl crate::sync::SyncOutboxModel for EventTypeDB {
    const ENTITY: SyncEntity = SyncEntity::SpendingEventType;
    fn sync_entity_id(&self) -> &str {
        &self.id
    }

    fn should_sync_outbox(&self, _op: SyncOperation) -> bool {
        self.key.is_none() || self.updated_at != self.created_at
    }
}

fn parse_dt(s: &str) -> NaiveDateTime {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.naive_utc())
        .unwrap_or_else(|_| chrono::Utc::now().naive_utc())
}

impl From<EventTypeDB> for EventType {
    fn from(db: EventTypeDB) -> Self {
        Self {
            id: db.id,
            key: db.key,
            name: db.name,
            color: db.color,
            created_at: parse_dt(&db.created_at),
            updated_at: parse_dt(&db.updated_at),
        }
    }
}

pub struct EventTypesRepository {
    pool: Arc<DbPool>,
    writer: WriteHandle,
}

impl EventTypesRepository {
    pub fn new(pool: Arc<DbPool>, writer: WriteHandle) -> Self {
        Self { pool, writer }
    }
}

#[async_trait]
impl EventTypesRepositoryTrait for EventTypesRepository {
    async fn list(&self) -> Result<Vec<EventType>> {
        let mut conn = get_connection(&self.pool).map_err(|e| anyhow::anyhow!(e))?;
        let rows = spending_event_types::table
            .order(spending_event_types::name.asc())
            .load::<EventTypeDB>(&mut conn)
            .map_err(StorageError::from)
            .map_err(|e| anyhow::anyhow!(e))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    async fn create(&self, new_type: NewEventType) -> Result<EventType> {
        let now = chrono::Utc::now().to_rfc3339();
        let row = NewEventTypeDB {
            id: new_type.id.unwrap_or_else(|| Uuid::new_v4().to_string()),
            key: None,
            name: new_type.name,
            color: new_type.color,
            created_at: now.clone(),
            updated_at: now,
        };
        self.writer
            .exec_tx(move |tx| {
                let inserted = diesel::insert_into(spending_event_types::table)
                    .values(&row)
                    .returning(EventTypeDB::as_returning())
                    .get_result(tx.conn())
                    .map_err(StorageError::from)?;
                tx.insert(&inserted)?;
                Ok(inserted)
            })
            .await
            .map(EventType::from)
            .map_err(|e| anyhow::anyhow!(e))
    }

    async fn update(
        &self,
        id: &str,
        name: Option<String>,
        color: Option<Option<String>>,
    ) -> Result<EventType> {
        let id = id.to_string();
        self.writer
            .exec_tx(move |tx| {
                let mut existing: EventTypeDB = spending_event_types::table
                    .find(&id)
                    .first::<EventTypeDB>(tx.conn())
                    .map_err(StorageError::from)?;
                if let Some(n) = name {
                    existing.name = n;
                }
                if let Some(c) = color {
                    existing.color = c;
                }
                existing.updated_at = chrono::Utc::now().to_rfc3339();
                diesel::update(spending_event_types::table.find(&id))
                    .set((
                        spending_event_types::name.eq(&existing.name),
                        spending_event_types::color.eq(&existing.color),
                        spending_event_types::updated_at.eq(&existing.updated_at),
                    ))
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;
                tx.update(&existing)?;
                Ok(existing)
            })
            .await
            .map(EventType::from)
            .map_err(|e| anyhow::anyhow!(e))
    }

    async fn delete(&self, id: &str) -> Result<()> {
        let id = id.to_string();
        self.writer
            .exec_tx(move |tx| {
                let affected = diesel::delete(spending_event_types::table.find(&id))
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;
                if affected > 0 {
                    tx.delete::<EventTypeDB>(id.clone());
                }
                Ok(())
            })
            .await
            .map_err(|e| anyhow::anyhow!(e))
    }
}

// ----------------------------- events -----------------------------

#[derive(Queryable, Identifiable, Selectable, Serialize, Deserialize, Debug, Clone)]
#[diesel(table_name = crate::schema::spending_events)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct EventDB {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub event_type_id: String,
    pub start_date: String,
    pub end_date: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Insertable, Serialize, Deserialize, Debug, Clone)]
#[diesel(table_name = crate::schema::spending_events)]
pub struct NewEventDB {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub event_type_id: String,
    pub start_date: String,
    pub end_date: String,
    pub created_at: String,
    pub updated_at: String,
}

impl crate::sync::SyncOutboxModel for EventDB {
    const ENTITY: SyncEntity = SyncEntity::SpendingEvent;
    fn sync_entity_id(&self) -> &str {
        &self.id
    }
}

impl From<EventDB> for Event {
    fn from(db: EventDB) -> Self {
        Self {
            id: db.id,
            name: db.name,
            description: db.description,
            event_type_id: db.event_type_id,
            start_date: db.start_date,
            end_date: db.end_date,
            created_at: parse_dt(&db.created_at),
            updated_at: parse_dt(&db.updated_at),
        }
    }
}

pub struct EventsRepository {
    pool: Arc<DbPool>,
    writer: WriteHandle,
}

impl EventsRepository {
    pub fn new(pool: Arc<DbPool>, writer: WriteHandle) -> Self {
        Self { pool, writer }
    }
}

#[async_trait]
impl EventsRepositoryTrait for EventsRepository {
    async fn list(&self) -> Result<Vec<Event>> {
        let mut conn = get_connection(&self.pool).map_err(|e| anyhow::anyhow!(e))?;
        let rows = spending_events::table
            .order(spending_events::start_date.desc())
            .load::<EventDB>(&mut conn)
            .map_err(StorageError::from)
            .map_err(|e| anyhow::anyhow!(e))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    async fn get(&self, id: &str) -> Result<Option<Event>> {
        let mut conn = get_connection(&self.pool).map_err(|e| anyhow::anyhow!(e))?;
        let row = spending_events::table
            .find(id)
            .first::<EventDB>(&mut conn)
            .optional()
            .map_err(StorageError::from)
            .map_err(|e| anyhow::anyhow!(e))?;
        Ok(row.map(Into::into))
    }

    async fn create(&self, new_event: NewEvent) -> Result<Event> {
        let now = chrono::Utc::now().to_rfc3339();
        let row = NewEventDB {
            id: new_event.id.unwrap_or_else(|| Uuid::new_v4().to_string()),
            name: new_event.name,
            description: new_event.description,
            event_type_id: new_event.event_type_id,
            start_date: new_event.start_date,
            end_date: new_event.end_date,
            created_at: now.clone(),
            updated_at: now,
        };
        self.writer
            .exec_tx(move |tx| {
                let inserted = diesel::insert_into(spending_events::table)
                    .values(&row)
                    .returning(EventDB::as_returning())
                    .get_result(tx.conn())
                    .map_err(StorageError::from)?;
                tx.insert(&inserted)?;
                Ok(inserted)
            })
            .await
            .map(Event::from)
            .map_err(|e| anyhow::anyhow!(e))
    }

    async fn update(&self, id: &str, patch: UpdateEvent) -> Result<Event> {
        let id = id.to_string();
        self.writer
            .exec_tx(move |tx| {
                let mut existing: EventDB = spending_events::table
                    .find(&id)
                    .first::<EventDB>(tx.conn())
                    .map_err(StorageError::from)?;
                if let Some(v) = patch.name {
                    existing.name = v;
                }
                if let Some(v) = patch.description {
                    existing.description = v;
                }
                if let Some(v) = patch.event_type_id {
                    existing.event_type_id = v;
                }
                if let Some(v) = patch.start_date {
                    existing.start_date = v;
                }
                if let Some(v) = patch.end_date {
                    existing.end_date = v;
                }
                existing.updated_at = chrono::Utc::now().to_rfc3339();

                diesel::update(spending_events::table.find(&id))
                    .set((
                        spending_events::name.eq(&existing.name),
                        spending_events::description.eq(&existing.description),
                        spending_events::event_type_id.eq(&existing.event_type_id),
                        spending_events::start_date.eq(&existing.start_date),
                        spending_events::end_date.eq(&existing.end_date),
                        spending_events::updated_at.eq(&existing.updated_at),
                    ))
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;
                tx.update(&existing)?;
                Ok(existing)
            })
            .await
            .map(Event::from)
            .map_err(|e| anyhow::anyhow!(e))
    }

    async fn delete(&self, id: &str) -> Result<()> {
        let id = id.to_string();
        self.writer
            .exec_tx(move |tx| {
                let affected_activity_event_ids: Vec<String> = spending_activity_events::table
                    .filter(spending_activity_events::event_id.eq(&id))
                    .select(spending_activity_events::activity_id)
                    .load::<String>(tx.conn())
                    .map_err(StorageError::from)?;

                let removed_activity_events = diesel::delete(
                    spending_activity_events::table
                        .filter(spending_activity_events::event_id.eq(&id)),
                )
                .execute(tx.conn())
                .map_err(StorageError::from)?;
                if removed_activity_events > 0 {
                    for activity_id in affected_activity_event_ids {
                        tx.delete::<ActivityEventDB>(activity_id);
                    }
                }

                let affected = diesel::delete(spending_events::table.find(&id))
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;
                if affected > 0 {
                    tx.delete::<EventDB>(id.clone());
                }
                Ok(())
            })
            .await
            .map_err(|e| anyhow::anyhow!(e))
    }

    async fn count_by_type(&self, event_type_id: &str) -> Result<usize> {
        let mut conn = get_connection(&self.pool).map_err(|e| anyhow::anyhow!(e))?;
        let count: i64 = spending_events::table
            .filter(spending_events::event_type_id.eq(event_type_id))
            .count()
            .get_result(&mut conn)
            .map_err(StorageError::from)
            .map_err(|e| anyhow::anyhow!(e))?;
        Ok(count.max(0) as usize)
    }
}
