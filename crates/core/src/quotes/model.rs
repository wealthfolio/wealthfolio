//! Quote domain models.
//!
//! This module contains the core data structures for representing market quotes,
//! quote summaries (search results), and data source information.

use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

// =============================================================================
// Quote
// =============================================================================

/// A market quote representing price data for a financial instrument at a point in time.
///
/// This is the core data structure for storing historical and real-time price data.
/// Each quote contains OHLCV (Open, High, Low, Close, Volume) data along with
/// metadata about when and where the data came from.
///
/// # Fields
///
/// * `id` - Unique identifier for the quote (typically `{asset_id}_{date}_{source}`)
/// * `asset_id` - Canonical asset identifier (e.g., "SEC:AAPL:XNAS", "CRYPTO:BTC:USD")
/// * `timestamp` - The date/time this quote represents
/// * `open`, `high`, `low`, `close` - Standard OHLC price data
/// * `adjclose` - Split and dividend adjusted closing price
/// * `volume` - Trading volume for the period
/// * `currency` - The currency of the price data (e.g., "USD", "EUR")
/// * `data_source` - Where this quote data came from
/// * `created_at` - When this record was created in the database
/// * `notes` - Optional user notes (for manual entries)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    pub id: String,
    pub asset_id: String,
    pub timestamp: DateTime<Utc>,
    pub open: Decimal,
    pub high: Decimal,
    pub low: Decimal,
    pub close: Decimal,
    pub adjclose: Decimal,
    pub volume: Decimal,
    pub currency: String,
    pub data_source: String,
    pub created_at: DateTime<Utc>,
    pub notes: Option<String>,
}

// =============================================================================
// Symbol Search Result
// =============================================================================

/// Result from a symbol/ticker search operation.
///
/// This is returned from symbol search operations and provides basic
/// identifying information about a financial instrument. Enhanced with
/// canonical exchange MIC codes and existing asset merging.
///
/// # Fields
///
/// * `symbol` - The ticker symbol (e.g., "AAPL", "SHOP.TO")
/// * `short_name` - Short display name (e.g., "Apple Inc.")
/// * `long_name` - Full legal name
/// * `exchange` - Exchange code from provider (e.g., "NASDAQ", "TOR")
/// * `exchange_mic` - Canonical MIC code (e.g., "XNAS", "XTSE")
/// * `exchange_name` - Friendly exchange name (e.g., "NASDAQ", "TSX")
/// * `quote_type` - Type of instrument (e.g., "EQUITY", "ETF", "CRYPTOCURRENCY")
/// * `type_display` - Human-readable type display
/// * `currency` - Trading currency (e.g., "USD", "CAD")
/// * `data_source` - Data source provider (e.g., "YAHOO", "MANUAL")
/// * `quote_mode` - Pricing mode (e.g., "MARKET", "MANUAL")
/// * `is_existing` - True if this asset already exists in user's database
/// * `existing_asset_id` - The ID if asset exists (e.g., "SEC:AAPL:XNAS")
/// * `index` - Index membership if applicable
/// * `score` - Relevance score from search
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SymbolSearchResult {
    pub symbol: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canonical_symbol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canonical_exchange_mic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_symbol: Option<String>,
    pub short_name: String,
    pub long_name: String,
    pub exchange: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exchange_mic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exchange_name: Option<String>,
    pub quote_type: String,
    pub type_display: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub currency_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quote_mode: Option<String>,
    #[serde(default)]
    pub is_existing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub existing_asset_id: Option<String>,
    /// Set by the search on an existing asset it found as exactly what the
    /// query names (its symbol on the query's exchange, a provider alias, or
    /// the listing an exact provider result points to), as opposed to one whose
    /// symbol or name merely contains the query.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub exact_match: bool,
    pub index: String,
    pub score: f64,
}

// =============================================================================
// Latest Quote Pair
// =============================================================================

/// A pair of quotes representing the latest and previous trading day quotes.
///
/// This is useful for calculating daily changes and displaying current vs previous values.
///
/// # Fields
///
/// * `latest` - The most recent quote for the symbol
/// * `previous` - The quote from the previous trading day (if available)
#[derive(Clone, Debug)]
pub struct LatestQuotePair {
    pub latest: Quote,
    pub previous: Option<Quote>,
}

/// Result from resolving a symbol's latest quote (currency, price, and provider).
///
/// Used during symbol selection to confirm inferred currency and pre-fill price.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedQuote {
    pub currency: Option<String>,
    pub price: Option<Decimal>,
    pub resolved_provider_id: Option<String>,
}

/// Result of an explicitly requested provider-history replacement.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetProviderHistoryResult {
    pub asset_id: String,
    pub source: String,
    pub from_date: String,
    pub to_date: String,
    pub inserted_count: usize,
    pub deleted_count: usize,
}

/// Per-asset results of an explicitly requested global provider-history reset.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResetAllProviderHistoryResult {
    pub results: Vec<ResetProviderHistoryResult>,
    pub failures: Vec<ProviderHistoryResetFailure>,
    pub skipped: Vec<ProviderHistoryResetSkipped>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderHistoryResetFailure {
    pub asset_id: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderHistoryResetSkipped {
    pub asset_id: String,
    pub reason: String,
}

/// Configuration captured before a destructive replacement fetch.
#[derive(Debug, Clone)]
pub struct ProviderHistoryResetContext {
    pub asset: crate::assets::Asset,
    pub fingerprint: String,
    pub earliest_provider_date: Option<chrono::NaiveDate>,
    pub provider_configuration: Vec<(String, i32)>,
}

impl ProviderHistoryResetContext {
    pub fn ensure_eligible(&self) -> crate::errors::Result<()> {
        if let Some(reason) = super::sync::asset_skip_reason(&self.asset, true) {
            return Err(crate::errors::Error::Asset(format!(
                "Cannot reset provider history: {reason:?}"
            )));
        }
        Ok(())
    }
}
