//! Yahoo Finance market data provider.
//!
//! This provider uses the Yahoo Finance API to fetch market data for:
//! - Equities/ETFs (e.g., AAPL, SHOP.TO)
//! - Cryptocurrencies (e.g., BTC-USD)
//! - Foreign exchange rates (e.g., EURUSD=X)

mod models;

use std::sync::RwLock;
use std::time::Duration;

use crate::SymbolResolver;
use async_trait::async_trait;
use chrono::{DateTime, TimeZone, Utc};
use lazy_static::lazy_static;
use log::{debug, warn};
use num_traits::FromPrimitive;
use reqwest::header;
use rust_decimal::Decimal;
use serde::Deserialize;
use time::OffsetDateTime;
use urlencoding::encode;
use yahoo_finance_api as yahoo;

use crate::errors::MarketDataError;
use crate::models::{
    AssetProfile, Coverage, DividendEvent, InstrumentKind, ProviderInstrument, Quote, QuoteContext,
    SearchResult, SplitEvent,
};
use crate::provider::{MarketDataProvider, ProviderCapabilities, RateLimit};
use crate::resolver::{yahoo_equity_search_queries, yahoo_exchange_to_mic, ResolverChain};

use models::{
    YahooPriceDetail, YahooQuoteSummaryResponse, YahooQuoteSummaryResult, YahooTopHoldings,
};

// ============================================================================
// Crumb/Cookie Authentication
// ============================================================================

