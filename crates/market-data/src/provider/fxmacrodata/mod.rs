//! FXMacroData provider for FX rates.
//!
//! Fetches daily FX spot rates from the FXMacroData `/v1/forex/{base}/{quote}`
//! endpoint. Rates are official central-bank reference rates; pairs the
//! publisher does not quote directly are derived from the USD legs.
//!
//! The endpoint returns rows newest-first and pages them (`limit` <= 100),
//! so historical requests follow `pagination.next_offset` until the range is
//! exhausted. Requires an API key, sent in the `X-API-Key` header.

use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use reqwest::{Client, StatusCode};
use rust_decimal::Decimal;
use serde::Deserialize;
use std::time::Duration;

use tracing::{debug, warn};

use crate::errors::MarketDataError;
use crate::models::{Coverage, InstrumentKind, ProviderInstrument, Quote, QuoteContext};
use crate::provider::{MarketDataProvider, ProviderCapabilities, RateLimit};

/// Provider ID constant
const PROVIDER_ID: &str = "FXMACRODATA";

/// API base URL
const BASE_URL: &str = "https://api.fxmacrodata.com/v1";

/// Default HTTP request timeout
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Maximum rows per page accepted by the API.
const PAGE_LIMIT: u32 = 100;

/// Upper bound on pages fetched for one historical request (~19 years of
/// daily rows), so a misbehaving response cannot loop forever.
const MAX_PAGES: u32 = 50;

/// Response from `GET /v1/forex/{base}/{quote}`.
#[derive(Debug, Deserialize)]
struct ForexResponse {
    #[serde(default)]
    data: Vec<ForexRow>,
    #[serde(default)]
    pagination: Option<Pagination>,
}

/// One daily FX row. `val` is the reference rate (units of quote per base).
#[derive(Debug, Deserialize)]
struct ForexRow {
    date: String,
    #[serde(default)]
    val: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct Pagination {
    #[serde(default)]
    has_more: bool,
    #[serde(default)]
    next_offset: Option<u32>,
}

/// FXMacroData provider for FX rates.
///
/// # Example
///
/// ```ignore
/// use wealthfolio_market_data::provider::fxmacrodata::FxMacroDataProvider;
///
/// let provider = FxMacroDataProvider::new("your_api_key".to_string());
/// ```
pub struct FxMacroDataProvider {
    client: Client,
    api_key: String,
}

impl FxMacroDataProvider {
    /// Create a new FXMacroData provider with the given API key.
    pub fn new(api_key: String) -> Self {
        let client = wealthfolio_http::client_builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .unwrap_or_else(|_| wealthfolio_http::client());

        Self { client, api_key }
    }

    /// Extract the base/quote pair from the resolved instrument.
    fn fx_pair(instrument: &ProviderInstrument) -> Result<(String, String), MarketDataError> {
        match instrument {
            ProviderInstrument::FxPair { from, to } => Ok((from.to_string(), to.to_string())),
            ProviderInstrument::FxSymbol { symbol } => {
                // Accept "EURUSD" and Yahoo-style "EURUSD=X".
                let pair = symbol.trim_end_matches("=X");
                if pair.len() == 6 && pair.is_ascii() {
                    Ok((pair[..3].to_string(), pair[3..].to_string()))
                } else {
                    Err(MarketDataError::UnsupportedAssetType(format!(
                        "Cannot parse FX symbol: {}",
                        symbol
                    )))
                }
            }
            _ => Err(MarketDataError::UnsupportedAssetType(format!(
                "{:?}",
                instrument
            ))),
        }
    }

    fn forex_url(base: &str, quote: &str) -> String {
        format!(
            "{}/forex/{}/{}",
            BASE_URL,
            base.to_ascii_lowercase(),
            quote.to_ascii_lowercase()
        )
    }

