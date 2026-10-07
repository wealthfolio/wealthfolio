//! Quote import tools (MCP-only).
//!
//! Save reviewed closing prices for existing assets, such as the unit prices a
//! statement reports for its closing date, so the portfolio's value on that
//! date can match the statement without changing activities. The preview
//! checks each row against its asset and the stored quote of its day; the
//! commit checks the rows again and saves them through the quote import
//! pipeline as manual quotes, which provider syncs do not overwrite. The
//! import queues one valuation recalculation per batch.

use std::sync::Arc;

use chrono::NaiveDate;
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::json;
use wealthfolio_core::assets::QuoteMode;
use wealthfolio_core::quotes::{
    ImportValidationStatus, QuoteImportOutcome, QuoteImportPreview, QuoteImportRow,
};

use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};

/// Max quotes per call, so one call cannot force unbounded writes.
const MAX_QUOTES: usize = 100;

/// One reviewed quote, as prepare and commit take it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteImportInput {
    pub asset_id: String,
    pub date: String,
    /// A JSON number or a decimal string.
    pub price: Decimal,
    pub currency: String,
    #[serde(default)]
    pub overwrite: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteImportArgs {
    pub quotes: Vec<QuoteImportInput>,
}

/// The asset a row names.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteAssetDto {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub quote_ccy: String,
    pub quote_mode: QuoteMode,
}

/// The quote valuations use for the row's day.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredQuoteDto {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price: Option<f64>,
    pub currency: String,
    /// MANUAL for an entered quote, otherwise its provider (or BROKER).
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteRowResult {
    pub index: usize,
    pub asset_id: String,
    pub date: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price: Option<f64>,
    pub currency: String,
    pub outcome: QuoteImportOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset: Option<QuoteAssetDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub existing: Option<StoredQuoteDto>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteImportSummary {
    pub total: usize,
    pub create: usize,
    pub update: usize,
    pub skip: usize,
    pub conflict: usize,
    pub invalid: usize,
}

/// Output for `prepare_quote_import`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareQuoteImportOutput {
    pub summary: QuoteImportSummary,
    pub rows: Vec<QuoteRowResult>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Recalculation {
    /// Quotes were saved; valuations recalculate in the background.
    Queued,
    /// Nothing was saved.
    None,
}

/// Output for `commit_quote_import`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitQuoteImportOutput {
    /// False when an invalid or conflicting row stopped the batch.
    pub committed: bool,
    /// Quotes written.
    pub saved: usize,
    pub summary: QuoteImportSummary,
    pub rows: Vec<QuoteRowResult>,
    pub recalculation: Recalculation,
    pub message: String,
}

fn parse_rows(args: serde_json::Value) -> Result<Vec<QuoteImportRow>, AgentToolError> {
    // Reject oversized batches from the raw array before deserializing it.
    let count = args
        .get("quotes")
        .and_then(|quotes| quotes.as_array())
        .map(Vec::len);
    if let Some(count) = count.filter(|count| *count > MAX_QUOTES) {
        return Err(AgentToolError::InvalidInput(format!(
            "Batch limited to {MAX_QUOTES} quotes, got {count}"
        )));
    }
    let args: QuoteImportArgs = serde_json::from_value(args)?;
    if args.quotes.is_empty() {
        return Err(AgentToolError::InvalidInput(
            "quotes must contain at least one quote".to_string(),
        ));
    }
    Ok(args
        .quotes
        .into_iter()
        .map(|row| QuoteImportRow {
            asset_id: row.asset_id.trim().to_string(),
            date: canonical_date(row.date.trim()),
            close: row.price,
            currency: row.currency.trim().to_string(),
            overwrite: row.overwrite,
        })
        .collect())
}

/// Zero-pad a date such as 2026-6-3, so results and quote ids use one
/// spelling; anything unparsable is left for the preview to report.
fn canonical_date(date: &str) -> String {
    NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map(|date| date.to_string())
        .unwrap_or_else(|_| date.to_string())
}

fn row_result(index: usize, row: &QuoteImportRow, preview: &QuoteImportPreview) -> QuoteRowResult {
    QuoteRowResult {
        index,
        asset_id: row.asset_id.clone(),
        date: row.date.clone(),
        price: row.close.to_f64(),
        currency: row.currency.clone(),
        outcome: preview.outcome,
        asset: preview.asset.as_ref().map(|asset| QuoteAssetDto {
            symbol: asset
                .display_code
                .clone()
                .or_else(|| asset.instrument_symbol.clone()),
            name: asset.name.clone(),
            quote_ccy: asset.quote_ccy.clone(),
            quote_mode: asset.quote_mode,
        }),
        existing: preview.existing.as_ref().map(|quote| StoredQuoteDto {
            price: quote.close.to_f64(),
            currency: quote.currency.clone(),
            source: quote.data_source.clone(),
        }),
        errors: preview.errors.clone(),
    }
}