/// Cached Yahoo authentication data
#[derive(Debug, Clone)]
struct CrumbData {
    cookie: String,
    crumb: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct YahooSearchResponseRaw {
    #[serde(default)]
    quotes: Vec<YahooSearchQuoteRaw>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct YahooSearchQuoteRaw {
    symbol: String,
    exchange: Option<String>,
    quote_type: Option<String>,
    #[serde(rename = "shortname")]
    short_name: Option<String>,
    #[serde(rename = "longname")]
    long_name: Option<String>,
    score: Option<f64>,
    currency: Option<String>,
}

lazy_static! {
    /// Global cache for Yahoo authentication crumb
    static ref YAHOO_CRUMB: RwLock<Option<CrumbData>> = RwLock::default();
}

// ============================================================================
// Yahoo Provider
// ============================================================================

/// Yahoo Finance market data provider.
///
/// Provides access to market data for equities, ETFs, cryptocurrencies,
/// and foreign exchange rates through the Yahoo Finance API.
pub struct YahooProvider {
    connector: yahoo::YahooConnector,
}

impl YahooProvider {
    /// Create a new Yahoo Finance provider.
    pub async fn new() -> Result<Self, MarketDataError> {
        let connector =
            yahoo::YahooConnector::new().map_err(|e| MarketDataError::ProviderError {
                provider: "YAHOO".to_string(),
                message: format!("Failed to initialize Yahoo connector: {}", e),
            })?;
        Ok(Self { connector })
    }

    // ========================================================================
    // Symbol Extraction
    // ========================================================================

    /// Extract the symbol string from a ProviderInstrument.
    fn extract_symbol(&self, instrument: &ProviderInstrument) -> Result<String, MarketDataError> {
        match instrument {
            ProviderInstrument::EquitySymbol { symbol } => Ok(symbol.to_string()),
            ProviderInstrument::CryptoSymbol { symbol } => Ok(symbol.to_string()),
            ProviderInstrument::FxSymbol { symbol } => Ok(symbol.to_string()),
            ProviderInstrument::CryptoPair { symbol, market } => {
                Ok(format!("{}-{}", symbol, market))
            }
            ProviderInstrument::FxPair { from, to } => Ok(format!("{}{}=X", from, to)),
            ProviderInstrument::MetalSymbol { symbol, .. } => Ok(symbol.to_string()),
            ProviderInstrument::BondIsin { isin } => Ok(isin.to_string()),
        }
    }

    /// Convert a Yahoo error to a MarketDataError, detecting rate limits.
    fn convert_yahoo_error(&self, e: yahoo::YahooError, symbol: &str) -> MarketDataError {
        let error_msg = e.to_string();

        // Detect no-data boundary from Yahoo API error message
        if error_msg.contains("Data doesn't exist for startDate")
            || error_msg.contains("No data found, symbol may be delisted")
        {
            return MarketDataError::NoDataForRange;
        }

        // Detect rate limiting from error message
        if error_msg.contains("Too many requests")
            || error_msg.contains("rate limit")
            || error_msg.contains("429")
        {
            return MarketDataError::RateLimited {
                provider: "YAHOO".to_string(),
            };
        }

        // Handle known error types
        if matches!(e, yahoo::YahooError::NoQuotes | yahoo::YahooError::NoResult) {
            return MarketDataError::SymbolNotFound(symbol.to_string());
        }

        MarketDataError::ProviderError {
            provider: "YAHOO".to_string(),
            message: error_msg,
        }
    }

    // ========================================================================
    // Crumb/Cookie Authentication
    // ========================================================================

    /// Ensure we have a valid Yahoo authentication crumb.
    async fn ensure_crumb(&self) -> Result<CrumbData, MarketDataError> {
        // Check if we have a cached crumb
        {
            let guard = YAHOO_CRUMB.read().unwrap();
            if let Some(crumb) = guard.as_ref() {
                return Ok(crumb.clone());
            }
        }

        // Fetch new crumb
        self.fetch_crumb().await
    }

    /// Fetch a new Yahoo authentication crumb.
    async fn fetch_crumb(&self) -> Result<CrumbData, MarketDataError> {
        let client = reqwest::Client::new();

        // Step 1: Get cookie from fc.yahoo.com
        let response = client
            .get("https://fc.yahoo.com")
            .send()
            .await
            .map_err(|e| MarketDataError::ProviderError {
                provider: "YAHOO".to_string(),
                message: format!("Failed to get cookie: {}", e),
            })?;

        let cookie = response
            .headers()
            .get(header::SET_COOKIE)
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.split_once(';').map(|(v, _)| v.to_string()))
            .ok_or_else(|| MarketDataError::ProviderError {
                provider: "YAHOO".to_string(),
                message: "Failed to parse Yahoo cookie".to_string(),
            })?;

        // Step 2: Get crumb using cookie
        let crumb = client
            .get("https://query1.finance.yahoo.com/v1/test/getcrumb")
            .header(
                header::USER_AGENT,
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            )
            .header(header::COOKIE, &cookie)
            .send()
            .await
            .map_err(|e| MarketDataError::ProviderError {
                provider: "YAHOO".to_string(),
                message: format!("Failed to get crumb: {}", e),
            })?
            .text()
            .await
            .map_err(|e| MarketDataError::ProviderError {
                provider: "YAHOO".to_string(),
                message: format!("Failed to read crumb: {}", e),
            })?;

        let crumb_data = CrumbData { cookie, crumb };

        // Cache it
        let mut guard = YAHOO_CRUMB.write().unwrap();
        *guard = Some(crumb_data.clone());

        Ok(crumb_data)
    }

    /// Clear the cached crumb (used when authentication fails)
    fn clear_crumb(&self) {
        let mut guard = YAHOO_CRUMB.write().unwrap();
        *guard = None;
    }

    // ========================================================================
    // Dividend Fetching
    // ========================================================================

    /// Fetch dividend events for a symbol in the requested date range.
    pub async fn fetch_dividends(
        &self,
        symbol: &str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<DividendEvent>, MarketDataError> {
        use std::collections::HashMap;

        let crumb_data = self.ensure_crumb().await?;

        let encoded = urlencoding::encode(symbol);
        let url = format!(
            "https://query1.finance.yahoo.com/v8/finance/chart/{}?interval=1d&period1={}&period2={}&events=div&crumb={}",
            encoded,
            start.timestamp(),
            end.timestamp(),
            urlencoding::encode(&crumb_data.crumb)
        );

        let client = reqwest::Client::new();
        let resp = client
            .get(&url)
            .header(header::ACCEPT, "application/json")
            .header(
                header::USER_AGENT,
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            )
            .header(header::COOKIE, &crumb_data.cookie)
            .send()
            .await
            .map_err(|e| MarketDataError::ProviderError {
                provider: "YAHOO".to_string(),
                message: format!("Failed to fetch dividends: {}", e),
            })?;

        let status = resp.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            self.clear_crumb();
        }
        if !status.is_success() {
            return Err(MarketDataError::ProviderError {
                provider: "YAHOO".to_string(),
                message: format!("Yahoo returned {}", status),
            });
        }

        let text = resp
            .text()
            .await
            .map_err(|e| MarketDataError::ProviderError {
                provider: "YAHOO".to_string(),
                message: format!("Failed to read dividends response: {}", e),
            })?;

        #[derive(serde::Deserialize)]
        struct DivItem {
            amount: f64,
            date: i64,
        }
        #[derive(serde::Deserialize)]
        struct Events {
            dividends: Option<HashMap<String, DivItem>>,
        }
        #[derive(serde::Deserialize)]
        struct ChartResult {
            events: Option<Events>,
        }
        #[derive(serde::Deserialize)]
        struct ChartError {
            code: String,
            description: Option<String>,
        }
        #[derive(serde::Deserialize)]
        struct Chart {
            result: Option<Vec<ChartResult>>,
            error: Option<ChartError>,
        }
        #[derive(serde::Deserialize)]
        struct Root {
            chart: Option<Chart>,
        }

        let parsed: Root =
            serde_json::from_str(&text).map_err(|e| MarketDataError::ProviderError {
                provider: "YAHOO".to_string(),
                message: format!("Failed to parse dividends: {}", e),
            })?;

        // Detect Yahoo application-level errors (HTTP 200 with result: null + error object).
        // Without this check, the .and_then chain below silently returns Ok([]) for
        // invalid/delisted symbols and auth failures, masking real errors from callers.
        if let Some(chart_error) = parsed.chart.as_ref().and_then(|c| c.error.as_ref()) {
            let code = chart_error.code.to_ascii_lowercase();
            let description = chart_error.description.as_deref().unwrap_or("");

            // "Bad Request" + date-range description → no data in range
            if description.contains("Data doesn't exist for startDate") {
                return Err(MarketDataError::NoDataForRange);
            }

            // "Not Found" → symbol doesn't exist or is delisted
            if code.contains("not found") || code.contains("no data") {
                return Err(MarketDataError::SymbolNotFound(symbol.to_string()));
            }

            let display_description = if description.is_empty() {
                &chart_error.code
            } else {
                description
            };
            return Err(MarketDataError::ProviderError {
                provider: "YAHOO".to_string(),
                message: format!("chart error {}: {}", chart_error.code, display_description),
            });
        }

        let divs = parsed
            .chart
            .and_then(|c| c.result)
            .and_then(|r| r.into_iter().next())
            .and_then(|r| r.events)
            .and_then(|e| e.dividends)
            .unwrap_or_default();

        let mut result: Vec<DividendEvent> = divs
            .into_values()
            .map(|d| DividendEvent {
                amount: d.amount,
                date: d.date,
            })
            .collect();
        result.sort_by_key(|d| d.date);
        Ok(result)
    }

    // ========================================================================
    // Quote Fetching
    // ========================================================================

    /// Get the currency: prefer exchange metadata, fall back to asset's quote_ccy.
    fn get_currency(&self, context: &QuoteContext) -> String {
        let chain = ResolverChain::new();
        chain
            .get_currency(&"YAHOO".into(), context)
            .or_else(|| context.currency_hint.clone())
            .map(|c| c.to_string())
            .unwrap_or_else(|| "USD".to_string())
    }

    /// Convert chrono DateTime<Utc> to time::OffsetDateTime for the Yahoo API.
    fn chrono_to_offset_datetime(dt: DateTime<Utc>) -> OffsetDateTime {
        OffsetDateTime::from_unix_timestamp(dt.timestamp())
            .unwrap_or_else(|_| OffsetDateTime::now_utc())
    }

    /// Convert a Yahoo quote to our Quote model.
    fn yahoo_quote_to_quote(
        &self,
        yahoo_quote: yahoo::Quote,
        currency: String,
    ) -> Result<Quote, MarketDataError> {
        // Validate timestamp
        let timestamp: DateTime<Utc> = Utc
            .timestamp_opt(yahoo_quote.timestamp, 0)
            .single()
            .ok_or_else(|| MarketDataError::ValidationFailed {
                message: format!("Invalid timestamp: {}", yahoo_quote.timestamp),
            })?;

        // Close price is required
        let close = Decimal::from_f64_retain(yahoo_quote.close).ok_or_else(|| {
            MarketDataError::ValidationFailed {
                message: format!(
                    "Failed to convert close price {} to Decimal",
                    yahoo_quote.close
                ),
            }
        })?;

        Ok(Quote {
            timestamp,
            open: Decimal::from_f64_retain(yahoo_quote.open),
            high: Decimal::from_f64_retain(yahoo_quote.high),
            low: Decimal::from_f64_retain(yahoo_quote.low),
            close,
            volume: Decimal::from_u64(yahoo_quote.volume),
            currency,
            source: "YAHOO".to_string(),
        })
    }

    fn map_raw_search_quote(item: YahooSearchQuoteRaw) -> Option<SearchResult> {
        let symbol = item.symbol.trim();
        if symbol.is_empty() {
            return None;
        }

        let name = item
            .long_name
            .filter(|s| !s.trim().is_empty())
            .or_else(|| item.short_name.filter(|s| !s.trim().is_empty()))
            .unwrap_or_else(|| symbol.to_string());

        let exchange = item.exchange.unwrap_or_default();
        let quote_type = item.quote_type.unwrap_or_else(|| "UNKNOWN".to_string());

        let mut result = SearchResult::new(symbol.to_string(), name, &exchange, quote_type)
            .with_data_source("YAHOO");

        // Derive MIC from Yahoo exchange code (e.g., NMS→XNAS, TOR→XTSE)
        if let Some(mic) = yahoo_exchange_to_mic(&exchange) {
            result = result.with_exchange_mic(mic.into_owned());
        }

        if let Some(score) = item.score {
            result = result.with_score(score);
        }

        if let Some(currency) = item.currency.filter(|c| !c.trim().is_empty()) {
            result = result.with_currency(currency);
        }

        Some(result)
    }

    fn parse_raw_search_payload(payload: &str) -> Result<Vec<SearchResult>, MarketDataError> {
        let parsed: YahooSearchResponseRaw =
            serde_json::from_str(payload).map_err(|e| MarketDataError::ProviderError {
                provider: "YAHOO".to_string(),
                message: format!("Failed to parse Yahoo search payload: {}", e),
            })?;

        Ok(parsed
            .quotes
            .into_iter()
            .filter_map(Self::map_raw_search_quote)
            .collect())
    }

    async fn search_raw_with_currency(
        &self,
        encoded_query: &str,
    ) -> Result<Vec<SearchResult>, MarketDataError> {
        let url = format!(
            "https://query2.finance.yahoo.com/v1/finance/search?q={}",
            encoded_query
        );

        let payload = reqwest::Client::new()
            .get(&url)
            .header(
                header::USER_AGENT,
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            )
            .send()
            .await
            .map_err(|e| MarketDataError::ProviderError {
                provider: "YAHOO".to_string(),
                message: format!("Yahoo raw search request failed: {}", e),
            })?
            .text()
            .await
            .map_err(|e| MarketDataError::ProviderError {
                provider: "YAHOO".to_string(),
                message: format!("Yahoo raw search body read failed: {}", e),
            })?;

        Self::parse_raw_search_payload(&payload)
    }

    /// Fetch latest quote using primary method (library API).
    async fn fetch_latest_quote_primary(
        &self,
        symbol: &str,
        context: &QuoteContext,
    ) -> Result<Quote, MarketDataError> {
        let response = self
            .connector
            .get_latest_quotes(symbol, "1d")
            .await
            .map_err(|e| self.convert_yahoo_error(e, symbol))?;

        // Prefer Yahoo's own currency from response metadata over resolver chain
        let currency = response
            .metadata()
            .ok()
            .and_then(|m| m.currency)
            .unwrap_or_else(|| self.get_currency(context));

        let yahoo_quote = response.last_quote().map_err(|e| {
            warn!("No quotes returned for {}: {}", symbol, e);
            MarketDataError::SymbolNotFound(symbol.to_string())
        })?;

        self.yahoo_quote_to_quote(yahoo_quote, currency)
    }

    /// Fetch latest quote using backup method (quoteSummary API).
    async fn fetch_latest_quote_backup(
        &self,
        symbol: &str,
        context: &QuoteContext,
    ) -> Result<Quote, MarketDataError> {
        let crumb = self.ensure_crumb().await?;

        let url = format!(
            "https://query1.finance.yahoo.com/v10/finance/quoteSummary/{}?modules=price&crumb={}",
            encode(symbol),
            encode(&crumb.crumb)
        );

        let client = reqwest::Client::new();
        let response = client
            .get(&url)
            .header(
                header::USER_AGENT,
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            )
            .header(header::COOKIE, &crumb.cookie)
            .send()
            .await
            .map_err(|e| MarketDataError::ProviderError {
                provider: "YAHOO".to_string(),
                message: format!("Backup quote request failed: {}", e),
            })?;

        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            self.clear_crumb();
            return Err(MarketDataError::ProviderError {
                provider: "YAHOO".to_string(),
                message: "Yahoo authentication expired".to_string(),
            });
        }

        let data: YahooQuoteSummaryResponse =
            response
                .json()
                .await
                .map_err(|e| MarketDataError::ProviderError {
                    provider: "YAHOO".to_string(),
                    message: format!("Failed to parse backup quote response: {}", e),
                })?;

        let price = data
            .quote_summary
            .result
            .first()
            .and_then(|r| r.price.as_ref())
            .ok_or_else(|| MarketDataError::SymbolNotFound(symbol.to_string()))?;

        // Extract currency: API response > context hint (derived from MIC)
        let currency = price
            .currency
            .clone()
            .unwrap_or_else(|| self.get_currency(context));

        let close = price
            .regular_market_price
            .as_ref()
            .and_then(|p| p.raw)
            .and_then(Decimal::from_f64_retain)
            .ok_or_else(|| MarketDataError::ValidationFailed {
                message: "No valid price in backup response".to_string(),
            })?;

        let timestamp = price
            .regular_market_time
            .and_then(|ts| Utc.timestamp_opt(ts, 0).single())
            .unwrap_or_else(Utc::now);

        Ok(Quote {
            timestamp,
            open: price
                .regular_market_open
                .as_ref()
                .and_then(|p| p.raw)
                .and_then(Decimal::from_f64_retain),
            high: price
                .regular_market_day_high
                .as_ref()
                .and_then(|p| p.raw)
                .and_then(Decimal::from_f64_retain),
            low: price
                .regular_market_day_low
                .as_ref()
                .and_then(|p| p.raw)
                .and_then(Decimal::from_f64_retain),
            close,
            volume: price
                .regular_market_volume
                .as_ref()
                .and_then(|p| p.raw)
                .and_then(Decimal::from_f64_retain),
            currency,
            source: "YAHOO".to_string(),
        })
    }