    /// Map a non-success HTTP status to a market data error.
    fn status_error(status: StatusCode, body: &str) -> MarketDataError {
        let snippet = &body[..body.floor_char_boundary(300)];
        match status {
            StatusCode::TOO_MANY_REQUESTS => MarketDataError::RateLimited {
                provider: PROVIDER_ID.to_string(),
            },
            StatusCode::UNAUTHORIZED => MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: "Invalid or missing API key".to_string(),
            },
            StatusCode::FORBIDDEN | StatusCode::PAYMENT_REQUIRED => {
                MarketDataError::ProviderError {
                    provider: PROVIDER_ID.to_string(),
                    message: format!("Access denied - check API key and plan: {}", snippet),
                }
            }
            StatusCode::NOT_FOUND => MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("Pair not available: {}", snippet),
            },
            _ => MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("HTTP {}: {}", status, snippet),
            },
        }
    }

    /// Convert API rows into quotes, skipping rows without a rate.
    /// Returned quotes are sorted by timestamp ascending.
    fn quotes_from_rows(rows: &[ForexRow], currency: &str) -> Vec<Quote> {
        let mut quotes: Vec<Quote> = rows
            .iter()
            .filter_map(|row| {
                let rate = row.val.filter(|v| v.is_finite() && *v > 0.0)?;
                let close = Decimal::try_from(rate).ok()?;
                let date = NaiveDate::parse_from_str(&row.date, "%Y-%m-%d").ok()?;
                let timestamp = Utc.from_utc_datetime(&date.and_hms_opt(0, 0, 0)?);
                Some(Quote::new(
                    timestamp,
                    close,
                    currency.to_string(),
                    PROVIDER_ID.to_string(),
                ))
            })
            .collect();
        quotes.sort_by_key(|q| q.timestamp);
        quotes
    }

    /// Fetch one page of FX rows.
    async fn fetch_page(
        &self,
        base: &str,
        quote: &str,
        params: &[(&str, String)],
    ) -> Result<ForexResponse, MarketDataError> {
        let url = Self::forex_url(base, quote);
        debug!("Fetching FXMacroData {}/{} {:?}", base, quote, params);

        let response = self
            .client
            .get(&url)
            .header("X-API-Key", &self.api_key)
            .query(params)
            .send()
            .await
            .map_err(|e| {
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
        let body = response
            .text()
            .await
            .map_err(|e| MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("Failed to read response: {}", e),
            })?;

        if !status.is_success() {
            warn!(
                provider = PROVIDER_ID,
                status = %status,
                "FXMacroData forex request failed"
            );
            return Err(Self::status_error(status, &body));
        }

        serde_json::from_str(&body).map_err(|e| MarketDataError::ProviderError {
            provider: PROVIDER_ID.to_string(),
            message: format!("Failed to parse forex response: {}", e),
        })
    }
}