fn summarize(rows: &[QuoteRowResult]) -> QuoteImportSummary {
    let mut summary = QuoteImportSummary {
        total: rows.len(),
        ..QuoteImportSummary::default()
    };
    for row in rows {
        match row.outcome {
            QuoteImportOutcome::Create => summary.create += 1,
            QuoteImportOutcome::Update => summary.update += 1,
            QuoteImportOutcome::Skip => summary.skip += 1,
            QuoteImportOutcome::Conflict => summary.conflict += 1,
            QuoteImportOutcome::Invalid => summary.invalid += 1,
        }
    }
    summary
}

/// Check the rows against their assets and stored quotes.
fn preview(
    env: &dyn AgentEnvironment,
    rows: &[QuoteImportRow],
) -> Result<(Vec<QuoteImportPreview>, Vec<QuoteRowResult>), AgentToolError> {
    let previews = env
        .quote_service()
        .preview_quote_import(rows)
        .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;
    let results = rows
        .iter()
        .zip(&previews)
        .enumerate()
        .map(|(index, (row, preview))| row_result(index, row, preview))
        .collect();
    Ok((previews, results))
}

fn quotes_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "properties": {
            "quotes": {
                "type": "array",
                "minItems": 1,
                "maxItems": MAX_QUOTES,
                "items": {
                    "type": "object",
                    "properties": {
                        "assetId": { "type": "string", "description": "Id of an existing investment asset. Tickers are not resolved here: get_asset_taxonomy_assignments (classification:read) returns the id for a ticker or name." },
                        "date": { "type": "string", "description": "Quote day, YYYY-MM-DD (UTC), today or earlier." },
                        "price": { "type": "number", "exclusiveMinimum": 0, "description": "Closing (unit) price in the asset's quote currency." },
                        "currency": { "type": "string", "description": "The asset's quote currency, as prepare_quote_import shows it (minor units such as GBp are case-sensitive)." },
                        "overwrite": { "type": "boolean", "description": "Replace a stored quote of that day that has a different price. Set it only on rows whose replacement the user approved." }
                    },
                    "required": ["assetId", "date", "price", "currency"]
                }
            }
        },
        "required": ["quotes"]
    })
}

/// Keep only asset ids, dates and counts of the arguments in the audit log, at
/// most `MAX_QUOTES` rows: never prices, and no extra field an agent attaches.
fn quotes_for_audit(args: &serde_json::Value) -> serde_json::Value {
    let rows = args
        .get("quotes")
        .and_then(|quotes| quotes.as_array())
        .map(Vec::as_slice)
        .unwrap_or_default();
    let quotes: Vec<serde_json::Value> = rows
        .iter()
        .take(MAX_QUOTES)
        .map(|row| {
            json!({
                "assetId": row.get("assetId").and_then(|value| value.as_str()),
                "date": row.get("date").and_then(|value| value.as_str()),
            })
        })
        .collect();
    let overwrite_count = rows
        .iter()
        .filter(|row| row.get("overwrite").and_then(|value| value.as_bool()) == Some(true))
        .count();
    json!({
        "quotes": quotes,
        "quoteCount": rows.len(),
        "overwriteCount": overwrite_count,
    })
}

/// Preview reviewed quotes without saving them.
pub struct PrepareQuoteImport;

