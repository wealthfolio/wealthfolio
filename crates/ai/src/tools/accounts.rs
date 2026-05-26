//! Accounts tool - fetch active accounts using rig-core Tool trait.

use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use super::constants::MAX_ACCOUNTS;
use crate::env::AiEnvironment;
use crate::error::AiError;

// ============================================================================
// Tool Arguments and Output
// ============================================================================

/// Arguments for the get_accounts tool.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetAccountsArgs {
    /// Display hint for the UI. Pass "compact" when fetching accounts as a
    /// prerequisite for another action (e.g., resolving account name before
    /// import). Omit or pass "full" when the user asked to see accounts.
    #[serde(default)]
    pub display_mode: Option<String>,
}

/// DTO for account data in tool output.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountDto {
    pub id: String,
    pub name: String,
    pub account_type: String,
    pub currency: String,
    pub is_active: bool,
}

/// Output envelope for accounts tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetAccountsOutput {
    pub accounts: Vec<AccountDto>,
    pub count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_count: Option<usize>,
}

// ============================================================================
// Tool Implementation
// ============================================================================

/// Tool to get active accounts.
pub struct GetAccountsTool<E: AiEnvironment> {
    env: Arc<E>,
}

impl<E: AiEnvironment> GetAccountsTool<E> {
    pub fn new(env: Arc<E>) -> Self {
        Self { env }
    }
}

impl<E: AiEnvironment> Clone for GetAccountsTool<E> {
    fn clone(&self) -> Self {
        Self {
            env: self.env.clone(),
        }
    }
}

impl<E: AiEnvironment + 'static> Tool for GetAccountsTool<E> {
    const NAME: &'static str = "get_accounts";

    type Error = AiError;
    type Args = GetAccountsArgs;
    type Output = GetAccountsOutput;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Get the list of active investment accounts. Returns account id, name, type, and currency for each account.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "displayMode": {
                        "type": "string",
                        "enum": ["full", "compact"],
                        "description": "Pass 'compact' when fetching accounts as input for another tool call (e.g., resolving account name before import_csv). Omit when the user directly asked to see their accounts."
                    }
                },
                "required": []
            }),
        }
    }

    async fn call(&self, _args: Self::Args) -> Result<Self::Output, Self::Error> {
        let accounts = self
            .env
            .account_service()
            .get_active_non_archived_accounts()
            .map_err(|e| AiError::ToolExecutionFailed(e.to_string()))?;

        let original_count = accounts.len();
        let accounts_dto: Vec<AccountDto> = accounts
            .into_iter()
            .take(MAX_ACCOUNTS)
            .map(|a| AccountDto {
                id: a.id,
                name: a.name,
                account_type: a.account_type,
                currency: a.currency,
                is_active: a.is_active,
            })
            .collect();

        let returned_count = accounts_dto.len();
        let truncated = original_count > returned_count;

        Ok(GetAccountsOutput {
            accounts: accounts_dto,
            count: returned_count,
            truncated: if truncated { Some(true) } else { None },
            original_count: if truncated {
                Some(original_count)
            } else {
                None
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::test_env::MockEnvironment;

    #[tokio::test]
    async fn test_get_accounts_tool() {
        let env = Arc::new(MockEnvironment::new());
        let tool = GetAccountsTool::new(env);

        let result = tool.call(GetAccountsArgs::default()).await;
        assert!(result.is_ok());

        let output = result.unwrap();
        assert_eq!(output.count, output.accounts.len());
    }
}
