//! Metal Price API provider for precious metals market data.
//!
//! This provider fetches real-time precious metal prices from the Metal Price API.
//! It supports the following metals:
//! - XAU (Gold)
//! - XAG (Silver)
//! - XPT (Platinum)
//! - XPD (Palladium)
//! - XRH (Rhodium)
//! - XRU (Ruthenium)
//! - XIR (Iridium)
//! - XOS (Osmium)
//!
//! Supports both real-time (latest) and historical (timeframe) quotes.

use async_trait::async_trait;
use chrono::{DateTime, Duration as ChronoDuration, NaiveDate, TimeZone, Utc};
use reqwest::Client;
use rust_decimal::Decimal;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tokio::sync::Mutex as AsyncMutex;

use tracing::warn;

use crate::errors::MarketDataError;
use crate::models::{Coverage, InstrumentKind, ProviderInstrument, Quote, QuoteContext};
use crate::provider::{MarketDataProvider, ProviderCapabilities, RateLimit};

/// Supported metal symbols
const SUPPORTED_METALS: &[&str] = &["XAU", "XAG", "XPT", "XPD", "XRH", "XRU", "XIR", "XOS"];

/// Provider ID constant
const PROVIDER_ID: &str = "METAL_PRICE_API";

/// One troy ounce in grams (exact definition).
const TROY_OZ_GRAMS: Decimal = Decimal::from_parts(311034768, 0, 0, false, 7);

/// API response from Metal Price API (latest and historical endpoints)
#[derive(Debug, Deserialize)]
struct MetalPriceResponse {
    /// Whether the request was successful
    success: bool,
    /// Base currency used in the request
    #[allow(dead_code)]
    base: String,
    /// Unix timestamp of the quote
    #[allow(dead_code)]
    timestamp: i64,
    /// Rates for requested metals (1 base_currency = rate troy ounces)
    rates: HashMap<String, f64>,
}

/// API response from Metal Price API timeframe endpoint
#[derive(Debug, Deserialize)]
struct MetalPriceTimeframeResponse {
    /// Whether the request was successful
    success: bool,
    /// Rates keyed by date string, then by symbol variants.
    /// Missing when the API returns an error (e.g., plan limit exceeded).
    #[serde(default)]
    rates: HashMap<String, HashMap<String, f64>>,
    /// Error payload, present when `success` is false.
    #[serde(default)]
    error: Option<MetalPriceApiError>,
}

#[derive(Debug, Deserialize)]
struct MetalPriceApiError {
    #[serde(rename = "statusCode")]
    status_code: Option<u16>,
    #[allow(dead_code)]
    message: Option<String>,
}

/// Per-troy-ounce price cached from a prior `/latest` fetch.
#[derive(Clone, Copy)]
struct CachedLatest {
    price_per_oz: Decimal,
    fetched_at: Instant,
    timestamp: DateTime<Utc>,
}

/// How long a cached per-oz latest price is considered fresh. Short enough that
/// the next scheduled resolver sweep re-fetches, long enough that multiple
/// weight variants in a single sweep share one API call.
const LATEST_CACHE_TTL: Duration = Duration::from_secs(300);

/// Cache key for the `/latest` endpoint: (base metal code, quote currency).
type LatestKey = (String, String);

/// Cache key for a single historical per-oz rate.
type HistoricalKey = (String, String, NaiveDate);

/// Plan-limit error codes returned when the requested range exceeds the
/// caller's tier:
///   209 — start date older than 30 days (free tier)
///   421 — total span longer than 5 days (free tier)
const PLAN_LIMIT_STATUS_CODES: &[u16] = &[209, 421];
/// Conservative window we fall back to after a plan-limit rejection.
/// Free tier caps span at 5 days; we use 4 to leave headroom.
const PLAN_LIMIT_MAX_DAYS: i64 = 4;

enum TimeframeFetchError {
    PlanLimit,
    Other { message: String },
}

impl TimeframeFetchError {
    fn into_market_data_error(self) -> MarketDataError {
        match self {
            TimeframeFetchError::PlanLimit => MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: "Plan limit exceeded even at minimum window".to_string(),
            },
            TimeframeFetchError::Other { message } => MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message,
            },
        }
    }
}