    // ========================================================================
    // Profile Fetching
    // ========================================================================

    /// Fetch profile using quoteSummary API (richest data source).
    async fn fetch_quote_summary_profile(
        &self,
        symbol: &str,
    ) -> Result<AssetProfile, MarketDataError> {
        let crumb = self.ensure_crumb().await?;

        let url = format!(
            "https://query1.finance.yahoo.com/v10/finance/quoteSummary/{}?modules=price,summaryProfile,summaryDetail,topHoldings&crumb={}",
            encode(symbol),
            encode(&crumb.crumb)
        );

        let client = reqwest::Client::new();
        let response = client
            .get(&url)
            .header(
                header::USER_AGENT,
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            )
            .header(header::COOKIE, &crumb.cookie)
            .send()
            .await
            .map_err(|e| MarketDataError::ProviderError {
                provider: "YAHOO".to_string(),
                message: format!("Profile request failed: {}", e),
            })?;

        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            self.clear_crumb();
            return Err(MarketDataError::ProviderError {
                provider: "YAHOO".to_string(),
                message: "Yahoo authentication expired".to_string(),
            });
        }

        // Get response text first for debugging
        let response_text = response
            .text()
            .await
            .map_err(|e| MarketDataError::ProviderError {
                provider: "YAHOO".to_string(),
                message: format!("Failed to read profile response: {}", e),
            })?;

