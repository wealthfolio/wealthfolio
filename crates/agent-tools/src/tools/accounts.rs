//! Accounts tool - fetch accounts.

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use wealthfolio_core::accounts::{Account, TrackingMode};

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
    /// Also return hidden (inactive) accounts.
    #[serde(default)]
    pub include_hidden: bool,
    /// Also return archived accounts.
    #[serde(default)]
    pub include_archived: bool,
}

impl GetAccountsArgs {
    /// `list_accounts` filters: `None` drops a filter, so both kinds come back.
    fn filters(&self) -> (Option<bool>, Option<bool>) {
        (
            (!self.include_hidden).then_some(true),
            (!self.include_archived).then_some(false),
        )
    }
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
    pub is_archived: bool,
    /// TRANSACTIONS: holdings come from activities. HOLDINGS: holdings are
    /// entered directly, so activities do not drive them. NOT_SET: undecided.
    pub tracking_mode: TrackingMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    pub is_default: bool,
    /// Sync provider for broker-connected accounts; absent for manual ones.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
}

/// Output envelope for accounts tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetAccountsOutput {
    pub accounts: Vec<AccountDto>,
    pub count: usize,
}

impl GetAccountsOutput {
    /// Every account the filters returned: accounts are small, and a cut-off
    /// list hides the ids an agent needs to write to an account.
    fn from_accounts(accounts: Vec<Account>) -> Self {
        let accounts: Vec<AccountDto> = accounts
            .into_iter()
            .map(|a| AccountDto {
                id: a.id,
                name: a.name,
                account_type: a.account_type,
                currency: a.currency,
                is_active: a.is_active,
                is_archived: a.is_archived,
                tracking_mode: a.tracking_mode,
                group: a.group,
                is_default: a.is_default,
                provider: a.provider,
            })
            .collect();
        Self {
            count: accounts.len(),
            accounts,
        }
    }
}

/// Tool to get accounts.
pub struct GetAccounts;

#[async_trait::async_trait]
impl AgentTool for GetAccounts {
    fn name(&self) -> &'static str {
        "get_accounts"
    }

    fn description(&self) -> &'static str {
        "Get every active investment account. Pass includeHidden or includeArchived to add hidden or archived accounts. Returns account id, name, type, currency, active and archived flags, tracking mode, group, and sync provider for each account."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "displayMode": {
                    "type": "string",
                    "enum": ["full", "compact"],
                    "description": "Pass 'compact' when fetching accounts as input for another tool call (e.g., resolving account name before import_csv). Omit when the user directly asked to see their accounts."
                },
                "includeHidden": {
                    "type": "boolean",
                    "description": "Also return hidden accounts (isActive false). Default false."
                },
                "includeArchived": {
                    "type": "boolean",
                    "description": "Also return archived accounts. Default false."
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
        let args: GetAccountsArgs = serde_json::from_value(args)?;
        let (is_active, is_archived) = args.filters();

        let accounts = env
            .account_service()
            .list_accounts(is_active, is_archived, None)
            .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;

        let output = GetAccountsOutput::from_accounts(accounts);
        Ok(AgentToolResult {
            content: serde_json::to_value(output)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(value: serde_json::Value) -> GetAccountsArgs {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn filters_default_to_active_non_archived() {
        assert_eq!(
            args(serde_json::json!({})).filters(),
            (Some(true), Some(false))
        );
        assert_eq!(
            args(serde_json::json!({ "includeHidden": true })).filters(),
            (None, Some(false))
        );
        assert_eq!(
            args(serde_json::json!({ "includeArchived": true })).filters(),
            (Some(true), None)
        );
        assert_eq!(
            args(serde_json::json!({ "includeHidden": true, "includeArchived": true })).filters(),
            (None, None)
        );
    }

    /// #2371: the list stopped at 50 accounts with no way to get the rest.
    #[test]
    fn returns_every_account() {
        let accounts: Vec<Account> = (0..120)
            .map(|i| Account {
                id: format!("account-{i}"),
                name: format!("Account {i}"),
                is_active: i % 2 == 0,
                is_archived: i % 3 == 0,
                ..Default::default()
            })
            .collect();

        let output = GetAccountsOutput::from_accounts(accounts);

        assert_eq!(output.count, 120);
        assert_eq!(output.accounts.len(), 120);
        assert_eq!(output.accounts[119].id, "account-119");
        assert!(!output.accounts[1].is_active);
        assert!(output.accounts[3].is_archived);
        let json = serde_json::to_value(&output).unwrap();
        assert!(json.get("truncated").is_none());
    }
}
