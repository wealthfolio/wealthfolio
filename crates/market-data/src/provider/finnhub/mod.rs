//! Finnhub market data provider implementation.
//!
//! This module provides market data from Finnhub API:
//! - Equities via /quote endpoint (real-time only, historical candles are premium)
//! - Symbol search via /search endpoint
//! - Company profiles via /stock/profile2 endpoint
//!
//! Finnhub free tier: 60 API calls/minute, US stocks only, no historical candles.
//! API documentation: https://finnhub.io/docs/api

use std::time::Duration;

use crate::SymbolResolver;
use async_trait::async_trait;
use chrono::{DateTime, TimeZone, Utc};
use log::{debug, warn};
use reqwest::Client;
use rust_decimal::Decimal;
use serde::Deserialize;

use crate::errors::MarketDataError;
use crate::models::{
    AssetProfile, Coverage, DividendEvent, InstrumentKind, ProviderInstrument, Quote, QuoteContext,
    SearchResult,
};
use crate::provider::{MarketDataProvider, ProviderCapabilities, RateLimit};
use crate::resolver::yahoo_suffix_to_mic;
use crate::resolver::ResolverChain;

const BASE_URL: &str = "https://finnhub.io/api/v1";
const PROVIDER_ID: &str = "FINNHUB";

// ============================================================================
// API Response Structures
// ============================================================================

/// Response from /quote endpoint
#[derive(Debug, Deserialize)]
struct QuoteResponse {
    /// Current price
    c: Option<f64>,
    /// High price of the day
    h: Option<f64>,
    /// Low price of the day
    l: Option<f64>,
    /// Open price of the day
    o: Option<f64>,
    /// Timestamp (Unix)
    t: Option<i64>,
    // Note: d (change), dp (percent change), pc (previous close) exist but not used
}

/// Response from /stock/candle endpoint
#[derive(Debug, Deserialize)]
struct CandleResponse {
    /// Status: "ok" or "no_data"
    s: String,
    /// Close prices
    #[serde(default)]
    c: Vec<f64>,
    /// High prices
    #[serde(default)]
    h: Vec<f64>,
    /// Low prices
    #[serde(default)]
    l: Vec<f64>,
    /// Open prices
    #[serde(default)]
    o: Vec<f64>,
    /// Volume
    #[serde(default)]
    v: Vec<f64>,
    /// Timestamps (Unix)
    #[serde(default)]
    t: Vec<i64>,
}

/// Response from /search endpoint
#[derive(Debug, Deserialize)]
struct SearchResponse {
    /// Search results
    result: Vec<SearchItem>,
    // Note: count field exists but we use result.len() instead
}

/// Individual search result item
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchItem {
    /// Full description/name
    description: String,
    /// Display symbol
    #[allow(dead_code)]
    display_symbol: String,
    /// Symbol for API calls
    symbol: String,
    /// Security type (e.g., "Common Stock", "ETF")
    #[serde(rename = "type")]
    security_type: String,
}

/// Response from /stock/dividend2 endpoint.
#[derive(Debug, Deserialize)]
struct DividendsResponse {
    #[serde(default)]
    data: Vec<FinnhubDividend>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FinnhubDividend {
    amount: f64,
    ex_date: String,
}

/// Response from /stock/profile2 endpoint
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileResponse {
    /// Company name
    name: Option<String>,
    /// Stock ticker
    ticker: Option<String>,
    /// Company description
    #[serde(default)]
    description: Option<String>,
    /// Finnhub industry classification
    finnhub_industry: Option<String>,
    /// Country
    country: Option<String>,
    /// Company website
    weburl: Option<String>,
    /// Logo URL
    logo: Option<String>,
    /// Market capitalization (in millions)
    market_capitalization: Option<f64>,
    /// Number of employees
    employee_total: Option<i64>,
    // Note: exchange, currency, ipo, share_outstanding, phone fields exist but not mapped to AssetProfile
}

/// Error response from Finnhub
#[derive(Debug, Deserialize)]
struct ErrorResponse {
    error: Option<String>,
}

// ============================================================================
// FinnhubProvider
// ============================================================================

/// Finnhub market data provider.
///
/// Supports equities with global coverage for major exchanges.
/// Free tier is limited to 60 API calls per minute.
pub struct FinnhubProvider {
    client: Client,
    api_key: String,
}

impl FinnhubProvider {
    /// Create a new Finnhub provider with the given API key.
    pub fn new(api_key: String) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| Client::new());