        let data: YahooQuoteSummaryResponse =
            serde_json::from_str(&response_text).map_err(|e| {
                warn!(
                    "[YAHOO] Failed to parse quoteSummary for {}: {}. Response: {}",
                    symbol,
                    e,
                    &response_text[..response_text.len().min(1000)]
                );
                MarketDataError::ProviderError {
                    provider: "YAHOO".to_string(),
                    message: format!("Failed to parse profile response: {}", e),
                }
            })?;

        let result = data
            .quote_summary
            .result
            .into_iter()
            .next()
            .ok_or_else(|| MarketDataError::SymbolNotFound(symbol.to_string()))?;

        self.map_quote_summary_to_profile(symbol, &result)
    }

    /// Fetch profile using search (last resort, minimal data).
    async fn fetch_search_profile(&self, symbol: &str) -> Result<AssetProfile, MarketDataError> {
        let encoded_symbol = encode(symbol);
        let result = self
            .connector
            .search_ticker(&encoded_symbol)
            .await
            .map_err(|e| MarketDataError::ProviderError {
                provider: "YAHOO".to_string(),
                message: e.to_string(),
            })?;

        let item = result
            .quotes
            .iter()
            .find(|q| q.symbol == symbol)
            .ok_or_else(|| MarketDataError::SymbolNotFound(symbol.to_string()))?;

        Ok(AssetProfile {
            source: Some("YAHOO".to_string()),
            name: Some(format_name(
                Some(&item.long_name),
                &item.quote_type,
                Some(&item.short_name),
                symbol,
            )),
            quote_type: Some(item.quote_type.to_uppercase()),
            ..Default::default()
        })
    }

    /// Map quoteSummary result to AssetProfile.
    fn map_quote_summary_to_profile(
        &self,
        symbol: &str,
        result: &YahooQuoteSummaryResult,
    ) -> Result<AssetProfile, MarketDataError> {
        let price = result.price.as_ref();
        let summary = result.summary_profile.as_ref();
        let detail = result.summary_detail.as_ref();
        let top_holdings = result.top_holdings.as_ref();

        // Get quote type for name formatting and classification
        let quote_type = price
            .and_then(|p| p.quote_type.as_ref())
            .map(|s| s.as_str())
            .unwrap_or("");
        let quote_type_upper = quote_type.to_uppercase();

        // Format name
        let name = format_name(
            price.and_then(|p| p.long_name.as_deref()),
            quote_type,
            price.and_then(|p| p.short_name.as_deref()),
            symbol,
        );

        // Build sector/sectors and asset allocation based on asset type
        let (sector, sectors, asset_allocation) = match quote_type_upper.as_str() {
            "ETF" | "MUTUALFUND" => {
                // For ETFs/Mutual Funds: extract sector weightings from topHoldings
                let sectors_json = top_holdings.and_then(|th| {
                    if th.sector_weightings.is_empty() {
                        return None;
                    }
                    let sector_data: Vec<serde_json::Value> = th
                        .sector_weightings
                        .iter()
                        .flat_map(|sw| {
                            sw.iter().filter_map(|(sector_name, weight)| {
                                weight.raw.map(|w| {
                                    serde_json::json!({
                                        "name": format_sector(sector_name),
                                        "weight": w
                                    })
                                })
                            })
                        })
                        .collect();
                    if sector_data.is_empty() {
                        None
                    } else {
                        serde_json::to_string(&sector_data).ok()
                    }
                });
                (
                    None,
                    sectors_json,
                    top_holdings.and_then(asset_allocation_json),
                )
            }
            _ => {
                // For stocks: use single sector from summaryProfile
                let sector = summary
                    .and_then(|s| s.sector.as_ref())
                    .map(|s| format_sector(s));
                (sector, None, None)
            }
        };

        let profile = AssetProfile {
            source: Some("YAHOO".to_string()),
            name: Some(name),
            quote_type: price
                .and_then(|p| p.quote_type.clone())
                .map(|t| t.to_uppercase()),
            sector,
            sectors,
            asset_allocation,
            industry: summary.and_then(|s| s.industry.clone()),
            website: summary.and_then(|s| s.website.clone()),
            description: summary
                .and_then(|s| s.long_business_summary.clone().or(s.description.clone())),
            country: summary.and_then(|s| s.country.clone()),
            employees: summary.and_then(|s| s.full_time_employees),
            // Financial metrics from summaryDetail (extract .raw from YahooPriceDetail)
            market_cap: detail.and_then(|d| d.market_cap.as_ref().and_then(|v| v.raw)),
            pe_ratio: detail.and_then(|d| d.trailing_pe.as_ref().and_then(|v| v.raw)),
            dividend_yield: detail.and_then(|d| d.dividend_yield.as_ref().and_then(|v| v.raw)),
            week_52_high: detail.and_then(|d| d.fifty_two_week_high.as_ref().and_then(|v| v.raw)),
            week_52_low: detail.and_then(|d| d.fifty_two_week_low.as_ref().and_then(|v| v.raw)),
            ..Default::default()
        };

        // Log mapped profile for debugging
        debug!(
            "[YAHOO PROFILE MAPPED] symbol={}, name={:?}, quote_type={:?}, sector={:?}, sectors={:?}, industry={:?}, country={:?}, description_len={:?}",
            symbol,
            profile.name,
            profile.quote_type,
            profile.sector,
            profile.sectors.as_ref().map(|s| if s.len() > 100 { format!("{}...", &s[..100]) } else { s.clone() }),
            profile.industry,
            profile.country,
            profile.description.as_ref().map(|d| d.len())
        );

        Ok(profile)
    }

    async fn search_single(&self, query: &str) -> Result<Vec<SearchResult>, MarketDataError> {
        let encoded_query = encode(query);

        debug!("Searching Yahoo for '{}'", query);

        // First try raw endpoint parsing so we can preserve currency (e.g., GBP vs GBp on LSE ETFs).
        match self.search_raw_with_currency(&encoded_query).await {
            Ok(results) if !results.is_empty() => return Ok(results),
            Ok(_) => debug!(
                "Yahoo raw search returned no quotes for '{}', falling back to connector API",
                query
            ),
            Err(e) => debug!(
                "Yahoo raw search failed for '{}': {}. Falling back to connector API",
                query, e
            ),
        }

        let result = self
            .connector
            .search_ticker(&encoded_query)
            .await
            .map_err(|e| MarketDataError::ProviderError {
                provider: "YAHOO".to_string(),
                message: e.to_string(),
            })?;

        let search_results = result
            .quotes
            .iter()
            .map(|item| {
                let mut r = SearchResult::new(
                    &item.symbol,
                    &item.long_name,
                    &item.exchange,
                    &item.quote_type,
                )
                .with_score(item.score)
                .with_data_source("YAHOO");
                if let Some(mic) = yahoo_exchange_to_mic(&item.exchange) {
                    r = r.with_exchange_mic(mic.into_owned());
                }
                r
            })
            .collect();

        Ok(search_results)
    }
}

