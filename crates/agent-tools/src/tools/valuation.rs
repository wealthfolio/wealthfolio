//! Valuation history tool - fetch portfolio valuation history.

use chrono::NaiveDate;
use rust_decimal::prelude::ToPrimitive;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use wealthfolio_core::accounts::{account_supports_purpose, AccountPurpose};

use crate::constants::{DEFAULT_VALUATIONS_DAYS, MAX_VALUATIONS_POINTS};
use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};

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

/// Tool to get portfolio valuation history.
pub struct GetValuationHistory;

#[async_trait::async_trait]
impl AgentTool for GetValuationHistory {
    fn name(&self) -> &'static str {
        "get_valuation_history"
    }

    fn description(&self) -> &'static str {
        "Get historical portfolio valuations over time. Returns daily valuation points with total value and net contributions. Omit accountId for aggregate valuations across all accounts. Useful for analyzing portfolio growth, performance trends, and comparing value vs contributions."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
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
        })
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::HoldingsRead]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: GetValuationHistoryArgs = serde_json::from_value(args)?;
        let base_currency = env.base_currency();
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
            let account = env
                .account_service()
                .get_account(account_id)
                .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;
            let account_valuations =
                if account_supports_purpose(&account.account_type, AccountPurpose::Holdings) {
                    env.valuation_service()
                        .get_historical_valuations(account_id, Some(start_date), Some(end_date))
                        .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?
                } else {
                    Vec::new()
                };

            account_valuations
                .into_iter()
                .map(|v| ValuationPointDto {
                    date: v.valuation_date.format("%Y-%m-%d").to_string(),
                    total_value: v.total_value_base.to_f64().unwrap_or(0.0),
                    net_contribution: v.net_contribution_base.to_f64().unwrap_or(0.0),
                    currency: base_currency.clone(),
                })
                .collect()
        } else {
            let accounts = env
                .account_service()
                .get_active_non_archived_accounts()
                .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;
            let account_ids: Vec<String> = accounts
                .into_iter()
                .filter(|account| {
                    account_supports_purpose(&account.account_type, AccountPurpose::Holdings)
                })
                .map(|account| account.id)
                .collect();
            env.valuation_service()
                .get_historical_valuations_for_accounts(
                    "all",
                    &account_ids,
                    &base_currency,
                    Some(start_date),
                    Some(end_date),
                )
                .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?
                .into_iter()
                .map(|v| ValuationPointDto {
                    date: v.valuation_date.format("%Y-%m-%d").to_string(),
                    total_value: v.total_value_base.to_f64().unwrap_or(0.0),
                    net_contribution: v.net_contribution_base.to_f64().unwrap_or(0.0),
                    currency: base_currency.clone(),
                })
                .collect()
        };

        let original_count = valuations.len();

        // Apply limit
        let valuations: Vec<ValuationPointDto> =
            valuations.into_iter().take(MAX_VALUATIONS_POINTS).collect();

        let returned_count = valuations.len();
        let truncated = original_count > returned_count;

        let output = GetValuationHistoryOutput {
            valuations,
            account_scope: account_id.unwrap_or("all").to_string(),
            currency: base_currency,
            start_date: start_date.format("%Y-%m-%d").to_string(),
            end_date: end_date.format("%Y-%m-%d").to_string(),
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
