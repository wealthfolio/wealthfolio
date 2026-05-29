//! Holdings tool - fetch portfolio holdings using rig-core Tool trait.

use rig::{completion::ToolDefinition, tool::Tool};
use rust_decimal::prelude::ToPrimitive;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use wealthfolio_core::accounts::{account_supports_purpose, AccountPurpose};

use super::constants::MAX_HOLDINGS;
use crate::env::AiEnvironment;
use crate::error::AiError;

// ============================================================================
// Tool Arguments and Output
// ============================================================================

/// Arguments for the get_holdings tool.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetHoldingsArgs {
    /// Account ID. Omit for all accounts.
    #[serde(default)]
    pub account_id: Option<String>,

    /// View mode: "table", "treemap", or "both". Default is "treemap".
    /// - "table": Show holdings as a detailed list with values and gains
    /// - "treemap": Show portfolio composition chart with daily performance colors
    /// - "both": Show treemap first, then table below
    #[serde(default = "default_view_mode")]
    pub view_mode: String,
}

fn default_view_mode() -> String {
    "treemap".to_string()
}

/// DTO for holding data in tool output.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldingDto {
    pub account: String,
    pub symbol: String,
    pub name: Option<String>,
    pub holding_type: String,
    pub quantity: f64,
    pub market_value_base: f64,
    pub cost_basis_base: Option<f64>,
    pub unrealized_gain_pct: Option<f64>,
    pub day_change_pct: Option<f64>,
    pub weight: f64,
    pub currency: String,
}

/// Output envelope for holdings tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetHoldingsOutput {
    pub holdings: Vec<HoldingDto>,
    pub total_value: f64,
    pub currency: String,
    pub account_scope: String,
    /// View mode requested: "table", "treemap", or "both"
    pub view_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_count: Option<usize>,
}

// ============================================================================
// Tool Implementation
// ============================================================================

/// Tool to get portfolio holdings.
pub struct GetHoldingsTool<E: AiEnvironment> {
    env: Arc<E>,
    base_currency: String,
}

impl<E: AiEnvironment> GetHoldingsTool<E> {
    pub fn new(env: Arc<E>, base_currency: String) -> Self {
        Self { env, base_currency }
    }
}

impl<E: AiEnvironment> Clone for GetHoldingsTool<E> {
    fn clone(&self) -> Self {
        Self {
            env: self.env.clone(),
            base_currency: self.base_currency.clone(),
        }
    }
}

