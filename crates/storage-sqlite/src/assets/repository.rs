use async_trait::async_trait;
use diesel::prelude::*;
use diesel::r2d2::{self, Pool};
use diesel::sqlite::SqliteConnection;
use std::collections::HashSet;
use std::sync::Arc;

use wealthfolio_core::assets::{Asset, AssetRepositoryTrait, NewAsset, UpdateAssetProfile};
use wealthfolio_core::{Error, Result};

use super::model::{AssetDB, InsertableAssetDB};
use crate::db::{get_connection, WriteHandle};
use crate::errors::StorageError;
use crate::schema::{activities, assets, quotes};
use crate::utils::chunk_for_sqlite;

/// Repository for managing asset data in the database
pub struct AssetRepository {
    pool: Arc<Pool<r2d2::ConnectionManager<SqliteConnection>>>,
    writer: WriteHandle,
}

impl AssetRepository {
    /// Creates a new AssetRepository instance
    pub fn new(
        pool: Arc<Pool<r2d2::ConnectionManager<SqliteConnection>>>,
        writer: WriteHandle,
    ) -> Self {
        Self { pool, writer }
    }

    /// Retrieves an asset by its ID
    pub fn get_by_id_impl(&self, asset_id: &str) -> Result<Asset> {
        let mut conn = get_connection(&self.pool)?;

        let result = assets::table
            .select(AssetDB::as_select())
            .find(asset_id)
            .first::<AssetDB>(&mut conn)
            .map_err(StorageError::from)?;

        Ok(result.into())
    }

    /// Lists all assets in the database
    pub fn list_impl(&self) -> Result<Vec<Asset>> {
        let mut conn = get_connection(&self.pool)?;

        let results = assets::table
            .select(AssetDB::as_select())
            .load::<AssetDB>(&mut conn)
            .map_err(StorageError::from)?;

        Ok(results.into_iter().map(Asset::from).collect())
    }

    pub fn list_by_asset_ids_impl(&self, asset_ids: &[String]) -> Result<Vec<Asset>> {
        if asset_ids.is_empty() {
            return Ok(Vec::new());
        }

        let mut conn = get_connection(&self.pool)?;
        let mut all_results = Vec::new();

        // Chunk the asset_ids to avoid SQLite parameter limits
        for chunk in chunk_for_sqlite(asset_ids) {
            let results = assets::table
                .select(AssetDB::as_select())
                .filter(assets::id.eq_any(chunk))
                .load::<AssetDB>(&mut conn)
                .map_err(StorageError::from)?;

            all_results.extend(results.into_iter().map(Asset::from));
        }

        Ok(all_results)
    }

    /// Search for assets by display_code or name (case-insensitive partial match).
    pub fn search_by_symbol_impl(&self, query: &str) -> Result<Vec<Asset>> {
        let mut conn = get_connection(&self.pool)?;

        let pattern = format!("%{}%", query.to_uppercase());

        let results = assets::table
            .select(AssetDB::as_select())
            .filter(diesel::dsl::sql::<diesel::sql_types::Bool>(&format!(
                "UPPER(display_code) LIKE '{}'",
                pattern.replace('\'', "''")
            )))
            .or_filter(diesel::dsl::sql::<diesel::sql_types::Bool>(&format!(
                "UPPER(instrument_symbol) LIKE '{}'",
                pattern.replace('\'', "''")
            )))
            .or_filter(diesel::dsl::sql::<diesel::sql_types::Bool>(&format!(
                "UPPER(name) LIKE '{}'",
                pattern.replace('\'', "''")
            )))
            .order(assets::display_code.asc())
            .limit(50)
            .load::<AssetDB>(&mut conn)
            .map_err(StorageError::from)?;

        Ok(results.into_iter().map(Asset::from).collect())
    }
}

#[async_trait]
impl AssetRepositoryTrait for AssetRepository {
    /// Creates a new asset in the database
    async fn create(&self, new_asset: NewAsset) -> Result<Asset> {
        new_asset.validate()?;
        let asset_db: InsertableAssetDB = new_asset.into();

        self.writer
            .exec_tx(move |tx| -> Result<Asset> {
                let result_db = diesel::insert_into(assets::table)
                    .values(&asset_db)
                    .get_result::<AssetDB>(tx.conn())
                    .map_err(StorageError::from)?;
                let payload_db = result_db.clone();
                let asset: Asset = result_db.into();
                tx.insert(&payload_db)?;
                Ok(asset)
            })
            .await
    }

