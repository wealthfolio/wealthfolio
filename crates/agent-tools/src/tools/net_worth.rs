//! Net worth tool - assets minus liabilities, on a date and over time.

use chrono::NaiveDate;
use rust_decimal::prelude::ToPrimitive;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::constants::MAX_NET_WORTH_POINTS;
use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};

/// Arguments for the get_net_worth tool.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetNetWorthArgs {
    /// As-of date for the balance sheet (YYYY-MM-DD). Defaults to today.
    #[serde(default)]
    pub date: Option<String>,
    /// Start date for history (YYYY-MM-DD). When set, history points are
    /// included from this date through `date` (or today).
    #[serde(default)]
    pub start_date: Option<String>,
}

/// A category/liability line in the balance-sheet breakdown.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetWorthLineDto {
    pub category: String,
    pub name: String,
    pub value: f64,
}

/// A single net-worth history point.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetWorthHistoryPointDto {
    pub date: String,
    pub net_worth: f64,
    pub total_assets: f64,
    pub total_liabilities: f64,
}

/// Output envelope for the net worth tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetNetWorthOutput {
    pub date: String,
    pub currency: String,
    pub total_assets: f64,
    pub total_liabilities: f64,
    pub net_worth: f64,
    pub assets: Vec<NetWorthLineDto>,
    pub liabilities: Vec<NetWorthLineDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history: Option<Vec<NetWorthHistoryPointDto>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history_truncated: Option<bool>,
}

/// Tool to get net worth (assets minus liabilities).
pub struct GetNetWorth;

#[async_trait::async_trait]
impl AgentTool for GetNetWorth {
    fn name(&self) -> &'static str {
        "get_net_worth"
    }

    fn description(&self) -> &'static str {
        "Get net worth (total assets minus total liabilities) as of a date, with a breakdown by asset category and by liability. Pass startDate to also include a net worth history series. Covers investment accounts plus alternative assets and liabilities."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "date": {
                    "type": "string",
                    "description": "As-of date in YYYY-MM-DD format. Defaults to today."
                },
                "startDate": {
                    "type": "string",
                    "description": "When set (YYYY-MM-DD), include a net worth history series from this date through the as-of date."
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
        let args: GetNetWorthArgs = serde_json::from_value(args)?;

        let as_of = args
            .date
            .as_ref()
            .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
            .unwrap_or_else(|| chrono::Utc::now().date_naive());

        let net_worth_service = env.net_worth_service();
        let response = net_worth_service
            .get_net_worth(as_of)
            .await
            .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;

        let assets: Vec<NetWorthLineDto> = response
            .assets
            .breakdown
            .iter()
            .map(|item| NetWorthLineDto {
                category: item.category.clone(),
                name: item.name.clone(),
                value: item.value.to_f64().unwrap_or(0.0),
            })
            .collect();
        let liabilities: Vec<NetWorthLineDto> = response
            .liabilities
            .breakdown
            .iter()
            .map(|item| NetWorthLineDto {
                category: item.category.clone(),
                name: item.name.clone(),
                value: item.value.to_f64().unwrap_or(0.0),
            })
            .collect();

        // Optional history series.
        let (history, history_truncated) = match args
            .start_date
            .as_ref()
            .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
        {
            Some(start) => {
                let points = net_worth_service
                    .get_net_worth_history(start, as_of)
                    .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;
                let original = points.len();
                let dto: Vec<NetWorthHistoryPointDto> = points
                    .into_iter()
                    .take(MAX_NET_WORTH_POINTS)
                    .map(|p| NetWorthHistoryPointDto {
                        date: p.date.format("%Y-%m-%d").to_string(),
                        net_worth: p.net_worth.to_f64().unwrap_or(0.0),
                        total_assets: p.total_assets.to_f64().unwrap_or(0.0),
                        total_liabilities: p.total_liabilities.to_f64().unwrap_or(0.0),
                    })
                    .collect();
                let truncated = original > dto.len();
                (Some(dto), if truncated { Some(true) } else { None })
            }
            None => (None, None),
        };

        let output = GetNetWorthOutput {
            date: response.date.format("%Y-%m-%d").to_string(),
            total_assets: response.assets.total.to_f64().unwrap_or(0.0),
            total_liabilities: response.liabilities.total.to_f64().unwrap_or(0.0),
            net_worth: response.net_worth.to_f64().unwrap_or(0.0),
            currency: response.currency,
            assets,
            liabilities,
            history,
            history_truncated,
        };
        Ok(AgentToolResult {
            content: serde_json::to_value(output)?,
        })
    }
}