        Self { client, api_key }
    }

    /// Make a GET request to the Finnhub API.
    async fn fetch(
        &self,
        endpoint: &str,
        params: &[(&str, &str)],
    ) -> Result<String, MarketDataError> {
        let url = format!("{}{}", BASE_URL, endpoint);

        let mut request = self.client.get(&url);

        // Add API key as header (more secure than query param)
        request = request.header("X-Finnhub-Token", &self.api_key);

        // Add query parameters
        for (key, value) in params {
            request = request.query(&[(key, value)]);
        }

        debug!("Finnhub request: {} with {} params", endpoint, params.len());

        let response = request.send().await.map_err(|e| {
            if e.is_timeout() {
                MarketDataError::Timeout {
                    provider: PROVIDER_ID.to_string(),
                }
            } else {
                MarketDataError::ProviderError {
                    provider: PROVIDER_ID.to_string(),
                    message: format!("Request failed: {}", e),
                }
            }
        })?;

        let status = response.status();
        debug!("Finnhub response status: {} for {}", status, endpoint);

        // Handle rate limiting (HTTP 429)
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let body = response.text().await.unwrap_or_default();
            warn!("Finnhub rate limited (HTTP 429): {}", body);
            return Err(MarketDataError::RateLimited {
                provider: PROVIDER_ID.to_string(),
            });
        }

        // Handle unauthorized (invalid API key)
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: "Invalid or missing API key".to_string(),
            });
        }

        // Handle forbidden - typically means invalid API key or access denied
        if status == reqwest::StatusCode::FORBIDDEN {
            let body = response.text().await.unwrap_or_default();
            warn!("Finnhub 403 Forbidden response: {}", body);
            return Err(MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("Access forbidden - check API key: {}", body),
            });
        }

        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();

            // Try to parse error message
            if let Ok(error_resp) = serde_json::from_str::<ErrorResponse>(&body) {
                if let Some(error_msg) = error_resp.error {
                    return Err(MarketDataError::ProviderError {
                        provider: PROVIDER_ID.to_string(),
                        message: error_msg,
                    });
                }
            }

            return Err(MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("HTTP {} - {}", status, body),
            });
        }

        response
            .text()
            .await
            .map_err(|e| MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("Failed to read response: {}", e),
            })
    }

    /// Extract the symbol string from a ProviderInstrument.
    fn extract_symbol(&self, instrument: &ProviderInstrument) -> Result<String, MarketDataError> {
        match instrument {
            ProviderInstrument::EquitySymbol { symbol } => Ok(symbol.to_string()),
            ProviderInstrument::CryptoSymbol { symbol } => {
                // Finnhub uses BINANCE:BTCUSDT format for crypto
                if symbol.contains(':') {
                    Ok(symbol.to_string())
                } else {
                    Ok(format!("BINANCE:{}USDT", symbol))
                }
            }
            ProviderInstrument::CryptoPair { symbol, market } => {
                Ok(format!("BINANCE:{}{}", symbol, market))
            }
            ProviderInstrument::FxPair { from, to } => {
                // Finnhub uses OANDA:EUR_USD format for forex
                Ok(format!("OANDA:{}_{}", from, to))
            }
            ProviderInstrument::FxSymbol { symbol } => {
                // Try to parse and format
                if symbol.len() == 6 {
                    let from = &symbol[..3];
                    let to = &symbol[3..];
                    Ok(format!("OANDA:{}_{}", from, to))
                } else {
                    Ok(symbol.to_string())
                }
            }
            ProviderInstrument::MetalSymbol { .. } => Err(MarketDataError::UnsupportedAssetType(
                "Finnhub does not support metals directly".to_string(),
            )),
            ProviderInstrument::BondIsin { .. } => Err(MarketDataError::UnsupportedAssetType(
                "Finnhub does not support bonds directly".to_string(),
            )),
        }
    }

    /// Get the currency: prefer exchange metadata, fall back to asset's quote_ccy.
    fn get_currency(&self, context: &QuoteContext) -> String {
        let chain = ResolverChain::new();
        chain
            .get_currency(&PROVIDER_ID.into(), context)
            .or_else(|| context.currency_hint.clone())
            .map(|c| c.to_string())
            .unwrap_or_else(|| "USD".to_string())
    }

    /// Fetch latest quote from /quote endpoint.
    async fn fetch_latest_quote(
        &self,
        symbol: &str,
        currency: &str,
    ) -> Result<Quote, MarketDataError> {
        let params = [("symbol", symbol)];
        let text = self.fetch("/quote", &params).await?;

        let response: QuoteResponse =
            serde_json::from_str(&text).map_err(|e| MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("Failed to parse quote response: {}", e),
            })?;

        // Check if we got valid data
        let close = response.c.ok_or_else(|| {
            MarketDataError::SymbolNotFound(format!("No quote data for symbol: {}", symbol))
        })?;

        // Finnhub returns 0 for unknown symbols instead of an error
        if close == 0.0 && response.o.unwrap_or(0.0) == 0.0 {
            return Err(MarketDataError::SymbolNotFound(format!(
                "Symbol not found or no trading data: {}",
                symbol
            )));
        }

        let timestamp = response
            .t
            .and_then(|ts| Utc.timestamp_opt(ts, 0).single())
            .unwrap_or_else(Utc::now);

        let close_decimal =
            Decimal::try_from(close).map_err(|_| MarketDataError::ValidationFailed {
                message: format!("Invalid close price: {}", close),
            })?;

        Ok(Quote {
            timestamp,
            open: response.o.and_then(|v| Decimal::try_from(v).ok()),
            high: response.h.and_then(|v| Decimal::try_from(v).ok()),
            low: response.l.and_then(|v| Decimal::try_from(v).ok()),
            close: close_decimal,
            volume: None, // /quote endpoint doesn't provide volume
            currency: currency.to_string(),
            source: PROVIDER_ID.to_string(),
        })
    }

    /// Fetch historical quotes from /stock/candle endpoint.
    async fn fetch_historical_quotes(
        &self,
        symbol: &str,
        currency: &str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<Quote>, MarketDataError> {
        let from_ts = start.timestamp().to_string();
        let to_ts = end.timestamp().to_string();

        let params = [
            ("symbol", symbol),
            ("resolution", "D"), // Daily candles
            ("from", &from_ts),
            ("to", &to_ts),
        ];

        let text = self.fetch("/stock/candle", &params).await?;

        let response: CandleResponse =
            serde_json::from_str(&text).map_err(|e| MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("Failed to parse candle response: {}", e),
            })?;

        // Check response status
        if response.s == "no_data" {
            return Err(MarketDataError::NoDataForRange);
        }

        if response.s != "ok" {
            return Err(MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("Unexpected candle status: {}", response.s),
            });
        }

        // Validate array lengths match
        let len = response.t.len();
        if response.c.len() != len
            || response.o.len() != len
            || response.h.len() != len
            || response.l.len() != len
        {
            return Err(MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: "Mismatched array lengths in candle response".to_string(),
            });
        }

        if len == 0 {
            return Err(MarketDataError::NoDataForRange);
        }

        let mut quotes = Vec::with_capacity(len);

        for i in 0..len {
            let timestamp = match Utc.timestamp_opt(response.t[i], 0).single() {
                Some(ts) => ts,
                None => {
                    warn!("Invalid timestamp at index {}: {}", i, response.t[i]);
                    continue;
                }
            };

            let close = match Decimal::try_from(response.c[i]) {
                Ok(d) => d,
                Err(_) => {
                    warn!("Invalid close price at index {}: {}", i, response.c[i]);
                    continue;
                }
            };

            let open = Decimal::try_from(response.o[i]).ok();
            let high = Decimal::try_from(response.h[i]).ok();
            let low = Decimal::try_from(response.l[i]).ok();
            let volume = response.v.get(i).and_then(|&v| Decimal::try_from(v).ok());

            quotes.push(Quote {
                timestamp,
                open,
                high,
                low,
                close,
                volume,
                currency: currency.to_string(),
                source: PROVIDER_ID.to_string(),
            });
        }

        // Sort by timestamp ascending
        quotes.sort_by_key(|a| a.timestamp);

        debug!(
            "Finnhub: fetched {} historical quotes for {} ({} to {})",
            quotes.len(),
            symbol,
            start.format("%Y-%m-%d"),
            end.format("%Y-%m-%d")
        );

        Ok(quotes)
    }

    /// Fetch cash dividends from /stock/dividend2 endpoint.
    async fn fetch_dividends(
        &self,
        symbol: &str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<DividendEvent>, MarketDataError> {
        let params = [("symbol", symbol)];
        let text = self.fetch("/stock/dividend2", &params).await?;

        let response: DividendsResponse =
            serde_json::from_str(&text).map_err(|e| MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("Failed to parse dividends response: {}", e),
            })?;

        let mut dividends: Vec<DividendEvent> = response
            .data
            .into_iter()
            .filter_map(|d| {
                let date = chrono::NaiveDate::parse_from_str(&d.ex_date, "%Y-%m-%d").ok()?;
                let timestamp = Utc.from_utc_datetime(&date.and_hms_opt(0, 0, 0)?);
                if timestamp < start || timestamp > end {
                    return None;
                }
                Some(DividendEvent {
                    amount: d.amount,
                    date: timestamp.timestamp(),
                })
            })
            .collect();

        dividends.sort_by_key(|d| d.date);
        Ok(dividends)
    }

    /// Fetch company profile from /stock/profile2 endpoint.
    async fn fetch_profile(&self, symbol: &str) -> Result<AssetProfile, MarketDataError> {
        let params = [("symbol", symbol)];
        let text = self.fetch("/stock/profile2", &params).await?;

        // Check for empty response (symbol not found)
        if text.trim() == "{}" {
            return Err(MarketDataError::SymbolNotFound(format!(
                "No profile data for symbol: {}",
                symbol
            )));
        }

        let response: ProfileResponse =
            serde_json::from_str(&text).map_err(|e| MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("Failed to parse profile response: {}", e),
            })?;

        // Check if we got meaningful data
        if response.name.is_none() && response.ticker.is_none() {
            return Err(MarketDataError::SymbolNotFound(format!(
                "No profile data for symbol: {}",
                symbol
            )));
        }

        Ok(AssetProfile {
            source: Some(PROVIDER_ID.to_string()),
            name: response.name,
            quote_type: Some("EQUITY".to_string()), // Finnhub only supports equities
            sector: response.finnhub_industry.clone(),
            sectors: None, // Finnhub doesn't provide weighted sectors
            asset_allocation: None,
            industry: response.finnhub_industry,
            website: response.weburl,
            description: response.description,
            country: response.country,
            employees: response.employee_total.map(|e| e as u64),
            logo_url: response.logo,
            market_cap: response.market_capitalization.map(|mc| mc * 1_000_000.0), // Finnhub returns in millions
            pe_ratio: None, // Not available in profile endpoint
            dividend_yield: None,
            week_52_high: None,
            week_52_low: None,
            isin: None,
        })
    }

    /// Search for symbols.
    async fn search_symbols(&self, query: &str) -> Result<Vec<SearchResult>, MarketDataError> {
        let params = [("q", query)];
        let text = self.fetch("/search", &params).await?;

        let response: SearchResponse =
            serde_json::from_str(&text).map_err(|e| MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("Failed to parse search response: {}", e),
            })?;

        let results: Vec<SearchResult> = response
            .result
            .into_iter()
            .map(|item| {
                let asset_type = map_security_type(&item.security_type);
                let mut result =
                    SearchResult::new(&item.symbol, &item.description, "", &asset_type)
                        .with_data_source(PROVIDER_ID);
                // Derive MIC from Finnhub symbol suffix (same convention as Yahoo)
                if let Some(dot_pos) = item.symbol.rfind('.') {
                    let suffix = &item.symbol[dot_pos + 1..];
                    if let Some(mic) = yahoo_suffix_to_mic(suffix) {
                        result = result.with_exchange_mic(mic);
                    }
                }
                result
            })
            .collect();

        debug!(
            "Finnhub: found {} search results for '{}'",
            results.len(),
            query
        );

        Ok(results)
    }
}

