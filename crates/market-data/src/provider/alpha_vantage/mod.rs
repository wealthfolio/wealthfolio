//! Alpha Vantage market data provider implementation.
//!
//! This module provides market data from Alpha Vantage API:
//! - Equities via TIME_SERIES_DAILY endpoint
//! - Options via REALTIME_OPTIONS endpoint (premium)
//! - FX rates via FX_DAILY endpoint
//! - Cryptocurrencies via DIGITAL_CURRENCY_DAILY endpoint
//!
//! Note: Alpha Vantage free tier is limited to 5 API calls per minute.

use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use log::{debug, warn};
use reqwest::Client;
use rust_decimal::Decimal;
use serde::Deserialize;

use crate::SymbolResolver;
use std::collections::HashMap;
use std::str::FromStr;
use std::time::Duration;

use crate::errors::MarketDataError;
use crate::models::{
    AssetProfile, Coverage, DividendEvent, InstrumentId, InstrumentKind, ProviderInstrument, Quote,
    QuoteContext, SearchResult,
};
use crate::provider::{MarketDataProvider, ProviderCapabilities, RateLimit};
use crate::resolver::ResolverChain;

const BASE_URL: &str = "https://www.alphavantage.co/query";
const PROVIDER_ID: &str = "ALPHA_VANTAGE";

/// Alpha Vantage market data provider.
///
/// Supports equities, FX rates, and cryptocurrencies.
/// Free tier is limited to 5 API calls per minute.
pub struct AlphaVantageProvider {
    client: Client,
    api_key: String,
}

// ============================================================================
// Response structures for Alpha Vantage API
// ============================================================================

/// TIME_SERIES_DAILY response for equities
#[derive(Debug, Deserialize)]
struct TimeSeriesResponse {
    #[serde(rename = "Time Series (Daily)")]
    time_series: Option<HashMap<String, DailyQuote>>,
    #[serde(rename = "Error Message")]
    error_message: Option<String>,
    #[serde(rename = "Note")]
    note: Option<String>,
    #[serde(rename = "Information")]
    information: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DailyQuote {
    #[serde(rename = "1. open")]
    open: String,
    #[serde(rename = "2. high")]
    high: String,
    #[serde(rename = "3. low")]
    low: String,
    #[serde(rename = "4. close")]
    close: String,
    #[serde(rename = "5. volume")]
    volume: String,
}

/// FX_DAILY response for forex pairs
#[derive(Debug, Deserialize)]
struct FxDailyResponse {
    #[serde(rename = "Time Series FX (Daily)")]
    time_series: Option<HashMap<String, FxDailyQuote>>,
    #[serde(rename = "Error Message")]
    error_message: Option<String>,
    #[serde(rename = "Note")]
    note: Option<String>,
    #[serde(rename = "Information")]
    information: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FxDailyQuote {
    #[serde(rename = "1. open")]
    open: String,
    #[serde(rename = "2. high")]
    high: String,
    #[serde(rename = "3. low")]
    low: String,
    #[serde(rename = "4. close")]
    close: String,
}

/// DIGITAL_CURRENCY_DAILY response for cryptocurrencies
#[derive(Debug, Deserialize)]
struct CryptoDailyResponse {
    #[serde(rename = "Time Series (Digital Currency Daily)")]
    time_series: Option<HashMap<String, CryptoDailyQuote>>,
    #[serde(rename = "Error Message")]
    error_message: Option<String>,
    #[serde(rename = "Note")]
    note: Option<String>,
    #[serde(rename = "Information")]
    information: Option<String>,
}

/// Crypto daily quote with dynamic field names based on market currency.
/// We use a custom deserializer to handle the dynamic field names.
#[derive(Debug, Deserialize)]
struct CryptoDailyQuote {
    // The fields are dynamically named based on market currency
    // e.g., "1a. open (USD)", "4a. close (USD)"
    // We'll use serde flatten with a HashMap to capture all fields
    #[serde(flatten)]
    fields: HashMap<String, serde_json::Value>,
}

impl CryptoDailyQuote {
    /// Extract the close price from the dynamic fields.
    /// Looks for "4a. close (XXX)" or "4b. close (XXX)" patterns.
    fn get_close(&self) -> Option<Decimal> {
        // Try to find close price in USD first, then any other currency
        for (key, value) in &self.fields {
            if key.starts_with("4a. close") || key.starts_with("4b. close") {
                if let Some(s) = value.as_str() {
                    return Decimal::from_str(s).ok();
                }
            }
        }
        None
    }

    fn get_open(&self) -> Option<Decimal> {
        for (key, value) in &self.fields {
            if key.starts_with("1a. open") || key.starts_with("1b. open") {
                if let Some(s) = value.as_str() {
                    return Decimal::from_str(s).ok();
                }
            }
        }
        None
    }

    fn get_high(&self) -> Option<Decimal> {
        for (key, value) in &self.fields {
            if key.starts_with("2a. high") || key.starts_with("2b. high") {
                if let Some(s) = value.as_str() {
                    return Decimal::from_str(s).ok();
                }
            }
        }
        None
    }

    fn get_low(&self) -> Option<Decimal> {
        for (key, value) in &self.fields {
            if key.starts_with("3a. low") || key.starts_with("3b. low") {
                if let Some(s) = value.as_str() {
                    return Decimal::from_str(s).ok();
                }
            }
        }
        None
    }

