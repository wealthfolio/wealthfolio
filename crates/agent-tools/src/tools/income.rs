//! Income tool - fetch income summaries (dividends, interest, other income).

use rust_decimal::prelude::ToPrimitive;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};

/// Arguments for the get_income tool.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetIncomeArgs {
    /// Period to show: "YTD", "LAST_YEAR", or "ALL" (default: "YTD").
    pub period: Option<String>,
}

/// DTO for top income-generating asset.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopAssetDto {
    pub symbol: String,
    pub name: String,
    pub income: f64,
}

/// Output envelope for income tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetIncomeOutput {
    /// Total income for the period in base currency.
    pub total_income: f64,
    /// Base currency code.
    pub currency: String,
    /// Average monthly income.
    pub monthly_average: f64,
    /// Year-over-year growth percentage (if available).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub yoy_growth: Option<f64>,
    /// Income breakdown by type (DIVIDEND, INTEREST, OTHER_INCOME).
    pub by_type: HashMap<String, f64>,
    /// Top income-generating assets (up to 10).
    pub top_assets: Vec<TopAssetDto>,
    /// Monthly income breakdown (YYYY-MM -> amount).
    pub by_month: HashMap<String, f64>,
    /// Period label (YTD, LAST_YEAR, ALL).
    pub period: String,
}

/// Tool to fetch income summaries (dividends, interest, other income).
pub struct GetIncome;

#[async_trait::async_trait]
impl AgentTool for GetIncome {
    fn name(&self) -> &'static str {
        "get_income"
    }

    fn description(&self) -> &'static str {
        "Fetch income summary including dividends, interest, and other income. Returns total income, monthly average, year-over-year growth, breakdown by type, and top income-generating assets."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "period": {
                    "type": "string",
                    "enum": ["YTD", "LAST_YEAR", "ALL"],
                    "description": "Time period for income summary: YTD (year to date), LAST_YEAR, or ALL (all time). Defaults to YTD."
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
        let args: GetIncomeArgs = serde_json::from_value(args)?;

        // Get income summaries from service
        let summaries = env
            .income_service()
            .get_income_summary(None)
            .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;

        // Determine which period to return
        let period = args.period.unwrap_or_else(|| "YTD".to_string());
        let period_upper = period.to_uppercase();

        // Find the requested period summary
        let summary = summaries
            .iter()
            .find(|s| s.period == period_upper)
            .ok_or_else(|| {
                AgentToolError::ExecutionFailed(format!(
                    "Period '{}' not found in income data",
                    period
                ))
            })?;

        // Convert by_type HashMap<String, Decimal> -> HashMap<String, f64>
        let by_type: HashMap<String, f64> = summary
            .by_type
            .iter()
            .map(|(k, v)| (k.clone(), v.to_f64().unwrap_or(0.0)))
            .collect();

        // Convert by_month HashMap<String, Decimal> -> HashMap<String, f64>
        let by_month: HashMap<String, f64> = summary
            .by_month
            .iter()
            .map(|(k, v)| (k.clone(), v.to_f64().unwrap_or(0.0)))
            .collect();

        // Get top 10 income-generating assets, sorted by income descending
        let mut assets: Vec<_> = summary
            .by_asset
            .values()
            .filter(|a| a.income.to_f64().unwrap_or(0.0) > 0.0)
            .collect();
        assets.sort_by(|a, b| {
            b.income
                .to_f64()
                .unwrap_or(0.0)
                .partial_cmp(&a.income.to_f64().unwrap_or(0.0))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let top_assets: Vec<TopAssetDto> = assets
            .into_iter()
            .take(10)
            .map(|a| TopAssetDto {
                symbol: a.symbol.clone(),
                name: a.name.clone(),
                income: a.income.to_f64().unwrap_or(0.0),
            })
            .collect();

        let output = GetIncomeOutput {
            total_income: summary.total_income.to_f64().unwrap_or(0.0),
            currency: summary.currency.clone(),
            monthly_average: summary.monthly_average.to_f64().unwrap_or(0.0),
            yoy_growth: summary.yoy_growth.and_then(|g| g.to_f64()),
            by_type,
            top_assets,
            by_month,
            period: summary.period.clone(),
        };
        Ok(AgentToolResult {
            content: serde_json::to_value(output)?,
        })
    }
}
