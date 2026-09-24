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
use serde_json::json;
use wealthfolio_core::activities::ActivityImport;
use wealthfolio_core::assets::{InstrumentType, QuoteMode};

use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};

/// Hard cap on rows per call to keep payloads and audit rows bounded.
const MAX_IMPORT_ROWS: usize = 1000;

/// A CSV row the agent has already mapped to activity fields. Maps to the
/// core [`ActivityImport`]; omit fields that don't apply (e.g. `symbol` for
/// pure cash activities).
#[derive(Debug, Clone, Serialize, Deserialize)]
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
    /// Reviewed identity, using the same fields as the CSV importer.
    #[serde(default)]
    pub asset_id: Option<String>,
    #[serde(default)]
    pub instrument_type: Option<String>,
    #[serde(default)]
    pub exchange_mic: Option<String>,
    #[serde(default)]
    pub quote_ccy: Option<String>,
    #[serde(default)]
    pub quote_mode: Option<QuoteMode>,
    #[serde(default)]
    pub isin: Option<String>,
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub provider_symbol: Option<String>,
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
    pub asset_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub isin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_symbol: Option<String>,
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
        asset_id: row.asset_id.clone(),
        isin: row.isin.clone(),
        provider_id: row.provider_id.clone(),
        provider_symbol: row.provider_symbol.clone(),
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

/// Match CSV label normalization while reusing the domain's instrument aliases.
fn normalize_instrument_type(value: &str) -> Option<InstrumentType> {
    let normalized = value
        .trim()
        .split(|c: char| c.is_whitespace() || c == '-' || c == '_')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("");
    // Keep this allowlist aligned with the CSV importer's instrument-type.ts.
    // The provider parser also accepts futures and money-market labels, which
    // CSV does not support as explicit types or symbol prefixes.
    match normalized.to_uppercase().as_str() {
        "OPT" => Some(InstrumentType::Option),
        "EQUITY" | "STOCK" | "ETF" | "MUTUALFUND" | "INDEX" | "BOND" | "FIXEDINCOME" | "DEBT"
        | "OPTION" | "CRYPTO" | "CRYPTOCURRENCY" | "FX" | "FOREX" | "CURRENCY" | "METAL"
        | "COMMODITY" => InstrumentType::from_external_str(&normalized),
        _ => None,
    }
}

/// CSV recognizes typed prefixes before sending rows to the shared importer.
/// MCP needs the same preprocessing; otherwise `crypto:BNB-EUR` retains
/// `crypto:` in the canonical asset symbol. Unknown prefixes remain symbols.
fn split_instrument_prefixed_symbol(symbol: &str) -> (&str, Option<InstrumentType>) {
    let symbol = symbol.trim();
    if let Some((prefix, value)) = symbol.split_once(':') {
        let value = value.trim();
        let valid_prefix = (1..=21).contains(&prefix.len())
            && prefix.starts_with(|c: char| c.is_ascii_alphabetic())
            && prefix
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c.is_whitespace());
        if valid_prefix && !value.is_empty() {
            if let Some(kind) = normalize_instrument_type(prefix) {
                return (value, Some(kind));
            }
        }
    }
    (symbol, None)
}

