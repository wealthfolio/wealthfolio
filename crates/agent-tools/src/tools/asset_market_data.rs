//! Asset and market-data read tools: `get_asset`, `get_quote_history` and
//! `get_market_data_providers`.
//!
//! They read stored data only; none of them calls a market data provider.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use chrono::{Duration, NaiveDate, Utc};
use rust_decimal::prelude::ToPrimitive;
use serde::{Deserialize, Serialize};
use wealthfolio_core::accounts::{account_supports_portfolio_scope, AccountPurpose};
use wealthfolio_core::assets::{Asset, AssetKind, InstrumentType, QuoteMode};
use wealthfolio_core::errors::PublicError;
use wealthfolio_core::quotes::{Quote, QuoteSyncState};

use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};
use crate::tools::asset_lookup::{
    asset_to_dto, resolve_active_asset_match, ActiveAssetResolution, ResolvedAssetDto,
};

/// Default `get_quote_history` window when no start date is given.
const DEFAULT_HISTORY_DAYS: i64 = 365;
/// Default and largest number of quote rows one `get_quote_history` call returns.
const DEFAULT_HISTORY_LIMIT: usize = 500;
const MAX_HISTORY_LIMIT: usize = 2000;
/// Distinct sync errors listed per provider.
const MAX_PROVIDER_ERRORS: usize = 5;
/// Prefix of a custom provider's id, as the app and symbol resolution use it.
pub(crate) const CUSTOM_PROVIDER_PREFIX: &str = "CUSTOM:";
/// The built-in row that dispatches to custom providers; agents pick the
/// custom provider itself instead.
const CUSTOM_DISPATCH_PROVIDER_ID: &str = "CUSTOM_SCRAPER";

fn exec_err(error: impl std::fmt::Display) -> AgentToolError {
    AgentToolError::ExecutionFailed(error.to_string())
}

/// Parameter names whose values are treated as secrets in error text.
const SECRET_KEYS: [&str; 9] = [
    "apikey=",
    "api_key=",
    "api-key=",
    "access_token=",
    "token=",
    "key=",
    "secret=",
    "password=",
    "bearer ",
];

/// Where a URL ends. Commas, parentheses and brackets are legal inside a
/// URL, so a URL runs to the next space or quote; trailing punctuation
/// is redacted with it.
fn ends_url(c: char) -> bool {
    c.is_whitespace() || matches!(c, '\'' | '"' | '`' | '>' | '<')
}

/// Whether the quote at `end` closes a value: it is followed by a
/// separator or the end of the text, not by more of the value ("tenant's").
fn closes_quote(text: &str, end: usize) -> bool {
    text[end + 1..]
        .chars()
        .next()
        .is_none_or(|c| c.is_whitespace() || matches!(c, ':' | ',' | ')' | ';'))
}

/// End of the URL starting at `start`. An apostrophe belongs to the URL
/// unless the URL opened with one (`quoted`) and this one closes it.
fn url_end(text: &str, start: usize, quoted: bool) -> usize {
    text[start..]
        .char_indices()
        .map(|(n, c)| (start + n, c))
        .find(|&(end, c)| {
            if c == '\'' {
                quoted && closes_quote(text, end)
            } else {
                ends_url(c)
            }
        })
        .map_or(text.len(), |(end, _)| end)
}

/// Where a parameter value ends.
fn ends_value(c: char) -> bool {
    ends_url(c) || matches!(c, '&' | ';' | ',' | ')' | ']')
}