/// Metal Price API provider for precious metals market data.
///
/// # Example
///
/// ```ignore
/// use wealthfolio_market_data::provider::metal_price_api::MetalPriceApiProvider;
///
/// let provider = MetalPriceApiProvider::new("your_api_key".to_string());
/// ```
pub struct MetalPriceApiProvider {
    client: Client,
    api_key: String,
    /// Per-troy-ounce latest prices keyed by (base, quote). Shared across all
    /// weight variants of the same metal/currency pair.
    latest_cache: Arc<StdMutex<HashMap<LatestKey, CachedLatest>>>,
    /// Historical per-troy-ounce rates. Past dates never change, so entries
    /// have no TTL; today's date is not cached (rates may still be moving).
    historical_cache: Arc<StdMutex<HashMap<HistoricalKey, Decimal>>>,
    /// Per-key async mutexes used to single-flight in-flight fetches so that
    /// concurrent requests for the same (base, quote) share one API call.
    latest_locks: Arc<StdMutex<HashMap<LatestKey, Arc<AsyncMutex<()>>>>>,
    historical_locks: Arc<StdMutex<HashMap<LatestKey, Arc<AsyncMutex<()>>>>>,
}

/// Default HTTP request timeout
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

impl MetalPriceApiProvider {
    /// Create a new Metal Price API provider with the given API key.
    pub fn new(api_key: String) -> Self {
        let client = Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .unwrap_or_else(|_| Client::new());

        Self {
            client,
            api_key,
            latest_cache: Arc::new(StdMutex::new(HashMap::new())),
            historical_cache: Arc::new(StdMutex::new(HashMap::new())),
            latest_locks: Arc::new(StdMutex::new(HashMap::new())),
            historical_locks: Arc::new(StdMutex::new(HashMap::new())),
        }
    }

    fn key_lock(
        map: &StdMutex<HashMap<LatestKey, Arc<AsyncMutex<()>>>>,
        key: &LatestKey,
    ) -> Arc<AsyncMutex<()>> {
        let mut guard = map.lock().expect("lock map poisoned");
        guard
            .entry(key.clone())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }

    /// Look up a cached latest per-oz price if it's still within TTL.
    fn cached_latest(&self, key: &LatestKey) -> Option<CachedLatest> {
        let cache = self.latest_cache.lock().expect("latest_cache poisoned");
        cache
            .get(key)
            .copied()
            .filter(|c| c.fetched_at.elapsed() < LATEST_CACHE_TTL)
    }

    /// Fetch the per-troy-ounce latest price from the API, using cached values
    /// when fresh and single-flighting concurrent fetches for the same key.
    async fn get_or_fetch_latest_per_oz(
        &self,
        base_code: &str,
        quote_currency: &str,
        raw_symbol: &str,
    ) -> Result<CachedLatest, MarketDataError> {
        let key: LatestKey = (base_code.to_string(), quote_currency.to_string());

        if let Some(hit) = self.cached_latest(&key) {
            return Ok(hit);
        }

        let lock = Self::key_lock(&self.latest_locks, &key);
        let _guard = lock.lock().await;

        if let Some(hit) = self.cached_latest(&key) {
            return Ok(hit);
        }

        let url = format!(
            "https://api.metalpriceapi.com/v1/latest?base={}&currencies={}",
            quote_currency, base_code
        );

        let response = self
            .client
            .get(&url)
            .header("X-API-KEY", &self.api_key)
            .send()
            .await
            .map_err(|e| MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: e.to_string(),
            })?;

        let metal_resp: MetalPriceResponse =
            response
                .json()
                .await
                .map_err(|e| MarketDataError::ProviderError {
                    provider: PROVIDER_ID.to_string(),
                    message: e.to_string(),
                })?;

