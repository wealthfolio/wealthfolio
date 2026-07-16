//! Accounts tool - fetch active accounts.

use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::constants::MAX_ACCOUNTS;
use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};

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

/// Tool to get active accounts.
pub struct GetAccounts;

#[async_trait::async_trait]
impl AgentTool for GetAccounts {
    fn name(&self) -> &'static str {
        "get_accounts"
    }

    fn description(&self) -> &'static str {
        "Get the list of active investment accounts. Returns account id, name, type, and currency for each account."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "displayMode": {
                    "type": "string",
                    "enum": ["full", "compact"],
                    "description": "Pass 'compact' when fetching accounts as input for another tool call (e.g., resolving account name before import_csv). Omit when the user directly asked to see their accounts."
                }
            },
            "required": []
        })
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::AccountsRead]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let _args: GetAccountsArgs = serde_json::from_value(args)?;

        let accounts = env
            .account_service()
            .get_active_non_archived_accounts()
            .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;

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

        let output = GetAccountsOutput {
            accounts: accounts_dto,
            count: returned_count,
            truncated: if truncated { Some(true) } else { None },
            original_count: if truncated {
                Some(original_count)
            } else {
                None
            },
        };
        Ok(AgentToolResult {
            content: serde_json::to_value(output)?,
        })
    }
}
