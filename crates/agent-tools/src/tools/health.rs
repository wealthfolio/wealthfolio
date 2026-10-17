//! Health status tool - expose portfolio health issues to agents.

use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};

/// A refresh within this many seconds of the last run returns that run, so a
/// read-scoped caller cannot recompute every check back to back.
const REFRESH_COOLDOWN_SECS: i64 = 60;

/// Arguments for the get_health_status tool (no required args).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetHealthStatusArgs {
    /// Run the checks now instead of reading the cached status.
    #[serde(default)]
    pub refresh: bool,
}

/// DTO for a single health issue.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthIssueDto {
    pub id: String,
    pub severity: String,
    pub category: String,
    pub title: String,
    pub message: String,
    pub affected_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub affected_mv_pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

/// Output envelope for get_health_status tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetHealthStatusOutput {
    /// One of the `Severity` values (INFO | WARNING | ERROR | CRITICAL) or the
    /// synthetic string `"NOT_COMPUTED"` when no cached status exists. Not a
    /// real `Severity` variant — do not deserialize back into the enum.
    pub overall_severity: String,
    pub issues: Vec<HealthIssueDto>,
    pub is_stale: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// Tool to get the current portfolio health status.
pub struct GetHealthStatus;

#[async_trait::async_trait]
impl AgentTool for GetHealthStatus {
    fn name(&self) -> &'static str {
        "get_health_status"
    }

    fn description(&self) -> &'static str {
        "Read the cached portfolio health status produced by the Health Center. \
                `overallSeverity` is one of INFO | WARNING | ERROR | CRITICAL, or NOT_COMPUTED when \
                no check has run yet in this session (in that case `issues` is empty). \
                Pass `refresh: true` to run the checks now, as the Health Center's run does, \
                when the status is NOT_COMPUTED or `isStale`, or after the user fixed data; it \
                reads only local data and also refreshes the Health Center's cached status. A \
                refresh within a minute of the last run returns that run. \
                Each issue has `severity` (same scale), `category` (PRICE_STALENESS | FX_INTEGRITY | \
                CLASSIFICATION | DATA_CONSISTENCY | ACCOUNT_CONFIGURATION | SETTINGS_CONFIGURATION), \
                `title`, `message`, `affectedCount`, optional `affectedMvPct` (share of portfolio \
                market value impacted, as a fraction 0.0-1.0), and optional `details`. \
                `isStale` is true when the cache is older than 5 minutes. \
                Use this to diagnose data problems (missing prices, stale FX rates, negative \
                balances, unclassified assets) and guide the user to fixes in the Health Center."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "refresh": {
                    "type": "boolean",
                    "description": "Run the health checks now and return the fresh status, instead of reading the cached one. Default false."
                }
            },
            "required": []
        })
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::HealthRead]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: GetHealthStatusArgs = serde_json::from_value(args)?;

        let cached = env.health_service().get_cached_status().await;
        let recent = cached.as_ref().is_some_and(|status| {
            chrono::Utc::now() - status.checked_at
                < chrono::Duration::seconds(REFRESH_COOLDOWN_SECS)
        });
        let status = if args.refresh && !recent {
            Some(
                env.run_health_checks()
                    .await
                    .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?,
            )
        } else {
            cached
        };
        let Some(status) = status else {
            let output = GetHealthStatusOutput {
                overall_severity: "NOT_COMPUTED".to_string(),
                issues: Vec::new(),
                is_stale: false,
                note: Some(
                    "No health check has run yet in this session. Call get_health_status \
                     with refresh: true to run one."
                        .to_string(),
                ),
            };
            return Ok(AgentToolResult {
                content: serde_json::to_value(output)?,
            });
        };

        let issues = status
            .issues
            .iter()
            .map(|issue| HealthIssueDto {
                id: issue.id.clone(),
                severity: issue.severity.as_str().to_string(),
                category: issue.category.as_str().to_string(),
                title: issue.title.clone(),
                message: issue.message.clone(),
                affected_count: issue.affected_count,
                affected_mv_pct: issue.affected_mv_pct,
                details: issue.details.clone(),
            })
            .collect::<Vec<_>>();

        let output = GetHealthStatusOutput {
            overall_severity: status.overall_severity.as_str().to_string(),
            issues,
            is_stale: status.is_stale,
            note: None,
        };
        Ok(AgentToolResult {
            content: serde_json::to_value(output)?,
        })
    }
}
