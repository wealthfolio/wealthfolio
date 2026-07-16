//! CSV-import tools (MCP-only).
//!
//! These expose Wealthfolio's real import pipeline so an MCP agent can run
//! the same flow as the in-app import wizard: fetch the account's saved
//! mapping, map the CSV into rows itself, preview them
//! (`check_activities_import` — validation + duplicate detection), then
//! import (`import_activities` — dedup-safe, grouped as one import run).
//!
//! The agent owns CSV parsing/column-mapping (its strength); the tools own
//! validation, duplicate detection, and the grouped/idempotent write. Set
//! `forceImport: true` on a row to import it despite a detected duplicate
//! (mirrors the wizard's "Import anyway").

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use wealthfolio_core::activities::ActivityImport;

use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};

/// Hard cap on rows per call to keep payloads and audit rows bounded.
const MAX_IMPORT_ROWS: usize = 1000;

/// A CSV row the agent has already mapped to activity fields. Maps to the
/// core [`ActivityImport`]; omit fields that don't apply (e.g. `symbol` for
/// pure cash activities).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityImportRow {
    /// Activity date (the importer accepts ISO and common formats).
    pub date: String,
    pub activity_type: String,
    pub currency: String,
    #[serde(default)]
    pub symbol: Option<String>,
    #[serde(default)]
    pub symbol_name: Option<String>,
    #[serde(default)]
    pub quantity: Option<f64>,
    #[serde(default)]
    pub unit_price: Option<f64>,
    #[serde(default)]
    pub amount: Option<f64>,
    #[serde(default)]
    pub fee: Option<f64>,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub comment: Option<String>,
    /// 1-based source line, surfaced in previews and duplicate messages.
    #[serde(default)]
    pub line_number: Option<i32>,
    /// Import despite a detected duplicate (the wizard's "Import anyway").
    #[serde(default)]
    pub force_import: bool,
}

/// Arguments shared by prepare/commit.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityImportArgs {
    pub activities: Vec<ActivityImportRow>,
}