    fn get_volume(&self) -> Option<Decimal> {
        for (key, value) in &self.fields {
            if key.starts_with("5. volume") {
                if let Some(s) = value.as_str() {
                    return Decimal::from_str(s).ok();
                }
            }
        }
        None
    }
}

/// REALTIME_OPTIONS response for option chain/contract quotes (premium endpoint).
#[derive(Debug, Deserialize)]
struct OptionsResponse {
    data: Option<Vec<OptionContract>>,
    #[serde(rename = "Error Message")]
    error_message: Option<String>,
    #[serde(rename = "Note")]
    note: Option<String>,
    #[serde(rename = "Information")]
    information: Option<String>,
}

/// A single option contract from the REALTIME_OPTIONS response.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct OptionContract {
    #[serde(rename = "contractID")]
    contract_id: Option<String>,
    symbol: Option<String>,
    expiration: Option<String>,
    strike: Option<String>,
    #[serde(rename = "type")]
    option_type: Option<String>,
    last: Option<String>,
    mark: Option<String>,
    bid: Option<String>,
    ask: Option<String>,
    volume: Option<String>,
    open_interest: Option<String>,
    date: Option<String>,
}

/// SYMBOL_SEARCH response for symbol lookup
#[derive(Debug, Deserialize)]
struct SymbolSearchResponse {
    #[serde(rename = "bestMatches")]
    best_matches: Option<Vec<SymbolMatch>>,
    #[serde(rename = "Error Message")]
    error_message: Option<String>,
    #[serde(rename = "Note")]
    note: Option<String>,
    #[serde(rename = "Information")]
    information: Option<String>,
}

/// DIVIDENDS response for equity cash dividends.
#[derive(Debug, Deserialize)]
struct DividendsResponse {
    data: Option<Vec<AlphaDividend>>,
    #[serde(rename = "Error Message")]
    error_message: Option<String>,
    #[serde(rename = "Note")]
    note: Option<String>,
    #[serde(rename = "Information")]
    information: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AlphaDividend {
    ex_dividend_date: String,
    amount: String,
}

/// Individual match from SYMBOL_SEARCH
#[derive(Debug, Deserialize)]
struct SymbolMatch {
    #[serde(rename = "1. symbol")]
    symbol: String,
    #[serde(rename = "2. name")]
    name: String,
    #[serde(rename = "3. type")]
    asset_type: String,
    #[serde(rename = "4. region")]
    region: String,
    #[serde(rename = "5. marketOpen")]
    #[allow(dead_code)]
    market_open: String,
    #[serde(rename = "6. marketClose")]
    #[allow(dead_code)]
    market_close: String,
    #[serde(rename = "7. timezone")]
    #[allow(dead_code)]
    timezone: String,
    #[serde(rename = "8. currency")]
    currency: String,
    #[serde(rename = "9. matchScore")]
    match_score: String,
}

/// OVERVIEW response for company fundamentals
/// Only includes fields that map to AssetProfile; API returns many more fields.
#[derive(Debug, Deserialize)]
struct CompanyOverviewResponse {
    // Company identification
    #[serde(rename = "Symbol")]
    symbol: Option<String>,
    #[serde(rename = "AssetType")]
    asset_type: Option<String>,
    #[serde(rename = "Name")]
    name: Option<String>,
    #[serde(rename = "Description")]
    description: Option<String>,
    #[serde(rename = "Country")]
    country: Option<String>,
    #[serde(rename = "Sector")]
    sector: Option<String>,
    #[serde(rename = "Industry")]
    industry: Option<String>,

    // Market data
    #[serde(rename = "MarketCapitalization")]
    market_capitalization: Option<String>,

    // Valuation ratios
    #[serde(rename = "PERatio")]
    pe_ratio: Option<String>,
    #[serde(rename = "TrailingPE")]
    trailing_pe: Option<String>,

    // Dividend data
    #[serde(rename = "DividendYield")]
    dividend_yield: Option<String>,

    // Technical indicators
    #[serde(rename = "52WeekHigh")]
    week_52_high: Option<String>,
    #[serde(rename = "52WeekLow")]
    week_52_low: Option<String>,

    // Error handling
    #[serde(rename = "Error Message")]
    error_message: Option<String>,
    #[serde(rename = "Note")]
    note: Option<String>,
    #[serde(rename = "Information")]
    information: Option<String>,
    // Note: API provides many more fields (CIK, Exchange, Currency, EPS, Beta, etc.)
    // that are not currently mapped to AssetProfile
}

/// ETF_PROFILE response for ETF fundamentals
/// Provides sector weightings and holdings data for ETFs
#[derive(Debug, Deserialize)]
#[allow(dead_code)] // Some fields reserved for future use
struct EtfProfileResponse {
    // Note: Alpha Vantage ETF_PROFILE returns sectors as an array
    #[serde(default)]
    sectors: Vec<EtfSectorWeight>,

    // Holdings data (not currently used but available)
    #[serde(default)]
    holdings: Vec<EtfHolding>,

    // Fund metadata
    net_assets: Option<String>,
    net_expense_ratio: Option<String>,
    dividend_yield: Option<String>,

    // Error handling
    #[serde(rename = "Error Message")]
    error_message: Option<String>,
    #[serde(rename = "Note")]
    note: Option<String>,
    #[serde(rename = "Information")]
    information: Option<String>,
}

/// Sector weight entry from ETF_PROFILE
#[derive(Debug, Deserialize)]
struct EtfSectorWeight {
    sector: String,
    weight: String, // e.g., "51.1%" or "0.511"
}

/// Holding entry from ETF_PROFILE (for future use)
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct EtfHolding {
    #[serde(default)]
    symbol: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    weight: Option<String>,
}

impl EtfProfileResponse {
    /// Check if the response indicates an error or no data
    fn has_error(&self) -> bool {
        self.error_message.is_some()
            || self
                .information
                .as_ref()
                .is_some_and(|i| i.contains("demo"))
            || self.sectors.is_empty()
    }

    /// Parse weight string (handles both "51.1%" and "0.511" formats)
    fn parse_weight(s: &str) -> Option<f64> {
        let trimmed = s.trim();
        if trimmed.ends_with('%') {
            // Convert percentage to decimal: "51.1%" -> 0.511
            trimmed
                .trim_end_matches('%')
                .parse::<f64>()
                .ok()
                .map(|v| v / 100.0)
        } else {
            trimmed.parse::<f64>().ok()
        }
    }

    /// Convert sector weights to JSON array format
    fn sectors_to_json(&self) -> Option<String> {
        if self.sectors.is_empty() {
            return None;
        }

        let sector_data: Vec<serde_json::Value> = self
            .sectors
            .iter()
            .filter_map(|sw| {
                let weight = Self::parse_weight(&sw.weight)?;
                Some(serde_json::json!({
                    "name": sw.sector,
                    "weight": weight
                }))
            })
            .collect();

        if sector_data.is_empty() {
            None
        } else {
            serde_json::to_string(&sector_data).ok()
        }
    }

    /// Convert to AssetProfile
    fn to_asset_profile(&self, _symbol: &str) -> AssetProfile {
        AssetProfile {
            source: Some(PROVIDER_ID.to_string()),
            name: None, // ETF_PROFILE doesn't include name
            quote_type: Some("ETF".to_string()),
            sector: None, // ETFs have multiple sectors
            sectors: self.sectors_to_json(),
            asset_allocation: None,
            industry: None,
            website: None,
            description: None,
            country: None, // ETF_PROFILE doesn't include country
            employees: None,
            logo_url: None,
            market_cap: None,
            pe_ratio: None,
            dividend_yield: self
                .dividend_yield
                .as_ref()
                .and_then(|s| Self::parse_weight(s)),
            week_52_high: None,
            week_52_low: None,
            isin: None,
        }
    }
}

impl CompanyOverviewResponse {
    /// Parse a string field as f64, handling "None" and "-" values
    fn parse_f64(s: &Option<String>) -> Option<f64> {
        s.as_ref()
            .filter(|v| !v.is_empty() && *v != "None" && *v != "-" && *v != "0")
            .and_then(|v| v.parse::<f64>().ok())
    }