    async fn create_batch(&self, new_assets: Vec<NewAsset>) -> Result<Vec<Asset>> {
        if new_assets.is_empty() {
            return Ok(Vec::new());
        }
        for asset in &new_assets {
            asset.validate()?;
        }
        let assets_db: Vec<InsertableAssetDB> = new_assets.into_iter().map(|a| a.into()).collect();
        let ids: Vec<String> = assets_db.iter().filter_map(|a| a.id.clone()).collect();

        self.writer
            .exec_tx(move |tx| -> Result<Vec<Asset>> {
                let existing_ids: HashSet<String> = assets::table
                    .filter(assets::id.eq_any(&ids))
                    .select(assets::id)
                    .load::<String>(tx.conn())
                    .map_err(StorageError::from)?
                    .into_iter()
                    .collect();

                // INSERT OR IGNORE: skip assets that already exist
                for asset_db in &assets_db {
                    diesel::insert_into(assets::table)
                        .values(asset_db)
                        .on_conflict(assets::id)
                        .do_nothing()
                        .execute(tx.conn())
                        .map_err(StorageError::from)?;
                }

                // Re-read all to return the full set
                let results = assets::table
                    .filter(assets::id.eq_any(&ids))
                    .load::<AssetDB>(tx.conn())
                    .map_err(StorageError::from)?;
                for result in &results {
                    if !existing_ids.contains(&result.id) {
                        tx.insert(result)?;
                    }
                }
                Ok(results.into_iter().map(|r| r.into()).collect())
            })
            .await
    }

    /// Updates an existing asset in the database
    async fn update_profile(&self, asset_id: &str, payload: UpdateAssetProfile) -> Result<Asset> {
        payload.validate()?;
        let asset_id_owned = asset_id.to_string();
        let payload_owned = payload.clone();

        self.writer
            .exec_tx(move |tx| -> Result<Asset> {
                // First, get the existing asset to preserve fields if not provided
                let existing: AssetDB = assets::table
                    .filter(assets::id.eq(&asset_id_owned))
                    .first(tx.conn())
                    .map_err(StorageError::from)?;

                // Use payload metadata if provided, otherwise preserve existing
                let metadata_json = match &payload_owned.metadata {
                    Some(new_metadata) => {
                        Some(serde_json::to_string(new_metadata).unwrap_or_default())
                    }
                    None => existing.metadata.clone(),
                };

                // Serialize kind to string if present
                let kind_str = payload_owned
                    .kind
                    .as_ref()
                    .map(|k| k.as_db_str().to_string());

                // Serialize quote_mode to string if present
                let quote_mode_str = payload_owned
                    .quote_mode
                    .as_ref()
                    .map(|qm| qm.as_db_str().to_string());

                // Serialize provider_config to JSON string if present
                let provider_config_str = payload_owned
                    .provider_config
                    .as_ref()
                    .map(|pc| serde_json::to_string(pc).unwrap_or_default());

                // Instrument fields - use payload if present, otherwise keep existing
                let instrument_type_value = payload_owned
                    .instrument_type
                    .as_ref()
                    .map(|t| Some(t.as_db_str().to_string()))
                    .unwrap_or_else(|| existing.instrument_type.clone());

                let instrument_symbol_value = if payload_owned.instrument_symbol.is_some() {
                    payload_owned.instrument_symbol.clone()
                } else {
                    existing.instrument_symbol.clone()
                };

                let instrument_exchange_mic_value =
                    if payload_owned.instrument_exchange_mic.is_some() {
                        payload_owned.instrument_exchange_mic.clone()
                    } else {
                        existing.instrument_exchange_mic.clone()
                    };
                let quote_ccy_value = payload_owned
                    .quote_ccy
                    .clone()
                    .unwrap_or_else(|| existing.quote_ccy.clone());

                // Build the update query
                let result_db = if let Some(kind_value) = kind_str {
                    diesel::update(assets::table.filter(assets::id.eq(&asset_id_owned)))
                        .set((
                            assets::name.eq(&payload_owned.name),
                            assets::kind.eq(kind_value),
                            assets::display_code.eq(&payload_owned.display_code),
                            assets::notes.eq(&payload_owned.notes),
                            assets::metadata.eq(&metadata_json),
                            assets::quote_mode.eq(quote_mode_str
                                .clone()
                                .unwrap_or_else(|| "MARKET".to_string())),
                            assets::quote_ccy.eq(&quote_ccy_value),
                            assets::instrument_type.eq(&instrument_type_value),
                            assets::instrument_symbol.eq(&instrument_symbol_value),
                            assets::instrument_exchange_mic.eq(&instrument_exchange_mic_value),
                            assets::provider_config.eq(&provider_config_str),
                        ))
                        .get_result::<AssetDB>(tx.conn())
                        .map_err(StorageError::from)?
                } else {
                    diesel::update(assets::table.filter(assets::id.eq(&asset_id_owned)))
                        .set((
                            assets::name.eq(&payload_owned.name),
                            assets::display_code.eq(&payload_owned.display_code),
                            assets::notes.eq(&payload_owned.notes),
                            assets::metadata.eq(&metadata_json),
                            assets::quote_mode
                                .eq(quote_mode_str.unwrap_or_else(|| "MARKET".to_string())),
                            assets::quote_ccy.eq(&quote_ccy_value),
                            assets::instrument_type.eq(&instrument_type_value),
                            assets::instrument_symbol.eq(&instrument_symbol_value),
                            assets::instrument_exchange_mic.eq(&instrument_exchange_mic_value),
                            assets::provider_config.eq(&provider_config_str),
                        ))
                        .get_result::<AssetDB>(tx.conn())
                        .map_err(StorageError::from)?
                };
                let payload_db = result_db.clone();
                let asset: Asset = result_db.into();
                tx.update(&payload_db)?;
                Ok(asset)
            })
            .await
    }

