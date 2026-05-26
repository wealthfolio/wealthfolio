use std::{collections::HashSet, sync::Arc};

use super::portfolios_model::{
    AccountScope, NewPortfolio, PortfolioUpdate, PortfolioWithAccounts, ResolvedAccountScope,
};
use super::portfolios_traits::{PortfolioRepositoryTrait, PortfolioServiceTrait};
use crate::accounts::AccountRepositoryTrait;
use crate::errors::{DatabaseError, Result, ValidationError};
use crate::Error;

fn map_unique_violation(e: Error) -> Error {
    if matches!(e, Error::Database(DatabaseError::UniqueViolation(_))) {
        Error::Validation(ValidationError::InvalidInput(
            "Portfolio name already exists".to_string(),
        ))
    } else {
        e
    }
}

pub struct PortfolioService {
    repository: Arc<dyn PortfolioRepositoryTrait>,
    account_repository: Arc<dyn AccountRepositoryTrait>,
}

impl PortfolioService {
    pub fn new(
        repository: Arc<dyn PortfolioRepositoryTrait>,
        account_repository: Arc<dyn AccountRepositoryTrait>,
    ) -> Self {
        Self {
            repository,
            account_repository,
        }
    }

    fn validate_account_ids_exist(&self, ids: &[String]) -> Result<()> {
        let existing = self.account_repository.list(None, None, Some(ids))?;
        let found: std::collections::HashSet<_> = existing.iter().map(|a| &a.id).collect();
        for id in ids {
            if !found.contains(id) {
                return Err(Error::Validation(ValidationError::InvalidInput(format!(
                    "Account '{}' does not exist",
                    id
                ))));
            }
        }
        Ok(())
    }

    fn validate_resolved_account_ids_exist(&self, ids: &[String]) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }

        let existing = self.account_repository.list(None, None, Some(ids))?;
        let found: HashSet<_> = existing.iter().map(|a| a.id.as_str()).collect();
        for id in ids {
            if !found.contains(id.as_str()) {
                return Err(Error::Validation(ValidationError::InvalidInput(format!(
                    "Account scope includes unknown account '{}'",
                    id
                ))));
            }
        }
        Ok(())
    }
}

#[async_trait::async_trait]
impl PortfolioServiceTrait for PortfolioService {
    async fn create_portfolio(&self, mut new: NewPortfolio) -> Result<PortfolioWithAccounts> {
        new.name = new.name.trim().to_string();
        new.validate()?;
        self.validate_account_ids_exist(&new.account_ids)?;
        self.repository
            .create(new)
            .await
            .map_err(map_unique_violation)
    }

    async fn update_portfolio(&self, mut update: PortfolioUpdate) -> Result<PortfolioWithAccounts> {
        update.name = update.name.trim().to_string();
        update.validate()?;
        self.validate_account_ids_exist(&update.account_ids)?;
        self.repository
            .update(update)
            .await
            .map_err(map_unique_violation)
    }

    async fn delete_portfolio(&self, id: &str) -> Result<()> {
        self.repository.delete(id).await?;
        Ok(())
    }

    fn get_portfolio(&self, id: &str) -> Result<PortfolioWithAccounts> {
        self.repository.get_by_id(id)
    }

    fn list_portfolios(&self) -> Result<Vec<PortfolioWithAccounts>> {
        self.repository.list()
    }

    fn resolve_account_filter(&self, filter: &AccountScope) -> Result<Vec<String>> {
        self.repository.resolve_account_ids(filter)
    }

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
        self.validate_resolved_account_ids_exist(&ids)?;

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
}