    /// Check if the response indicates an error
    fn has_error(&self) -> bool {
        self.error_message.is_some()
            || self
                .information
                .as_ref()
                .is_some_and(|i| i.contains("demo"))
    }

    /// Convert to AssetProfile
    fn to_asset_profile(&self) -> AssetProfile {
        // Normalize Alpha Vantage asset types to standard format
        // Alpha Vantage returns: "Common Stock", "ETF", "Mutual Fund", etc.
        let quote_type = self
            .asset_type
            .as_ref()
            .map(|t| match t.to_uppercase().as_str() {
                "COMMON STOCK" => "EQUITY".to_string(),
                "MUTUAL FUND" => "MUTUALFUND".to_string(),
                other => other.to_string(),
            });

        AssetProfile {
            source: Some(PROVIDER_ID.to_string()),
            name: self.name.clone(),
            quote_type,
            sector: self.sector.clone(),
            sectors: None, // Alpha Vantage doesn't provide weighted sectors
            asset_allocation: None,
            industry: self.industry.clone(),
            website: None, // Alpha Vantage doesn't provide website
            description: self.description.clone(),
            country: self.country.clone(),
            employees: None, // Alpha Vantage doesn't provide employee count
            logo_url: None,
            market_cap: Self::parse_f64(&self.market_capitalization),
            pe_ratio: Self::parse_f64(&self.pe_ratio)
                .or_else(|| Self::parse_f64(&self.trailing_pe)),
            dividend_yield: Self::parse_f64(&self.dividend_yield),
            week_52_high: Self::parse_f64(&self.week_52_high),
            week_52_low: Self::parse_f64(&self.week_52_low),
            isin: None,
        }
    }
}

// ============================================================================
// AlphaVantageProvider implementation
// ============================================================================

impl AlphaVantageProvider {
    /// Create a new Alpha Vantage provider with the given API key.
    ///
    /// # Errors
    ///
    /// Returns an error if the HTTP client cannot be created.
    pub fn new(api_key: String) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| Client::new());

        Self { client, api_key }
    }

    /// Make a request to the Alpha Vantage API.
    async fn fetch(&self, params: &[(&str, &str)]) -> Result<String, MarketDataError> {
        let mut all_params: Vec<(&str, &str)> = params.to_vec();
        all_params.push(("apikey", &self.api_key));

        let url = reqwest::Url::parse_with_params(BASE_URL, &all_params).map_err(|e| {
            MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("Failed to build URL: {}", e),
            }
        })?;

        debug!(
            "Alpha Vantage request: {}",
            url.as_str().replace(&self.api_key, "***")
        );

        let response = self.client.get(url).send().await.map_err(|e| {
            if e.is_timeout() {
                MarketDataError::Timeout {
                    provider: PROVIDER_ID.to_string(),
                }
            } else {
                MarketDataError::ProviderError {
                    provider: PROVIDER_ID.to_string(),
                    message: e.to_string(),
                }
            }
        })?;

