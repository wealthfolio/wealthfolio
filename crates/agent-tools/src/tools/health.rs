//! Health status tool - expose portfolio health issues to agents.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use wealthfolio_core::health::model::ActionRef;
use wealthfolio_core::health::{
    DiagnosticAction, FixAction, HealthDateRange, HealthDiagnostic, HealthIssue,
};
use wealthfolio_core::portfolio::projection::ActivityIssue;

use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};

/// A refresh within this many seconds of the last run returns that run, so a
/// read-scoped caller cannot recompute every check back to back.
const REFRESH_COOLDOWN_SECS: i64 = 60;

/// Held while a refresh checks the cooldown and runs, so a concurrent refresh
/// waits and then returns that run instead of starting its own.
// ponytail: one lock for the process, not per profile; refreshes are rare.
static REFRESH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Arguments for the get_health_status tool (no required args).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetHealthStatusArgs {
    /// Run the checks now instead of reading the cached status.
    #[serde(default)]
    pub refresh: bool,
}

/// Most diagnostics returned per issue; `totalDiagnostics` counts them all.
const MAX_DIAGNOSTICS_PER_ISSUE: usize = 20;

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
    /// Per-activity machine-readable reasons, alongside the readable details.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub activity_issues: Vec<ActivityIssue>,
    /// Stable machine code for the issue.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// Values the issue's wording is built from (counts, symbols, currencies).
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub params: HashMap<String, Value>,
    /// Changes when the data behind the issue changes.
    pub data_hash: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub affected_items: Vec<HealthAffectedItemDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix_action: Option<HealthActionDto>,
    /// Root causes, at most `MAX_DIAGNOSTICS_PER_ISSUE` of them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<HealthDiagnosticDto>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub diagnostics_truncated: bool,
    /// All diagnostics of the issue; set only when `diagnostics` was truncated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_diagnostics: Option<usize>,
}

/// A record an issue affects: its id and how the app names it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthAffectedItemDto {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
}

/// A fix or navigation action, reduced to its id, label and target ids.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthActionDto {
    /// `fix` or `navigate`.
    pub kind: String,
    /// Fix action id (e.g. `sync_prices`); navigation actions have none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub label: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub primary: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub asset_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub account_ids: Vec<String>,
}

impl From<&FixAction> for HealthActionDto {
    fn from(action: &FixAction) -> Self {
        // Fix actions that target records carry a list of their ids.
        let ids: Vec<String> = serde_json::from_value(action.payload.clone()).unwrap_or_default();
        let (asset_ids, account_ids) = match action.id.as_str() {
            "sync_prices" | "retry_sync" => (ids, Vec::new()),
            "rebuild_account_history" => (Vec::new(), ids),
            _ => (Vec::new(), Vec::new()),
        };
        Self {
            kind: "fix".to_string(),
            id: Some(action.id.clone()),
            label: action.label.clone(),
            primary: false,
            asset_ids,
            account_ids,
        }
    }
}

impl From<&DiagnosticAction> for HealthActionDto {
    fn from(action: &DiagnosticAction) -> Self {
        let dto = match &action.action {
            ActionRef::Fix { action } => Self::from(action),
            ActionRef::Navigate { action } => Self {
                kind: "navigate".to_string(),
                id: None,
                label: action.label.clone(),
                primary: false,
                asset_ids: Vec::new(),
                account_ids: Vec::new(),
            },
        };
        Self {
            primary: action.primary,
            ..dto
        }
    }
}

/// A record a diagnostic is about.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthEntityDto {
    pub kind: String,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// One root cause of an issue, with the records and dates it concerns.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthDiagnosticDto {
    pub code: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub entities: Vec<HealthEntityDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date_range: Option<HealthDateRange>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub actions: Vec<HealthActionDto>,
}

impl From<&HealthDiagnostic> for HealthDiagnosticDto {
    fn from(diagnostic: &HealthDiagnostic) -> Self {
        Self {
            code: diagnostic.code.clone(),
            entities: diagnostic
                .entities
                .iter()
                .map(|entity| HealthEntityDto {
                    kind: entity.kind.clone(),
                    id: entity.id.clone(),
                    label: entity.label.clone(),
                })
                .collect(),
            date: diagnostic.date.clone(),
            date_range: diagnostic.date_range.clone(),
            actions: diagnostic
                .actions
                .iter()
                .map(HealthActionDto::from)
                .collect(),
        }
    }
}