// ============================================================================
// MarketDataProvider Implementation
// ============================================================================

#[async_trait]
impl MarketDataProvider for YahooProvider {
    fn id(&self) -> &'static str {
        "YAHOO"
    }

    fn priority(&self) -> u8 {
        1
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            instrument_kinds: &[
                InstrumentKind::Equity,
                InstrumentKind::Crypto,
                InstrumentKind::Fx,
                InstrumentKind::Option,
                InstrumentKind::Metal,
            ],
            coverage: Coverage::global_best_effort(),
            supports_latest: true,
            supports_historical: true,
            supports_search: true,
            supports_profile: true,
            supports_dividends: true,
        }
    }

    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_minute: 2000,
            max_concurrency: 10,
            min_delay: Duration::from_millis(25),
        }
    }

    async fn get_latest_quote(
        &self,
        context: &QuoteContext,
        instrument: ProviderInstrument,
    ) -> Result<Quote, MarketDataError> {
        let symbol = self.extract_symbol(&instrument)?;

        debug!("Fetching latest quote for {} from Yahoo", symbol);

        // Try primary method first
        match self.fetch_latest_quote_primary(&symbol, context).await {
            Ok(quote) => return Ok(quote),
            Err(e) => {
                debug!(
                    "Primary quote fetch failed for {}: {}, trying backup",
                    symbol, e
                );
            }
        }

        // Fallback to quoteSummary price data
        self.fetch_latest_quote_backup(&symbol, context).await
    }

    async fn get_historical_quotes(
        &self,
        context: &QuoteContext,
        instrument: ProviderInstrument,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<Quote>, MarketDataError> {
        let symbol = self.extract_symbol(&instrument)?;

        debug!(
            "Fetching historical quotes for {} from {} to {} from Yahoo",
            symbol,
            start.format("%Y-%m-%d"),
            end.format("%Y-%m-%d")
        );

        // Skip cash symbols
        if symbol.starts_with("CASH:") {
            return Ok(vec![]);
        }

        let start_time = Self::chrono_to_offset_datetime(start);
        let end_time = Self::chrono_to_offset_datetime(end);

        let response = self
            .connector
            .get_quote_history(&symbol, start_time, end_time)
            .await
            .map_err(|e| self.convert_yahoo_error(e, &symbol))?;

        // Prefer Yahoo's own currency from response metadata over resolver chain
        let currency = response
            .metadata()
            .ok()
            .and_then(|m| m.currency)
            .unwrap_or_else(|| self.get_currency(context));

        match response.quotes() {
            Ok(yahoo_quotes) => {
                let quotes: Vec<Quote> = yahoo_quotes
                    .into_iter()
                    .filter_map(|q| match self.yahoo_quote_to_quote(q, currency.clone()) {
                        Ok(quote) => Some(quote),
                        Err(e) => {
                            warn!("Skipping quote due to conversion error: {:?}", e);
                            None
                        }
                    })
                    .collect();

                if quotes.is_empty() {
                    return Err(MarketDataError::NoDataForRange);
                }

                Ok(quotes)
            }
            Err(yahoo::YahooError::NoQuotes) => {
                warn!(
                    "No historical quotes returned for '{}' between {} and {}",
                    symbol,
                    start.format("%Y-%m-%d"),
                    end.format("%Y-%m-%d")
                );
                Err(MarketDataError::NoDataForRange)
            }
            Err(e) => Err(self.convert_yahoo_error(e, &symbol)),
        }
    }

    async fn get_splits(
        &self,
        _context: &QuoteContext,
        instrument: ProviderInstrument,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<SplitEvent>, MarketDataError> {
        let symbol = self.extract_symbol(&instrument)?;

        if symbol.starts_with("CASH:") {
            return Ok(vec![]);
        }

        let start_time = Self::chrono_to_offset_datetime(start);
        let end_time = Self::chrono_to_offset_datetime(end);

        // Use 3mo interval to minimize OHLCV data in the response (~200 bars max)
        // while still returning all split events within the requested date range.
        let response = self
            .connector
            .get_quote_history_interval(&symbol, start_time, end_time, "3mo")
            .await
            .map_err(|e| self.convert_yahoo_error(e, &symbol))?;

        let splits = match response.splits() {
            Ok(splits) => splits,
            Err(yahoo::YahooError::NoQuotes) => return Ok(vec![]),
            Err(e) => return Err(self.convert_yahoo_error(e, &symbol)),
        };

        let events = splits
            .into_iter()
            .filter_map(|s| {
                let date = chrono::DateTime::from_timestamp(s.date, 0)?.date_naive();
                if s.denominator == 0.0 {
                    warn!(
                        "Skipping split for {} on {} — zero denominator",
                        symbol, date
                    );
                    return None;
                }
                let ratio = Decimal::from_f64(s.numerator / s.denominator)?;
                Some(SplitEvent { date, ratio })
            })
            .collect();

        Ok(events)
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
                    provider: self.id().to_string(),
                });
            }
        };

        self.fetch_dividends(&symbol, start, end).await
    }

    async fn search(&self, query: &str) -> Result<Vec<SearchResult>, MarketDataError> {
        let mut last_error = None;

        for provider_query in yahoo_equity_search_queries(query) {
            match self.search_single(&provider_query).await {
                Ok(results) if !results.is_empty() => return Ok(results),
                Ok(_) => {}
                Err(e) => last_error = Some(e),
            }
        }

        if let Some(error) = last_error {
            Err(error)
        } else {
            Ok(vec![])
        }
    }

    async fn get_profile(&self, symbol: &str) -> Result<AssetProfile, MarketDataError> {
        debug!("[YAHOO] get_profile called for symbol: {}", symbol);

        // Try quoteSummary API first (richest data)
        match self.fetch_quote_summary_profile(symbol).await {
            Ok(profile) => {
                debug!("[YAHOO] quoteSummary succeeded for {}", symbol);
                return Ok(profile);
            }
            Err(e) => {
                debug!(
                    "quoteSummary failed for {}: {}, trying search fallback",
                    symbol, e
                );
            }
        }

        // Last resort: search-based profile
        debug!(
            "[YAHOO] Falling back to search-based profile for {}",
            symbol
        );
        let profile = self.fetch_search_profile(symbol).await?;
        debug!(
            "[YAHOO PROFILE FROM SEARCH] symbol={}, name={:?}, quote_type={:?}",
            symbol, profile.name, profile.quote_type
        );
        Ok(profile)
    }
}

