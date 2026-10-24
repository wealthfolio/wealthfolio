//! Repository for broker sync state persistence.

use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, NaiveTime, Utc};
use diesel::prelude::*;
use diesel::r2d2::{self, Pool};
use diesel::sqlite::SqliteConnection;
use std::sync::Arc;

use wealthfolio_connect::broker_ingest::{
    BrokerSyncState, BrokerSyncStateRepositoryTrait as ConnectBrokerSyncStateRepositoryTrait,
};
use wealthfolio_core::errors::{Error, Result, ValidationError};

use crate::db::{get_connection, WriteHandle};
use crate::errors::StorageError;
use crate::schema::brokers_sync_state;

use super::model::BrokerSyncStateDB;

fn parse_sync_cursor(last_synced_date: &str) -> Result<String> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(last_synced_date) {
        return Ok(dt.with_timezone(&Utc).to_rfc3339());
    }

    if let Ok(date) = NaiveDate::parse_from_str(last_synced_date, "%Y-%m-%d") {
        let dt = date.and_time(NaiveTime::MIN).and_utc();
        return Ok(dt.to_rfc3339());
    }

    Err(Error::Validation(ValidationError::InvalidInput(format!(
        "Invalid broker sync cursor '{}'",
        last_synced_date
    ))))
}

pub struct BrokerSyncStateRepository {
    pool: Arc<Pool<r2d2::ConnectionManager<SqliteConnection>>>,
    writer: WriteHandle,
}

impl BrokerSyncStateRepository {
    pub fn new(
        pool: Arc<Pool<r2d2::ConnectionManager<SqliteConnection>>>,
        writer: WriteHandle,
    ) -> Self {
        Self { pool, writer }
    }

    /// Get or create sync state for account+provider
    pub async fn get_or_create(
        &self,
        account_id: String,
        provider: String,
    ) -> Result<BrokerSyncState> {
        self.writer
            .exec(move |conn| {
                let existing = brokers_sync_state::table
                    .find((&account_id, &provider))
                    .first::<BrokerSyncStateDB>(conn)
                    .optional()
                    .map_err(StorageError::from)?;

                match existing {
                    Some(db) => Ok(db.into()),
                    None => {
                        let new_state = BrokerSyncState::new(account_id, provider);
                        let db_model: BrokerSyncStateDB = new_state.clone().into();

                        diesel::insert_into(brokers_sync_state::table)
                            .values(&db_model)
                            .execute(conn)
                            .map_err(StorageError::from)?;

                        Ok(new_state)
                    }
                }
            })
            .await
    }

    /// Get sync state by account+provider (read-only)
    pub fn get(&self, account_id: &str, provider: &str) -> Result<Option<BrokerSyncState>> {
        let mut conn = get_connection(&self.pool)?;

        let result = brokers_sync_state::table
            .find((account_id, provider))
            .first::<BrokerSyncStateDB>(&mut conn)
            .optional()
            .map_err(StorageError::from)?;

        Ok(result.map(Into::into))
    }

    /// Get sync state by account ID (first provider found)
    pub fn get_by_account_id(&self, account_id: &str) -> Result<Option<BrokerSyncState>> {
        let mut conn = get_connection(&self.pool)?;

        let result = brokers_sync_state::table
            .filter(brokers_sync_state::account_id.eq(account_id))
            .first::<BrokerSyncStateDB>(&mut conn)
            .optional()
            .map_err(StorageError::from)?;

        Ok(result.map(Into::into))
    }

    /// Update sync state
    pub async fn update(&self, state: BrokerSyncState) -> Result<BrokerSyncState> {
        self.writer
            .exec(move |conn| {
                let db_model: BrokerSyncStateDB = state.into();

                diesel::update(
                    brokers_sync_state::table.find((&db_model.account_id, &db_model.provider)),
                )
                .set(&db_model)
                .execute(conn)
                .map_err(StorageError::from)?;

                Ok(db_model.into())
            })
            .await
    }

