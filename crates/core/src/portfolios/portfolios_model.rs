use serde::{Deserialize, Serialize};

use crate::{errors::ValidationError, Error, Result};

/// A saved portfolio — a named reporting scope over a set of accounts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Portfolio {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub sort_order: i32,
    pub created_at: String,
    pub updated_at: String,
}

/// Portfolio with its resolved member account IDs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioWithAccounts {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub sort_order: i32,
    pub account_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Input for creating a new portfolio.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPortfolio {
    pub name: String,
    pub description: Option<String>,
    #[serde(default)]
    pub sort_order: i32,
    pub account_ids: Vec<String>,
}

impl NewPortfolio {
    pub fn validate(&self) -> Result<()> {
        if self.name.trim().is_empty() {
            return Err(Error::Validation(ValidationError::InvalidInput(
                "Portfolio name cannot be empty".to_string(),
            )));
        }
        if self.account_ids.is_empty() {
            return Err(Error::Validation(ValidationError::InvalidInput(
                "Portfolio must contain at least one account".to_string(),
            )));
        }
        let mut seen = std::collections::HashSet::new();
        for id in &self.account_ids {
            if !seen.insert(id) {
                return Err(Error::Validation(ValidationError::InvalidInput(format!(
                    "Duplicate account ID: {}",
                    id
                ))));
            }
        }
        Ok(())
    }
}

/// Input for updating an existing portfolio.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioUpdate {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    #[serde(default)]
    pub sort_order: i32,
    pub account_ids: Vec<String>,
}

impl PortfolioUpdate {
    pub fn validate(&self) -> Result<()> {
        if self.id.trim().is_empty() {
            return Err(Error::Validation(ValidationError::InvalidInput(
                "Portfolio ID is required for updates".to_string(),
            )));
        }
        if self.name.trim().is_empty() {
            return Err(Error::Validation(ValidationError::InvalidInput(
                "Portfolio name cannot be empty".to_string(),
            )));
        }
        if self.account_ids.is_empty() {
            return Err(Error::Validation(ValidationError::InvalidInput(
                "Portfolio must contain at least one account".to_string(),
            )));
        }
        let mut seen = std::collections::HashSet::new();
        for id in &self.account_ids {
            if !seen.insert(id) {
                return Err(Error::Validation(ValidationError::InvalidInput(format!(
                    "Duplicate account ID: {}",
                    id
                ))));
            }
        }
        Ok(())
    }
}

/// Typed account scope filter — resolved once at the service boundary.
///
/// Repositories receive `&[String]` account IDs and must not parse
/// encoded strings like `MULTI:id,id` or `PORTFOLIO`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AccountFilter {
    /// All active, non-archived accounts.
    All,
    /// A single specific account.
    Account { account_id: String },
    /// A saved portfolio — resolved to its member account IDs.
    Portfolio { portfolio_id: String },
}