impl From<&HealthIssue> for HealthIssueDto {
    fn from(issue: &HealthIssue) -> Self {
        let diagnostics = issue.diagnostics.as_deref().unwrap_or_default();
        let diagnostics_truncated = diagnostics.len() > MAX_DIAGNOSTICS_PER_ISSUE;
        Self {
            id: issue.id.clone(),
            severity: issue.severity.as_str().to_string(),
            category: issue.category.as_str().to_string(),
            title: issue.title.clone(),
            message: issue.message.clone(),
            affected_count: issue.affected_count,
            affected_mv_pct: issue.affected_mv_pct,
            details: issue.details.clone(),
            activity_issues: diagnostics
                .iter()
                .flat_map(|diagnostic| diagnostic.evidence.iter())
                .filter_map(|evidence| evidence.activity_issue.clone())
                .collect(),
            code: issue.code.clone(),
            params: issue.params.clone(),
            data_hash: issue.data_hash.clone(),
            affected_items: issue
                .affected_items
                .iter()
                .flatten()
                .map(|item| HealthAffectedItemDto {
                    id: item.id.clone(),
                    label: item.name.clone(),
                    symbol: item.symbol.clone(),
                })
                .collect(),
            fix_action: issue.fix_action.as_ref().map(HealthActionDto::from),
            diagnostics: diagnostics
                .iter()
                .take(MAX_DIAGNOSTICS_PER_ISSUE)
                .map(HealthDiagnosticDto::from)
                .collect(),
            diagnostics_truncated,
            total_diagnostics: diagnostics_truncated.then_some(diagnostics.len()),
        }
    }
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
                market value impacted, as a fraction 0.0-1.0), optional `details`, and optional \
                `activityIssues` (activityId, kind, fallback message and optional reason with code/params). \
                Issues also carry ids, so you need not parse prose: optional `code` and `params`; \
                `dataHash` (changes when the data behind the issue changes); `affectedItems` (id, \
                label, optional symbol); `fixAction` (kind `fix`, `id`, label, and the `assetIds` or \
                `accountIds` it targets; it is the first diagnostic's primary fix, so read each \
                diagnostic's actions for the full set); and `diagnostics`, one per root cause, each with `code` \
                (e.g. MISSING_MARKET_QUOTE, MISSING_MANUAL_VALUATION, MISSING_FX_RATE), `entities` \
                (kind such as asset, account, activity or currencyPair, id, label), optional `date` \
                and `dateRange` (start, end, inclusive), and `actions` (`fix` actions with id and \
                target ids, `navigate` actions with a label; `primary` marks the recommended one). At \
                most 20 diagnostics are returned per issue; `diagnosticsTruncated` and \
                `totalDiagnostics` say when more exist. \
                Fix action ids are sync_prices, retry_sync, rebuild_account_history and \
                migrate_legacy_classifications. To act on them with tools: sync_prices and retry_sync \
                map to `refresh_market_data` for the listed assetIds; for a missing market quote or \
                manual value, read the asset's stored prices with `get_quote_history` over the \
                diagnostic's `date`/`dateRange`, then refresh with `refresh_market_data` or import \
                the missing prices with `commit_quote_import`; when prices are off because the \
                asset's quote currency is wrong (for example GBp vs GBP), read the asset with \
                `get_asset` and change it with `prepare_asset_update` / `commit_asset_update`. Use \
                these tools only when they are available to you; otherwise point the user to the \
                Health Center. \
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

        let _refresh = if args.refresh {
            Some(REFRESH_LOCK.lock().await)
        } else {
            None
        };
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
            .map(HealthIssueDto::from)
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

#[cfg(test)]
mod tests {
    use super::*;
    use wealthfolio_core::health::{
        AffectedItem, Evidence, HealthCategory, HealthEntityRef, HealthIssue, NavigateAction,
    };

    #[test]
    fn health_tool_exposes_activity_ids_and_structured_reasons() {
        let activity: ActivityIssue = serde_json::from_value(serde_json::json!({
            "activityId": "buy-1", "kind": "REJECTED", "message": "no USD/GBp rate",
            "reason": { "code": "MISSING_FX_RATE", "params": { "from": "USD", "to": "GBp", "date": "2025-01-06" } }
        })).expect("activity fixture");
        let mut issue = HealthIssue::builder()
            .id("rejected_activity:hash")
            .category(HealthCategory::DataConsistency)
            .title("Rejected")
            .message("Review these transactions")
            .details("readable fallback")
            .data_hash("hash")
            .build();
        let mut evidence = Evidence::new("Item", "Brokerage");
        evidence.activity_issue = Some(activity);
        issue.diagnostics.as_mut().expect("fallback diagnostic")[0]
            .evidence
            .push(evidence);
        let result =
            serde_json::to_value(HealthIssueDto::from(&issue)).expect("serialized tool output");
        assert_eq!(result["details"], "readable fallback");
        assert_eq!(result["activityIssues"][0]["activityId"], "buy-1");
        assert_eq!(
            result["activityIssues"][0]["reason"]["code"],
            "MISSING_FX_RATE"
        );
        assert_eq!(result["activityIssues"][0]["reason"]["params"]["to"], "GBp");
    }

