//! Boerse Frankfurt (Deutsche Boerse) market data provider.
//!
//! Covers equities, ETFs, and bonds traded on Xetra (XETR) and Frankfurt (XFRA)
//! via the Deutsche Boerse TradingView UDF protocol and price_information endpoint.
//! No API key required — only a browser User-Agent header.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use log::debug;
use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT};
use reqwest::Client;
use rust_decimal::Decimal;
use serde::Deserialize;
use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use urlencoding::encode;

use crate::errors::MarketDataError;
use crate::models::{
    AssetProfile, Coverage, InstrumentId, InstrumentKind, ProviderId, ProviderInstrument, Quote,
    QuoteContext, SearchResult,
};
use crate::provider::{MarketDataProvider, ProviderCapabilities, RateLimit};
use crate::registry::{RateLimitConfig, RateLimiter};

const PROVIDER_ID: &str = "BOERSE_FRANKFURT";
const BASE_URL: &str = "https://api.live.deutsche-boerse.com/v1";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
    AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// Response structs
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct TvSearchResult {
    symbol: String,
    description: String,
    exchange: String,
    #[serde(rename = "type")]
    instrument_type: String,
}

#[derive(Debug, Deserialize)]
struct TvSymbolInfo {
    #[allow(dead_code)]
    name: String,
    #[allow(dead_code)]
    exchange: String,
    description: String,
    #[allow(dead_code)]
    currency_code: String,
    #[allow(dead_code)]
    pricescale: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct TvHistoryResponse {
    s: String,
    #[serde(default)]
    t: Vec<i64>,
    #[serde(default)]
    o: Vec<f64>,
    #[serde(default)]
    h: Vec<f64>,
    #[serde(default)]
    l: Vec<f64>,
    #[serde(default)]
    c: Vec<f64>,
    #[serde(default)]
    v: Vec<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PriceInfoResponse {
    #[allow(dead_code)]
    isin: Option<String>,
    last_price: Option<f64>,
    timestamp_last_price: Option<String>,
    day_high: Option<f64>,
    day_low: Option<f64>,
    #[serde(default)]
    traded_in_percent: bool,
    currency: Option<PriceInfoCurrency>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PriceInfoCurrency {
    original_value: String,
}

// ---------------------------------------------------------------------------
// Provider struct
// ---------------------------------------------------------------------------

pub struct BoerseFrankfurtProvider {
    client: Client,
    isin_cache: Arc<RwLock<HashMap<String, String>>>,
    request_limiter: RateLimiter,
}

impl Default for BoerseFrankfurtProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl BoerseFrankfurtProvider {
    pub fn new() -> Self {
        let client = Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .default_headers(default_headers())
            .build()
            .unwrap_or_else(|_| Client::new());
        let request_limiter = RateLimiter::new();
        let provider_id: ProviderId = Cow::Borrowed(PROVIDER_ID);
        request_limiter.configure(
            &provider_id,
            RateLimitConfig {
                requests_per_minute: 30,
                // Allow a small burst, but still meter actual outbound BF HTTP calls.
                burst_capacity: 2.0,
            },
        );

        Self {
            client,
            isin_cache: Arc::new(RwLock::new(HashMap::new())),
            request_limiter,
        }
    }

    async fn send_get(&self, url: &str) -> Result<reqwest::Response, MarketDataError> {
        let provider_id: ProviderId = Cow::Borrowed(PROVIDER_ID);
        self.request_limiter.acquire(&provider_id).await;
        self.client
            .get(url)
            .send()
            .await
            .map_err(|e| MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("HTTP request failed: {}", e),
            })
    }

    /// Resolve a ticker to an ISIN. Checks cache first, then whether it already
    /// looks like an ISIN, and finally falls back to the search endpoint.
    async fn resolve_isin(&self, symbol: &str, mic: &str) -> Result<String, MarketDataError> {
        let cache_key = format!(
            "{}:{}",
            mic.trim().to_uppercase(),
            symbol.trim().to_uppercase()
        );

        // Check cache
        {
            let cache = self.isin_cache.read().await;
            if let Some(isin) = cache.get(&cache_key) {
                return Ok(isin.clone());
            }
        }

        // Already an ISIN?
        if looks_like_isin(symbol) {
            return Ok(symbol.to_string());
        }

        // Search fallback
        let url = format!(
            "{}/tradingview/search?query={}&limit=5",
            BASE_URL,
            encode(symbol)
        );
        let resp = self.send_get(&url).await?;

        if !resp.status().is_success() {
            return Err(MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("Search returned HTTP {}", resp.status()),
            });
        }

        let results: Vec<TvSearchResult> =
            resp.json()
                .await
                .map_err(|e| MarketDataError::ProviderError {
                    provider: PROVIDER_ID.to_string(),
                    message: format!("Search JSON parse error: {}", e),
                })?;

        // Only accept an exact venue match. Falling back to another venue can
        // silently map the asset to the wrong security.
        let isin = results
            .iter()
            .find_map(|r| {
                map_german_type(&r.instrument_type)?;
                let (r_mic, r_isin) = r.symbol.split_once(':')?;
                if r_mic == mic {
                    Some(r_isin.to_string())
                } else {
                    None
                }
            })
            .ok_or_else(|| MarketDataError::SymbolNotFound(format!("{}@{}", symbol, mic)))?;

        // Cache it
        {
            let mut cache = self.isin_cache.write().await;
            cache.insert(cache_key, isin.clone());
        }

        Ok(isin)
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn default_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(UA));
    headers
}

/// Extract (mic, symbol) from a ProviderInstrument, using the QuoteContext
/// to recover the canonical MIC when the instrument doesn't encode one.
fn parse_mic_symbol(
    instrument: &ProviderInstrument,
    context: &QuoteContext,
) -> Result<(String, String), MarketDataError> {
    match instrument {
        ProviderInstrument::BondIsin { isin } => Ok(("XFRA".to_string(), isin.to_string())),
        ProviderInstrument::EquitySymbol { symbol } => {
            if let Some((mic, rest)) = symbol.split_once(':') {
                Ok((mic.to_string(), rest.to_string()))
            } else {
                // No MIC in the symbol — read from the canonical instrument.
                let mic = match &context.instrument {
                    InstrumentId::Equity { mic, .. } => {
                        mic.as_deref().unwrap_or("XETR").to_string()
                    }
                    _ => "XETR".to_string(),
                };
                Ok((mic, symbol.to_string()))
            }
        }
        _ => Err(MarketDataError::UnsupportedAssetType(format!(
            "{:?}",
            instrument
        ))),
    }
}

/// Check if a string looks like an ISIN (2 uppercase letters + 10 alphanumeric).
fn looks_like_isin(s: &str) -> bool {
    s.len() == 12
        && s[..2].chars().all(|c| c.is_ascii_uppercase())
        && s[2..].chars().all(|c| c.is_ascii_alphanumeric())
}

/// Map German instrument type names to standard asset types.
/// Returns None for types this provider cannot serve (Index, FX, Commodity).
fn map_german_type(t: &str) -> Option<&'static str> {
    match t {
        "Aktie" => Some("EQUITY"),
        "ETP" => Some("ETF"),
        "Anleihe" => Some("BOND"),
        "Fonds" => Some("MUTUALFUND"),
        _ => None,
    }
}