/// A model-friendly view of a checked/imported row, including the asset
/// resolution that `check_activities_import` fills in (so the agent can show
/// how each symbol resolved before committing).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRowResult {
    pub line_number: Option<i32>,
    pub date: String,
    pub symbol: String,
    pub activity_type: String,
    pub is_valid: bool,
    pub is_duplicate: bool,
    // ── Resolved asset identity (populated during validation) ──────────────
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exchange_mic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quote_ccy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instrument_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quote_mode: Option<String>,
    // ── Duplicate / validation ─────────────────────────────────────────────
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duplicate_of_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duplicate_of_line_number: Option<i32>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreviewSummary {
    pub total: usize,
    pub valid: usize,
    pub invalid: usize,
    pub duplicates: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareActivityImportOutput {
    pub summary: ImportPreviewSummary,
    pub rows: Vec<ImportRowResult>,
}

/// Flatten a `{field: [msg, ...]}` map into `["field: msg", ...]`.
fn flatten_messages(map: &Option<std::collections::HashMap<String, Vec<String>>>) -> Vec<String> {
    map.as_ref()
        .map(|m| {
            m.iter()
                .flat_map(|(field, msgs)| {
                    msgs.iter().map(move |msg| {
                        if field.starts_with('_') {
                            msg.clone()
                        } else {
                            format!("{field}: {msg}")
                        }
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn is_duplicate(row: &ActivityImport) -> bool {
    row.duplicate_of_id.is_some() || row.duplicate_of_line_number.is_some()
}

fn to_result(row: &ActivityImport) -> ImportRowResult {
    ImportRowResult {
        line_number: row.line_number,
        date: row.date.clone(),
        symbol: row.symbol.clone(),
        activity_type: row.activity_type.clone(),
        is_valid: row.is_valid,
        is_duplicate: is_duplicate(row),
        symbol_name: row.symbol_name.clone(),
        exchange_mic: row.exchange_mic.clone(),
        quote_ccy: row.quote_ccy.clone(),
        instrument_type: row.instrument_type.clone(),
        quote_mode: row.quote_mode.clone(),
        duplicate_of_id: row.duplicate_of_id.clone(),
        duplicate_of_line_number: row.duplicate_of_line_number,
        errors: flatten_messages(&row.errors),
        warnings: flatten_messages(&row.warnings),
    }
}

/// Convert the lean input rows into core `ActivityImport`s via serde (only
/// present fields are set, so optional columns fall back to defaults).
fn to_import_rows(rows: &[ActivityImportRow]) -> Result<Vec<ActivityImport>, AgentToolError> {
    if rows.is_empty() {
        return Err(AgentToolError::InvalidInput(
            "No activities to import".to_string(),
        ));
    }
    if rows.len() > MAX_IMPORT_ROWS {
        return Err(AgentToolError::InvalidInput(format!(
            "Too many rows ({}); import at most {MAX_IMPORT_ROWS} per call",
            rows.len()
        )));
    }
    rows.iter()
        .enumerate()
        .map(|(index, row)| {
            let mut obj = Map::new();
            obj.insert("date".into(), json!(row.date));
            obj.insert(
                "symbol".into(),
                json!(row.symbol.clone().unwrap_or_default()),
            );
            obj.insert("activityType".into(), json!(row.activity_type));
            obj.insert("currency".into(), json!(row.currency));
            obj.insert("isDraft".into(), json!(false));
            obj.insert("isValid".into(), json!(false));
            obj.insert("forceImport".into(), json!(row.force_import));
            obj.insert(
                "lineNumber".into(),
                json!(row.line_number.unwrap_or((index + 1) as i32)),
            );
            if let Some(v) = row.quantity {
                obj.insert("quantity".into(), json!(v));
            }
            if let Some(v) = row.unit_price {
                obj.insert("unitPrice".into(), json!(v));
            }
            if let Some(v) = row.amount {
                obj.insert("amount".into(), json!(v));
            }
            if let Some(v) = row.fee {
                obj.insert("fee".into(), json!(v));
            }
            if let Some(v) = &row.account_id {
                obj.insert("accountId".into(), json!(v));
            }
            if let Some(v) = &row.symbol_name {
                obj.insert("symbolName".into(), json!(v));
            }
            if let Some(v) = &row.comment {
                obj.insert("comment".into(), json!(v));
            }
            serde_json::from_value::<ActivityImport>(Value::Object(obj))
                .map_err(AgentToolError::from)
        })
        .collect()
}

/// Summarize audit args to just the row count. Built as an allowlist (a fresh
/// object with only the count) rather than cloning the input and replacing the
/// `activities` key — otherwise an agent could smuggle sensitive data into the
/// audit log via any extra top-level field, which would survive the redaction.
fn redact_activities(args: &serde_json::Value) -> serde_json::Value {
    let count = args
        .get("activities")
        .and_then(|a| a.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    json!({ "activities": format!("[{count} rows]") })
}

// ── get_import_mapping ──────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetImportMappingArgs {
    pub account_id: String,
    /// Mapping context; defaults to the CSV activity importer.
    #[serde(default)]
    pub context_kind: Option<String>,
}

/// Fetch an account's saved import mapping/template so the agent can map a
/// CSV consistently with prior imports.
pub struct GetImportMapping;

#[async_trait::async_trait]
impl AgentTool for GetImportMapping {
    fn name(&self) -> &'static str {
        "get_import_mapping"
    }

    fn description(&self) -> &'static str {
        "Get an account's saved CSV import mapping/template (column→field mappings, symbol and activity-type mappings, and parse config) so you can map a new CSV the same way prior imports were mapped. Returns an empty mapping when none is saved."
    }

    fn input_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "accountId": { "type": "string", "description": "Account to fetch the saved mapping for." },
                "contextKind": { "type": "string", "description": "Mapping context. Defaults to CSV_ACTIVITY." }
            },
            "required": ["accountId"]
        })
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::ActivitiesRead]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: GetImportMappingArgs = serde_json::from_value(args)?;
        let account_id = args.account_id.trim();
        if account_id.is_empty() {
            return Err(AgentToolError::InvalidInput(
                "accountId is required".to_string(),
            ));
        }
        let context_kind = args
            .context_kind
            .filter(|k| !k.trim().is_empty())
            .unwrap_or_else(|| "CSV_ACTIVITY".to_string());

        let mapping = env
            .activity_service()
            .get_import_mapping(account_id.to_string(), context_kind)
            .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;

        Ok(AgentToolResult {
            content: serde_json::to_value(mapping)?,
        })
    }
}

// ── prepare_activity_import ─────────────────────────────────────────────

/// Validate mapped rows and detect duplicates without writing anything.
pub struct PrepareActivityImport;

#[async_trait::async_trait]
impl AgentTool for PrepareActivityImport {
    fn name(&self) -> &'static str {
        "prepare_activity_import"
    }

    fn description(&self) -> &'static str {
        "Validate a batch of activity rows you mapped from a CSV and detect duplicates, WITHOUT importing. Returns each row's validity, errors/warnings, and whether it duplicates an existing or in-batch activity, plus a summary. Review duplicates with the user, then call commit_activity_import (set forceImport on rows to import despite a duplicate)."
    }

    fn input_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": { "activities": { "type": "array", "items": activity_row_schema() } },
            "required": ["activities"]
        })
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        // Duplicate detection reads existing stored activities (returning their
        // ids), so this needs read access alongside draft — otherwise a
        // draft-only token could probe for the existence of stored activities.
        &[AgentScope::ActivitiesRead, AgentScope::ActivitiesDraft]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Draft
    }

    fn sanitize_args_for_audit(&self, args: &serde_json::Value) -> serde_json::Value {
        redact_activities(args)
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: ActivityImportArgs = serde_json::from_value(args)?;
        let rows = to_import_rows(&args.activities)?;

        let checked = env
            .activity_service()
            .check_activities_import(rows)
            .await
            .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;

        let total = checked.len();
        let invalid = checked.iter().filter(|r| !r.is_valid).count();
        let duplicates = checked.iter().filter(|r| is_duplicate(r)).count();
        let output = PrepareActivityImportOutput {
            summary: ImportPreviewSummary {
                total,
                valid: total - invalid,
                invalid,
                duplicates,
            },
            rows: checked.iter().map(to_result).collect(),
        };
        Ok(AgentToolResult {
            content: serde_json::to_value(output)?,
        })
    }
}

