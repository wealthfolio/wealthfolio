//! Durable per-addon key-value storage repository (SQLite-backed).
//!
//! Dumb CRUD over the `addon_storage` composite-PK table. All validation
//! (key/value length caps) and uninstall cleanup live in the core
//! `AddonService`; this layer only persists and queries rows.

use std::sync::Arc;

use diesel::prelude::*;
use serde::{Deserialize, Serialize};

use super::addon_storage_id;
use crate::db::{get_connection, DbPool, WriteHandle};
use crate::errors::StorageError;
use crate::schema::addon_storage;
use crate::sync::OutboxWriteRequest;
use wealthfolio_core::addons::AddonStorageRepositoryTrait;
use wealthfolio_core::errors::Result;
use wealthfolio_core::sync::{SyncEntity, SyncOperation};

#[derive(Queryable, Selectable, Insertable, Serialize, Deserialize, Debug, Clone)]
#[diesel(table_name = crate::schema::addon_storage)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct AddonStorageDB {
    pub addon_id: String,
    pub key: String,
    pub value: String,
}

pub struct AddonStorageRepository {
    pool: Arc<DbPool>,
    writer: WriteHandle,
}

impl AddonStorageRepository {
    pub fn new(pool: Arc<DbPool>, writer: WriteHandle) -> Self {
        Self { pool, writer }
    }

    pub async fn get(&self, addon_id: &str, key: &str) -> Result<Option<String>> {
        let mut conn = get_connection(&self.pool)?;
        addon_storage::table
            .filter(addon_storage::addon_id.eq(addon_id))
            .filter(addon_storage::key.eq(key))
            .select(addon_storage::value)
            .first::<String>(&mut conn)
            .optional()
            .map_err(|e| StorageError::from(e).into())
    }

    pub async fn set(&self, addon_id: &str, key: &str, value: &str) -> Result<()> {
        let addon_id = addon_id.to_string();
        let key = key.to_string();
        let value = value.to_string();
        self.writer
            .exec_tx(move |tx| {
                let row = AddonStorageDB {
                    addon_id: addon_id.clone(),
                    key: key.clone(),
                    value: value.clone(),
                };
                // Upsert on the (addon_id, key) composite primary key.
                diesel::replace_into(addon_storage::table)
                    .values(&row)
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;
                tx.queue_outbox(OutboxWriteRequest::new(
                    SyncEntity::AddonStorage,
                    addon_storage_id(&addon_id, &key),
                    SyncOperation::Update,
                    serde_json::json!({
                        "addonId": addon_id,
                        "key": key,
                        "value": value,
                    }),
                ));
                Ok(())
            })
            .await
    }

    pub async fn delete(&self, addon_id: &str, key: &str) -> Result<()> {
        let addon_id = addon_id.to_string();
        let key = key.to_string();
        self.writer
            .exec_tx(move |tx| {
                diesel::delete(
                    addon_storage::table
                        .filter(addon_storage::addon_id.eq(&addon_id))
                        .filter(addon_storage::key.eq(&key)),
                )
                .execute(tx.conn())
                .map_err(StorageError::from)?;
                tx.queue_outbox(OutboxWriteRequest::new(
                    SyncEntity::AddonStorage,
                    addon_storage_id(&addon_id, &key),
                    SyncOperation::Delete,
                    serde_json::json!({
                        "addonId": addon_id,
                        "key": key,
                    }),
                ));
                Ok(())
            })
            .await
    }

    pub async fn delete_all(&self, addon_id: &str) -> Result<()> {
        let addon_id = addon_id.to_string();
        self.writer
            .exec(move |conn| {
                diesel::delete(addon_storage::table.filter(addon_storage::addon_id.eq(&addon_id)))
                    .execute(conn)
                    .map_err(StorageError::from)?;
                Ok(())
            })
            .await
    }
}

#[async_trait::async_trait]
impl AddonStorageRepositoryTrait for AddonStorageRepository {
    async fn get(&self, addon_id: &str, key: &str) -> std::result::Result<Option<String>, String> {
        AddonStorageRepository::get(self, addon_id, key)
            .await
            .map_err(|e| e.to_string())
    }

    async fn set(&self, addon_id: &str, key: &str, value: &str) -> std::result::Result<(), String> {
        AddonStorageRepository::set(self, addon_id, key, value)
            .await
            .map_err(|e| e.to_string())
    }

    async fn delete(&self, addon_id: &str, key: &str) -> std::result::Result<(), String> {
        AddonStorageRepository::delete(self, addon_id, key)
            .await
            .map_err(|e| e.to_string())
    }