// ============================================================================
// MarketDataProvider Implementation
// ============================================================================

#[async_trait]
impl MarketDataProvider for FinnhubProvider {
    fn id(&self) -> &'static str {
        PROVIDER_ID
    }

    fn priority(&self) -> u8 {
        // Medium priority - good alternative to Yahoo
        2
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            // Finnhub primarily supports equities, but also has crypto/forex
            instrument_kinds: &[InstrumentKind::Equity],
            // Global coverage for major exchanges (free tier = US only)
            coverage: Coverage::global_best_effort(),
            supports_latest: true,
            // Historical candles require premium subscription
            supports_historical: true,
            supports_search: true,
            supports_profile: true,
            supports_dividends: true,
        }
    }

    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_minute: 60, // Free tier limit
            max_concurrency: 5,
            min_delay: Duration::from_millis(100),
        }
    }

    async fn get_latest_quote(
        &self,
        context: &QuoteContext,
        instrument: ProviderInstrument,
    ) -> Result<Quote, MarketDataError> {
        let symbol = self.extract_symbol(&instrument)?;
        let currency = self.get_currency(context);

        debug!("Fetching latest quote for {} from Finnhub", symbol);

        self.fetch_latest_quote(&symbol, &currency).await
    }

    async fn get_historical_quotes(
        &self,
        context: &QuoteContext,
        instrument: ProviderInstrument,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<Quote>, MarketDataError> {
        let symbol = self.extract_symbol(&instrument)?;
        let currency = self.get_currency(context);

        debug!(
            "Fetching historical quotes for {} from {} to {} from Finnhub",
            symbol,
            start.format("%Y-%m-%d"),
            end.format("%Y-%m-%d")
        );

        let quotes = self
            .fetch_historical_quotes(&symbol, &currency, start, end)
            .await?;

        if quotes.is_empty() {
            return Err(MarketDataError::NoDataForRange);
        }

        Ok(quotes)
    }

    async fn get_dividends(
        &self,
        _context: &QuoteContext,
        instrument: ProviderInstrument,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<DividendEvent>, MarketDataError> {
        let symbol = match instrument {
            ProviderInstrument::EquitySymbol { symbol } => symbol.to_string(),
            _ => {
                return Err(MarketDataError::NotSupported {
                    operation: "dividends".to_string(),
                    provider: PROVIDER_ID.to_string(),
                });
            }
        };

        self.fetch_dividends(&symbol, start, end).await
    }

    async fn search(&self, query: &str) -> Result<Vec<SearchResult>, MarketDataError> {
        debug!("Searching Finnhub for '{}'", query);
        self.search_symbols(query).await
    }

    async fn get_profile(&self, symbol: &str) -> Result<AssetProfile, MarketDataError> {
        debug!("Fetching profile for {} from Finnhub", symbol);
        self.fetch_profile(symbol).await
    }
}

// ============================================================================
// Helper Functions
// ============================================================================

/// Map Finnhub security type to our asset type.
fn map_security_type(finnhub_type: &str) -> String {
    match finnhub_type.to_lowercase().as_str() {
        "common stock" | "stock" => "Stock".to_string(),
        "etf" | "etp" => "ETF".to_string(),
        "mutual fund" | "fund" => "Mutual Fund".to_string(),
        "adr" | "american depositary receipt" => "ADR".to_string(),
        "reit" => "REIT".to_string(),
        "warrant" => "Warrant".to_string(),
        "preferred stock" | "preferred" => "Preferred Stock".to_string(),
        "unit" => "Unit".to_string(),
        "closed-end fund" => "Closed-End Fund".to_string(),
        _ => finnhub_type.to_string(),
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::borrow::Cow;
    use std::sync::Arc;

    fn create_test_fx_context(
        currency_hint: Option<&'static str>,
        quote: &'static str,
    ) -> QuoteContext {
        use crate::models::InstrumentId;

        QuoteContext {
            instrument: InstrumentId::Fx {
                base: Cow::Borrowed("EUR"),
                quote: Cow::Borrowed(quote),
            },
            identifiers: Default::default(),
            overrides: None,
            currency_hint: currency_hint.map(Cow::Borrowed),
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        }
    }

    #[test]
    fn test_provider_id() {
        let provider = FinnhubProvider::new("test_key".to_string());
        assert_eq!(provider.id(), "FINNHUB");
    }

    #[test]
    fn test_provider_priority() {
        let provider = FinnhubProvider::new("test_key".to_string());
        assert_eq!(provider.priority(), 2);
    }

    #[test]
    fn test_provider_capabilities() {
        let provider = FinnhubProvider::new("test_key".to_string());
        let caps = provider.capabilities();
        assert!(caps.instrument_kinds.contains(&InstrumentKind::Equity));
        assert!(caps.supports_latest);
        assert!(caps.supports_historical);
        assert!(caps.supports_search);
        assert!(caps.supports_profile);
        assert!(caps.supports_dividends);
    }

    #[test]
    fn test_rate_limit() {
        let provider = FinnhubProvider::new("test_key".to_string());
        let limit = provider.rate_limit();
        assert_eq!(limit.requests_per_minute, 60);
        assert_eq!(limit.max_concurrency, 5);
        assert_eq!(limit.min_delay, Duration::from_millis(100));
    }

    #[test]
    fn test_get_currency_prefers_resolver_over_hint() {
        let provider = FinnhubProvider::new("test_key".to_string());
        // FX resolver returns the quote currency ("CAD"), which takes priority over hint
        let context = create_test_fx_context(Some("TWD"), "CAD");
        assert_eq!(provider.get_currency(&context), "CAD");
    }

    #[test]
    fn test_get_currency_falls_back_to_resolver_when_hint_missing() {
        let provider = FinnhubProvider::new("test_key".to_string());
        let context = create_test_fx_context(None, "CAD");
        assert_eq!(provider.get_currency(&context), "CAD");
    }

    #[test]
    fn test_extract_symbol_equity() {
        let provider = FinnhubProvider::new("test_key".to_string());
        let instrument = ProviderInstrument::EquitySymbol {
            symbol: Arc::from("AAPL"),
        };
        let symbol = provider.extract_symbol(&instrument).unwrap();
        assert_eq!(symbol, "AAPL");
    }

    #[test]
    fn test_extract_symbol_crypto_pair() {
        let provider = FinnhubProvider::new("test_key".to_string());
        let instrument = ProviderInstrument::CryptoPair {
            symbol: Arc::from("BTC"),
            market: Cow::Borrowed("USDT"),
        };
        let symbol = provider.extract_symbol(&instrument).unwrap();
        assert_eq!(symbol, "BINANCE:BTCUSDT");
    }

    #[test]
    fn test_extract_symbol_fx_pair() {
        let provider = FinnhubProvider::new("test_key".to_string());
        let instrument = ProviderInstrument::FxPair {
            from: Cow::Borrowed("EUR"),
            to: Cow::Borrowed("USD"),
        };
        let symbol = provider.extract_symbol(&instrument).unwrap();
        assert_eq!(symbol, "OANDA:EUR_USD");
    }

    #[test]
    fn test_map_security_type() {
        assert_eq!(map_security_type("Common Stock"), "Stock");
        assert_eq!(map_security_type("ETF"), "ETF");
        assert_eq!(map_security_type("Mutual Fund"), "Mutual Fund");
        assert_eq!(map_security_type("ADR"), "ADR");
        assert_eq!(map_security_type("Unknown Type"), "Unknown Type");
    }

    #[test]
    fn test_quote_response_parsing() {
        let json = r#"{
            "c": 150.25,
            "d": 1.50,
            "dp": 1.01,
            "h": 152.00,
            "l": 148.50,
            "o": 149.00,
            "pc": 148.75,
            "t": 1704067200
        }"#;

        let response: QuoteResponse = serde_json::from_str(json).unwrap();
        assert_eq!(response.c, Some(150.25));
        assert_eq!(response.o, Some(149.00));
        assert_eq!(response.h, Some(152.00));
        assert_eq!(response.l, Some(148.50));
    }

    #[test]
    fn test_candle_response_parsing() {
        let json = r#"{
            "s": "ok",
            "c": [150.0, 151.0, 152.0],
            "h": [151.0, 152.0, 153.0],
            "l": [149.0, 150.0, 151.0],
            "o": [149.5, 150.5, 151.5],
            "v": [1000000, 1100000, 1200000],
            "t": [1704067200, 1704153600, 1704240000]
        }"#;

        let response: CandleResponse = serde_json::from_str(json).unwrap();
        assert_eq!(response.s, "ok");
        assert_eq!(response.c.len(), 3);
        assert_eq!(response.t.len(), 3);
    }

    #[test]
    fn test_candle_response_no_data() {
        let json = r#"{"s": "no_data"}"#;

        let response: CandleResponse = serde_json::from_str(json).unwrap();
        assert_eq!(response.s, "no_data");
        assert!(response.c.is_empty());
    }

    #[test]
    fn test_search_response_parsing() {
        let json = r#"{
            "count": 2,
            "result": [
                {
                    "description": "Apple Inc",
                    "displaySymbol": "AAPL",
                    "symbol": "AAPL",
                    "type": "Common Stock"
                },
                {
                    "description": "Apple Hospitality REIT Inc",
                    "displaySymbol": "APLE",
                    "symbol": "APLE",
                    "type": "REIT"
                }
            ]
        }"#;

        let response: SearchResponse = serde_json::from_str(json).unwrap();
        assert_eq!(response.result.len(), 2);
        assert_eq!(response.result[0].symbol, "AAPL");
        assert_eq!(response.result[0].security_type, "Common Stock");
    }

    #[test]
    fn test_profile_response_parsing() {
        let json = r#"{
            "name": "Apple Inc",
            "ticker": "AAPL",
            "exchange": "NASDAQ NMS - GLOBAL MARKET",
            "currency": "USD",
            "finnhubIndustry": "Technology",
            "country": "US",
            "weburl": "https://www.apple.com/",
            "logo": "https://static.finnhub.io/logo/aapl.png",
            "marketCapitalization": 2800000,
            "shareOutstanding": 15550
        }"#;

        // Note: JSON includes extra fields (exchange, currency, shareOutstanding) that we don't parse
        let response: ProfileResponse = serde_json::from_str(json).unwrap();
        assert_eq!(response.name, Some("Apple Inc".to_string()));
        assert_eq!(response.ticker, Some("AAPL".to_string()));
        assert_eq!(response.finnhub_industry, Some("Technology".to_string()));
        assert_eq!(response.country, Some("US".to_string()));
        assert_eq!(response.weburl, Some("https://www.apple.com/".to_string()));
        // Market cap in millions
        assert_eq!(response.market_capitalization, Some(2800000.0));
    }
}