    /// Record a sync attempt (upsert with RUNNING status)
    pub async fn upsert_attempt(&self, account_id: String, provider: String) -> Result<()> {
        self.writer
            .exec(move |conn| {
                let now = Utc::now();
                let now_str = now.to_rfc3339();

                // Check if exists
                let existing = brokers_sync_state::table
                    .find((&account_id, &provider))
                    .first::<BrokerSyncStateDB>(conn)
                    .optional()
                    .map_err(StorageError::from)?;

                match existing {
                    Some(_) => {
                        // Update attempt timestamp and status
                        diesel::update(brokers_sync_state::table.find((&account_id, &provider)))
                            .set((
                                brokers_sync_state::last_attempted_at.eq(&now_str),
                                brokers_sync_state::sync_status.eq("RUNNING"),
                                brokers_sync_state::updated_at.eq(&now_str),
                            ))
                            .execute(conn)
                            .map_err(StorageError::from)?;
                    }
                    None => {
                        // Create new record
                        let new_state = BrokerSyncStateDB {
                            account_id,
                            provider,
                            checkpoint_json: None,
                            last_attempted_at: Some(now_str.clone()),
                            last_successful_at: None,
                            last_error: None,
                            last_run_id: None,
                            sync_status: "RUNNING".to_string(),
                            created_at: now_str.clone(),
                            updated_at: now_str,
                        };

                        diesel::insert_into(brokers_sync_state::table)
                            .values(&new_state)
                            .execute(conn)
                            .map_err(StorageError::from)?;
                    }
                }

                Ok(())
            })
            .await
    }

    /// Record a successful sync (upsert with IDLE status)
    pub async fn upsert_success(
        &self,
        account_id: String,
        provider: String,
        last_synced_date: String,
        import_run_id: Option<String>,
    ) -> Result<()> {
        let cursor_str = parse_sync_cursor(&last_synced_date)?;

        self.writer
            .exec(move |conn| {
                let now = Utc::now();
                let now_str = now.to_rfc3339();

                // Check if exists
                let existing = brokers_sync_state::table
                    .find((&account_id, &provider))
                    .first::<BrokerSyncStateDB>(conn)
                    .optional()
                    .map_err(StorageError::from)?;

                match existing {
                    Some(_) => {
                        // Update success timestamp and status
                        diesel::update(brokers_sync_state::table.find((&account_id, &provider)))
                            .set((
                                brokers_sync_state::last_successful_at.eq(&cursor_str),
                                brokers_sync_state::sync_status.eq("IDLE"),
                                brokers_sync_state::last_error.eq::<Option<String>>(None),
                                brokers_sync_state::last_run_id.eq(&import_run_id),
                                brokers_sync_state::updated_at.eq(&now_str),
                            ))
                            .execute(conn)
                            .map_err(StorageError::from)?;
                    }
                    None => {
                        // Create new record
                        let new_state = BrokerSyncStateDB {
                            account_id,
                            provider,
                            checkpoint_json: None,
                            last_attempted_at: Some(now_str.clone()),
                            last_successful_at: Some(cursor_str),
                            last_error: None,
                            last_run_id: import_run_id,
                            sync_status: "IDLE".to_string(),
                            created_at: now_str.clone(),
                            updated_at: now_str,
                        };

                        diesel::insert_into(brokers_sync_state::table)
                            .values(&new_state)
                            .execute(conn)
                            .map_err(StorageError::from)?;
                    }
                }

                Ok(())
            })
            .await
    }

