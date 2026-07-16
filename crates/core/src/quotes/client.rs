//! Market Data Client - Facade for the market-data crate.
//!
//! This module provides a clean interface between the core domain layer
//! and the market-data crate's provider system.
//!
//! # Architecture
//!
//! ```text
//! ┌─────────────────────────────────────────────────────────────────────┐
//! │                         Core Domain Layer                           │
//! │                                                                     │
//! │  Asset ─────────────────────────────────────────────▶ core::Quote   │
//! │                           │                               ▲         │
//! │                           │                               │         │
//! │                           ▼                               │         │
//! │  ┌─────────────────────────────────────────────────────────────┐   │
//! │  │                    MarketDataClient                          │   │
//! │  │                                                              │   │
//! │  │  Asset ─▶ QuoteContext ─▶ ProviderRegistry ─▶ market::Quote  │   │
//! │  │                                                   │          │   │
//! │  │                                    convert ◀──────┘          │   │
//! │  └─────────────────────────────────────────────────────────────┘   │
//! └─────────────────────────────────────────────────────────────────────┘
//! ```

use std::borrow::Cow;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use log::{debug, info, warn};

use crate::assets::{canonicalize_market_identity, Asset, InstrumentType, ProviderProfile};
use crate::errors::Result;
use crate::quotes::constants::*;
use crate::quotes::model::SymbolSearchResult;
use crate::quotes::Quote;
use crate::secrets::SecretStore;

use wealthfolio_market_data::{
    mic_to_currency, mic_to_exchange_name, yahoo_equity_provider_symbol_to_canonical,
    yahoo_exchange_to_mic, yahoo_suffix_to_mic, AlphaVantageProvider,
    AssetProfile as MarketAssetProfile, BoerseFrankfurtProvider, BondQuoteMetadata, DividendEvent,
    ExchangeMap, FinnhubProvider, FixtureProvider, MarketDataAppProvider, MetalPriceApiProvider,
    OpenFigiProvider, ProviderId, ProviderRegistry, Quote as MarketQuote, QuoteContext,
    QuoteIdentifiers, ResolverChain, SearchResult as MarketSearchResult, SplitEvent,
    UsTreasuryCalcProvider, YahooProvider,
};

/// Market data error types.
#[derive(Debug, thiserror::Error)]
pub enum MarketDataClientError {
    /// A market data operation failed.
    /// Preserves the full error semantics from the market-data crate.
    #[error("{0}")]
    MarketData(#[from] wealthfolio_market_data::errors::MarketDataError),

    #[error("Invalid data: {0}")]
    InvalidData(String),
}

#[derive(Debug)]
pub struct HistoricalQuoteFetchError {
    pub error: crate::Error,
    pub provider_id: Option<String>,
}

impl From<MarketDataClientError> for crate::Error {
    fn from(e: MarketDataClientError) -> Self {
        use crate::quotes::MarketDataError;
        match e {
            MarketDataClientError::MarketData(external_err) => {
                // Use the From implementation to preserve error semantics
                crate::Error::MarketData(external_err.into())
            }
            MarketDataClientError::InvalidData(msg) => {
                crate::Error::MarketData(MarketDataError::InvalidData(msg))
            }
        }
    }
}

/// Provider configuration for initialization.
#[derive(Debug, Clone)]
pub struct ProviderConfig {
    /// Provider ID (e.g., "YAHOO", "ALPHA_VANTAGE")
    pub id: String,
    /// User-configured priority (lower = higher priority)
    pub priority: i32,
}

/// Market data client - facade for fetching quotes via the market-data crate.
///
/// Handles:
/// - Provider initialization with API keys
/// - Asset → QuoteContext conversion
/// - Quote type conversion (market-data → core)
/// - Coordinating with the market-data ProviderRegistry
pub struct MarketDataClient {
    registry: ProviderRegistry,
}

impl MarketDataClient {
    /// Create a new market data client with providers initialized from secrets.
    ///
    /// # Arguments
    ///
    /// * `secret_store` - Store for retrieving API keys
    /// * `enabled_providers` - List of provider configurations with IDs and priorities
    ///
    /// # Returns
    ///
    /// A new `MarketDataClient` instance. Note that if no providers could be initialized,
    /// the client will return `NoProvidersAvailable` errors when fetching quotes.
    pub async fn new(
        secret_store: Arc<dyn SecretStore>,
        enabled_providers: Vec<ProviderConfig>,
    ) -> Result<Self> {
        Self::new_with_extra(secret_store, enabled_providers, vec![]).await
    }

    /// Create a new market data client with extra pre-built providers (e.g., CustomScraperProvider).
    pub async fn new_with_extra(
        secret_store: Arc<dyn SecretStore>,
        enabled_providers: Vec<ProviderConfig>,
        extra_providers: Vec<Arc<dyn wealthfolio_market_data::MarketDataProvider>>,
    ) -> Result<Self> {
        use std::collections::HashMap;

        let mut providers: Vec<Arc<dyn wealthfolio_market_data::MarketDataProvider>> = Vec::new();
        let mut init_errors: Vec<String> = Vec::new();
        let mut custom_priorities: HashMap<String, i32> = HashMap::new();

        for config in &enabled_providers {
            match Self::create_provider(&config.id, &secret_store).await {
                Ok(Some(provider)) => {
                    info!("Initialized market data provider: {}", config.id);
                    custom_priorities.insert(config.id.clone(), config.priority);
                    providers.push(provider);
                }
                Ok(None) => {
                    debug!(
                        "Provider {} requires API key but none found, skipping",
                        config.id
                    );
                }
                Err(e) => {
                    let msg = format!("{}: {:?}", config.id, e);
                    warn!("Failed to initialize provider {}", msg);
                    init_errors.push(msg);
                }
            }
        }

        if Self::is_e2e_mode() {
            if !extra_providers.is_empty() {
                warn!(
                    "Skipping {} extra market data provider(s) because WEALTHFOLIO_E2E=1",
                    extra_providers.len()
                );
            }
        } else {
            // Append extra providers (e.g., CustomScraperProvider)
            for ep in extra_providers {
                info!("Registered extra provider: {}", ep.id());
                providers.push(ep);
            }
        }

        if providers.is_empty() {
            warn!(
                "No market data providers initialized! Enabled: {:?}, Errors: {:?}",
                enabled_providers, init_errors
            );
        } else {
            info!(
                "Market data client initialized with {} providers: {:?}",
                providers.len(),
                providers.iter().map(|p| p.id()).collect::<Vec<_>>()
            );
        }

        // Create the resolver chain for symbol resolution
        let resolver = Arc::new(ResolverChain::new());

        // Create the registry with custom priorities
        let registry = ProviderRegistry::with_priorities(providers, resolver, custom_priorities);

        Ok(Self { registry })
    }