    /// Updates the quote mode of an asset (MARKET, MANUAL)
    async fn update_quote_mode(&self, asset_id: &str, quote_mode: &str) -> Result<Asset> {
        let asset_id_owned = asset_id.to_string();
        let quote_mode_owned = quote_mode.to_string();
        self.writer
            .exec_tx(move |tx| -> Result<Asset> {
                let result_db = diesel::update(assets::table.filter(assets::id.eq(asset_id_owned)))
                    .set(assets::quote_mode.eq(quote_mode_owned))
                    .get_result::<AssetDB>(tx.conn())
                    .map_err(StorageError::from)?;
                let payload_db = result_db.clone();
                tx.update(&payload_db)?;
                Ok(result_db.into())
            })
            .await
    }

    /// Retrieves an asset by its ID
    fn get_by_id(&self, asset_id: &str) -> Result<Asset> {
        self.get_by_id_impl(asset_id)
    }

    /// Lists all assets in the database
    fn list(&self) -> Result<Vec<Asset>> {
        self.list_impl()
    }

    /// Lists assets by their asset IDs
    fn list_by_asset_ids(&self, asset_ids: &[String]) -> Result<Vec<Asset>> {
        self.list_by_asset_ids_impl(asset_ids)
    }

    async fn delete(&self, asset_id: &str) -> Result<()> {
        let asset_id_owned = asset_id.to_string();
        let asset_id_for_event = asset_id_owned.clone();
        self.writer
            .exec_tx(move |tx| -> Result<()> {
                // Check for activities constraint
                let activity_count: i64 = activities::table
                    .filter(activities::asset_id.eq(&asset_id_owned))
                    .count()
                    .get_result(tx.conn())
                    .map_err(StorageError::from)?;

                if activity_count > 0 {
                    return Err(Error::ConstraintViolation(
                        "Cannot delete asset: it has existing activities. Please delete all associated activities first.".to_string()
                    ));
                }

                // Delete all quotes for this asset (by asset_id)
                diesel::delete(quotes::table.filter(quotes::asset_id.eq(&asset_id_owned)))
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;

                // Delete the asset
                diesel::delete(assets::table.filter(assets::id.eq(&asset_id_owned)))
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;

                tx.delete::<AssetDB>(asset_id_for_event.clone());

                Ok(())
            })
            .await
    }

