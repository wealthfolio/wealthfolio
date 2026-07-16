//! Custom scraper provider — runtime dispatch to user-defined JSON/HTML sources.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone, Utc};
use log::debug;
use rust_decimal::Decimal;

use crate::custom_provider::model::{
    build_browser_like_headers, expand_template, extract_html_value, validate_url, TemplateContext,
    CUSTOM_PROVIDER_USER_AGENT, MAX_RESPONSE_BYTES,
};
use crate::custom_provider::service::{
    detect_html_locale, parse_csv_records, parse_number_string, resolve_csv_column,
};
use crate::custom_provider::store::CustomProviderRepository;
use crate::custom_provider::CustomProviderSource;
use crate::quotes::constants::DATA_SOURCE_CUSTOM_SCRAPER;
use crate::secrets::SecretStore;

use wealthfolio_market_data::errors::MarketDataError;
use wealthfolio_market_data::{
    Coverage, InstrumentKind, MarketDataProvider, ProviderCapabilities, ProviderInstrument,
    Quote as MarketQuote, QuoteContext, RateLimit,
};

/// Provider that dispatches to user-defined custom source configurations.
pub struct CustomScraperProvider {
    repo: Arc<dyn CustomProviderRepository>,
    secret_store: Arc<dyn SecretStore>,
    client: reqwest::Client,
}