    async fn delete_all(&self, addon_id: &str) -> std::result::Result<(), String> {
        AddonStorageRepository::delete_all(self, addon_id)
            .await
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{create_pool, run_migrations, write_actor::spawn_writer};
    use tempfile::tempdir;

    async fn setup() -> (AddonStorageRepository, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db").to_string_lossy().to_string();
        run_migrations(&db_path).unwrap();
        let pool = create_pool(&db_path).unwrap();
        let writer = spawn_writer((*pool).clone()).unwrap();
        let repo = AddonStorageRepository::new(Arc::clone(&pool), writer);
        (repo, dir)
    }

    fn count_rows(repo: &AddonStorageRepository) -> i64 {
        let mut conn = get_connection(&repo.pool).unwrap();
        addon_storage::table
            .count()
            .get_result::<i64>(&mut conn)
            .unwrap()
    }

    /// Outbox rows for the addon_storage entity, as (entity_id, op, payload_json).
    fn addon_storage_outbox(
        repo: &AddonStorageRepository,
    ) -> Vec<(String, String, serde_json::Value)> {
        use crate::schema::sync_outbox;
        let mut conn = get_connection(&repo.pool).unwrap();
        sync_outbox::table
            .filter(sync_outbox::entity.eq("addon_storage"))
            .order(sync_outbox::created_at.asc())
            .select((
                sync_outbox::entity_id,
                sync_outbox::op,
                sync_outbox::payload,
            ))
            .load::<(String, String, String)>(&mut conn)
            .unwrap()
            .into_iter()
            .map(|(entity_id, op, payload)| {
                (entity_id, op, serde_json::from_str(&payload).unwrap())
            })
            .collect()
    }

    #[tokio::test]
    async fn upsert_replaces_without_duplicate_rows() {
        let (repo, _dir) = setup().await;

        repo.set("addon-a", "prefs", "v1").await.unwrap();
        repo.set("addon-a", "prefs", "v2").await.unwrap();

        assert_eq!(
            repo.get("addon-a", "prefs").await.unwrap().as_deref(),
            Some("v2")
        );
        assert_eq!(
            count_rows(&repo),
            1,
            "upsert must not create duplicate rows"
        );
    }

    #[tokio::test]
    async fn get_missing_returns_none() {
        let (repo, _dir) = setup().await;
        assert_eq!(repo.get("addon-a", "missing").await.unwrap(), None);
    }

    #[tokio::test]
    async fn delete_removes_only_target_key() {
        let (repo, _dir) = setup().await;

        repo.set("addon-a", "k1", "v1").await.unwrap();
        repo.set("addon-a", "k2", "v2").await.unwrap();

        repo.delete("addon-a", "k1").await.unwrap();

        assert_eq!(repo.get("addon-a", "k1").await.unwrap(), None);
        assert_eq!(
            repo.get("addon-a", "k2").await.unwrap().as_deref(),
            Some("v2")
        );
    }

    #[tokio::test]
    async fn delete_all_is_scoped_per_addon() {
        let (repo, _dir) = setup().await;

        repo.set("addon-a", "k1", "v1").await.unwrap();
        repo.set("addon-a", "k2", "v2").await.unwrap();
        repo.set("addon-b", "k1", "keep").await.unwrap();

        repo.delete_all("addon-a").await.unwrap();

        assert_eq!(repo.get("addon-a", "k1").await.unwrap(), None);
        assert_eq!(repo.get("addon-a", "k2").await.unwrap(), None);
        assert_eq!(
            repo.get("addon-b", "k1").await.unwrap().as_deref(),
            Some("keep"),
            "delete_all must not touch other addons"
        );
    }

    #[tokio::test]
    async fn composite_primary_key_isolates_same_key_across_addons() {
        let (repo, _dir) = setup().await;

        repo.set("addon-a", "shared", "a-value").await.unwrap();
        repo.set("addon-b", "shared", "b-value").await.unwrap();

        assert_eq!(
            repo.get("addon-a", "shared").await.unwrap().as_deref(),
            Some("a-value")
        );
        assert_eq!(
            repo.get("addon-b", "shared").await.unwrap().as_deref(),
            Some("b-value")
        );
        assert_eq!(count_rows(&repo), 2);
    }

    #[tokio::test]
    async fn set_emits_update_outbox_event() {
        let (repo, _dir) = setup().await;

        repo.set("addon-a", "prefs", "v1").await.unwrap();

        let rows = addon_storage_outbox(&repo);
        assert_eq!(rows.len(), 1, "set must emit exactly one outbox event");
        let (entity_id, op, payload) = &rows[0];
        assert_eq!(entity_id, &addon_storage_id("addon-a", "prefs"));
        assert_eq!(op, "update");
        // normalize_outbox_payload rewrites keys to snake_case.
        assert_eq!(payload["addon_id"], "addon-a");
        assert_eq!(payload["key"], "prefs");
        assert_eq!(payload["value"], "v1");
    }

    #[tokio::test]
    async fn delete_emits_delete_outbox_event() {
        let (repo, _dir) = setup().await;

        repo.set("addon-a", "prefs", "v1").await.unwrap();
        repo.delete("addon-a", "prefs").await.unwrap();

        let rows = addon_storage_outbox(&repo);
        assert_eq!(rows.len(), 2, "expected set + delete outbox events");
        let (entity_id, op, payload) = &rows[1];
        assert_eq!(entity_id, &addon_storage_id("addon-a", "prefs"));
        assert_eq!(op, "delete");
        assert_eq!(payload["addon_id"], "addon-a");
        assert_eq!(payload["key"], "prefs");
    }

    #[tokio::test]
    async fn delete_all_emits_no_outbox_event() {
        let (repo, _dir) = setup().await;

        repo.set("addon-a", "k1", "v1").await.unwrap();
        repo.set("addon-a", "k2", "v2").await.unwrap();
        let before = addon_storage_outbox(&repo).len();

        repo.delete_all("addon-a").await.unwrap();

        let after = addon_storage_outbox(&repo).len();
        assert_eq!(
            before, after,
            "delete_all (uninstall cleanup) must stay local-only"
        );
    }
}