        let status = response.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err(MarketDataError::RateLimited {
                provider: PROVIDER_ID.to_string(),
            });
        }

        if !status.is_success() {
            return Err(MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("HTTP {}", status),
            });
        }

        response
            .text()
            .await
            .map_err(|e| MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: e.to_string(),
            })
    }

    /// Get the currency: prefer exchange metadata, fall back to asset's quote_ccy.
    fn resolve_currency(&self, context: &QuoteContext) -> String {
        let chain = ResolverChain::new();
        chain
            .get_currency(&PROVIDER_ID.into(), context)
            .or_else(|| context.currency_hint.clone())
            .map(|c| c.to_string())
            .unwrap_or_else(|| "USD".to_string())
    }

    /// Check for API-level errors in the response.
    fn check_api_error(
        error_message: &Option<String>,
        note: &Option<String>,
        information: &Option<String>,
    ) -> Result<(), MarketDataError> {
        if let Some(ref msg) = error_message {
            // Check if it's a "not found" type error
            if msg.contains("Invalid API call") || msg.contains("not found") {
                return Err(MarketDataError::SymbolNotFound(msg.clone()));
            }
            return Err(MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: msg.clone(),
            });
        }

        // "Note" usually indicates rate limiting
        if let Some(ref msg) = note {
            if msg.contains("API call frequency") || msg.contains("rate limit") {
                return Err(MarketDataError::RateLimited {
                    provider: PROVIDER_ID.to_string(),
                });
            }
            warn!("Alpha Vantage note: {}", msg);
        }

        // "Information" can indicate various issues
        if let Some(ref msg) = information {
            if msg.contains("API call frequency") || msg.contains("rate limit") {
                return Err(MarketDataError::RateLimited {
                    provider: PROVIDER_ID.to_string(),
                });
            }
            warn!("Alpha Vantage info: {}", msg);
        }

        Ok(())
    }

    /// Parse a date string in YYYY-MM-DD format to DateTime<Utc>.
    fn parse_date(date_str: &str) -> Option<DateTime<Utc>> {
        NaiveDate::parse_from_str(date_str, "%Y-%m-%d")
            .ok()
            .and_then(|d| d.and_hms_opt(0, 0, 0))
            .and_then(|dt| Utc.from_local_datetime(&dt).single())
    }

    /// Parse a decimal value from a string.
    fn parse_decimal(s: &str) -> Option<Decimal> {
        Decimal::from_str(s).ok()
    }

    /// Fetch equity quotes using TIME_SERIES_DAILY endpoint.
    async fn fetch_equity_quotes(
        &self,
        symbol: &str,
        currency: &str,
    ) -> Result<Vec<Quote>, MarketDataError> {
        let params = [
            ("function", "TIME_SERIES_DAILY"),
            ("symbol", symbol),
            ("outputsize", "compact"), // TIME_SERIES_DAILY: 'full' is premium-only
        ];

        let text = self.fetch(&params).await?;
        let response: TimeSeriesResponse =
            serde_json::from_str(&text).map_err(|e| MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("Failed to parse response: {}", e),
            })?;

        Self::check_api_error(
            &response.error_message,
            &response.note,
            &response.information,
        )?;

        let time_series = response.time_series.ok_or_else(|| {
            MarketDataError::SymbolNotFound(format!("No data for symbol: {}", symbol))
        })?;

        let mut quotes: Vec<Quote> = time_series
            .into_iter()
            .filter_map(|(date_str, daily)| {
                let timestamp = Self::parse_date(&date_str)?;
                let open = Self::parse_decimal(&daily.open)?;
                let high = Self::parse_decimal(&daily.high)?;
                let low = Self::parse_decimal(&daily.low)?;
                let close = Self::parse_decimal(&daily.close)?;
                let volume = Self::parse_decimal(&daily.volume)?;

                Some(Quote::ohlcv(
                    timestamp,
                    open,
                    high,
                    low,
                    close,
                    volume,
                    currency.to_string(),
                    PROVIDER_ID.to_string(),
                ))
            })
            .collect();

        // Sort by timestamp ascending
        quotes.sort_by_key(|a| a.timestamp);

        debug!(
            "Alpha Vantage: fetched {} equity quotes for {}",
            quotes.len(),
            symbol
        );

        Ok(quotes)
    }

    /// Extract the underlying ticker from an OCC symbol (chars before the date portion).
    fn extract_underlying_from_occ(occ_symbol: &str) -> String {
        // OCC format: UNDERLYING + YYMMDD + C/P + STRIKE(8) = 15 non-underlying chars
        let s = occ_symbol.trim();
        let underlying_len = s.len().saturating_sub(15);
        if underlying_len == 0 {
            s.to_string()
        } else {
            s[..underlying_len].trim().to_string()
        }
    }

    /// Fetch a single option contract quote using REALTIME_OPTIONS endpoint.
    ///
    /// Uses `symbol` (underlying) + `contract` (OCC symbol) to get a specific contract.
    async fn fetch_option_quote(&self, occ_symbol: &str) -> Result<Quote, MarketDataError> {
        let underlying = Self::extract_underlying_from_occ(occ_symbol);

        let params = [
            ("function", "REALTIME_OPTIONS"),
            ("symbol", &underlying),
            ("contract", occ_symbol),
        ];

        let text = self.fetch(&params).await?;
        let response: OptionsResponse =
            serde_json::from_str(&text).map_err(|e| MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("Failed to parse options response: {}", e),
            })?;

        Self::check_api_error(
            &response.error_message,
            &response.note,
            &response.information,
        )?;

        let contracts = response.data.ok_or_else(|| {
            MarketDataError::SymbolNotFound(format!("No options data for: {}", occ_symbol))
        })?;

        let contract = contracts.into_iter().next().ok_or_else(|| {
            MarketDataError::SymbolNotFound(format!("Contract not found: {}", occ_symbol))
        })?;

        // Use `last` traded price; fall back to `mark` (mid of bid/ask)
        let close = contract
            .last
            .as_deref()
            .and_then(Self::parse_decimal)
            .or_else(|| contract.mark.as_deref().and_then(Self::parse_decimal))
            .ok_or_else(|| MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("No price data for contract: {}", occ_symbol),
            })?;

        let volume = contract.volume.as_deref().and_then(Self::parse_decimal);

        let timestamp = contract
            .date
            .as_deref()
            .and_then(Self::parse_date)
            .unwrap_or_else(Utc::now);

        debug!(
            "Alpha Vantage: fetched option quote for {} — close={}",
            occ_symbol, close
        );

        Ok(Quote {
            timestamp,
            open: None,
            high: None,
            low: None,
            close,
            volume,
            currency: "USD".to_string(), // US options are always USD
            source: PROVIDER_ID.to_string(),
        })
    }

    /// Fetch FX quotes using FX_DAILY endpoint.
    async fn fetch_fx_quotes(&self, from: &str, to: &str) -> Result<Vec<Quote>, MarketDataError> {
        let params = [
            ("function", "FX_DAILY"),
            ("from_symbol", from),
            ("to_symbol", to),
            ("outputsize", "full"), // FX_DAILY supports full on free tier
        ];

        let text = self.fetch(&params).await?;
        let response: FxDailyResponse =
            serde_json::from_str(&text).map_err(|e| MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("Failed to parse response: {}", e),
            })?;

        Self::check_api_error(
            &response.error_message,
            &response.note,
            &response.information,
        )?;

        let time_series = response.time_series.ok_or_else(|| {
            MarketDataError::SymbolNotFound(format!("No data for FX pair: {}/{}", from, to))
        })?;

        let mut quotes: Vec<Quote> = time_series
            .into_iter()
            .filter_map(|(date_str, daily)| {
                let timestamp = Self::parse_date(&date_str)?;
                let open = Self::parse_decimal(&daily.open)?;
                let high = Self::parse_decimal(&daily.high)?;
                let low = Self::parse_decimal(&daily.low)?;
                let close = Self::parse_decimal(&daily.close)?;

                Some(Quote {
                    timestamp,
                    open: Some(open),
                    high: Some(high),
                    low: Some(low),
                    close,
                    volume: None, // FX doesn't have volume
                    currency: to.to_string(),
                    source: PROVIDER_ID.to_string(),
                })
            })
            .collect();

        // Sort by timestamp ascending
        quotes.sort_by_key(|a| a.timestamp);

        debug!(
            "Alpha Vantage: fetched {} FX quotes for {}/{}",
            quotes.len(),
            from,
            to
        );

        Ok(quotes)
    }

    /// Fetch crypto quotes using DIGITAL_CURRENCY_DAILY endpoint.
    async fn fetch_crypto_quotes(
        &self,
        symbol: &str,
        market: &str,
    ) -> Result<Vec<Quote>, MarketDataError> {
        let params = [
            ("function", "DIGITAL_CURRENCY_DAILY"),
            ("symbol", symbol),
            ("market", market),
        ];

        let text = self.fetch(&params).await?;
        let response: CryptoDailyResponse =
            serde_json::from_str(&text).map_err(|e| MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("Failed to parse response: {}", e),
            })?;

        Self::check_api_error(
            &response.error_message,
            &response.note,
            &response.information,
        )?;

        let time_series = response.time_series.ok_or_else(|| {
            MarketDataError::SymbolNotFound(format!("No data for crypto: {}/{}", symbol, market))
        })?;

        let mut quotes: Vec<Quote> = time_series
            .into_iter()
            .filter_map(|(date_str, daily)| {
                let timestamp = Self::parse_date(&date_str)?;
                let close = daily.get_close()?;

                Some(Quote {
                    timestamp,
                    open: daily.get_open(),
                    high: daily.get_high(),
                    low: daily.get_low(),
                    close,
                    volume: daily.get_volume(),
                    currency: market.to_string(),
                    source: PROVIDER_ID.to_string(),
                })
            })
            .collect();

        // Sort by timestamp ascending
        quotes.sort_by_key(|a| a.timestamp);

        debug!(
            "Alpha Vantage: fetched {} crypto quotes for {}/{}",
            quotes.len(),
            symbol,
            market
        );

        Ok(quotes)
    }

    /// Filter quotes by date range.
    fn filter_by_date_range(
        quotes: Vec<Quote>,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Vec<Quote> {
        quotes
            .into_iter()
            .filter(|q| q.timestamp >= start && q.timestamp <= end)
            .collect()
    }

    /// Fetch cash dividends using DIVIDENDS endpoint.
    async fn fetch_dividends(
        &self,
        symbol: &str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<DividendEvent>, MarketDataError> {
        let params = [("function", "DIVIDENDS"), ("symbol", symbol)];

        let text = self.fetch(&params).await?;
        let response: DividendsResponse =
            serde_json::from_str(&text).map_err(|e| MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("Failed to parse dividends response: {}", e),
            })?;

        Self::check_api_error(
            &response.error_message,
            &response.note,
            &response.information,
        )?;

        let mut dividends: Vec<DividendEvent> = response
            .data
            .unwrap_or_default()
            .into_iter()
            .filter_map(|d| {
                let timestamp = Self::parse_date(&d.ex_dividend_date)?;
                if timestamp < start || timestamp > end {
                    return None;
                }
                let amount = d.amount.parse::<f64>().ok()?;
                Some(DividendEvent {
                    amount,
                    date: timestamp.timestamp(),
                })
            })
            .collect();

        dividends.sort_by_key(|d| d.date);
        Ok(dividends)
    }

    /// Fetch company overview using OVERVIEW endpoint.
    async fn fetch_company_overview(&self, symbol: &str) -> Result<AssetProfile, MarketDataError> {
        let params = [("function", "OVERVIEW"), ("symbol", symbol)];

        let text = self.fetch(&params).await?;

        // First try to parse as a valid response
        let response: CompanyOverviewResponse =
            serde_json::from_str(&text).map_err(|e| MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("Failed to parse company overview response: {}", e),
            })?;

        // Check for API-level errors
        Self::check_api_error(
            &response.error_message,
            &response.note,
            &response.information,
        )?;

        // Check if we got actual data (symbol should be present)
        if response.symbol.is_none() || response.has_error() {
            return Err(MarketDataError::SymbolNotFound(format!(
                "No company overview data for symbol: {}",
                symbol
            )));
        }

        debug!("Alpha Vantage: fetched company overview for {}", symbol);

        Ok(response.to_asset_profile())
    }

    /// Fetch ETF profile using ETF_PROFILE endpoint.
    /// Returns sector weightings and holdings data for ETFs.
    async fn fetch_etf_profile(&self, symbol: &str) -> Result<AssetProfile, MarketDataError> {
        let params = [("function", "ETF_PROFILE"), ("symbol", symbol)];

        let text = self.fetch(&params).await?;

        // Try to parse as ETF profile response
        let response: EtfProfileResponse =
            serde_json::from_str(&text).map_err(|e| MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("Failed to parse ETF profile response: {}", e),
            })?;

        // Check for API-level errors
        Self::check_api_error(
            &response.error_message,
            &response.note,
            &response.information,
        )?;

        // Check if we got actual data
        if response.has_error() {
            return Err(MarketDataError::SymbolNotFound(format!(
                "No ETF profile data for symbol: {}",
                symbol
            )));
        }

        debug!(
            "Alpha Vantage: fetched ETF profile for {} with {} sectors",
            symbol,
            response.sectors.len()
        );

        Ok(response.to_asset_profile(symbol))
    }

    /// Search for symbols using SYMBOL_SEARCH endpoint.
    async fn search_symbols(&self, query: &str) -> Result<Vec<SearchResult>, MarketDataError> {
        let params = [("function", "SYMBOL_SEARCH"), ("keywords", query)];

        let text = self.fetch(&params).await?;

        let response: SymbolSearchResponse =
            serde_json::from_str(&text).map_err(|e| MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("Failed to parse search response: {}", e),
            })?;

        // Check for API-level errors
        Self::check_api_error(
            &response.error_message,
            &response.note,
            &response.information,
        )?;

        let matches = response.best_matches.unwrap_or_default();

        let results: Vec<SearchResult> = matches
            .into_iter()
            .map(|m| {
                // Parse match score (0-1 as string, e.g., "1.0000")
                let score = m.match_score.parse::<f64>().unwrap_or(0.0);

                // Normalize asset type to match other providers
                let asset_type = match m.asset_type.to_uppercase().as_str() {
                    "EQUITY" => "EQUITY",
                    "ETF" => "ETF",
                    "MUTUAL FUND" => "MUTUALFUND",
                    other => other,
                }
                .to_string();

                SearchResult::new(&m.symbol, &m.name, &m.region, &asset_type)
                    .with_currency(&m.currency)
                    .with_score(score)
                    .with_data_source(PROVIDER_ID)
            })
            .collect();

        debug!(
            "Alpha Vantage: search for '{}' returned {} results",
            query,
            results.len()
        );

        Ok(results)
    }
}