#[async_trait::async_trait]
impl AgentTool for PrepareQuoteImport {
    fn name(&self) -> &'static str {
        "prepare_quote_import"
    }

    fn description(&self) -> &'static str {
        "Preview saving closing prices (quotes) for existing assets, such as the unit prices a statement reports for its closing date, WITHOUT saving them. Each row names an asset by assetId (tickers are not resolved; get_asset_taxonomy_assignments, which needs classification:read, returns the id for a ticker or name), a date (YYYY-MM-DD, today or earlier), the price and the asset's quote currency. Returns per row the asset, the quote valuations use for that day (price and source: MANUAL for an entered quote, otherwise its provider) and the outcome: create (no quote that day, or a provider price equal to the row's, which is saved as a manual quote so a later refetch cannot change it), skip (a manual quote with that price is already stored), update (a different price is stored and the row sets overwrite), conflict (a different price is stored and overwrite is not set) or invalid (see errors: unknown or non-investment asset, bad or future date, non-positive price, currency other than the asset's quote currency, or a second row for the same asset and date). Show the outcomes to the user, set overwrite only on rows whose replacement they approved, then pass the same rows to commit_quote_import. Up to 100 rows."
    }

    fn input_schema(&self) -> serde_json::Value {
        quotes_schema()
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        // The preview returns stored quotes, so it needs read access alongside
        // the write scope, like the activity import preview.
        &[AgentScope::HoldingsRead, AgentScope::MarketDataWrite]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Draft
    }

    fn sanitize_args_for_audit(&self, args: &serde_json::Value) -> serde_json::Value {
        quotes_for_audit(args)
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let rows = parse_rows(args)?;
        let (_, rows) = preview(env.as_ref(), &rows)?;
        let output = PrepareQuoteImportOutput {
            summary: summarize(&rows),
            rows,
        };
        Ok(AgentToolResult {
            content: serde_json::to_value(output)?,
        })
    }
}

/// Save reviewed quotes through the quote import pipeline.
pub struct CommitQuoteImport;

