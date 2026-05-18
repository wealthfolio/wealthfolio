use async_trait::async_trait;

use super::portfolios_model::{
    AccountFilter, NewPortfolio, PortfolioUpdate, PortfolioWithAccounts,
};
use crate::errors::Result;

#[async_trait]
pub trait PortfolioRepositoryTrait: Send + Sync {
    async fn create(&self, new: NewPortfolio) -> Result<PortfolioWithAccounts>;
    async fn update(&self, update: PortfolioUpdate) -> Result<PortfolioWithAccounts>;
    async fn delete(&self, id: &str) -> Result<usize>;
    fn get_by_id(&self, id: &str) -> Result<PortfolioWithAccounts>;
    fn list(&self) -> Result<Vec<PortfolioWithAccounts>>;
    /// Resolve an AccountFilter to the concrete list of account IDs.
    fn resolve_account_ids(&self, filter: &AccountFilter) -> Result<Vec<String>>;
}

#[async_trait]
pub trait PortfolioServiceTrait: Send + Sync {
    async fn create_portfolio(&self, new: NewPortfolio) -> Result<PortfolioWithAccounts>;
    async fn update_portfolio(&self, update: PortfolioUpdate) -> Result<PortfolioWithAccounts>;
    async fn delete_portfolio(&self, id: &str) -> Result<()>;
    fn get_portfolio(&self, id: &str) -> Result<PortfolioWithAccounts>;
    fn list_portfolios(&self) -> Result<Vec<PortfolioWithAccounts>>;
    /// Resolve an AccountFilter to validated, ordered account IDs.
    fn resolve_account_filter(&self, filter: &AccountFilter) -> Result<Vec<String>>;
}