impl CustomScraperProvider {
    pub fn new(
        repo: Arc<dyn CustomProviderRepository>,
        secret_store: Arc<dyn SecretStore>,
    ) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::limited(5))
            .user_agent(CUSTOM_PROVIDER_USER_AGENT)
            .build()
            .expect("failed to build reqwest HTTP client");
        Self {
            repo,
            secret_store,
            client,
        }
    }

    /// Expand URL template variables using the shared template engine.
    fn expand_url(
        url: &str,
        symbol: &str,
        context: Option<&QuoteContext>,
        from: Option<&str>,
        to: Option<&str>,
    ) -> String {
        let isin_owned: Option<String> = context.and_then(|ctx| {
            // Prefer explicit identifiers so equity ISINs can be used without changing the
            // canonical instrument; bonds fall back to their instrument ISIN.
            ctx.identifiers
                .isin
                .as_deref()
                .map(str::to_string)
                .or_else(|| match &ctx.instrument {
                    wealthfolio_market_data::InstrumentId::Bond { isin } => {
                        Some(isin.as_ref().to_string())
                    }
                    _ => None,
                })
        });

        let mic_owned: Option<String> = context.and_then(|ctx| match &ctx.instrument {
            wealthfolio_market_data::InstrumentId::Equity { mic, .. } => {
                mic.as_ref().map(|m| m.as_ref().to_string())
            }
            _ => None,
        });

        let currency = context
            .and_then(|ctx| ctx.currency_hint.as_deref())
            .unwrap_or("USD");

        let tctx = TemplateContext {
            symbol,
            currency,
            isin: isin_owned.as_deref(),
            mic: mic_owned.as_deref(),
            from,
            to,
        };

        expand_template(url, &tctx)
    }

    fn source_url_has_identity_placeholder(url: &str) -> bool {
        url.contains("{SYMBOL}") || url.contains("{ISIN}")
    }

    /// Build HTTP headers from source config, resolving secrets.
    fn build_headers(
        &self,
        source: &CustomProviderSource,
        url: &str,
    ) -> Result<reqwest::header::HeaderMap, MarketDataError> {
        let mut headers = build_browser_like_headers(&source.format, url);
        if let Some(headers_json) = &source.headers {
            if let Ok(map) =
                serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(headers_json)
            {
                for (k, v) in map {
                    if let Some(val_str) = v.as_str() {
                        let resolved = self.resolve_secret(val_str)?;
                        if let (Ok(name), Ok(value)) = (
                            reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                            reqwest::header::HeaderValue::from_str(&resolved),
                        ) {
                            headers.insert(name, value);
                        }
                    }
                }
            }
        }
        Ok(headers)
    }

    /// Fetch body from URL with simple 1-retry on 5xx/network errors.
    async fn fetch_body(
        &self,
        url: &str,
        headers: reqwest::header::HeaderMap,
    ) -> Result<String, MarketDataError> {
        let do_fetch = |hdrs: reqwest::header::HeaderMap| self.client.get(url).headers(hdrs).send();

        let response = match do_fetch(headers.clone()).await {
            Ok(resp) if resp.status().is_server_error() => {
                debug!("CustomScraper: 5xx from {}, retrying once", url);
                tokio::time::sleep(Duration::from_secs(1)).await;
                do_fetch(headers).await.map_err(MarketDataError::Network)?
            }
            Ok(resp) => resp,
            Err(_e) => {
                debug!("CustomScraper: network error from {}, retrying once", url);
                tokio::time::sleep(Duration::from_secs(1)).await;
                do_fetch(headers).await.map_err(MarketDataError::Network)?
            }
        };

        if !response.status().is_success() {
            return Err(MarketDataError::ProviderError {
                provider: DATA_SOURCE_CUSTOM_SCRAPER.to_string(),
                message: format!("HTTP {}", response.status()),
            });
        }

        if let Some(len) = response.content_length() {
            if len > MAX_RESPONSE_BYTES as u64 {
                return Err(MarketDataError::ProviderError {
                    provider: DATA_SOURCE_CUSTOM_SCRAPER.to_string(),
                    message: format!(
                        "Response body too large ({} bytes, max {})",
                        len, MAX_RESPONSE_BYTES
                    ),
                });
            }
        }
        let body_bytes = response.bytes().await.map_err(MarketDataError::Network)?;
        if body_bytes.len() > MAX_RESPONSE_BYTES {
            return Err(MarketDataError::ProviderError {
                provider: DATA_SOURCE_CUSTOM_SCRAPER.to_string(),
                message: format!(
                    "Response body too large ({} bytes, max {})",
                    body_bytes.len(),
                    MAX_RESPONSE_BYTES
                ),
            });
        }
        String::from_utf8(body_bytes.to_vec()).map_err(|e| MarketDataError::ProviderError {
            provider: DATA_SOURCE_CUSTOM_SCRAPER.to_string(),
            message: format!("Response body is not valid UTF-8: {}", e),
        })
    }

    /// Load and execute a source config, returning a single quote.
    async fn fetch_from_source(
        &self,
        source: &CustomProviderSource,
        symbol: &str,
        currency_hint: Option<&str>,
        context: Option<&QuoteContext>,
    ) -> Result<MarketQuote, MarketDataError> {
        let quotes = self
            .fetch_from_source_with_dates(source, symbol, currency_hint, context, None, None)
            .await?;
        quotes
            .into_iter()
            .next()
            .ok_or_else(|| MarketDataError::ProviderError {
                provider: DATA_SOURCE_CUSTOM_SCRAPER.to_string(),
                message: format!("No quote extracted for symbol '{}'", symbol),
            })
    }

    async fn fetch_latest_from_historical_sources(
        &self,
        context: &QuoteContext,
        symbol: &str,
        currency_hint: Option<&str>,
    ) -> Result<MarketQuote, MarketDataError> {
        let sources = self.find_sources(context, "historical")?;
        let to = Utc::now();
        let from = to - chrono::Duration::days(90);
        let from_str = from.format("%Y-%m-%d").to_string();
        let to_str = to.format("%Y-%m-%d").to_string();

        let mut last_err = None;
        for source in &sources {
            let sym = Self::resolve_symbol(context, source, symbol);
            match self
                .fetch_from_source_with_dates(
                    source,
                    &sym,
                    currency_hint,
                    Some(context),
                    Some(&from_str),
                    Some(&to_str),
                )
                .await
            {
                Ok(quotes) => {
                    if let Some(quote) = quotes.into_iter().max_by_key(|q| q.timestamp) {
                        return Ok(quote);
                    }
                    last_err = Some((
                        source.provider_id.clone(),
                        MarketDataError::ProviderError {
                            provider: DATA_SOURCE_CUSTOM_SCRAPER.to_string(),
                            message: format!("No historical quotes extracted for symbol '{}'", sym),
                        },
                    ));
                }
                Err(e) => {
                    log::debug!(
                        "CustomScraper [{}]: historical latest fallback failed for '{}': {}",
                        source.provider_id,
                        sym,
                        e
                    );
                    last_err = Some((source.provider_id.clone(), e));
                }
            }
        }

        let (pid, e) = last_err.unwrap_or_else(|| {
            (
                "unknown".to_string(),
                MarketDataError::ProviderError {
                    provider: DATA_SOURCE_CUSTOM_SCRAPER.to_string(),
                    message: "No historical providers found".to_string(),
                },
            )
        });
        Err(MarketDataError::ProviderError {
            provider: DATA_SOURCE_CUSTOM_SCRAPER.to_string(),
            message: format!("[{}] {}", pid, extract_inner_message(&e)),
        })
    }

    /// Load and execute a source config, returning one or more quotes.
    async fn fetch_from_source_with_dates(
        &self,
        source: &CustomProviderSource,
        symbol: &str,
        currency_hint: Option<&str>,
        context: Option<&QuoteContext>,
        from: Option<&str>,
        to: Option<&str>,
    ) -> Result<Vec<MarketQuote>, MarketDataError> {
        // Default price fallback — if URL is empty, return static price
        if source.url.is_empty() {
            if let Some(price) = source.default_price {
                let close = to_decimal(price);
                let currency = currency_hint.unwrap_or("USD").to_string();
                let src = format!("{}:{}", DATA_SOURCE_CUSTOM_SCRAPER, source.provider_id);
                return Ok(vec![MarketQuote::new(Utc::now(), close, currency, src)]);
            }
            return Err(MarketDataError::ProviderError {
                provider: DATA_SOURCE_CUSTOM_SCRAPER.to_string(),
                message: "No URL and no default_price configured".to_string(),
            });
        }

        let url = Self::expand_url(&source.url, symbol, context, from, to);

        validate_url(&url).map_err(|e| MarketDataError::ProviderError {
            provider: DATA_SOURCE_CUSTOM_SCRAPER.to_string(),
            message: e.to_string(),
        })?;

        let headers = self.build_headers(source, &url)?;

        debug!("CustomScraper: fetching {} for symbol '{}'", url, symbol);

        let body = match self.fetch_body(&url, headers).await {
            Ok(b) => b,
            Err(e) => {
                // Fall back to default_price on fetch failure
                if let Some(price) = source.default_price {
                    let close = to_decimal(price);
                    let currency = currency_hint.unwrap_or("USD").to_string();
                    let src = format!("{}:{}", DATA_SOURCE_CUSTOM_SCRAPER, source.provider_id);
                    return Ok(vec![MarketQuote::new(Utc::now(), close, currency, src)]);
                }
                return Err(e);
            }
        };

        let currency = resolve_currency(source, symbol, currency_hint, &body, from, to);

        // Auto-detect locale from HTML lang if not explicitly set
        let locale = source.locale.as_deref().map(|s| s.to_string()).or_else(|| {
            if matches!(source.format.as_str(), "html" | "html_table") {
                detect_html_locale(&body)
            } else {
                None
            }
        });
        let locale_ref = locale.as_deref();

        match source.format.as_str() {
            "html_table" => {
                let rows = extract_table_rows(&body, source, locale_ref);
                if rows.is_empty() {
                    return Err(MarketDataError::ProviderError {
                        provider: DATA_SOURCE_CUSTOM_SCRAPER.to_string(),
                        message: format!(
                            "No rows extracted from HTML table for symbol '{}'",
                            symbol
                        ),
                    });
                }
                Ok(rows_to_quotes(rows, source, &currency))
            }
            "csv" => {
                let rows = extract_csv_rows(&body, source, locale_ref);
                if rows.is_empty() {
                    return Err(MarketDataError::ProviderError {
                        provider: DATA_SOURCE_CUSTOM_SCRAPER.to_string(),
                        message: format!("No rows extracted from CSV for symbol '{}'", symbol),
                    });
                }
                Ok(rows_to_quotes(rows, source, &currency))
            }
            "json" => {
                let rows =
                    extract_json_rows(&body, source, symbol, currency_hint, locale_ref, from, to);
                if rows.is_empty() {
                    return Err(MarketDataError::ProviderError {
                        provider: DATA_SOURCE_CUSTOM_SCRAPER.to_string(),
                        message: format!(
                            "Could not extract price from path '{}' for symbol '{}'",
                            source.price_path, symbol
                        ),
                    });
                }
                Ok(rows_to_quotes(rows, source, &currency))
            }
            "html" => {
                let price =
                    extract_html_value(&body, &source.price_path, locale_ref).ok_or_else(|| {
                        MarketDataError::ProviderError {
                            provider: format!(
                                "{}:{}",
                                DATA_SOURCE_CUSTOM_SCRAPER, source.provider_id
                            ),
                            message: format!(
                                "Could not extract price using CSS selector '{}' for symbol '{}'",
                                source.price_path, symbol
                            ),
                        }
                    })?;

                let close = apply_factor_invert(price, source);
                let high = source
                    .high_path
                    .as_ref()
                    .and_then(|p| extract_html_value(&body, p, locale_ref))
                    .map(|v| apply_factor_invert(v, source));
                let low = source
                    .low_path
                    .as_ref()
                    .and_then(|p| extract_html_value(&body, p, locale_ref))
                    .map(|v| apply_factor_invert(v, source));
                let volume = source
                    .volume_path
                    .as_ref()
                    .and_then(|p| extract_html_value(&body, p, locale_ref));

                let src = format!("{}:{}", DATA_SOURCE_CUSTOM_SCRAPER, source.provider_id);
                let mut quote = MarketQuote::new(Utc::now(), to_decimal(close), currency, src);
                quote.high = high.map(to_decimal);
                quote.low = low.map(to_decimal);
                quote.volume = volume.map(to_decimal);
                Ok(vec![quote])
            }
            _ => Err(MarketDataError::ProviderError {
                provider: DATA_SOURCE_CUSTOM_SCRAPER.to_string(),
                message: format!("Unsupported format: {}", source.format),
            }),
        }
    }

    /// Resolve __SECRET__ placeholders in header values.
    fn resolve_secret(&self, val: &str) -> Result<String, MarketDataError> {
        if let Some(key) = val.strip_prefix("__SECRET__") {
            self.secret_store
                .get_secret(key)
                .ok()
                .flatten()
                .ok_or_else(|| MarketDataError::ProviderError {
                    provider: DATA_SOURCE_CUSTOM_SCRAPER.to_string(),
                    message: format!("Secret '{}' not found", key),
                })
        } else {
            Ok(val.to_string())
        }
    }
}