    /// Record a failed sync (upsert with FAILED status)
    pub async fn upsert_failure(
        &self,
        account_id: String,
        provider: String,
        error: String,
        import_run_id: Option<String>,
    ) -> Result<()> {
        self.writer
            .exec(move |conn| {
                let now = Utc::now();
                let now_str = now.to_rfc3339();

                // Check if exists
                let existing = brokers_sync_state::table
                    .find((&account_id, &provider))
                    .first::<BrokerSyncStateDB>(conn)
                    .optional()
                    .map_err(StorageError::from)?;

                match existing {
                    Some(_) => {
                        // Update failure
                        diesel::update(brokers_sync_state::table.find((&account_id, &provider)))
                            .set((
                                brokers_sync_state::sync_status.eq("FAILED"),
                                brokers_sync_state::last_error.eq(&error),
                                brokers_sync_state::last_run_id.eq(&import_run_id),
                                brokers_sync_state::updated_at.eq(&now_str),
                            ))
                            .execute(conn)
                            .map_err(StorageError::from)?;
                    }
                    None => {
                        // Create new record with error
                        let new_state = BrokerSyncStateDB {
                            account_id,
                            provider,
                            checkpoint_json: None,
                            last_attempted_at: Some(now_str.clone()),
                            last_successful_at: None,
                            last_error: Some(error),
                            last_run_id: import_run_id,
                            sync_status: "FAILED".to_string(),
                            created_at: now_str.clone(),
                            updated_at: now_str,
                        };

                        diesel::insert_into(brokers_sync_state::table)
                            .values(&new_state)
                            .execute(conn)
                            .map_err(StorageError::from)?;
                    }
                }

                Ok(())
            })
            .await
    }

    /// Record a partial sync warning (upsert with NEEDS_REVIEW status)
    pub async fn upsert_needs_review(
        &self,
        account_id: String,
        provider: String,
        warning: String,
        import_run_id: Option<String>,
    ) -> Result<()> {
        self.writer
            .exec(move |conn| {
                let now = Utc::now();
                let now_str = now.to_rfc3339();

                // Check if exists
                let existing = brokers_sync_state::table
                    .find((&account_id, &provider))
                    .first::<BrokerSyncStateDB>(conn)
                    .optional()
                    .map_err(StorageError::from)?;

                match existing {
                    Some(_) => {
                        diesel::update(brokers_sync_state::table.find((&account_id, &provider)))
                            .set((
                                brokers_sync_state::sync_status.eq("NEEDS_REVIEW"),
                                brokers_sync_state::last_error.eq(&warning),
                                brokers_sync_state::last_run_id.eq(&import_run_id),
                                brokers_sync_state::updated_at.eq(&now_str),
                            ))
                            .execute(conn)
                            .map_err(StorageError::from)?;
                    }
                    None => {
                        let new_state = BrokerSyncStateDB {
                            account_id,
                            provider,
                            checkpoint_json: None,
                            last_attempted_at: Some(now_str.clone()),
                            last_successful_at: None,
                            last_error: Some(warning),
                            last_run_id: import_run_id,
                            sync_status: "NEEDS_REVIEW".to_string(),
                            created_at: now_str.clone(),
                            updated_at: now_str,
                        };

                        diesel::insert_into(brokers_sync_state::table)
                            .values(&new_state)
                            .execute(conn)
                            .map_err(StorageError::from)?;
                    }
                }

                Ok(())
            })
            .await
    }

    /// Get all sync states for an account
    pub fn get_for_account(&self, account_id: &str) -> Result<Vec<BrokerSyncState>> {
        let mut conn = get_connection(&self.pool)?;

        let results = brokers_sync_state::table
            .filter(brokers_sync_state::account_id.eq(account_id))
            .load::<BrokerSyncStateDB>(&mut conn)
            .map_err(StorageError::from)?;

        Ok(results.into_iter().map(Into::into).collect())
    }

    /// Get all broker sync states
    pub fn get_all(&self) -> Result<Vec<BrokerSyncState>> {
        let mut conn = get_connection(&self.pool)?;

        let results = brokers_sync_state::table
            .order(brokers_sync_state::updated_at.desc())
            .load::<BrokerSyncStateDB>(&mut conn)
            .map_err(StorageError::from)?;

        Ok(results.into_iter().map(Into::into).collect())
    }

    /// Delete sync state
    pub async fn delete(&self, account_id: String, provider: String) -> Result<()> {
        self.writer
            .exec(move |conn| {
                diesel::delete(brokers_sync_state::table.find((&account_id, &provider)))
                    .execute(conn)
                    .map_err(StorageError::from)?;

                Ok(())
            })
            .await
    }
}

