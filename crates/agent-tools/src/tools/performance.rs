//! Performance tool - fetch portfolio performance metrics using PerformanceService.

use chrono::{Datelike, Local, NaiveDate};
use rust_decimal::prelude::ToPrimitive;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use wealthfolio_core::accounts::{account_supports_portfolio_scope, AccountPurpose};
use wealthfolio_core::portfolio::performance::PerformanceResult as CorePerformanceResult;

use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};

/// Arguments for the get_performance tool.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetPerformanceArgs {
    /// Account ID. Omit for all accounts.
    #[serde(default)]
    pub account_id: Option<String>,

    /// Period for performance calculation: "1M", "3M", "6M", "YTD", "1Y", "ALL".
    #[serde(default = "default_period")]
    pub period: String,
}

fn default_period() -> String {
    "YTD".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GetPerformanceOutput {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub period_start_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub period_end_date: Option<String>,
    pub currency: String,
    pub mode: String,
    pub basis_status: String,
    pub summary: PerformanceSummaryOutput,
    pub returns: PerformanceReturnsOutput,
    pub attribution: PerformanceAttributionOutput,
    pub risk: PerformanceRiskOutput,
    pub data_quality: PerformanceDataQualityOutput,
    pub is_mixed_tracking_mode: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceSummaryOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    pub method: String,
    pub basis: String,
    pub quality: String,
    pub amount_status: String,
    pub percent_status: String,
    pub basis_status: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceReturnsOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub twr: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annualized_twr: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub irr: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annualized_irr: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_return: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annualized_value_return: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceAttributionOutput {
    pub contributions: f64,
    pub distributions: f64,
    pub income: f64,
    pub realized_pnl: f64,
    pub unrealized_pnl_change: f64,
    pub fx_effect: f64,
    pub fees: f64,
    pub taxes: f64,
    pub residual: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceRiskOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volatility: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_drawdown: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peak_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trough_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drawdown_duration_days: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceDataQualityOutput {
    pub status: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub not_applicable_reasons: Vec<String>,
}

impl PerformanceSummaryOutput {
    fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            method: "notApplicable".to_string(),
            basis: "notApplicable".to_string(),
            quality: "noData".to_string(),
            amount_status: "unavailable".to_string(),
            percent_status: "unavailable".to_string(),
            basis_status: "notApplicable".to_string(),
            reasons: vec![reason.into()],
            ..Default::default()
        }
    }

    fn from_metrics(metrics: &CorePerformanceResult) -> Self {
        Self {
            amount: metrics.summary.amount.and_then(|v| v.to_f64()),
            percent: metrics.summary.percent.and_then(|v| v.to_f64()),
            method: serialized_value(&metrics.summary.method, "notApplicable"),
            basis: serialized_value(&metrics.summary.basis, "notApplicable"),
            quality: serialized_value(&metrics.summary.quality, "partial"),
            amount_status: serialized_value(&metrics.summary.amount_status, "unavailable"),
            percent_status: serialized_value(&metrics.summary.percent_status, "unavailable"),
            basis_status: serialized_value(&metrics.summary.basis_status, "notApplicable"),
            reasons: metrics.summary.reasons.clone(),
        }
    }
}

fn serialized_value<T: Serialize>(value: &T, fallback: &str) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(ToString::to_string))
        .unwrap_or_else(|| fallback.to_string())
}

/// Convert a period string to a start date.
fn period_to_start_date(period: &str, end_date: NaiveDate) -> Option<NaiveDate> {
    match period.to_uppercase().as_str() {
        "1M" => Some(end_date - chrono::Duration::days(30)),
        "3M" => Some(end_date - chrono::Duration::days(90)),
        "6M" => Some(end_date - chrono::Duration::days(180)),
        "YTD" => NaiveDate::from_ymd_opt(end_date.year(), 1, 1),
        "1Y" => Some(end_date - chrono::Duration::days(365)),
        _ => None, // None means no start date filter
    }
}

/// Tool to get portfolio performance.
pub struct GetPerformance;

