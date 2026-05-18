use diesel::prelude::*;
use serde::{Deserialize, Serialize};

use wealthfolio_core::portfolios::{Portfolio, PortfolioWithAccounts};

#[derive(
    Queryable,
    Identifiable,
    Insertable,
    AsChangeset,
    Selectable,
    Serialize,
    Deserialize,
    Debug,
    Clone,
)]
#[diesel(table_name = crate::schema::portfolios)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct PortfolioDB {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub sort_order: i32,
    pub created_at: String,
    pub updated_at: String,
}

impl From<PortfolioDB> for Portfolio {
    fn from(db: PortfolioDB) -> Self {
        Self {
            id: db.id,
            name: db.name,
            description: db.description,
            sort_order: db.sort_order,
            created_at: db.created_at,
            updated_at: db.updated_at,
        }
    }
}

#[derive(Queryable, Identifiable, Insertable, Selectable, Serialize, Deserialize, Debug, Clone)]
#[diesel(table_name = crate::schema::portfolio_accounts)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct PortfolioAccountDB {
    pub id: String,
    pub portfolio_id: String,
    pub account_id: String,
    pub sort_order: i32,
    pub created_at: String,
}

/// Build a `PortfolioWithAccounts` from a `PortfolioDB` and its membership rows.
pub fn build_portfolio_with_accounts(
    portfolio: PortfolioDB,
    memberships: Vec<PortfolioAccountDB>,
) -> PortfolioWithAccounts {
    let mut account_ids: Vec<String> = memberships.into_iter().map(|m| m.account_id).collect();
    account_ids.sort();

    PortfolioWithAccounts {
        id: portfolio.id,
        name: portfolio.name,
        description: portfolio.description,
        sort_order: portfolio.sort_order,
        account_ids,
        created_at: portfolio.created_at,
        updated_at: portfolio.updated_at,
    }
}