    fn search_by_symbol(&self, query: &str) -> Result<Vec<Asset>> {
        self.search_by_symbol_impl(query)
    }

    /// Find an asset by its instrument_key
    fn find_by_instrument_key(&self, instrument_key: &str) -> Result<Option<Asset>> {
        let mut conn = get_connection(&self.pool)?;

        let result = assets::table
            .select(AssetDB::as_select())
            .filter(assets::instrument_key.eq(instrument_key))
            .first::<AssetDB>(&mut conn)
            .optional()
            .map_err(StorageError::from)?;

        Ok(result.map(Asset::from))
    }

    async fn cleanup_legacy_metadata(&self, asset_id: &str) -> Result<()> {
        let asset_id_owned = asset_id.to_string();
        self.writer
            .exec_tx(move |tx| -> Result<()> {
                // Get current metadata
                let existing: AssetDB = assets::table
                    .filter(assets::id.eq(&asset_id_owned))
                    .first(tx.conn())
                    .map_err(StorageError::from)?;

                // Parse current metadata and remove $.legacy, keep $.identifiers
                let new_metadata: Option<String> = existing.metadata.and_then(|meta_str| {
                    serde_json::from_str::<serde_json::Value>(&meta_str)
                        .ok()
                        .and_then(|meta| {
                            let identifiers = meta.get("identifiers").cloned();
                            identifiers
                                .map(|ids| serde_json::json!({ "identifiers": ids }).to_string())
                        })
                });

                // Update the asset
                diesel::update(assets::table.filter(assets::id.eq(&asset_id_owned)))
                    .set(assets::metadata.eq(new_metadata))
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;
                let updated = assets::table
                    .filter(assets::id.eq(&asset_id_owned))
                    .first::<AssetDB>(tx.conn())
                    .map_err(StorageError::from)?;
                tx.update(&updated)?;

                Ok(())
            })
            .await
    }

    async fn deactivate(&self, asset_id: &str) -> Result<()> {
        let asset_id_owned = asset_id.to_string();
        self.writer
            .exec_tx(move |tx| -> Result<()> {
                let updated = diesel::update(assets::table.filter(assets::id.eq(&asset_id_owned)))
                    .set(assets::is_active.eq(0))
                    .get_result::<AssetDB>(tx.conn())
                    .map_err(StorageError::from)?;
                tx.update(&updated)?;
                Ok(())
            })
            .await
    }

    async fn reactivate(&self, asset_id: &str) -> Result<()> {
        let asset_id_owned = asset_id.to_string();
        self.writer
            .exec_tx(move |tx| -> Result<()> {
                let updated = diesel::update(assets::table.filter(assets::id.eq(&asset_id_owned)))
                    .set(assets::is_active.eq(1))
                    .get_result::<AssetDB>(tx.conn())
                    .map_err(StorageError::from)?;
                tx.update(&updated)?;
                Ok(())
            })
            .await
    }

    async fn reactivate_batch(&self, asset_ids: &[String]) -> Result<()> {
        if asset_ids.is_empty() {
            return Ok(());
        }

        let asset_ids = asset_ids.to_vec();
        self.writer
            .exec_tx(move |tx| -> Result<()> {
                for chunk in chunk_for_sqlite(&asset_ids) {
                    diesel::update(assets::table.filter(assets::id.eq_any(chunk)))
                        .set(assets::is_active.eq(1))
                        .execute(tx.conn())
                        .map_err(StorageError::from)?;

                    let updated_rows = assets::table
                        .filter(assets::id.eq_any(chunk))
                        .select(AssetDB::as_select())
                        .load::<AssetDB>(tx.conn())
                        .map_err(StorageError::from)?;
                    for updated in updated_rows {
                        tx.update(&updated)?;
                    }
                }

                Ok(())
            })
            .await
    }

