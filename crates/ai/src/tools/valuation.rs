//! Valuation history tool - fetch portfolio valuation history using rig-core Tool trait.

use chrono::NaiveDate;
use rig::{completion::ToolDefinition, tool::Tool};
use rust_decimal::prelude::ToPrimitive;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use super::constants::{DEFAULT_VALUATIONS_DAYS, MAX_VALUATIONS_POINTS};
use crate::env::AiEnvironment;
use crate::error::AiError;
use wealthfolio_core::accounts::{account_supports_purpose, AccountPurpose};

// ============================================================================
// Tool Arguments and Output
// ============================================================================

/// Arguments for the get_valuation_history tool.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetValuationHistoryArgs {
    /// Account ID. Omit for all accounts aggregated.
    #[serde(default)]
    pub account_id: Option<String>,
    /// Start date for the valuation history (YYYY-MM-DD format).
    #[serde(default)]
    pub start_date: Option<String>,
    /// End date for the valuation history (YYYY-MM-DD format).
    #[serde(default)]
    pub end_date: Option<String>,
}

/// DTO for a single valuation point in tool output.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValuationPointDto {
    pub date: String,
    pub total_value: f64,
    pub net_contribution: f64,
    pub currency: String,
}

/// Output envelope for valuation history tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetValuationHistoryOutput {
    pub valuations: Vec<ValuationPointDto>,
    pub account_scope: String,
    pub currency: String,
    pub start_date: String,
    pub end_date: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_count: Option<usize>,
}

// ============================================================================
// Tool Implementation
// ============================================================================

/// Tool to get portfolio valuation history.
pub struct GetValuationHistoryTool<E: AiEnvironment> {
    env: Arc<E>,
    base_currency: String,
}

impl<E: AiEnvironment> GetValuationHistoryTool<E> {
    pub fn new(env: Arc<E>, base_currency: String) -> Self {
        Self { env, base_currency }
    }
}

impl<E: AiEnvironment> Clone for GetValuationHistoryTool<E> {
    fn clone(&self) -> Self {
        Self {
            env: self.env.clone(),
            base_currency: self.base_currency.clone(),
        }
    }
}

