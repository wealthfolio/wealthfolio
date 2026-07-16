//! Unified Quote Service.
//!
//! This module provides a comprehensive service for all quote-related operations:
//! - Quote CRUD (via QuoteStore)
//! - Provider operations (search, get_profile via MarketDataClient)
//! - Sync operations (via QuoteSyncService)
//! - Provider settings management
//! - Quote import/export

use async_trait::async_trait;
use chrono::{Duration, NaiveDate, TimeZone, Utc};
use log::{debug, info};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::utils::time_utils;

use super::client::{MarketDataClient, ProviderConfig};
use super::constants::{DATA_SOURCE_CUSTOM_SCRAPER, DATA_SOURCE_MANUAL, MAX_SYNC_ERRORS};
use super::import::{ImportValidationStatus, QuoteConverter, QuoteImport, QuoteValidator};
use super::model::{LatestQuotePair, Quote, ResolvedQuote, SymbolSearchResult};
use super::store::{ProviderSettingsStore, QuoteStore};
use super::sync::{QuoteSyncService, QuoteSyncServiceTrait, SyncResult};
use super::sync_state::{QuoteSyncState, SymbolSyncPlan, SyncCategory, SyncMode, SyncStateStore};
use super::types::{quote_id, AssetId, Day, QuoteSource};
use crate::activities::ActivityRepositoryTrait;
use crate::assets::{
    asset_provider_alias_symbols, canonicalize_market_identity, normalize_quote_ccy_code,
    parse_crypto_pair_symbol, parse_symbol_with_exchange_suffix, symbol_resolution_candidates,
    Asset, AssetKind, AssetRepositoryTrait, AssetSpec, InstrumentType, ProviderProfile, QuoteMode,
};
use crate::errors::Result;
use crate::fx::currency::{get_normalization_rule, normalize_currency_code};
use crate::portfolio::snapshot::is_quantity_significant;
use crate::secrets::SecretStore;

use wealthfolio_market_data::{
    exchanges_for_currency, mic_to_currency, mic_to_exchange_name,
    yahoo_equity_provider_symbol_to_canonical, DividendEvent, ExchangeMap,
};

/// Provider information combining static info with settings.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub url: Option<String>,
    pub enabled: bool,
    pub priority: i32,
    pub logo_filename: Option<String>,
    pub capabilities: Option<super::provider_settings::ProviderCapabilities>,
    pub requires_api_key: bool,
    pub has_api_key: bool,
    /// Number of assets synced by this provider
    pub asset_count: i64,
    /// Number of assets with sync errors
    pub error_count: i64,
    /// Most recent sync timestamp
    pub last_synced_at: Option<String>,
    /// Most recent error message (if any)
    pub last_sync_error: Option<String>,
    /// All unique error messages for this provider
    pub unique_errors: Vec<String>,
    /// Provider type: "builtin" or "custom"
    pub provider_type: Option<String>,
}

#[derive(Debug, Clone)]
pub struct FetchDividendsParams {
    pub symbol: String,
    pub exchange_mic: Option<String>,
    pub instrument_type: Option<InstrumentType>,
    pub quote_ccy: Option<String>,
    pub preferred_provider: Option<String>,
    pub start: Option<NaiveDate>,
    pub end: Option<NaiveDate>,
}

fn resolve_effective_quote_currency(asset_quote_ccy: &str, quote_ccy: &str) -> Option<String> {
    if asset_quote_ccy.is_empty() || quote_ccy.is_empty() || asset_quote_ccy == quote_ccy {
        return None;
    }

    if normalize_currency_code(asset_quote_ccy) != normalize_currency_code(quote_ccy) {
        return None;
    }

    // Minor-unit codes carry unit scale information that we must preserve.
    let asset_is_minor = get_normalization_rule(asset_quote_ccy).is_some();
    let quote_is_minor = get_normalization_rule(quote_ccy).is_some();

    if asset_is_minor && !quote_is_minor {
        return Some(asset_quote_ccy.to_string());
    }
    if quote_is_minor && !asset_is_minor {
        return Some(quote_ccy.to_string());
    }

    Some(asset_quote_ccy.to_string())
}

fn reconcile_quote_currency(quote: &mut Quote, asset: &Asset) {
    if let Some(effective) = resolve_effective_quote_currency(&asset.quote_ccy, &quote.currency) {
        quote.currency = effective;
    }
}

fn instrument_type_from_search_result(quote_type: &str) -> Option<InstrumentType> {
    match quote_type.to_uppercase().as_str() {
        "EQUITY" | "STOCK" | "ETF" | "MUTUALFUND" | "MUTUAL FUND" | "INDEX" | "ECNQUOTE" => {
            Some(InstrumentType::Equity)
        }
        "CRYPTOCURRENCY" | "CRYPTO" => Some(InstrumentType::Crypto),
        "CURRENCY" | "FOREX" | "FX" => Some(InstrumentType::Fx),
        "OPTION" => Some(InstrumentType::Option),
        "COMMODITY" => Some(InstrumentType::Metal),
        "BOND" | "MONEYMARKET" => Some(InstrumentType::Bond),
        _ => None,
    }
}

fn instrument_key_from_search_result(result: &SymbolSearchResult) -> Option<String> {
    let instrument_type = instrument_type_from_search_result(&result.quote_type)?;
    let canonical = canonicalize_market_identity(
        Some(instrument_type.clone()),
        result
            .canonical_symbol
            .as_deref()
            .or(Some(result.symbol.as_str())),
        result
            .canonical_exchange_mic
            .as_deref()
            .or(result.exchange_mic.as_deref()),
        result.currency.as_deref(),
    );

    AssetSpec {
        id: None,
        display_code: canonical.display_code,
        instrument_symbol: canonical.instrument_symbol,
        instrument_exchange_mic: canonical.instrument_exchange_mic,
        instrument_type: Some(instrument_type),
        quote_ccy: canonical.quote_ccy.unwrap_or_default(),
        requested_quote_ccy: None,
        kind: AssetKind::Investment,
        quote_mode: None,
        name: None,
        provider_config: None,
        provider_id: None,
        provider_symbol: None,
        metadata: None,
    }
    .instrument_key()
}

fn local_search_identity(query: &str) -> Option<(String, Option<&'static str>)> {
    let query = query.trim();
    if query.is_empty() {
        return None;
    }

    let (base_symbol, suffix_mic) = parse_symbol_with_exchange_suffix(query);
    let canonical_symbol = yahoo_equity_provider_symbol_to_canonical(base_symbol);
    let canonical_symbol = canonical_symbol.trim();
    if canonical_symbol.is_empty() {
        return None;
    }

    Some((canonical_symbol.to_string(), suffix_mic))
}

fn asset_matches_local_search_identity(
    asset: &Asset,
    canonical_symbol: &str,
    exchange_mic: Option<&str>,
) -> bool {
    let Some(asset_symbol) = asset.instrument_symbol.as_deref() else {
        return false;
    };
    if !asset_symbol.eq_ignore_ascii_case(canonical_symbol) {
        return false;
    }

    match exchange_mic {
        Some(expected) => asset
            .instrument_exchange_mic
            .as_deref()
            .is_some_and(|actual| actual.eq_ignore_ascii_case(expected)),
        None => true,
    }
}

fn asset_search_display_symbol(asset: &Asset) -> String {
    let stored_display = asset
        .display_code
        .clone()
        .or_else(|| asset.instrument_symbol.clone())
        .unwrap_or_default();
    let Some(instrument_symbol) = asset.instrument_symbol.as_deref().map(str::trim) else {
        return stored_display;
    };
    if !matches!(asset.instrument_type.as_ref(), Some(InstrumentType::Equity))
        || instrument_symbol.is_empty()
        || !stored_display
            .trim()
            .eq_ignore_ascii_case(instrument_symbol)
    {
        return stored_display;
    }

    let suffix = asset.instrument_exchange_mic.as_deref().and_then(|mic| {
        ExchangeMap::new()
            .get_suffix(
                &std::borrow::Cow::Owned(mic.to_string()),
                &std::borrow::Cow::Borrowed("YAHOO"),
            )
            .filter(|suffix| !suffix.is_empty())
            .map(str::to_string)
    });

    match suffix {
        Some(suffix) => format!("{instrument_symbol}{suffix}"),
        None => stored_display,
    }
}

fn extract_provider_id_from_sync_error(error: &str) -> Option<&'static str> {
    super::constants::MARKET_DATA_PROVIDER_IDS
        .into_iter()
        .find(|provider_id| error.contains(provider_id))
}

fn has_open_position_quantity(quantity: &rust_decimal::Decimal) -> bool {
    !quantity.is_zero() && is_quantity_significant(quantity)
}

fn provider_config_for_symbol_resolution(
    preferred_provider: Option<&str>,
) -> Option<serde_json::Value> {
    let provider = preferred_provider
        .map(str::trim)
        .filter(|p| !p.is_empty())?;

    if let Some(custom_code) = provider
        .strip_prefix("CUSTOM:")
        .map(str::trim)
        .filter(|code| !code.is_empty())
    {
        return Some(serde_json::json!({
            "preferred_provider": DATA_SOURCE_CUSTOM_SCRAPER,
            "custom_provider_code": custom_code,
        }));
    }

    Some(serde_json::json!({ "preferred_provider": provider }))
}

fn resolved_provider_matches_requested(
    resolved_provider: &str,
    requested_provider: Option<&str>,
) -> bool {
    let Some(requested) = requested_provider.map(str::trim).filter(|p| !p.is_empty()) else {
        return true;
    };

    if let Some(custom_code) = requested.strip_prefix("CUSTOM:") {
        return resolved_provider == format!("{}:{}", DATA_SOURCE_CUSTOM_SCRAPER, custom_code);
    }

    resolved_provider == requested
}

/// Latest quote payload enriched with backend freshness computation.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestQuoteSnapshot {
    pub quote: Option<Quote>,
    pub is_stale: bool,
    pub effective_market_date: String,
    pub quote_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_quote_reason: Option<NoQuoteReason>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoQuoteReason {
    pub code: String,
    pub message: String,
}

/// Unified trait for all quote operations.
#[async_trait]
pub trait QuoteServiceTrait: Send + Sync {
    // =========================================================================
    // Quote CRUD Operations
    // =========================================================================

    /// Get the latest quote for a symbol.
    fn get_latest_quote(&self, symbol: &str) -> Result<Quote>;

    /// Get the latest quotes for multiple symbols.
    fn get_latest_quotes(&self, symbols: &[String]) -> Result<HashMap<String, Quote>>;

    /// Get the latest quotes for multiple symbols, restricted to rows with `day <= as_of`.
    fn get_latest_quotes_as_of(
        &self,
        symbols: &[String],
        as_of: chrono::NaiveDate,
    ) -> Result<HashMap<String, Quote>>;

    /// Get latest quotes with backend-computed staleness metadata.
    fn get_latest_quotes_snapshot(
        &self,
        asset_ids: &[String],
    ) -> Result<HashMap<String, LatestQuoteSnapshot>>;

    /// Get the latest quote pairs (current + previous) for multiple symbols.
    fn get_latest_quotes_pair(
        &self,
        symbols: &[String],
    ) -> Result<HashMap<String, LatestQuotePair>>;

    /// Get all historical quotes for a symbol.
    fn get_historical_quotes(&self, symbol: &str) -> Result<Vec<Quote>>;

    /// Get all historical quotes grouped by symbol.
    fn get_all_historical_quotes(&self) -> Result<HashMap<String, Vec<(NaiveDate, Quote)>>>;

