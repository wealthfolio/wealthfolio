//! MarketData.app provider implementation.
//!
//! This provider fetches market data from MarketData.app API.
//! It supports equities only with Bearer token authentication.
//!
//! # API Endpoints
//!
//! - Latest price: `https://api.marketdata.app/v1/stocks/prices/{symbol}/`
//! - Historical candles: `https://api.marketdata.app/v1/stocks/candles/D/{symbol}?from={start_date}&to={end_date}`
//!
//! # Response Format
//!
//! The API returns parallel arrays for OHLCV data with a status field `s` indicating success ("ok") or error.

use async_trait::async_trait;
use chrono::{DateTime, TimeZone, Utc};
use log::warn;
use reqwest::Client;
use rust_decimal::Decimal;
use serde::Deserialize;

use crate::SymbolResolver;
use std::time::Duration;

use crate::errors::MarketDataError;
use crate::models::{Coverage, InstrumentKind, ProviderInstrument, Quote, QuoteContext};
use crate::provider::{MarketDataProvider, ProviderCapabilities, RateLimit};
use crate::resolver::ResolverChain;

const BASE_URL: &str = "https://api.marketdata.app/v1";
const PROVIDER_ID: &str = "MARKETDATA_APP";

/// Default HTTP request timeout
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Response from the candles endpoint for historical data.
#[derive(Debug, Deserialize)]
struct CandlesResponse {
    /// Status: "ok" or error message
    s: String,
    /// Open prices
    #[serde(default)]
    o: Option<Vec<f64>>,
    /// High prices
    #[serde(default)]
    h: Option<Vec<f64>>,
    /// Low prices
    #[serde(default)]
    l: Option<Vec<f64>>,
    /// Close prices
    #[serde(default)]
    c: Option<Vec<f64>>,
    /// Volume
    #[serde(default)]
    v: Option<Vec<f64>>,
    /// Unix timestamps
    #[serde(default)]
    t: Option<Vec<i64>>,
}

/// Response from the prices endpoint for latest quote.
#[derive(Debug, Deserialize)]
struct PriceResponse {
    /// Status: "ok" or error message
    s: String,
    /// Mid price (average of bid and ask)
    #[serde(default)]
    mid: Option<Vec<f64>>,
    /// Unix timestamps of last update
    #[serde(default)]
    updated: Option<Vec<i64>>,
}

/// MarketData.app provider for fetching equity market data.
///
/// # Example
///
/// ```ignore
/// let provider = MarketDataAppProvider::new("your-api-key".to_string());
/// let quote = provider.get_latest_quote(&context, instrument).await?;
/// ```
pub struct MarketDataAppProvider {
    client: Client,
    api_key: String,
}

impl MarketDataAppProvider {
    /// Create a new MarketData.app provider with the given API key.
    pub fn new(api_key: String) -> Self {
        let client = Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .unwrap_or_else(|_| Client::new());

        Self { client, api_key }
    }

    /// Extract symbol from ProviderInstrument, returning an error for unsupported types.
    fn extract_symbol(instrument: &ProviderInstrument) -> Result<String, MarketDataError> {
        match instrument {
            ProviderInstrument::EquitySymbol { symbol } => Ok(symbol.to_string()),
            _ => Err(MarketDataError::UnsupportedAssetType(format!(
                "MarketData.app only supports equities, got: {:?}",
                instrument
            ))),
        }
    }

    /// Fetch data from the API with Bearer token authentication.
    async fn fetch(&self, url: &str) -> Result<String, MarketDataError> {
        let response = self
            .client
            .get(url)
            .bearer_auth(&self.api_key)
            .send()
            .await
            .map_err(|e| MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: e.to_string(),
            })?;

