use async_trait::async_trait;
use diesel::prelude::*;
use diesel::r2d2::{self, Pool};
use diesel::sqlite::SqliteConnection;
use std::collections::HashMap;
use std::sync::Arc;

use crate::db::{get_connection, WriteHandle};
use crate::errors::StorageError;
use crate::schema::accounts;
use crate::schema::accounts::dsl::*;

use super::model::AccountDB;
use wealthfolio_core::accounts::{
    Account, AccountAccountingSettings, AccountRepositoryTrait, AccountUpdate, NewAccount,
};
use wealthfolio_core::errors::Result;

/// Repository for managing account data in the database
pub struct AccountRepository {
    pool: Arc<Pool<r2d2::ConnectionManager<SqliteConnection>>>,
    writer: WriteHandle,
}

impl AccountRepository {
    /// Creates a new AccountRepository instance
    pub fn new(
        pool: Arc<Pool<r2d2::ConnectionManager<SqliteConnection>>>,
        writer: WriteHandle,
    ) -> Self {
        Self { pool, writer }
    }
}

// Implement the trait
#[async_trait]
impl AccountRepositoryTrait for AccountRepository {
    /// Creates a new account
    async fn create(&self, new_account: NewAccount) -> Result<Account> {
        new_account.validate()?;

        self.writer
            .exec_tx(move |tx| {
                let mut account_db: AccountDB = new_account.into();
                account_db.id = uuid::Uuid::new_v4().to_string();
                account_db.ensure_default_accounting_meta()?;

                diesel::insert_into(accounts::table)
                    .values(&account_db)
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;

                let payload_db = account_db.clone();
                let account: Account = account_db.into();
                tx.insert(&payload_db)?;

                Ok(account)
            })
            .await
    }

    async fn update(&self, account_update: AccountUpdate) -> Result<Account> {
        account_update.validate()?;

        // Capture which optional fields were explicitly set before conversion
        let is_archived_provided = account_update.is_archived.is_some();
        let tracking_mode_provided = account_update.tracking_mode.is_some();

        self.writer
            .exec_tx(move |tx| {
                let mut account_db: AccountDB = account_update.into();

                let existing = accounts
                    .select(AccountDB::as_select())
                    .find(&account_db.id)
                    .first::<AccountDB>(tx.conn())
                    .map_err(StorageError::from)?;

                // Preserve fields that shouldn't change
                account_db.currency = existing.currency;
                account_db.created_at = existing.created_at;
                account_db.updated_at = chrono::Utc::now().naive_utc();

                // Preserve broker-managed fields (only set by broker sync, not user form)
                account_db.provider_account_id = existing.provider_account_id;
                account_db.platform_id = existing.platform_id;
                account_db.provider = existing.provider;
                account_db.account_number = existing.account_number;
                if account_db.meta.is_none() {
                    account_db.meta = existing.meta;
                }

                // Preserve is_archived and tracking_mode if not explicitly provided
                if !is_archived_provided {
                    account_db.is_archived = existing.is_archived;
                }
                if !tracking_mode_provided {
                    account_db.tracking_mode = existing.tracking_mode;
                }

                diesel::update(accounts.find(&account_db.id))
                    .set(&account_db)
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;

                let payload_db = account_db.clone();
                let account: Account = account_db.into();
                tx.update(&payload_db)?;

                Ok(account)
            })
            .await
    }

    /// Retrieves an account by its ID
    fn get_by_id(&self, account_id: &str) -> Result<Account> {
        let mut conn = get_connection(&self.pool)?;

        let account = accounts
            .select(AccountDB::as_select())
            .find(account_id)
            .first::<AccountDB>(&mut conn)
            .map_err(StorageError::from)?;

        Ok(account.into())
    }