    /// Get quotes for symbols within a date range.
    fn get_quotes_in_range(
        &self,
        symbols: &HashSet<String>,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<Vec<Quote>>;

    /// Get quotes for symbols within a date range, with gap filling.
    ///
    /// This method fills in missing quotes for weekends and holidays by carrying
    /// forward the last known quote. This is essential for portfolio valuation
    /// which needs a quote for every day in the range.
    ///
    /// # Algorithm
    /// 1. Fetches all quotes in range (with lookback for initial values)
    /// 2. For each day in the range, outputs the last known quote for each symbol
    /// 3. Symbols with no quotes before the start date will have no output until their first quote
    ///
    /// # Arguments
    /// * `symbols` - Set of symbols to fetch quotes for
    /// * `start` - Start date of the range
    /// * `end` - End date of the range
    fn get_quotes_in_range_filled(
        &self,
        symbols: &HashSet<String>,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<Vec<Quote>>;

    /// Get daily quotes grouped by date, then by symbol.
    async fn get_daily_quotes(
        &self,
        asset_ids: &HashSet<String>,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<HashMap<NaiveDate, HashMap<String, Quote>>>;

    /// Add a new quote.
    async fn add_quote(&self, quote: &Quote) -> Result<Quote>;

    /// Update an existing quote.
    async fn update_quote(&self, quote: Quote) -> Result<Quote>;

    /// Delete a quote by ID.
    async fn delete_quote(&self, quote_id: &str) -> Result<()>;

    /// Bulk upsert quotes.
    async fn bulk_upsert_quotes(&self, quotes: Vec<Quote>) -> Result<usize>;

    // =========================================================================
    // Provider Operations (via MarketDataClient)
    // =========================================================================

    /// Search for symbols.
    ///
    /// Returns search results merged with existing assets. Existing assets are
    /// returned first, followed by provider results. Results are deduplicated
    /// by symbol+exchange and sorted by relevance to account_currency.
    async fn search_symbol(&self, query: &str) -> Result<Vec<SymbolSearchResult>>;

    /// Search for symbols with account currency for relevance sorting.
    ///
    /// # Arguments
    /// * `query` - Search query string
    /// * `account_currency` - Optional currency to sort results by exchange relevance
    ///
    /// # Returns
    /// Search results merged with existing assets, sorted by:
    /// 1. Existing assets first
    /// 2. Then by exchange relevance to account_currency (e.g., CAD account prefers TSX)
    /// 3. Then by provider relevance score
    async fn search_symbol_with_currency(
        &self,
        query: &str,
        account_currency: Option<&str>,
    ) -> Result<Vec<SymbolSearchResult>>;

    /// Resolve the latest quote for a symbol (currency, price, and provider).
    ///
    /// Best-effort: returns what the provider can give. Used during symbol selection
    /// to confirm inferred currency and pre-fill the price field.
    async fn resolve_symbol_quote(
        &self,
        symbol: &str,
        exchange_mic: Option<&str>,
        instrument_type: Option<&InstrumentType>,
        quote_ccy: Option<&str>,
        preferred_provider: Option<&str>,
    ) -> Result<ResolvedQuote> {
        let _ = (
            symbol,
            exchange_mic,
            instrument_type,
            quote_ccy,
            preferred_provider,
        );
        Ok(ResolvedQuote::default())
    }

    /// Get asset profile from provider.
    ///
    /// Uses the asset's exchange_mic to build provider-specific symbols
    /// (e.g., "VFV.TO" for Yahoo when exchange_mic is XTSE).
    async fn get_asset_profile(&self, asset: &Asset) -> Result<ProviderProfile>;

    /// Fetch historical quotes from provider.
    async fn fetch_quotes_from_provider(
        &self,
        asset_id: &str,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<Vec<Quote>>;

    /// Fetch quotes for an asset ID (canonical format like "SEC:^GSPC:INDEX")
    /// that may not exist in the database. Used for benchmark indices and external symbols.
    async fn fetch_quotes_for_symbol(
        &self,
        asset_id: &str,
        currency: &str,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<Vec<Quote>>;

    /// Fetch cash dividends for a single symbol.
    async fn fetch_dividends(&self, _params: FetchDividendsParams) -> Result<Vec<DividendEvent>> {
        unimplemented!("fetch_dividends is not implemented for this quote service")
    }

    // =========================================================================
    // Sync Operations (via QuoteSyncService)
    // =========================================================================

    /// Perform quote synchronization with the specified mode and optional asset filter.
    ///
    /// # Arguments
    /// * `mode` - The sync mode determining how date ranges are calculated
    /// * `asset_ids` - Optional list of specific assets to sync. If None, syncs all relevant assets.
    ///
    /// # Sync Modes
    /// * `Incremental` - Default mode. Continues from last_quote_date with overlap to heal corrections.
    /// * `RefetchRecent { days }` - Refetches the last N days regardless of existing quotes.
    /// * `BackfillHistory { days }` - Rebuilds full history from activity start (or N days fallback).
    async fn sync(&self, mode: SyncMode, asset_ids: Option<Vec<String>>) -> Result<SyncResult>;

    /// Force resync for specific asset IDs (or all if None) using BackfillHistory mode.
    /// An empty asset ID list is treated as sync nothing.
    async fn resync(&self, asset_ids: Option<Vec<String>>) -> Result<SyncResult>;

    /// Refresh sync state from holdings/activities.
    async fn refresh_sync_state(&self) -> Result<()>;

    /// Get the current sync plan.
    fn get_sync_plan(&self) -> Result<Vec<SymbolSyncPlan>>;

    /// Handle new activity created.
    async fn handle_activity_created(&self, symbol: &str, activity_date: NaiveDate) -> Result<()>;

    /// Handle activity deleted.
    async fn handle_activity_deleted(&self, symbol: &str) -> Result<()>;

    /// Delete sync state for a symbol.
    async fn delete_sync_state(&self, symbol: &str) -> Result<()>;

    /// Get symbols needing sync.
    fn get_symbols_needing_sync(&self) -> Result<Vec<QuoteSyncState>>;

    /// Get sync state for a specific symbol.
    fn get_sync_state(&self, symbol: &str) -> Result<Option<QuoteSyncState>>;

    /// Mark asset profile as enriched.
    async fn mark_profile_enriched(&self, symbol: &str) -> Result<()>;

    /// Get assets that need profile enrichment.
    fn get_assets_needing_profile_enrichment(&self) -> Result<Vec<QuoteSyncState>>;

    /// Get sync states that have errors (error_count > 0).
    fn get_sync_states_with_errors(&self) -> Result<Vec<QuoteSyncState>>;

    /// Reset sync error counts for the given asset IDs, allowing retry.
    async fn reset_sync_errors(&self, asset_ids: &[String]) -> Result<()>;

    /// Reset stale sync routing/error state after a market identity or provider profile change.
    ///
    /// Implementors must clear `error_count`, `last_error`, and `data_source` on
    /// the matching `QuoteSyncState` so the next sync re-routes to the asset's
    /// `preferred_provider`. Note: clearing `data_source` to an empty string is
    /// the contract — `effective_provider` treats `""` as "no override".
    async fn reset_sync_state_for_profile_change(&self, asset_id: &str) -> Result<()>;

    /// Update position status (active/inactive) based on current holdings.
    async fn update_position_status_from_holdings(
        &self,
        current_holdings: &std::collections::HashMap<String, rust_decimal::Decimal>,
    ) -> Result<()>;

    // =========================================================================
    // Provider Settings
    // =========================================================================

    /// Get all provider info.
    async fn get_providers_info(&self) -> Result<Vec<ProviderInfo>>;

    /// Update provider settings.
    async fn update_provider_settings(
        &self,
        provider_id: &str,
        priority: i32,
        enabled: bool,
    ) -> Result<()>;

    // =========================================================================
    // Quote Import
    // =========================================================================

    /// Parse and validate quotes from CSV content.
    ///
    /// This method parses CSV data, validates quote fields, and checks if assets
    /// exist in the database. Returns quotes with validation status:
    /// - Valid: quote can be imported (asset exists, data valid)
    /// - Warning: quote has minor issues but can be imported
    /// - Error: quote cannot be imported (asset not found, invalid data)
    ///
    /// # Arguments
    /// * `content` - Raw CSV file content as bytes
    /// * `has_header_row` - Whether the CSV has a header row
    ///
    /// # Returns
    /// The parsed and validated quotes with symbols resolved to asset IDs
    async fn check_quotes_import(
        &self,
        content: &[u8],
        has_header_row: bool,
    ) -> Result<Vec<QuoteImport>>;

    /// Import quotes from CSV data.
    async fn import_quotes(
        &self,
        quotes: Vec<QuoteImport>,
        overwrite: bool,
    ) -> Result<Vec<QuoteImport>>;
}

/// Unified quote service implementation.
pub struct QuoteService<Q, S, PS, A, R>
where
    Q: QuoteStore,
    S: SyncStateStore,
    PS: ProviderSettingsStore,
    A: AssetRepositoryTrait,
    R: ActivityRepositoryTrait,
{
    /// Quote storage.
    quote_store: Arc<Q>,
    /// Sync state storage.
    sync_state_store: Arc<S>,
    /// Provider settings storage.
    provider_settings_store: Arc<PS>,
    /// Asset repository.
    asset_repo: Arc<A>,
    /// Activity repository.
    activity_repo: Arc<R>,
    /// Market data client for provider operations.
    client: Arc<RwLock<MarketDataClient>>,
    /// Secret store for API keys.
    secret_store: Arc<dyn SecretStore>,
    /// Optional custom provider repository for CUSTOM_SCRAPER provider.
    custom_provider_repo: Option<Arc<dyn crate::custom_provider::CustomProviderRepository>>,
    /// Sync service.
    #[allow(clippy::type_complexity)]
    sync_service: Arc<RwLock<Option<Arc<QuoteSyncService<Q, S, A, R>>>>>,
}

impl<Q, S, PS, A, R> QuoteService<Q, S, PS, A, R>
where
    Q: QuoteStore + 'static,
    S: SyncStateStore + 'static,
    PS: ProviderSettingsStore + 'static,
    A: AssetRepositoryTrait + 'static,
    R: ActivityRepositoryTrait + 'static,
{
    /// Create a new quote service.
    pub async fn new(
        quote_store: Arc<Q>,
        sync_state_store: Arc<S>,
        provider_settings_store: Arc<PS>,
        asset_repo: Arc<A>,
        activity_repo: Arc<R>,
        secret_store: Arc<dyn SecretStore>,
    ) -> Result<Self> {
        Self::new_with_custom_provider(
            quote_store,
            sync_state_store,
            provider_settings_store,
            asset_repo,
            activity_repo,
            secret_store,
            None,
        )
        .await
    }

    /// Create a new quote service with optional custom provider repository.
    pub async fn new_with_custom_provider(
        quote_store: Arc<Q>,
        sync_state_store: Arc<S>,
        provider_settings_store: Arc<PS>,
        asset_repo: Arc<A>,
        activity_repo: Arc<R>,
        secret_store: Arc<dyn SecretStore>,
        custom_provider_repo: Option<Arc<dyn crate::custom_provider::CustomProviderRepository>>,
    ) -> Result<Self> {
        let providers = provider_settings_store.get_all_providers()?;
        let enabled: Vec<ProviderConfig> = providers
            .iter()
            .filter(|p| p.enabled)
            .map(|p| ProviderConfig {
                id: p.id.clone(),
                priority: p.priority,
            })
            .collect();

        // Build extra providers (CustomScraperProvider if repo is available and enabled)
        let custom_scraper_enabled = providers
            .iter()
            .any(|p| p.id == super::constants::DATA_SOURCE_CUSTOM_SCRAPER && p.enabled);
        let extra = if custom_scraper_enabled {
            Self::build_extra_providers(&custom_provider_repo, &secret_store)
        } else {
            Vec::new()
        };

        let client =
            MarketDataClient::new_with_extra(secret_store.clone(), enabled.clone(), extra).await?;
        let client_arc = Arc::new(RwLock::new(client));

        let sync_service = QuoteSyncService::new(
            client_arc.clone(),
            quote_store.clone(),
            sync_state_store.clone(),
            asset_repo.clone(),
            activity_repo.clone(),
        );

        Ok(Self {
            quote_store,
            sync_state_store,
            provider_settings_store,
            asset_repo,
            activity_repo,
            client: client_arc,
            secret_store,
            custom_provider_repo,
            sync_service: Arc::new(RwLock::new(Some(Arc::new(sync_service)))),
        })
    }

    /// Build extra providers from optional custom provider repo.
    fn build_extra_providers(
        custom_provider_repo: &Option<Arc<dyn crate::custom_provider::CustomProviderRepository>>,
        secret_store: &Arc<dyn SecretStore>,
    ) -> Vec<Arc<dyn wealthfolio_market_data::MarketDataProvider>> {
        let mut extra: Vec<Arc<dyn wealthfolio_market_data::MarketDataProvider>> = Vec::new();
        if let Some(repo) = custom_provider_repo {
            extra.push(Arc::new(
                super::custom_scraper_provider::CustomScraperProvider::new(
                    repo.clone(),
                    secret_store.clone(),
                ),
            ));
        }
        extra
    }

    /// Refresh the market data client (e.g., after provider settings change).
    async fn refresh_client(&self) -> Result<()> {
        let providers = self.provider_settings_store.get_all_providers()?;
        let enabled: Vec<ProviderConfig> = providers
            .iter()
            .filter(|p| p.enabled)
            .map(|p| ProviderConfig {
                id: p.id.clone(),
                priority: p.priority,
            })
            .collect();

        let custom_scraper_enabled = providers
            .iter()
            .any(|p| p.id == super::constants::DATA_SOURCE_CUSTOM_SCRAPER && p.enabled);
        let extra = if custom_scraper_enabled {
            Self::build_extra_providers(&self.custom_provider_repo, &self.secret_store)
        } else {
            Vec::new()
        };
        let new_client =
            MarketDataClient::new_with_extra(self.secret_store.clone(), enabled.clone(), extra)
                .await?;
        *self.client.write().await = new_client;

        // Refresh sync service with updated client
        let new_sync = QuoteSyncService::new(
            self.client.clone(),
            self.quote_store.clone(),
            self.sync_state_store.clone(),
            self.asset_repo.clone(),
            self.activity_repo.clone(),
        );
        *self.sync_service.write().await = Some(Arc::new(new_sync));

        Ok(())
    }

    /// Get the sync service.
    async fn get_sync_service(&self) -> Result<Arc<QuoteSyncService<Q, S, A, R>>> {
        let guard = self.sync_service.read().await;
        guard
            .as_ref()
            .cloned()
            .ok_or_else(|| crate::Error::Unexpected("Sync service not initialized".to_string()))
    }

    /// Convert QuoteImport to Quote.
    fn convert_import_to_quote(&self, import: &QuoteImport) -> Result<Quote> {
        let timestamp = QuoteConverter::date_to_timestamp(&import.date)?;
        let id = QuoteConverter::generate_id(&import.symbol, &import.date);

        Ok(Quote {
            id,
            created_at: Utc::now(),
            data_source: DATA_SOURCE_MANUAL.to_string(),
            timestamp,
            asset_id: import.symbol.clone(),
            open: import.open_or_close(),
            high: import.high_or_close(),
            low: import.low_or_close(),
            close: import.close,
            adjclose: import.close,
            volume: import.volume_or_zero(),
            currency: import.currency.clone(),
            notes: None,
        })
    }

    /// Convert an existing Asset to a SymbolSearchResult for search results.
    ///
    /// Marks the result as existing and includes the asset ID.
    fn asset_to_quote_summary(asset: &Asset) -> SymbolSearchResult {
        let exchange_name = asset
            .instrument_exchange_mic
            .as_ref()
            .and_then(|mic| mic_to_exchange_name(mic))
            .map(String::from);

        let quote_type = match asset.instrument_type {
            Some(InstrumentType::Equity) => "EQUITY",
            Some(InstrumentType::Crypto) => "CRYPTOCURRENCY",
            Some(InstrumentType::Metal) => "COMMODITY",
            Some(InstrumentType::Option) => "OPTION",
            Some(InstrumentType::Bond) => "BOND",
            Some(InstrumentType::Fx) => "FOREX",
            None => "OTHER",
        };

        let stored_display = asset
            .display_code
            .clone()
            .or_else(|| asset.instrument_symbol.clone())
            .unwrap_or_default();
        let display = asset_search_display_symbol(asset);

        SymbolSearchResult {
            symbol: display.clone(),
            canonical_symbol: asset.instrument_symbol.clone(),
            canonical_exchange_mic: asset.instrument_exchange_mic.clone(),
            provider_id: asset.preferred_provider(),
            provider_symbol: None,
            short_name: asset.name.clone().unwrap_or_else(|| stored_display.clone()),
            long_name: asset.name.clone().unwrap_or(stored_display),
            exchange: exchange_name.clone().unwrap_or_default(),
            exchange_mic: asset.instrument_exchange_mic.clone(),
            exchange_name,
            quote_type: quote_type.to_string(),
            type_display: quote_type.to_string(),
            currency: Some(asset.quote_ccy.clone()),
            currency_source: None,
            data_source: if asset.quote_mode == QuoteMode::Manual {
                Some(DATA_SOURCE_MANUAL.to_string())
            } else {
                asset.preferred_provider()
            },
            quote_mode: Some(asset.quote_mode.as_db_str().to_string()),
            is_existing: true,
            existing_asset_id: Some(asset.id.clone()),
            index: String::new(),
            score: 100.0, // High score for existing assets
        }
    }

    fn no_quote_reason(asset: Option<&Asset>, state: Option<&QuoteSyncState>) -> NoQuoteReason {
        if let Some(asset) = asset {
            if asset.quote_mode == QuoteMode::Manual {
                return NoQuoteReason {
                    code: "MANUAL_PRICING".to_string(),
                    message: "Quote mode is Manual".to_string(),
                };
            }

            if !asset.is_active {
                return NoQuoteReason {
                    code: "INACTIVE".to_string(),
                    message: "Asset is inactive".to_string(),
                };
            }

            if asset.is_bond() {
                if let Some(spec) = asset.bond_spec() {
                    if let Some(maturity) = spec.maturity_date {
                        if maturity < Utc::now().date_naive() {
                            return NoQuoteReason {
                                code: "MATURED_BOND".to_string(),
                                message: "Bond has matured".to_string(),
                            };
                        }
                    }
                }
            }

            if asset.is_option() {
                if let Some(spec) = asset.option_spec() {
                    if spec.expiration < Utc::now().date_naive() {
                        return NoQuoteReason {
                            code: "EXPIRED_OPTION".to_string(),
                            message: "Option has expired".to_string(),
                        };
                    }
                }
            }
        }

        if let Some(state) = state {
            if state.error_count >= MAX_SYNC_ERRORS {
                return NoQuoteReason {
                    code: "TOO_MANY_ERRORS".to_string(),
                    message: "Sync paused after repeated errors".to_string(),
                };
            }

            if let Some(last_error) = state
                .last_error
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                return NoQuoteReason {
                    code: "LAST_ERROR".to_string(),
                    message: format!("Last sync error: {}", last_error),
                };
            }

            if state.last_synced_at.is_none() {
                return NoQuoteReason {
                    code: "PENDING_SYNC".to_string(),
                    message: "No provider quote has been synced yet".to_string(),
                };
            }
        }

        NoQuoteReason {
            code: "NO_DATA".to_string(),
            message: "No data available from provider yet".to_string(),
        }
    }
}

#[async_trait]
impl<Q, S, PS, A, R> QuoteServiceTrait for QuoteService<Q, S, PS, A, R>
where
    Q: QuoteStore + 'static,
    S: SyncStateStore + 'static,
    PS: ProviderSettingsStore + 'static,
    A: AssetRepositoryTrait + 'static,
    R: ActivityRepositoryTrait + 'static,
{
    // =========================================================================
    // Quote CRUD
    // =========================================================================

    fn get_latest_quote(&self, symbol: &str) -> Result<Quote> {
        let mut quote = self.quote_store.get_latest_quote(symbol)?;
        if let Ok(asset) = self.asset_repo.get_by_id(symbol) {
            reconcile_quote_currency(&mut quote, &asset);
        }
        Ok(quote)
    }

    fn get_latest_quotes(&self, symbols: &[String]) -> Result<HashMap<String, Quote>> {
        let mut quotes = self.quote_store.get_latest_quotes(symbols)?;
        let assets = self.asset_repo.list_by_asset_ids(symbols)?;
        let assets_by_id: HashMap<String, Asset> = assets
            .into_iter()
            .map(|asset| (asset.id.clone(), asset))
            .collect();

        for (asset_id, quote) in quotes.iter_mut() {
            if let Some(asset) = assets_by_id.get(asset_id) {
                reconcile_quote_currency(quote, asset);
            }
        }

        Ok(quotes)
    }

    fn get_latest_quotes_as_of(
        &self,
        symbols: &[String],
        as_of: chrono::NaiveDate,
    ) -> Result<HashMap<String, Quote>> {
        let mut quotes = self.quote_store.get_latest_quotes_as_of(symbols, as_of)?;
        let assets = self.asset_repo.list_by_asset_ids(symbols)?;
        let assets_by_id: HashMap<String, Asset> = assets
            .into_iter()
            .map(|asset| (asset.id.clone(), asset))
            .collect();

        for (asset_id, quote) in quotes.iter_mut() {
            if let Some(asset) = assets_by_id.get(asset_id) {
                reconcile_quote_currency(quote, asset);
            }
        }

        Ok(quotes)
    }

    fn get_latest_quotes_snapshot(
        &self,
        asset_ids: &[String],
    ) -> Result<HashMap<String, LatestQuoteSnapshot>> {
        let mut seen_asset_ids = HashSet::new();
        let unique_asset_ids: Vec<String> = asset_ids
            .iter()
            .filter(|asset_id| seen_asset_ids.insert(asset_id.as_str()))
            .cloned()
            .collect();

        let mut quotes = self.quote_store.get_latest_quotes(&unique_asset_ids)?;
        let assets = self.asset_repo.list_by_asset_ids(&unique_asset_ids)?;
        let assets_by_id: HashMap<String, Asset> = assets
            .into_iter()
            .map(|asset| (asset.id.clone(), asset))
            .collect();
        let sync_states = self.sync_state_store.get_by_asset_ids(&unique_asset_ids)?;
        let now = Utc::now();

        for (asset_id, quote) in quotes.iter_mut() {
            if let Some(asset) = assets_by_id.get(asset_id) {
                reconcile_quote_currency(quote, asset);
            }
        }

        let snapshots = unique_asset_ids
            .iter()
            .map(|asset_id| {
                let asset = assets_by_id.get(asset_id);
                let effective_today = time_utils::market_effective_date(
                    now,
                    asset.and_then(|a| a.instrument_exchange_mic.as_deref()),
                );
                let snapshot = if let Some(quote) = quotes.get(asset_id).cloned() {
                    let quote_day = quote.timestamp.date_naive();
                    let is_inactive = asset.map(|a| !a.is_active).unwrap_or(false);

                    LatestQuoteSnapshot {
                        quote: Some(quote),
                        is_stale: is_inactive || quote_day < effective_today,
                        effective_market_date: effective_today.to_string(),
                        quote_date: Some(quote_day.to_string()),
                        no_quote_reason: None,
                    }
                } else {
                    // No quote available — flag as stale so any UI surface that
                    // already filters on `is_stale` keeps treating the row as
                    // outdated; the contextual message lives in `no_quote_reason`.
                    LatestQuoteSnapshot {
                        quote: None,
                        is_stale: true,
                        effective_market_date: effective_today.to_string(),
                        quote_date: None,
                        no_quote_reason: Some(Self::no_quote_reason(
                            asset,
                            sync_states.get(asset_id),
                        )),
                    }
                };

                (asset_id.clone(), snapshot)
            })
            .collect();

        Ok(snapshots)
    }

    fn get_latest_quotes_pair(
        &self,
        symbols: &[String],
    ) -> Result<HashMap<String, LatestQuotePair>> {
        let mut pairs = self.quote_store.get_latest_quotes_pair(symbols)?;
        let assets = self.asset_repo.list_by_asset_ids(symbols)?;
        let assets_by_id: HashMap<String, Asset> = assets
            .into_iter()
            .map(|asset| (asset.id.clone(), asset))
            .collect();

        for (asset_id, pair) in pairs.iter_mut() {
            if let Some(asset) = assets_by_id.get(asset_id) {
                reconcile_quote_currency(&mut pair.latest, asset);
                if let Some(previous) = pair.previous.as_mut() {
                    reconcile_quote_currency(previous, asset);
                }
            }
        }

        Ok(pairs)
    }

    fn get_historical_quotes(&self, symbol: &str) -> Result<Vec<Quote>> {
        let mut quotes = self.quote_store.get_historical_quotes(symbol)?;
        if let Ok(asset) = self.asset_repo.get_by_id(symbol) {
            for quote in quotes.iter_mut() {
                reconcile_quote_currency(quote, &asset);
            }
        }
        Ok(quotes)
    }

    fn get_all_historical_quotes(&self) -> Result<HashMap<String, Vec<(NaiveDate, Quote)>>> {
        let mut quotes = self.quote_store.get_all_historical_quotes()?;
        let asset_ids: Vec<String> = quotes
            .iter()
            .map(|quote| quote.asset_id.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let assets = self.asset_repo.list_by_asset_ids(&asset_ids)?;
        let assets_by_id: HashMap<String, Asset> = assets
            .into_iter()
            .map(|asset| (asset.id.clone(), asset))
            .collect();

        for quote in quotes.iter_mut() {
            if let Some(asset) = assets_by_id.get(&quote.asset_id) {
                reconcile_quote_currency(quote, asset);
            }
        }

        let mut grouped: HashMap<String, Vec<(NaiveDate, Quote)>> = HashMap::new();
        for quote in quotes {
            let date = quote.timestamp.date_naive();
            grouped
                .entry(quote.asset_id.clone())
                .or_default()
                .push((date, quote));
        }

        // Sort by date
        for quotes in grouped.values_mut() {
            quotes.sort_by_key(|(date, _)| *date);
        }

        Ok(grouped)
    }

    fn get_quotes_in_range(
        &self,
        symbols: &HashSet<String>,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<Vec<Quote>> {
        let ids: Vec<String> = symbols.iter().cloned().collect();
        let assets = self.asset_repo.list_by_asset_ids(&ids)?;
        let assets_by_id: HashMap<String, Asset> = assets
            .into_iter()
            .map(|asset| (asset.id.clone(), asset))
            .collect();

        let mut all_quotes = Vec::new();
        for symbol in symbols {
            let mut quotes = self.quote_store.get_quotes_in_range(symbol, start, end)?;
            if let Some(asset) = assets_by_id.get(symbol) {
                for quote in quotes.iter_mut() {
                    reconcile_quote_currency(quote, asset);
                }
            }
            all_quotes.extend(quotes);
        }
        Ok(all_quotes)
    }

    fn get_quotes_in_range_filled(
        &self,
        symbols: &HashSet<String>,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<Vec<Quote>> {
        if symbols.is_empty() {
            return Ok(Vec::new());
        }

        // Lookback period to find initial quotes before start_date
        const QUOTE_LOOKBACK_DAYS: i64 = 30;

        // Fetch quotes with lookback period
        let lookback_start = start - Duration::days(QUOTE_LOOKBACK_DAYS);
        let ids: Vec<String> = symbols.iter().cloned().collect();
        let assets = self.asset_repo.list_by_asset_ids(&ids)?;
        let assets_by_id: HashMap<String, Asset> = assets
            .into_iter()
            .map(|asset| (asset.id.clone(), asset))
            .collect();

        let mut all_quotes = Vec::new();
        for symbol in symbols {
            let mut quotes = self
                .quote_store
                .get_quotes_in_range(symbol, lookback_start, end)?;
            if let Some(asset) = assets_by_id.get(symbol) {
                for quote in quotes.iter_mut() {
                    reconcile_quote_currency(quote, asset);
                }
            }
            all_quotes.extend(quotes);
        }

        append_historical_seed_quotes(
            self.quote_store.as_ref(),
            symbols,
            start,
            &assets_by_id,
            &mut all_quotes,
        )?;

        // Fill missing quotes
        Ok(fill_missing_quotes(&all_quotes, symbols, start, end))
    }

    async fn get_daily_quotes(
        &self,
        asset_ids: &HashSet<String>,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<HashMap<NaiveDate, HashMap<String, Quote>>> {
        let quotes = self.get_quotes_in_range(asset_ids, start, end)?;

        let mut daily: HashMap<NaiveDate, HashMap<String, Quote>> = HashMap::new();
        for quote in quotes {
            let date = quote.timestamp.date_naive();
            daily
                .entry(date)
                .or_default()
                .insert(quote.asset_id.clone(), quote);
        }

        Ok(daily)
    }

    async fn add_quote(&self, quote: &Quote) -> Result<Quote> {
        self.quote_store.save_quote(quote).await
    }

    async fn update_quote(&self, quote: Quote) -> Result<Quote> {
        let mut quote = quote;

        // When source is MANUAL, regenerate the ID so provider sync can't overwrite it.
        // If the old ID was provider-based (e.g. *_YAHOO), delete it first.
        if quote.data_source == DATA_SOURCE_MANUAL {
            let day = Day::new(quote.timestamp.date_naive());
            let asset_id = AssetId::new(&quote.asset_id);
            let manual_id = quote_id(&asset_id, day, &QuoteSource::Manual);

            if quote.id != manual_id {
                let _ = self.quote_store.delete_quote(&quote.id).await;
                quote.id = manual_id;
            }
        }

        self.quote_store.save_quote(&quote).await
    }

    async fn delete_quote(&self, quote_id: &str) -> Result<()> {
        self.quote_store.delete_quote(quote_id).await
    }

    async fn bulk_upsert_quotes(&self, quotes: Vec<Quote>) -> Result<usize> {
        self.quote_store.upsert_quotes(&quotes).await
    }

    // =========================================================================
    // Provider Operations
    // =========================================================================

    async fn search_symbol(&self, query: &str) -> Result<Vec<SymbolSearchResult>> {
        self.search_symbol_with_currency(query, None).await
    }

    async fn search_symbol_with_currency(
        &self,
        query: &str,
        account_currency: Option<&str>,
    ) -> Result<Vec<SymbolSearchResult>> {
        // 1. Search existing assets in user's database
        let mut existing_assets = self.asset_repo.search_by_symbol(query).unwrap_or_default();
        if let Some((canonical_symbol, exchange_mic)) = local_search_identity(query) {
            let query_trimmed = query.trim();
            if !canonical_symbol.eq_ignore_ascii_case(query_trimmed) || exchange_mic.is_some() {
                let mut seen_asset_ids: HashSet<String> = existing_assets
                    .iter()
                    .map(|asset| asset.id.clone())
                    .collect();
                for asset in self
                    .asset_repo
                    .search_by_symbol(&canonical_symbol)
                    .unwrap_or_default()
                {
                    if seen_asset_ids.contains(&asset.id)
                        || !asset_matches_local_search_identity(
                            &asset,
                            &canonical_symbol,
                            exchange_mic,
                        )
                    {
                        continue;
                    }
                    seen_asset_ids.insert(asset.id.clone());
                    existing_assets.push(asset);
                }
            }
        }
        let query_trimmed = query.trim();
        if !query_trimmed.is_empty() {
            let mut seen_asset_ids: HashSet<String> = existing_assets
                .iter()
                .map(|asset| asset.id.clone())
                .collect();
            for asset in self.asset_repo.list().unwrap_or_default() {
                if seen_asset_ids.contains(&asset.id)
                    || !asset_provider_alias_symbols(&asset)
                        .iter()
                        .any(|alias| alias.eq_ignore_ascii_case(query_trimmed))
                {
                    continue;
                }
                seen_asset_ids.insert(asset.id.clone());
                existing_assets.push(asset);
            }
        }

        // 2. Search provider for external results
        let provider_results = self
            .client
            .read()
            .await
            .search(query)
            .await
            .unwrap_or_default();

        // 3. Convert existing assets to SymbolSearchResult with is_existing flag
        let mut existing_summaries: Vec<SymbolSearchResult> = existing_assets
            .iter()
            .filter(|a| a.kind != AssetKind::Fx)
            .map(|asset| Self::asset_to_quote_summary(asset))
            .collect();
        let mut existing_asset_ids: HashSet<String> = existing_summaries
            .iter()
            .filter_map(|s| s.existing_asset_id.clone())
            .collect();

        let mut unmatched_provider_results = Vec::with_capacity(provider_results.len());
        for result in provider_results {
            let existing_asset = instrument_key_from_search_result(&result)
                .and_then(|key| self.asset_repo.find_by_instrument_key(&key).ok().flatten());

            if let Some(asset) = existing_asset.filter(|a| a.kind != AssetKind::Fx) {
                if existing_asset_ids.insert(asset.id.clone()) {
                    existing_summaries.push(Self::asset_to_quote_summary(&asset));
                }
                continue;
            }

            unmatched_provider_results.push(result);
        }

        // 4. Build a set of existing (symbol, exchange_mic) pairs for deduplication
        let existing_keys: HashSet<(String, Option<String>)> = existing_summaries
            .iter()
            .map(|s| (s.symbol.clone(), s.exchange_mic.clone()))
            .collect();

        // 5. Filter provider results to exclude duplicates
        let new_provider_results: Vec<SymbolSearchResult> = unmatched_provider_results
            .into_iter()
            .filter(|r| {
                // Check if this symbol+exchange combo already exists
                !existing_keys.contains(&(r.symbol.clone(), r.exchange_mic.clone()))
            })
            .collect();

        // 6. Merge existing assets first, then provider results
        let mut merged = Vec::with_capacity(existing_summaries.len() + new_provider_results.len());
        merged.extend(existing_summaries);
        merged.extend(new_provider_results);

        // 7. Sort results: existing first, then by exchange relevance (if currency), then by score
        let preferred_exchanges = account_currency
            .map(exchanges_for_currency)
            .unwrap_or_default();

        merged.sort_by(|a, b| {
            // Existing assets always come first
            match (a.is_existing, b.is_existing) {
                (true, false) => return std::cmp::Ordering::Less,
                (false, true) => return std::cmp::Ordering::Greater,
                _ => {}
            }

            // Then sort by exchange relevance (if currency provided)
            if !preferred_exchanges.is_empty() {
                let a_rank = a
                    .exchange_mic
                    .as_ref()
                    .and_then(|mic| preferred_exchanges.iter().position(|e| *e == mic.as_str()))
                    .unwrap_or(usize::MAX);
                let b_rank = b
                    .exchange_mic
                    .as_ref()
                    .and_then(|mic| preferred_exchanges.iter().position(|e| *e == mic.as_str()))
                    .unwrap_or(usize::MAX);

                match a_rank.cmp(&b_rank) {
                    std::cmp::Ordering::Equal => {}
                    other => return other,
                }
            }

            // Finally sort by provider score (descending, higher score first)
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        Ok(merged)
    }

    async fn resolve_symbol_quote(
        &self,
        symbol: &str,
        exchange_mic: Option<&str>,
        instrument_type: Option<&InstrumentType>,
        quote_ccy: Option<&str>,
        preferred_provider: Option<&str>,
    ) -> Result<ResolvedQuote> {
        let trimmed_symbol = symbol.trim();
        if trimmed_symbol.is_empty() {
            return Ok(ResolvedQuote::default());
        }

        // Strip Yahoo exchange suffix to avoid double-suffixing (e.g. "AZN.L" + MIC "XLON" → "AZN.L.L").
        // The resolver chain will re-append the correct suffix from the MIC.
        let clean_symbol = if let Some(mic) = exchange_mic {
            if let Some(dot_pos) = trimmed_symbol.rfind('.') {
                let suffix = &trimmed_symbol[dot_pos + 1..];
                if mic_to_yahoo_suffix(mic).is_some_and(|s| s.eq_ignore_ascii_case(suffix)) {
                    &trimmed_symbol[..dot_pos]
                } else {
                    trimmed_symbol
                }
            } else {
                trimmed_symbol
            }
        } else {
            trimmed_symbol
        };

        let requested_quote_ccy = normalize_quote_ccy_code(quote_ccy);
        let provider_config = provider_config_for_symbol_resolution(preferred_provider);

        for attempt_symbol in symbol_resolution_candidates(clean_symbol) {
            // For bonds, populate metadata with TreasuryDirect details so
            // US_TREASURY_CALC can price them during resolve.
            let bond_metadata = if instrument_type == Some(&InstrumentType::Bond) {
                let upper = attempt_symbol.to_uppercase();
                // Convert CUSIP to ISIN if needed
                let isin = if crate::utils::cusip::looks_like_cusip(&upper) {
                    crate::utils::cusip::cusip_to_isin(&upper, "US")
                } else {
                    upper
                };
                if isin.starts_with("US912") {
                    let http = reqwest::Client::new();
                    wealthfolio_market_data::provider::us_treasury_calc::UsTreasuryCalcProvider::fetch_bond_details(&http, &isin).await
                        .map(|details| {
                            let spec = crate::assets::BondSpec {
                                isin: Some(isin.clone()),
                                coupon_rate: Some(details.coupon_rate),
                                maturity_date: Some(details.maturity_date),
                                face_value: Some(details.face_value),
                                coupon_frequency: Some(details.coupon_frequency),
                            };
                            (isin, serde_json::json!({ "bond": spec }))
                        })
                } else {
                    None
                }
            } else {
                None
            };

            let (resolved_symbol, metadata) = match &bond_metadata {
                Some((isin, meta)) => (isin.clone(), Some(meta.clone())),
                None => (attempt_symbol.clone(), None),
            };

            let pair_quote_ccy = if matches!(instrument_type, Some(InstrumentType::Crypto)) {
                parse_crypto_pair_symbol(&resolved_symbol).map(|(_, quote)| quote)
            } else {
                None
            };
            let quote_ccy_for_identity =
                pair_quote_ccy.as_deref().or(requested_quote_ccy.as_deref());
            let inferred_instrument_type =
                instrument_type.cloned().unwrap_or(InstrumentType::Equity);
            let canonical_identity = canonicalize_market_identity(
                Some(inferred_instrument_type.clone()),
                Some(resolved_symbol.as_str()),
                exchange_mic,
                quote_ccy_for_identity,
            );
            if matches!(
                inferred_instrument_type,
                InstrumentType::Crypto | InstrumentType::Fx
            ) && canonical_identity.quote_ccy.is_none()
            {
                debug!(
                    "resolve_symbol_quote: missing quote currency for {} symbol='{}'",
                    inferred_instrument_type.as_db_str(),
                    resolved_symbol
                );
                continue;
            }

            let temp_asset = Asset {
                id: format!("_QUOTE_RESOLVE_{}", attempt_symbol),
                kind: AssetKind::Investment,
                quote_mode: QuoteMode::Market,
                quote_ccy: canonical_identity.quote_ccy.unwrap_or_default(),
                instrument_type: Some(inferred_instrument_type),
                instrument_symbol: canonical_identity
                    .instrument_symbol
                    .or_else(|| Some(resolved_symbol.clone())),
                display_code: canonical_identity
                    .display_code
                    .or_else(|| Some(attempt_symbol.clone())),
                instrument_exchange_mic: canonical_identity.instrument_exchange_mic,
                provider_config: provider_config.clone(),
                metadata,
                ..Default::default()
            };

            match self
                .client
                .read()
                .await
                .fetch_latest_quote(&temp_asset)
                .await
            {
                Ok(quote) => {
                    let currency = {
                        let c = quote.currency.trim();
                        if c.is_empty() {
                            None
                        } else {
                            Some(c.to_string())
                        }
                    };
                    let price = if quote.close.is_zero() {
                        None
                    } else {
                        Some(quote.close)
                    };
                    let resolved_provider_id = quote.data_source.clone();
                    if !resolved_provider_matches_requested(
                        &resolved_provider_id,
                        preferred_provider,
                    ) {
                        debug!(
                            "resolve_symbol_quote: requested provider {:?} but resolved via {} for symbol='{}'",
                            preferred_provider, resolved_provider_id, attempt_symbol
                        );
                        continue;
                    }
                    return Ok(ResolvedQuote {
                        currency,
                        price,
                        resolved_provider_id: Some(resolved_provider_id),
                    });
                }
                Err(err) => {
                    debug!(
                        "resolve_symbol_quote: provider lookup failed for symbol='{}' mic={:?}: {}",
                        attempt_symbol, exchange_mic, err
                    );
                }
            }
        }

        Ok(ResolvedQuote::default())
    }

    async fn get_asset_profile(&self, asset: &Asset) -> Result<ProviderProfile> {
        self.client.read().await.get_profile(asset).await
    }

    async fn fetch_quotes_from_provider(
        &self,
        asset_id: &str,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<Vec<Quote>> {
        let asset = self.asset_repo.get_by_id(asset_id)?;
        let start_dt = Utc.from_utc_datetime(&start.and_hms_opt(0, 0, 0).unwrap());
        let end_dt = Utc.from_utc_datetime(&end.and_hms_opt(23, 59, 59).unwrap());

        self.client
            .read()
            .await
            .fetch_historical_quotes(&asset, start_dt, end_dt)
            .await
    }

    /// Fetch quotes for an asset ID (canonical format like "SEC:^GSPC:INDEX")
    /// that may not exist in the user's database.
    async fn fetch_quotes_for_symbol(
        &self,
        asset_id: &str,
        currency: &str,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<Vec<Quote>> {
        // First try to find an existing asset by ID
        if let Ok(asset) = self.asset_repo.get_by_id(asset_id) {
            let start_dt = Utc.from_utc_datetime(&start.and_hms_opt(0, 0, 0).unwrap());
            let end_dt = Utc.from_utc_datetime(&end.and_hms_opt(23, 59, 59).unwrap());
            return self
                .client
                .read()
                .await
                .fetch_historical_quotes(&asset, start_dt, end_dt)
                .await;
        }

        // Asset not found by ID — create a minimal temporary Asset for fetching
        let temp_asset = Asset {
            id: asset_id.to_string(),
            instrument_symbol: Some(asset_id.to_string()),
            display_code: Some(asset_id.to_string()),
            kind: AssetKind::Investment,
            instrument_type: Some(InstrumentType::Equity),
            quote_ccy: currency.to_string(),
            quote_mode: QuoteMode::Market,
            ..Default::default()
        };

        let start_dt = Utc.from_utc_datetime(&start.and_hms_opt(0, 0, 0).unwrap());
        let end_dt = Utc.from_utc_datetime(&end.and_hms_opt(23, 59, 59).unwrap());

        self.client
            .read()
            .await
            .fetch_historical_quotes(&temp_asset, start_dt, end_dt)
            .await
    }

    async fn fetch_dividends(&self, params: FetchDividendsParams) -> Result<Vec<DividendEvent>> {
        let FetchDividendsParams {
            symbol,
            exchange_mic,
            instrument_type,
            quote_ccy,
            preferred_provider,
            start,
            end,
        } = params;

        let end_date = end.unwrap_or_else(|| Utc::now().date_naive());
        let start_date = start.unwrap_or_else(|| end_date - Duration::days(365 * 5));
        let start_dt = Utc.from_utc_datetime(&start_date.and_hms_opt(0, 0, 0).unwrap());
        let end_dt = Utc.from_utc_datetime(&end_date.and_hms_opt(23, 59, 59).unwrap());

        let provider_config = preferred_provider
            .map(|provider| serde_json::json!({ "preferred_provider": provider }));

        let temp_asset = Asset {
            id: symbol.clone(),
            instrument_symbol: Some(symbol.clone()),
            display_code: Some(symbol),
            kind: AssetKind::Investment,
            instrument_type: Some(instrument_type.unwrap_or(InstrumentType::Equity)),
            instrument_exchange_mic: exchange_mic.clone(),
            quote_ccy: quote_ccy
                .or_else(|| {
                    exchange_mic
                        .as_deref()
                        .and_then(mic_to_currency)
                        .map(str::to_string)
                })
                .unwrap_or_else(|| "USD".to_string()),
            quote_mode: QuoteMode::Market,
            provider_config,
            ..Default::default()
        };

        self.client
            .read()
            .await
            .fetch_dividends(&temp_asset, start_dt, end_dt)
            .await
    }

    // =========================================================================
    // Sync Operations
    // =========================================================================

    async fn sync(&self, mode: SyncMode, asset_ids: Option<Vec<String>>) -> Result<SyncResult> {
        let sync_service = self.get_sync_service().await?;
        sync_service.sync(mode, asset_ids).await
    }

    async fn resync(&self, asset_ids: Option<Vec<String>>) -> Result<SyncResult> {
        let sync_service = self.get_sync_service().await?;
        sync_service.resync(asset_ids).await
    }

    async fn refresh_sync_state(&self) -> Result<()> {
        let sync_service = self.get_sync_service().await?;
        sync_service.refresh_sync_state().await
    }

    fn get_sync_plan(&self) -> Result<Vec<SymbolSyncPlan>> {
        // Blocking read since this is sync
        let rt = tokio::runtime::Handle::current();
        rt.block_on(async {
            let sync_service = self.get_sync_service().await?;
            sync_service.get_sync_plan()
        })
    }

    async fn handle_activity_created(&self, symbol: &str, activity_date: NaiveDate) -> Result<()> {
        let sync_service = self.get_sync_service().await?;
        let asset_id = AssetId::new(symbol);
        let day = Day::new(activity_date);
        sync_service.handle_activity_created(&asset_id, day).await
    }

    async fn handle_activity_deleted(&self, symbol: &str) -> Result<()> {
        let sync_service = self.get_sync_service().await?;
        let asset_id = AssetId::new(symbol);
        sync_service.handle_activity_deleted(&asset_id).await
    }

    async fn delete_sync_state(&self, symbol: &str) -> Result<()> {
        self.sync_state_store.delete(symbol).await
    }

    fn get_symbols_needing_sync(&self) -> Result<Vec<QuoteSyncState>> {
        self.sync_state_store
            .get_assets_needing_sync(super::constants::CLOSED_POSITION_GRACE_PERIOD_DAYS)
    }

    fn get_sync_state(&self, asset_id: &str) -> Result<Option<QuoteSyncState>> {
        self.sync_state_store.get_by_asset_id(asset_id)
    }

    async fn mark_profile_enriched(&self, symbol: &str) -> Result<()> {
        self.sync_state_store.mark_profile_enriched(symbol).await
    }

    fn get_assets_needing_profile_enrichment(&self) -> Result<Vec<QuoteSyncState>> {
        self.sync_state_store
            .get_assets_needing_profile_enrichment()
    }

    async fn update_position_status_from_holdings(
        &self,
        current_holdings: &std::collections::HashMap<String, rust_decimal::Decimal>,
    ) -> Result<()> {
        use rust_decimal::Decimal;

        let today = Utc::now().date_naive();
        let open_asset_ids: Vec<String> = current_holdings
            .iter()
            .filter_map(|(asset_id, quantity)| {
                if has_open_position_quantity(quantity) {
                    Some(asset_id.clone())
                } else {
                    None
                }
            })
            .collect();

        if !open_asset_ids.is_empty() {
            let open_assets = self.asset_repo.list_by_asset_ids(&open_asset_ids)?;
            let open_sync_states = self.sync_state_store.get_by_asset_ids(&open_asset_ids)?;
            let mut open_states_to_mark_active = Vec::new();
            let mut new_open_states = Vec::new();
            let mut assets_to_reactivate = Vec::new();

            for asset in open_assets {
                if asset.kind == AssetKind::Fx {
                    continue;
                }

                if !asset.is_active {
                    // Catalog active state follows actual holdings: a user-hidden asset
                    // must become selectable again while it is held. Closing the position
                    // only closes quote sync state; it does not auto-hide the asset.
                    debug!(
                        "Queueing asset {} for reactivation from current holdings before quote sync",
                        asset.id
                    );
                    assets_to_reactivate.push(asset.id.clone());
                }

                if asset.quote_mode != QuoteMode::Market {
                    continue;
                }

                match open_sync_states.get(&asset.id).cloned() {
                    Some(state) if !state.is_active || state.position_closed_date.is_some() => {
                        debug!("Marking sync state active for open position {}", asset.id);
                        open_states_to_mark_active.push(asset.id.clone());
                    }
                    Some(_) => {}
                    None => {
                        debug!("Creating sync state for open position {}", asset.id);
                        let mut state = QuoteSyncState::new(asset.id.clone(), String::new());
                        state.sync_priority = SyncCategory::Active.default_priority();
                        new_open_states.push(state);
                    }
                }
            }

            if !assets_to_reactivate.is_empty() {
                self.asset_repo
                    .reactivate_batch(&assets_to_reactivate)
                    .await?;
            }

            if !open_states_to_mark_active.is_empty() {
                self.sync_state_store
                    .mark_active_batch(&open_states_to_mark_active)
                    .await?;
            }

            if !new_open_states.is_empty() {
                self.sync_state_store.upsert_batch(&new_open_states).await?;
            }
        }

        // Get all sync states to determine previous active/inactive status
        let all_sync_states = self.sync_state_store.get_all()?;
        let sync_state_asset_ids: Vec<String> = all_sync_states
            .iter()
            .map(|state| state.asset_id.clone())
            .collect();
        let assets_by_id: HashMap<String, Asset> = self
            .asset_repo
            .list_by_asset_ids(&sync_state_asset_ids)?
            .into_iter()
            .map(|asset| (asset.id.clone(), asset))
            .collect();

        let mut marked_active = 0;
        let mut marked_inactive = 0;
        let mut lifecycle_states_to_mark_active = Vec::new();
        let mut lifecycle_states_to_mark_inactive = Vec::new();

        for sync_state in all_sync_states {
            let asset_id = &sync_state.asset_id;

            // Skip FX assets - they don't have "positions" in the holdings sense.
            // FX rates are always needed for currency conversion as long as there are
            // foreign-currency activities or holdings. Their lifecycle is managed separately.
            let Some(asset) = assets_by_id.get(asset_id) else {
                continue;
            };
            if asset.kind == AssetKind::Fx {
                continue;
            }

            let current_qty = current_holdings
                .get(asset_id)
                .copied()
                .unwrap_or(Decimal::ZERO);
            let has_open_position = has_open_position_quantity(&current_qty);

            if has_open_position {
                // Any non-zero held quantity means the catalog asset must remain usable.
                if !sync_state.is_active {
                    // Was inactive, now has a position - mark as active (re-opened)
                    debug!(
                        "Marking asset {} as active (re-opened position, qty={})",
                        asset_id, current_qty
                    );
                    lifecycle_states_to_mark_active.push(asset_id.clone());
                    marked_active += 1;
                }
                // If already active, no change needed
            } else {
                // Asset has no open position (quantity = 0 or not in holdings)
                if sync_state.is_active {
                    // Was active, now closed - mark as inactive with today's date
                    debug!("Marking asset {} as inactive (position closed)", asset_id);
                    lifecycle_states_to_mark_inactive.push(asset_id.clone());
                    marked_inactive += 1;
                }
                // If already inactive, no change needed (preserve existing closed date)
            }
        }

        if !lifecycle_states_to_mark_active.is_empty() {
            self.sync_state_store
                .mark_active_batch(&lifecycle_states_to_mark_active)
                .await?;
        }

        if !lifecycle_states_to_mark_inactive.is_empty() {
            self.sync_state_store
                .mark_inactive_batch(&lifecycle_states_to_mark_inactive, today)
                .await?;
        }

        if marked_active > 0 || marked_inactive > 0 {
            info!(
                "Position status update: {} marked active, {} marked inactive",
                marked_active, marked_inactive
            );
        }

        Ok(())
    }

    fn get_sync_states_with_errors(&self) -> Result<Vec<QuoteSyncState>> {
        self.sync_state_store.get_with_errors()
    }

    async fn reset_sync_errors(&self, asset_ids: &[String]) -> Result<()> {
        for asset_id in asset_ids {
            self.sync_state_store.update_after_sync(asset_id).await?;
        }
        Ok(())
    }

    async fn reset_sync_state_for_profile_change(&self, asset_id: &str) -> Result<()> {
        if let Some(mut state) = self.sync_state_store.get_by_asset_id(asset_id)? {
            state.error_count = 0;
            state.last_error = None;
            // Empty string (not absent) is the contract: `effective_provider`
            // filters empty `data_source` and falls back to `preferred_provider`.
            state.data_source.clear();
            state.updated_at = Utc::now();
            self.sync_state_store.upsert(&state).await?;
        }
        Ok(())
    }

    // =========================================================================
    // Provider Settings
    // =========================================================================

    async fn get_providers_info(&self) -> Result<Vec<ProviderInfo>> {
        use super::constants::*;

        let settings = self.provider_settings_store.get_all_providers()?;

        // Get aggregated sync stats from quote_sync_state table
        let sync_stats = self.sync_state_store.get_provider_sync_stats()?;
        let stats_map: HashMap<String, super::sync_state::ProviderSyncStats> = sync_stats
            .into_iter()
            .map(|s| (s.provider_id.clone(), s))
            .collect();
        let sync_states_with_errors = self.get_sync_states_with_errors()?;

        #[derive(Default)]
        struct ProviderErrorStats {
            error_count: i64,
            last_sync_error: Option<String>,
            last_error_at_millis: Option<i64>,
            unique_errors: HashSet<String>,
        }

        let mut error_stats_map: HashMap<String, ProviderErrorStats> = HashMap::new();
        for state in sync_states_with_errors {
            let Some(last_error) = state.last_error else {
                continue;
            };

            let provider_id = extract_provider_id_from_sync_error(&last_error)
                .map(|id| id.to_string())
                .unwrap_or_else(|| state.data_source.clone());
            if provider_id.is_empty() {
                continue;
            }

            let entry = error_stats_map.entry(provider_id).or_default();
            entry.error_count += 1;
            entry.unique_errors.insert(last_error.clone());

            let updated_at_millis = state.updated_at.timestamp_millis();
            if entry
                .last_error_at_millis
                .map(|current| updated_at_millis > current)
                .unwrap_or(true)
            {
                entry.last_error_at_millis = Some(updated_at_millis);
                entry.last_sync_error = Some(last_error);
            }
        }

        let mut infos = Vec::new();
        for setting in settings {
            // Check if provider requires an API key
            let requires_key = matches!(
                setting.id.as_str(),
                DATA_SOURCE_ALPHA_VANTAGE
                    | DATA_SOURCE_MARKET_DATA_APP
                    | DATA_SOURCE_METAL_PRICE_API
                    | DATA_SOURCE_FINNHUB
            );
            // Check if API key is set (skip for disabled providers to avoid keychain prompts)
            let has_key = if requires_key && setting.enabled {
                self.secret_store
                    .get_secret(&setting.id)
                    .ok()
                    .flatten()
                    .map(|k| !k.is_empty())
                    .unwrap_or(false)
            } else {
                !requires_key
            };

            // Get sync stats for this provider
            let stats = stats_map.get(&setting.id);
            let asset_count = stats.map(|s| s.asset_count).unwrap_or(0);
            let error_stats = error_stats_map.get(&setting.id);
            let error_count = error_stats.map(|s| s.error_count).unwrap_or(0);
            let last_synced_at = stats
                .and_then(|s| s.last_synced_at)
                .map(|dt| dt.to_rfc3339());
            let last_sync_error = error_stats.and_then(|s| s.last_sync_error.clone());
            let mut unique_errors: Vec<String> = error_stats
                .map(|s| s.unique_errors.iter().cloned().collect())
                .unwrap_or_default();
            unique_errors.sort();

            infos.push(ProviderInfo {
                id: setting.id.clone(),
                name: setting.name.clone(),
                description: Some(setting.description.clone()),
                url: setting.url.clone(),
                enabled: setting.enabled,
                priority: setting.priority,
                logo_filename: setting.logo_filename.clone(),
                capabilities: setting.capabilities.clone(),
                requires_api_key: requires_key,
                has_api_key: has_key,
                asset_count,
                error_count,
                last_synced_at,
                last_sync_error,
                unique_errors,
                provider_type: setting.provider_type.clone(),
            });
        }

        infos.sort_by_key(|a| a.priority);
        Ok(infos)
    }

    async fn update_provider_settings(
        &self,
        provider_id: &str,
        priority: i32,
        enabled: bool,
    ) -> Result<()> {
        use super::provider_settings::UpdateMarketDataProviderSetting;

        self.provider_settings_store.update_provider(
            provider_id,
            UpdateMarketDataProviderSetting {
                priority: Some(priority),
                enabled: Some(enabled),
            },
        )?;

        // Refresh client with new settings
        self.refresh_client().await?;

        Ok(())
    }

    // =========================================================================
    // Quote Import
    // =========================================================================

    async fn check_quotes_import(
        &self,
        content: &[u8],
        has_header_row: bool,
    ) -> Result<Vec<QuoteImport>> {
        use rust_decimal::Decimal;
        use std::str::FromStr;

        // Parse CSV
        let mut reader = csv::ReaderBuilder::new()
            .has_headers(has_header_row)
            .flexible(true)
            .trim(csv::Trim::All)
            .from_reader(content);

        // Get headers (lowercase for case-insensitive matching)
        let headers: Vec<String> = if has_header_row {
            reader
                .headers()
                .map_err(|e| {
                    crate::errors::ValidationError::InvalidInput(format!(
                        "Failed to read CSV headers: {}",
                        e
                    ))
                })?
                .iter()
                .map(|h| h.to_lowercase())
                .collect()
        } else {
            vec![
                "symbol".to_string(),
                "date".to_string(),
                "close".to_string(),
            ]
        };

        // Validate required headers
        let required = ["symbol", "date", "close"];
        let missing: Vec<&str> = required
            .iter()
            .filter(|h| !headers.contains(&h.to_string()))
            .copied()
            .collect();
        if !missing.is_empty() {
            return Err(crate::errors::ValidationError::InvalidInput(format!(
                "Missing required columns: {}",
                missing.join(", ")
            ))
            .into());
        }

        // Helper to get column index
        let get_idx = |name: &str| headers.iter().position(|h| h == name);
        let symbol_idx = get_idx("symbol").unwrap();
        let date_idx = get_idx("date").unwrap();
        let close_idx = get_idx("close").unwrap();
        let open_idx = get_idx("open");
        let high_idx = get_idx("high");
        let low_idx = get_idx("low");
        let volume_idx = get_idx("volume");
        let currency_idx = get_idx("currency");

        // Parse rows into QuoteImport
        let mut quotes: Vec<QuoteImport> = Vec::new();
        for result in reader.records() {
            let record = match result {
                Ok(r) => r,
                Err(e) => {
                    debug!("Skipping invalid CSV row: {}", e);
                    continue;
                }
            };

            let get_field =
                |idx: usize| record.get(idx).map(|s| s.trim()).filter(|s| !s.is_empty());
            let parse_decimal = |idx: Option<usize>| -> Option<Decimal> {
                idx.and_then(&get_field)
                    .and_then(|s| Decimal::from_str(&s.replace(',', "")).ok())
            };

            let symbol = get_field(symbol_idx).unwrap_or("").to_string();
            let date = get_field(date_idx).unwrap_or("").to_string();
            let close = parse_decimal(Some(close_idx)).unwrap_or(Decimal::ZERO);
            let currency = get_field(currency_idx.unwrap_or(usize::MAX))
                .unwrap_or("USD")
                .to_string();

            quotes.push(QuoteImport {
                symbol,
                display_symbol: None,
                date,
                open: parse_decimal(open_idx),
                high: parse_decimal(high_idx),
                low: parse_decimal(low_idx),
                close,
                volume: parse_decimal(volume_idx),
                currency,
                validation_status: ImportValidationStatus::Valid,
                error_message: None,
            });
        }

        if quotes.is_empty() {
            return Err(crate::errors::ValidationError::InvalidInput(
                "CSV file must contain at least one data row".to_string(),
            )
            .into());
        }

        info!("Parsed {} quotes from CSV, validating...", quotes.len());

        // Fetch all assets once for efficient lookup
        let all_assets = self.asset_repo.list()?;

        // Build lookup maps for flexible symbol matching:
        // 1. By asset ID (e.g., "SEC:VFV:XTSE")
        // 2. By symbol (e.g., "VFV")
        // 3. By symbol.exchange suffix (e.g., "VFV.TO" -> symbol "VFV" + exchange suffix "TO")
        let mut asset_by_id: HashMap<String, &Asset> = HashMap::new();
        let mut asset_by_symbol: HashMap<String, &Asset> = HashMap::new();
        let mut asset_by_symbol_exchange: HashMap<String, &Asset> = HashMap::new();

        for asset in &all_assets {
            asset_by_id.insert(asset.id.to_lowercase(), asset);
            asset_by_symbol.insert(
                asset
                    .display_code
                    .as_deref()
                    .unwrap_or_default()
                    .to_lowercase(),
                asset,
            );

            // Build symbol.exchange key if asset has exchange_mic
            if let Some(ref mic) = asset.instrument_exchange_mic {
                if let Some(suffix) = mic_to_yahoo_suffix(mic) {
                    let key = format!(
                        "{}.{}",
                        asset
                            .display_code
                            .as_deref()
                            .unwrap_or_default()
                            .to_lowercase(),
                        suffix.to_lowercase()
                    );
                    asset_by_symbol_exchange.insert(key, asset);
                }
            }
        }

        for quote in &mut quotes {
            // First validate the quote fields
            quote.validation_status = QuoteValidator::validate(quote);

            // If already has an error, skip asset matching
            if !quote.validation_status.is_importable() {
                if let ImportValidationStatus::Error(msg) = &quote.validation_status {
                    quote.error_message = Some(msg.clone());
                }
                continue;
            }

            // Try to match the symbol against existing assets
            // Priority: 1) exact asset ID, 2) exact symbol, 3) symbol.exchange format
            let symbol_lower = quote.symbol.to_lowercase();
            let matched_asset = asset_by_id
                .get(&symbol_lower)
                .or_else(|| asset_by_symbol.get(&symbol_lower))
                .or_else(|| asset_by_symbol_exchange.get(&symbol_lower));

            match matched_asset {
                Some(asset) => {
                    // Preserve original symbol for display, replace with asset ID for import
                    quote.display_symbol = Some(
                        asset
                            .display_code
                            .clone()
                            .unwrap_or_else(|| quote.symbol.clone()),
                    );
                    quote.symbol = asset.id.clone();
                }
                None => {
                    // Asset not found - mark as error
                    let msg = format!("Asset not found: '{}'", quote.symbol);
                    quote.validation_status = ImportValidationStatus::Error(msg.clone());
                    quote.error_message = Some(msg);
                }
            }
        }

        Ok(quotes)
    }

    async fn import_quotes(
        &self,
        mut quotes: Vec<QuoteImport>,
        overwrite: bool,
    ) -> Result<Vec<QuoteImport>> {
        info!(
            "Importing {} quotes (overwrite={})",
            quotes.len(),
            overwrite
        );

        // Validate all quotes
        QuoteValidator::validate_batch(&mut quotes);

        let mut to_save = Vec::new();

        for quote in &mut quotes {
            // Skip invalid quotes
            if !quote.validation_status.is_importable() {
                continue;
            }

            // Check for duplicates if not overwriting
            if !overwrite {
                let existing = self
                    .quote_store
                    .find_duplicate_quotes(&quote.symbol, quote.parse_date().unwrap_or_default());
                if existing.map(|v| !v.is_empty()).unwrap_or(false) {
                    quote.validation_status =
                        ImportValidationStatus::Warning("Quote already exists".to_string());
                    continue;
                }
            }

            // Convert and add to batch
            match self.convert_import_to_quote(quote) {
                Ok(q) => {
                    to_save.push(q);
                    quote.validation_status = ImportValidationStatus::Valid;
                }
                Err(e) => {
                    quote.validation_status = ImportValidationStatus::Error(e.to_string());
                }
            }
        }

        // Save all valid quotes
        if !to_save.is_empty() {
            let saved = self.quote_store.upsert_quotes(&to_save).await?;
            info!("Saved {} quotes", saved);
        }

        Ok(quotes)
    }
}

// =============================================================================
// Symbol Resolution Helpers
// =============================================================================

/// Convert MIC (Market Identifier Code) to Yahoo Finance exchange suffix.
///
/// This enables matching symbols like "VFV.TO" against assets with exchange_mic "XTSE".
///
/// # Arguments
/// * `mic` - The ISO 10383 Market Identifier Code (e.g., "XTSE")
///
/// # Returns
/// The Yahoo Finance suffix without the dot (e.g., "TO") if known, or None.
fn mic_to_yahoo_suffix(mic: &str) -> Option<String> {
    ExchangeMap::new()
        .get_suffix(
            &std::borrow::Cow::Owned(mic.to_string()),
            &std::borrow::Cow::Borrowed("YAHOO"),
        )
        .and_then(|suffix| suffix.strip_prefix('.'))
        .map(str::to_string)
}

// =============================================================================
// Gap Filling Helper
// =============================================================================

pub(crate) fn append_historical_seed_quotes<Q: QuoteStore>(
    quote_store: &Q,
    symbols: &HashSet<String>,
    start: NaiveDate,
    assets_by_id: &HashMap<String, Asset>,
    all_quotes: &mut Vec<Quote>,
) -> Result<()> {
    let mut symbols_with_seed_quotes: HashSet<String> = all_quotes
        .iter()
        .filter(|quote| quote.timestamp.date_naive() < start)
        .map(|quote| quote.asset_id.clone())
        .collect();

    // For symbols without a pre-start seed in the lookback window, fetch the
    // latest quote before start. Preserves manual quote carry-forward when stale.
    for symbol in symbols {
        if symbols_with_seed_quotes.contains(symbol) {
            continue;
        }

        let maybe_seed_quote = quote_store.get_latest_quote_before(symbol, start)?;

        if let Some(mut seed_quote) = maybe_seed_quote {
            if let Some(asset) = assets_by_id.get(symbol) {
                reconcile_quote_currency(&mut seed_quote, asset);
            }
            all_quotes.push(seed_quote);
            symbols_with_seed_quotes.insert(symbol.clone());
        }
    }

    Ok(())
}

/// Fills missing quotes for weekends and holidays by carrying forward the last known quote.
///
/// This is critical for portfolio valuation which needs a quote for every day in the range.
/// Without this, portfolio values would show $0 on non-trading days.
///
/// # Algorithm
/// 1. Build a map of quotes by date
/// 2. Look back from start_date to find initial quotes for each symbol
/// 3. For each day in [start_date, end_date]:
///    - Update last_known_quotes with any actual quotes for that day
///    - Output the last known quote for each symbol (with the current day's timestamp)
///
/// # Arguments
/// * `quotes` - All quotes including lookback period
/// * `required_symbols` - Symbols to fill
/// * `start_date` - Start of the output range
/// * `end_date` - End of the output range
///
/// # Returns
/// A Vec of quotes with one entry per symbol per day (filled from last known value)
pub(crate) fn fill_missing_quotes(
    quotes: &[Quote],
    required_symbols: &HashSet<String>,
    start_date: NaiveDate,
    end_date: NaiveDate,
) -> Vec<Quote> {
    if required_symbols.is_empty() {
        return Vec::new();
    }

    // Build quotes_by_date map
    let mut quotes_by_date: HashMap<NaiveDate, HashMap<String, Quote>> = HashMap::new();
    for quote in quotes {
        quotes_by_date
            .entry(quote.timestamp.date_naive())
            .or_default()
            .insert(quote.asset_id.clone(), quote.clone());
    }

    let mut all_filled_quotes = Vec::new();
    let mut last_known_quotes: HashMap<String, Quote> = HashMap::new();

    // Look back from start_date to find initial quotes for each required symbol
    // We look through all dates before start_date that we have quotes for
    let mut lookback_dates: Vec<NaiveDate> = quotes_by_date
        .keys()
        .filter(|d| **d < start_date)
        .cloned()
        .collect();
    lookback_dates.sort(); // Sort ascending so we get the most recent values

    for date in lookback_dates {
        if let Some(daily_quotes) = quotes_by_date.get(&date) {
            for (symbol, quote) in daily_quotes {
                if required_symbols.contains(symbol) {
                    // Always update - we want the most recent quote before start_date
                    last_known_quotes.insert(symbol.clone(), quote.clone());
                }
            }
        }
    }

    // Now iterate through the requested date range
    for current_date in time_utils::get_days_between(start_date, end_date) {
        // Update last_known_quotes with any actual quotes for this day
        if let Some(daily_quotes) = quotes_by_date.get(&current_date) {
            for (symbol, quote) in daily_quotes {
                if required_symbols.contains(symbol) {
                    last_known_quotes.insert(symbol.clone(), quote.clone());
                }
            }
        }

        // Output a quote for each required symbol using last known value
        for symbol in required_symbols {
            if let Some(last_quote) = last_known_quotes.get(symbol) {
                let mut quote_for_today = last_quote.clone();
                // Update timestamp to current date at noon UTC
                quote_for_today.timestamp =
                    Utc.from_utc_datetime(&current_date.and_hms_opt(12, 0, 0).unwrap());
                all_filled_quotes.push(quote_for_today);
            }
        }
    }

    all_filled_quotes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activities::{
        Activity, ActivityBulkMutationResult, ActivityRepositoryTrait, ActivityUpdate,
        ImportMapping, IncomeData, NewActivity, Sort,
    };
    use crate::assets::QuoteMode;
    use crate::assets::{AssetRepositoryTrait, NewAsset, UpdateAssetProfile};
    use crate::limits::ContributionActivity;
    use crate::quotes::store::ProviderSettingsStore;
    use crate::quotes::types::{AssetId, Day, QuoteSource};
    use crate::quotes::{
        LatestQuotePair, MarketDataProviderSetting, ProviderSyncStats, QuoteService, QuoteStore,
        QuoteSyncState,
    };
    use crate::secrets::SecretStore;
    use async_trait::async_trait;
    use rust_decimal_macros::dec;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    #[test]
    fn test_instrument_key_from_bf_search_result_uses_isin_and_mic() {
        let result = SymbolSearchResult {
            symbol: "IE00BTJRMP35".to_string(),
            quote_type: "ETF".to_string(),
            exchange_mic: Some("XETR".to_string()),
            currency: Some("EUR".to_string()),
            ..Default::default()
        };

        assert_eq!(
            instrument_key_from_search_result(&result).as_deref(),
            Some("EQUITY:IE00BTJRMP35@XETR")
        );
    }

    #[test]
    fn test_instrument_key_from_yahoo_search_result_canonicalizes_suffix() {
        let result = SymbolSearchResult {
            symbol: "SHOP.TO".to_string(),
            quote_type: "EQUITY".to_string(),
            exchange_mic: Some("XTSE".to_string()),
            currency: Some("CAD".to_string()),
            ..Default::default()
        };

        assert_eq!(
            instrument_key_from_search_result(&result).as_deref(),
            Some("EQUITY:SHOP@XTSE")
        );
    }

    #[test]
    fn test_local_search_identity_canonicalizes_provider_symbols() {
        assert_eq!(
            local_search_identity("SHOP.TO"),
            Some(("SHOP".to_string(), Some("XTSE")))
        );
        assert_eq!(
            local_search_identity("BRK-B"),
            Some(("BRK.B".to_string(), None))
        );
    }

    #[test]
    fn test_local_search_identity_matches_canonical_asset_exchange() {
        let shop_tsx = Asset {
            instrument_symbol: Some("SHOP".to_string()),
            instrument_exchange_mic: Some("XTSE".to_string()),
            ..Default::default()
        };
        let shop_nyse = Asset {
            instrument_symbol: Some("SHOP".to_string()),
            instrument_exchange_mic: Some("XNYS".to_string()),
            ..Default::default()
        };
        let (canonical_symbol, exchange_mic) = local_search_identity("SHOP.TO").unwrap();

        assert!(asset_matches_local_search_identity(
            &shop_tsx,
            &canonical_symbol,
            exchange_mic
        ));
        assert!(!asset_matches_local_search_identity(
            &shop_nyse,
            &canonical_symbol,
            exchange_mic
        ));
    }

    #[test]
    fn test_mic_to_yahoo_suffix_uses_market_data_registry() {
        assert_eq!(mic_to_yahoo_suffix("CXE").as_deref(), Some("XC"));
        assert_eq!(mic_to_yahoo_suffix("XETR").as_deref(), Some("DE"));
    }

    #[test]
    fn test_asset_search_summary_displays_exchange_qualified_symbol() {
        let asset = Asset {
            id: "shop-tsx".to_string(),
            name: Some("Shopify Inc.".to_string()),
            display_code: Some("SHOP".to_string()),
            instrument_symbol: Some("SHOP".to_string()),
            instrument_exchange_mic: Some("XTSE".to_string()),
            instrument_type: Some(InstrumentType::Equity),
            quote_ccy: "CAD".to_string(),
            provider_config: Some(serde_json::json!({ "preferred_provider": "YAHOO" })),
            ..Default::default()
        };

        let result = QuoteService::<
            NoopQuoteStore,
            MockSyncStateStore,
            MockProviderSettingsStore,
            NoopAssetRepository,
            NoopActivityRepository,
        >::asset_to_quote_summary(&asset);

        assert_eq!(result.symbol, "SHOP.TO");
        assert_eq!(result.canonical_symbol.as_deref(), Some("SHOP"));
        assert_eq!(result.canonical_exchange_mic.as_deref(), Some("XTSE"));
        assert_eq!(result.provider_id.as_deref(), Some("YAHOO"));

        let metal = Asset {
            id: "gold-spot".to_string(),
            name: Some("Gold".to_string()),
            display_code: Some("XAU".to_string()),
            instrument_symbol: Some("XAU".to_string()),
            instrument_exchange_mic: None,
            instrument_type: Some(InstrumentType::Metal),
            quote_ccy: "USD".to_string(),
            provider_config: Some(serde_json::json!({
                "preferred_provider": "METAL_PRICE_API",
                "overrides": {
                    "METAL_PRICE_API": {
                        "type": "metal_symbol",
                        "symbol": "XAU-1KG",
                        "quote": "USD"
                    }
                }
            })),
            ..Default::default()
        };

        let result = QuoteService::<
            NoopQuoteStore,
            MockSyncStateStore,
            MockProviderSettingsStore,
            NoopAssetRepository,
            NoopActivityRepository,
        >::asset_to_quote_summary(&metal);

        assert_eq!(result.symbol, "XAU");
        assert_eq!(result.canonical_symbol.as_deref(), Some("XAU"));
        assert_eq!(result.canonical_exchange_mic, None);
    }

    #[test]
    fn test_market_asset_without_provider_stays_market_in_search_summary() {
        let asset = Asset {
            id: "aapl".to_string(),
            name: Some("Apple Inc.".to_string()),
            display_code: Some("AAPL".to_string()),
            instrument_symbol: Some("AAPL".to_string()),
            instrument_exchange_mic: Some("XNAS".to_string()),
            instrument_type: Some(InstrumentType::Equity),
            quote_mode: QuoteMode::Market,
            quote_ccy: "USD".to_string(),
            provider_config: None,
            ..Default::default()
        };

        let result = QuoteService::<
            NoopQuoteStore,
            MockSyncStateStore,
            MockProviderSettingsStore,
            NoopAssetRepository,
            NoopActivityRepository,
        >::asset_to_quote_summary(&asset);

        assert_eq!(result.data_source, None);
        assert_eq!(result.quote_mode.as_deref(), Some("MARKET"));
    }

    #[test]
    fn test_asset_provider_alias_symbols_include_provider_overrides() {
        let asset = Asset {
            instrument_symbol: Some("ACME".to_string()),
            instrument_exchange_mic: Some("XNYS".to_string()),
            instrument_type: Some(InstrumentType::Equity),
            quote_ccy: "USD".to_string(),
            provider_config: Some(serde_json::json!({
                "preferred_provider": "YAHOO",
                "overrides": {
                    "YAHOO": { "type": "equity_symbol", "symbol": "ACME-OLD" }
                }
            })),
            ..Default::default()
        };

        let aliases = asset_provider_alias_symbols(&asset);

        assert!(aliases.iter().any(|alias| alias == "ACME-OLD"));
    }

    #[derive(Default)]
    struct NoopQuoteStore;

    #[async_trait]
    impl QuoteStore for NoopQuoteStore {
        async fn save_quote(&self, _quote: &Quote) -> Result<Quote> {
            unimplemented!("unused in this test")
        }

        async fn delete_quote(&self, _quote_id: &str) -> Result<()> {
            unimplemented!("unused in this test")
        }

        async fn upsert_quotes(&self, _quotes: &[Quote]) -> Result<usize> {
            unimplemented!("unused in this test")
        }

        async fn delete_quotes_for_asset(&self, _asset_id: &AssetId) -> Result<usize> {
            unimplemented!("unused in this test")
        }

        async fn delete_provider_quotes_for_asset(&self, _asset_id: &AssetId) -> Result<usize> {
            unimplemented!("unused in this test")
        }

        fn latest(
            &self,
            _asset_id: &AssetId,
            _source: Option<&QuoteSource>,
        ) -> Result<Option<Quote>> {
            unimplemented!("unused in this test")
        }

        fn range(
            &self,
            _asset_id: &AssetId,
            _start: Day,
            _end: Day,
            _source: Option<&QuoteSource>,
        ) -> Result<Vec<Quote>> {
            unimplemented!("unused in this test")
        }

        fn latest_batch(
            &self,
            _asset_ids: &[AssetId],
            _source: Option<&QuoteSource>,
        ) -> Result<HashMap<AssetId, Quote>> {
            unimplemented!("unused in this test")
        }

        fn latest_with_previous(
            &self,
            _asset_ids: &[AssetId],
        ) -> Result<HashMap<AssetId, LatestQuotePair>> {
            unimplemented!("unused in this test")
        }

        fn get_quote_bounds_for_assets(
            &self,
            _asset_ids: &[String],
            _source: &str,
        ) -> Result<HashMap<String, (NaiveDate, NaiveDate)>> {
            unimplemented!("unused in this test")
        }

        fn get_latest_quote(&self, _symbol: &str) -> Result<Quote> {
            unimplemented!("unused in this test")
        }

        fn get_latest_quotes(&self, _symbols: &[String]) -> Result<HashMap<String, Quote>> {
            unimplemented!("unused in this test")
        }

        fn get_latest_quotes_as_of(
            &self,
            _symbols: &[String],
            _as_of: chrono::NaiveDate,
        ) -> Result<HashMap<String, Quote>> {
            Ok(HashMap::new())
        }

        fn get_latest_quotes_pair(
            &self,
            _symbols: &[String],
        ) -> Result<HashMap<String, LatestQuotePair>> {
            unimplemented!("unused in this test")
        }

        fn get_historical_quotes(&self, _symbol: &str) -> Result<Vec<Quote>> {
            unimplemented!("unused in this test")
        }

        fn get_all_historical_quotes(&self) -> Result<Vec<Quote>> {
            unimplemented!("unused in this test")
        }

        fn get_quotes_in_range(
            &self,
            _symbol: &str,
            _start: NaiveDate,
            _end: NaiveDate,
        ) -> Result<Vec<Quote>> {
            unimplemented!("unused in this test")
        }

        fn find_duplicate_quotes(&self, _symbol: &str, _date: NaiveDate) -> Result<Vec<Quote>> {
            unimplemented!("unused in this test")
        }
    }

    #[derive(Default)]
    struct SnapshotQuoteStore {
        quotes: HashMap<String, Quote>,
        requested_latest_quotes: Arc<Mutex<Vec<Vec<String>>>>,
    }

    #[async_trait]
    impl QuoteStore for SnapshotQuoteStore {
        async fn save_quote(&self, _quote: &Quote) -> Result<Quote> {
            unimplemented!("unused in this test")
        }

        async fn delete_quote(&self, _quote_id: &str) -> Result<()> {
            unimplemented!("unused in this test")
        }

        async fn upsert_quotes(&self, _quotes: &[Quote]) -> Result<usize> {
            unimplemented!("unused in this test")
        }

        async fn delete_quotes_for_asset(&self, _asset_id: &AssetId) -> Result<usize> {
            unimplemented!("unused in this test")
        }

        async fn delete_provider_quotes_for_asset(&self, _asset_id: &AssetId) -> Result<usize> {
            unimplemented!("unused in this test")
        }

        fn latest(
            &self,
            _asset_id: &AssetId,
            _source: Option<&QuoteSource>,
        ) -> Result<Option<Quote>> {
            unimplemented!("unused in this test")
        }

        fn range(
            &self,
            _asset_id: &AssetId,
            _start: Day,
            _end: Day,
            _source: Option<&QuoteSource>,
        ) -> Result<Vec<Quote>> {
            unimplemented!("unused in this test")
        }

        fn latest_batch(
            &self,
            _asset_ids: &[AssetId],
            _source: Option<&QuoteSource>,
        ) -> Result<HashMap<AssetId, Quote>> {
            unimplemented!("unused in this test")
        }

        fn latest_with_previous(
            &self,
            _asset_ids: &[AssetId],
        ) -> Result<HashMap<AssetId, LatestQuotePair>> {
            unimplemented!("unused in this test")
        }

        fn get_quote_bounds_for_assets(
            &self,
            _asset_ids: &[String],
            _source: &str,
        ) -> Result<HashMap<String, (NaiveDate, NaiveDate)>> {
            unimplemented!("unused in this test")
        }

        fn get_latest_quote(&self, _symbol: &str) -> Result<Quote> {
            unimplemented!("unused in this test")
        }

        fn get_latest_quotes(&self, symbols: &[String]) -> Result<HashMap<String, Quote>> {
            self.requested_latest_quotes
                .lock()
                .unwrap()
                .push(symbols.to_vec());
            Ok(symbols
                .iter()
                .filter_map(|symbol| {
                    self.quotes
                        .get(symbol)
                        .cloned()
                        .map(|quote| (symbol.clone(), quote))
                })
                .collect())
        }

        fn get_latest_quotes_as_of(
            &self,
            _symbols: &[String],
            _as_of: chrono::NaiveDate,
        ) -> Result<HashMap<String, Quote>> {
            Ok(HashMap::new())
        }

        fn get_latest_quotes_pair(
            &self,
            _symbols: &[String],
        ) -> Result<HashMap<String, LatestQuotePair>> {
            unimplemented!("unused in this test")
        }

        fn get_historical_quotes(&self, _symbol: &str) -> Result<Vec<Quote>> {
            unimplemented!("unused in this test")
        }

        fn get_all_historical_quotes(&self) -> Result<Vec<Quote>> {
            unimplemented!("unused in this test")
        }

        fn get_quotes_in_range(
            &self,
            _symbol: &str,
            _start: NaiveDate,
            _end: NaiveDate,
        ) -> Result<Vec<Quote>> {
            unimplemented!("unused in this test")
        }

        fn find_duplicate_quotes(&self, _symbol: &str, _date: NaiveDate) -> Result<Vec<Quote>> {
            unimplemented!("unused in this test")
        }
    }

    struct MockSyncStateStore {
        provider_sync_stats: Vec<ProviderSyncStats>,
        with_errors: Vec<QuoteSyncState>,
        states: Arc<Mutex<HashMap<String, QuoteSyncState>>>,
    }

    #[async_trait]
    impl crate::quotes::SyncStateStore for MockSyncStateStore {
        fn get_provider_sync_stats(&self) -> Result<Vec<ProviderSyncStats>> {
            Ok(self.provider_sync_stats.clone())
        }

        fn get_all(&self) -> Result<Vec<QuoteSyncState>> {
            Ok(self.states.lock().unwrap().values().cloned().collect())
        }

        fn get_by_asset_id(&self, asset_id: &str) -> Result<Option<QuoteSyncState>> {
            Ok(self.states.lock().unwrap().get(asset_id).cloned())
        }

        fn get_by_asset_ids(
            &self,
            asset_ids: &[String],
        ) -> Result<HashMap<String, QuoteSyncState>> {
            let states = self.states.lock().unwrap();
            Ok(asset_ids
                .iter()
                .filter_map(|asset_id| {
                    states
                        .get(asset_id)
                        .cloned()
                        .map(|state| (asset_id.clone(), state))
                })
                .collect())
        }

        fn get_active_assets(&self) -> Result<Vec<QuoteSyncState>> {
            unimplemented!("unused in this test")
        }

        fn get_assets_needing_sync(&self, _grace_period_days: i64) -> Result<Vec<QuoteSyncState>> {
            unimplemented!("unused in this test")
        }

        async fn upsert(&self, state: &QuoteSyncState) -> Result<QuoteSyncState> {
            self.states
                .lock()
                .unwrap()
                .insert(state.asset_id.clone(), state.clone());
            Ok(state.clone())
        }

        async fn upsert_batch(&self, states: &[QuoteSyncState]) -> Result<usize> {
            let mut stored = self.states.lock().unwrap();
            for state in states {
                stored.insert(state.asset_id.clone(), state.clone());
            }
            Ok(states.len())
        }

        async fn update_after_sync(&self, _asset_id: &str) -> Result<()> {
            unimplemented!("unused in this test")
        }

        async fn update_after_failure(&self, _asset_id: &str, _error: &str) -> Result<()> {
            unimplemented!("unused in this test")
        }

        async fn mark_inactive(&self, asset_id: &str, closed_date: NaiveDate) -> Result<()> {
            if let Some(state) = self.states.lock().unwrap().get_mut(asset_id) {
                state.mark_closed(closed_date);
            }
            Ok(())
        }

        async fn mark_active(&self, asset_id: &str) -> Result<()> {
            if let Some(state) = self.states.lock().unwrap().get_mut(asset_id) {
                state.mark_active();
            }
            Ok(())
        }

        async fn delete(&self, _asset_id: &str) -> Result<()> {
            unimplemented!("unused in this test")
        }

        async fn delete_all(&self) -> Result<usize> {
            unimplemented!("unused in this test")
        }

        async fn mark_profile_enriched(&self, _asset_id: &str) -> Result<()> {
            unimplemented!("unused in this test")
        }

        fn get_assets_needing_profile_enrichment(&self) -> Result<Vec<QuoteSyncState>> {
            unimplemented!("unused in this test")
        }

        fn get_with_errors(&self) -> Result<Vec<QuoteSyncState>> {
            Ok(self.with_errors.clone())
        }
    }

    struct MockProviderSettingsStore {
        providers: Vec<MarketDataProviderSetting>,
    }

    impl ProviderSettingsStore for MockProviderSettingsStore {
        fn get_all_providers(&self) -> Result<Vec<MarketDataProviderSetting>> {
            Ok(self.providers.clone())
        }

        fn get_provider(&self, id: &str) -> Result<MarketDataProviderSetting> {
            self.providers
                .iter()
                .find(|p| p.id == id)
                .cloned()
                .ok_or_else(|| crate::Error::Unexpected(format!("Provider not found: {}", id)))
        }

        fn update_provider(
            &self,
            _id: &str,
            _changes: crate::quotes::UpdateMarketDataProviderSetting,
        ) -> Result<MarketDataProviderSetting> {
            unimplemented!("unused in this test")
        }
    }

    #[derive(Default)]
    struct NoopAssetRepository;

    #[async_trait]
    impl AssetRepositoryTrait for NoopAssetRepository {
        async fn create(&self, _new_asset: NewAsset) -> Result<Asset> {
            unimplemented!("unused in this test")
        }

        async fn create_batch(&self, _new_assets: Vec<NewAsset>) -> Result<Vec<Asset>> {
            unimplemented!("unused in this test")
        }

        async fn update_profile(
            &self,
            _asset_id: &str,
            _payload: UpdateAssetProfile,
        ) -> Result<Asset> {
            unimplemented!("unused in this test")
        }

        async fn update_quote_mode(&self, _asset_id: &str, _quote_mode: &str) -> Result<Asset> {
            unimplemented!("unused in this test")
        }

        fn get_by_id(&self, _asset_id: &str) -> Result<Asset> {
            unimplemented!("unused in this test")
        }

        fn list(&self) -> Result<Vec<Asset>> {
            Ok(Vec::new())
        }

        fn list_by_asset_ids(&self, _asset_ids: &[String]) -> Result<Vec<Asset>> {
            Ok(Vec::new())
        }

        async fn delete(&self, _asset_id: &str) -> Result<()> {
            unimplemented!("unused in this test")
        }

        fn search_by_symbol(&self, _query: &str) -> Result<Vec<Asset>> {
            unimplemented!("unused in this test")
        }

        fn find_by_instrument_key(&self, _instrument_key: &str) -> Result<Option<Asset>> {
            unimplemented!("unused in this test")
        }

        async fn cleanup_legacy_metadata(&self, _asset_id: &str) -> Result<()> {
            unimplemented!("unused in this test")
        }

        async fn deactivate(&self, _asset_id: &str) -> Result<()> {
            unimplemented!("unused in this test")
        }

        async fn reactivate(&self, _asset_id: &str) -> Result<()> {
            unimplemented!("unused in this test")
        }

        async fn copy_user_metadata(&self, _source_id: &str, _target_id: &str) -> Result<()> {
            unimplemented!("unused in this test")
        }

        async fn deactivate_orphaned_investments(&self) -> Result<Vec<String>> {
            unimplemented!("unused in this test")
        }
    }

    struct PositionStatusAssetRepository {
        assets: HashMap<String, Asset>,
        reactivated: Arc<Mutex<Vec<String>>>,
        deactivated: Arc<Mutex<Vec<String>>>,
    }

    #[async_trait]
    impl AssetRepositoryTrait for PositionStatusAssetRepository {
        async fn create(&self, _new_asset: NewAsset) -> Result<Asset> {
            unimplemented!("unused in this test")
        }

        async fn create_batch(&self, _new_assets: Vec<NewAsset>) -> Result<Vec<Asset>> {
            unimplemented!("unused in this test")
        }

        async fn update_profile(
            &self,
            _asset_id: &str,
            _payload: UpdateAssetProfile,
        ) -> Result<Asset> {
            unimplemented!("unused in this test")
        }

        async fn update_quote_mode(&self, _asset_id: &str, _quote_mode: &str) -> Result<Asset> {
            unimplemented!("unused in this test")
        }

        fn get_by_id(&self, asset_id: &str) -> Result<Asset> {
            self.assets
                .get(asset_id)
                .cloned()
                .ok_or_else(|| crate::Error::Unexpected(format!("asset not found: {}", asset_id)))
        }

        fn list(&self) -> Result<Vec<Asset>> {
            Ok(self.assets.values().cloned().collect())
        }

        fn list_by_asset_ids(&self, asset_ids: &[String]) -> Result<Vec<Asset>> {
            Ok(asset_ids
                .iter()
                .filter_map(|asset_id| self.assets.get(asset_id).cloned())
                .collect())
        }

        async fn delete(&self, _asset_id: &str) -> Result<()> {
            unimplemented!("unused in this test")
        }

        fn search_by_symbol(&self, _query: &str) -> Result<Vec<Asset>> {
            unimplemented!("unused in this test")
        }

        fn find_by_instrument_key(&self, _instrument_key: &str) -> Result<Option<Asset>> {
            unimplemented!("unused in this test")
        }

        async fn cleanup_legacy_metadata(&self, _asset_id: &str) -> Result<()> {
            unimplemented!("unused in this test")
        }

        async fn deactivate(&self, asset_id: &str) -> Result<()> {
            self.deactivated.lock().unwrap().push(asset_id.to_string());
            Ok(())
        }

        async fn reactivate(&self, asset_id: &str) -> Result<()> {
            self.reactivated.lock().unwrap().push(asset_id.to_string());
            Ok(())
        }

        async fn copy_user_metadata(&self, _source_id: &str, _target_id: &str) -> Result<()> {
            unimplemented!("unused in this test")
        }

        async fn deactivate_orphaned_investments(&self) -> Result<Vec<String>> {
            unimplemented!("unused in this test")
        }
    }

    #[derive(Default)]
    struct NoopActivityRepository;

    #[async_trait]
    impl ActivityRepositoryTrait for NoopActivityRepository {
        fn get_activity(&self, _activity_id: &str) -> Result<Activity> {
            unimplemented!("unused in this test")
        }

        fn find_transfer_counterpart(
            &self,
            _group_id: &str,
            _exclude_id: &str,
        ) -> Result<Option<Activity>> {
            Ok(None)
        }

        fn get_activities(&self) -> Result<Vec<Activity>> {
            unimplemented!("unused in this test")
        }

        fn get_activities_by_account_id(&self, _account_id: &str) -> Result<Vec<Activity>> {
            unimplemented!("unused in this test")
        }

        fn get_activities_by_account_ids(&self, _account_ids: &[String]) -> Result<Vec<Activity>> {
            unimplemented!("unused in this test")
        }

        fn get_trading_activities(&self) -> Result<Vec<Activity>> {
            unimplemented!("unused in this test")
        }

        fn get_income_activities(&self) -> Result<Vec<Activity>> {
            unimplemented!("unused in this test")
        }

        fn get_contribution_activities(
            &self,
            _account_ids: &[String],
            _start_date: chrono::DateTime<chrono::Utc>,
            _end_date: chrono::DateTime<chrono::Utc>,
        ) -> Result<Vec<ContributionActivity>> {
            unimplemented!("unused in this test")
        }

        fn search_activities(
            &self,
            _page: i64,
            _page_size: i64,
            _account_id_filter: Option<Vec<String>>,
            _activity_type_filter: Option<Vec<String>>,
            _asset_id_keyword: Option<String>,
            _sort: Option<Sort>,
            _needs_review_filter: Option<bool>,
            _date_from: Option<NaiveDate>,
            _date_to: Option<NaiveDate>,
            _instrument_type_filter: Option<Vec<String>>,
            _activity_id_filter: Option<Vec<String>>,
        ) -> Result<crate::activities::ActivitySearchResponse> {
            unimplemented!("unused in this test")
        }

        async fn create_activity(&self, _new_activity: NewActivity) -> Result<Activity> {
            unimplemented!("unused in this test")
        }

        async fn update_activity(&self, _activity_update: ActivityUpdate) -> Result<Activity> {
            unimplemented!("unused in this test")
        }

        async fn delete_activity(&self, _activity_id: String) -> Result<Activity> {
            unimplemented!("unused in this test")
        }

        async fn link_transfer_activities(
            &self,
            _activity_a_id: String,
            _activity_b_id: String,
        ) -> Result<(Activity, Activity)> {
            unimplemented!("unused in this test")
        }

        async fn unlink_transfer_activities(
            &self,
            _activity_a_id: String,
            _activity_b_id: String,
        ) -> Result<(Activity, Activity)> {
            unimplemented!("unused in this test")
        }

        async fn bulk_mutate_activities(
            &self,
            _creates: Vec<NewActivity>,
            _updates: Vec<ActivityUpdate>,
            _delete_ids: Vec<String>,
        ) -> Result<ActivityBulkMutationResult> {
            unimplemented!("unused in this test")
        }

        async fn create_activities(&self, _activities: Vec<NewActivity>) -> Result<usize> {
            unimplemented!("unused in this test")
        }

        fn get_first_activity_date(
            &self,
            _account_ids: Option<&[String]>,
        ) -> Result<Option<chrono::DateTime<Utc>>> {
            unimplemented!("unused in this test")
        }

        fn get_import_mapping(
            &self,
            _account_id: &str,
            _context_kind: &str,
        ) -> Result<Option<ImportMapping>> {
            unimplemented!("unused in this test")
        }

        async fn save_import_mapping(&self, _mapping: &ImportMapping) -> Result<()> {
            unimplemented!("unused in this test")
        }

        async fn link_account_template(
            &self,
            _account_id: &str,
            _template_id: &str,
            _context_kind: &str,
        ) -> Result<()> {
            unimplemented!("unused in this test")
        }

        fn list_import_templates(&self) -> Result<Vec<crate::activities::ImportTemplate>> {
            Ok(Vec::new())
        }

        fn get_import_template(
            &self,
            _template_id: &str,
        ) -> Result<Option<crate::activities::ImportTemplate>> {
            Ok(None)
        }

        async fn save_import_template(
            &self,
            _template: &crate::activities::ImportTemplate,
        ) -> Result<()> {
            unimplemented!("unused in this test")
        }

        async fn delete_import_template(&self, _template_id: &str) -> Result<()> {
            unimplemented!("unused in this test")
        }

        fn get_broker_sync_profile(
            &self,
            _account_id: &str,
            _source_system: &str,
        ) -> Result<Option<crate::activities::ImportTemplate>> {
            Ok(None)
        }

        async fn save_broker_sync_profile(
            &self,
            _template: &crate::activities::ImportTemplate,
        ) -> Result<()> {
            Ok(())
        }

        async fn link_broker_sync_profile(
            &self,
            _account_id: &str,
            _template_id: &str,
            _source_system: &str,
        ) -> Result<()> {
            Ok(())
        }

        fn calculate_average_cost(
            &self,
            _account_id: &str,
            _asset_id: &str,
        ) -> Result<rust_decimal::Decimal> {
            unimplemented!("unused in this test")
        }

        fn get_income_activities_data(
            &self,
            _account_ids: Option<&[String]>,
        ) -> Result<Vec<IncomeData>> {
            unimplemented!("unused in this test")
        }

        fn get_first_activity_date_overall(&self) -> Result<chrono::DateTime<Utc>> {
            unimplemented!("unused in this test")
        }

        fn get_activity_bounds_for_assets(
            &self,
            _asset_ids: &[String],
        ) -> Result<HashMap<String, (Option<NaiveDate>, Option<NaiveDate>)>> {
            unimplemented!("unused in this test")
        }

        fn get_holdings_snapshot_bounds_for_assets(
            &self,
            _asset_ids: &[String],
        ) -> Result<HashMap<String, (Option<NaiveDate>, Option<NaiveDate>)>> {
            unimplemented!("unused in this test")
        }

        fn check_existing_duplicates(
            &self,
            _idempotency_keys: &[String],
        ) -> Result<HashMap<String, String>> {
            unimplemented!("unused in this test")
        }

        async fn bulk_upsert(
            &self,
            _activities: Vec<crate::activities::ActivityUpsert>,
        ) -> Result<crate::activities::BulkUpsertResult> {
            unimplemented!("unused in this test")
        }

        async fn reassign_asset(&self, _old_asset_id: &str, _new_asset_id: &str) -> Result<u32> {
            unimplemented!("unused in this test")
        }

        async fn get_activity_accounts_and_currencies_by_asset_id(
            &self,
            _asset_id: &str,
        ) -> Result<(Vec<String>, Vec<String>)> {
            unimplemented!("unused in this test")
        }
    }

    #[derive(Default)]
    struct MockSecretStore;

    impl SecretStore for MockSecretStore {
        fn set_secret(&self, _service: &str, _secret: &str) -> Result<()> {
            Ok(())
        }

        fn get_secret(&self, _service: &str) -> Result<Option<String>> {
            Ok(None)
        }

        fn delete_secret(&self, _service: &str) -> Result<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn test_get_providers_info_attributes_error_to_provider_from_error_message() {
        let now = Utc::now();
        let finnhub_error = "Market data operation failed: Provider error: FINNHUB: Access forbidden - check API key: {\"error\":\"You don't have access to this resource.\"}".to_string();

        let provider_settings = Arc::new(MockProviderSettingsStore {
            providers: vec![
                MarketDataProviderSetting {
                    id: "YAHOO".to_string(),
                    name: "Yahoo Finance".to_string(),
                    description: "Yahoo provider".to_string(),
                    url: Some("https://finance.yahoo.com".to_string()),
                    priority: 1,
                    enabled: false,
                    logo_filename: None,
                    last_synced_at: None,
                    last_sync_status: None,
                    last_sync_error: None,
                    capabilities: None,
                    provider_type: None,
                },
                MarketDataProviderSetting {
                    id: "FINNHUB".to_string(),
                    name: "Finnhub".to_string(),
                    description: "Finnhub provider".to_string(),
                    url: Some("https://finnhub.io".to_string()),
                    priority: 2,
                    enabled: false,
                    logo_filename: None,
                    last_synced_at: None,
                    last_sync_status: None,
                    last_sync_error: None,
                    capabilities: None,
                    provider_type: None,
                },
            ],
        });

        let sync_state_store = Arc::new(MockSyncStateStore {
            provider_sync_stats: vec![ProviderSyncStats {
                provider_id: "YAHOO".to_string(),
                asset_count: 1,
                error_count: 1,
                last_synced_at: Some(now),
                last_error: Some("old yahoo error".to_string()),
                unique_errors: vec!["old yahoo error".to_string()],
            }],
            with_errors: vec![QuoteSyncState {
                asset_id: "asset_1".to_string(),
                is_active: true,
                position_closed_date: None,
                last_synced_at: Some(now),
                data_source: "YAHOO".to_string(),
                sync_priority: 100,
                error_count: 1,
                last_error: Some(finnhub_error.clone()),
                profile_enriched_at: None,
                created_at: now,
                updated_at: now,
            }],
            states: Arc::new(Mutex::new(HashMap::new())),
        });

        let service = QuoteService::new(
            Arc::new(NoopQuoteStore),
            sync_state_store,
            provider_settings,
            Arc::new(NoopAssetRepository),
            Arc::new(NoopActivityRepository),
            Arc::new(MockSecretStore),
        )
        .await
        .unwrap();

        let providers = QuoteServiceTrait::get_providers_info(&service)
            .await
            .unwrap();

        let yahoo = providers.iter().find(|p| p.id == "YAHOO").unwrap();
        let finnhub = providers.iter().find(|p| p.id == "FINNHUB").unwrap();

        assert_eq!(yahoo.asset_count, 1);
        assert_eq!(yahoo.error_count, 0);
        assert!(yahoo.last_sync_error.is_none());

        assert_eq!(finnhub.asset_count, 0);
        assert_eq!(finnhub.error_count, 1);
        assert_eq!(
            finnhub.last_sync_error.as_deref(),
            Some(finnhub_error.as_str())
        );
        assert_eq!(finnhub.unique_errors, vec![finnhub_error]);
    }

    #[tokio::test]
    async fn test_reset_sync_state_for_profile_change_clears_errors_and_provider_binding() {
        let now = Utc::now();
        let state = QuoteSyncState {
            asset_id: "asset_1".to_string(),
            is_active: true,
            position_closed_date: None,
            last_synced_at: Some(now),
            data_source: "YAHOO".to_string(),
            sync_priority: 100,
            error_count: 10,
            last_error: Some("old failure".to_string()),
            profile_enriched_at: Some(now),
            created_at: now,
            updated_at: now,
        };
        let states = Arc::new(Mutex::new(HashMap::from([(
            state.asset_id.clone(),
            state.clone(),
        )])));
        let sync_state_store = Arc::new(MockSyncStateStore {
            provider_sync_stats: vec![],
            with_errors: vec![],
            states: Arc::clone(&states),
        });
        let service = QuoteService::new(
            Arc::new(NoopQuoteStore),
            sync_state_store,
            Arc::new(MockProviderSettingsStore { providers: vec![] }),
            Arc::new(NoopAssetRepository),
            Arc::new(NoopActivityRepository),
            Arc::new(MockSecretStore),
        )
        .await
        .unwrap();

        QuoteServiceTrait::reset_sync_state_for_profile_change(&service, "asset_1")
            .await
            .unwrap();

        let updated = states.lock().unwrap().get("asset_1").cloned().unwrap();
        assert_eq!(updated.data_source, "");
        assert_eq!(updated.error_count, 0);
        assert!(updated.last_error.is_none());
        assert_eq!(updated.last_synced_at, state.last_synced_at);
        assert_eq!(updated.profile_enriched_at, state.profile_enriched_at);
    }

    #[tokio::test]
    async fn test_update_position_status_creates_sync_state_for_open_inactive_asset() {
        let asset_id = "asset_1".to_string();
        let asset = Asset {
            id: asset_id.clone(),
            kind: AssetKind::Investment,
            quote_mode: QuoteMode::Market,
            is_active: false,
            ..Default::default()
        };
        let reactivated = Arc::new(Mutex::new(Vec::new()));
        let deactivated = Arc::new(Mutex::new(Vec::new()));
        let asset_repo = PositionStatusAssetRepository {
            assets: HashMap::from([(asset_id.clone(), asset)]),
            reactivated: Arc::clone(&reactivated),
            deactivated: Arc::clone(&deactivated),
        };
        let states = Arc::new(Mutex::new(HashMap::new()));
        let sync_state_store = Arc::new(MockSyncStateStore {
            provider_sync_stats: vec![],
            with_errors: vec![],
            states: Arc::clone(&states),
        });
        let service = QuoteService::new(
            Arc::new(NoopQuoteStore),
            sync_state_store,
            Arc::new(MockProviderSettingsStore { providers: vec![] }),
            Arc::new(asset_repo),
            Arc::new(NoopActivityRepository),
            Arc::new(MockSecretStore),
        )
        .await
        .unwrap();
        let current_holdings = HashMap::from([(asset_id.clone(), dec!(1))]);

        service
            .update_position_status_from_holdings(&current_holdings)
            .await
            .unwrap();

        assert_eq!(*reactivated.lock().unwrap(), vec![asset_id.clone()]);
        assert!(deactivated.lock().unwrap().is_empty());

        let stored = states.lock().unwrap().get(&asset_id).cloned().unwrap();
        assert!(stored.is_active);
        assert!(stored.position_closed_date.is_none());
        assert_eq!(
            stored.sync_priority,
            SyncCategory::Active.default_priority()
        );
    }

    #[tokio::test]
    async fn test_update_position_status_treats_negative_quantity_as_open() {
        let asset_id = "asset_1".to_string();
        let asset = Asset {
            id: asset_id.clone(),
            kind: AssetKind::Investment,
            quote_mode: QuoteMode::Market,
            is_active: false,
            ..Default::default()
        };
        let reactivated = Arc::new(Mutex::new(Vec::new()));
        let asset_repo = PositionStatusAssetRepository {
            assets: HashMap::from([(asset_id.clone(), asset)]),
            reactivated: Arc::clone(&reactivated),
            deactivated: Arc::new(Mutex::new(Vec::new())),
        };
        let states = Arc::new(Mutex::new(HashMap::new()));
        let service = QuoteService::new(
            Arc::new(NoopQuoteStore),
            Arc::new(MockSyncStateStore {
                provider_sync_stats: vec![],
                with_errors: vec![],
                states: Arc::clone(&states),
            }),
            Arc::new(MockProviderSettingsStore { providers: vec![] }),
            Arc::new(asset_repo),
            Arc::new(NoopActivityRepository),
            Arc::new(MockSecretStore),
        )
        .await
        .unwrap();
        let current_holdings = HashMap::from([(asset_id.clone(), dec!(-1))]);

        service
            .update_position_status_from_holdings(&current_holdings)
            .await
            .unwrap();

        assert_eq!(*reactivated.lock().unwrap(), vec![asset_id.clone()]);
        let stored = states.lock().unwrap().get(&asset_id).cloned().unwrap();
        assert!(stored.is_active);
        assert!(stored.position_closed_date.is_none());
    }

    #[tokio::test]
    async fn test_update_position_status_reopens_existing_sync_state() {
        let asset_id = "asset_1".to_string();
        let now = Utc::now();
        let asset = Asset {
            id: asset_id.clone(),
            kind: AssetKind::Investment,
            quote_mode: QuoteMode::Market,
            is_active: true,
            ..Default::default()
        };
        let closed_state = QuoteSyncState {
            asset_id: asset_id.clone(),
            is_active: false,
            position_closed_date: Some(NaiveDate::from_ymd_opt(2026, 1, 1).unwrap()),
            last_synced_at: Some(now),
            data_source: "YAHOO".to_string(),
            sync_priority: 50,
            error_count: 0,
            last_error: None,
            profile_enriched_at: None,
            created_at: now,
            updated_at: now,
        };
        let states = Arc::new(Mutex::new(HashMap::from([(
            asset_id.clone(),
            closed_state,
        )])));
        let asset_repo = PositionStatusAssetRepository {
            assets: HashMap::from([(asset_id.clone(), asset)]),
            reactivated: Arc::new(Mutex::new(Vec::new())),
            deactivated: Arc::new(Mutex::new(Vec::new())),
        };
        let service = QuoteService::new(
            Arc::new(NoopQuoteStore),
            Arc::new(MockSyncStateStore {
                provider_sync_stats: vec![],
                with_errors: vec![],
                states: Arc::clone(&states),
            }),
            Arc::new(MockProviderSettingsStore { providers: vec![] }),
            Arc::new(asset_repo),
            Arc::new(NoopActivityRepository),
            Arc::new(MockSecretStore),
        )
        .await
        .unwrap();
        let current_holdings = HashMap::from([(asset_id.clone(), dec!(1))]);

        service
            .update_position_status_from_holdings(&current_holdings)
            .await
            .unwrap();

        let stored = states.lock().unwrap().get(&asset_id).cloned().unwrap();
        assert!(stored.is_active);
        assert!(stored.position_closed_date.is_none());
        assert_eq!(
            stored.sync_priority,
            SyncCategory::Active.default_priority()
        );
    }

    #[tokio::test]
    async fn test_update_position_status_closes_sync_state_without_deactivating_asset() {
        let asset_id = "asset_1".to_string();
        let now = Utc::now();
        let asset = Asset {
            id: asset_id.clone(),
            kind: AssetKind::Investment,
            quote_mode: QuoteMode::Market,
            is_active: true,
            ..Default::default()
        };
        let active_state = QuoteSyncState {
            asset_id: asset_id.clone(),
            is_active: true,
            position_closed_date: None,
            last_synced_at: Some(now),
            data_source: "YAHOO".to_string(),
            sync_priority: SyncCategory::Active.default_priority(),
            error_count: 0,
            last_error: None,
            profile_enriched_at: None,
            created_at: now,
            updated_at: now,
        };
        let states = Arc::new(Mutex::new(HashMap::from([(
            asset_id.clone(),
            active_state,
        )])));
        let deactivated = Arc::new(Mutex::new(Vec::new()));
        let asset_repo = PositionStatusAssetRepository {
            assets: HashMap::from([(asset_id.clone(), asset)]),
            reactivated: Arc::new(Mutex::new(Vec::new())),
            deactivated: Arc::clone(&deactivated),
        };
        let service = QuoteService::new(
            Arc::new(NoopQuoteStore),
            Arc::new(MockSyncStateStore {
                provider_sync_stats: vec![],
                with_errors: vec![],
                states: Arc::clone(&states),
            }),
            Arc::new(MockProviderSettingsStore { providers: vec![] }),
            Arc::new(asset_repo),
            Arc::new(NoopActivityRepository),
            Arc::new(MockSecretStore),
        )
        .await
        .unwrap();

        service
            .update_position_status_from_holdings(&HashMap::new())
            .await
            .unwrap();

        let stored = states.lock().unwrap().get(&asset_id).cloned().unwrap();
        assert!(!stored.is_active);
        assert!(stored.position_closed_date.is_some());
        assert!(deactivated.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_latest_quote_snapshot_deduplicates_requested_asset_ids() -> Result<()> {
        let asset_id = "asset_1".to_string();
        let quote = Quote {
            id: "quote_1".to_string(),
            asset_id: asset_id.clone(),
            timestamp: Utc::now(),
            open: dec!(42),
            high: dec!(42),
            low: dec!(42),
            close: dec!(42),
            adjclose: dec!(42),
            volume: dec!(0),
            currency: "USD".to_string(),
            data_source: "YAHOO".to_string(),
            created_at: Utc::now(),
            notes: None,
        };
        let requested_latest_quotes = Arc::new(Mutex::new(Vec::new()));
        let service = QuoteService::new(
            Arc::new(SnapshotQuoteStore {
                quotes: HashMap::from([(asset_id.clone(), quote)]),
                requested_latest_quotes: requested_latest_quotes.clone(),
            }),
            Arc::new(MockSyncStateStore {
                provider_sync_stats: vec![],
                with_errors: vec![],
                states: Arc::new(Mutex::new(HashMap::new())),
            }),
            Arc::new(MockProviderSettingsStore { providers: vec![] }),
            Arc::new(NoopAssetRepository),
            Arc::new(NoopActivityRepository),
            Arc::new(MockSecretStore),
        )
        .await?;

        let snapshots =
            service.get_latest_quotes_snapshot(&[asset_id.clone(), asset_id.clone()])?;

        assert_eq!(
            *requested_latest_quotes.lock().unwrap(),
            vec![vec![asset_id.clone()]]
        );
        assert_eq!(snapshots.len(), 1);
        let snapshot = snapshots.get(&asset_id).expect("snapshot should exist");
        assert_eq!(
            snapshot.quote.as_ref().map(|quote| quote.id.as_str()),
            Some("quote_1")
        );
        assert!(snapshot.no_quote_reason.is_none());
        Ok(())
    }

    #[test]
    fn test_no_quote_reason_reports_error_cooldown() {
        type TestQuoteService = QuoteService<
            NoopQuoteStore,
            MockSyncStateStore,
            MockProviderSettingsStore,
            NoopAssetRepository,
            NoopActivityRepository,
        >;

        let now = Utc::now();
        let asset = Asset {
            id: "asset_1".to_string(),
            quote_mode: QuoteMode::Market,
            is_active: true,
            ..Default::default()
        };
        let state = QuoteSyncState {
            asset_id: asset.id.clone(),
            is_active: true,
            position_closed_date: None,
            last_synced_at: Some(now),
            data_source: "YAHOO".to_string(),
            sync_priority: 100,
            error_count: MAX_SYNC_ERRORS,
            last_error: Some("provider failed".to_string()),
            profile_enriched_at: Some(now),
            created_at: now,
            updated_at: now,
        };

        let reason = TestQuoteService::no_quote_reason(Some(&asset), Some(&state));

        assert_eq!(reason.code, "TOO_MANY_ERRORS");
        assert_eq!(reason.message, "Sync paused after repeated errors");
    }

    #[test]
    fn test_no_quote_reason_prefers_manual_pricing() {
        type TestQuoteService = QuoteService<
            NoopQuoteStore,
            MockSyncStateStore,
            MockProviderSettingsStore,
            NoopAssetRepository,
            NoopActivityRepository,
        >;

        let asset = Asset {
            id: "asset_1".to_string(),
            quote_mode: QuoteMode::Manual,
            is_active: true,
            ..Default::default()
        };

        let reason = TestQuoteService::no_quote_reason(Some(&asset), None);

        assert_eq!(reason.code, "MANUAL_PRICING");
        assert_eq!(reason.message, "Quote mode is Manual");
    }

    #[test]
    fn test_no_quote_reason_reports_expired_option() {
        type TestQuoteService = QuoteService<
            NoopQuoteStore,
            MockSyncStateStore,
            MockProviderSettingsStore,
            NoopAssetRepository,
            NoopActivityRepository,
        >;

        let asset = Asset {
            id: "asset_1".to_string(),
            quote_mode: QuoteMode::Market,
            is_active: true,
            instrument_type: Some(InstrumentType::Option),
            metadata: Some(serde_json::json!({
                "option": crate::assets::OptionSpec {
                    underlying_asset_id: "underlying_1".to_string(),
                    expiration: NaiveDate::from_ymd_opt(2000, 1, 1).unwrap(),
                    right: "CALL".to_string(),
                    strike: dec!(100),
                    multiplier: dec!(100),
                    occ_symbol: None,
                }
            })),
            ..Default::default()
        };

        let reason = TestQuoteService::no_quote_reason(Some(&asset), None);

        assert_eq!(reason.code, "EXPIRED_OPTION");
        assert_eq!(reason.message, "Option has expired");
    }

    #[test]
    fn test_no_quote_reason_reports_inactive_asset() {
        type TestQuoteService = QuoteService<
            NoopQuoteStore,
            MockSyncStateStore,
            MockProviderSettingsStore,
            NoopAssetRepository,
            NoopActivityRepository,
        >;

        let asset = Asset {
            id: "asset_1".to_string(),
            quote_mode: QuoteMode::Market,
            is_active: false,
            ..Default::default()
        };

        let reason = TestQuoteService::no_quote_reason(Some(&asset), None);

        assert_eq!(reason.code, "INACTIVE");
        assert_eq!(reason.message, "Asset is inactive");
    }

    #[test]
    fn test_no_quote_reason_reports_matured_bond() {
        type TestQuoteService = QuoteService<
            NoopQuoteStore,
            MockSyncStateStore,
            MockProviderSettingsStore,
            NoopAssetRepository,
            NoopActivityRepository,
        >;

        let asset = Asset {
            id: "asset_1".to_string(),
            quote_mode: QuoteMode::Market,
            is_active: true,
            instrument_type: Some(InstrumentType::Bond),
            metadata: Some(serde_json::json!({
                "bond": crate::assets::BondSpec {
                    maturity_date: Some(NaiveDate::from_ymd_opt(2000, 1, 1).unwrap()),
                    coupon_rate: None,
                    face_value: None,
                    coupon_frequency: None,
                    isin: None,
                }
            })),
            ..Default::default()
        };

        let reason = TestQuoteService::no_quote_reason(Some(&asset), None);

        assert_eq!(reason.code, "MATURED_BOND");
        assert_eq!(reason.message, "Bond has matured");
    }

    #[test]
    fn test_no_quote_reason_reports_last_error_below_threshold() {
        type TestQuoteService = QuoteService<
            NoopQuoteStore,
            MockSyncStateStore,
            MockProviderSettingsStore,
            NoopAssetRepository,
            NoopActivityRepository,
        >;

        let now = Utc::now();
        let asset = Asset {
            id: "asset_1".to_string(),
            quote_mode: QuoteMode::Market,
            is_active: true,
            ..Default::default()
        };
        let state = QuoteSyncState {
            asset_id: asset.id.clone(),
            is_active: true,
            position_closed_date: None,
            last_synced_at: Some(now),
            data_source: "YAHOO".to_string(),
            sync_priority: 100,
            error_count: 1,
            last_error: Some("symbol not found".to_string()),
            profile_enriched_at: Some(now),
            created_at: now,
            updated_at: now,
        };

        let reason = TestQuoteService::no_quote_reason(Some(&asset), Some(&state));

        assert_eq!(reason.code, "LAST_ERROR");
        assert_eq!(reason.message, "Last sync error: symbol not found");
    }

    #[test]
    fn test_no_quote_reason_reports_pending_sync() {
        type TestQuoteService = QuoteService<
            NoopQuoteStore,
            MockSyncStateStore,
            MockProviderSettingsStore,
            NoopAssetRepository,
            NoopActivityRepository,
        >;

        let now = Utc::now();
        let asset = Asset {
            id: "asset_1".to_string(),
            quote_mode: QuoteMode::Market,
            is_active: true,
            ..Default::default()
        };
        let state = QuoteSyncState {
            asset_id: asset.id.clone(),
            is_active: true,
            position_closed_date: None,
            last_synced_at: None,
            data_source: "YAHOO".to_string(),
            sync_priority: 100,
            error_count: 0,
            last_error: None,
            profile_enriched_at: Some(now),
            created_at: now,
            updated_at: now,
        };

        let reason = TestQuoteService::no_quote_reason(Some(&asset), Some(&state));

        assert_eq!(reason.code, "PENDING_SYNC");
        assert_eq!(reason.message, "No provider quote has been synced yet");
    }

    #[test]
    fn test_no_quote_reason_falls_back_to_no_data() {
        type TestQuoteService = QuoteService<
            NoopQuoteStore,
            MockSyncStateStore,
            MockProviderSettingsStore,
            NoopAssetRepository,
            NoopActivityRepository,
        >;

        let reason = TestQuoteService::no_quote_reason(None, None);

        assert_eq!(reason.code, "NO_DATA");
        assert_eq!(reason.message, "No data available from provider yet");
    }

    #[test]
    fn test_resolve_effective_quote_currency_prefers_minor_unit() {
        assert_eq!(
            resolve_effective_quote_currency("GBp", "GBP").as_deref(),
            Some("GBp")
        );
        assert_eq!(
            resolve_effective_quote_currency("GBP", "GBp").as_deref(),
            Some("GBp")
        );
    }

    #[test]
    fn test_resolve_effective_quote_currency_rejects_unrelated_pairs() {
        assert_eq!(resolve_effective_quote_currency("GBP", "USD"), None);
        assert_eq!(resolve_effective_quote_currency("EUR", "GBP"), None);
    }

    #[test]
    fn test_reconcile_quote_currency_applies_asset_unit_hint() {
        let asset = Asset {
            id: "asset_1".to_string(),
            quote_ccy: "GBp".to_string(),
            quote_mode: QuoteMode::Market,
            ..Default::default()
        };

        let mut quote = Quote {
            id: "q_1".to_string(),
            created_at: Utc::now(),
            data_source: "YAHOO".to_string(),
            timestamp: Utc::now(),
            asset_id: asset.id.clone(),
            open: dec!(465),
            high: dec!(470),
            low: dec!(440),
            close: dec!(445.65),
            adjclose: dec!(445.65),
            volume: dec!(1000),
            currency: "GBP".to_string(),
            notes: None,
        };

        reconcile_quote_currency(&mut quote, &asset);
        assert_eq!(quote.currency, "GBp");
    }

    #[test]
    fn test_extract_provider_id_from_sync_error_provider_error_format() {
        let error = "Market data operation failed: Provider error: FINNHUB: Access forbidden";
        assert_eq!(extract_provider_id_from_sync_error(error), Some("FINNHUB"));
    }

    #[test]
    fn test_extract_provider_id_from_sync_error_timeout_format() {
        let error = "Market data operation failed: Timeout: ALPHA_VANTAGE";
        assert_eq!(
            extract_provider_id_from_sync_error(error),
            Some("ALPHA_VANTAGE")
        );
    }

    #[test]
    fn test_extract_provider_id_from_sync_error_unknown_format() {
        let error = "Market data operation failed: All providers failed";
        assert_eq!(extract_provider_id_from_sync_error(error), None);
    }
}