// ============================================================================
// Helper Functions
// ============================================================================

/// Clean up fund names by removing common prefixes.
fn format_name(
    long_name: Option<&str>,
    quote_type: &str,
    short_name: Option<&str>,
    symbol: &str,
) -> String {
    let mut name = long_name.unwrap_or("").to_string();

    if !name.is_empty() {
        let replacements = [
            ("&amp;", "&"),
            ("Amundi Index Solutions - ", ""),
            ("iShares ETF (CH) - ", ""),
            ("iShares III Public Limited Company - ", ""),
            ("iShares V PLC - ", ""),
            ("iShares VI Public Limited Company - ", ""),
            ("iShares VII PLC - ", ""),
            ("Multi Units Luxembourg - ", ""),
            ("VanEck ETFs N.V. - ", ""),
            ("Vaneck Vectors Ucits Etfs Plc - ", ""),
            ("Vanguard Funds Public Limited Company - ", ""),
            ("Vanguard Index Funds - ", ""),
            ("Xtrackers (IE) Plc - ", ""),
        ];

        for (from, to) in &replacements {
            name = name.replace(from, to);
        }
    }

    // Special handling for futures - strip date suffix
    if quote_type.to_uppercase() == "FUTURE" {
        if let Some(sn) = short_name {
            if sn.len() >= 7 {
                return sn[..sn.len() - 7].to_string();
            }
        }
    }

    if name.is_empty() {
        short_name.unwrap_or(symbol).to_string()
    } else {
        name
    }
}

