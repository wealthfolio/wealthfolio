use async_trait::async_trait;
use diesel::prelude::*;
use diesel::r2d2::{self, Pool};
use diesel::sqlite::SqliteConnection;
use std::collections::HashMap;
use std::sync::Arc;
use uuid::Uuid;

use crate::db::{get_connection, WriteHandle};
use crate::errors::StorageError;
use crate::schema::{portfolio_accounts, portfolios};
use wealthfolio_core::errors::Error;

use super::model::{build_portfolio_with_accounts, PortfolioAccountDB, PortfolioDB};
use wealthfolio_core::errors::Result;
use wealthfolio_core::portfolios::{
    AccountScope, NewPortfolio, PortfolioRepositoryTrait, PortfolioUpdate, PortfolioWithAccounts,
};

pub struct PortfolioRepository {
    pool: Arc<Pool<r2d2::ConnectionManager<SqliteConnection>>>,
    writer: WriteHandle,
}

impl PortfolioRepository {
    pub fn new(
        pool: Arc<Pool<r2d2::ConnectionManager<SqliteConnection>>>,
        writer: WriteHandle,
    ) -> Self {
        Self { pool, writer }
    }

    fn load_memberships_for_portfolios(
        conn: &mut SqliteConnection,
        portfolio_ids: &[String],
    ) -> Result<Vec<PortfolioAccountDB>> {
        use crate::schema::portfolio_accounts::dsl::*;
        portfolio_accounts
            .filter(portfolio_id.eq_any(portfolio_ids))
            .order((portfolio_id.asc(), sort_order.asc(), account_id.asc()))
            .select(PortfolioAccountDB::as_select())
            .load::<PortfolioAccountDB>(conn)
            .map_err(|e| Error::from(StorageError::from(e)))
    }
}

#[async_trait]
impl PortfolioRepositoryTrait for PortfolioRepository {
    async fn create(&self, new: NewPortfolio) -> Result<PortfolioWithAccounts> {
        self.writer
            .exec_tx(move |tx| {
                let portfolio_id = Uuid::new_v4().to_string();
                let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();

                let portfolio_db = PortfolioDB {
                    id: portfolio_id.clone(),
                    name: new.name.clone(),
                    description: new.description.clone(),
                    sort_order: new.sort_order,
                    created_at: now.clone(),
                    updated_at: now.clone(),
                };

                diesel::insert_into(portfolios::table)
                    .values(&portfolio_db)
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;

                tx.insert(&portfolio_db)?;

                let mut memberships = Vec::new();
                for (i, account_id) in new.account_ids.iter().enumerate() {
                    let membership = PortfolioAccountDB {
                        id: format!("pfm_{}_{}", portfolio_id, account_id),
                        portfolio_id: portfolio_id.clone(),
                        account_id: account_id.clone(),
                        sort_order: i as i32,
                        created_at: now.clone(),
                    };
                    diesel::insert_into(portfolio_accounts::table)
                        .values(&membership)
                        .execute(tx.conn())
                        .map_err(StorageError::from)?;
                    tx.insert(&membership)?;
                    memberships.push(membership);
                }

                Ok(build_portfolio_with_accounts(portfolio_db, memberships))
            })
            .await
    }

    async fn update(&self, update: PortfolioUpdate) -> Result<PortfolioWithAccounts> {
        self.writer
            .exec_tx(move |tx| {
                let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();

                // Load existing to preserve created_at
                let existing = portfolios::table
                    .find(&update.id)
                    .select(PortfolioDB::as_select())
                    .first::<PortfolioDB>(tx.conn())
                    .map_err(StorageError::from)?;

                let portfolio_db = PortfolioDB {
                    id: update.id.clone(),
                    name: update.name.clone(),
                    description: update.description.clone(),
                    sort_order: update.sort_order,
                    created_at: existing.created_at,
                    updated_at: now.clone(),
                };

                diesel::update(portfolios::table.find(&update.id))
                    .set(&portfolio_db)
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;

                tx.update(&portfolio_db)?;

                // Remove old memberships and replace
                let old_memberships = portfolio_accounts::table
                    .filter(portfolio_accounts::portfolio_id.eq(&update.id))
                    .select(PortfolioAccountDB::as_select())
                    .load::<PortfolioAccountDB>(tx.conn())
                    .map_err(StorageError::from)?;

                for old in &old_memberships {
                    diesel::delete(
                        portfolio_accounts::table.filter(portfolio_accounts::id.eq(&old.id)),
                    )
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;
                    tx.delete::<PortfolioAccountDB>(old.id.clone());
                }

                let mut memberships = Vec::new();
                for (i, account_id) in update.account_ids.iter().enumerate() {
                    let membership = PortfolioAccountDB {
                        id: format!("pfm_{}_{}", update.id, account_id),
                        portfolio_id: update.id.clone(),
                        account_id: account_id.clone(),
                        sort_order: i as i32,
                        created_at: now.clone(),
                    };
                    diesel::insert_into(portfolio_accounts::table)
                        .values(&membership)
                        .execute(tx.conn())
                        .map_err(StorageError::from)?;
                    tx.insert(&membership)?;
                    memberships.push(membership);
                }

                Ok(build_portfolio_with_accounts(portfolio_db, memberships))
            })
            .await
    }