/// Remove what could carry a credential from a provider or sync error: every
/// URL (any case, anywhere in the text) becomes `<url>`, and the value of a
/// key, token or password parameter, or of a bearer token, becomes
/// `<redacted>`. Custom provider URLs can hold API keys in their query.
pub(crate) fn redact_urls(text: &str) -> String {
    // ASCII lowercasing keeps byte offsets, so indexes match `text`.
    let lower = text.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut previous: Option<char> = None;
    while let Some(c) = text[i..].chars().next() {
        let rest = &lower[i..];
        if rest.starts_with("http://") || rest.starts_with("https://") {
            out.push_str("<url>");
            i = url_end(text, i, previous == Some('\''));
            previous = Some('>');
            continue;
        }
        let at_word_start = previous.is_none_or(|p| !(p.is_ascii_alphanumeric() || p == '_'));
        // A value labelled as a URL is hidden whole even without a scheme:
        // custom provider validation echoes malformed URLs ("Invalid URL '…'").
        if at_word_start && rest.starts_with("url") {
            let after = i + 3;
            let tail = &text[after..];
            let gap = tail
                .chars()
                .take_while(|c| matches!(c, ' ' | ':' | '='))
                .count();
            let start = after + gap;
            match text[start..].chars().next() {
                Some(quote @ ('\'' | '"' | '`')) => {
                    out.push_str(&text[i..=start]);
                    out.push_str("<redacted>");
                    let body = start + 1;
                    // The value can hold the quote character itself
                    // ("tenant's"), so only a quote followed by a separator
                    // or the end closes it.
                    i = text[body..]
                        .match_indices(quote)
                        .map(|(n, _)| body + n)
                        .find(|&end| closes_quote(text, end))
                        .unwrap_or(text.len());
                    previous = Some('>');
                    continue;
                }
                Some(_) if tail[..gap].contains('=') && !lower[start..].starts_with("http") => {
                    out.push_str(&text[i..start]);
                    out.push_str("<redacted>");
                    i = text[start..]
                        .find(ends_value)
                        .map_or(text.len(), |n| start + n);
                    previous = Some('>');
                    continue;
                }
                _ => {}
            }
        }
        if let Some(key) = SECRET_KEYS
            .iter()
            .find(|key| at_word_start && rest.starts_with(**key))
        {
            out.push_str(&text[i..i + key.len()]);
            out.push_str("<redacted>");
            let value = i + key.len();
            i = text[value..]
                .find(ends_value)
                .map_or(text.len(), |n| value + n);
            previous = Some('>');
            continue;
        }
        out.push(c);
        previous = Some(c);
        i += c.len_utf8();
    }
    out
}

fn date_of(quote: &Quote) -> NaiveDate {
    quote.timestamp.date_naive()
}