#[async_trait]
impl MarketDataProvider for FxMacroDataProvider {
    fn id(&self) -> &'static str {
        PROVIDER_ID
    }

    fn priority(&self) -> u8 {
        5
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            instrument_kinds: &[InstrumentKind::Fx],
            coverage: Coverage::global_best_effort(),
            supports_latest: true,
            supports_historical: true,
            supports_search: false,
            supports_profile: false,
            supports_dividends: false,
        }
    }

    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_minute: 60,
            max_concurrency: 2,
            min_delay: Duration::from_millis(200),
        }
    }

    async fn get_latest_quote(
        &self,
        _context: &QuoteContext,
        instrument: ProviderInstrument,
    ) -> Result<Quote, MarketDataError> {
        let (base, quote) = Self::fx_pair(&instrument)?;

        // Rows come back newest-first, so the first row is the latest rate.
        let response = self
            .fetch_page(&base, &quote, &[("limit", "1".to_string())])
            .await?;

        Self::quotes_from_rows(&response.data, &quote)
            .pop()
            .ok_or(MarketDataError::NoDataForRange)
    }

    async fn get_historical_quotes(
        &self,
        _context: &QuoteContext,
        instrument: ProviderInstrument,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<Quote>, MarketDataError> {
        let (base, quote) = Self::fx_pair(&instrument)?;

        let start_date = start.format("%Y-%m-%d").to_string();
        let end_date = end.format("%Y-%m-%d").to_string();

        let mut rows = Vec::new();
        let mut offset: u32 = 0;
        for _ in 0..MAX_PAGES {
            let params = [
                ("start_date", start_date.clone()),
                ("end_date", end_date.clone()),
                ("limit", PAGE_LIMIT.to_string()),
                ("offset", offset.to_string()),
            ];
            let page = self.fetch_page(&base, &quote, &params).await?;
            rows.extend(page.data);

            match page.pagination {
                Some(Pagination {
                    has_more: true,
                    next_offset: Some(next),
                }) if next > offset => offset = next,
                _ => break,
            }
        }

        let quotes = Self::quotes_from_rows(&rows, &quote);
        if quotes.is_empty() {
            return Err(MarketDataError::NoDataForRange);
        }
        Ok(quotes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;
    use std::borrow::Cow;

    const PAGE_JSON: &str = r#"{
        "base": "EUR",
        "quote": "USD",
        "source": "ecb",
        "start_date": "2024-01-01",
        "end_date": "2024-01-05",
        "pagination": {
            "limit": 3,
            "offset": 0,
            "returned_count": 3,
            "total_count": 4,
            "has_more": true,
            "next_offset": 3
        },
        "data": [
            {"date": "2024-01-05", "val": 1.0921, "announcement_datetime": 1704470400},
            {"date": "2024-01-04", "val": null},
            {"date": "2024-01-03", "val": 1.0919, "is_official": true}
        ]
    }"#;

    fn fx_pair(from: &'static str, to: &'static str) -> ProviderInstrument {
        ProviderInstrument::FxPair {
            from: Cow::Borrowed(from),
            to: Cow::Borrowed(to),
        }
    }

    #[test]
    fn test_parse_forex_page() {
        let resp: ForexResponse = serde_json::from_str(PAGE_JSON).unwrap();
        assert_eq!(resp.data.len(), 3);
        let pagination = resp.pagination.unwrap();
        assert!(pagination.has_more);
        assert_eq!(pagination.next_offset, Some(3));
    }

    #[test]
    fn test_parse_last_page_without_next_offset() {
        let json = r#"{
            "pagination": {"has_more": false, "next_offset": null},
            "data": [{"date": "2024-01-02", "val": 1.0956}]
        }"#;
        let resp: ForexResponse = serde_json::from_str(json).unwrap();
        let pagination = resp.pagination.unwrap();
        assert!(!pagination.has_more);
        assert_eq!(pagination.next_offset, None);
    }

    #[test]
    fn test_quotes_from_rows_sorted_and_skips_missing_rates() {
        let resp: ForexResponse = serde_json::from_str(PAGE_JSON).unwrap();
        let quotes = FxMacroDataProvider::quotes_from_rows(&resp.data, "USD");

        assert_eq!(quotes.len(), 2);
        assert_eq!(quotes[0].timestamp.date_naive().to_string(), "2024-01-03");
        assert_eq!(quotes[1].timestamp.date_naive().to_string(), "2024-01-05");
        assert_eq!(quotes[1].close, dec!(1.0921));
        assert_eq!(quotes[1].currency, "USD");
        assert_eq!(quotes[1].source, "FXMACRODATA");
    }

    #[test]
    fn test_quotes_from_rows_skips_bad_dates_and_non_positive_rates() {
        let json = r#"{"data": [
            {"date": "not-a-date", "val": 1.1},
            {"date": "2024-01-02", "val": 0.0},
            {"date": "2024-01-03", "val": 155.42}
        ]}"#;
        let resp: ForexResponse = serde_json::from_str(json).unwrap();
        let quotes = FxMacroDataProvider::quotes_from_rows(&resp.data, "JPY");
        assert_eq!(quotes.len(), 1);
        assert_eq!(quotes[0].close, dec!(155.42));
    }

    #[test]
    fn test_fx_pair_from_pair() {
        let (base, quote) = FxMacroDataProvider::fx_pair(&fx_pair("EUR", "USD")).unwrap();
        assert_eq!(base, "EUR");
        assert_eq!(quote, "USD");
    }

    #[test]
    fn test_fx_pair_from_symbol() {
        let instrument = ProviderInstrument::FxSymbol {
            symbol: "GBPJPY=X".into(),
        };
        let (base, quote) = FxMacroDataProvider::fx_pair(&instrument).unwrap();
        assert_eq!(base, "GBP");
        assert_eq!(quote, "JPY");
    }

    #[test]
    fn test_fx_pair_rejects_other_instruments() {
        let instrument = ProviderInstrument::EquitySymbol {
            symbol: "AAPL".into(),
        };
        assert!(FxMacroDataProvider::fx_pair(&instrument).is_err());

        let bad_symbol = ProviderInstrument::FxSymbol {
            symbol: "EURO".into(),
        };
        assert!(FxMacroDataProvider::fx_pair(&bad_symbol).is_err());
    }

    #[test]
    fn test_forex_url_lowercases_pair() {
        assert!(FxMacroDataProvider::forex_url("EUR", "USD").ends_with("/v1/forex/eur/usd"));
    }

    #[test]
    fn test_status_error_mapping() {
        assert!(matches!(
            FxMacroDataProvider::status_error(StatusCode::TOO_MANY_REQUESTS, ""),
            MarketDataError::RateLimited { .. }
        ));
        match FxMacroDataProvider::status_error(StatusCode::UNAUTHORIZED, "") {
            MarketDataError::ProviderError { provider, message } => {
                assert_eq!(provider, "FXMACRODATA");
                assert!(message.contains("API key"));
            }
            other => panic!("unexpected error: {:?}", other),
        }
        assert!(matches!(
            FxMacroDataProvider::status_error(StatusCode::FORBIDDEN, "{\"detail\":\"plan\"}"),
            MarketDataError::ProviderError { .. }
        ));
    }

    #[test]
    fn test_provider_id() {
        let provider = FxMacroDataProvider::new("test_key".to_string());
        assert_eq!(provider.id(), "FXMACRODATA");
    }

    #[test]
    fn test_provider_capabilities() {
        let provider = FxMacroDataProvider::new("test_key".to_string());
        let caps = provider.capabilities();
        assert_eq!(caps.instrument_kinds, &[InstrumentKind::Fx]);
        assert!(caps.supports_latest);
        assert!(caps.supports_historical);
        assert!(!caps.supports_search);
        assert!(!caps.supports_profile);
        assert!(!caps.supports_dividends);
    }

    #[test]
    fn test_rate_limit() {
        let provider = FxMacroDataProvider::new("test_key".to_string());
        let rate_limit = provider.rate_limit();
        assert_eq!(rate_limit.requests_per_minute, 60);
        assert_eq!(rate_limit.max_concurrency, 2);
    }

    // ── Integration test (requires FXMACRODATA_API_KEY env var) ──────

    #[tokio::test]
    #[ignore = "requires FXMACRODATA_API_KEY"]
    async fn test_get_historical_quotes_eur_usd() {
        let api_key =
            std::env::var("FXMACRODATA_API_KEY").expect("FXMACRODATA_API_KEY must be set");
        let provider = FxMacroDataProvider::new(api_key);
        let context = QuoteContext {
            instrument: crate::models::InstrumentId::Fx {
                base: Cow::Borrowed("EUR"),
                quote: Cow::Borrowed("USD"),
            },
            identifiers: Default::default(),
            overrides: None,
            currency_hint: None,
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        };

        let end = Utc::now();
        let start = end - chrono::Duration::days(30);
        let quotes = provider
            .get_historical_quotes(&context, fx_pair("EUR", "USD"), start, end)
            .await
            .unwrap();

        assert!(
            quotes.len() >= 10,
            "Expected ~20 rows, got {}",
            quotes.len()
        );
        for w in quotes.windows(2) {
            assert!(w[0].timestamp < w[1].timestamp, "Quotes not sorted");
        }
        assert!(quotes.iter().all(|q| q.currency == "USD"));
    }
}