/// Convert the input allowlist into core rows, normalizing CSV identity hints.
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
            // Serialize the input allowlist so identity fields survive both tools.
            // Validation status always belongs to the backend, never to the caller.
            let mut obj = serde_json::to_value(row)?;
            let (symbol, prefix_type) =
                split_instrument_prefixed_symbol(row.symbol.as_deref().unwrap_or_default());
            let instrument_type = match row.instrument_type.as_deref() {
                Some(value) => Some(normalize_instrument_type(value).ok_or_else(|| {
                    AgentToolError::InvalidInput(format!(
                        "Row {}: unsupported instrumentType '{}'.",
                        index + 1,
                        value
                    ))
                })?),
                None => prefix_type,
            };
            obj["symbol"] = json!(symbol);
            obj["instrumentType"] = json!(instrument_type.map(|kind| kind.as_db_str()));
            obj["isDraft"] = json!(false);
            obj["isValid"] = json!(false);
            obj["lineNumber"] = json!(row.line_number.unwrap_or((index + 1) as i32));
            serde_json::from_value::<ActivityImport>(obj).map_err(AgentToolError::from)
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
        "Validate a batch of activity rows you mapped from a CSV and detect duplicates, WITHOUT importing. Returns each row's validity, errors/warnings, and whether it duplicates an existing or in-batch activity, plus a summary. Review resolved asset identities and duplicates with the user. Merge each reviewed row's assetId, symbol, instrumentType, exchangeMic, quoteCcy, quoteMode, providerId and providerSymbol into the original input before calling commit_activity_import (set forceImport on rows to import despite a duplicate)."
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
        "Import a batch of mapped activity rows through Wealthfolio's import pipeline as one import run. Include the reviewed identity fields returned by prepare_activity_import to preserve the selected assets; bare symbols are resolved again. Duplicates are skipped unless a row sets forceImport=true. This MUTATES data — only call after previewing with prepare_activity_import and confirming with the user. Returns the import run id, a summary (imported/skipped/duplicates/assets created), and any failed rows."
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
            "symbol": { "type": "string", "description": "Ticker or typed symbol such as crypto:BNB-EUR, bond:<ISIN>, option:<OCC>. Omit when selecting assetId or for pure cash activities." },
            "symbolName": { "type": "string" },
            "assetId": { "type": "string", "description": "Existing asset UUID selected during review. Omit symbol to use the stored identity; do not put UUIDs in symbol." },
            "instrumentType": { "type": "string", "description": "EQUITY, CRYPTO, FX, OPTION, METAL or BOND (case-insensitive; CSV aliases accepted). Takes precedence over a typed symbol prefix." },
            "exchangeMic": { "type": "string", "description": "Reviewed exchange MIC, e.g. XNAS or XETR." },
            "quoteCcy": { "type": "string", "description": "Asset quote currency, distinct from the activity currency." },
            "quoteMode": { "type": "string", "enum": ["MARKET", "MANUAL"] },
            "isin": { "type": "string", "description": "Security ISIN used by the CSV asset resolver." },
            "providerId": { "type": "string", "description": "Market data provider returned during review." },
            "providerSymbol": { "type": "string", "description": "Provider-native symbol returned during review." },
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
            asset_id: None,
            instrument_type: None,
            exchange_mic: None,
            quote_ccy: None,
            quote_mode: None,
            isin: None,
            provider_id: None,
            provider_symbol: None,
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
    fn typed_symbols_are_normalized_before_resolution() {
        for (input, symbol, kind) in [
            (" crypto:BNB-EUR ", "BNB-EUR", "CRYPTO"),
            ("CRYPTOCURRENCY:PEPE-EUR", "PEPE-EUR", "CRYPTO"),
            ("bond : US037833DU14", "US037833DU14", "BOND"),
            ("fixed income:US037833DU14", "US037833DU14", "BOND"),
            ("opt:AAPL260918C00200000", "AAPL260918C00200000", "OPTION"),
        ] {
            let mut input_row = row(false);
            input_row.symbol = Some(input.to_string());
            let mapped = to_import_rows(&[input_row]).unwrap();
            assert_eq!(mapped[0].symbol, symbol);
            assert_eq!(mapped[0].instrument_type.as_deref(), Some(kind));
        }
        for symbol in ["BNB", "PEPE", "vendor:BNB-EUR", "crypto:", "1crypto:BNB"] {
            assert_eq!(split_instrument_prefixed_symbol(symbol), (symbol, None));
        }
    }

    #[test]
    fn explicit_type_takes_precedence_over_prefix_like_csv() {
        let mut input = row(false);
        input.symbol = Some("crypto:BNB-EUR".to_string());
        input.instrument_type = Some("stock".to_string());
        let mapped = to_import_rows(&[input]).unwrap();
        assert_eq!(mapped[0].symbol, "BNB-EUR");
        assert_eq!(mapped[0].instrument_type.as_deref(), Some("EQUITY"));
    }

    #[test]
    fn explicit_crypto_hint_is_not_discarded_for_bare_tickers() {
        for symbol in ["BNB", "PEPE"] {
            for kind in ["CRYPTO", "Crypto", "crypto", "CRYPTOCURRENCY"] {
                let mut input = row(false);
                input.symbol = Some(symbol.to_string());
                input.instrument_type = Some(kind.to_string());
                let mapped = to_import_rows(&[input]).unwrap();
                assert_eq!(mapped[0].symbol, symbol);
                assert_eq!(mapped[0].instrument_type.as_deref(), Some("CRYPTO"));
            }
        }
    }

    #[test]
    fn provider_only_aliases_do_not_expand_csv_import_types() {
        // CSV deliberately leaves these prefixes intact; the broader provider
        // parser must not silently reinterpret an unsupported instrument.
        for label in ["future", "FUTURES", "money_market"] {
            let symbol = format!("{label}:CL2412");
            let mut input = row(false);
            input.symbol = Some(symbol.clone());
            let mapped = to_import_rows(&[input.clone()]).unwrap();
            assert_eq!(mapped[0].symbol, symbol);
            assert_eq!(mapped[0].instrument_type, None);

            input.instrument_type = Some(label.to_string());
            assert!(matches!(
                to_import_rows(&[input]),
                Err(AgentToolError::InvalidInput(_))
            ));
        }
    }

    #[test]
    fn unsupported_identity_labels_are_rejected() {
        let mut input = row(false);
        input.instrument_type = Some("CRPYTO".to_string());
        assert!(matches!(
            to_import_rows(&[input]),
            Err(AgentToolError::InvalidInput(_))
        ));
        let mut value = serde_json::to_value(row(false)).unwrap();
        value["quoteMode"] = json!("UNKNOWN");
        assert!(serde_json::from_value::<ActivityImportRow>(value).is_err());
    }

    #[test]
    fn existing_asset_can_be_selected_without_a_symbol() {
        let mut value = serde_json::to_value(row(false)).unwrap();
        value["assetId"] = json!("crypto-bnb-id");
        value.as_object_mut().unwrap().remove("symbol");
        // Backend-owned validation fields cannot be injected through the tool.
        value["isValid"] = json!(true);
        value["isDraft"] = json!(true);
        let input: ActivityImportRow = serde_json::from_value(value).unwrap();
        let mapped = to_import_rows(&[input]).unwrap();
        assert_eq!(mapped[0].asset_id.as_deref(), Some("crypto-bnb-id"));
        assert_eq!(mapped[0].symbol, "");
        assert!(!mapped[0].is_valid);
        assert!(!mapped[0].is_draft);
    }

    #[test]
    fn reviewed_identity_survives_preview_and_commit_mapping() {
        for asset_id in [None, Some("existing-id")] {
            let mut input = serde_json::to_value(row(false)).unwrap();
            let identity = json!({
                "assetId": asset_id,
                "symbol": "BNB",
                "symbolName": "Binance Coin",
                "instrumentType": "CRYPTO",
                "exchangeMic": null,
                "quoteCcy": "EUR",
                "quoteMode": "MARKET",
                "isin": null,
                "providerId": "YAHOO",
                "providerSymbol": "BNB-EUR"
            });
            input
                .as_object_mut()
                .unwrap()
                .extend(identity.as_object().unwrap().clone());
            let parsed: ActivityImportRow = serde_json::from_value(input.clone()).unwrap();
            let checked = to_import_rows(&[parsed]).unwrap().remove(0);
            let preview = serde_json::to_value(to_result(&checked)).unwrap();
            for (field, value) in identity.as_object().unwrap() {
                if !value.is_null() {
                    assert_eq!(&preview[field], value, "preview dropped {field}");
                }
            }
            // Clients merge reviewed fields into their original financial row.
            input
                .as_object_mut()
                .unwrap()
                .extend(preview.as_object().unwrap().clone());
            let commit: ActivityImportRow = serde_json::from_value(input).unwrap();
            let committed = to_import_rows(&[commit]).unwrap().remove(0);
            assert_eq!(committed.asset_id, checked.asset_id);
            assert_eq!(committed.provider_symbol, checked.provider_symbol);
            assert_eq!(committed.instrument_type, checked.instrument_type);
            assert_eq!(committed.quote_ccy, checked.quote_ccy);
            assert_eq!(committed.quantity, checked.quantity);
        }
    }

    #[test]
    fn both_tools_advertise_the_csv_identity_fields() {
        let prepare = PrepareActivityImport.input_schema();
        let commit = CommitActivityImport.input_schema();
        assert_eq!(prepare, commit);
        let properties = &prepare["properties"]["activities"]["items"]["properties"];
        for field in [
            "assetId",
            "instrumentType",
            "exchangeMic",
            "quoteCcy",
            "quoteMode",
            "isin",
            "providerId",
            "providerSymbol",
        ] {
            assert!(properties.get(field).is_some(), "missing {field}");
        }
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