#[async_trait]
impl MarketDataProvider for CustomScraperProvider {
    fn id(&self) -> &'static str {
        DATA_SOURCE_CUSTOM_SCRAPER
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            instrument_kinds: &[
                InstrumentKind::Equity,
                InstrumentKind::Crypto,
                InstrumentKind::Fx,
                InstrumentKind::Metal,
                InstrumentKind::Bond,
                InstrumentKind::Option,
            ],
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
            requests_per_minute: 30,
            max_concurrency: 2,
            min_delay: Duration::from_millis(500),
        }
    }

    async fn get_latest_quote(
        &self,
        context: &QuoteContext,
        instrument: ProviderInstrument,
    ) -> Result<MarketQuote, MarketDataError> {
        let symbol = match &instrument {
            ProviderInstrument::EquitySymbol { symbol } => symbol.to_string(),
            _ => {
                return Err(MarketDataError::ProviderError {
                    provider: DATA_SOURCE_CUSTOM_SCRAPER.to_string(),
                    message: "Unexpected instrument type".to_string(),
                })
            }
        };

        let currency_hint = context.currency_hint.as_deref();

        let sources = self.find_sources(context, "latest").ok();
        let mut last_err = None;
        if let Some(sources) = sources {
            for source in &sources {
                let sym = Self::resolve_symbol(context, source, &symbol);
                match self
                    .fetch_from_source(source, &sym, currency_hint, Some(context))
                    .await
                {
                    Ok(quote) => return Ok(quote),
                    Err(e) => {
                        log::debug!(
                            "CustomScraper [{}]: failed for symbol '{}': {}",
                            source.provider_id,
                            sym,
                            e
                        );
                        last_err = Some((source.provider_id.clone(), e));
                    }
                }
            }
        }

        match self
            .fetch_latest_from_historical_sources(context, &symbol, currency_hint)
            .await
        {
            Ok(quote) => Ok(quote),
            Err(historical_err) => {
                let Some((pid, e)) = last_err else {
                    return Err(historical_err);
                };
                log::debug!(
                    "CustomScraper: latest source failed and historical fallback also failed: {}",
                    historical_err
                );
                Err(MarketDataError::ProviderError {
                    provider: DATA_SOURCE_CUSTOM_SCRAPER.to_string(),
                    message: format!("[{}] {}", pid, extract_inner_message(&e)),
                })
            }
        }
    }

    async fn get_historical_quotes(
        &self,
        context: &QuoteContext,
        instrument: ProviderInstrument,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<MarketQuote>, MarketDataError> {
        let symbol = match &instrument {
            ProviderInstrument::EquitySymbol { symbol } => symbol.to_string(),
            _ => {
                return Err(MarketDataError::ProviderError {
                    provider: DATA_SOURCE_CUSTOM_SCRAPER.to_string(),
                    message: "Unexpected instrument type".to_string(),
                })
            }
        };

        // Try historical sources first, fall back to latest
        let historical_sources = self.find_sources(context, "historical").ok();
        let currency_hint = context.currency_hint.as_deref();

        if let Some(sources) = historical_sources {
            let from_str = start.format("%Y-%m-%d").to_string();
            let to_str = end.format("%Y-%m-%d").to_string();
            let mut last_err = None;
            for source in &sources {
                let sym = Self::resolve_symbol(context, source, &symbol);
                match self
                    .fetch_from_source_with_dates(
                        source,
                        &sym,
                        currency_hint,
                        Some(context),
                        Some(&from_str),
                        Some(&to_str),
                    )
                    .await
                {
                    Ok(quotes) => return Ok(quotes),
                    Err(e) => {
                        log::debug!(
                            "CustomScraper [{}]: historical failed for '{}': {}",
                            source.provider_id,
                            sym,
                            e
                        );
                        last_err = Some((source.provider_id.clone(), e));
                    }
                }
            }
            if let Some((pid, e)) = last_err {
                return Err(MarketDataError::ProviderError {
                    provider: DATA_SOURCE_CUSTOM_SCRAPER.to_string(),
                    message: format!("[{}] {}", pid, extract_inner_message(&e)),
                });
            }
        }

        // Fall back to latest sources — returns a single-element vec
        let latest_sources = self.find_sources(context, "latest")?;
        let mut last_err = None;
        for source in &latest_sources {
            let sym = Self::resolve_symbol(context, source, &symbol);
            match self
                .fetch_from_source(source, &sym, currency_hint, Some(context))
                .await
            {
                Ok(quote) => return Ok(vec![quote]),
                Err(e) => {
                    log::debug!(
                        "CustomScraper [{}]: latest fallback failed for '{}': {}",
                        source.provider_id,
                        sym,
                        e
                    );
                    last_err = Some((source.provider_id.clone(), e));
                }
            }
        }

        let (pid, e) = last_err.unwrap_or_else(|| {
            (
                "unknown".to_string(),
                MarketDataError::ProviderError {
                    provider: DATA_SOURCE_CUSTOM_SCRAPER.to_string(),
                    message: "No providers found".to_string(),
                },
            )
        });
        Err(MarketDataError::ProviderError {
            provider: DATA_SOURCE_CUSTOM_SCRAPER.to_string(),
            message: format!("[{}] {}", pid, extract_inner_message(&e)),
        })
    }
}