impl<E: AiEnvironment + 'static> Tool for GetHoldingsTool<E> {
    const NAME: &'static str = "get_holdings";

    type Error = AiError;
    type Args = GetHoldingsArgs;
    type Output = GetHoldingsOutput;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Get portfolio holdings for an account or all accounts. Returns symbol, quantity, market value, cost basis, and gain/loss for each holding. Omit accountId for aggregate holdings across all accounts. Use viewMode to control display: 'treemap' for visual composition chart with daily performance, 'table' for detailed list, or 'both' to show both views.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "accountId": {
                        "type": "string",
                        "description": "Account ID to get holdings for. Omit for all accounts."
                    },
                    "viewMode": {
                        "type": "string",
                        "enum": ["table", "treemap", "both"],
                        "description": "Display mode: 'treemap' for composition chart with daily gains (best for 'how is my portfolio today?'), 'table' for detailed list, 'both' for treemap + table",
                        "default": "treemap"
                    }
                },
                "required": []
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        use std::collections::HashMap;

        let account_id = args.account_id.as_deref().filter(|id| !id.is_empty());

        let holdings = if let Some(account_id) = account_id {
            let account = self
                .env
                .account_service()
                .get_account(account_id)
                .map_err(|e| AiError::ToolExecutionFailed(e.to_string()))?;
            if !account_supports_purpose(&account.account_type, AccountPurpose::Holdings) {
                Vec::new()
            } else {
                self.env
                    .holdings_service()
                    .get_holdings(account_id, &self.base_currency)
                    .await
                    .map_err(|e| AiError::ToolExecutionFailed(e.to_string()))?
            }
        } else {
            let accounts = self
                .env
                .account_service()
                .get_active_non_archived_accounts()
                .map_err(|e| AiError::ToolExecutionFailed(e.to_string()))?;
            let account_ids: Vec<String> = accounts
                .into_iter()
                .filter(|account| {
                    account_supports_purpose(&account.account_type, AccountPurpose::Holdings)
                })
                .map(|account| account.id)
                .collect();
            self.env
                .holdings_service()
                .get_holdings_for_accounts(&account_ids, &self.base_currency, "all")
                .await
                .map_err(|e| AiError::ToolExecutionFailed(e.to_string()))?
        };

        // Build account_id → name lookup
        let accounts = self
            .env
            .account_service()
            .list_accounts(None, None, None)
            .map_err(|e| AiError::ToolExecutionFailed(e.to_string()))?;
        let account_names: HashMap<String, String> =
            accounts.into_iter().map(|a| (a.id, a.name)).collect();

        let original_count = holdings.len();

        // Convert to DTOs, filtering out cash positions, and apply limit
        let holdings_dto: Vec<HoldingDto> = holdings
            .into_iter()
            .filter(|h| h.holding_type != wealthfolio_core::holdings::HoldingType::Cash)
            .take(MAX_HOLDINGS)
            .map(|h| {
                // Extract symbol and name from instrument
                let (symbol, name) = h
                    .instrument
                    .as_ref()
                    .map(|i| (i.symbol.clone(), i.name.clone()))
                    .unwrap_or_else(|| ("CASH".to_string(), None));

                // Convert HoldingType enum to string
                let holding_type = match h.holding_type {
                    wealthfolio_core::holdings::HoldingType::Cash => "Cash",
                    wealthfolio_core::holdings::HoldingType::Security => "Security",
                    wealthfolio_core::holdings::HoldingType::AlternativeAsset => "AlternativeAsset",
                };

                let account = account_names
                    .get(&h.account_id)
                    .cloned()
                    .unwrap_or_else(|| h.account_id.clone());

                HoldingDto {
                    account,
                    symbol,
                    name,
                    holding_type: holding_type.to_string(),
                    quantity: h.quantity.to_f64().unwrap_or(0.0),
                    market_value_base: h.market_value.base.to_f64().unwrap_or(0.0),
                    cost_basis_base: h.cost_basis.as_ref().and_then(|c| c.base.to_f64()),
                    unrealized_gain_pct: h.unrealized_gain_pct.and_then(|d| d.to_f64()),
                    day_change_pct: h.day_change_pct.and_then(|d| d.to_f64()),
                    weight: h.weight.to_f64().unwrap_or(0.0),
                    currency: h.local_currency,
                }
            })
            .collect();

        let returned_count = holdings_dto.len();
        let total_value: f64 = holdings_dto.iter().map(|h| h.market_value_base).sum();
        let truncated = original_count > returned_count;

        Ok(GetHoldingsOutput {
            holdings: holdings_dto,
            total_value,
            currency: self.base_currency.clone(),
            account_scope: account_id.unwrap_or("all").to_string(),
            view_mode: args.view_mode.clone(),
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
    use crate::env::test_env::{MockAccountService, MockEnvironment};
    use chrono::Utc;
    use wealthfolio_core::accounts::{Account, TrackingMode};

    #[tokio::test]
    async fn test_get_holdings_tool() {
        let env = Arc::new(MockEnvironment::new());
        let tool = GetHoldingsTool::new(env, "USD".to_string());

        let result = tool
            .call(GetHoldingsArgs {
                account_id: None,
                view_mode: "treemap".to_string(),
            })
            .await;
        assert!(result.is_ok());

        let output = result.unwrap();
        assert_eq!(output.account_scope, "all");
        assert_eq!(output.currency, "USD");
        assert_eq!(output.view_mode, "treemap");
    }

    #[tokio::test]
    async fn test_get_holdings_with_account_id() {
        let mut env = MockEnvironment::new();
        env.account_service = Arc::new(MockAccountService {
            accounts: vec![test_account("acc-123", "SECURITIES")],
        });
        let env = Arc::new(env);
        let tool = GetHoldingsTool::new(env, "USD".to_string());

        let result = tool
            .call(GetHoldingsArgs {
                account_id: Some("acc-123".to_string()),
                view_mode: "table".to_string(),
            })
            .await;
        assert!(result.is_ok());

        let output = result.unwrap();
        assert_eq!(output.account_scope, "acc-123");
        assert_eq!(output.view_mode, "table");
    }

    fn test_account(id: &str, account_type: &str) -> Account {
        let now = Utc::now().naive_utc();
        Account {
            id: id.to_string(),
            name: id.to_string(),
            account_type: account_type.to_string(),
            group: None,
            currency: "USD".to_string(),
            is_default: false,
            created_at: now,
            updated_at: now,
            platform_id: None,
            account_number: None,
            meta: None,
            is_active: true,
            provider: None,
            provider_account_id: None,
            is_archived: false,
            tracking_mode: TrackingMode::Transactions,
        }
    }
}