        if !metal_resp.success {
            warn!(
                provider = PROVIDER_ID,
                symbol = %raw_symbol,
                "Metal Price API latest request failed"
            );
            return Err(MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: "API request failed".to_string(),
            });
        }

        let rate = metal_resp
            .rates
            .get(base_code)
            .ok_or_else(|| MarketDataError::SymbolNotFound(raw_symbol.to_string()))?;

        let price_per_oz = Self::rate_to_price(*rate)?;
        let timestamp = Utc
            .timestamp_opt(metal_resp.timestamp, 0)
            .single()
            .unwrap_or_else(Utc::now);
        let entry = CachedLatest {
            price_per_oz,
            fetched_at: Instant::now(),
            timestamp,
        };

        self.latest_cache
            .lock()
            .expect("latest_cache poisoned")
            .insert(key, entry);

        Ok(entry)
    }

    /// Iterate inclusive dates `[start_date, end_date]`. Bails out at the
    /// natural end of representable dates rather than overflowing.
    fn dates_in_range(start_date: NaiveDate, end_date: NaiveDate) -> Vec<NaiveDate> {
        let mut out = Vec::new();
        let mut d = start_date;
        loop {
            if d > end_date {
                break;
            }
            out.push(d);
            match d.succ_opt() {
                Some(n) => d = n,
                None => break,
            }
        }
        out
    }

    /// Return historical per-oz rates for each date in `[start, end]` for which
    /// the API has a rate. If any past date is missing from the cache (or any
    /// of today's data is needed), fetch the full range from the API, cache
    /// past-date results, and return all known rates.
    async fn get_or_fetch_historical_per_oz(
        &self,
        base_code: &str,
        quote_currency: &str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
        raw_symbol: &str,
    ) -> Result<HashMap<NaiveDate, Decimal>, MarketDataError> {
        let start_date = start.date_naive();
        let end_date = end.date_naive();
        let today = Utc::now().date_naive();
        let dates = Self::dates_in_range(start_date, end_date);

        // Today's rate is never considered cached (still moving).
        let needs_fetch = {
            let cache = self
                .historical_cache
                .lock()
                .expect("historical_cache poisoned");
            dates.iter().any(|d| {
                *d >= today
                    || !cache.contains_key(&(base_code.to_string(), quote_currency.to_string(), *d))
            })
        };

        if needs_fetch {
            let lock_key: LatestKey = (base_code.to_string(), quote_currency.to_string());
            let lock = Self::key_lock(&self.historical_locks, &lock_key);
            let _guard = lock.lock().await;

            let tf_resp = match self
                .fetch_timeframe(quote_currency, base_code, start, end, raw_symbol)
                .await
            {
                Ok(resp) => resp,
                Err(TimeframeFetchError::PlanLimit) => {
                    let clamped_start = end - ChronoDuration::days(PLAN_LIMIT_MAX_DAYS);
                    let clamped_start = if clamped_start > start {
                        clamped_start
                    } else {
                        start
                    };
                    self.fetch_timeframe(quote_currency, base_code, clamped_start, end, raw_symbol)
                        .await
                        .map_err(TimeframeFetchError::into_market_data_error)?
                }
                Err(other) => return Err(other.into_market_data_error()),
            };

            let mut out: HashMap<NaiveDate, Decimal> = HashMap::new();
            let mut cache = self
                .historical_cache
                .lock()
                .expect("historical_cache poisoned");
            for (date_str, rates) in &tf_resp.rates {
                let Some(rate) = rates.get(base_code) else {
                    continue;
                };
                let date = NaiveDate::parse_from_str(date_str, "%Y-%m-%d").map_err(|e| {
                    MarketDataError::ProviderError {
                        provider: PROVIDER_ID.to_string(),
                        message: format!("Invalid date '{}': {}", date_str, e),
                    }
                })?;
                let price_per_oz = Self::rate_to_price(*rate)?;
                out.insert(date, price_per_oz);
                if date < today {
                    cache.insert(
                        (base_code.to_string(), quote_currency.to_string(), date),
                        price_per_oz,
                    );
                }
            }
            // Merge in any other cached entries within the range (the API may
            // have only returned a sub-window after a plan-limit retry).
            for d in &dates {
                if out.contains_key(d) {
                    continue;
                }
                if let Some(rate) =
                    cache.get(&(base_code.to_string(), quote_currency.to_string(), *d))
                {
                    out.insert(*d, *rate);
                }
            }
            return Ok(out);
        }

        let cache = self
            .historical_cache
            .lock()
            .expect("historical_cache poisoned");
        let mut out = HashMap::new();
        for d in &dates {
            if let Some(rate) = cache.get(&(base_code.to_string(), quote_currency.to_string(), *d))
            {
                out.insert(*d, *rate);
            }
        }
        Ok(out)
    }

    /// Parse a metal symbol, returning the base metal code and a troy-ounce
    /// multiplier for weight-suffixed symbols.
    ///
    /// Examples:
    ///   "XAU"      → ("XAU", 1.0)           — price per troy ounce
    ///   "XAU-1KG"  → ("XAU", 32.1507…)      — price per 1 kg bar
    ///   "XAU-500G" → ("XAU", 16.0753…)      — price per 500 g bar
    ///   "XAG-100G" → ("XAG", 3.2150…)       — price per 100 g bar
    ///   "FAKE"     → None
    fn parse_metal_symbol(symbol: &str) -> Option<(&str, Decimal)> {
        let (base, suffix) = match symbol.split_once('-') {
            Some((b, s)) => (b, Some(s)),
            None => (symbol, None),
        };
        if !SUPPORTED_METALS.contains(&base) {
            return None;
        }
        let multiplier = match suffix {
            None => Decimal::ONE,
            Some(s) => {
                let grams: Decimal = match s {
                    "1KG" => Decimal::from(1000),
                    "500G" => Decimal::from(500),
                    "250G" => Decimal::from(250),
                    "100G" => Decimal::from(100),
                    "50G" => Decimal::from(50),
                    "10G" => Decimal::from(10),
                    "1OZ" => TROY_OZ_GRAMS,
                    _ => return None,
                };
                grams / TROY_OZ_GRAMS
            }
        };
        Some((base, multiplier))
    }

    /// Issue a single timeframe request and return the parsed response.
    /// Maps the API's "plan limit exceeded" status to `TimeframeFetchError::PlanLimit`
    /// so callers can retry with a tighter window.
    async fn fetch_timeframe(
        &self,
        quote_currency: &str,
        base_code: &str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
        raw_symbol: &str,
    ) -> Result<MetalPriceTimeframeResponse, TimeframeFetchError> {
        let start_date = start.format("%Y-%m-%d");
        let end_date = end.format("%Y-%m-%d");

        let url = format!(
            "https://api.metalpriceapi.com/v1/timeframe?base={}&currencies={}&start_date={}&end_date={}",
            quote_currency, base_code, start_date, end_date
        );

        let response = self
            .client
            .get(&url)
            .header("X-API-KEY", &self.api_key)
            .send()
            .await
            .map_err(|e| TimeframeFetchError::Other {
                message: e.to_string(),
            })?;

        let response_text = response
            .text()
            .await
            .map_err(|e| TimeframeFetchError::Other {
                message: format!("Failed to read response: {}", e),
            })?;

        let tf_resp: MetalPriceTimeframeResponse =
            serde_json::from_str(&response_text).map_err(|e| {
                warn!(
                    provider = PROVIDER_ID,
                    error = %e,
                    body = %&response_text[..response_text.len().min(300)],
                    "Failed to parse timeframe response"
                );
                TimeframeFetchError::Other {
                    message: format!("Failed to parse timeframe response: {}", e),
                }
            })?;

        if !tf_resp.success || tf_resp.rates.is_empty() {
            if tf_resp
                .error
                .as_ref()
                .and_then(|e| e.status_code)
                .is_some_and(|c| PLAN_LIMIT_STATUS_CODES.contains(&c))
            {
                warn!(
                    provider = PROVIDER_ID,
                    symbol = %raw_symbol,
                    "Metal Price API plan limit exceeded; will retry with shorter window"
                );
                return Err(TimeframeFetchError::PlanLimit);
            }

            warn!(
                provider = PROVIDER_ID,
                symbol = %raw_symbol,
                body = %&response_text[..response_text.len().min(300)],
                "Metal Price API timeframe request failed"
            );
            return Err(TimeframeFetchError::Other {
                message: format!(
                    "Timeframe API request failed (body: {})",
                    &response_text[..response_text.len().min(300)]
                ),
            });
        }

        Ok(tf_resp)
    }

    /// Convert a rate (1 base_currency = rate troy ounces) to price per troy ounce.
    /// Division is done in Decimal space to avoid f64 precision loss.
    fn rate_to_price(rate: f64) -> Result<Decimal, MarketDataError> {
        let rate_decimal =
            Decimal::try_from(rate).map_err(|_| MarketDataError::ValidationFailed {
                message: "Failed to convert rate to decimal".to_string(),
            })?;
        if rate_decimal.is_zero() {
            return Err(MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: "Invalid rate (zero)".to_string(),
            });
        }
        Ok(Decimal::ONE / rate_decimal)
    }
}