impl CustomScraperProvider {
    /// Find candidate sources for the given kind.
    /// If `custom_provider_code` is set, returns that single provider's source.
    /// Otherwise, returns sources from all enabled custom providers whose URL
    /// contains an identity placeholder (general-purpose sources that work like built-in providers).
    fn find_sources(
        &self,
        context: &QuoteContext,
        kind: &str,
    ) -> Result<Vec<CustomProviderSource>, MarketDataError> {
        // Explicit provider code — use it directly
        if let Some(code) = context.custom_provider_code.as_deref() {
            let source = self
                .repo
                .get_source_by_kind(code, kind)
                .map_err(|e| MarketDataError::ProviderError {
                    provider: DATA_SOURCE_CUSTOM_SCRAPER.to_string(),
                    message: format!("Failed to load source config: {}", e),
                })?
                .ok_or_else(|| MarketDataError::ProviderError {
                    provider: DATA_SOURCE_CUSTOM_SCRAPER.to_string(),
                    message: format!("No '{}' source configured for provider '{}'", kind, code),
                })?;
            return Ok(vec![source]);
        }

        // No explicit code — collect general-purpose sources (URL contains an identity placeholder)
        // from all enabled custom providers, tried in priority order.
        let providers = self
            .repo
            .get_all()
            .map_err(|e| MarketDataError::ProviderError {
                provider: DATA_SOURCE_CUSTOM_SCRAPER.to_string(),
                message: format!("Failed to list custom providers: {}", e),
            })?;

        let sources: Vec<CustomProviderSource> = providers
            .into_iter()
            .filter(|p| p.enabled)
            .flat_map(|p| p.sources.into_iter().filter(|s| s.kind == kind))
            .filter(|s| Self::source_url_has_identity_placeholder(&s.url))
            .collect();

        if sources.is_empty() {
            return Err(MarketDataError::NotSupported {
                operation: format!("{} quotes", kind),
                provider: DATA_SOURCE_CUSTOM_SCRAPER.to_string(),
            });
        }

        Ok(sources)
    }

    /// Resolve the symbol for a specific custom provider source.
    /// Checks overrides keyed as `CUSTOM:<provider_id>` first, then falls back to the default symbol.
    fn resolve_symbol(
        context: &QuoteContext,
        source: &CustomProviderSource,
        default_symbol: &str,
    ) -> String {
        let override_key = format!("CUSTOM:{}", source.provider_id);
        if let Some(overrides) = &context.overrides {
            if let Some(instrument) = overrides.get(&override_key) {
                return instrument.to_symbol_string();
            }
        }
        default_symbol.to_string()
    }
}

// ─── Extracted row type ──────────────────────────────────────────────────────

struct ExtractedRow {
    date: Option<NaiveDate>,
    close: f64,
    open: Option<f64>,
    high: Option<f64>,
    low: Option<f64>,
    volume: Option<f64>,
}

// ─── Conversion helpers ──────────────────────────────────────────────────────

fn to_decimal(v: f64) -> Decimal {
    Decimal::try_from(v)
        .or_else(|_| Decimal::from_f64_retain(v).ok_or(()))
        .unwrap_or_default()
}

/// Extract the inner message from a MarketDataError, avoiding redundant "Provider error: X -" wrapping.
fn extract_inner_message(e: &MarketDataError) -> String {
    match e {
        MarketDataError::ProviderError { message, .. } => message.clone(),
        other => other.to_string(),
    }
}

fn apply_factor_invert(mut price: f64, source: &CustomProviderSource) -> f64 {
    if let Some(factor) = source.factor {
        price *= factor;
    }
    if source.invert == Some(true) && price != 0.0 {
        price = 1.0 / price;
    }
    price
}

fn resolve_currency(
    source: &CustomProviderSource,
    symbol: &str,
    currency_hint: Option<&str>,
    body: &str,
    from: Option<&str>,
    to: Option<&str>,
) -> String {
    if source.format == "json" {
        let currency = currency_hint.unwrap_or("USD");
        let tctx = TemplateContext {
            symbol,
            currency,
            isin: None,
            mic: None,
            from,
            to,
        };
        source
            .currency_path
            .as_ref()
            .and_then(|cp| {
                let cp = expand_template(cp, &tctx);
                extract_json_string(body, &cp)
            })
            .or_else(|| currency_hint.map(|s| s.to_string()))
            .unwrap_or_else(|| "USD".to_string())
    } else {
        currency_hint
            .map(|s| s.to_string())
            .unwrap_or_else(|| "USD".to_string())
    }
}

fn rows_to_quotes(
    rows: Vec<ExtractedRow>,
    source: &CustomProviderSource,
    currency: &str,
) -> Vec<MarketQuote> {
    rows.into_iter()
        .map(|row| {
            let close = apply_factor_invert(row.close, source);
            let ts = row
                .date
                .and_then(|d| parse_date_to_utc(d, source.date_timezone.as_deref()))
                .unwrap_or_else(|| {
                    debug!(
                        "CustomScraper [{}]: date missing or failed to convert to UTC, defaulting to now",
                        source.provider_id
                    );
                    Utc::now()
                });

            let src = format!("{}:{}", DATA_SOURCE_CUSTOM_SCRAPER, source.provider_id);
            let mut quote = MarketQuote::new(ts, to_decimal(close), currency.to_string(), src);
            quote.open = row.open.map(|v| to_decimal(apply_factor_invert(v, source)));
            quote.high = row.high.map(|v| to_decimal(apply_factor_invert(v, source)));
            quote.low = row.low.map(|v| to_decimal(apply_factor_invert(v, source)));
            quote.volume = row.volume.map(to_decimal);
            quote
        })
        .collect()
}