    async fn copy_user_metadata(&self, source_id: &str, target_id: &str) -> Result<()> {
        let source_id_owned = source_id.to_string();
        let target_id_owned = target_id.to_string();
        self.writer
            .exec_tx(move |tx| -> Result<()> {
                // Get source asset
                let source: AssetDB = assets::table
                    .filter(assets::id.eq(&source_id_owned))
                    .first(tx.conn())
                    .map_err(StorageError::from)?;

                // Only copy notes (user-editable field) if source has content
                // Don't overwrite target's notes if source is empty
                if let Some(ref notes) = source.notes {
                    if !notes.trim().is_empty() {
                        let updated =
                            diesel::update(assets::table.filter(assets::id.eq(&target_id_owned)))
                                .set(assets::notes.eq(notes))
                                .get_result::<AssetDB>(tx.conn())
                                .map_err(StorageError::from)?;
                        tx.update(&updated)?;
                    }
                }

                Ok(())
            })
            .await
    }

    async fn deactivate_orphaned_investments(&self) -> Result<Vec<String>> {
        self.writer
            .exec_tx(move |tx| -> Result<Vec<String>> {
                // Find active INVESTMENT assets with no activities and no holdings history in
                // non-archived accounts. Any historical snapshot reference is enough to keep
                // the asset active because old valuations may still need its quote history.
                let orphan_ids: Vec<String> = assets::table
                    .select(assets::id)
                    .filter(assets::kind.eq("INVESTMENT"))
                    .filter(assets::is_active.eq(1))
                    .filter(diesel::dsl::sql::<diesel::sql_types::Bool>(
                        r#"
                        NOT EXISTS (
                            SELECT 1
                            FROM activities activity
                            WHERE activity.asset_id = assets.id
                        )
                        AND assets.id NOT IN (
                            SELECT DISTINCT position.key
                            FROM holdings_snapshots snapshot
                            JOIN accounts account ON account.id = snapshot.account_id
                            JOIN json_each(snapshot.positions) position
                            WHERE account.is_archived = 0
                        )
                        "#,
                    ))
                    .load::<String>(tx.conn())
                    .map_err(StorageError::from)?;

                if !orphan_ids.is_empty() {
                    for chunk in chunk_for_sqlite(&orphan_ids) {
                        diesel::update(assets::table.filter(assets::id.eq_any(chunk)))
                            .set(assets::is_active.eq(0))
                            .execute(tx.conn())
                            .map_err(StorageError::from)?;

                        let updated_rows = assets::table
                            .filter(assets::id.eq_any(chunk))
                            .select(AssetDB::as_select())
                            .load::<AssetDB>(tx.conn())
                            .map_err(StorageError::from)?;
                        for updated in updated_rows {
                            tx.update(&updated)?;
                        }
                    }
                }

                Ok(orphan_ids)
            })
            .await
    }

    async fn link_options_to_underlying(
        &self,
        symbol: &str,
        equity_asset_id: &str,
    ) -> Result<usize> {
        let symbol = symbol.to_string();
        let equity_asset_id = equity_asset_id.to_string();
        self.writer
            .exec_tx(move |tx| -> Result<usize> {
                // Find option assets whose underlyingAssetSymbol matches and resolved id is missing.
                let candidate_ids: Vec<String> = assets::table
                    .select(assets::id)
                    .filter(assets::instrument_type.eq("OPTION"))
                    .filter(diesel::dsl::sql::<diesel::sql_types::Bool>(&format!(
                        "json_extract(metadata, '$.option.underlyingAssetSymbol') = '{}' \
                         AND (json_extract(metadata, '$.option.underlyingResolvedId') IS NULL \
                              OR json_extract(metadata, '$.option.underlyingResolvedId') = '')",
                        symbol.replace('\'', "''")
                    )))
                    .load::<String>(tx.conn())
                    .map_err(StorageError::from)?;

                if candidate_ids.is_empty() {
                    return Ok(0);
                }

                let updated = diesel::sql_query(
                    "UPDATE assets \
                     SET metadata = json_set(metadata, '$.option.underlyingResolvedId', ?) \
                     WHERE id IN (SELECT value FROM json_each(?))",
                )
                .bind::<diesel::sql_types::Text, _>(equity_asset_id.clone())
                .bind::<diesel::sql_types::Text, _>(
                    serde_json::to_string(&candidate_ids).unwrap_or_else(|_| "[]".to_string()),
                )
                .execute(tx.conn())
                .map_err(StorageError::from)?;

                // Notify sync layer about the changed rows.
                let updated_rows = assets::table
                    .filter(assets::id.eq_any(&candidate_ids))
                    .select(AssetDB::as_select())
                    .load::<AssetDB>(tx.conn())
                    .map_err(StorageError::from)?;
                for updated in updated_rows {
                    tx.update(&updated)?;
                }

                Ok(updated)
            })
            .await
    }