// ── commit_activity_import ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitActivityImportOutput {
    pub import_run_id: String,
    pub summary: wealthfolio_core::activities::ImportActivitiesSummary,
    /// Rows that failed validation/import (with their errors).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub failed: Vec<ImportRowResult>,
}

/// Import mapped rows through the real pipeline (dedup-safe, one import run).
pub struct CommitActivityImport;

#[async_trait::async_trait]
impl AgentTool for CommitActivityImport {
    fn name(&self) -> &'static str {
        "commit_activity_import"
    }

    fn description(&self) -> &'static str {
        "Import a batch of mapped activity rows through Wealthfolio's import pipeline as one import run. Duplicates are skipped unless a row sets forceImport=true. This MUTATES data — only call after previewing with prepare_activity_import and confirming with the user. Returns the import run id, a summary (imported/skipped/duplicates/assets created), and any failed rows."
    }

    fn input_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": { "activities": { "type": "array", "items": activity_row_schema() } },
            "required": ["activities"]
        })
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        // Runs the same duplicate-detection read as `prepare_activity_import`
        // before importing, so it needs read in addition to draft + write.
        &[
            AgentScope::ActivitiesRead,
            AgentScope::ActivitiesDraft,
            AgentScope::ActivitiesWrite,
        ]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Write
    }

    fn sanitize_args_for_audit(&self, args: &serde_json::Value) -> serde_json::Value {
        redact_activities(args)
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: ActivityImportArgs = serde_json::from_value(args)?;
        let rows = to_import_rows(&args.activities)?;

        // Resolve each row (symbol → quote currency, instrument type, asset
        // resolution) before importing. `import_activities` expects rows the
        // check step has already filled in; without this, every row carrying a
        // symbol is rejected for a missing quoteCcy/instrumentType. This mirrors
        // `prepare_activity_import` and the desktop/web importers (check → import).
        let checked = env
            .activity_service()
            .check_activities_import(rows)
            .await
            .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;

        let result = env
            .activity_service()
            .import_activities(checked)
            .await
            .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;

        // Refresh derived data/health after a write, like the commit tools.
        if result.summary.imported > 0 {
            env.health_service().clear_cache().await;
        }

        let failed: Vec<ImportRowResult> = result
            .activities
            .iter()
            .filter(|r| !r.is_valid || r.errors.as_ref().is_some_and(|e| !e.is_empty()))
            .map(to_result)
            .collect();

        let output = CommitActivityImportOutput {
            import_run_id: result.import_run_id,
            summary: result.summary,
            failed,
        };
        Ok(AgentToolResult {
            content: serde_json::to_value(output)?,
        })
    }
}

