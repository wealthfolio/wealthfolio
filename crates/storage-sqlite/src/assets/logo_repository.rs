//! SQLite repository for custom asset logos, with sync outbox capture.

use std::sync::Arc;

use async_trait::async_trait;
use diesel::prelude::*;

use wealthfolio_core::assets::{AssetLogo, AssetLogoRepositoryTrait, AssetLogoSummary};
use wealthfolio_core::Result;

use super::logo_model::AssetLogoDB;
use crate::db::{get_connection, DbPool, WriteHandle};
use crate::errors::StorageError;
use crate::schema::{asset_logos, assets};

pub struct AssetLogoRepository {
    pool: Arc<DbPool>,
    writer: WriteHandle,
}

impl AssetLogoRepository {
    pub fn new(pool: Arc<DbPool>, writer: WriteHandle) -> Self {
        Self { pool, writer }
    }
}

#[async_trait]
impl AssetLogoRepositoryTrait for AssetLogoRepository {
    fn get(&self, asset_id: &str) -> Result<Option<AssetLogo>> {
        let mut conn = get_connection(&self.pool)?;
        let row = asset_logos::table
            .find(asset_id)
            .select(AssetLogoDB::as_select())
            .first::<AssetLogoDB>(&mut conn)
            .optional()
            .map_err(StorageError::from)?;
        Ok(row.map(AssetLogo::from))
    }

    fn list_summaries(&self) -> Result<Vec<AssetLogoSummary>> {
        let mut conn = get_connection(&self.pool)?;
        let rows = asset_logos::table
            .inner_join(assets::table)
            .select((
                asset_logos::asset_id,
                assets::display_code,
                asset_logos::sha256,
                asset_logos::updated_at,
            ))
            .order(asset_logos::asset_id.asc())
            .load::<(String, Option<String>, String, String)>(&mut conn)
            .map_err(StorageError::from)?;
        Ok(rows
            .into_iter()
            .map(
                |(asset_id, display_code, sha256, updated_at)| AssetLogoSummary {
                    asset_id,
                    display_code,
                    sha256,
                    updated_at,
                },
            )
            .collect())
    }

    async fn upsert(&self, logo: AssetLogo) -> Result<AssetLogo> {
        let db: AssetLogoDB = logo.into();
        self.writer
            .exec_tx(move |tx| -> Result<AssetLogo> {
                let existed = asset_logos::table
                    .find(&db.asset_id)
                    .select(asset_logos::asset_id)
                    .first::<String>(tx.conn())
                    .optional()
                    .map_err(StorageError::from)?
                    .is_some();

                diesel::insert_into(asset_logos::table)
                    .values(&db)
                    .on_conflict(asset_logos::asset_id)
                    .do_update()
                    .set((
                        asset_logos::mime_type.eq(&db.mime_type),
                        asset_logos::data.eq(&db.data),
                        asset_logos::sha256.eq(&db.sha256),
                        asset_logos::width.eq(db.width),
                        asset_logos::height.eq(db.height),
                        asset_logos::updated_at.eq(&db.updated_at),
                    ))
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;

                let stored = asset_logos::table
                    .find(&db.asset_id)
                    .select(AssetLogoDB::as_select())
                    .first::<AssetLogoDB>(tx.conn())
                    .map_err(StorageError::from)?;
                if existed {
                    tx.update(&stored)?;
                } else {
                    tx.insert(&stored)?;
                }
                Ok(stored.into())
            })
            .await
    }