// ============================================================================
// MarketDataProvider trait implementation
// ============================================================================

#[async_trait]
impl MarketDataProvider for AlphaVantageProvider {
    fn id(&self) -> &'static str {
        PROVIDER_ID
    }

    fn priority(&self) -> u8 {
        // Lower priority than Yahoo due to rate limits
        3
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            instrument_kinds: &[
                InstrumentKind::Equity,
                InstrumentKind::Crypto,
                InstrumentKind::Fx,
                InstrumentKind::Option,
            ],
            // Use best_effort to accept instruments without MIC codes
            coverage: Coverage::global_best_effort(),
            supports_latest: true,
            supports_historical: true,
            supports_search: true,  // Via SYMBOL_SEARCH endpoint
            supports_profile: true, // Via OVERVIEW endpoint for equities
            supports_dividends: true,
        }
    }

    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_minute: 25,           // Free tier: 25 requests/day
            max_concurrency: 1,                // Sequential requests only
            min_delay: Duration::from_secs(3), // ~25 requests per minute
        }
    }

    async fn get_latest_quote(
        &self,
        context: &QuoteContext,
        instrument: ProviderInstrument,
    ) -> Result<Quote, MarketDataError> {
        // Options are routed as EquitySymbol by the resolver but need the
        // REALTIME_OPTIONS endpoint. Use the QuoteContext instrument kind
        // to detect options reliably (no heuristic needed).
        if matches!(context.instrument, InstrumentId::Option { .. }) {
            if let ProviderInstrument::EquitySymbol { ref symbol } = instrument {
                return self.fetch_option_quote(symbol).await;
            }
        }

        // Fetch historical quotes and return the most recent one
        let quotes = match instrument {
            ProviderInstrument::EquitySymbol { ref symbol } => {
                let currency = self.resolve_currency(context);
                self.fetch_equity_quotes(symbol, &currency).await?
            }
            ProviderInstrument::FxPair { ref from, ref to } => {
                self.fetch_fx_quotes(from, to).await?
            }
            ProviderInstrument::CryptoPair {
                ref symbol,
                ref market,
            } => self.fetch_crypto_quotes(symbol, market).await?,
            ProviderInstrument::FxSymbol { ref symbol } => {
                // Try to parse FX symbol format (e.g., "EURUSD" -> EUR/USD)
                if symbol.len() == 6 {
                    let from = &symbol[..3];
                    let to = &symbol[3..];
                    self.fetch_fx_quotes(from, to).await?
                } else {
                    return Err(MarketDataError::UnsupportedAssetType(format!(
                        "Cannot parse FX symbol: {}",
                        symbol
                    )));
                }
            }
            ProviderInstrument::CryptoSymbol { ref symbol } => {
                // Try to parse crypto symbol format (e.g., "BTC-USD" -> BTC/USD)
                if let Some((base, quote)) = symbol.split_once('-') {
                    self.fetch_crypto_quotes(base, quote).await?
                } else {
                    let currency = self.resolve_currency(context);
                    self.fetch_crypto_quotes(symbol, &currency).await?
                }
            }
            ProviderInstrument::MetalSymbol { .. } => {
                return Err(MarketDataError::UnsupportedAssetType(
                    "Alpha Vantage does not support metals".to_string(),
                ));
            }
            ProviderInstrument::BondIsin { .. } => {
                return Err(MarketDataError::UnsupportedAssetType(
                    "Alpha Vantage does not support bonds".to_string(),
                ));
            }
        };

        // Return the most recent quote
        quotes
            .into_iter()
            .last()
            .ok_or(MarketDataError::NoDataForRange)
    }

    async fn get_historical_quotes(
        &self,
        context: &QuoteContext,
        instrument: ProviderInstrument,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<Quote>, MarketDataError> {
        // HISTORICAL_OPTIONS requires per-day API calls — not practical with rate limits.
        // Use NotSupported so the registry falls through to the next provider (e.g. Yahoo).
        if matches!(context.instrument, InstrumentId::Option { .. }) {
            return Err(MarketDataError::NotSupported {
                operation: "historical_quotes".to_string(),
                provider: PROVIDER_ID.to_string(),
            });
        }

        let quotes = match instrument {
            ProviderInstrument::EquitySymbol { ref symbol } => {
                let currency = self.resolve_currency(context);
                self.fetch_equity_quotes(symbol, &currency).await?
            }
            ProviderInstrument::FxPair { ref from, ref to } => {
                self.fetch_fx_quotes(from, to).await?
            }
            ProviderInstrument::CryptoPair {
                ref symbol,
                ref market,
            } => self.fetch_crypto_quotes(symbol, market).await?,
            ProviderInstrument::FxSymbol { ref symbol } => {
                // Try to parse FX symbol format (e.g., "EURUSD" -> EUR/USD)
                if symbol.len() == 6 {
                    let from = &symbol[..3];
                    let to = &symbol[3..];
                    self.fetch_fx_quotes(from, to).await?
                } else {
                    return Err(MarketDataError::UnsupportedAssetType(format!(
                        "Cannot parse FX symbol: {}",
                        symbol
                    )));
                }
            }
            ProviderInstrument::CryptoSymbol { ref symbol } => {
                // Try to parse crypto symbol format (e.g., "BTC-USD" -> BTC/USD)
                if let Some((base, quote)) = symbol.split_once('-') {
                    self.fetch_crypto_quotes(base, quote).await?
                } else {
                    let currency = self.resolve_currency(context);
                    self.fetch_crypto_quotes(symbol, &currency).await?
                }
            }
            ProviderInstrument::MetalSymbol { .. } => {
                return Err(MarketDataError::UnsupportedAssetType(
                    "Alpha Vantage does not support metals".to_string(),
                ));
            }
            ProviderInstrument::BondIsin { .. } => {
                return Err(MarketDataError::UnsupportedAssetType(
                    "Alpha Vantage does not support bonds".to_string(),
                ));
            }
        };

        // Filter by date range
        let filtered = Self::filter_by_date_range(quotes, start, end);

        if filtered.is_empty() {
            return Err(MarketDataError::NoDataForRange);
        }

        Ok(filtered)
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

    async fn get_profile(&self, symbol: &str) -> Result<AssetProfile, MarketDataError> {
        debug!("Fetching profile for {} from Alpha Vantage", symbol);

        // First, try OVERVIEW endpoint for basic company/fund info
        let mut profile = self.fetch_company_overview(symbol).await?;

        // If it's an ETF, also fetch ETF_PROFILE for sector weightings
        if let Some(ref quote_type) = profile.quote_type {
            if quote_type == "ETF" || quote_type == "MUTUALFUND" {
                match self.fetch_etf_profile(symbol).await {
                    Ok(etf_profile) => {
                        // Merge ETF-specific data (sector weightings)
                        if etf_profile.sectors.is_some() {
                            profile.sectors = etf_profile.sectors;
                            profile.sector = None; // Clear single sector when we have weighted sectors
                        }
                        // Merge dividend yield if available from ETF profile
                        if etf_profile.dividend_yield.is_some() {
                            profile.dividend_yield = etf_profile.dividend_yield;
                        }
                        debug!("Alpha Vantage: merged ETF profile data for {}", symbol);
                    }
                    Err(e) => {
                        // ETF_PROFILE failed, continue with OVERVIEW data only
                        warn!(
                            "Alpha Vantage: ETF_PROFILE failed for {}, using OVERVIEW only: {}",
                            symbol, e
                        );
                    }
                }
            }
        }

        Ok(profile)
    }

    async fn search(&self, query: &str) -> Result<Vec<SearchResult>, MarketDataError> {
        debug!("Searching Alpha Vantage for '{}'", query);
        self.search_symbols(query).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::borrow::Cow;

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
    fn test_parse_date() {
        let date = AlphaVantageProvider::parse_date("2024-01-15");
        assert!(date.is_some());
        let dt = date.unwrap();
        assert_eq!(dt.date_naive().to_string(), "2024-01-15");
    }

    #[test]
    fn test_parse_date_invalid() {
        assert!(AlphaVantageProvider::parse_date("invalid").is_none());
        assert!(AlphaVantageProvider::parse_date("01-15-2024").is_none());
    }

    #[test]
    fn test_parse_decimal() {
        let d = AlphaVantageProvider::parse_decimal("150.25");
        assert!(d.is_some());
        assert_eq!(d.unwrap().to_string(), "150.25");
    }

    #[test]
    fn test_parse_decimal_invalid() {
        assert!(AlphaVantageProvider::parse_decimal("invalid").is_none());
    }

    #[test]
    fn test_provider_id() {
        let provider = AlphaVantageProvider::new("test_key".to_string());
        assert_eq!(provider.id(), "ALPHA_VANTAGE");
    }

    #[test]
    fn test_provider_priority() {
        let provider = AlphaVantageProvider::new("test_key".to_string());
        assert_eq!(provider.priority(), 3);
    }

    #[test]
    fn test_provider_capabilities() {
        let provider = AlphaVantageProvider::new("test_key".to_string());
        let caps = provider.capabilities();
        assert!(caps.instrument_kinds.contains(&InstrumentKind::Equity));
        assert!(caps.instrument_kinds.contains(&InstrumentKind::Crypto));
        assert!(caps.instrument_kinds.contains(&InstrumentKind::Fx));
        assert!(caps.instrument_kinds.contains(&InstrumentKind::Option));
        assert!(caps.supports_latest);
        assert!(caps.supports_historical);
        assert!(caps.supports_search); // Via SYMBOL_SEARCH endpoint
        assert!(caps.supports_profile); // Via OVERVIEW endpoint
        assert!(caps.supports_dividends);
    }

    #[test]
    fn test_rate_limit() {
        let provider = AlphaVantageProvider::new("test_key".to_string());
        let limit = provider.rate_limit();
        assert_eq!(limit.requests_per_minute, 25);
        assert_eq!(limit.max_concurrency, 1);
        assert_eq!(limit.min_delay, Duration::from_secs(3));
    }

    #[test]
    fn test_resolve_currency_prefers_resolver_over_hint() {
        let provider = AlphaVantageProvider::new("test_key".to_string());
        // FX resolver returns the quote currency ("CAD"), which takes priority over hint
        let context = create_test_fx_context(Some("TWD"), "CAD");
        assert_eq!(provider.resolve_currency(&context), "CAD");
    }

    #[test]
    fn test_resolve_currency_falls_back_to_resolver_when_hint_missing() {
        let provider = AlphaVantageProvider::new("test_key".to_string());
        let context = create_test_fx_context(None, "CAD");
        assert_eq!(provider.resolve_currency(&context), "CAD");
    }

    #[test]
    fn test_filter_by_date_range() {
        use rust_decimal_macros::dec;

        let quotes = vec![
            Quote::new(
                Utc.with_ymd_and_hms(2024, 1, 1, 0, 0, 0).unwrap(),
                dec!(100),
                "USD".to_string(),
                PROVIDER_ID.to_string(),
            ),
            Quote::new(
                Utc.with_ymd_and_hms(2024, 1, 15, 0, 0, 0).unwrap(),
                dec!(105),
                "USD".to_string(),
                PROVIDER_ID.to_string(),
            ),
            Quote::new(
                Utc.with_ymd_and_hms(2024, 1, 31, 0, 0, 0).unwrap(),
                dec!(110),
                "USD".to_string(),
                PROVIDER_ID.to_string(),
            ),
        ];

        let start = Utc.with_ymd_and_hms(2024, 1, 10, 0, 0, 0).unwrap();
        let end = Utc.with_ymd_and_hms(2024, 1, 20, 0, 0, 0).unwrap();

        let filtered = AlphaVantageProvider::filter_by_date_range(quotes, start, end);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].close, dec!(105));
    }

    #[test]
    fn test_crypto_daily_quote_parsing() {
        let mut fields = HashMap::new();
        fields.insert(
            "1a. open (USD)".to_string(),
            serde_json::Value::String("45000.00".to_string()),
        );
        fields.insert(
            "2a. high (USD)".to_string(),
            serde_json::Value::String("46000.00".to_string()),
        );
        fields.insert(
            "3a. low (USD)".to_string(),
            serde_json::Value::String("44000.00".to_string()),
        );
        fields.insert(
            "4a. close (USD)".to_string(),
            serde_json::Value::String("45500.00".to_string()),
        );
        fields.insert(
            "5. volume".to_string(),
            serde_json::Value::String("1000000".to_string()),
        );

        let quote = CryptoDailyQuote { fields };

        assert_eq!(quote.get_open().unwrap().to_string(), "45000.00");
        assert_eq!(quote.get_high().unwrap().to_string(), "46000.00");
        assert_eq!(quote.get_low().unwrap().to_string(), "44000.00");
        assert_eq!(quote.get_close().unwrap().to_string(), "45500.00");
        assert_eq!(quote.get_volume().unwrap().to_string(), "1000000");
    }

    #[test]
    fn test_company_overview_parsing() {
        // Note: API returns more fields (CIK, Exchange, Currency) but we only parse what's needed
        let json = r#"{
            "Symbol": "IBM",
            "AssetType": "Common Stock",
            "Name": "International Business Machines Corporation",
            "Description": "International Business Machines Corporation provides integrated solutions.",
            "Country": "USA",
            "Sector": "TECHNOLOGY",
            "Industry": "COMPUTER & OFFICE EQUIPMENT",
            "MarketCapitalization": "191234567890",
            "PERatio": "22.5",
            "DividendYield": "0.0455",
            "52WeekHigh": "199.18",
            "52WeekLow": "128.06"
        }"#;

        let response: CompanyOverviewResponse = serde_json::from_str(json).unwrap();
        let profile = response.to_asset_profile();

        assert_eq!(profile.source, Some("ALPHA_VANTAGE".to_string()));
        assert_eq!(
            profile.name,
            Some("International Business Machines Corporation".to_string())
        );
        assert_eq!(profile.sector, Some("TECHNOLOGY".to_string()));
        assert_eq!(
            profile.industry,
            Some("COMPUTER & OFFICE EQUIPMENT".to_string())
        );
        assert_eq!(profile.country, Some("USA".to_string()));
        assert_eq!(profile.market_cap, Some(191234567890.0));
        assert_eq!(profile.pe_ratio, Some(22.5));
        assert_eq!(profile.dividend_yield, Some(0.0455));
        assert_eq!(profile.week_52_high, Some(199.18));
        assert_eq!(profile.week_52_low, Some(128.06));
    }

    #[test]
    fn test_company_overview_with_none_values() {
        let json = r#"{
            "Symbol": "TEST",
            "AssetType": "ETF",
            "Name": "Test ETF",
            "Sector": "None",
            "Industry": "-",
            "PERatio": "None",
            "DividendYield": "0"
        }"#;

        let response: CompanyOverviewResponse = serde_json::from_str(json).unwrap();
        let profile = response.to_asset_profile();

        assert_eq!(profile.name, Some("Test ETF".to_string()));
        // "None" and "-" and "0" values should be parsed as None
        assert_eq!(profile.sector, Some("None".to_string())); // Raw string preserved
        assert_eq!(profile.pe_ratio, None); // Parsed as None
        assert_eq!(profile.dividend_yield, None); // "0" treated as None
    }

    #[test]
    fn test_company_overview_parse_f64() {
        assert_eq!(
            CompanyOverviewResponse::parse_f64(&Some("123.45".to_string())),
            Some(123.45)
        );
        assert_eq!(
            CompanyOverviewResponse::parse_f64(&Some("None".to_string())),
            None
        );
        assert_eq!(
            CompanyOverviewResponse::parse_f64(&Some("-".to_string())),
            None
        );
        assert_eq!(
            CompanyOverviewResponse::parse_f64(&Some("0".to_string())),
            None
        );
        assert_eq!(
            CompanyOverviewResponse::parse_f64(&Some("".to_string())),
            None
        );
        assert_eq!(CompanyOverviewResponse::parse_f64(&None), None);
    }

    #[test]
    fn test_etf_profile_parsing() {
        let json = r#"{
            "sectors": [
                {"sector": "Information Technology", "weight": "51.1%"},
                {"sector": "Communication Services", "weight": "16.3%"},
                {"sector": "Consumer Discretionary", "weight": "12.3%"},
                {"sector": "Healthcare", "weight": "5.3%"}
            ],
            "holdings": [],
            "dividend_yield": "0.46%"
        }"#;

        let response: EtfProfileResponse = serde_json::from_str(json).unwrap();
        let profile = response.to_asset_profile("QQQ");

        assert_eq!(profile.source, Some("ALPHA_VANTAGE".to_string()));
        assert_eq!(profile.quote_type, Some("ETF".to_string()));
        assert!(profile.sectors.is_some());

        // Verify sectors JSON is properly formatted
        let sectors_json = profile.sectors.unwrap();
        let sectors: Vec<serde_json::Value> = serde_json::from_str(&sectors_json).unwrap();
        assert_eq!(sectors.len(), 4);
        assert_eq!(sectors[0]["name"], "Information Technology");
        assert!((sectors[0]["weight"].as_f64().unwrap() - 0.511).abs() < 0.001);

        // Verify dividend yield is parsed from percentage
        assert!((profile.dividend_yield.unwrap() - 0.0046).abs() < 0.0001);
    }

    #[test]
    fn test_etf_profile_parse_weight() {
        // Test percentage format
        assert!((EtfProfileResponse::parse_weight("51.1%").unwrap() - 0.511).abs() < 0.001);
        assert!((EtfProfileResponse::parse_weight("0.46%").unwrap() - 0.0046).abs() < 0.0001);

        // Test decimal format
        assert!((EtfProfileResponse::parse_weight("0.511").unwrap() - 0.511).abs() < 0.001);

        // Test edge cases
        assert!(EtfProfileResponse::parse_weight("invalid").is_none());
    }

    #[test]
    fn test_symbol_search_response_parsing() {
        let json = r#"{
            "bestMatches": [
                {
                    "1. symbol": "MSFT",
                    "2. name": "Microsoft Corporation",
                    "3. type": "Equity",
                    "4. region": "United States",
                    "5. marketOpen": "09:30",
                    "6. marketClose": "16:00",
                    "7. timezone": "UTC-04",
                    "8. currency": "USD",
                    "9. matchScore": "1.0000"
                },
                {
                    "1. symbol": "MSF.DE",
                    "2. name": "Microsoft Corporation",
                    "3. type": "Equity",
                    "4. region": "Germany",
                    "5. marketOpen": "08:00",
                    "6. marketClose": "20:00",
                    "7. timezone": "UTC+02",
                    "8. currency": "EUR",
                    "9. matchScore": "0.6667"
                }
            ]
        }"#;

        let response: SymbolSearchResponse = serde_json::from_str(json).unwrap();
        let matches = response.best_matches.unwrap();

        assert_eq!(matches.len(), 2);

        // First match
        assert_eq!(matches[0].symbol, "MSFT");
        assert_eq!(matches[0].name, "Microsoft Corporation");
        assert_eq!(matches[0].asset_type, "Equity");
        assert_eq!(matches[0].region, "United States");
        assert_eq!(matches[0].currency, "USD");
        assert_eq!(matches[0].match_score, "1.0000");

        // Second match
        assert_eq!(matches[1].symbol, "MSF.DE");
        assert_eq!(matches[1].region, "Germany");
        assert_eq!(matches[1].currency, "EUR");
        assert_eq!(matches[1].match_score, "0.6667");
    }

    #[test]
    fn test_symbol_search_empty_response() {
        let json = r#"{"bestMatches": []}"#;
        let response: SymbolSearchResponse = serde_json::from_str(json).unwrap();
        assert!(response.best_matches.unwrap().is_empty());
    }

    #[test]
    fn test_extract_underlying_from_occ() {
        assert_eq!(
            AlphaVantageProvider::extract_underlying_from_occ("AAPL250321C00150000"),
            "AAPL"
        );
        assert_eq!(
            AlphaVantageProvider::extract_underlying_from_occ("IBM270115P00390000"),
            "IBM"
        );
        assert_eq!(
            AlphaVantageProvider::extract_underlying_from_occ("GOOGL250620C01500000"),
            "GOOGL"
        );
        // Edge case: 1-char underlying
        assert_eq!(
            AlphaVantageProvider::extract_underlying_from_occ("X250321C00050000"),
            "X"
        );
        // Space-padded OCC symbol — underlying should be trimmed
        assert_eq!(
            AlphaVantageProvider::extract_underlying_from_occ("TSLA  250321C00250000"),
            "TSLA"
        );
    }

    #[test]
    fn test_options_response_parsing() {
        let json = r#"{
            "data": [{
                "contractID": "IBM270115C00390000",
                "symbol": "IBM",
                "expiration": "2027-01-15",
                "strike": "390.00",
                "type": "call",
                "last": "25.50",
                "mark": "25.75",
                "bid": "25.40",
                "ask": "26.10",
                "volume": "1500",
                "open_interest": "5000",
                "date": "2025-03-07"
            }]
        }"#;
        let response: OptionsResponse = serde_json::from_str(json).unwrap();
        assert!(response.error_message.is_none());
        let data = response.data.unwrap();
        assert_eq!(data.len(), 1);
        assert_eq!(data[0].last.as_deref(), Some("25.50"));
        assert_eq!(data[0].mark.as_deref(), Some("25.75"));
        assert_eq!(data[0].volume.as_deref(), Some("1500"));
    }
}