    /// Lists accounts in the database, optionally filtering by active status, archived status, and account IDs
    fn list(
        &self,
        is_active_filter: Option<bool>,
        is_archived_filter: Option<bool>,
        account_ids: Option<&[String]>,
    ) -> Result<Vec<Account>> {
        let mut conn = get_connection(&self.pool)?;

        let mut query = accounts::table.into_boxed();

        if let Some(active) = is_active_filter {
            query = query.filter(is_active.eq(active));
        }

        if let Some(archived) = is_archived_filter {
            query = query.filter(is_archived.eq(archived));
        }

        if let Some(ids) = account_ids {
            query = query.filter(id.eq_any(ids));
        }

        let results = query
            .select(AccountDB::as_select())
            .order((is_active.desc(), is_archived.asc(), name.asc()))
            .load::<AccountDB>(&mut conn)
            .map_err(StorageError::from)?;

        let accounts_list: Vec<Account> = results.into_iter().map(Account::from).collect();
        Ok(accounts_list)
    }

    fn get_accounting_settings_by_account_ids(
        &self,
        requested_account_ids: &[String],
    ) -> Result<HashMap<String, AccountAccountingSettings>> {
        if requested_account_ids.is_empty() {
            return Ok(HashMap::new());
        }

        let mut conn = get_connection(&self.pool)?;
        let rows: Vec<AccountDB> = accounts::table
            .filter(id.eq_any(requested_account_ids))
            .select(AccountDB::as_select())
            .load(&mut conn)
            .map_err(StorageError::from)?;

        let mut settings: HashMap<String, AccountAccountingSettings> = requested_account_ids
            .iter()
            .map(|account_id| {
                (
                    account_id.clone(),
                    AccountAccountingSettings::default_for_account(account_id.clone()),
                )
            })
            .collect();

        for account in rows {
            let setting = account.accounting_settings()?;
            settings.insert(setting.account_id.clone(), setting);
        }

        Ok(settings)
    }