    #[test]
    fn health_tool_exposes_ids_fix_actions_and_capped_diagnostics() {
        let diagnostics = (0..MAX_DIAGNOSTICS_PER_ISSUE + 5)
            .map(|i| {
                HealthDiagnostic::new("MISSING_MARKET_QUOTE", "No price found", "explanation")
                    .entity(
                        HealthEntityRef::new("asset", format!("asset-{i}"))
                            .label("XYZ")
                            .route("/holdings/x"),
                    )
                    .date("2025-01-06")
                    .date_range("2025-01-06", "2025-01-09")
                    .evidence(Evidence::new("Value", "1234.56"))
                    .fix(true, FixAction::sync_prices(vec![format!("asset-{i}")]))
                    .navigate(false, NavigateAction::to_market_data())
            })
            .collect();
        let issue = HealthIssue::builder()
            .id("incomplete_valuation_value:hash")
            .category(HealthCategory::DataConsistency)
            .code("data_incomplete_valuation_value")
            .param("count", 25)
            .title("Prices are missing")
            .message("Sync prices")
            .affected_items(vec![AffectedItem::asset_with_name(
                "asset-0",
                "XYZ",
                Some("XYZ Corp".to_string()),
            )])
            .diagnostics(diagnostics)
            .data_hash("hash")
            .build();

        let result =
            serde_json::to_value(HealthIssueDto::from(&issue)).expect("serialized tool output");

        assert_eq!(result["code"], "data_incomplete_valuation_value");
        assert_eq!(result["params"]["count"], 25);
        assert_eq!(result["dataHash"], issue.data_hash);
        assert_eq!(
            result["affectedItems"],
            serde_json::json!([{ "id": "asset-0", "label": "XYZ Corp", "symbol": "XYZ" }])
        );
        // Core takes the issue's fix from its first diagnostic's primary fix.
        assert_eq!(
            result["fixAction"],
            serde_json::json!({
                "kind": "fix", "id": "sync_prices", "label": "Sync Prices",
                "assetIds": ["asset-0"]
            })
        );
        let shown = result["diagnostics"].as_array().expect("diagnostics");
        assert_eq!(shown.len(), MAX_DIAGNOSTICS_PER_ISSUE);
        assert_eq!(result["diagnosticsTruncated"], true);
        assert_eq!(result["totalDiagnostics"], MAX_DIAGNOSTICS_PER_ISSUE + 5);
        // Ids, labels and dates only: no routes, evidence values or payloads.
        assert_eq!(
            shown[0],
            serde_json::json!({
                "code": "MISSING_MARKET_QUOTE",
                "entities": [{ "kind": "asset", "id": "asset-0", "label": "XYZ" }],
                "date": "2025-01-06",
                "dateRange": { "start": "2025-01-06", "end": "2025-01-09" },
                "actions": [
                    { "kind": "fix", "id": "sync_prices", "label": "Sync Prices",
                      "primary": true, "assetIds": ["asset-0"] },
                    { "kind": "navigate", "label": "Review Market Data" }
                ]
            })
        );
    }

    #[test]
    fn fix_actions_name_the_records_they_target() {
        let retry = serde_json::to_value(HealthActionDto::from(&FixAction::retry_sync(vec![
            "a1".to_string(),
            "a2".to_string(),
        ])))
        .expect("serialized action");
        assert_eq!(retry["id"], "retry_sync");
        assert_eq!(retry["assetIds"], serde_json::json!(["a1", "a2"]));
        assert!(retry.get("accountIds").is_none());

        let rebuild = serde_json::to_value(HealthActionDto::from(
            &FixAction::rebuild_account_history(vec!["acc-1".to_string()]),
        ))
        .expect("serialized action");
        assert_eq!(rebuild["accountIds"], serde_json::json!(["acc-1"]));
        assert!(rebuild.get("assetIds").is_none());

        let migrate = serde_json::to_value(HealthActionDto::from(
            &FixAction::migrate_legacy_classifications(),
        ))
        .expect("serialized action");
        assert_eq!(migrate["id"], "migrate_legacy_classifications");
        assert!(migrate.get("assetIds").is_none() && migrate.get("accountIds").is_none());
    }

    #[test]
    fn health_tool_omits_empty_new_fields() {
        let issue = HealthIssue::builder()
            .id("quiet:hash")
            .category(HealthCategory::SettingsConfiguration)
            .title("Quiet")
            .message("Nothing to fix")
            .data_hash("hash")
            .build();
        let result =
            serde_json::to_value(HealthIssueDto::from(&issue)).expect("serialized tool output");
        for key in [
            "code",
            "params",
            "affectedItems",
            "fixAction",
            "diagnosticsTruncated",
            "totalDiagnostics",
        ] {
            assert!(result.get(key).is_none(), "{key} should be omitted");
        }
    }
}