#[async_trait]
impl ConnectBrokerSyncStateRepositoryTrait for BrokerSyncStateRepository {
    fn get_by_account_id(&self, account_id: &str) -> Result<Option<BrokerSyncState>> {
        BrokerSyncStateRepository::get_by_account_id(self, account_id)
    }

    async fn upsert_attempt(&self, account_id: String, provider: String) -> Result<()> {
        BrokerSyncStateRepository::upsert_attempt(self, account_id, provider).await
    }

    async fn upsert_success(
        &self,
        account_id: String,
        provider: String,
        last_synced_date: String,
        import_run_id: Option<String>,
    ) -> Result<()> {
        BrokerSyncStateRepository::upsert_success(
            self,
            account_id,
            provider,
            last_synced_date,
            import_run_id,
        )
        .await
    }

    async fn upsert_failure(
        &self,
        account_id: String,
        provider: String,
        error: String,
        import_run_id: Option<String>,
    ) -> Result<()> {
        BrokerSyncStateRepository::upsert_failure(self, account_id, provider, error, import_run_id)
            .await
    }

    async fn upsert_needs_review(
        &self,
        account_id: String,
        provider: String,
        warning: String,
        import_run_id: Option<String>,
    ) -> Result<()> {
        BrokerSyncStateRepository::upsert_needs_review(
            self,
            account_id,
            provider,
            warning,
            import_run_id,
        )
        .await
    }

    fn get_all(&self) -> Result<Vec<BrokerSyncState>> {
        BrokerSyncStateRepository::get_all(self)
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_sync_cursor, BrokerSyncStateRepository};
    use crate::db::{create_pool, get_connection, run_migrations, write_actor::spawn_writer};
    use diesel::sql_query;
    use diesel::RunQueryDsl;
    use std::sync::Arc;
    use tempfile::tempdir;

    fn setup_repo() -> (BrokerSyncStateRepository, tempfile::TempDir) {
        std::env::set_var("CONNECT_API_URL", "http://test.local");
        let temp_dir = tempdir().expect("tempdir");
        let db_path = temp_dir.path().join("test.db");
        let db_path = db_path.to_string_lossy().to_string();
        run_migrations(&db_path).expect("migrate db");
        let pool = create_pool(&db_path).expect("create pool");
        let writer = spawn_writer((*pool).clone()).expect("spawn writer");

        {
            let mut conn = get_connection(&pool).expect("connection");
            sql_query(
                "INSERT INTO accounts (
                    id, name, account_type, `group`, currency, is_default, is_active,
                    created_at, updated_at, platform_id, account_number, meta, provider,
                    provider_account_id, is_archived, tracking_mode
                ) VALUES (
                    'account-1', 'Broker Account', 'brokerage', NULL, 'GBP', 0, 1,
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL, NULL, 'snaptrade',
                    'provider-account-1', 0, 'TRANSACTIONS'
                )",
            )
            .execute(&mut conn)
            .expect("insert account");
        }

        (
            BrokerSyncStateRepository::new(Arc::clone(&pool), writer),
            temp_dir,
        )
    }

    #[test]
    fn parse_sync_cursor_accepts_date_without_using_now() {
        let cursor = parse_sync_cursor("2026-05-22").expect("valid cursor");

        assert!(cursor.starts_with("2026-05-22T00:00:00"));
    }

    #[test]
    fn parse_sync_cursor_rejects_invalid_value() {
        let err = parse_sync_cursor("not-a-date").expect_err("invalid cursor");

        assert!(err.to_string().contains("Invalid broker sync cursor"));
    }

    #[tokio::test]
    async fn upsert_success_stores_passed_cursor_date() {
        let (repo, _temp_dir) = setup_repo();

        repo.upsert_success(
            "account-1".to_string(),
            "snaptrade".to_string(),
            "2026-05-22".to_string(),
            None,
        )
        .await
        .expect("upsert success");

        let state = repo
            .get("account-1", "snaptrade")
            .expect("state query")
            .expect("state exists");
        assert_eq!(
            state.last_successful_at.expect("cursor").date_naive(),
            chrono::NaiveDate::from_ymd_opt(2026, 5, 22).unwrap()
        );
    }
}