        // Check for rate limiting
        if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err(MarketDataError::RateLimited {
                provider: PROVIDER_ID.to_string(),
            });
        }

        // Check for other HTTP errors
        if !response.status().is_success() {
            return Err(MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("HTTP error: {}", response.status()),
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
    fn get_currency(context: &QuoteContext) -> String {
        let chain = ResolverChain::new();
        chain
            .get_currency(&PROVIDER_ID.into(), context)
            .or_else(|| context.currency_hint.clone())
            .map(|c| c.to_string())
            .unwrap_or_else(|| "USD".to_string())
    }

    fn historical_candles_url(symbol: &str, start: &str, end: &str) -> String {
        format!(
            "{}/stocks/candles/D/{}?from={}&to={}&adjustsplits=true&adjustdividends=false",
            BASE_URL, symbol, start, end
        )
    }
}

#[async_trait]
impl MarketDataProvider for MarketDataAppProvider {
    fn id(&self) -> &'static str {
        PROVIDER_ID
    }

    fn priority(&self) -> u8 {
        2
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            instrument_kinds: &[InstrumentKind::Equity],
            // Use best_effort to accept instruments without MIC codes
            coverage: Coverage::us_only_best_effort(),
            supports_latest: true,
            supports_historical: true,
            supports_search: false,
            supports_profile: false,
            supports_dividends: false,
        }
    }

    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_minute: 100,
            max_concurrency: 10,
            min_delay: Duration::from_millis(100),
        }
    }

    async fn get_latest_quote(
        &self,
        context: &QuoteContext,
        instrument: ProviderInstrument,
    ) -> Result<Quote, MarketDataError> {
        let symbol = Self::extract_symbol(&instrument)?;
        let url = format!("{}/stocks/prices/{}/", BASE_URL, symbol);

        let response_text = self.fetch(&url).await?;
        let price_resp: PriceResponse =
            serde_json::from_str(&response_text).map_err(|e| MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("Failed to parse response: {}", e),
            })?;

        if price_resp.s != "ok" {
            return Err(MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("API returned status: {}", price_resp.s),
            });
        }

        // Extract the mid price from the response
        let mid_price = price_resp
            .mid
            .as_ref()
            .and_then(|arr| arr.first())
            .ok_or_else(|| MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: "No price data in response".to_string(),
            })?;

        // Extract and validate the timestamp
        let timestamp_unix = price_resp
            .updated
            .as_ref()
            .and_then(|arr| arr.first())
            .copied()
            .ok_or_else(|| MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: "No timestamp in response".to_string(),
            })?;

        let timestamp = Utc
            .timestamp_opt(timestamp_unix, 0)
            .single()
            .ok_or_else(|| MarketDataError::ValidationFailed {
                message: format!("Invalid timestamp: {}", timestamp_unix),
            })?;

        let close = Decimal::from_f64_retain(*mid_price).ok_or_else(|| {
            MarketDataError::ValidationFailed {
                message: format!("Failed to convert price {} to Decimal", mid_price),
            }
        })?;
        let currency = Self::get_currency(context);

        Ok(Quote::new(
            timestamp,
            close,
            currency,
            PROVIDER_ID.to_string(),
        ))
    }

    async fn get_historical_quotes(
        &self,
        context: &QuoteContext,
        instrument: ProviderInstrument,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<Quote>, MarketDataError> {
        let symbol = Self::extract_symbol(&instrument)?;

        let start_str = start.format("%Y-%m-%d").to_string();
        let end_str = end.format("%Y-%m-%d").to_string();

        let url = Self::historical_candles_url(&symbol, &start_str, &end_str);

        let response_text = self.fetch(&url).await?;
        let candles: CandlesResponse =
            serde_json::from_str(&response_text).map_err(|e| MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("Failed to parse response: {}", e),
            })?;

        if candles.s != "ok" {
            return Err(MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("API returned status: {}", candles.s),
            });
        }

        // Extract parallel arrays
        let closes = candles.c.ok_or_else(|| MarketDataError::ProviderError {
            provider: PROVIDER_ID.to_string(),
            message: "No close prices in response".to_string(),
        })?;

        let opens = candles.o.unwrap_or_default();
        let highs = candles.h.unwrap_or_default();
        let lows = candles.l.unwrap_or_default();
        let volumes = candles.v.unwrap_or_default();
        let timestamps = candles.t.unwrap_or_default();

        if closes.is_empty() {
            return Err(MarketDataError::NoDataForRange);
        }

        let currency = Self::get_currency(context);

        // Build quotes from parallel arrays, filtering out invalid prices
        let mut quotes = Vec::with_capacity(closes.len());

        for (i, close) in closes.iter().enumerate() {
            // Close price is required - skip this quote if it can't be converted
            let close_decimal = match Decimal::from_f64_retain(*close) {
                Some(d) => d,
                None => {
                    warn!(
                        "Skipping quote at index {}: failed to convert close price {}",
                        i, close
                    );
                    continue;
                }
            };

            // Skip quotes with missing timestamps to avoid data corruption
            let timestamp_unix = match timestamps.get(i) {
                Some(&ts) if ts > 0 => ts,
                _ => {
                    warn!(
                        "Skipping quote at index {}: missing or invalid timestamp",
                        i
                    );
                    continue;
                }
            };
            let timestamp = match Utc.timestamp_opt(timestamp_unix, 0).single() {
                Some(ts) => ts,
                None => {
                    warn!(
                        "Skipping quote at index {}: failed to parse timestamp {}",
                        i, timestamp_unix
                    );
                    continue;
                }
            };

            // Optional fields - use None if conversion fails
            let open = opens.get(i).and_then(|v| Decimal::from_f64_retain(*v));
            let high = highs.get(i).and_then(|v| Decimal::from_f64_retain(*v));
            let low = lows.get(i).and_then(|v| Decimal::from_f64_retain(*v));
            let volume = volumes.get(i).and_then(|v| Decimal::from_f64_retain(*v));

            quotes.push(Quote {
                timestamp,
                open,
                high,
                low,
                close: close_decimal,
                volume,
                currency: currency.clone(),
                source: PROVIDER_ID.to_string(),
            });
        }

        if quotes.is_empty() {
            return Err(MarketDataError::NoDataForRange);
        }

        // The candles endpoint never includes the current trading day's data.
        // Supplement with the real-time prices endpoint if `end` covers today
        // and the candles don't already include it.
        let today = Utc::now().date_naive();
        let end_date = end.date_naive();
        let last_candle_date = quotes.last().map(|q| q.timestamp.date_naive());

        if end_date >= today && last_candle_date.is_some_and(|d| d < today) {
            match self.get_latest_quote(context, instrument).await {
                Ok(latest) => {
                    // Avoid duplicates: only append if the real-time quote is
                    // newer than the last candle (e.g., skip on weekends when
                    // the prices endpoint returns the same day as the last candle).
                    if latest.timestamp.date_naive() > last_candle_date.unwrap() {
                        quotes.push(latest);
                    }
                }
                Err(e) => warn!(
                    "MarketData.app: failed to fetch current-day price for {}: {}",
                    symbol, e
                ),
            }
        }

        Ok(quotes)
    }
}

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
        let provider = MarketDataAppProvider::new("test-key".to_string());
        assert_eq!(provider.id(), "MARKETDATA_APP");
    }

    #[test]
    fn test_provider_priority() {
        let provider = MarketDataAppProvider::new("test-key".to_string());
        assert_eq!(provider.priority(), 2);
    }

    #[test]
    fn test_capabilities() {
        let provider = MarketDataAppProvider::new("test-key".to_string());
        let caps = provider.capabilities();

        assert_eq!(caps.instrument_kinds, &[InstrumentKind::Equity]);
        assert!(caps.supports_latest);
        assert!(caps.supports_historical);
        assert!(!caps.supports_search);
        assert!(!caps.supports_profile);
    }

    #[test]
    fn test_rate_limit() {
        let provider = MarketDataAppProvider::new("test-key".to_string());
        let rate = provider.rate_limit();

        assert_eq!(rate.requests_per_minute, 100);
        assert_eq!(rate.max_concurrency, 10);
        assert_eq!(rate.min_delay, Duration::from_millis(100));
    }

    #[test]
    fn test_get_currency_prefers_resolver_over_hint() {
        // FX resolver returns the quote currency ("CAD"), which takes priority over hint
        let context = create_test_fx_context(Some("TWD"), "CAD");
        assert_eq!(MarketDataAppProvider::get_currency(&context), "CAD");
    }

    #[test]
    fn test_get_currency_falls_back_to_resolver_when_hint_missing() {
        let context = create_test_fx_context(None, "CAD");
        assert_eq!(MarketDataAppProvider::get_currency(&context), "CAD");
    }

    #[test]
    fn test_extract_symbol_equity() {
        let instrument = ProviderInstrument::EquitySymbol {
            symbol: Arc::from("AAPL"),
        };
        let result = MarketDataAppProvider::extract_symbol(&instrument);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "AAPL");
    }

    #[test]
    fn test_extract_symbol_unsupported() {
        let instrument = ProviderInstrument::CryptoSymbol {
            symbol: Arc::from("BTC-USD"),
        };
        let result = MarketDataAppProvider::extract_symbol(&instrument);
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            MarketDataError::UnsupportedAssetType(_)
        ));
    }

    #[test]
    fn test_historical_candles_url_uses_split_only_adjustment() {
        let url = MarketDataAppProvider::historical_candles_url("NVDA", "2023-07-10", "2023-07-11");

        assert_eq!(
            url,
            "https://api.marketdata.app/v1/stocks/candles/D/NVDA?from=2023-07-10&to=2023-07-11&adjustsplits=true&adjustdividends=false"
        );
    }

    #[test]
    fn test_candles_response_deserialization() {
        let json = r#"{
            "s": "ok",
            "o": [145.0, 146.0],
            "h": [150.0, 151.0],
            "l": [144.0, 145.0],
            "c": [148.0, 149.0],
            "v": [1000000.0, 1100000.0],
            "t": [1640000000, 1640086400]
        }"#;

        let candles: CandlesResponse = serde_json::from_str(json).unwrap();
        assert_eq!(candles.s, "ok");
        assert_eq!(candles.c.unwrap().len(), 2);
    }

    #[test]
    fn test_price_response_deserialization() {
        let json = r#"{
            "s": "ok",
            "mid": [150.25],
            "updated": [1640000000]
        }"#;

        let price: PriceResponse = serde_json::from_str(json).unwrap();
        assert_eq!(price.s, "ok");
        assert_eq!(price.mid.unwrap()[0], 150.25);
    }

    #[test]
    fn test_candles_response_with_error() {
        let json = r#"{
            "s": "no_data"
        }"#;

        let candles: CandlesResponse = serde_json::from_str(json).unwrap();
        assert_eq!(candles.s, "no_data");
        assert!(candles.c.is_none());
    }
}