impl<E: AiEnvironment + 'static> Tool for GetValuationHistoryTool<E> {
    const NAME: &'static str = "get_valuation_history";

    type Error = AiError;
    type Args = GetValuationHistoryArgs;
    type Output = GetValuationHistoryOutput;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Get historical portfolio valuations over time. Returns daily valuation points with total value and net contributions. Omit accountId for aggregate valuations across all accounts. Useful for analyzing portfolio growth, performance trends, and comparing value vs contributions.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "accountId": {
                        "type": "string",
                        "description": "Account ID to get valuations for. Omit for all accounts aggregated."
                    },
                    "startDate": {
                        "type": "string",
                        "description": "Start date in YYYY-MM-DD format. Defaults to 365 days ago."
                    },
                    "endDate": {
                        "type": "string",
                        "description": "End date in YYYY-MM-DD format. Defaults to today."
                    }
                },
                "required": []
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let account_id = args.account_id.as_deref().filter(|id| !id.is_empty());

        // Parse dates with defaults
        let end_date = args
            .end_date
            .as_ref()
            .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
            .unwrap_or_else(|| chrono::Utc::now().date_naive());

        let start_date = args
            .start_date
            .as_ref()
            .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
            .unwrap_or_else(|| end_date - chrono::Duration::days(DEFAULT_VALUATIONS_DAYS));

        // Fetch valuations based on account scope
        let valuations: Vec<ValuationPointDto> = if let Some(account_id) = account_id {
            let account = self
                .env
                .account_service()
                .get_account(account_id)
                .map_err(|e| AiError::ToolExecutionFailed(e.to_string()))?;
            let account_valuations =
                if account_supports_purpose(&account.account_type, AccountPurpose::Holdings) {
                    self.env
                        .valuation_service()
                        .get_historical_valuations(account_id, Some(start_date), Some(end_date))
                        .map_err(|e| AiError::ToolExecutionFailed(e.to_string()))?
                } else {
                    Vec::new()
                };

            account_valuations
                .into_iter()
                .map(|v| ValuationPointDto {
                    date: v.valuation_date.format("%Y-%m-%d").to_string(),
                    total_value: v.total_value_base.to_f64().unwrap_or(0.0),
                    net_contribution: v.net_contribution_base.to_f64().unwrap_or(0.0),
                    currency: self.base_currency.clone(),
                })
                .collect()
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
                .valuation_service()
                .get_historical_valuations_for_accounts(
                    "all",
                    &account_ids,
                    &self.base_currency,
                    Some(start_date),
                    Some(end_date),
                )
                .map_err(|e| AiError::ToolExecutionFailed(e.to_string()))?
                .into_iter()
                .map(|v| ValuationPointDto {
                    date: v.valuation_date.format("%Y-%m-%d").to_string(),
                    total_value: v.total_value_base.to_f64().unwrap_or(0.0),
                    net_contribution: v.net_contribution_base.to_f64().unwrap_or(0.0),
                    currency: self.base_currency.clone(),
                })
                .collect()
        };

        let original_count = valuations.len();

        // Apply limit
        let valuations: Vec<ValuationPointDto> =
            valuations.into_iter().take(MAX_VALUATIONS_POINTS).collect();

        let returned_count = valuations.len();
        let truncated = original_count > returned_count;

        Ok(GetValuationHistoryOutput {
            valuations,
            account_scope: account_id.unwrap_or("all").to_string(),
            currency: self.base_currency.clone(),
            start_date: start_date.format("%Y-%m-%d").to_string(),
            end_date: end_date.format("%Y-%m-%d").to_string(),
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
    use crate::env::test_env::{MockAccountService, MockEnvironment, MockValuationService};
    use chrono::Utc;
    use rust_decimal::Decimal;
    use wealthfolio_core::{
        accounts::{Account, TrackingMode},
        valuation::DailyAccountValuation,
    };

    #[tokio::test]
    async fn test_get_valuation_history_tool() {
        let env = Arc::new(MockEnvironment::new());
        let tool = GetValuationHistoryTool::new(env, "USD".to_string());

        let result = tool
            .call(GetValuationHistoryArgs {
                account_id: None,
                start_date: None,
                end_date: None,
            })
            .await;
        assert!(result.is_ok());

        let output = result.unwrap();
        assert_eq!(output.account_scope, "all");
        assert_eq!(output.currency, "USD");
    }

    #[tokio::test]
    async fn test_get_valuation_history_with_account_id() {
        let mut env = MockEnvironment::new();
        env.account_service = Arc::new(MockAccountService {
            accounts: vec![test_account("acc-123", "SECURITIES")],
        });
        let env = Arc::new(env);
        let tool = GetValuationHistoryTool::new(env, "USD".to_string());

        let result = tool
            .call(GetValuationHistoryArgs {
                account_id: Some("acc-123".to_string()),
                start_date: Some("2024-01-01".to_string()),
                end_date: Some("2024-12-31".to_string()),
            })
            .await;
        assert!(result.is_ok());

        let output = result.unwrap();
        assert_eq!(output.account_scope, "acc-123");
        assert_eq!(output.start_date, "2024-01-01");
        assert_eq!(output.end_date, "2024-12-31");
    }

    #[tokio::test]
    async fn test_get_valuation_history_returns_empty_for_credit_card() {
        let mut env = MockEnvironment::new();
        env.account_service = Arc::new(MockAccountService {
            accounts: vec![test_account("card-1", "CREDIT_CARD")],
        });
        env.valuation_service = Arc::new(MockValuationService {
            valuations: vec![test_valuation("card-1")],
        });
        let env = Arc::new(env);
        let tool = GetValuationHistoryTool::new(env, "USD".to_string());

        let output = tool
            .call(GetValuationHistoryArgs {
                account_id: Some("card-1".to_string()),
                start_date: Some("2024-01-01".to_string()),
                end_date: Some("2024-12-31".to_string()),
            })
            .await
            .expect("credit card valuations should return empty output");

        assert_eq!(output.account_scope, "card-1");
        assert!(output.valuations.is_empty());
    }

    #[tokio::test]
    async fn test_get_valuation_history_with_dates() {
        let env = Arc::new(MockEnvironment::new());
        let tool = GetValuationHistoryTool::new(env, "EUR".to_string());

        let result = tool
            .call(GetValuationHistoryArgs {
                account_id: None,
                start_date: Some("2024-06-01".to_string()),
                end_date: Some("2024-06-30".to_string()),
            })
            .await;
        assert!(result.is_ok());

        let output = result.unwrap();
        assert_eq!(output.currency, "EUR");
        assert_eq!(output.start_date, "2024-06-01");
        assert_eq!(output.end_date, "2024-06-30");
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
            is_active: true,
            created_at: now,
            updated_at: now,
            platform_id: None,
            account_number: None,
            meta: None,
            provider: None,
            provider_account_id: None,
            is_archived: false,
            tracking_mode: TrackingMode::Transactions,
        }
    }

    fn test_valuation(account_id: &str) -> DailyAccountValuation {
        DailyAccountValuation {
            id: format!("val-{account_id}"),
            account_id: account_id.to_string(),
            valuation_date: chrono::NaiveDate::from_ymd_opt(2024, 1, 1).unwrap(),
            account_currency: "USD".to_string(),
            base_currency: "USD".to_string(),
            fx_rate_to_base: Decimal::ONE,
            cash_balance: Decimal::ZERO,
            investment_market_value: Decimal::ZERO,
            total_value: Decimal::new(100, 0),
            cost_basis: Decimal::ZERO,
            net_contribution: Decimal::ZERO,
            cash_balance_base: Decimal::ZERO,
            investment_market_value_base: Decimal::ZERO,
            total_value_base: Decimal::new(100, 0),
            cost_basis_base: Decimal::ZERO,
            net_contribution_base: Decimal::ZERO,
            external_inflow_base: Decimal::ZERO,
            external_outflow_base: Decimal::ZERO,
            performance_eligible_value_base: Decimal::ZERO,
            calculated_at: Utc::now(),
        }
    }
}