#[async_trait::async_trait]
impl AgentTool for GetPerformance {
    fn name(&self) -> &'static str {
        "get_performance"
    }

    fn description(&self) -> &'static str {
        "Get portfolio performance metrics including TWR, IRR, value return, attribution, volatility, and max drawdown. Omit accountId for aggregate performance across all accounts."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "accountId": {
                    "type": "string",
                    "description": "Account ID to get performance for. Omit for all accounts."
                },
                "period": {
                    "type": "string",
                    "description": "Time period for performance calculation",
                    "enum": ["1M", "3M", "6M", "YTD", "1Y", "ALL"],
                    "default": "YTD"
                }
            },
            "required": []
        })
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::PerformanceRead]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: GetPerformanceArgs = serde_json::from_value(args)?;
        let base_currency = env.base_currency();
        let account_id = args.account_id.as_deref().filter(|id| !id.is_empty());
        let period = args.period.to_uppercase();

        // Calculate date range
        let end_date = Local::now().date_naive();
        let start_date = period_to_start_date(&period, end_date);

        let metrics = if let Some(account_id) = account_id {
            let account = env
                .account_service()
                .get_account(account_id)
                .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;
            if !account_supports_portfolio_scope(&account, AccountPurpose::Performance) {
                let reason = "Performance unavailable for this account type.".to_string();
                let output = GetPerformanceOutput {
                    id: account_id.to_string(),
                    period_start_date: start_date.map(|d| d.to_string()),
                    period_end_date: Some(end_date.to_string()),
                    currency: account.currency,
                    mode: "notApplicable".to_string(),
                    basis_status: "notApplicable".to_string(),
                    summary: PerformanceSummaryOutput::unavailable(reason.clone()),
                    data_quality: PerformanceDataQualityOutput {
                        status: "noData".to_string(),
                        warnings: Vec::new(),
                        not_applicable_reasons: vec![reason],
                    },
                    ..Default::default()
                };
                return Ok(AgentToolResult {
                    content: serde_json::to_value(output)?,
                });
            }
            env.performance_service()
                .calculate_performance_history(
                    "account",
                    account_id,
                    start_date,
                    Some(end_date),
                    Some(account.tracking_mode),
                    Some(&account.account_type),
                )
                .await
                .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?
        } else {
            let accounts = env
                .account_service()
                .get_non_archived_accounts()
                .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;
            let mut account_tracking_modes = std::collections::HashMap::new();
            let mut account_types = std::collections::HashMap::new();
            let account_ids: Vec<String> = accounts
                .into_iter()
                .filter(|account| {
                    account_supports_portfolio_scope(account, AccountPurpose::Performance)
                })
                .map(|account| {
                    account_tracking_modes.insert(account.id.clone(), account.tracking_mode);
                    account_types.insert(account.id.clone(), account.account_type.clone());
                    account.id
                })
                .collect();
            env.performance_service()
                .calculate_performance_history_for_accounts(
                    "all",
                    &account_ids,
                    &base_currency,
                    &account_tracking_modes,
                    &account_types,
                    start_date,
                    Some(end_date),
                )
                .await
                .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?
        };

        let mode = serialized_value(&metrics.mode, "notApplicable");
        let basis_status = serialized_value(&metrics.basis_status, "notApplicable");
        let summary = PerformanceSummaryOutput::from_metrics(&metrics);
        let data_quality_status = serialized_value(&metrics.data_quality.status, "partial");

        let output = GetPerformanceOutput {
            id: metrics.scope.id,
            period_start_date: metrics.period.start_date.map(|d| d.to_string()),
            period_end_date: metrics.period.end_date.map(|d| d.to_string()),
            currency: if metrics.scope.currency.is_empty() {
                base_currency.clone()
            } else {
                metrics.scope.currency
            },
            mode,
            basis_status,
            summary,
            returns: PerformanceReturnsOutput {
                twr: metrics.returns.twr.and_then(|v| v.to_f64()),
                annualized_twr: metrics.returns.annualized_twr.and_then(|v| v.to_f64()),
                irr: metrics.returns.irr.and_then(|v| v.to_f64()),
                annualized_irr: metrics.returns.annualized_irr.and_then(|v| v.to_f64()),
                value_return: metrics.returns.value_return.and_then(|v| v.to_f64()),
                annualized_value_return: metrics
                    .returns
                    .annualized_value_return
                    .and_then(|v| v.to_f64()),
            },
            attribution: PerformanceAttributionOutput {
                contributions: metrics.attribution.contributions.to_f64().unwrap_or(0.0),
                distributions: metrics.attribution.distributions.to_f64().unwrap_or(0.0),
                income: metrics.attribution.income.to_f64().unwrap_or(0.0),
                realized_pnl: metrics.attribution.realized_pnl.to_f64().unwrap_or(0.0),
                unrealized_pnl_change: metrics
                    .attribution
                    .unrealized_pnl_change
                    .to_f64()
                    .unwrap_or(0.0),
                fx_effect: metrics.attribution.fx_effect.to_f64().unwrap_or(0.0),
                fees: metrics.attribution.fees.to_f64().unwrap_or(0.0),
                taxes: metrics.attribution.taxes.to_f64().unwrap_or(0.0),
                residual: metrics.attribution.residual.to_f64().unwrap_or(0.0),
            },
            risk: PerformanceRiskOutput {
                volatility: metrics.risk.volatility.and_then(|v| v.to_f64()),
                max_drawdown: metrics.risk.max_drawdown.and_then(|v| v.to_f64()),
                peak_date: metrics.risk.peak_date.map(|d| d.to_string()),
                trough_date: metrics.risk.trough_date.map(|d| d.to_string()),
                recovery_date: metrics.risk.recovery_date.map(|d| d.to_string()),
                drawdown_duration_days: metrics.risk.drawdown_duration_days,
            },
            data_quality: PerformanceDataQualityOutput {
                status: data_quality_status,
                warnings: metrics.data_quality.warnings,
                not_applicable_reasons: metrics.data_quality.not_applicable_reasons,
            },
            is_mixed_tracking_mode: metrics.is_mixed_tracking_mode,
        };
        Ok(AgentToolResult {
            content: serde_json::to_value(output)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_period_conversion() {
        let today = NaiveDate::from_ymd_opt(2024, 6, 15).unwrap();

        // Test YTD
        let ytd_start = period_to_start_date("YTD", today);
        assert_eq!(ytd_start, NaiveDate::from_ymd_opt(2024, 1, 1));

        // Test 1M (30 days back)
        let one_month_start = period_to_start_date("1M", today);
        assert_eq!(one_month_start, NaiveDate::from_ymd_opt(2024, 5, 16));

        // Test 1Y (365 days back)
        let one_year_start = period_to_start_date("1Y", today);
        assert_eq!(one_year_start, NaiveDate::from_ymd_opt(2023, 6, 16));

        // Test ALL - returns None (no start date filter)
        let all_start = period_to_start_date("ALL", today);
        assert_eq!(all_start, None);
    }
}