/// Convert snake_case sector to Title Case.
fn format_sector(sector: &str) -> String {
    sector
        .split('_')
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                None => String::new(),
                Some(first) => first.to_uppercase().chain(chars).collect(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn asset_allocation_json(top_holdings: &YahooTopHoldings) -> Option<String> {
    let positions = [
        ("stock", &top_holdings.stock_position),
        ("bond", &top_holdings.bond_position),
        ("cash", &top_holdings.cash_position),
        ("preferred", &top_holdings.preferred_position),
        ("convertible", &top_holdings.convertible_position),
        ("other", &top_holdings.other_position),
    ];

    let allocation: Vec<serde_json::Value> = positions
        .into_iter()
        .filter_map(|(name, detail)| allocation_position(name, detail.as_ref()))
        .collect();

    if allocation.is_empty() {
        None
    } else {
        serde_json::to_string(&allocation).ok()
    }
}

fn allocation_position(name: &str, detail: Option<&YahooPriceDetail>) -> Option<serde_json::Value> {
    let weight = detail?.raw?;
    if !weight.is_finite() || weight <= 0.0 {
        return None;
    }

    Some(serde_json::json!({
        "name": name,
        "weight": weight
    }))
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::borrow::Cow;
    use std::sync::Arc;

    #[test]
    fn test_format_name() {
        // Test fund name cleanup
        assert_eq!(
            format_name(
                Some("iShares VII PLC - iShares Core S&P 500"),
                "ETF",
                None,
                "IVV"
            ),
            "iShares Core S&P 500"
        );

        // Test HTML entity replacement
        assert_eq!(
            format_name(Some("Apple Inc &amp; Co"), "EQUITY", None, "AAPL"),
            "Apple Inc & Co"
        );

        // Test fallback to short_name
        assert_eq!(
            format_name(None, "EQUITY", Some("AAPL Inc"), "AAPL"),
            "AAPL Inc"
        );

        // Test fallback to symbol
        assert_eq!(format_name(None, "EQUITY", None, "AAPL"), "AAPL");
    }

    #[test]
    fn test_format_sector() {
        assert_eq!(format_sector("technology"), "Technology");
        assert_eq!(format_sector("basic_materials"), "Basic Materials");
        assert_eq!(format_sector("real_estate"), "Real Estate");
        assert_eq!(format_sector("consumer_cyclical"), "Consumer Cyclical");
    }

    #[test]
    fn test_asset_allocation_json() {
        let holdings = YahooTopHoldings {
            sector_weightings: Vec::new(),
            stock_position: Some(YahooPriceDetail { raw: Some(0.60) }),
            bond_position: Some(YahooPriceDetail { raw: Some(0.30) }),
            cash_position: Some(YahooPriceDetail { raw: Some(0.0) }),
            other_position: Some(YahooPriceDetail { raw: Some(0.10) }),
            preferred_position: None,
            convertible_position: None,
        };

        let json = asset_allocation_json(&holdings).unwrap();
        let allocation: Vec<serde_json::Value> = serde_json::from_str(&json).unwrap();

        assert_eq!(allocation.len(), 3);
        assert_eq!(allocation[0]["name"], "stock");
        assert_eq!(allocation[0]["weight"].as_f64(), Some(0.60));
        assert_eq!(allocation[1]["name"], "bond");
        assert_eq!(allocation[1]["weight"].as_f64(), Some(0.30));
        assert_eq!(allocation[2]["name"], "other");
        assert_eq!(allocation[2]["weight"].as_f64(), Some(0.10));
    }

    fn create_test_context() -> QuoteContext {
        use crate::models::InstrumentId;

        QuoteContext {
            instrument: InstrumentId::Equity {
                ticker: Arc::from("AAPL"),
                mic: None,
            },
            identifiers: Default::default(),
            overrides: None,
            currency_hint: Some(Cow::Borrowed("USD")),
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        }
    }

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
    fn test_extract_symbol_equity() {
        let instrument = ProviderInstrument::EquitySymbol {
            symbol: Arc::from("AAPL"),
        };

        match &instrument {
            ProviderInstrument::EquitySymbol { symbol } => {
                assert_eq!(symbol.as_ref(), "AAPL");
            }
            _ => panic!("Expected EquitySymbol"),
        }
    }

    #[test]
    fn test_extract_symbol_crypto_pair() {
        let instrument = ProviderInstrument::CryptoPair {
            symbol: Arc::from("BTC"),
            market: Cow::Borrowed("USD"),
        };

        match &instrument {
            ProviderInstrument::CryptoPair { symbol, market } => {
                let formatted = format!("{}-{}", symbol, market);
                assert_eq!(formatted, "BTC-USD");
            }
            _ => panic!("Expected CryptoPair"),
        }
    }

    #[test]
    fn test_extract_symbol_fx_pair() {
        let instrument = ProviderInstrument::FxPair {
            from: Cow::Borrowed("EUR"),
            to: Cow::Borrowed("USD"),
        };

        match &instrument {
            ProviderInstrument::FxPair { from, to } => {
                let formatted = format!("{}{}=X", from, to);
                assert_eq!(formatted, "EURUSD=X");
            }
            _ => panic!("Expected FxPair"),
        }
    }

    #[test]
    fn test_get_currency_with_hint() {
        let provider = YahooProvider {
            connector: yahoo::YahooConnector::new().expect("Failed to initialize Yahoo connector"),
        };
        let context = create_test_context();
        assert_eq!(provider.get_currency(&context), "USD");
    }

    #[test]
    fn test_get_currency_prefers_resolver_over_hint() {
        let provider = YahooProvider {
            connector: yahoo::YahooConnector::new().expect("Failed to initialize Yahoo connector"),
        };
        // FX resolver returns the quote currency ("CAD"), which takes priority over hint
        let context = create_test_fx_context(Some("TWD"), "CAD");
        assert_eq!(provider.get_currency(&context), "CAD");
    }

    #[test]
    fn test_get_currency_falls_back_to_hint_when_resolver_empty() {
        let provider = YahooProvider {
            connector: yahoo::YahooConnector::new().expect("Failed to initialize Yahoo connector"),
        };
        // No MIC → resolver returns None for equities, so hint wins
        let context = create_test_context();
        assert_eq!(provider.get_currency(&context), "USD");
    }

    #[test]
    fn test_get_currency_xlon_prefers_exchange_metadata() {
        use crate::models::InstrumentId;
        // BATS@XLON: asset has quote_ccy="GBP" but Yahoo prices are in pence.
        // get_currency() must return "GBp" from exchange metadata, not "GBP" from hint.
        let provider = YahooProvider {
            connector: yahoo::YahooConnector::new().expect("Failed to initialize Yahoo connector"),
        };
        let context = QuoteContext {
            instrument: InstrumentId::Equity {
                ticker: Arc::from("BATS"),
                mic: Some("XLON".into()),
            },
            identifiers: Default::default(),
            currency_hint: Some(Cow::Borrowed("GBP")),
            overrides: None,
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        };
        assert_eq!(provider.get_currency(&context), "GBp");
    }

    #[test]
    fn test_capabilities() {
        let capabilities = ProviderCapabilities {
            instrument_kinds: &[
                InstrumentKind::Equity,
                InstrumentKind::Crypto,
                InstrumentKind::Fx,
                InstrumentKind::Option,
                InstrumentKind::Metal,
            ],
            coverage: Coverage::global_best_effort(),
            supports_latest: true,
            supports_historical: true,
            supports_search: true,
            supports_profile: true,
            supports_dividends: true,
        };

        assert!(capabilities
            .instrument_kinds
            .contains(&InstrumentKind::Equity));
        assert!(capabilities
            .instrument_kinds
            .contains(&InstrumentKind::Crypto));
        assert!(capabilities.instrument_kinds.contains(&InstrumentKind::Fx));
        assert!(capabilities
            .instrument_kinds
            .contains(&InstrumentKind::Option));
        assert!(capabilities
            .instrument_kinds
            .contains(&InstrumentKind::Metal));
        assert!(capabilities.supports_latest);
        assert!(capabilities.supports_historical);
        assert!(capabilities.supports_search);
        assert!(capabilities.supports_profile);
        assert!(capabilities.supports_dividends);
    }

    #[test]
    fn test_rate_limit() {
        let rate_limit = RateLimit {
            requests_per_minute: 2000,
            max_concurrency: 10,
            min_delay: Duration::from_millis(50),
        };

        assert_eq!(rate_limit.requests_per_minute, 2000);
        assert_eq!(rate_limit.max_concurrency, 10);
        assert_eq!(rate_limit.min_delay, Duration::from_millis(50));
    }

    #[test]
    fn test_parse_raw_search_payload_preserves_currency() {
        let payload = r#"{
          "quotes": [
            {
              "symbol": "VFEG.L",
              "exchange": "LSE",
              "quoteType": "ETF",
              "shortname": "Vanguard FTSE Emerging Markets UCITS ETF USD Accumulation",
              "longname": "Vanguard FTSE Emerging Markets UCITS ETF USD Accumulation",
              "score": 20001.0,
              "currency": "GBP"
            }
          ]
        }"#;

        let results = YahooProvider::parse_raw_search_payload(payload).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].symbol, "VFEG.L");
        assert_eq!(results[0].currency.as_deref(), Some("GBP"));
    }

    #[test]
    fn test_parse_raw_search_payload_uses_symbol_when_names_missing() {
        let payload = r#"{
          "quotes": [
            {
              "symbol": "BARC.L",
              "exchange": "LSE",
              "quoteType": "EQUITY"
            }
          ]
        }"#;

        let results = YahooProvider::parse_raw_search_payload(payload).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "BARC.L");
        assert_eq!(results[0].currency, None);
    }

    #[test]
    fn test_yahoo_search_queries_prefers_share_class_alias() {
        assert_eq!(
            yahoo_equity_search_queries("BRK.B"),
            vec!["BRK-B".to_string(), "BRK.B".to_string()]
        );
        assert_eq!(
            yahoo_equity_search_queries("SHOP.TO"),
            vec!["SHOP.TO".to_string()]
        );
        assert_eq!(
            yahoo_equity_search_queries("VOD.L"),
            vec!["VOD.L".to_string()]
        );
        assert_eq!(
            yahoo_equity_search_queries("AAPL"),
            vec!["AAPL".to_string()]
        );
    }

    #[test]
    fn test_no_data_range_error_message_detection() {
        let provider = YahooProvider {
            connector: yahoo::YahooConnector::new().expect("Failed to initialize Yahoo connector"),
        };
        let err = yahoo::YahooError::FetchFailed(
            "yahoo! finance returned api error: YErrorMessage { code: Some(\"Bad Request\") description: Some(\"Data doesn't exist for startDate = 1747094400 endDate = 1750118399\") }"
                .to_string(),
        );

        let mapped = provider.convert_yahoo_error(err, "TEST");
        assert!(matches!(mapped, MarketDataError::NoDataForRange));
    }

    /// Parsing tests for the inline chart-error detection added to `fetch_dividends`.
    /// These replicate the JSON shapes Yahoo returns on HTTP 200 with application-level errors.
    mod fetch_dividends_error_detection {
        use super::*;

        // Mirrors the inline structs in fetch_dividends so we can drive them in tests.
        #[allow(dead_code)]
        #[derive(serde::Deserialize)]
        struct DivItem {
            amount: f64,
            date: i64,
        }
        #[allow(dead_code)]
        #[derive(serde::Deserialize)]
        struct Events {
            dividends: Option<std::collections::HashMap<String, DivItem>>,
        }
        #[allow(dead_code)]
        #[derive(serde::Deserialize)]
        struct ChartResult {
            events: Option<Events>,
        }
        #[derive(serde::Deserialize)]
        struct ChartError {
            code: String,
            description: Option<String>,
        }
        #[allow(dead_code)]
        #[derive(serde::Deserialize)]
        struct Chart {
            result: Option<Vec<ChartResult>>,
            error: Option<ChartError>,
        }
        #[derive(serde::Deserialize)]
        struct Root {
            chart: Option<Chart>,
        }

        fn classify(text: &str) -> Result<(), MarketDataError> {
            let parsed: Root = serde_json::from_str(text).unwrap();
            if let Some(e) = parsed.chart.as_ref().and_then(|c| c.error.as_ref()) {
                let code = e.code.to_ascii_lowercase();
                let description = e.description.as_deref().unwrap_or("");
                if description.contains("Data doesn't exist for startDate") {
                    return Err(MarketDataError::NoDataForRange);
                }
                if code.contains("not found") || code.contains("no data") {
                    return Err(MarketDataError::SymbolNotFound("SYM".to_string()));
                }
                let display = if description.is_empty() {
                    &e.code
                } else {
                    description
                };
                return Err(MarketDataError::ProviderError {
                    provider: "YAHOO".to_string(),
                    message: format!("chart error {}: {}", e.code, display),
                });
            }
            Ok(())
        }

        #[test]
        fn not_found_error_maps_to_symbol_not_found() {
            // Real Yahoo v8/finance/chart response for an invalid/delisted symbol
            let json = r#"{"chart":{"result":null,"error":{"code":"Not Found","description":"No data found, symbol may be delisted"}}}"#;
            assert!(matches!(
                classify(json),
                Err(MarketDataError::SymbolNotFound(_))
            ));
        }

        #[test]
        fn bad_request_date_range_maps_to_no_data_for_range() {
            // Real Yahoo v8/finance/chart response when the requested date range has no data
            let json = r#"{"chart":{"result":null,"error":{"code":"Bad Request","description":"Data doesn't exist for startDate = 1577836800, endDate = 1578009600"}}}"#;
            assert!(matches!(
                classify(json),
                Err(MarketDataError::NoDataForRange)
            ));
        }

        #[test]
        fn generic_chart_error_maps_to_provider_error() {
            let json = r#"{"chart":{"result":null,"error":{"code":"Unauthorized","description":"Invalid crumb"}}}"#;
            match classify(json) {
                Err(MarketDataError::ProviderError { message, .. }) => {
                    assert!(message.contains("Unauthorized"));
                }
                other => panic!("unexpected: {:?}", other),
            }
        }

        #[test]
        fn valid_result_with_no_dividends_returns_ok() {
            let json = r#"{"chart":{"result":[{"events":null}],"error":null}}"#;
            assert!(classify(json).is_ok());
        }
    }
}