/// Convert a NaiveDate to DateTime<Utc>, optionally applying a timezone.
fn parse_date_to_utc(date: NaiveDate, tz_name: Option<&str>) -> Option<DateTime<Utc>> {
    let noon = date.and_hms_opt(12, 0, 0)?;
    if let Some(tz_str) = tz_name {
        if let Ok(tz) = tz_str.parse::<chrono_tz::Tz>() {
            return tz
                .from_local_datetime(&noon)
                .single()
                .map(|dt| dt.with_timezone(&Utc));
        }
    }
    Some(DateTime::<Utc>::from_naive_utc_and_offset(noon, Utc))
}

// ─── Date parsing ────────────────────────────────────────────────────────────

const COMMON_DATE_FORMATS: &[&str] = &[
    "%Y-%m-%d",
    "%d/%m/%Y",
    "%m/%d/%Y",
    "%d.%m.%Y",
    "%d-%m-%Y",
    "%B %d, %Y",
    "%A, %B %d, %Y",
    "%b %d, %Y",
    "%a, %b %d, %Y",
    "%d %b %Y",
    "%d %B %Y",
    "%Y%m%d",
];

const COMMON_DATETIME_FORMATS: &[&str] = &[
    "%Y-%m-%dT%H:%M:%S%.f",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%d %H:%M:%S%.f",
    "%Y-%m-%d %H:%M:%S",
];

fn parse_date(s: &str, explicit_format: Option<&str>) -> Option<NaiveDate> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    if let Some(fmt) = explicit_format {
        return NaiveDate::parse_from_str(s, fmt).ok();
    }
    if let Ok(n) = s.parse::<i64>() {
        return parse_numeric_date(n);
    }
    // ISO 8601 / RFC 3339 datetime with timezone (e.g. "2026-03-30T12:00:00Z", "...+00:00").
    // Use the local date from the offset so later date_timezone handling stays consistent
    // with how bare dates are interpreted downstream.
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(dt.date_naive());
    }
    for fmt in COMMON_DATETIME_FORMATS {
        if let Ok(dt) = NaiveDateTime::parse_from_str(s, fmt) {
            return Some(dt.date());
        }
    }
    for fmt in COMMON_DATE_FORMATS {
        if let Ok(d) = NaiveDate::parse_from_str(s, fmt) {
            return Some(d);
        }
    }
    None
}

fn parse_numeric_date(n: i64) -> Option<NaiveDate> {
    // Excel/Lotus day serial: days since 1899-12-30 (accounts for the 1900 leap-year bug).
    // Values below 100_000 cover years 1900–2173, which excludes plausible unix-second
    // price timestamps (Jan 1970 + 100_000 s = Jan 2 1970, never a real quote date).
    if (1..100_000).contains(&n) {
        let base = NaiveDate::from_ymd_opt(1899, 12, 30)?;
        return base.checked_add_signed(chrono::Duration::days(n));
    }
    let secs = if n > 9_999_999_999 { n / 1000 } else { n };
    DateTime::from_timestamp(secs, 0).map(|dt| dt.naive_utc().date())
}