#[async_trait]
impl MarketDataProvider for MetalPriceApiProvider {
    fn id(&self) -> &'static str {
        PROVIDER_ID
    }

    fn priority(&self) -> u8 {
        4
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            instrument_kinds: &[InstrumentKind::Metal],
            coverage: Coverage::metals_any_currency(),
            supports_latest: true,
            supports_historical: true,
            supports_search: false,
            supports_profile: false,
        }
    }

    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_minute: 100,
            max_concurrency: 5,
            min_delay: Duration::from_millis(100),
        }
    }

    async fn get_latest_quote(
        &self,
        _context: &QuoteContext,
        instrument: ProviderInstrument,
    ) -> Result<Quote, MarketDataError> {
        // Extract symbol and quote currency from the instrument
        let (raw_symbol, quote_currency) = match &instrument {
            ProviderInstrument::MetalSymbol { symbol, quote } => {
                (symbol.to_string(), quote.to_string())
            }
            _ => {
                return Err(MarketDataError::UnsupportedAssetType(format!(
                    "{:?}",
                    instrument
                )))
            }
        };

        let (base_code, weight_multiplier) = Self::parse_metal_symbol(&raw_symbol)
            .ok_or_else(|| MarketDataError::SymbolNotFound(raw_symbol.clone()))?;

        let cached = self
            .get_or_fetch_latest_per_oz(base_code, &quote_currency, &raw_symbol)
            .await?;

        let price = cached.price_per_oz * weight_multiplier;

        Ok(Quote::new(
            cached.timestamp,
            price,
            quote_currency,
            PROVIDER_ID.to_string(),
        ))
    }

    /// Fetch historical quotes using the timeframe API endpoint.
    ///
    /// Note: The API has a maximum date range of 365 days (paid plans).
    /// Free-tier plans are limited to 5 days. Exceeding the limit returns
    /// HTTP 421 which is handled as a provider error.
    async fn get_historical_quotes(
        &self,
        _context: &QuoteContext,
        instrument: ProviderInstrument,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<Quote>, MarketDataError> {
        let (raw_symbol, quote_currency) = match &instrument {
            ProviderInstrument::MetalSymbol { symbol, quote } => {
                (symbol.to_string(), quote.to_string())
            }
            _ => {
                return Err(MarketDataError::UnsupportedAssetType(format!(
                    "{:?}",
                    instrument
                )))
            }
        };

        let (base_code, weight_multiplier) = Self::parse_metal_symbol(&raw_symbol)
            .ok_or_else(|| MarketDataError::SymbolNotFound(raw_symbol.clone()))?;

        let rates = self
            .get_or_fetch_historical_per_oz(base_code, &quote_currency, start, end, &raw_symbol)
            .await?;

        let mut quotes: Vec<Quote> = rates
            .into_iter()
            .map(|(date, price_per_oz)| {
                let timestamp = Utc.from_utc_datetime(&date.and_hms_opt(12, 0, 0).unwrap());
                Quote::new(
                    timestamp,
                    price_per_oz * weight_multiplier,
                    quote_currency.clone(),
                    PROVIDER_ID.to_string(),
                )
            })
            .collect();

        quotes.sort_by_key(|q| q.timestamp);
        Ok(quotes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    #[test]
    fn test_parse_metal_symbol_base() {
        let (base, mult) = MetalPriceApiProvider::parse_metal_symbol("XAU").unwrap();
        assert_eq!(base, "XAU");
        assert_eq!(mult, Decimal::ONE);
    }

    #[test]
    fn test_parse_metal_symbol_1kg() {
        let (base, mult) = MetalPriceApiProvider::parse_metal_symbol("XAU-1KG").unwrap();
        assert_eq!(base, "XAU");
        // 1 kg = 1000g / 31.1034768 g/oz ≈ 32.1507 oz
        assert!(mult > dec!(32.15) && mult < dec!(32.16));
    }

    #[test]
    fn test_parse_metal_symbol_500g() {
        let (base, mult) = MetalPriceApiProvider::parse_metal_symbol("XAU-500G").unwrap();
        assert_eq!(base, "XAU");
        assert!(mult > dec!(16.07) && mult < dec!(16.08));
    }

    #[test]
    fn test_parse_metal_symbol_1oz() {
        let (_, mult) = MetalPriceApiProvider::parse_metal_symbol("XAG-1OZ").unwrap();
        assert_eq!(mult, Decimal::ONE);
    }

    #[test]
    fn test_parse_metal_symbol_unsupported() {
        assert!(MetalPriceApiProvider::parse_metal_symbol("AAPL").is_none());
        assert!(MetalPriceApiProvider::parse_metal_symbol("BTC").is_none());
        assert!(MetalPriceApiProvider::parse_metal_symbol("XAU-99G").is_none());
    }

    #[test]
    fn test_provider_id() {
        let provider = MetalPriceApiProvider::new("test_key".to_string());
        assert_eq!(provider.id(), "METAL_PRICE_API");
    }

    #[test]
    fn test_provider_priority() {
        let provider = MetalPriceApiProvider::new("test_key".to_string());
        assert_eq!(provider.priority(), 4);
    }

    #[test]
    fn test_provider_capabilities() {
        let provider = MetalPriceApiProvider::new("test_key".to_string());
        let caps = provider.capabilities();
        assert_eq!(caps.instrument_kinds, &[InstrumentKind::Metal]);
        assert!(caps.supports_latest);
        assert!(caps.supports_historical);
        assert!(!caps.supports_search);
        assert!(!caps.supports_profile);
    }

    #[test]
    fn test_rate_limit() {
        let provider = MetalPriceApiProvider::new("test_key".to_string());
        let rate_limit = provider.rate_limit();
        assert_eq!(rate_limit.requests_per_minute, 100);
        assert_eq!(rate_limit.max_concurrency, 5);
        assert_eq!(rate_limit.min_delay, Duration::from_millis(100));
    }

    #[test]
    fn test_rate_to_price() {
        // 1 USD = 0.000322 troy ounces of gold → price ≈ $3105.59/oz
        let price = MetalPriceApiProvider::rate_to_price(0.000322).unwrap();
        assert!(price > dec!(3000) && price < dec!(3200));
    }

    #[test]
    fn test_rate_to_price_zero() {
        let result = MetalPriceApiProvider::rate_to_price(0.0);
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn latest_cache_serves_weight_variants_without_network() {
        // Provider with no real API key. If the cache is used, no request is
        // made; if it isn't, the call would fail.
        let provider = MetalPriceApiProvider::new("invalid_key".to_string());
        let ts = Utc::now();
        provider.latest_cache.lock().unwrap().insert(
            ("XAU".to_string(), "USD".to_string()),
            CachedLatest {
                price_per_oz: dec!(3000),
                fetched_at: Instant::now(),
                timestamp: ts,
            },
        );

        let context = QuoteContext {
            instrument: crate::models::InstrumentId::Metal {
                code: "XAU".into(),
                quote: std::borrow::Cow::Borrowed("USD"),
            },
            overrides: None,
            currency_hint: None,
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        };

        let oz_quote = provider
            .get_latest_quote(
                &context,
                ProviderInstrument::MetalSymbol {
                    symbol: "XAU-1OZ".into(),
                    quote: "USD".into(),
                },
            )
            .await
            .unwrap();
        assert_eq!(oz_quote.close, dec!(3000));

        let kg_quote = provider
            .get_latest_quote(
                &context,
                ProviderInstrument::MetalSymbol {
                    symbol: "XAU-1KG".into(),
                    quote: "USD".into(),
                },
            )
            .await
            .unwrap();
        // 1 kg / 31.1034768 g/oz ≈ 32.1507 oz; price ≈ 3000 * 32.1507 ≈ 96452
        assert!(kg_quote.close > dec!(96000) && kg_quote.close < dec!(97000));
        assert_eq!(kg_quote.timestamp, ts);
    }

    #[test]
    fn cached_latest_expires_after_ttl() {
        let provider = MetalPriceApiProvider::new("invalid_key".to_string());
        provider.latest_cache.lock().unwrap().insert(
            ("XAG".to_string(), "USD".to_string()),
            CachedLatest {
                price_per_oz: dec!(25),
                fetched_at: Instant::now()
                    .checked_sub(LATEST_CACHE_TTL + Duration::from_secs(1))
                    .unwrap(),
                timestamp: Utc::now(),
            },
        );
        assert!(provider
            .cached_latest(&("XAG".to_string(), "USD".to_string()))
            .is_none());
    }

    /// Helper to get API key from environment, or None if not set.
    fn api_key_from_env() -> Option<String> {
        std::env::var("METAL_PRICE_API_KEY")
            .ok()
            .filter(|k| !k.is_empty())
    }

    // ── Integration tests (require METAL_PRICE_API_KEY env var) ──────

    #[tokio::test]
    #[ignore = "requires METAL_PRICE_API_KEY"]
    async fn test_get_latest_quote_gold_usd() {
        let api_key = api_key_from_env().expect("METAL_PRICE_API_KEY must be set");
        let provider = MetalPriceApiProvider::new(api_key);
        let context = QuoteContext {
            instrument: crate::models::InstrumentId::Metal {
                code: "XAU".into(),
                quote: std::borrow::Cow::Borrowed("USD"),
            },
            overrides: None,
            currency_hint: None,
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        };
        let instrument = ProviderInstrument::MetalSymbol {
            symbol: "XAU".into(),
            quote: "USD".into(),
        };

        let quote = provider
            .get_latest_quote(&context, instrument)
            .await
            .unwrap();
        assert_eq!(quote.currency, "USD");
        // Gold price should be in a reasonable range (USD/oz)
        assert!(
            quote.close > dec!(1000),
            "Gold price too low: {}",
            quote.close
        );
        assert!(
            quote.close < dec!(20000),
            "Gold price too high: {}",
            quote.close
        );
    }

    #[tokio::test]
    #[ignore = "requires METAL_PRICE_API_KEY"]
    async fn test_get_latest_quote_gold_chf() {
        let api_key = api_key_from_env().expect("METAL_PRICE_API_KEY must be set");
        let provider = MetalPriceApiProvider::new(api_key);
        let context = QuoteContext {
            instrument: crate::models::InstrumentId::Metal {
                code: "XAU".into(),
                quote: std::borrow::Cow::Borrowed("CHF"),
            },
            overrides: None,
            currency_hint: None,
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        };
        let instrument = ProviderInstrument::MetalSymbol {
            symbol: "XAU".into(),
            quote: "CHF".into(),
        };

        let quote = provider
            .get_latest_quote(&context, instrument)
            .await
            .unwrap();
        assert_eq!(quote.currency, "CHF");
        assert!(
            quote.close > dec!(1000),
            "Gold price too low: {}",
            quote.close
        );
    }

    #[tokio::test]
    #[ignore = "requires METAL_PRICE_API_KEY"]
    async fn test_get_historical_quotes_gold() {
        let api_key = api_key_from_env().expect("METAL_PRICE_API_KEY must be set");
        let provider = MetalPriceApiProvider::new(api_key);
        let context = QuoteContext {
            instrument: crate::models::InstrumentId::Metal {
                code: "XAU".into(),
                quote: std::borrow::Cow::Borrowed("USD"),
            },
            overrides: None,
            currency_hint: None,
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        };
        let instrument = ProviderInstrument::MetalSymbol {
            symbol: "XAU".into(),
            quote: "USD".into(),
        };

        // Free tier returns HTTP 421 for timeframe queries exceeding 5 days.
        // Paid plans support up to 365 days per the API docs.
        let end = Utc::now();
        let start = end - chrono::Duration::days(4);

        let quotes = provider
            .get_historical_quotes(&context, instrument, start, end)
            .await
            .unwrap();

        assert!(!quotes.is_empty(), "Should return at least one quote");
        assert!(
            quotes.len() >= 2,
            "Expected at least 2 days, got {}",
            quotes.len()
        );

        // Quotes should be sorted by timestamp
        for w in quotes.windows(2) {
            assert!(w[0].timestamp <= w[1].timestamp, "Quotes not sorted");
        }

        // All quotes should be reasonable gold prices
        for q in &quotes {
            assert_eq!(q.currency, "USD");
            assert!(
                q.close > dec!(1000),
                "Gold price too low on {}: {}",
                q.timestamp,
                q.close
            );
        }
    }

    #[tokio::test]
    #[ignore = "requires METAL_PRICE_API_KEY"]
    async fn test_get_latest_quote_unsupported_metal() {
        let api_key = api_key_from_env().expect("METAL_PRICE_API_KEY must be set");
        let provider = MetalPriceApiProvider::new(api_key);
        let context = QuoteContext {
            instrument: crate::models::InstrumentId::Metal {
                code: "FAKE".into(),
                quote: std::borrow::Cow::Borrowed("USD"),
            },
            overrides: None,
            currency_hint: None,
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        };
        let instrument = ProviderInstrument::MetalSymbol {
            symbol: "FAKE".into(),
            quote: "USD".into(),
        };

        let result = provider.get_latest_quote(&context, instrument).await;
        assert!(result.is_err());
    }
}
