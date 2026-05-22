use async_trait::async_trait;

use super::portfolios_model::{
    AccountScope, NewPortfolio, PortfolioUpdate, PortfolioWithAccounts, ResolvedAccountScope,
};
use crate::errors::{Error, Result, ValidationError};

#[async_trait]
pub trait PortfolioRepositoryTrait: Send + Sync {
    async fn create(&self, new: NewPortfolio) -> Result<PortfolioWithAccounts>;
    async fn update(&self, update: PortfolioUpdate) -> Result<PortfolioWithAccounts>;
    async fn delete(&self, id: &str) -> Result<usize>;
    fn get_by_id(&self, id: &str) -> Result<PortfolioWithAccounts>;
    fn list(&self) -> Result<Vec<PortfolioWithAccounts>>;
    /// Resolve an AccountScope to the concrete list of account IDs.
    fn resolve_account_ids(&self, filter: &AccountScope) -> Result<Vec<String>>;
}

#[async_trait]
pub trait PortfolioServiceTrait: Send + Sync {
    async fn create_portfolio(&self, new: NewPortfolio) -> Result<PortfolioWithAccounts>;
    async fn update_portfolio(&self, update: PortfolioUpdate) -> Result<PortfolioWithAccounts>;
    async fn delete_portfolio(&self, id: &str) -> Result<()>;
    fn get_portfolio(&self, id: &str) -> Result<PortfolioWithAccounts>;
    fn list_portfolios(&self) -> Result<Vec<PortfolioWithAccounts>>;
    /// Resolve an AccountScope to validated, ordered account IDs.
    fn resolve_account_filter(&self, filter: &AccountScope) -> Result<Vec<String>>;

    /// Resolve an AccountScope into its runtime reporting form.
    fn resolve_account_scope(&self, filter: &AccountScope) -> Result<ResolvedAccountScope> {
        match filter {
            AccountScope::All => Ok(ResolvedAccountScope::TotalSnapshot),
            AccountScope::Account { account_id } => {
                Ok(ResolvedAccountScope::Account(account_id.clone()))
            }
            AccountScope::Portfolio { .. } | AccountScope::Accounts { .. } => {
                let ids = self.resolve_account_filter(filter)?;
                if ids.is_empty() {
                    return Err(Error::Validation(ValidationError::InvalidInput(
                        "Account scope resolved to no accounts".to_string(),
                    )));
                }
                Ok(ResolvedAccountScope::Accounts(ids))
            }
        }
    }
}