/// Extract text from a table cell, preferring the first child element's text
/// to avoid concatenating multiple responsive variants (e.g., full and abbreviated dates).
fn extract_first_text_content(el: scraper::ElementRef) -> String {
    // If the cell has child elements, use the first one's text
    let child_sel = scraper::Selector::parse("*").expect("valid CSS selector '*'");
    if let Some(first_child) = el.select(&child_sel).next() {
        let text = first_child.text().collect::<String>();
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    // Fall back to direct text content
    el.text().collect::<String>().trim().to_string()
}

// ─── HTML table multi-row extraction ─────────────────────────────────────────

fn extract_table_rows(
    body: &str,
    source: &CustomProviderSource,
    locale: Option<&str>,
) -> Vec<ExtractedRow> {
    let document = scraper::Html::parse_document(body);
    let table_sel = match scraper::Selector::parse("table") {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let tr_sel = scraper::Selector::parse("tr").expect("valid CSS selector 'tr'");
    let td_sel = scraper::Selector::parse("td").expect("valid CSS selector 'td'");

    let (table_idx, close_col) = match parse_table_col_path(&source.price_path) {
        Some(v) => v,
        None => return Vec::new(),
    };
    let date_col = source
        .date_path
        .as_ref()
        .and_then(|p| parse_table_col_path(p))
        .map(|(_, c)| c);
    let open_col = source
        .open_path
        .as_ref()
        .and_then(|p| parse_table_col_path(p))
        .map(|(_, c)| c);
    let high_col = source
        .high_path
        .as_ref()
        .and_then(|p| parse_table_col_path(p))
        .map(|(_, c)| c);
    let low_col = source
        .low_path
        .as_ref()
        .and_then(|p| parse_table_col_path(p))
        .map(|(_, c)| c);
    let volume_col = source
        .volume_path
        .as_ref()
        .and_then(|p| parse_table_col_path(p))
        .map(|(_, c)| c);

    let table_el = match document.select(&table_sel).nth(table_idx) {
        Some(t) => t,
        None => return Vec::new(),
    };

    let date_fmt = source.date_format.as_deref();
    let mut rows = Vec::new();

    for tr in table_el.select(&tr_sel) {
        let cells: Vec<String> = tr
            .select(&td_sel)
            .map(|el| extract_first_text_content(el))
            .collect();
        if cells.is_empty() || close_col >= cells.len() {
            continue;
        }

        let close = match parse_number_string(&cells[close_col], locale) {
            Some(v) => v,
            None => continue,
        };

        let date = date_col
            .and_then(|c| cells.get(c))
            .and_then(|s| parse_date(s, date_fmt));
        let open = open_col
            .and_then(|c| cells.get(c))
            .and_then(|s| parse_number_string(s, locale));
        let high = high_col
            .and_then(|c| cells.get(c))
            .and_then(|s| parse_number_string(s, locale));
        let low = low_col
            .and_then(|c| cells.get(c))
            .and_then(|s| parse_number_string(s, locale));
        let volume = volume_col
            .and_then(|c| cells.get(c))
            .and_then(|s| parse_number_string(s, locale));

        rows.push(ExtractedRow {
            date,
            close,
            open,
            high,
            low,
            volume,
        });
    }

    rows
}

/// Parse a "table_idx:col_idx" path.
fn parse_table_col_path(path: &str) -> Option<(usize, usize)> {
    let parts: Vec<&str> = path.split(':').collect();
    if parts.len() != 2 {
        return None;
    }
    Some((parts[0].parse().ok()?, parts[1].parse().ok()?))
}

// ─── CSV multi-row extraction ────────────────────────────────────────────────

fn extract_csv_rows(
    body: &str,
    source: &CustomProviderSource,
    locale: Option<&str>,
) -> Vec<ExtractedRow> {
    let records = match parse_csv_records(body) {
        Some(r) => r,
        None => return Vec::new(),
    };
    if records.len() < 2 {
        return Vec::new();
    }

    let headers = &records[0];
    let close_col = match resolve_csv_column(headers, &source.price_path) {
        Some(c) => c,
        None => return Vec::new(),
    };
    let date_col = source
        .date_path
        .as_ref()
        .and_then(|p| resolve_csv_column(headers, p));
    let open_col = source
        .open_path
        .as_ref()
        .and_then(|p| resolve_csv_column(headers, p));
    let high_col = source
        .high_path
        .as_ref()
        .and_then(|p| resolve_csv_column(headers, p));
    let low_col = source
        .low_path
        .as_ref()
        .and_then(|p| resolve_csv_column(headers, p));
    let volume_col = source
        .volume_path
        .as_ref()
        .and_then(|p| resolve_csv_column(headers, p));

    let date_fmt = source.date_format.as_deref();

    records[1..]
        .iter()
        .filter_map(|row| {
            let close = row
                .get(close_col)
                .and_then(|s| parse_number_string(s, locale))?;
            let date = date_col
                .and_then(|c| row.get(c))
                .and_then(|s| parse_date(s, date_fmt));
            let open = open_col
                .and_then(|c| row.get(c))
                .and_then(|s| parse_number_string(s, locale));
            let high = high_col
                .and_then(|c| row.get(c))
                .and_then(|s| parse_number_string(s, locale));
            let low = low_col
                .and_then(|c| row.get(c))
                .and_then(|s| parse_number_string(s, locale));
            let volume = volume_col
                .and_then(|c| row.get(c))
                .and_then(|s| parse_number_string(s, locale));

            Some(ExtractedRow {
                date,
                close,
                open,
                high,
                low,
                volume,
            })
        })
        .collect()
}

// ─── JSON multi-row extraction ───────────────────────────────────────────────

fn extract_json_rows(
    body: &str,
    source: &CustomProviderSource,
    symbol: &str,
    currency_hint: Option<&str>,
    locale: Option<&str>,
    from: Option<&str>,
    to: Option<&str>,
) -> Vec<ExtractedRow> {
    use jsonpath_rust::JsonPathQuery;

    let json: serde_json::Value = match serde_json::from_str(body) {
        Ok(j) => j,
        Err(_) => return Vec::new(),
    };

    let currency = currency_hint.unwrap_or("USD");
    let tctx = TemplateContext {
        symbol,
        currency,
        isin: None,
        mic: None,
        from,
        to,
    };
    let expand_path = |p: &str| -> String { expand_template(p, &tctx) };

    const MAX_JSON_ROWS: usize = 10_000;

    let price_path = expand_path(&source.price_path);
    let prices: Vec<serde_json::Value> = match json.clone().path(&price_path) {
        Ok(serde_json::Value::Array(arr)) => arr.into_iter().take(MAX_JSON_ROWS).collect(),
        Ok(val) => vec![val],
        Err(_) => return Vec::new(),
    };

    let dates: Vec<Option<String>> = source
        .date_path
        .as_ref()
        .and_then(|dp| {
            let dp = expand_path(dp);
            json.clone().path(&dp).ok().map(|v| match v {
                serde_json::Value::Array(arr) => {
                    arr.into_iter().map(|v| json_val_to_string(&v)).collect()
                }
                other => vec![json_val_to_string(&other)],
            })
        })
        .unwrap_or_default();

    let open_path = source.open_path.as_deref().map(expand_path);
    let high_path = source.high_path.as_deref().map(expand_path);
    let low_path = source.low_path.as_deref().map(expand_path);
    let volume_path = source.volume_path.as_deref().map(expand_path);
    let opens = extract_json_f64_array(&json, open_path.as_deref(), locale);
    let highs = extract_json_f64_array(&json, high_path.as_deref(), locale);
    let lows = extract_json_f64_array(&json, low_path.as_deref(), locale);
    let volumes = extract_json_f64_array(&json, volume_path.as_deref(), locale);

    let date_fmt = source.date_format.as_deref();

    debug!(
        "extract_json_rows: {} prices, {} dates, {} volumes (pricePath={}, datePath={:?})",
        prices.len(),
        dates.len(),
        volumes.len(),
        source.price_path,
        source.date_path,
    );

    prices
        .into_iter()
        .enumerate()
        .filter_map(|(i, val)| {
            let close = json_val_to_f64(&val, locale)?;
            let date = dates
                .get(i)
                .and_then(|s| s.as_ref())
                .and_then(|s| parse_date(s, date_fmt));
            Some(ExtractedRow {
                date,
                close,
                open: opens.get(i).copied().flatten(),
                high: highs.get(i).copied().flatten(),
                low: lows.get(i).copied().flatten(),
                volume: volumes.get(i).copied().flatten(),
            })
        })
        .collect()
}

fn extract_json_f64_array(
    json: &serde_json::Value,
    path: Option<&str>,
    locale: Option<&str>,
) -> Vec<Option<f64>> {
    use jsonpath_rust::JsonPathQuery;
    let Some(path) = path else {
        return Vec::new();
    };
    match json.clone().path(path) {
        Ok(serde_json::Value::Array(arr)) => arr
            .into_iter()
            .map(|v| json_val_to_f64(&v, locale))
            .collect(),
        Ok(val) => vec![json_val_to_f64(&val, locale)],
        Err(_) => Vec::new(),
    }
}

fn json_val_to_f64(val: &serde_json::Value, locale: Option<&str>) -> Option<f64> {
    match val {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => parse_number_string(s, locale),
        _ => None,
    }
}

fn json_val_to_string(val: &serde_json::Value) -> Option<String> {
    match val {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Null => None,
        other => Some(other.to_string()),
    }
}

// ─── Extraction helpers ──────────────────────────────────────────────────────

fn extract_json_string(body: &str, path: &str) -> Option<String> {
    use jsonpath_rust::JsonPathQuery;
    let json: serde_json::Value = serde_json::from_str(body).ok()?;
    let result = json.path(path).ok()?;
    let first = match &result {
        serde_json::Value::Array(arr) => arr.first()?,
        other => other,
    };
    match first {
        serde_json::Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

// extract_html_value imported from crate::custom_provider::model
// parse_number_string imported from crate::custom_provider::service

#[cfg(test)]
mod tests {
    use super::*;
    use std::borrow::Cow;
    use std::sync::Arc;
    use wealthfolio_market_data::{InstrumentId, ProviderOverrides, QuoteIdentifiers};

    fn ymd(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
    }

    fn json_source(price_path: &str) -> CustomProviderSource {
        CustomProviderSource {
            id: "test:historical".to_string(),
            provider_id: "test".to_string(),
            kind: "historical".to_string(),
            format: "json".to_string(),
            url: "https://example.test/prices".to_string(),
            price_path: price_path.to_string(),
            date_path: None,
            date_format: None,
            currency_path: None,
            factor: None,
            invert: None,
            locale: None,
            headers: None,
            open_path: None,
            high_path: None,
            low_path: None,
            volume_path: None,
            default_price: None,
            date_timezone: None,
        }
    }

    fn source_with_url(provider_id: &str, kind: &str, url: &str) -> CustomProviderSource {
        let mut source = json_source("$.price");
        source.id = format!("{provider_id}:{kind}");
        source.provider_id = provider_id.to_string();
        source.kind = kind.to_string();
        source.url = url.to_string();
        source
    }

    struct MockCustomProviderRepository {
        providers: Vec<crate::custom_provider::CustomProviderWithSources>,
    }

    #[async_trait::async_trait]
    impl CustomProviderRepository for MockCustomProviderRepository {
        fn get_all(
            &self,
        ) -> crate::errors::Result<Vec<crate::custom_provider::CustomProviderWithSources>> {
            Ok(self.providers.clone())
        }

        fn get_source_by_kind(
            &self,
            provider_code: &str,
            kind: &str,
        ) -> crate::errors::Result<Option<CustomProviderSource>> {
            Ok(self
                .providers
                .iter()
                .find(|provider| provider.id == provider_code)
                .and_then(|provider| provider.sources.iter().find(|source| source.kind == kind))
                .cloned())
        }

        async fn create(
            &self,
            _payload: &crate::custom_provider::NewCustomProvider,
        ) -> crate::errors::Result<crate::custom_provider::CustomProviderWithSources> {
            unreachable!("not used by custom scraper provider tests")
        }

        async fn update(
            &self,
            _provider_code: &str,
            _payload: &crate::custom_provider::UpdateCustomProvider,
        ) -> crate::errors::Result<crate::custom_provider::CustomProviderWithSources> {
            unreachable!("not used by custom scraper provider tests")
        }

        async fn delete(&self, _provider_code: &str) -> crate::errors::Result<()> {
            unreachable!("not used by custom scraper provider tests")
        }

        fn get_asset_count_for_provider(&self, _provider_code: &str) -> crate::errors::Result<i64> {
            Ok(0)
        }
    }

    struct MockSecretStore;

    impl SecretStore for MockSecretStore {
        fn set_secret(&self, _service: &str, _secret: &str) -> crate::errors::Result<()> {
            Ok(())
        }

        fn get_secret(&self, _service: &str) -> crate::errors::Result<Option<String>> {
            Ok(None)
        }

        fn delete_secret(&self, _service: &str) -> crate::errors::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn expand_url_uses_equity_identifier_isin_independently_from_symbol() {
        let context = QuoteContext {
            instrument: InstrumentId::Equity {
                ticker: Arc::from("LKPG"),
                mic: None,
            },
            identifiers: QuoteIdentifiers {
                isin: Some(Cow::Borrowed("SI0031101346")),
            },
            overrides: None,
            currency_hint: Some(Cow::Borrowed("EUR")),
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: Some("local-exchange".to_string()),
        };

        let url = CustomScraperProvider::expand_url(
            "https://server/history/{ISIN}/{SYMBOL}/{FROM}/{TO}/json",
            "LKPG",
            Some(&context),
            Some("2026-03-13"),
            Some("2026-06-11"),
        );

        assert_eq!(
            url,
            "https://server/history/SI0031101346/LKPG/2026-03-13/2026-06-11/json"
        );
    }

    #[test]
    fn find_sources_includes_isin_only_general_sources() {
        let repo = Arc::new(MockCustomProviderRepository {
            providers: vec![
                crate::custom_provider::CustomProviderWithSources {
                    id: "isin-source".to_string(),
                    name: "ISIN Source".to_string(),
                    description: String::new(),
                    enabled: true,
                    priority: 1,
                    sources: vec![source_with_url(
                        "isin-source",
                        "latest",
                        "https://example.test/quotes/{ISIN}",
                    )],
                },
                crate::custom_provider::CustomProviderWithSources {
                    id: "static-source".to_string(),
                    name: "Static Source".to_string(),
                    description: String::new(),
                    enabled: true,
                    priority: 2,
                    sources: vec![source_with_url(
                        "static-source",
                        "latest",
                        "https://example.test/quotes/static",
                    )],
                },
            ],
        });
        let provider = CustomScraperProvider::new(repo, Arc::new(MockSecretStore));
        let context = QuoteContext {
            instrument: InstrumentId::Equity {
                ticker: Arc::from("LKPG"),
                mic: None,
            },
            identifiers: QuoteIdentifiers {
                isin: Some(Cow::Borrowed("SI0031101346")),
            },
            overrides: None,
            currency_hint: Some(Cow::Borrowed("EUR")),
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        };

        let sources = provider.find_sources(&context, "latest").unwrap();

        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].provider_id, "isin-source");
        assert_eq!(sources[0].url, "https://example.test/quotes/{ISIN}");
    }

    #[test]
    fn resolve_symbol_uses_legacy_bond_custom_provider_mapping() {
        let overrides = ProviderOverrides::from_json(&serde_json::json!({
            "CUSTOM:single-point": {
                "type": "bond_isin",
                "symbol": "SWB:US744330AA93"
            }
        }))
        .unwrap();
        let context = QuoteContext {
            instrument: InstrumentId::Bond {
                isin: Arc::from("US744330AA93"),
            },
            identifiers: Default::default(),
            overrides: Some(overrides),
            currency_hint: Some(Cow::Borrowed("USD")),
            preferred_provider: Some(Cow::Borrowed("CUSTOM_SCRAPER")),
            bond_metadata: None,
            custom_provider_code: Some("single-point".to_string()),
        };
        let source = CustomProviderSource {
            id: "source-1".to_string(),
            provider_id: "single-point".to_string(),
            kind: "latest".to_string(),
            format: "json".to_string(),
            url: "https://example.test/?ticker={SYMBOL}".to_string(),
            price_path: "$.price".to_string(),
            date_path: None,
            date_format: None,
            currency_path: None,
            factor: None,
            invert: None,
            locale: None,
            headers: None,
            open_path: None,
            high_path: None,
            low_path: None,
            volume_path: None,
            default_price: None,
            date_timezone: None,
        };

        assert_eq!(
            CustomScraperProvider::resolve_symbol(&context, &source, "US744330AA93"),
            "SWB:US744330AA93"
        );
    }

    #[test]
    fn extract_json_rows_expands_historical_date_placeholders() {
        let body = r#"{
            "series": {
                "2026-01-01": [{ "date": "2026-01-01", "close": "10.50", "open": "10.00" }],
                "2026-02-01": [{ "date": "2026-02-01", "close": "12.50", "open": "12.00" }]
            },
            "meta": {
                "currencyByTo": { "2026-02-01": "CAD" }
            }
        }"#;
        let mut source = json_source("$.series.{TO}[*].close");
        source.date_path = Some("$.series.{TO}[*].date".to_string());
        source.open_path = Some("$.series.{TO}[*].open".to_string());
        source.currency_path = Some("$.meta.currencyByTo.{TO}".to_string());

        let rows = extract_json_rows(
            body,
            &source,
            "ABC",
            Some("USD"),
            None,
            Some("2026-01-01"),
            Some("2026-02-01"),
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].date, Some(ymd(2026, 2, 1)));
        assert_eq!(rows[0].close, 12.5);
        assert_eq!(rows[0].open, Some(12.0));

        let currency = resolve_currency(
            &source,
            "ABC",
            Some("USD"),
            body,
            Some("2026-01-01"),
            Some("2026-02-01"),
        );
        assert_eq!(currency, "CAD");
    }

    #[test]
    fn extract_json_rows_supports_unicode_keys() {
        let body = r#"[
            { "净值日期": "2026-07-10T00:00:00.000", "单位净值": 1.4018 },
            { "净值日期": "2026-07-11T00:00:00.000", "单位净值": 1.4026 }
        ]"#;
        let mut source = json_source(r#"$[*]["单位净值"]"#);
        source.date_path = Some(r#"$[*]["净值日期"]"#.to_string());

        let rows = extract_json_rows(body, &source, "001097", Some("CNY"), None, None, None);

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].date, Some(ymd(2026, 7, 10)));
        assert_eq!(rows[0].close, 1.4018);
        assert_eq!(rows[1].date, Some(ymd(2026, 7, 11)));
        assert_eq!(rows[1].close, 1.4026);
    }

    #[test]
    fn parse_date_iso_date_only() {
        assert_eq!(parse_date("2026-03-30", None), Some(ymd(2026, 3, 30)));
    }

    #[test]
    fn parse_date_iso_datetime_with_z() {
        assert_eq!(
            parse_date("2026-03-30T12:00:00Z", None),
            Some(ymd(2026, 3, 30))
        );
    }

    #[test]
    fn parse_date_iso_datetime_with_offset() {
        assert_eq!(
            parse_date("2026-04-03T07:39:00+00:00", None),
            Some(ymd(2026, 4, 3))
        );
    }

    #[test]
    fn parse_date_iso_datetime_preserves_local_date() {
        // 23:00 local on Apr 3 (UTC-05:00) is Apr 4 in UTC — we want the source's local date.
        assert_eq!(
            parse_date("2026-04-03T23:00:00-05:00", None),
            Some(ymd(2026, 4, 3))
        );
    }

    #[test]
    fn parse_date_iso_datetime_with_fractional_seconds() {
        assert_eq!(
            parse_date("2026-03-30T12:00:00.123Z", None),
            Some(ymd(2026, 3, 30))
        );
    }

    #[test]
    fn parse_date_iso_datetime_naive() {
        assert_eq!(
            parse_date("2026-03-30T12:00:00", None),
            Some(ymd(2026, 3, 30))
        );
    }

    #[test]
    fn parse_date_unix_seconds() {
        // 2024-04-01 00:00:00 UTC
        assert_eq!(parse_date("1711929600", None), Some(ymd(2024, 4, 1)));
    }

    #[test]
    fn parse_date_unix_millis() {
        assert_eq!(parse_date("1711929600000", None), Some(ymd(2024, 4, 1)));
    }

    #[test]
    fn parse_date_excel_serial() {
        // Excel day serial 45383 → 2024-04-01 (1899-12-30 + 45383 days)
        assert_eq!(parse_date("45383", None), Some(ymd(2024, 4, 1)));
    }

    #[test]
    fn parse_date_explicit_format() {
        assert_eq!(
            parse_date("2026-04-03T07:39:00+00:00", Some("%Y-%m-%dT%H:%M:%S%:z")),
            Some(ymd(2026, 4, 3))
        );
    }

    #[test]
    fn parse_date_empty_and_garbage() {
        assert_eq!(parse_date("", None), None);
        assert_eq!(parse_date("   ", None), None);
        assert_eq!(parse_date("not a date", None), None);
    }
}