// ---------------------------------------------------------------------------
// get_asset
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetAssetArgs {
    #[serde(default)]
    pub asset_id: Option<String>,
    #[serde(default)]
    pub query: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetDetailDto {
    pub asset_id: String,
    pub kind: AssetKind,
    pub name: Option<String>,
    pub display_code: Option<String>,
    pub symbol: Option<String>,
    pub exchange_mic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exchange_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub isin: Option<String>,
    pub instrument_type: Option<InstrumentType>,
    pub is_active: bool,
    pub quote_mode: QuoteMode,
    pub quote_currency: String,
    /// Provider id the asset prefers (`CUSTOM:<code>` for a custom
    /// provider); none means the enabled providers in priority order.
    pub preferred_provider: Option<String>,
    /// Per-provider symbols, keyed by provider id.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub provider_symbols: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestQuoteDto {
    pub date: Option<String>,
    pub close: Option<f64>,
    pub currency: Option<String>,
    pub source: Option<String>,
    pub is_stale: bool,
    /// Market date the quote is expected for.
    pub effective_market_date: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub missing_reason: Option<MissingQuoteReasonDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingQuoteReasonDto {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStateDto {
    /// Provider used by the last sync.
    pub provider: String,
    pub last_synced_at: Option<String>,
    pub error_count: i32,
    pub last_error: Option<String>,
    pub position_closed_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuoteSourceDto {
    pub source: String,
    pub currency: String,
    pub count: usize,
    pub first_date: String,
    pub last_date: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetHoldingDto {
    pub account_id: String,
    pub account_name: String,
    pub quantity: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetAssetOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset: Option<AssetDetailDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_quote: Option<LatestQuoteDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sync_state: Option<SyncStateDto>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub quote_sources: Vec<QuoteSourceDto>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub holdings: Vec<AssetHoldingDto>,
    /// Accounts whose holdings could not be read for this asset.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub incomplete_account_ids: Vec<String>,
    /// Set instead of `asset` when the query matches several assets.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub candidates: Vec<ResolvedAssetDto>,
}

/// The provider id an asset prefers, in the form the asset update tools take.
pub(crate) fn preferred_provider_id(asset: &Asset) -> Option<String> {
    let provider = asset.preferred_provider()?;
    if provider == CUSTOM_DISPATCH_PROVIDER_ID {
        if let Some(code) = asset
            .provider_config
            .as_ref()
            .and_then(|config| config.get("custom_provider_code"))
            .and_then(|code| code.as_str())
        {
            return Some(format!("{CUSTOM_PROVIDER_PREFIX}{code}"));
        }
    }
    Some(provider)
}

pub(crate) fn provider_symbols(asset: &Asset) -> BTreeMap<String, String> {
    let Some(overrides) = asset.provider_overrides().and_then(|o| o.as_object()) else {
        return BTreeMap::new();
    };
    overrides
        .iter()
        .filter_map(|(provider, value)| {
            let field = |name: &str| value.get(name).and_then(|v| v.as_str());
            let symbol = match field("type") {
                Some("fx_pair") => format!("{}/{}", field("from")?, field("to")?),
                Some("crypto_pair") => format!("{}/{}", field("symbol")?, field("market")?),
                _ => value
                    .as_str()
                    .or_else(|| field("symbol"))
                    .or_else(|| field("isin"))?
                    .to_string(),
            };
            Some((provider.clone(), symbol))
        })
        .collect()
}

pub(crate) fn asset_detail(asset: &Asset) -> AssetDetailDto {
    AssetDetailDto {
        asset_id: asset.id.clone(),
        kind: asset.kind.clone(),
        name: asset.name.clone(),
        display_code: asset.display_code.clone(),
        symbol: asset.instrument_symbol.clone(),
        exchange_mic: asset.instrument_exchange_mic.clone(),
        exchange_name: asset.exchange_name.clone(),
        isin: asset
            .metadata
            .as_ref()
            .and_then(|m| m.get("identifiers"))
            .and_then(|ids| ids.get("isin"))
            .and_then(|isin| isin.as_str())
            .map(str::to_uppercase),
        instrument_type: asset.instrument_type.clone(),
        is_active: asset.is_active,
        quote_mode: asset.quote_mode,
        quote_currency: asset.quote_ccy.clone(),
        preferred_provider: preferred_provider_id(asset),
        provider_symbols: provider_symbols(asset),
    }
}

fn sync_state_dto(state: QuoteSyncState) -> SyncStateDto {
    SyncStateDto {
        provider: state.data_source,
        last_synced_at: state.last_synced_at.map(|at| at.to_rfc3339()),
        error_count: state.error_count,
        // Stored sync errors can hold credentials and stay internal, as in
        // the quote service's other public reads; only their presence shows.
        last_error: state
            .last_error
            .as_deref()
            .filter(|error| !error.trim().is_empty())
            .map(|_| PublicError::provider_unavailable().message),
        position_closed_date: state.position_closed_date.map(|d| d.to_string()),
    }
}

/// Group stored quotes by source and currency, with their date span.
pub(crate) fn quote_sources(quotes: &[Quote]) -> Vec<QuoteSourceDto> {
    let mut groups: BTreeMap<(String, String), (usize, NaiveDate, NaiveDate)> = BTreeMap::new();
    for quote in quotes {
        let date = date_of(quote);
        groups
            .entry((quote.data_source.clone(), quote.currency.clone()))
            .and_modify(|(count, first, last)| {
                *count += 1;
                *first = (*first).min(date);
                *last = (*last).max(date);
            })
            .or_insert((1, date, date));
    }
    groups
        .into_iter()
        .map(
            |((source, currency), (count, first, last))| QuoteSourceDto {
                source,
                currency,
                count,
                first_date: first.to_string(),
                last_date: last.to_string(),
            },
        )
        .collect()
}

/// Accounts that hold the asset, with quantities, as the asset page reads them.
pub(crate) async fn asset_holdings(
    env: &dyn AgentEnvironment,
    asset_id: &str,
) -> Result<(Vec<AssetHoldingDto>, Vec<String>), AgentToolError> {
    let accounts = env
        .account_service()
        .get_active_accounts()
        .map_err(exec_err)?;
    let names: HashMap<String, String> = accounts
        .iter()
        .map(|account| (account.id.clone(), account.name.clone()))
        .collect();
    let ids = accounts
        .iter()
        .filter(|account| account_supports_portfolio_scope(account, AccountPurpose::Holdings))
        .map(|account| account.id.clone())
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let scope = env
        .holdings_service()
        .get_asset_holdings_scope(&ids, asset_id, &env.base_currency())
        .await
        .map_err(exec_err)?;
    let holdings = scope
        .holdings
        .into_iter()
        .filter(|holding| !holding.quantity.is_zero())
        .map(|holding| AssetHoldingDto {
            account_name: names
                .get(&holding.account_id)
                .cloned()
                .unwrap_or_else(|| holding.account_id.clone()),
            account_id: holding.account_id,
            quantity: holding.quantity.to_f64().unwrap_or_default(),
        })
        .collect();
    let incomplete = scope
        .incomplete_accounts
        .into_iter()
        .map(|account| account.account_id)
        .collect();
    Ok((holdings, incomplete))
}

/// Tool to read one asset's market-data setup and price state.
pub struct GetAsset;

#[async_trait::async_trait]
impl AgentTool for GetAsset {
    fn name(&self) -> &'static str {
        "get_asset"
    }

    fn description(&self) -> &'static str {
        "Read one asset's market-data setup and price state, to find why its prices are \
         missing or wrong. Pass `assetId`, or `query` (symbol, symbol with exchange suffix such \
         as `CSPX.L`, symbol and MIC, or name; active assets only). A query that matches several \
         assets returns `candidates` instead; call again with the chosen `assetId`. Returns \
         `asset` (kind, instrument type, symbol, exchange MIC, ISIN, quote mode MARKET or MANUAL, \
         `quoteCurrency`, `preferredProvider` and per-provider `providerSymbols`), \
         `latestQuote` (date, close, currency, source, `isStale`, and `missingReason` when there \
         is none), `syncState` (provider of the last sync, last sync time, error count, and a \
         generic `lastError` when the last sync failed; the details stay in the app), `quoteSources` (stored quotes grouped by source and currency with count and \
         first and last date: rows in a currency other than `quoteCurrency` point to a wrong \
         listing or currency), and `holdings` (accounts holding it, with quantity). Reads stored \
         data only; it never calls a market data provider."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "assetId": { "type": "string", "description": "Asset id, from get_holdings, get_health_status or a previous get_asset." },
                "query": { "type": "string", "description": "Symbol, symbol with exchange suffix, symbol and MIC, or name, when the asset id is unknown." }
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
        let args: GetAssetArgs = serde_json::from_value(args)?;
        let asset_id = args
            .asset_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let query = args
            .query
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let (asset, matched_by) = match (asset_id, query) {
            (Some(_), Some(_)) | (None, None) => {
                return Err(AgentToolError::InvalidInput(
                    "Pass exactly one of assetId or query".to_string(),
                ))
            }
            (Some(id), None) => {
                let asset = env.asset_service().get_asset_by_id(id).map_err(|_| {
                    AgentToolError::InvalidInput(format!("Asset '{id}' was not found"))
                })?;
                (asset, "asset_id")
            }
            (None, Some(query)) => match resolve_active_asset_match(env.as_ref(), query)? {
                ActiveAssetResolution::Resolved(resolved) => (resolved.asset, resolved.matched_by),
                ActiveAssetResolution::Ambiguous(candidates) => {
                    let output = GetAssetOutput {
                        matched_by: None,
                        asset: None,
                        latest_quote: None,
                        sync_state: None,
                        quote_sources: Vec::new(),
                        holdings: Vec::new(),
                        incomplete_account_ids: Vec::new(),
                        candidates: candidates
                            .iter()
                            .map(|asset| asset_to_dto(asset, "candidate"))
                            .collect(),
                    };
                    return Ok(AgentToolResult {
                        content: serde_json::to_value(output)?,
                    });
                }
                ActiveAssetResolution::NotFound(query) => {
                    return Err(AgentToolError::InvalidInput(format!(
                        "Asset '{query}' was not found among active assets"
                    )))
                }
            },
        };

        let quote_service = env.quote_service();
        let latest_quote = quote_service
            .get_latest_quotes_snapshot(std::slice::from_ref(&asset.id))
            .map_err(exec_err)?
            .remove(&asset.id)
            .map(|snapshot| LatestQuoteDto {
                date: snapshot.quote_date,
                close: snapshot.quote.as_ref().and_then(|q| q.close.to_f64()),
                currency: snapshot.quote.as_ref().map(|q| q.currency.clone()),
                source: snapshot.quote.as_ref().map(|q| q.data_source.clone()),
                is_stale: snapshot.is_stale,
                effective_market_date: snapshot.effective_market_date,
                missing_reason: snapshot
                    .no_quote_reason
                    .map(|reason| MissingQuoteReasonDto {
                        code: reason.code,
                        message: redact_urls(&reason.message),
                    }),
            });
        let sync_state = quote_service
            .get_sync_state(&asset.id)
            .map_err(exec_err)?
            .map(sync_state_dto);
        let quote_sources = quote_sources(
            &quote_service
                .get_stored_quotes(&asset.id, None, None)
                .map_err(exec_err)?,
        );
        let (holdings, incomplete_account_ids) = asset_holdings(env.as_ref(), &asset.id).await?;

        let output = GetAssetOutput {
            matched_by: Some(matched_by.to_string()),
            asset: Some(asset_detail(&asset)),
            latest_quote,
            sync_state,
            quote_sources,
            holdings,
            incomplete_account_ids,
            candidates: Vec::new(),
        };
        Ok(AgentToolResult {
            content: serde_json::to_value(output)?,
        })
    }
}

// ---------------------------------------------------------------------------
// get_quote_history
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetQuoteHistoryArgs {
    pub asset_id: String,
    #[serde(default)]
    pub start_date: Option<NaiveDate>,
    #[serde(default)]
    pub end_date: Option<NaiveDate>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteRowDto {
    pub date: String,
    pub close: Option<f64>,
    pub currency: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetQuoteHistoryOutput {
    pub asset_id: String,
    pub quote_currency: String,
    pub start_date: String,
    pub end_date: String,
    /// Newest first.
    pub quotes: Vec<QuoteRowDto>,
    pub total_count: usize,
    pub truncated: bool,
}

/// Tool to read an asset's stored quotes over a date range.
pub struct GetQuoteHistory;

#[async_trait::async_trait]
impl AgentTool for GetQuoteHistory {
    fn name(&self) -> &'static str {
        "get_quote_history"
    }

    fn description(&self) -> &'static str {
        "Read an asset's stored daily quotes: date, close, currency and source (a provider \
         id, MANUAL or BROKER). Defaults to the last 365 days up to today; pass `startDate` and \
         `endDate` (YYYY-MM-DD) for another range and `source` to keep one source. Rows are \
         newest first; a day can have one row per source. At most `limit` rows (default 500, \
         max 2000) are returned, with `truncated` set when more matched. Use it to find missing \
         days or rows in the wrong currency; days without a row have no stored price. Reads \
         stored data only."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "assetId": { "type": "string", "description": "Asset id, from get_asset or get_holdings." },
                "startDate": { "type": "string", "format": "date", "description": "First day, YYYY-MM-DD. Default: 365 days before endDate." },
                "endDate": { "type": "string", "format": "date", "description": "Last day, YYYY-MM-DD. Default: today." },
                "source": { "type": "string", "description": "Only rows from this source, e.g. YAHOO or MANUAL." },
                "limit": { "type": "integer", "minimum": 1, "maximum": MAX_HISTORY_LIMIT, "description": "Most rows to return. Default 500." }
            },
            "required": ["assetId"]
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
        let args: GetQuoteHistoryArgs = serde_json::from_value(args)?;
        let end = args.end_date.unwrap_or_else(|| Utc::now().date_naive());
        let start = args
            .start_date
            .unwrap_or_else(|| end - Duration::days(DEFAULT_HISTORY_DAYS));
        if start > end {
            return Err(AgentToolError::InvalidInput(
                "startDate must not be after endDate".to_string(),
            ));
        }
        let limit = args
            .limit
            .unwrap_or(DEFAULT_HISTORY_LIMIT)
            .clamp(1, MAX_HISTORY_LIMIT);
        let asset = env
            .asset_service()
            .get_asset_by_id(args.asset_id.trim())
            .map_err(|_| {
                AgentToolError::InvalidInput(format!("Asset '{}' was not found", args.asset_id))
            })?;
        let source = args
            .source
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());

        // Every stored row, so a source that loses the per-day choice and
        // a row stored in another currency still show.
        let mut quotes = env
            .quote_service()
            .get_stored_quotes(&asset.id, Some(start), Some(end))
            .map_err(exec_err)?
            .into_iter()
            .filter(|quote| source.is_none_or(|s| quote.data_source.eq_ignore_ascii_case(s)))
            .collect::<Vec<_>>();
        quotes.sort_by(|a, b| {
            b.timestamp
                .date_naive()
                .cmp(&a.timestamp.date_naive())
                .then_with(|| a.data_source.cmp(&b.data_source))
        });
        let total_count = quotes.len();
        let rows = quotes
            .into_iter()
            .take(limit)
            .map(|quote| QuoteRowDto {
                date: date_of(&quote).to_string(),
                close: quote.close.to_f64(),
                currency: quote.currency,
                source: quote.data_source,
            })
            .collect::<Vec<_>>();

        let output = GetQuoteHistoryOutput {
            asset_id: asset.id,
            quote_currency: asset.quote_ccy,
            start_date: start.to_string(),
            end_date: end.to_string(),
            truncated: total_count > rows.len(),
            quotes: rows,
            total_count,
        };
        Ok(AgentToolResult {
            content: serde_json::to_value(output)?,
        })
    }
}

// ---------------------------------------------------------------------------
// get_market_data_providers
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketDataProviderDto {
    /// Id to use as an asset's preferred provider.
    pub id: String,
    pub name: String,
    /// `builtin` or `custom`.
    pub provider_type: String,
    pub enabled: bool,
    pub priority: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instruments: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coverage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires_api_key: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_api_key: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_synced_at: Option<String>,
    /// Recent sync errors, as the quote service's public message (stored
    /// errors stay internal).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub recent_errors: Vec<String>,
    /// Custom providers: whether they serve latest and/or historical prices.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub source_kinds: Vec<String>,
    /// Custom providers: also tried for assets not assigned to them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_as_fallback: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetMarketDataProvidersOutput {
    pub providers: Vec<MarketDataProviderDto>,
}

/// Tool to list the market data providers and their state.
pub struct GetMarketDataProviders;

#[async_trait::async_trait]
impl AgentTool for GetMarketDataProviders {
    fn name(&self) -> &'static str {
        "get_market_data_providers"
    }

    fn description(&self) -> &'static str {
        "List the market data providers: built-in ones and the user's custom providers, with \
         `id` (what an asset's preferred provider is set to; custom providers are \
         `CUSTOM:<code>`), `enabled`, `priority` (lower runs first), coverage, whether \
         an API key is needed and set, and for built-in providers asset and error counts and \
         the last sync (error details stay in the app; custom providers report none here). \
         Only enabled providers are used for syncs and lookups. Provider settings, API keys \
         and custom provider sources (URLs, headers) are not shown and cannot be changed \
         here; the user edits them in Settings > Market Data."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({ "type": "object", "properties": {}, "required": [] })
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
        _args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let builtin = env
            .quote_service()
            .get_providers_info()
            .await
            .map_err(exec_err)?;
        let mut providers = builtin
            .into_iter()
            .filter(|info| info.id != CUSTOM_DISPATCH_PROVIDER_ID)
            .map(|info| {
                let capabilities = info.capabilities.as_ref();
                MarketDataProviderDto {
                    id: info.id,
                    name: info.name,
                    provider_type: info.provider_type.unwrap_or_else(|| "builtin".to_string()),
                    enabled: info.enabled,
                    priority: info.priority,
                    description: info.description.filter(|d| !d.trim().is_empty()),
                    instruments: capabilities.map(|c| c.instruments.clone()),
                    coverage: capabilities.map(|c| c.coverage.clone()),
                    requires_api_key: Some(info.requires_api_key),
                    has_api_key: Some(info.has_api_key),
                    asset_count: Some(info.asset_count),
                    error_count: Some(info.error_count),
                    last_synced_at: info.last_synced_at,
                    recent_errors: info
                        .unique_errors
                        .iter()
                        .take(MAX_PROVIDER_ERRORS)
                        .map(|error| redact_urls(error))
                        .collect(),
                    source_kinds: Vec::new(),
                    use_as_fallback: None,
                }
            })
            .collect::<Vec<_>>();

        for custom in env.custom_providers().map_err(exec_err)? {
            let mut source_kinds = custom
                .sources
                .iter()
                .map(|source| source.kind.clone())
                .collect::<Vec<_>>();
            source_kinds.sort();
            source_kinds.dedup();
            providers.push(MarketDataProviderDto {
                id: format!("{CUSTOM_PROVIDER_PREFIX}{}", custom.id),
                name: custom.name,
                provider_type: "custom".to_string(),
                enabled: custom.enabled,
                priority: custom.priority,
                description: Some(custom.description).filter(|d| !d.trim().is_empty()),
                instruments: None,
                coverage: None,
                requires_api_key: None,
                has_api_key: None,
                asset_count: None,
                error_count: None,
                last_synced_at: None,
                recent_errors: Vec::new(),
                source_kinds,
                use_as_fallback: Some(custom.use_as_fallback),
            });
        }
        providers.sort_by_key(|provider| provider.priority);

        Ok(AgentToolResult {
            content: serde_json::to_value(GetMarketDataProvidersOutput { providers })?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use rust_decimal::Decimal;

    fn quote(day: u32, source: &str, currency: &str) -> Quote {
        let timestamp = Utc
            .with_ymd_and_hms(2026, 9, day, 12, 0, 0)
            .single()
            .expect("valid date");
        Quote {
            id: format!("{day}-{source}"),
            asset_id: "a".to_string(),
            timestamp,
            open: Decimal::ONE,
            high: Decimal::ONE,
            low: Decimal::ONE,
            close: Decimal::ONE,
            adjclose: Decimal::ONE,
            volume: Decimal::ZERO,
            currency: currency.to_string(),
            data_source: source.to_string(),
            created_at: timestamp,
            notes: None,
        }
    }

    #[test]
    fn errors_lose_their_urls() {
        assert_eq!(
            redact_urls(
                "error sending request for url (https://www.alphavantage.co/query?apikey=K) 429"
            ),
            "error sending request for url (<url> 429"
        );
        assert_eq!(
            redact_urls("GET http://x.example/a?token=T failed"),
            "GET <url> failed"
        );
        assert_eq!(redact_urls("no url here"), "no url here");
        assert_eq!(
            redact_urls("Invalid URL 'HTTPS://prices.example:bad/?apikey=SECRET'"),
            "Invalid URL '<redacted>'"
        );
        assert_eq!(
            redact_urls(
                "Invalid URL 'prices.example/private/SECRET-KEY-123': relative URL without a base"
            ),
            "Invalid URL '<redacted>': relative URL without a base"
        );
        assert_eq!(
            redact_urls(
                "Invalid URL 'prices.example/tenant's/SECRET-KEY-123': relative URL without a base"
            ),
            "Invalid URL '<redacted>': relative URL without a base"
        );
        assert_eq!(
            redact_urls("source url=prices.example/SECRET failed; urls checked: 2"),
            "source url=<redacted> failed; urls checked: 2"
        );
        assert_eq!(
            redact_urls("fetch failed: url=Https://x.example/q?s=1 status 500"),
            "fetch failed: url=<url> status 500"
        );
        assert_eq!(
            redact_urls("bad response for symbol=X&apiKey=SECRET&token=T2; Bearer abc.def"),
            "bad response for symbol=X&apiKey=<redacted>&token=<redacted>; Bearer <redacted>"
        );
        assert_eq!(redact_urls("monkey=banana"), "monkey=banana");
        assert_eq!(
            redact_urls(
                "error sending request for url (https://prices.example/tenant's/SECRET-KEY-123)"
            ),
            "error sending request for url (<url>"
        );
        assert_eq!(
            redact_urls("for url (https://prices.example/tenant',SECRET-KEY-123) 500"),
            "for url (<url> 500"
        );
        assert_eq!(
            redact_urls("for url (https://prices.example/tenant')SECRET-KEY-123) 500"),
            "for url (<url> 500"
        );
        assert_eq!(
            redact_urls("source 'https://prices.example/q?s=1', retrying"),
            "source '<url>', retrying"
        );
        assert_eq!(
            redact_urls("for url (https://prices.example/private/tenant,SECRET-KEY-123) 401"),
            "for url (<url> 401"
        );
        assert_eq!(
            redact_urls("GET https://p.example/a(b)/SECRET?x=1, retrying"),
            "GET <url> retrying"
        );
        assert_eq!(redact_urls("prix élevé: 3€"), "prix élevé: 3€");
    }

    #[test]
    fn stored_sync_errors_are_not_output() {
        let mut state = QuoteSyncState::new("a".to_string(), "YAHOO".to_string());
        state.error_count = 3;
        state.last_error =
            Some("error sending request for url (https://x.example/q?apikey=SECRET)".to_string());
        let dto = sync_state_dto(state.clone());
        assert_eq!(dto.error_count, 3);
        assert_eq!(
            dto.last_error,
            Some(PublicError::provider_unavailable().message)
        );
        state.last_error = None;
        assert_eq!(sync_state_dto(state).last_error, None);
    }

    #[test]
    fn quote_sources_group_by_source_and_currency() {
        let quotes = vec![
            quote(3, "YAHOO", "GBp"),
            quote(1, "YAHOO", "GBp"),
            quote(2, "YAHOO", "USD"),
            quote(2, "MANUAL", "USD"),
        ];
        let sources = quote_sources(&quotes);
        let summary = sources
            .iter()
            .map(|s| {
                (
                    s.source.as_str(),
                    s.currency.as_str(),
                    s.count,
                    s.first_date.as_str(),
                    s.last_date.as_str(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            summary,
            vec![
                ("MANUAL", "USD", 1, "2026-09-02", "2026-09-02"),
                ("YAHOO", "GBp", 2, "2026-09-01", "2026-09-03"),
                ("YAHOO", "USD", 1, "2026-09-02", "2026-09-02"),
            ]
        );
    }

    #[test]
    fn provider_setup_reads_custom_providers_and_symbol_overrides() {
        let mut asset = Asset {
            provider_config: Some(serde_json::json!({
                "preferred_provider": "CUSTOM_SCRAPER",
                "custom_provider_code": "my-feed"
            })),
            ..Default::default()
        };
        assert_eq!(
            preferred_provider_id(&asset).as_deref(),
            Some("CUSTOM:my-feed")
        );
        asset.provider_config = Some(serde_json::json!({
            "preferred_provider": "YAHOO",
            "overrides": {
                "YAHOO": { "type": "equity_symbol", "symbol": "CSPX.L" },
                "ALPHA_VANTAGE": { "type": "fx_pair", "from": "EUR", "to": "USD" },
                "BOERSE_FRANKFURT": { "type": "bond_isin", "isin": "DE0001102580" }
            }
        }));
        assert_eq!(preferred_provider_id(&asset).as_deref(), Some("YAHOO"));
        assert_eq!(
            provider_symbols(&asset),
            BTreeMap::from([
                ("ALPHA_VANTAGE".to_string(), "EUR/USD".to_string()),
                ("BOERSE_FRANKFURT".to_string(), "DE0001102580".to_string()),
                ("YAHOO".to_string(), "CSPX.L".to_string()),
            ])
        );
        asset.provider_config = None;
        assert_eq!(preferred_provider_id(&asset), None);
    }

    #[test]
    fn get_asset_takes_exactly_one_selector() {
        for args in [
            serde_json::json!({}),
            serde_json::json!({ "assetId": "a", "query": "b" }),
            serde_json::json!({ "assetId": " ", "query": "" }),
        ] {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .build()
                .expect("runtime");
            let result = runtime.block_on(GetAsset.call(Arc::new(NoServices), args));
            assert!(matches!(result, Err(AgentToolError::InvalidInput(_))));
        }
    }

    /// Fails the test if a tool reaches any service.
    struct NoServices;

    #[async_trait::async_trait]
    impl AgentEnvironment for NoServices {
        crate::tools::test_support::unreachable_services!();
    }
}