    fn is_e2e_mode() -> bool {
        matches!(std::env::var("WEALTHFOLIO_E2E").as_deref(), Ok("1"))
    }

    fn e2e_fixture_dir() -> Result<String> {
        std::env::var("WEALTHFOLIO_FIXTURE_DIR").map_err(|_| {
            MarketDataClientError::InvalidData(
                "WEALTHFOLIO_FIXTURE_DIR must be set when WEALTHFOLIO_E2E=1".to_string(),
            )
            .into()
        })
    }

    fn create_e2e_provider(
        provider_id: &str,
    ) -> Result<Option<Arc<dyn wealthfolio_market_data::MarketDataProvider>>> {
        let fixture_dir = Self::e2e_fixture_dir()?;

        match provider_id {
            DATA_SOURCE_YAHOO => Ok(Some(Arc::new(FixtureProvider::new(fixture_dir)))),
            DATA_SOURCE_BOERSE_FRANKFURT => Ok(Some(Arc::new(FixtureProvider::new_for_provider(
                fixture_dir,
                DATA_SOURCE_BOERSE_FRANKFURT,
            )))),
            DATA_SOURCE_MARKET_DATA_APP
            | DATA_SOURCE_ALPHA_VANTAGE
            | DATA_SOURCE_METAL_PRICE_API
            | DATA_SOURCE_FINNHUB
            | DATA_SOURCE_OPENFIGI
            | DATA_SOURCE_US_TREASURY_CALC
            | DATA_SOURCE_CUSTOM_SCRAPER => {
                warn!(
                    "Provider {} is disabled because WEALTHFOLIO_E2E=1; add fixture support before using it in e2e",
                    provider_id
                );
                Ok(None)
            }
            DATA_SOURCE_MANUAL | DATA_SOURCE_CALCULATED | DATA_SOURCE_BROKER => Ok(None),
            _ => {
                warn!("Unknown provider ID: {}", provider_id);
                Ok(None)
            }
        }
    }

    /// Create a provider by ID with its API key.
    async fn create_provider(
        provider_id: &str,
        secret_store: &Arc<dyn SecretStore>,
    ) -> Result<Option<Arc<dyn wealthfolio_market_data::MarketDataProvider>>> {
        if Self::is_e2e_mode() {
            return Self::create_e2e_provider(provider_id);
        }

        match provider_id {
            DATA_SOURCE_YAHOO => {
                // Yahoo doesn't need an API key
                let provider = YahooProvider::new()
                    .await
                    .map_err(MarketDataClientError::from)?;
                Ok(Some(Arc::new(provider)))
            }
            DATA_SOURCE_MARKET_DATA_APP => {
                if let Ok(Some(key)) = secret_store.get_secret(provider_id) {
                    if !key.is_empty() {
                        let provider = MarketDataAppProvider::new(key);
                        return Ok(Some(Arc::new(provider)));
                    }
                }
                Ok(None)
            }
            DATA_SOURCE_ALPHA_VANTAGE => {
                if let Ok(Some(key)) = secret_store.get_secret(provider_id) {
                    if !key.is_empty() {
                        let provider = AlphaVantageProvider::new(key);
                        return Ok(Some(Arc::new(provider)));
                    }
                }
                Ok(None)
            }
            DATA_SOURCE_METAL_PRICE_API => {
                if let Ok(Some(key)) = secret_store.get_secret(provider_id) {
                    if !key.is_empty() {
                        let provider = MetalPriceApiProvider::new(key);
                        return Ok(Some(Arc::new(provider)));
                    }
                }
                Ok(None)
            }
            DATA_SOURCE_FINNHUB => {
                if let Ok(Some(key)) = secret_store.get_secret(provider_id) {
                    if !key.is_empty() {
                        let provider = FinnhubProvider::new(key);
                        return Ok(Some(Arc::new(provider)));
                    }
                }
                Ok(None)
            }
            DATA_SOURCE_OPENFIGI => {
                // OpenFIGI doesn't need an API key (free tier)
                Ok(Some(Arc::new(OpenFigiProvider::new())))
            }
            DATA_SOURCE_US_TREASURY_CALC => {
                // Calculates bond prices from US Treasury yield curve data (no API key)
                Ok(Some(Arc::new(UsTreasuryCalcProvider::new())))
            }
            DATA_SOURCE_BOERSE_FRANKFURT => {
                // European bond pricing via Börse Frankfurt (no API key)
                Ok(Some(Arc::new(BoerseFrankfurtProvider::new())))
            }
            _ => {
                warn!("Unknown provider ID: {}", provider_id);
                Ok(None)
            }
        }
    }