#[async_trait::async_trait]
impl AgentTool for CommitQuoteImport {
    fn name(&self) -> &'static str {
        "commit_quote_import"
    }

    fn description(&self) -> &'static str {
        "Save reviewed closing prices for existing assets as manual quotes. This MUTATES data: only call it after prepare_quote_import and the user's confirmation, with the same rows. The rows are checked again; if any is invalid or a conflict, nothing is saved and committed is false. Rows whose price is already stored as a manual quote are skipped, so repeating a call is safe. A manual quote takes precedence over the provider price of its day and provider syncs do not overwrite it; creating or editing a BUY or SELL of a manually priced asset on that day replaces it with the trade price. Activities, quantities and cost basis are not changed. When quotes are saved, recalculation is queued: valuations update in the background within a few seconds; check them with get_valuation_history or get_net_worth. Up to 100 rows."
    }

    fn input_schema(&self) -> serde_json::Value {
        quotes_schema()
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        // Runs the same preview before saving, so it needs read as well.
        &[AgentScope::HoldingsRead, AgentScope::MarketDataWrite]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Write
    }

    fn sanitize_args_for_audit(&self, args: &serde_json::Value) -> serde_json::Value {
        quotes_for_audit(args)
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let rows = parse_rows(args)?;
        let (previews, mut results) = preview(env.as_ref(), &rows)?;

        let output = |committed, saved, results: Vec<QuoteRowResult>, message: &str| {
            let recalculation = if saved > 0 {
                Recalculation::Queued
            } else {
                Recalculation::None
            };
            serde_json::to_value(CommitQuoteImportOutput {
                committed,
                saved,
                summary: summarize(&results),
                rows: results,
                recalculation,
                message: message.to_string(),
            })
        };

        // Save nothing unless every row is reviewed and valid, as the
        // activity import does.
        if previews.iter().any(|preview| {
            matches!(
                preview.outcome,
                QuoteImportOutcome::Invalid | QuoteImportOutcome::Conflict
            )
        }) {
            return Ok(AgentToolResult {
                content: output(
                    false,
                    0,
                    results,
                    "Nothing was saved: fix or remove invalid rows, and set overwrite only on conflicts the user approved.",
                )?,
            });
        }

        let writes: Vec<usize> = previews
            .iter()
            .enumerate()
            .filter(|(_, preview)| preview.outcome.writes())
            .map(|(index, _)| index)
            .collect();
        if writes.is_empty() {
            return Ok(AgentToolResult {
                content: output(
                    true,
                    0,
                    results,
                    "Every price is already stored; nothing to save.",
                )?,
            });
        }

        // import_quotes skips any day with a stored quote unless it may
        // overwrite: allow it only when a row lands on such a day (an approved
        // update, or an equal provider price saved as manual). A batch of rows
        // on empty days thus never replaces a quote stored after the check.
        let overwrite = writes
            .iter()
            .any(|&index| previews[index].existing.is_some());
        let imported = env
            .quote_service()
            .import_quotes(
                writes
                    .iter()
                    .map(|&index| rows[index].to_import())
                    .collect(),
                overwrite,
            )
            .await
            .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;

        let mut saved = 0;
        for (&index, quote) in writes.iter().zip(&imported) {
            match &quote.validation_status {
                ImportValidationStatus::Valid => saved += 1,
                ImportValidationStatus::Warning(message) => {
                    results[index].outcome = QuoteImportOutcome::Conflict;
                    results[index].errors.push(message.clone());
                }
                ImportValidationStatus::Error(message) => {
                    results[index].outcome = QuoteImportOutcome::Invalid;
                    results[index].errors.push(message.clone());
                }
            }
        }
        let message = if saved == 0 {
            "No quote was saved; see the rows' errors."
        } else if saved < writes.len() {
            "Some quotes were not saved; see their errors. Recalculation is queued for the saved ones: check valuations with get_valuation_history or get_net_worth in a few seconds."
        } else {
            "Quotes saved. Recalculation is queued: check valuations with get_valuation_history or get_net_worth in a few seconds."
        };
        Ok(AgentToolResult {
            content: output(true, saved, results, message)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(asset_id: &str) -> serde_json::Value {
        json!({ "assetId": asset_id, "date": "2026-06-30", "price": 101.25, "currency": "EUR" })
    }

    #[test]
    fn quotes_must_be_present_and_bounded() {
        assert!(matches!(
            parse_rows(json!({ "quotes": [] })),
            Err(AgentToolError::InvalidInput(_))
        ));
        let oversized: Vec<_> = (0..=MAX_QUOTES).map(|_| row("a")).collect();
        assert!(matches!(
            parse_rows(json!({ "quotes": oversized })),
            Err(AgentToolError::InvalidInput(_))
        ));
        let parsed = parse_rows(json!({ "quotes": [{
            "assetId": " a ", "date": " 2026-06-30 ", "price": 101.25,
            "currency": " EUR ", "overwrite": true
        }] }))
        .unwrap();
        assert_eq!(
            parsed,
            vec![QuoteImportRow {
                asset_id: "a".to_string(),
                date: "2026-06-30".to_string(),
                close: Decimal::new(10125, 2),
                currency: "EUR".to_string(),
                overwrite: true,
            }]
        );
    }

    #[test]
    fn dates_are_zero_padded() {
        let mut input = row("a");
        input["date"] = json!(" 2026-6-3 ");
        let parsed = parse_rows(json!({ "quotes": [input.clone()] })).unwrap();
        assert_eq!(parsed[0].date, "2026-06-03");
        input["date"] = json!("03/06/2026");
        let parsed = parse_rows(json!({ "quotes": [input] })).unwrap();
        assert_eq!(parsed[0].date, "03/06/2026");
    }

    #[test]
    fn prices_keep_the_digits_sent() {
        for (price, expected) in [
            (json!(0.1), "0.1"),
            (json!(101.25), "101.25"),
            (json!(1234.5678), "1234.5678"),
            (json!("98.7650"), "98.7650"),
        ] {
            let mut input = row("a");
            input["price"] = price;
            let parsed = parse_rows(json!({ "quotes": [input] })).unwrap();
            assert_eq!(parsed[0].close.to_string(), expected);
        }
    }

    #[test]
    fn audit_keeps_only_asset_ids_dates_and_counts() {
        let mut first = row("asset-1");
        first["overwrite"] = json!(true);
        first["note"] = json!("statement total 12345.67");
        let args = json!({ "quotes": [first, row("asset-2")], "comment": "secret" });
        assert_eq!(
            CommitQuoteImport.sanitize_args_for_audit(&args),
            json!({
                "quotes": [
                    { "assetId": "asset-1", "date": "2026-06-30" },
                    { "assetId": "asset-2", "date": "2026-06-30" }
                ],
                "quoteCount": 2,
                "overwriteCount": 1
            })
        );
        assert_eq!(
            PrepareQuoteImport.sanitize_args_for_audit(&args),
            CommitQuoteImport.sanitize_args_for_audit(&args)
        );

        let oversized: Vec<_> = (0..MAX_QUOTES + 5).map(|_| row("a")).collect();
        let audit = CommitQuoteImport.sanitize_args_for_audit(&json!({ "quotes": oversized }));
        assert_eq!(audit["quotes"].as_array().unwrap().len(), MAX_QUOTES);
        assert_eq!(audit["quoteCount"], MAX_QUOTES + 5);
    }

    #[test]
    fn prepare_and_commit_take_the_same_rows() {
        let schema = PrepareQuoteImport.input_schema();
        assert_eq!(schema, CommitQuoteImport.input_schema());
        assert_eq!(
            schema["properties"]["quotes"]["items"]["required"],
            json!(["assetId", "date", "price", "currency"])
        );
        assert_eq!(schema["properties"]["quotes"]["maxItems"], MAX_QUOTES);
    }
}