    async fn delete(&self, id: &str) -> Result<usize> {
        let id_owned = id.to_string();
        self.writer
            .exec_tx(move |tx| {
                let affected = diesel::delete(portfolios::table.find(&id_owned))
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;

                if affected > 0 {
                    tx.delete::<PortfolioDB>(id_owned.clone());
                }

                Ok(affected)
            })
            .await
    }

    fn get_by_id(&self, id: &str) -> Result<PortfolioWithAccounts> {
        let mut conn = get_connection(&self.pool)?;

        let portfolio = portfolios::table
            .find(id)
            .select(PortfolioDB::as_select())
            .first::<PortfolioDB>(&mut conn)
            .map_err(StorageError::from)?;

        let memberships =
            Self::load_memberships_for_portfolios(&mut conn, std::slice::from_ref(&portfolio.id))?;

        Ok(build_portfolio_with_accounts(portfolio, memberships))
    }

    fn list(&self) -> Result<Vec<PortfolioWithAccounts>> {
        let mut conn = get_connection(&self.pool)?;

        let all_portfolios = portfolios::table
            .select(PortfolioDB::as_select())
            .order((portfolios::sort_order.asc(), portfolios::name.asc()))
            .load::<PortfolioDB>(&mut conn)
            .map_err(StorageError::from)?;

        if all_portfolios.is_empty() {
            return Ok(vec![]);
        }

        let ids: Vec<String> = all_portfolios.iter().map(|p| p.id.clone()).collect();
        let all_memberships = Self::load_memberships_for_portfolios(&mut conn, &ids)?;

        let mut by_portfolio: HashMap<String, Vec<PortfolioAccountDB>> = HashMap::new();
        for m in all_memberships {
            by_portfolio
                .entry(m.portfolio_id.clone())
                .or_default()
                .push(m);
        }

        let result = all_portfolios
            .into_iter()
            .map(|p| {
                let mems = by_portfolio.remove(&p.id).unwrap_or_default();
                build_portfolio_with_accounts(p, mems)
            })
            .collect();

        Ok(result)
    }

    fn resolve_account_ids(&self, filter: &AccountScope) -> Result<Vec<String>> {
        let mut conn = get_connection(&self.pool)?;

        match filter {
            AccountScope::All => {
                use crate::schema::accounts::dsl::*;
                let ids = accounts
                    .filter(is_archived.eq(false))
                    .order(name.asc())
                    .select(id)
                    .load::<String>(&mut conn)
                    .map_err(StorageError::from)?;
                Ok(ids)
            }
            AccountScope::Account { account_id } => Ok(vec![account_id.clone()]),
            AccountScope::Portfolio { portfolio_id: pfid } => {
                use crate::schema::portfolio_accounts::dsl::*;
                let ids = portfolio_accounts
                    .filter(portfolio_id.eq(pfid))
                    .order((sort_order.asc(), account_id.asc()))
                    .select(account_id)
                    .load::<String>(&mut conn)
                    .map_err(StorageError::from)?;
                Ok(ids)
            }
            AccountScope::Accounts { account_ids } => Ok(account_ids.clone()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{create_pool, get_connection, run_migrations, write_actor::spawn_writer};
    use diesel::sql_query;
    use diesel::sql_types::{Bool, Text};
    use tempfile::tempdir;

    fn setup() -> (PortfolioRepository, tempfile::TempDir) {
        std::env::set_var("CONNECT_API_URL", "http://test.local");
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db").to_string_lossy().to_string();
        run_migrations(&db_path).unwrap();
        let pool = create_pool(&db_path).unwrap();
        let writer = spawn_writer((*pool).clone()).unwrap();
        let repo = PortfolioRepository::new(pool, writer);
        (repo, dir)
    }

    fn insert_account(
        repo: &PortfolioRepository,
        account_id: &str,
        name: &str,
        active: bool,
        archived: bool,
    ) {
        let mut conn = get_connection(&repo.pool).unwrap();
        sql_query(
            "INSERT INTO accounts (
                id, name, account_type, currency, is_default, is_active, created_at, updated_at,
                is_archived, tracking_mode
             ) VALUES (?, ?, 'SECURITIES', 'USD', 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, 'TRANSACTIONS')",
        )
        .bind::<Text, _>(account_id)
        .bind::<Text, _>(name)
        .bind::<Bool, _>(active)
        .bind::<Bool, _>(archived)
        .execute(&mut conn)
        .unwrap();
    }

    #[tokio::test]
    async fn resolve_all_keeps_hidden_and_excludes_archived_accounts() {
        let (repo, _dir) = setup();
        insert_account(&repo, "active", "Active", true, false);
        insert_account(&repo, "hidden", "Hidden", false, false);
        insert_account(&repo, "archived", "Archived", true, true);

        let ids = repo.resolve_account_ids(&AccountScope::All).unwrap();

        assert_eq!(ids, vec!["active", "hidden"]);
    }
}
