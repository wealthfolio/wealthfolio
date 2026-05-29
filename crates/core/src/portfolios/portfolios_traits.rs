use async_trait::async_trait;

use super::portfolios_model::{
    AccountScope, NewPortfolio, PortfolioUpdate, PortfolioWithAccounts, ResolvedAccountScope,
};
use crate::errors::Result;

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
    fn resolve_account_scope(
        &self,
        filter: &AccountScope,
        base_currency: &str,
    ) -> Result<ResolvedAccountScope> {
        let mut ids = match filter {
            AccountScope::Account { account_id } => vec![account_id.clone()],
            AccountScope::All | AccountScope::Portfolio { .. } | AccountScope::Accounts { .. } => {
                self.resolve_account_filter(filter)?
            }
        };
        ids.sort();
        ids.dedup();

        let scope_id = match filter {
            AccountScope::All => "all".to_string(),
            AccountScope::Account { account_id } => format!("account:{}", account_id),
            AccountScope::Portfolio { portfolio_id } => format!("portfolio:{}", portfolio_id),
            AccountScope::Accounts { .. } => {
                use sha2::{Digest, Sha256};
                let joined = ids.join("\n");
                let digest = Sha256::digest(joined.as_bytes());
                format!("accounts:{}", hex::encode(&digest[..8]))
            }
        };

        Ok(ResolvedAccountScope {
            scope_id,
            account_ids: ids,
            base_currency: base_currency.to_string(),
        })
    }

    /// Resolve an AccountScope into its runtime reporting form using the app
    /// default base currency. Prefer `resolve_account_scope` where the current
    /// base currency is available.
    fn resolve_account_scope_default_base(
        &self,
        filter: &AccountScope,
    ) -> Result<ResolvedAccountScope> {
        self.resolve_account_scope(filter, "")
    }
}