/// JSON schema for one mapped CSV row (shared by prepare/commit).
fn activity_row_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "properties": {
            "date": { "type": "string", "description": "Activity date (ISO or common format)." },
            "activityType": { "type": "string", "description": "e.g. BUY, SELL, DEPOSIT, DIVIDEND." },
            "currency": { "type": "string" },
            "symbol": { "type": "string", "description": "Ticker; omit for pure cash activities." },
            "symbolName": { "type": "string" },
            "quantity": { "type": "number" },
            "unitPrice": { "type": "number" },
            "amount": { "type": "number" },
            "fee": { "type": "number" },
            "accountId": { "type": "string" },
            "comment": { "type": "string" },
            "lineNumber": { "type": "integer", "description": "1-based source row, for duplicate messages." },
            "forceImport": { "type": "boolean", "description": "Import despite a detected duplicate." }
        },
        "required": ["date", "activityType", "currency"]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(force: bool) -> ActivityImportRow {
        ActivityImportRow {
            date: "2024-01-15".to_string(),
            activity_type: "BUY".to_string(),
            currency: "USD".to_string(),
            symbol: Some("AAPL".to_string()),
            symbol_name: None,
            quantity: Some(10.0),
            unit_price: Some(150.25),
            amount: None,
            fee: None,
            account_id: Some("acct-1".to_string()),
            comment: None,
            line_number: None,
            force_import: force,
        }
    }

    #[test]
    fn maps_rows_to_import_with_defaults() {
        let mapped = to_import_rows(&[row(true)]).unwrap();
        let r = &mapped[0];
        assert_eq!(r.symbol, "AAPL");
        assert_eq!(r.activity_type, "BUY");
        assert_eq!(r.currency, "USD");
        assert!(r.quantity.is_some());
        assert_eq!(r.line_number, Some(1)); // defaulted from index
        assert!(r.force_import); // "import anyway" preserved
        assert!(!r.is_draft);
    }

    #[test]
    fn cash_row_without_symbol_defaults_to_empty() {
        let mut r = row(false);
        r.symbol = None;
        let mapped = to_import_rows(&[r]).unwrap();
        assert_eq!(mapped[0].symbol, "");
    }

    #[test]
    fn empty_and_oversized_are_rejected() {
        assert!(matches!(
            to_import_rows(&[]),
            Err(AgentToolError::InvalidInput(_))
        ));
        let many = vec![row(false); MAX_IMPORT_ROWS + 1];
        assert!(matches!(
            to_import_rows(&many),
            Err(AgentToolError::InvalidInput(_))
        ));
    }

    #[test]
    fn audit_redaction_replaces_rows_with_count() {
        let args = json!({ "activities": [ {"a": 1}, {"a": 2}, {"a": 3} ] });
        let redacted = redact_activities(&args);
        assert_eq!(redacted["activities"], json!("[3 rows]"));
    }

    #[test]
    fn audit_redaction_drops_unknown_keys() {
        // An agent must not be able to smuggle sensitive data into the audit
        // log via an extra top-level field; only the row-count summary survives.
        let args = json!({
            "activities": [ {"a": 1} ],
            "note": "SSN 123-45-6789",
        });
        let redacted = redact_activities(&args);
        assert_eq!(redacted["activities"], json!("[1 rows]"));
        assert!(redacted.get("note").is_none());
        assert_eq!(redacted.as_object().unwrap().len(), 1);
    }
}