    fn list_options_for_underlying(
        &self,
        equity_asset_id: &str,
        underlying_symbol: &str,
    ) -> Result<Vec<Asset>> {
        let mut conn = get_connection(&self.pool)?;
        let asset_id_lit = equity_asset_id.replace('\'', "''");
        let symbol_lit = underlying_symbol.replace('\'', "''");

        // Match by resolved id first; for any options not yet resolved, also match by symbol.
        let results = assets::table
            .select(AssetDB::as_select())
            .filter(assets::instrument_type.eq("OPTION"))
            .filter(diesel::dsl::sql::<diesel::sql_types::Bool>(&format!(
                "json_extract(metadata, '$.option.underlyingResolvedId') = '{}' \
                 OR (json_extract(metadata, '$.option.underlyingResolvedId') IS NULL \
                     AND json_extract(metadata, '$.option.underlyingAssetSymbol') = '{}')",
                asset_id_lit, symbol_lit
            )))
            .load::<AssetDB>(&mut conn)
            .map_err(StorageError::from)?;

        Ok(results.into_iter().map(Asset::from).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{create_pool, get_connection, init, run_migrations, write_actor::spawn_writer};
    use crate::utils::SQLITE_MAX_PARAMS_CHUNK;
    use diesel::r2d2::ConnectionManager;
    use diesel::sql_query;
    use diesel::sql_types::Text;
    use std::sync::Arc;
    use tempfile::tempdir;

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

    fn insert_asset(conn: &mut SqliteConnection, asset_id: &str) {
        sql_query(
            "INSERT INTO assets (
                id, kind, name, display_code, is_active, quote_mode, quote_ccy,
                created_at, updated_at
             ) VALUES (?, 'INVESTMENT', ?, ?, 1, 'MARKET', 'USD', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
        )
        .bind::<Text, _>(asset_id)
        .bind::<Text, _>(asset_id)
        .bind::<Text, _>(asset_id)
        .execute(conn)
        .expect("insert asset");
    }

    fn insert_account(conn: &mut SqliteConnection, account_id: &str, archived: bool) {
        sql_query(format!(
            "INSERT INTO accounts (id, name, account_type, `group`, currency, is_default, is_active, \
             created_at, updated_at, platform_id, account_number, meta, provider, provider_account_id, \
             is_archived, tracking_mode) VALUES ('{}', 'Test', 'cash', NULL, 'USD', 1, 1, \
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL, NULL, NULL, NULL, {}, 'portfolio')",
            account_id,
            if archived { 1 } else { 0 }
        ))
        .execute(conn)
        .expect("insert account");
    }

    fn insert_activity(
        conn: &mut SqliteConnection,
        activity_id: &str,
        account_id: &str,
        asset_id: &str,
    ) {
        sql_query(
            "INSERT INTO activities (
                id, account_id, asset_id, activity_type, status, activity_date,
                quantity, unit_price, amount, fee, currency,
                is_user_modified, needs_review, created_at, updated_at
             ) VALUES (?, ?, ?, 'BUY', 'POSTED', '2026-01-01T00:00:00Z',
                '1', '1', '1', '0', 'USD', 0, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        )
        .bind::<Text, _>(activity_id)
        .bind::<Text, _>(account_id)
        .bind::<Text, _>(asset_id)
        .execute(conn)
        .expect("insert activity");
    }

    fn insert_holdings_snapshot(
        conn: &mut SqliteConnection,
        account_id: &str,
        snapshot_date: &str,
        positions: &str,
    ) {
        let snapshot_id = format!("{}_{}", account_id, snapshot_date);
        sql_query(
            "INSERT INTO holdings_snapshots (
                id, account_id, snapshot_date, currency, positions, cash_balances, cost_basis,
                net_contribution, calculated_at, net_contribution_base,
                cash_total_account_currency, cash_total_base_currency, source
             ) VALUES (?, ?, ?, 'USD', ?, '{}', '0', '0', '2026-01-01T00:00:00Z', '0', '0', '0', 'CALCULATED')",
        )
        .bind::<Text, _>(snapshot_id)
        .bind::<Text, _>(account_id)
        .bind::<Text, _>(snapshot_date)
        .bind::<Text, _>(positions)
        .execute(conn)
        .expect("insert holdings snapshot");
    }

    fn is_active(conn: &mut SqliteConnection, asset_id: &str) -> i32 {
        assets::table
            .filter(assets::id.eq(asset_id))
            .select(assets::is_active)
            .first(conn)
            .expect("asset active flag")
    }

    #[tokio::test]
    async fn orphan_cleanup_preserves_non_archived_snapshot_history() {
        let (pool, writer) = setup_db();
        let repo = AssetRepository::new(pool.clone(), writer);
        let mut conn = get_connection(&pool).expect("conn");

        insert_account(&mut conn, "acc-open", false);
        insert_account(&mut conn, "acc-archived", true);
        for asset_id in [
            "snapshot_only",
            "archived_only",
            "with_activity",
            "plain_orphan",
        ] {
            insert_asset(&mut conn, asset_id);
        }

        insert_holdings_snapshot(
            &mut conn,
            "acc-open",
            "2026-01-01",
            r#"{"snapshot_only":{"quantity":"0"}}"#,
        );
        insert_holdings_snapshot(
            &mut conn,
            "acc-archived",
            "2026-01-01",
            r#"{"archived_only":{"quantity":"5"}}"#,
        );
        insert_activity(&mut conn, "activity-1", "acc-open", "with_activity");
        drop(conn);

        let orphan_ids = repo
            .deactivate_orphaned_investments()
            .await
            .expect("cleanup orphans");

        assert!(!orphan_ids.contains(&"snapshot_only".to_string()));
        assert!(!orphan_ids.contains(&"with_activity".to_string()));
        assert!(orphan_ids.contains(&"archived_only".to_string()));
        assert!(orphan_ids.contains(&"plain_orphan".to_string()));

        let mut conn = get_connection(&pool).expect("conn");
        assert_eq!(is_active(&mut conn, "snapshot_only"), 1);
        assert_eq!(is_active(&mut conn, "with_activity"), 1);
        assert_eq!(is_active(&mut conn, "archived_only"), 0);
        assert_eq!(is_active(&mut conn, "plain_orphan"), 0);
    }

    #[tokio::test]
    async fn reactivate_batch_handles_more_than_one_sqlite_chunk() {
        let (pool, writer) = setup_db();
        let repo = AssetRepository::new(pool.clone(), writer);
        let mut conn = get_connection(&pool).expect("conn");
        let asset_ids: Vec<String> = (0..(SQLITE_MAX_PARAMS_CHUNK * 2 + 1))
            .map(|i| format!("asset-{i}"))
            .collect();

        for asset_id in &asset_ids {
            insert_asset(&mut conn, asset_id);
            diesel::update(assets::table.filter(assets::id.eq(asset_id)))
                .set(assets::is_active.eq(0))
                .execute(&mut conn)
                .expect("deactivate asset");
        }
        drop(conn);

        repo.reactivate_batch(&asset_ids)
            .await
            .expect("reactivate assets");

        let mut conn = get_connection(&pool).expect("conn");
        for asset_id in &asset_ids {
            assert_eq!(is_active(&mut conn, asset_id), 1);
        }
    }

    #[tokio::test]
    async fn orphan_cleanup_handles_more_than_one_sqlite_chunk() {
        let (pool, writer) = setup_db();
        let repo = AssetRepository::new(pool.clone(), writer);
        let mut conn = get_connection(&pool).expect("conn");
        let asset_ids: Vec<String> = (0..(SQLITE_MAX_PARAMS_CHUNK * 2 + 1))
            .map(|i| format!("orphan-{i}"))
            .collect();

        for asset_id in &asset_ids {
            insert_asset(&mut conn, asset_id);
        }
        drop(conn);

        let orphan_ids = repo
            .deactivate_orphaned_investments()
            .await
            .expect("cleanup orphans");

        assert_eq!(orphan_ids.len(), asset_ids.len());

        let mut conn = get_connection(&pool).expect("conn");
        for asset_id in &asset_ids {
            assert_eq!(is_active(&mut conn, asset_id), 0);
        }
    }
}