    async fn delete(&self, asset_id: &str) -> Result<bool> {
        let asset_id = asset_id.to_string();
        self.writer
            .exec_tx(move |tx| -> Result<bool> {
                let deleted = diesel::delete(asset_logos::table.find(&asset_id))
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;
                if deleted > 0 {
                    tx.delete::<AssetLogoDB>(asset_id);
                }
                Ok(deleted > 0)
            })
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{create_pool, run_migrations, write_actor::spawn_writer, TestDir};

    async fn setup() -> (AssetLogoRepository, TestDir) {
        std::env::set_var("CONNECT_API_URL", "http://test.local");
        let dir = TestDir::new();
        let db_path = dir.path().join("test.db").to_string_lossy().to_string();
        run_migrations(&db_path).unwrap();
        let pool = create_pool(&db_path).unwrap();
        let writer = spawn_writer((*pool).clone()).unwrap();
        let repo = AssetLogoRepository::new(Arc::clone(&pool), writer);
        (repo, dir)
    }

    fn insert_asset(repo: &AssetLogoRepository, id: &str, display_code: &str) {
        let mut conn = get_connection(&repo.pool).unwrap();
        diesel::sql_query(format!(
            "INSERT INTO assets (id, kind, name, display_code, is_active, quote_mode, quote_ccy, instrument_symbol, created_at, updated_at) \
             VALUES ('{id}', 'INVESTMENT', 'Logo Test Asset', '{display_code}', 1, 'MANUAL', 'USD', '{display_code}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
        ))
        .execute(&mut conn)
        .unwrap();
    }

    fn logo(asset_id: &str, data: &str) -> AssetLogo {
        AssetLogo {
            asset_id: asset_id.to_string(),
            mime_type: "image/png".to_string(),
            data_base64: data.to_string(),
            sha256: format!("sha-{data}"),
            width: 1,
            height: 1,
            created_at: "2026-09-02T00:00:00+00:00".to_string(),
            updated_at: "2026-09-02T00:00:00+00:00".to_string(),
        }
    }

    /// Outbox rows for the asset_logo entity, as (entity_id, op, payload_json).
    fn logo_outbox(repo: &AssetLogoRepository) -> Vec<(String, String, serde_json::Value)> {
        use crate::schema::sync_outbox;
        let mut conn = get_connection(&repo.pool).unwrap();
        sync_outbox::table
            .filter(sync_outbox::entity.eq("asset_logo"))
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
    async fn get_missing_returns_none() {
        let (repo, _dir) = setup().await;
        assert_eq!(repo.get("nope").unwrap(), None);
    }

    #[tokio::test]
    async fn upsert_then_get_and_list_summaries() {
        let (repo, _dir) = setup().await;
        insert_asset(&repo, "asset-a", "AAPL");

        let stored = repo.upsert(logo("asset-a", "AAAA")).await.unwrap();
        assert_eq!(stored.asset_id, "asset-a");
        assert_eq!(repo.get("asset-a").unwrap(), Some(stored.clone()));

        let summaries = repo.list_summaries().unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].asset_id, "asset-a");
        assert_eq!(summaries[0].display_code.as_deref(), Some("AAPL"));
        assert_eq!(summaries[0].sha256, stored.sha256);
    }

    #[tokio::test]
    async fn upsert_replaces_and_preserves_created_at() {
        let (repo, _dir) = setup().await;
        insert_asset(&repo, "asset-a", "AAPL");

        repo.upsert(logo("asset-a", "AAAA")).await.unwrap();
        let mut second = logo("asset-a", "BBBBBBBB");
        second.created_at = "2026-09-03T00:00:00+00:00".to_string();
        second.updated_at = "2026-09-03T00:00:00+00:00".to_string();
        let stored = repo.upsert(second).await.unwrap();

        assert_eq!(stored.data_base64, "BBBBBBBB");
        assert_eq!(stored.created_at, "2026-09-02T00:00:00+00:00");
        assert_eq!(stored.updated_at, "2026-09-03T00:00:00+00:00");
        assert_eq!(repo.list_summaries().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn upsert_rejects_missing_asset() {
        let (repo, _dir) = setup().await;
        assert!(repo.upsert(logo("ghost", "AAAA")).await.is_err());
        assert!(logo_outbox(&repo).is_empty());
    }

    #[tokio::test]
    async fn delete_returns_whether_row_existed() {
        let (repo, _dir) = setup().await;
        insert_asset(&repo, "asset-a", "AAPL");

        assert!(!repo.delete("asset-a").await.unwrap());
        repo.upsert(logo("asset-a", "AAAA")).await.unwrap();
        assert!(repo.delete("asset-a").await.unwrap());
        assert_eq!(repo.get("asset-a").unwrap(), None);
    }

    #[tokio::test]
    async fn outbox_captures_create_update_delete() {
        let (repo, _dir) = setup().await;
        insert_asset(&repo, "asset-a", "AAPL");

        repo.upsert(logo("asset-a", "AAAA")).await.unwrap();
        repo.upsert(logo("asset-a", "BBBBBBBB")).await.unwrap();
        repo.delete("asset-a").await.unwrap();
        // Deleting again must not emit a second delete event.
        repo.delete("asset-a").await.unwrap();

        let rows = logo_outbox(&repo);
        assert_eq!(rows.len(), 3, "expected create + update + delete");

        let (entity_id, op, payload) = &rows[0];
        assert_eq!(entity_id, "asset-a");
        assert_eq!(op, "create");
        assert_eq!(payload["asset_id"], "asset-a");
        assert_eq!(payload["mime_type"], "image/png");
        assert_eq!(payload["data"], "AAAA");
        assert_eq!(payload["sha256"], "sha-AAAA");
        assert_eq!(payload["width"], 1);
        assert_eq!(payload["height"], 1);
        assert!(payload.get("data_base64").is_none());

        let (_, op, payload) = &rows[1];
        assert_eq!(op, "update");
        assert_eq!(payload["data"], "BBBBBBBB");

        let (entity_id, op, payload) = &rows[2];
        assert_eq!(entity_id, "asset-a");
        assert_eq!(op, "delete");
        assert_eq!(payload, &serde_json::json!({ "asset_id": "asset-a" }));
    }
}