    /// Deletes an account by its ID and returns the number of deleted records
    async fn delete(&self, account_id_param: &str) -> Result<usize> {
        let id_to_delete_owned = account_id_param.to_string();
        let event_subject_id = id_to_delete_owned.clone();
        self.writer
            .exec_tx(move |tx| {
                let affected_rows = diesel::delete(accounts.find(id_to_delete_owned))
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;

                if affected_rows > 0 {
                    tx.delete::<AccountDB>(event_subject_id.clone());
                }
                Ok(affected_rows)
            })
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{create_pool, run_migrations, write_actor::spawn_writer};
    use crate::schema::accounts::dsl as accounts_dsl;
    use tempfile::tempdir;
    use wealthfolio_core::accounts::{
        CostBasisMethod, CostBasisProfile, LotSelectionStrategy, PoolingScope, TrackingMode,
    };

    async fn setup() -> (
        AccountRepository,
        Arc<Pool<r2d2::ConnectionManager<SqliteConnection>>>,
        tempfile::TempDir,
    ) {
        std::env::set_var("CONNECT_API_URL", "http://test.local");
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db").to_string_lossy().to_string();
        run_migrations(&db_path).unwrap();
        let pool = create_pool(&db_path).unwrap();
        let writer = spawn_writer((*pool).clone()).unwrap();
        let repo = AccountRepository::new(Arc::clone(&pool), writer);
        (repo, pool, dir)
    }

    fn new_account(account_name: &str) -> NewAccount {
        NewAccount {
            id: None,
            name: account_name.to_string(),
            account_type: "REGULAR".to_string(),
            group: None,
            currency: "USD".to_string(),
            is_default: false,
            is_active: true,
            platform_id: None,
            account_number: None,
            meta: None,
            provider: None,
            provider_account_id: None,
            is_archived: false,
            tracking_mode: TrackingMode::Transactions,
        }
    }

    fn insert_account_without_settings(
        pool: &Arc<Pool<r2d2::ConnectionManager<SqliteConnection>>>,
        account_id: &str,
    ) {
        let mut conn = get_connection(pool).unwrap();
        diesel::sql_query(format!(
            "INSERT INTO accounts (id, name, account_type, currency, is_default, is_active, \
             created_at, updated_at, tracking_mode, is_archived) \
             VALUES ('{}', 'Manual', 'REGULAR', 'USD', 0, 1, datetime('now'), datetime('now'), \
             'TRANSACTIONS', 0)",
            account_id
        ))
        .execute(&mut conn)
        .unwrap();
    }

    #[tokio::test]
    async fn create_stores_default_accounting_settings_in_meta() {
        let (repo, pool, _dir) = setup().await;
        let account = repo.create(new_account("Seeded")).await.unwrap();

        let settings = repo
            .get_accounting_settings_by_account_ids(std::slice::from_ref(&account.id))
            .unwrap();
        let setting = settings.get(&account.id).unwrap();
        assert_eq!(setting.cost_basis_method, CostBasisMethod::Fifo);
        assert_eq!(setting.cost_basis_profile, CostBasisProfile::Generic);
        assert_eq!(setting.pooling_scope, PoolingScope::Account);
        assert!(setting.lot_selection_strategy.is_none());

        let mut conn = get_connection(&pool).unwrap();
        let stored_account = accounts_dsl::accounts
            .find(&account.id)
            .select(AccountDB::as_select())
            .first::<AccountDB>(&mut conn)
            .unwrap();
        let meta_json: serde_json::Value =
            serde_json::from_str(stored_account.meta.as_deref().unwrap()).unwrap();
        assert_eq!(
            meta_json["accounting"]["costBasisMethod"],
            serde_json::json!("FIFO")
        );
    }

    #[tokio::test]
    async fn missing_accounting_settings_resolve_to_defaults() {
        let (repo, pool, _dir) = setup().await;
        insert_account_without_settings(&pool, "acc-missing-settings");

        let settings = repo
            .get_accounting_settings_by_account_ids(&["acc-missing-settings".to_string()])
            .unwrap();
        let setting = settings.get("acc-missing-settings").unwrap();
        assert_eq!(setting.cost_basis_method, CostBasisMethod::Fifo);
        assert_eq!(setting.cost_basis_profile, CostBasisProfile::Generic);
        assert_eq!(setting.pooling_scope, PoolingScope::Account);
        assert_eq!(setting.settings_json, "{}");
    }

    #[tokio::test]
    async fn explicit_accounting_settings_round_trip() {
        let (repo, pool, _dir) = setup().await;
        insert_account_without_settings(&pool, "acc-explicit-settings");

        let mut conn = get_connection(&pool).unwrap();
        diesel::sql_query(
            "UPDATE accounts
             SET meta = '{\"accounting\":{\"costBasisMethod\":\"LIFO\",\"costBasisProfile\":\"CANADA_ACB\",\"poolingScope\":\"PORTFOLIO\",\"lotSelectionStrategy\":\"HIGHEST_COST\",\"settingsJson\":{\"source\":\"test\"},\"createdAt\":\"2026-01-01T00:00:00.000Z\",\"updatedAt\":\"2026-01-02T00:00:00.000Z\"}}'
             WHERE id = 'acc-explicit-settings'",
        )
        .execute(&mut conn)
        .unwrap();

        let settings = repo
            .get_accounting_settings_by_account_ids(&["acc-explicit-settings".to_string()])
            .unwrap();
        let setting = settings.get("acc-explicit-settings").unwrap();
        assert_eq!(setting.cost_basis_method, CostBasisMethod::Lifo);
        assert_eq!(setting.cost_basis_profile, CostBasisProfile::CanadaAcb);
        assert_eq!(setting.pooling_scope, PoolingScope::Portfolio);
        assert_eq!(
            setting.lot_selection_strategy,
            Some(LotSelectionStrategy::HighestCost)
        );
        assert_eq!(setting.settings_json, "{\"source\":\"test\"}");
    }
}