/// Check if the context instrument is a bond.
fn is_bond_context(context: &QuoteContext) -> bool {
    matches!(context.instrument, InstrumentId::Bond { .. })
}

// ---------------------------------------------------------------------------
// MarketDataProvider impl
// ---------------------------------------------------------------------------

#[async_trait]
impl MarketDataProvider for BoerseFrankfurtProvider {
    fn id(&self) -> &'static str {
        PROVIDER_ID
    }

    fn priority(&self) -> u8 {
        15
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            instrument_kinds: &[InstrumentKind::Equity, InstrumentKind::Bond],
            coverage: Coverage::dach_exchanges(),
            supports_latest: true,
            supports_historical: true,
            supports_search: false,
            supports_profile: true,
            supports_dividends: false,
        }
    }

    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_minute: 30,
            max_concurrency: 2,
            min_delay: Duration::from_secs(2),
        }
    }

    async fn get_latest_quote(
        &self,
        context: &QuoteContext,
        instrument: ProviderInstrument,
    ) -> Result<Quote, MarketDataError> {
        let (mic, symbol) = parse_mic_symbol(&instrument, context)?;
        let isin = self.resolve_isin(&symbol, &mic).await?;

        let url = format!(
            "{}/data/price_information/single?isin={}&mic={}",
            BASE_URL, isin, mic
        );

        debug!("BF get_latest_quote: {}", url);

        let resp = self.send_get(&url).await?;

        if !resp.status().is_success() {
            return Err(MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("HTTP {}", resp.status()),
            });
        }

        let body: PriceInfoResponse =
            resp.json()
                .await
                .map_err(|e| MarketDataError::ProviderError {
                    provider: PROVIDER_ID.to_string(),
                    message: format!("JSON parse error: {}", e),
                })?;

        let raw_price = body
            .last_price
            .ok_or_else(|| MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: "No lastPrice in response".to_string(),
            })?;

        let price = if body.traded_in_percent {
            raw_price / 100.0
        } else {
            raw_price
        };

        let close = Decimal::try_from(price).map_err(|_| MarketDataError::ValidationFailed {
            message: format!("Failed to convert price {} to decimal", price),
        })?;

        let high = body.day_high.and_then(|v| {
            let v = if body.traded_in_percent { v / 100.0 } else { v };
            Decimal::try_from(v).ok()
        });

        let low = body.day_low.and_then(|v| {
            let v = if body.traded_in_percent { v / 100.0 } else { v };
            Decimal::try_from(v).ok()
        });

        let currency = body
            .currency
            .map(|c| c.original_value)
            .or_else(|| context.currency_hint.as_ref().map(|c| c.to_string()))
            .unwrap_or_else(|| "EUR".to_string());

        let timestamp = body
            .timestamp_last_price
            .and_then(|ts| DateTime::parse_from_rfc3339(&ts).ok())
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or_else(Utc::now);

        Ok(Quote {
            timestamp,
            open: None,
            high,
            low,
            close,
            volume: None,
            currency,
            source: PROVIDER_ID.to_string(),
        })
    }

    async fn get_historical_quotes(
        &self,
        context: &QuoteContext,
        instrument: ProviderInstrument,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<Quote>, MarketDataError> {
        let (mic, symbol) = parse_mic_symbol(&instrument, context)?;
        let isin = self.resolve_isin(&symbol, &mic).await?;

        let tv_symbol = format!("{}:{}", mic, isin);
        let url = format!(
            "{}/tradingview/history?symbol={}&resolution=1D&from={}&to={}",
            BASE_URL,
            encode(&tv_symbol),
            start.timestamp(),
            end.timestamp()
        );

        debug!("BF get_historical_quotes: {}", url);

        let resp = self.send_get(&url).await?;

        if !resp.status().is_success() {
            return Err(MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("HTTP {}", resp.status()),
            });
        }

        let body: TvHistoryResponse =
            resp.json()
                .await
                .map_err(|e| MarketDataError::ProviderError {
                    provider: PROVIDER_ID.to_string(),
                    message: format!("JSON parse error: {}", e),
                })?;

        if body.s != "ok" {
            return Err(MarketDataError::SymbolNotFound(tv_symbol));
        }

        let bond = is_bond_context(context);
        let currency = context
            .currency_hint
            .as_ref()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "EUR".to_string());

        let len = body.t.len();
        let mut quotes = Vec::with_capacity(len);

        for i in 0..len {
            let ts = body.t[i];
            let timestamp = DateTime::from_timestamp(ts, 0).unwrap_or_else(Utc::now);

            let divisor = if bond { 100.0 } else { 1.0 };

            let close = Decimal::try_from(body.c.get(i).copied().unwrap_or(0.0) / divisor)
                .map_err(|_| MarketDataError::ValidationFailed {
                    message: format!("Failed to convert close to decimal at index {}", i),
                })?;

            let open = body
                .o
                .get(i)
                .and_then(|&v| Decimal::try_from(v / divisor).ok());
            let high = body
                .h
                .get(i)
                .and_then(|&v| Decimal::try_from(v / divisor).ok());
            let low = body
                .l
                .get(i)
                .and_then(|&v| Decimal::try_from(v / divisor).ok());
            let volume = body.v.get(i).and_then(|&v| Decimal::try_from(v).ok());

            quotes.push(Quote {
                timestamp,
                open,
                high,
                low,
                close,
                volume,
                currency: currency.clone(),
                source: PROVIDER_ID.to_string(),
            });
        }

        Ok(quotes)
    }

    async fn search(&self, query: &str) -> Result<Vec<SearchResult>, MarketDataError> {
        let url = format!(
            "{}/tradingview/search?query={}&limit=10",
            BASE_URL,
            encode(query)
        );

        let resp = self.send_get(&url).await?;

        if !resp.status().is_success() {
            return Err(MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("HTTP {}", resp.status()),
            });
        }

        let results: Vec<TvSearchResult> =
            resp.json()
                .await
                .map_err(|e| MarketDataError::ProviderError {
                    provider: PROVIDER_ID.to_string(),
                    message: format!("JSON parse error: {}", e),
                })?;

        Ok(results
            .into_iter()
            .filter_map(|r| {
                let asset_type = map_german_type(&r.instrument_type)?;
                let (mic, isin) = r.symbol.split_once(':')?;

                Some(
                    SearchResult::new(isin.to_string(), r.description, &r.exchange, asset_type)
                        .with_exchange_mic(mic.to_string())
                        .with_data_source(PROVIDER_ID),
                )
            })
            .collect())
    }

    async fn get_profile(&self, symbol: &str) -> Result<AssetProfile, MarketDataError> {
        // symbol arrives as "MIC:ticker", "MIC:ISIN", bare ISIN, or bare ticker.
        // Resolve to "MIC:ISIN" for the TradingView symbols endpoint.
        let (mic, sym) = if let Some((m, s)) = symbol.split_once(':') {
            (m.to_string(), s.to_string())
        } else if looks_like_isin(symbol) {
            ("XFRA".to_string(), symbol.to_string())
        } else {
            ("XETR".to_string(), symbol.to_string())
        };

        let isin = self.resolve_isin(&sym, &mic).await?;
        let tv_symbol = format!("{}:{}", mic, isin);

        let url = format!(
            "{}/tradingview/symbols?symbol={}",
            BASE_URL,
            encode(&tv_symbol)
        );

        let resp = self.send_get(&url).await?;

        if !resp.status().is_success() {
            return Err(MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("HTTP {}", resp.status()),
            });
        }

        let info: TvSymbolInfo = resp
            .json()
            .await
            .map_err(|e| MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("JSON parse error: {}", e),
            })?;

        let mut profile = AssetProfile {
            source: Some(PROVIDER_ID.to_string()),
            name: Some(info.description),
            ..Default::default()
        };

        if looks_like_isin(&isin) {
            profile = profile.isin(isin);
        }

        Ok(profile)
    }
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;

    use super::*;

    fn dummy_equity_context(mic: Option<&'static str>) -> QuoteContext {
        QuoteContext {
            instrument: InstrumentId::Equity {
                ticker: Arc::from("X"),
                mic: mic.map(Cow::Borrowed),
            },
            identifiers: Default::default(),
            overrides: None,
            currency_hint: None,
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        }
    }

    fn dummy_bond_context() -> QuoteContext {
        QuoteContext {
            instrument: InstrumentId::Bond {
                isin: Arc::from("X"),
            },
            identifiers: Default::default(),
            overrides: None,
            currency_hint: None,
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        }
    }

    #[test]
    fn test_provider_id() {
        let provider = BoerseFrankfurtProvider::new();
        assert_eq!(provider.id(), "BOERSE_FRANKFURT");
    }

    #[test]
    fn test_provider_priority() {
        let provider = BoerseFrankfurtProvider::new();
        assert_eq!(provider.priority(), 15);
    }

    #[test]
    fn test_capabilities() {
        let provider = BoerseFrankfurtProvider::new();
        let caps = provider.capabilities();
        assert_eq!(
            caps.instrument_kinds,
            &[InstrumentKind::Equity, InstrumentKind::Bond]
        );
        assert!(caps.supports_latest);
        assert!(caps.supports_historical);
        assert!(!caps.supports_search);
        assert!(caps.supports_profile);
    }

    #[test]
    fn test_rate_limit() {
        let provider = BoerseFrankfurtProvider::new();
        let rl = provider.rate_limit();
        assert_eq!(rl.requests_per_minute, 30);
        assert_eq!(rl.max_concurrency, 2);
        assert_eq!(rl.min_delay, Duration::from_secs(2));
    }

    #[test]
    fn test_parse_mic_symbol_bond() {
        let ctx = dummy_bond_context();
        let instrument = ProviderInstrument::BondIsin {
            isin: Arc::from("XS2530331413"),
        };
        let (mic, isin) = parse_mic_symbol(&instrument, &ctx).unwrap();
        assert_eq!(mic, "XFRA");
        assert_eq!(isin, "XS2530331413");
    }

    #[test]
    fn test_parse_mic_symbol_equity_with_mic_in_symbol() {
        let ctx = dummy_equity_context(Some("XETR"));
        let instrument = ProviderInstrument::EquitySymbol {
            symbol: Arc::from("XETR:IE00BTJRMP35"),
        };
        let (mic, isin) = parse_mic_symbol(&instrument, &ctx).unwrap();
        assert_eq!(mic, "XETR");
        assert_eq!(isin, "IE00BTJRMP35");
    }

    #[test]
    fn test_parse_mic_symbol_bare_reads_context_mic() {
        let ctx = dummy_equity_context(Some("XFRA"));
        let instrument = ProviderInstrument::EquitySymbol {
            symbol: Arc::from("XDWD"),
        };
        let (mic, sym) = parse_mic_symbol(&instrument, &ctx).unwrap();
        assert_eq!(mic, "XFRA");
        assert_eq!(sym, "XDWD");
    }

    #[test]
    fn test_parse_mic_symbol_bare_defaults_to_xetr() {
        let ctx = dummy_equity_context(None);
        let instrument = ProviderInstrument::EquitySymbol {
            symbol: Arc::from("SAP"),
        };
        let (mic, sym) = parse_mic_symbol(&instrument, &ctx).unwrap();
        assert_eq!(mic, "XETR");
        assert_eq!(sym, "SAP");
    }

    #[test]
    fn test_looks_like_isin_positive() {
        assert!(looks_like_isin("IE00BTJRMP35"));
        assert!(looks_like_isin("DE0007164600"));
        assert!(looks_like_isin("XS2530331413"));
        assert!(looks_like_isin("US0378331005"));
    }

    #[test]
    fn test_looks_like_isin_negative() {
        assert!(!looks_like_isin("AAPL"));
        assert!(!looks_like_isin("XDWD"));
        assert!(!looks_like_isin("ie00btjrmp35")); // lowercase
        assert!(!looks_like_isin("IE00BTJRMP3")); // too short
        assert!(!looks_like_isin("IE00BTJRMP355")); // too long
    }

    #[test]
    fn test_map_german_type() {
        assert_eq!(map_german_type("Aktie"), Some("EQUITY"));
        assert_eq!(map_german_type("ETP"), Some("ETF"));
        assert_eq!(map_german_type("Anleihe"), Some("BOND"));
        assert_eq!(map_german_type("Fonds"), Some("MUTUALFUND"));
        assert_eq!(map_german_type("Index"), None);
        assert_eq!(map_german_type("Rohstoff"), None);
        assert_eq!(map_german_type("unknown"), None);
    }

    #[test]
    fn test_parse_price_info_response() {
        let json = r#"{
            "isin": "IE00BTJRMP35",
            "lastPrice": 70.02,
            "timestampLastPrice": "2026-03-14T15:42:00+01:00",
            "dayHigh": 70.2,
            "dayLow": 68.38,
            "tradedInPercent": false,
            "currency": { "originalValue": "EUR" }
        }"#;

        let resp: PriceInfoResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.last_price, Some(70.02));
        assert!(!resp.traded_in_percent);
        assert_eq!(resp.currency.unwrap().original_value, "EUR");
    }

    #[test]
    fn test_parse_price_info_bond_traded_in_percent() {
        let json = r#"{
            "isin": "XS2530331413",
            "lastPrice": 97.025,
            "timestampLastPrice": "2026-03-14T15:42:00+01:00",
            "dayHigh": 97.135,
            "dayLow": 97.04,
            "tradedInPercent": true,
            "currency": { "originalValue": "EUR" }
        }"#;

        let resp: PriceInfoResponse = serde_json::from_str(json).unwrap();
        assert!(resp.traded_in_percent);

        // Verify /100 conversion
        let raw = resp.last_price.unwrap();
        let converted = raw / 100.0;
        let dec = Decimal::try_from(converted).unwrap();
        assert_eq!(dec.to_string(), "0.97025");
    }

    #[test]
    fn test_parse_tv_history_response() {
        let json = r#"{
            "s": "ok",
            "t": [1772528400, 1772614800],
            "o": [68.45, 69.83],
            "h": [70.2, 70.29],
            "l": [68.38, 68.45],
            "c": [70.02, 69.06],
            "v": [11292866.27, 6062156.3]
        }"#;

        let resp: TvHistoryResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.s, "ok");
        assert_eq!(resp.t.len(), 2);
        assert_eq!(resp.c[0], 70.02);
        assert_eq!(resp.v[1], 6062156.3);
    }

    #[test]
    fn test_parse_tv_search_response() {
        let json = r#"[
            {
                "symbol": "XETR:DE0007164600",
                "full_name": "XETR:DE0007164600",
                "description": "SAP SE",
                "exchange": "Xetra",
                "type": "Aktie"
            }
        ]"#;

        let results: Vec<TvSearchResult> = serde_json::from_str(json).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].symbol, "XETR:DE0007164600");
        assert_eq!(results[0].description, "SAP SE");
        assert_eq!(results[0].instrument_type, "Aktie");
    }

    #[test]
    fn test_parse_tv_symbol_info() {
        let json = r#"{
            "name": "IE00BTJRMP35",
            "exchange": "XETR",
            "description": "Xtrackers MSCI Emerging Markets UCITS ETF 1C",
            "currency_code": "EUR",
            "session": "0900-1730",
            "pricescale": 1000.0,
            "has_daily": true,
            "supported_resolutions": ["15", "60", "1D", "1W", "3M"]
        }"#;

        let info: TvSymbolInfo = serde_json::from_str(json).unwrap();
        assert_eq!(
            info.description,
            "Xtrackers MSCI Emerging Markets UCITS ETF 1C"
        );
        assert_eq!(info.currency_code, "EUR");
    }

    #[test]
    fn test_resolve_isin_requires_exact_mic_match() {
        let results = [
            TvSearchResult {
                symbol: "XFRA:DE0007164600".to_string(),
                description: "SAP SE".to_string(),
                exchange: "Frankfurt".to_string(),
                instrument_type: "Aktie".to_string(),
            },
            TvSearchResult {
                symbol: "XETR:DE0007164600".to_string(),
                description: "SAP SE".to_string(),
                exchange: "Xetra".to_string(),
                instrument_type: "Aktie".to_string(),
            },
        ];

        let isin = results.iter().find_map(|r| {
            map_german_type(&r.instrument_type)?;
            let (r_mic, r_isin) = r.symbol.split_once(':')?;
            (r_mic == "XETR").then(|| r_isin.to_string())
        });
        assert_eq!(isin.as_deref(), Some("DE0007164600"));

        let missing = results.iter().find_map(|r| {
            map_german_type(&r.instrument_type)?;
            let (r_mic, r_isin) = r.symbol.split_once(':')?;
            (r_mic == "XPAR").then(|| r_isin.to_string())
        });
        assert!(missing.is_none());
    }
}