    /// Fetch historical quotes for an asset.
    ///
    /// # Arguments
    ///
    /// * `asset` - The asset to fetch quotes for
    /// * `start` - Start date (inclusive)
    /// * `end` - End date (inclusive)
    ///
    /// # Returns
    ///
    /// Vector of quotes in core format, or error if all providers fail.
    pub async fn fetch_historical_quotes(
        &self,
        asset: &Asset,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<Quote>> {
        self.fetch_historical_quotes_with_context(asset, start, end)
            .await
            .map_err(|ctx| ctx.error)
    }

    pub async fn fetch_historical_quotes_with_context(
        &self,
        asset: &Asset,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> std::result::Result<Vec<Quote>, HistoricalQuoteFetchError> {
        // Convert Asset to QuoteContext
        let context =
            self.build_quote_context(asset)
                .map_err(|error| HistoricalQuoteFetchError {
                    error,
                    provider_id: None,
                })?;

        debug!(
            "Fetching quotes for {:?} from {} to {}",
            context.instrument,
            start.format("%Y-%m-%d"),
            end.format("%Y-%m-%d")
        );

        let (market_result, diagnostics) = self
            .registry
            .fetch_quotes_with_diagnostics(&context, start, end)
            .await;

        let market_quotes = match market_result {
            Ok(quotes) => quotes,
            Err(error) => {
                let provider_id = diagnostics
                    .errors()
                    .into_iter()
                    .last()
                    .map(|(provider_id, _)| provider_id.to_string());
                return Err(HistoricalQuoteFetchError {
                    error: MarketDataClientError::MarketData(error).into(),
                    provider_id,
                });
            }
        };

        // Convert to core Quote format
        let core_quotes: Vec<Quote> = market_quotes
            .into_iter()
            .map(|mq| Self::convert_quote(mq, &asset.id))
            .collect();

        debug!(
            "Fetched {} quotes for asset {}",
            core_quotes.len(),
            asset.id
        );

        Ok(core_quotes)
    }

    /// Fetch the latest quote for an asset.
    pub async fn fetch_latest_quote(&self, asset: &Asset) -> Result<Quote> {
        let context = self.build_quote_context(asset)?;

        let market_quote = self
            .registry
            .fetch_latest_quote(&context)
            .await
            .map_err(MarketDataClientError::from)?;

        Ok(Self::convert_quote(market_quote, &asset.id))
    }

    /// Build a QuoteContext from an Asset.
    fn build_quote_context(&self, asset: &Asset) -> Result<QuoteContext> {
        // Convert Asset to InstrumentId
        let instrument = asset.to_instrument_id().ok_or_else(|| {
            MarketDataClientError::InvalidData(format!(
                "Asset {} with kind {:?} cannot be converted to InstrumentId",
                asset.id, asset.kind
            ))
        })?;

        // Build provider overrides from asset.provider_config JSON
        let overrides = asset
            .provider_overrides()
            .and_then(|json| wealthfolio_market_data::ProviderOverrides::from_json(json).ok());

        // Currency hint: prefer asset.quote_ccy, fall back to MIC-derived currency
        let currency_hint: Option<Cow<'static, str>> = if !asset.quote_ccy.is_empty() {
            Some(Cow::Owned(asset.quote_ccy.clone()))
        } else {
            asset
                .instrument_exchange_mic
                .as_ref()
                .and_then(|mic| mic_to_currency(mic))
                .map(Cow::Borrowed)
        };

        // Preferred provider from asset
        let preferred_provider: Option<ProviderId> = asset.preferred_provider().map(Cow::Owned);

        // Convert bond spec to market-data BondQuoteMetadata when available.
        // coupon_rate defaults to 0 for zero-coupon instruments (T-bills).
        // maturity_date is still required — without it we can't price.
        let bond_metadata = match asset.bond_spec() {
            Some(spec) if spec.maturity_date.is_some() => Some(BondQuoteMetadata {
                coupon_rate: spec.coupon_rate.unwrap_or(rust_decimal::Decimal::ZERO),
                maturity_date: spec.maturity_date.unwrap(),
                face_value: spec.face_value.unwrap_or(rust_decimal::Decimal::from(1000)),
                coupon_frequency: spec
                    .coupon_frequency
                    .unwrap_or_else(|| "SEMI_ANNUAL".to_string()),
            }),
            _ => None,
        };

        // Extract custom_provider_code from provider_config if present
        let custom_provider_code = asset
            .provider_config
            .as_ref()
            .and_then(|c| c.get("custom_provider_code"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        Ok(QuoteContext {
            instrument,
            identifiers: Self::quote_identifiers(asset),
            overrides,
            currency_hint,
            preferred_provider,
            bond_metadata,
            custom_provider_code,
        })
    }

    fn quote_identifiers(asset: &Asset) -> QuoteIdentifiers {
        let isin = asset
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("identifiers"))
            .and_then(|identifiers| identifiers.get("isin"))
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| Cow::Owned(value.to_uppercase()));

        QuoteIdentifiers { isin }
    }

    /// Convert a market-data Quote to a core Quote.
    fn convert_quote(market_quote: MarketQuote, asset_id: &str) -> Quote {
        let id = format!(
            "{}_{}_{}",
            asset_id,
            market_quote.timestamp.format("%Y-%m-%d"),
            market_quote.source
        );

        Quote {
            id,
            created_at: Utc::now(),
            data_source: market_quote.source,
            timestamp: market_quote.timestamp,
            asset_id: asset_id.to_string(),
            open: market_quote.open.unwrap_or(market_quote.close),
            high: market_quote.high.unwrap_or(market_quote.close),
            low: market_quote.low.unwrap_or(market_quote.close),
            close: market_quote.close,
            adjclose: market_quote.close, // Adjclose defaults to close
            volume: market_quote.volume.unwrap_or_default(),
            currency: market_quote.currency,
            notes: None,
        }
    }

    /// Get list of available providers.
    pub fn providers(&self) -> Vec<&str> {
        self.registry.providers().iter().map(|p| p.id()).collect()
    }

    /// Check if any providers are available.
    pub fn has_providers(&self) -> bool {
        !self.registry.providers().is_empty()
    }

    /// Get the number of available providers.
    pub fn provider_count(&self) -> usize {
        self.registry.providers().len()
    }

    /// Fetch split history for an asset over the given date range.
    ///
    /// Returns empty vec if no provider supports splits for this asset.
    pub async fn fetch_splits(
        &self,
        asset: &Asset,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Vec<SplitEvent> {
        let context = match self.build_quote_context(asset) {
            Ok(ctx) => ctx,
            Err(_) => return vec![],
        };
        self.registry.fetch_splits(&context, start, end).await
    }

    /// Fetch cash dividend history for an asset over the given date range.
    pub async fn fetch_dividends(
        &self,
        asset: &Asset,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<DividendEvent>> {
        let context = self.build_quote_context(asset)?;
        let dividends = self
            .registry
            .fetch_dividends(&context, start, end)
            .await
            .map_err(MarketDataClientError::from)?;
        Ok(dividends)
    }

    /// Fetch historical quotes for multiple assets.
    ///
    /// Fetches quotes for each asset sequentially. For high-volume scenarios,
    /// consider batching or parallel execution at the caller level.
    ///
    /// # Arguments
    ///
    /// * `assets` - Assets to fetch quotes for
    /// * `start` - Start date (inclusive)
    /// * `end` - End date (inclusive)
    ///
    /// # Returns
    ///
    /// Map of asset_id -> quotes. Assets that fail to fetch are logged and omitted.
    pub async fn fetch_historical_quotes_bulk(
        &self,
        assets: &[Asset],
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> std::collections::HashMap<String, Vec<Quote>> {
        use std::collections::HashMap;

        let mut results: HashMap<String, Vec<Quote>> = HashMap::new();

        for asset in assets {
            match self.fetch_historical_quotes(asset, start, end).await {
                Ok(quotes) => {
                    if !quotes.is_empty() {
                        results.insert(asset.id.clone(), quotes);
                    }
                }
                Err(e) => {
                    warn!("Failed to fetch quotes for asset {}: {:?}", asset.id, e);
                }
            }
        }

        info!(
            "Bulk fetch completed: {} of {} assets succeeded",
            results.len(),
            assets.len()
        );

        results
    }

    /// Search for symbols matching the query.
    ///
    /// # Arguments
    ///
    /// * `query` - Search query (e.g., "AAPL", "Apple")
    ///
    /// # Returns
    ///
    /// Vector of search results from providers that support search.
    pub async fn search(&self, query: &str) -> Result<Vec<SymbolSearchResult>> {
        debug!("Searching for '{}'", query);

        let results = self
            .registry
            .search(query)
            .await
            .map_err(MarketDataClientError::from)?;

        let summaries = results
            .into_iter()
            .map(Self::convert_search_result)
            .collect();

        Ok(summaries)
    }

    /// Get asset profile for an asset.
    ///
    /// Uses the same resolver as quote fetching to build provider-specific symbols
    /// (e.g., "VFV.TO" for Yahoo when the asset's exchange_mic is XTSE).
    ///
    /// # Arguments
    ///
    /// * `asset` - The asset to get profile for
    ///
    /// # Returns
    ///
    /// Asset profile from providers that support profiles.
    pub async fn get_profile(&self, asset: &Asset) -> Result<ProviderProfile> {
        let context = self.build_quote_context(asset)?;

        let profile = self
            .registry
            .get_profile(&context)
            .await
            .map_err(MarketDataClientError::from)?;

        let symbol = asset.instrument_symbol.as_deref().unwrap_or_default();
        Ok(Self::convert_profile(profile, symbol))
    }

    /// Convert a market-data SearchResult to core SymbolSearchResult.
    ///
    /// Enriches the result with canonical MIC codes and friendly exchange names:
    /// 1. Try mapping from Yahoo's exchange code (e.g., "NMS" -> "XNAS")
    /// 2. Try extracting MIC from symbol suffix (e.g., "SHOP.TO" -> "XTSE")
    /// 3. Look up friendly exchange name from MIC
    /// 4. Preserve provider-reported currency only (do NOT infer from MIC)
    fn yahoo_suffix_for_mic(mic: &str) -> Option<String> {
        ExchangeMap::new()
            .get_suffix(&Cow::Owned(mic.to_string()), &Cow::Borrowed("YAHOO"))
            .filter(|suffix| !suffix.is_empty())
            .map(str::to_string)
    }

    fn search_result_instrument_type(
        result: &MarketSearchResult,
        exchange_mic: Option<&str>,
    ) -> Option<InstrumentType> {
        let instrument_type = InstrumentType::from_external_str(&result.asset_type)?;
        if instrument_type == InstrumentType::Metal && exchange_mic.is_some() {
            return Some(InstrumentType::Equity);
        }

        Some(instrument_type)
    }

    fn search_result_quote_type(
        provider_quote_type: &str,
        instrument_type: Option<&InstrumentType>,
    ) -> String {
        match instrument_type {
            Some(InstrumentType::Metal) => "COMMODITY".to_string(),
            Some(InstrumentType::Equity)
                if provider_quote_type.eq_ignore_ascii_case("COMMODITY") =>
            {
                "EQUITY".to_string()
            }
            _ => provider_quote_type.to_string(),
        }
    }

    fn convert_search_result(result: MarketSearchResult) -> SymbolSearchResult {
        // Prefer provider-supplied MIC (e.g., BF sets this directly).
        // Fall back to Yahoo-specific helpers when the provider didn't set it.
        let mut exchange_mic = result.exchange_mic.clone();

        if exchange_mic.is_none() {
            exchange_mic = yahoo_exchange_to_mic(&result.exchange).map(|mic| mic.to_string());
        }
        if exchange_mic.is_none() {
            if let Some(dot_pos) = result.symbol.rfind('.') {
                let suffix = &result.symbol[dot_pos + 1..];
                exchange_mic = yahoo_suffix_to_mic(suffix).map(String::from);
            }
        }

        // Get friendly exchange name from MIC
        let exchange_name = exchange_mic
            .as_ref()
            .and_then(|mic| mic_to_exchange_name(mic))
            .map(String::from);

        // Determine currency and its provenance
        let (currency, currency_source) = if result.currency.is_some() {
            (result.currency.clone(), Some("provider".to_string()))
        } else {
            let inferred = exchange_mic
                .as_ref()
                .and_then(|mic| mic_to_currency(mic))
                .map(String::from);
            let source = if inferred.is_some() {
                Some("exchange_inferred".to_string())
            } else {
                None
            };
            (inferred, source)
        };

        let instrument_type = Self::search_result_instrument_type(&result, exchange_mic.as_deref());
        let quote_type =
            Self::search_result_quote_type(&result.asset_type, instrument_type.as_ref());
        let provider_id = result
            .data_source
            .clone()
            .or_else(|| Some("YAHOO".to_string()));
        let provider_symbol = Some(result.symbol.clone());
        let symbol_for_identity = if provider_id.as_deref() == Some("YAHOO")
            && instrument_type.as_ref() == Some(&InstrumentType::Equity)
        {
            yahoo_equity_provider_symbol_to_canonical(&result.symbol)
        } else {
            result.symbol.clone()
        };
        let canonical_identity = canonicalize_market_identity(
            instrument_type.clone(),
            Some(symbol_for_identity.as_str()),
            exchange_mic.as_deref(),
            currency.as_deref(),
        );
        let review_symbol = if provider_id.as_deref() == Some("YAHOO")
            && instrument_type.as_ref() == Some(&InstrumentType::Equity)
        {
            let display_symbol = canonical_identity
                .instrument_symbol
                .as_deref()
                .unwrap_or(symbol_for_identity.as_str());
            match canonical_identity
                .instrument_exchange_mic
                .as_deref()
                .and_then(Self::yahoo_suffix_for_mic)
            {
                Some(suffix) if !suffix.is_empty() => format!("{display_symbol}{suffix}"),
                _ => display_symbol.to_string(),
            }
        } else {
            result.symbol.clone()
        };

        SymbolSearchResult {
            symbol: review_symbol,
            canonical_symbol: canonical_identity.instrument_symbol,
            canonical_exchange_mic: canonical_identity.instrument_exchange_mic,
            provider_id: provider_id.clone(),
            provider_symbol,
            short_name: result.name.clone(),
            long_name: result.name,
            exchange: result.exchange,
            exchange_mic,
            exchange_name,
            quote_type,
            type_display: String::new(),
            currency,
            currency_source,
            data_source: provider_id,
            quote_mode: Some("MARKET".to_string()),
            is_existing: false,
            existing_asset_id: None,
            index: String::new(),
            score: result.score.unwrap_or(0.0),
        }
    }

    /// Fetch historical quotes for multiple symbols (legacy interface for sync).
    ///
    /// This method provides backward compatibility with the sync system that works
    /// with (symbol, currency) tuples. Internally creates minimal Asset objects.
    ///
    /// # Arguments
    ///
    /// * `symbols_with_currencies` - Tuples of (symbol, currency)
    /// * `start` - Start time
    /// * `end` - End time
    ///
    /// # Returns
    ///
    /// Tuple of (quotes, failed_symbols) for compatibility with sync logic.
    pub async fn fetch_quotes_by_symbols(
        &self,
        symbols_with_currencies: &[(String, String)],
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<(Vec<Quote>, Vec<(String, String)>)> {
        let mut all_quotes = Vec::new();
        let mut failed = Vec::new();

        for (symbol, currency) in symbols_with_currencies {
            // Create a minimal asset for the fetch
            let asset = Asset {
                id: symbol.clone(),
                instrument_symbol: Some(symbol.clone()),
                display_code: Some(symbol.clone()),
                quote_ccy: currency.clone(),
                kind: crate::assets::AssetKind::Investment,
                instrument_type: Some(crate::assets::InstrumentType::Equity),
                quote_mode: crate::assets::QuoteMode::Market,
                ..Default::default()
            };

            match self.fetch_historical_quotes(&asset, start, end).await {
                Ok(quotes) => all_quotes.extend(quotes),
                Err(e) => {
                    debug!("Failed to fetch quotes for {}: {:?}", symbol, e);
                    failed.push((symbol.clone(), currency.clone()));
                }
            }
        }

        Ok((all_quotes, failed))
    }

    /// Convert a market-data AssetProfile to core ProviderProfile.
    fn convert_profile(profile: MarketAssetProfile, symbol: &str) -> ProviderProfile {
        // Prefer sectors (JSON array with weights for ETFs) over single sector
        let sectors = profile.sectors.or_else(|| {
            profile
                .sector
                .map(|s| format!("[{{\"name\":\"{}\",\"weight\":1}}]", s))
        });

        ProviderProfile {
            id: Some(symbol.to_string()),
            isin: profile.isin,
            name: profile.name,
            asset_type: profile.quote_type, // Maps to AssetKind during enrichment
            symbol: symbol.to_string(),
            quote_symbol: Some(symbol.to_string()),
            currency: String::new(),
            // Use provider source from profile, fallback to YAHOO for backwards compatibility
            data_source: profile.source.unwrap_or_else(|| "YAHOO".to_string()),
            notes: profile.description,
            countries: profile
                .country
                .map(|c| format!("[{{\"name\":\"{}\",\"weight\":1}}]", c)),
            sectors,
            industry: profile.industry,
            categories: None,
            classes: profile.asset_allocation,
            attributes: None,
            url: profile.website,
            // Financial metrics
            market_cap: profile.market_cap,
            pe_ratio: profile.pe_ratio,
            dividend_yield: profile.dividend_yield,
            week_52_high: profile.week_52_high,
            week_52_low: profile.week_52_low,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assets::AssetKind;
    use chrono::TimeZone;
    use rust_decimal_macros::dec;
    use std::sync::Arc;

    // =========================================================================
    // Quote Conversion Tests
    // =========================================================================

    #[test]
    fn test_convert_quote_full_ohlcv() {
        let timestamp = Utc.with_ymd_and_hms(2024, 1, 15, 0, 0, 0).unwrap();
        let market_quote = MarketQuote::ohlcv(
            timestamp,
            dec!(100),
            dec!(105),
            dec!(95),
            dec!(102),
            dec!(1000000),
            "USD".to_string(),
            "YAHOO".to_string(),
        );

        let core_quote = MarketDataClient::convert_quote(market_quote, "AAPL");

        assert_eq!(core_quote.asset_id, "AAPL");
        assert_eq!(core_quote.id, "AAPL_2024-01-15_YAHOO");
        assert_eq!(core_quote.open, dec!(100));
        assert_eq!(core_quote.high, dec!(105));
        assert_eq!(core_quote.low, dec!(95));
        assert_eq!(core_quote.close, dec!(102));
        assert_eq!(core_quote.adjclose, dec!(102)); // Defaults to close
        assert_eq!(core_quote.volume, dec!(1000000));
        assert_eq!(core_quote.currency, "USD");
        assert_eq!(core_quote.data_source, "YAHOO");
    }

    #[test]
    fn test_convert_quote_minimal_close_only() {
        let timestamp = Utc.with_ymd_and_hms(2024, 6, 20, 0, 0, 0).unwrap();
        let market_quote = MarketQuote::new(
            timestamp,
            dec!(150.50),
            "CAD".to_string(),
            "ALPHA_VANTAGE".to_string(),
        );

        let core_quote = MarketDataClient::convert_quote(market_quote, "SHOP.TO");

        assert_eq!(core_quote.asset_id, "SHOP.TO");
        assert_eq!(core_quote.id, "SHOP.TO_2024-06-20_ALPHA_VANTAGE");
        // OHLC should all be close when not provided
        assert_eq!(core_quote.open, dec!(150.50));
        assert_eq!(core_quote.high, dec!(150.50));
        assert_eq!(core_quote.low, dec!(150.50));
        assert_eq!(core_quote.close, dec!(150.50));
        assert_eq!(core_quote.volume, dec!(0));
        assert_eq!(core_quote.data_source, "ALPHA_VANTAGE");
    }

    #[test]
    fn test_convert_quote_all_data_sources() {
        let timestamp = Utc::now();

        let test_cases = [
            "YAHOO",
            "ALPHA_VANTAGE",
            "MARKETDATA_APP",
            "METAL_PRICE_API",
            "FINNHUB",
            "MANUAL",
            "CUSTOM_SCRAPER:coingecko", // Custom provider with code
        ];

        for source_str in test_cases {
            let market_quote = MarketQuote::new(
                timestamp,
                dec!(100),
                "USD".to_string(),
                source_str.to_string(),
            );

            let core_quote = MarketDataClient::convert_quote(market_quote, "TEST");
            assert_eq!(
                core_quote.data_source, source_str,
                "Source string '{}' should be preserved verbatim",
                source_str
            );
        }
    }

    #[test]
    fn test_convert_quote_special_characters_in_asset_id() {
        let timestamp = Utc.with_ymd_and_hms(2024, 1, 1, 0, 0, 0).unwrap();
        let market_quote = MarketQuote::new(
            timestamp,
            dec!(1.25),
            "USD".to_string(),
            "YAHOO".to_string(),
        );

        // Test FX pair format
        let core_quote = MarketDataClient::convert_quote(market_quote.clone(), "EUR/USD");
        assert_eq!(core_quote.asset_id, "EUR/USD");
        assert_eq!(core_quote.id, "EUR/USD_2024-01-01_YAHOO");

        // Test crypto format
        let core_quote = MarketDataClient::convert_quote(market_quote, "BTC-USD");
        assert_eq!(core_quote.asset_id, "BTC-USD");
        assert_eq!(core_quote.id, "BTC-USD_2024-01-01_YAHOO");
    }

    #[test]
    fn test_convert_search_result_preserves_provider_currency() {
        let provider_result = MarketSearchResult::new(
            "VFEG.L",
            "Vanguard FTSE Emerging Markets UCITS ETF USD Accumulation",
            "LSE",
            "ETF",
        )
        .with_currency("GBP")
        .with_score(20001.0);

        let result = MarketDataClient::convert_search_result(provider_result);
        assert_eq!(result.symbol, "VFEG.L");
        assert_eq!(result.exchange_mic.as_deref(), Some("XLON"));
        assert_eq!(result.currency.as_deref(), Some("GBP"));
        assert_eq!(result.currency_source.as_deref(), Some("provider"));
    }

    #[test]
    fn test_convert_search_result_infers_currency_from_mic() {
        let provider_result =
            MarketSearchResult::new("VFEG.L", "Vanguard ETF", "LSE", "ETF").with_score(20001.0);

        let result = MarketDataClient::convert_search_result(provider_result);
        assert_eq!(result.symbol, "VFEG.L");
        assert_eq!(result.exchange_mic.as_deref(), Some("XLON"));
        assert_eq!(result.currency.as_deref(), Some("GBp"));
        assert_eq!(result.currency_source.as_deref(), Some("exchange_inferred"));
    }

    #[test]
    fn test_convert_search_result_maps_cxe_to_cboe_mic() {
        let provider_result =
            MarketSearchResult::new("VWRPL.XC", "Vanguard ETF", "CXE", "ETF").with_score(20001.0);

        let result = MarketDataClient::convert_search_result(provider_result);
        assert_eq!(result.symbol, "VWRPL.XC");
        assert_eq!(result.exchange_mic.as_deref(), Some("CXE"));
        assert_eq!(result.currency.as_deref(), Some("GBP"));
        assert_eq!(result.currency_source.as_deref(), Some("exchange_inferred"));
    }

    #[test]
    fn test_convert_search_result_maps_lowercase_exchange_code() {
        let provider_result =
            MarketSearchResult::new("VWRPL.XC", "Vanguard ETF", "cxe", "ETF").with_score(20001.0);

        let result = MarketDataClient::convert_search_result(provider_result);
        assert_eq!(result.exchange_mic.as_deref(), Some("CXE"));
    }

    #[test]
    fn test_convert_search_result_carries_canonical_and_provider_symbols() {
        let provider_result = MarketSearchResult::new("SHOP.TO", "Shopify Inc.", "TOR", "EQUITY")
            .with_currency("CAD")
            .with_data_source("YAHOO");

        let result = MarketDataClient::convert_search_result(provider_result);

        assert_eq!(result.symbol, "SHOP.TO");
        assert_eq!(result.canonical_symbol.as_deref(), Some("SHOP"));
        assert_eq!(result.canonical_exchange_mic.as_deref(), Some("XTSE"));
        assert_eq!(result.provider_id.as_deref(), Some("YAHOO"));
        assert_eq!(result.provider_symbol.as_deref(), Some("SHOP.TO"));
    }

    #[test]
    fn test_convert_search_result_treats_exchange_traded_commodity_as_equity() {
        let provider_result = MarketSearchResult::new("4GLD.DE", "Xetra-Gold", "GER", "COMMODITY")
            .with_currency("EUR")
            .with_data_source("YAHOO");

        let result = MarketDataClient::convert_search_result(provider_result);

        assert_eq!(result.symbol, "4GLD.DE");
        assert_eq!(result.canonical_symbol.as_deref(), Some("4GLD"));
        assert_eq!(result.canonical_exchange_mic.as_deref(), Some("XETR"));
        assert_eq!(result.quote_type, "EQUITY");
    }

    #[test]
    fn test_convert_search_result_maps_yahoo_share_class_provider_symbol() {
        let provider_result =
            MarketSearchResult::new("BRK-B", "Berkshire Hathaway Inc.", "NYQ", "EQUITY")
                .with_currency("USD")
                .with_data_source("YAHOO");

        let result = MarketDataClient::convert_search_result(provider_result);

        assert_eq!(result.symbol, "BRK.B");
        assert_eq!(result.canonical_symbol.as_deref(), Some("BRK.B"));
        assert_eq!(result.canonical_exchange_mic.as_deref(), Some("XNYS"));
        assert_eq!(result.provider_symbol.as_deref(), Some("BRK-B"));
    }

    #[test]
    fn test_convert_search_result_exchange_suffix_wins_over_share_class_dot() {
        let provider_result =
            MarketSearchResult::new("BRK-B.TO", "Berkshire Hathaway Inc.", "TOR", "EQUITY")
                .with_currency("CAD")
                .with_data_source("YAHOO");

        let result = MarketDataClient::convert_search_result(provider_result);

        assert_eq!(result.symbol, "BRK.B.TO");
        assert_eq!(result.canonical_symbol.as_deref(), Some("BRK.B"));
        assert_eq!(result.canonical_exchange_mic.as_deref(), Some("XTSE"));
        assert_eq!(result.provider_symbol.as_deref(), Some("BRK-B.TO"));
    }

    #[test]
    fn test_convert_search_result_keeps_gold_miners_as_equity() {
        let provider_result =
            MarketSearchResult::new("GOLD", "Barrick Gold Corporation", "NYQ", "EQUITY")
                .with_currency("USD")
                .with_data_source("YAHOO");

        let result = MarketDataClient::convert_search_result(provider_result);

        assert_eq!(result.quote_type, "EQUITY");
        assert_eq!(result.canonical_symbol.as_deref(), Some("GOLD"));
    }

    #[test]
    fn test_convert_profile_maps_asset_allocation_to_classes() {
        let market_profile = MarketAssetProfile {
            name: Some("Balanced ETF".to_string()),
            quote_type: Some("ETF".to_string()),
            asset_allocation: Some(
                r#"[{"name":"stock","weight":0.60},{"name":"bond","weight":0.40}]"#.to_string(),
            ),
            ..Default::default()
        };

        let provider_profile = MarketDataClient::convert_profile(market_profile, "BAL");

        assert_eq!(provider_profile.asset_type.as_deref(), Some("ETF"));
        assert_eq!(
            provider_profile.classes.as_deref(),
            Some(r#"[{"name":"stock","weight":0.60},{"name":"bond","weight":0.40}]"#)
        );
    }

    // =========================================================================
    // Build Quote Context Tests
    // =========================================================================

    fn create_test_asset(kind: AssetKind, symbol: &str, currency: &str) -> Asset {
        use crate::assets::{InstrumentType, QuoteMode};

        // Determine instrument_type from kind for test purposes
        let instrument_type = match kind {
            AssetKind::Investment => Some(InstrumentType::Equity),
            AssetKind::Fx => Some(InstrumentType::Fx),
            _ => None,
        };

        Asset {
            id: symbol.to_string(),
            kind,
            instrument_symbol: Some(symbol.to_string()),
            display_code: Some(symbol.to_string()),
            name: Some(format!("Test {}", symbol)),
            quote_ccy: currency.to_string(),
            instrument_exchange_mic: Some("XNAS".to_string()),
            instrument_type,
            quote_mode: QuoteMode::Market,
            ..Default::default()
        }
    }

    fn create_test_client() -> MarketDataClient {
        let registry = ProviderRegistry::new(Vec::new(), Arc::new(ResolverChain::new()));
        MarketDataClient { registry }
    }

    #[test]
    fn test_build_quote_context_equity() {
        let asset = create_test_asset(AssetKind::Investment, "AAPL", "USD");

        let instrument = asset.to_instrument_id();
        assert!(instrument.is_some());

        match instrument.unwrap() {
            wealthfolio_market_data::InstrumentId::Equity { ticker, mic } => {
                assert_eq!(ticker.as_ref(), "AAPL");
                assert_eq!(mic.as_deref(), Some("XNAS"));
            }
            _ => panic!("Expected Equity instrument"),
        }
    }

    #[test]
    fn test_build_quote_context_preserves_equity_isin_identifier() {
        let mut asset = create_test_asset(AssetKind::Investment, "LKPG", "EUR");
        asset.metadata = Some(serde_json::json!({
            "identifiers": {
                "isin": "SI0031101346"
            }
        }));

        let client = create_test_client();
        let context = client.build_quote_context(&asset).unwrap();

        match context.instrument {
            wealthfolio_market_data::InstrumentId::Equity { ticker, .. } => {
                assert_eq!(ticker.as_ref(), "LKPG");
            }
            _ => panic!("Expected Equity instrument"),
        }
        assert_eq!(context.identifiers.isin.as_deref(), Some("SI0031101346"));
    }

    #[test]
    fn test_build_quote_context_crypto() {
        let mut asset = create_test_asset(AssetKind::Investment, "BTC", "USD");
        asset.instrument_type = Some(crate::assets::InstrumentType::Crypto);
        asset.instrument_exchange_mic = None;

        let instrument = asset.to_instrument_id();
        assert!(instrument.is_some());

        match instrument.unwrap() {
            wealthfolio_market_data::InstrumentId::Crypto { base, quote } => {
                assert_eq!(base.as_ref(), "BTC");
                assert_eq!(quote.as_ref(), "USD");
            }
            _ => panic!("Expected Crypto instrument"),
        }
    }

    #[test]
    fn test_build_quote_context_fx() {
        let mut asset = create_test_asset(AssetKind::Fx, "EUR", "USD");
        asset.instrument_type = Some(crate::assets::InstrumentType::Fx);
        asset.instrument_exchange_mic = None;

        let instrument = asset.to_instrument_id();
        assert!(instrument.is_some());

        match instrument.unwrap() {
            wealthfolio_market_data::InstrumentId::Fx { base, quote } => {
                assert_eq!(base.as_ref(), "EUR");
                assert_eq!(quote.as_ref(), "USD");
            }
            _ => panic!("Expected Fx instrument"),
        }
    }

    #[test]
    fn test_build_quote_context_unsupported_asset_kinds() {
        let unsupported_kinds = [
            AssetKind::Property,
            AssetKind::Vehicle,
            AssetKind::Collectible,
            AssetKind::PreciousMetal,
            AssetKind::Liability,
            AssetKind::Other,
            AssetKind::PrivateEquity,
        ];

        for kind in unsupported_kinds {
            let kind_debug = format!("{:?}", kind);
            let asset = create_test_asset(kind, "TEST", "USD");
            let instrument = asset.to_instrument_id();
            assert!(
                instrument.is_none(),
                "Asset kind {} should not be convertible to InstrumentId",
                kind_debug
            );
        }
    }

    #[test]
    fn test_build_quote_context_currency_hint_prefers_asset_quote_currency() {
        let mut asset = create_test_asset(AssetKind::Investment, "SHOP", "TWD");
        asset.instrument_exchange_mic = Some("XTSE".to_string());
        let client = create_test_client();

        let context = client.build_quote_context(&asset).unwrap();

        assert_eq!(context.currency_hint.as_deref(), Some("TWD"));
    }

    #[test]
    fn test_build_quote_context_currency_hint_falls_back_to_mic_currency() {
        let mut asset = create_test_asset(AssetKind::Investment, "SHOP", "");
        asset.instrument_exchange_mic = Some("XTSE".to_string());
        let client = create_test_client();

        let context = client.build_quote_context(&asset).unwrap();

        assert_eq!(context.currency_hint.as_deref(), Some("CAD"));
    }

    #[test]
    fn test_build_quote_context_bond_metadata_populated() {
        use crate::assets::InstrumentType;
        use chrono::NaiveDate;

        let mut asset = create_test_asset(AssetKind::Investment, "US912810TD00", "USD");
        asset.instrument_type = Some(InstrumentType::Bond);
        asset.instrument_symbol = Some("US912810TD00".to_string());
        // Set bond metadata via the JSON metadata field (camelCase per BondSpec serde)
        asset.metadata = Some(serde_json::json!({
            "bond": {
                "couponRate": 0.04375,
                "maturityDate": "2040-11-15",
                "faceValue": 1000,
                "couponFrequency": "SEMI_ANNUAL"
            }
        }));

        let client = create_test_client();
        let context = client.build_quote_context(&asset).unwrap();

        let bond_meta = context
            .bond_metadata
            .expect("bond_metadata should be populated");
        assert_eq!(bond_meta.coupon_rate, dec!(0.04375));
        assert_eq!(
            bond_meta.maturity_date,
            NaiveDate::from_ymd_opt(2040, 11, 15).unwrap()
        );
        assert_eq!(bond_meta.face_value, dec!(1000));
        assert_eq!(bond_meta.coupon_frequency, "SEMI_ANNUAL");
    }

    #[test]
    fn test_build_quote_context_bond_metadata_none_when_missing() {
        use crate::assets::InstrumentType;

        let mut asset = create_test_asset(AssetKind::Investment, "US912810TD00", "USD");
        asset.instrument_type = Some(InstrumentType::Bond);
        asset.instrument_symbol = Some("US912810TD00".to_string());
        // Bond with no metadata — bond_metadata should be None
        asset.metadata = None;

        let client = create_test_client();
        let context = client.build_quote_context(&asset).unwrap();

        assert!(
            context.bond_metadata.is_none(),
            "bond_metadata should be None when no bond spec exists"
        );
    }

    // =========================================================================
    // Edge Case Tests
    // =========================================================================

    #[test]
    fn test_convert_quote_zero_values() {
        let timestamp = Utc::now();
        let market_quote = MarketQuote::ohlcv(
            timestamp,
            dec!(0),
            dec!(0),
            dec!(0),
            dec!(0),
            dec!(0),
            "USD".to_string(),
            "YAHOO".to_string(),
        );

        let core_quote = MarketDataClient::convert_quote(market_quote, "TEST");

        assert_eq!(core_quote.open, dec!(0));
        assert_eq!(core_quote.high, dec!(0));
        assert_eq!(core_quote.low, dec!(0));
        assert_eq!(core_quote.close, dec!(0));
        assert_eq!(core_quote.volume, dec!(0));
    }

    #[test]
    fn test_convert_quote_large_values() {
        let timestamp = Utc::now();
        let large_price = dec!(999999999.99);
        let large_volume = dec!(99999999999999);

        let market_quote = MarketQuote::ohlcv(
            timestamp,
            large_price,
            large_price,
            large_price,
            large_price,
            large_volume,
            "USD".to_string(),
            "YAHOO".to_string(),
        );

        let core_quote = MarketDataClient::convert_quote(market_quote, "BRK.A");

        assert_eq!(core_quote.close, large_price);
        assert_eq!(core_quote.volume, large_volume);
    }

    #[test]
    fn test_convert_quote_negative_values() {
        // Some instruments can have negative prices (e.g., oil futures in 2020)
        let timestamp = Utc::now();
        let market_quote = MarketQuote::ohlcv(
            timestamp,
            dec!(-37.63),
            dec!(-10.00),
            dec!(-40.32),
            dec!(-37.63),
            dec!(1000000),
            "USD".to_string(),
            "YAHOO".to_string(),
        );

        let core_quote = MarketDataClient::convert_quote(market_quote, "CL=F");

        assert_eq!(core_quote.close, dec!(-37.63));
        assert_eq!(core_quote.low, dec!(-40.32));
    }

    #[test]
    fn test_convert_quote_high_precision_decimals() {
        let timestamp = Utc::now();
        let precise_price = dec!(0.00001234); // Crypto can have high precision

        let market_quote = MarketQuote::new(
            timestamp,
            precise_price,
            "USD".to_string(),
            "YAHOO".to_string(),
        );

        let core_quote = MarketDataClient::convert_quote(market_quote, "SHIB-USD");

        assert_eq!(core_quote.close, precise_price);
    }

    #[test]
    fn test_build_quote_context_bond_zero_coupon() {
        use crate::assets::InstrumentType;
        use chrono::NaiveDate;

        let mut asset = create_test_asset(AssetKind::Investment, "US912797NQ65", "USD");
        asset.instrument_type = Some(InstrumentType::Bond);
        asset.instrument_symbol = Some("US912797NQ65".to_string());
        // Zero-coupon T-bill: couponRate is 0
        asset.metadata = Some(serde_json::json!({
            "bond": {
                "couponRate": 0,
                "maturityDate": "2025-12-18",
                "faceValue": 1000,
                "couponFrequency": "ZERO"
            }
        }));

        let client = create_test_client();
        let context = client.build_quote_context(&asset).unwrap();

        let bond_meta = context
            .bond_metadata
            .expect("bond_metadata should be Some for zero-coupon bond");
        assert_eq!(bond_meta.coupon_rate, dec!(0));
        assert_eq!(
            bond_meta.maturity_date,
            NaiveDate::from_ymd_opt(2025, 12, 18).unwrap()
        );
        assert_eq!(bond_meta.face_value, dec!(1000));
        assert_eq!(bond_meta.coupon_frequency, "ZERO");
    }
}
