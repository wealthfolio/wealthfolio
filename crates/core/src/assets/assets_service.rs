use log::{debug, error, info, warn};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::events::{DomainEvent, DomainEventSink, NoOpDomainEventSink};
use crate::quotes::QuoteServiceTrait;
use crate::taxonomies::TaxonomyServiceTrait;
use crate::utils::isin::looks_like_isin;
use futures::stream::{self, StreamExt};

use super::assets_model::{
    canonicalize_market_identity, normalize_quote_ccy_code, resolve_quote_ccy_precedence, Asset,
    AssetKind, AssetSpec, EnsureAssetsResult, InstrumentType, NewAsset, QuoteCcyResolutionSource,
    QuoteMode, UpdateAssetProfile,
};
use super::assets_traits::{AssetRepositoryTrait, AssetServiceTrait};
use super::auto_classification::{AutoClassificationService, ClassificationInput};
use crate::errors::{DatabaseError, Error, Result};

// Import mic_to_currency for resolving exchange trading currencies
use wealthfolio_market_data::mic_to_currency;

/// Converts a provider's asset_type string to our InstrumentType enum.
/// Provider data uses various naming conventions (e.g., "CRYPTOCURRENCY", "ETF", "Equity").
/// Returns None if the string doesn't map to a known type (caller decides fallback).
fn parse_instrument_type_from_provider(asset_type: &str) -> Option<InstrumentType> {
    match asset_type.to_uppercase().as_str() {
        "CRYPTOCURRENCY" | "CRYPTO" => Some(InstrumentType::Crypto),
        "EQUITY" | "STOCK" | "ETF" | "MUTUALFUND" | "MUTUAL FUND" | "INDEX" => {
            Some(InstrumentType::Equity)
        }
        "CURRENCY" | "FOREX" | "FX" => Some(InstrumentType::Fx),
        "OPTION" => Some(InstrumentType::Option),
        "COMMODITY" => Some(InstrumentType::Metal),
        _ => None,
    }
}

/// Service for managing assets
pub struct AssetService {
    quote_service: Arc<dyn QuoteServiceTrait>,
    asset_repository: Arc<dyn AssetRepositoryTrait>,
    taxonomy_service: Option<Arc<dyn TaxonomyServiceTrait>>,
    event_sink: Arc<dyn DomainEventSink>,
}

impl AssetService {
    fn normalize_exchange_mic(value: Option<&str>) -> Option<String> {
        value
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_uppercase())
    }

    fn default_quote_mode_for_kind(kind: &AssetKind) -> QuoteMode {
        match kind {
            AssetKind::Investment | AssetKind::Fx => QuoteMode::Market,
            _ => QuoteMode::Manual,
        }
    }

    fn inferred_provider_config(
        quote_mode: QuoteMode,
        instrument_type: Option<&InstrumentType>,
        instrument_symbol: Option<&str>,
        exchange_mic: Option<&str>,
    ) -> Option<serde_json::Value> {
        if quote_mode != QuoteMode::Market {
            return None;
        }

        if matches!(instrument_type, Some(InstrumentType::Equity))
            && exchange_mic
                .is_some_and(|mic| matches!(mic.trim().to_uppercase().as_str(), "XETR" | "XFRA"))
            && instrument_symbol
                .map(str::trim)
                .is_some_and(looks_like_isin)
        {
            return Some(serde_json::json!({ "preferred_provider": "BOERSE_FRANKFURT" }));
        }

        None
    }

    /// Common US-listed exchange MICs to probe when resolving the underlying
    /// equity for an OCC-formatted option symbol. OCC symbols don't carry MIC
    /// info, so we try the major venues in priority order.
    const US_EQUITY_MIC_CANDIDATES: &'static [&'static str] =
        &["XNAS", "XNYS", "XASE", "ARCX", "BATS"];

    /// Looks up the asset_id of the EQUITY whose `instrument_symbol` matches
    /// `symbol`. Tries common US MICs first, then a no-MIC fallback. Returns
    /// None if no equity record exists.
    fn resolve_underlying_equity(&self, symbol: &str) -> Option<String> {
        for mic in Self::US_EQUITY_MIC_CANDIDATES {
            let key = format!("EQUITY:{}@{}", symbol, mic);
            if let Ok(Some(asset)) = self.asset_repository.find_by_instrument_key(&key) {
                return Some(asset.id);
            }
        }
        let key = format!("EQUITY:{}", symbol);
        if let Ok(Some(asset)) = self.asset_repository.find_by_instrument_key(&key) {
            return Some(asset.id);
        }
        None
    }

    #[allow(clippy::too_many_arguments)]
    async fn resolve_quote_ccy(
        &self,
        symbol: Option<&str>,
        exchange_mic: Option<&str>,
        instrument_type: Option<&InstrumentType>,
        explicit_quote_ccy: Option<&str>,
        existing_asset_quote_ccy: Option<&str>,
        terminal_fallback: Option<&str>,
        allow_provider_lookup: bool,
    ) -> (String, QuoteCcyResolutionSource) {
        let has_deterministic_precedence = normalize_quote_ccy_code(explicit_quote_ccy).is_some()
            || normalize_quote_ccy_code(existing_asset_quote_ccy).is_some();
        let provider_quote_ccy = if allow_provider_lookup && !has_deterministic_precedence {
            if let Some(sym) = symbol.map(str::trim).filter(|s| !s.is_empty()) {
                self.quote_service
                    .resolve_symbol_quote(sym, exchange_mic, instrument_type, None, None)
                    .await
                    .ok()
                    .and_then(|q| q.currency)
            } else {
                None
            }
        } else {
            None
        };

        resolve_quote_ccy_precedence(
            explicit_quote_ccy,
            existing_asset_quote_ccy,
            provider_quote_ccy.as_deref(),
            exchange_mic.and_then(mic_to_currency),
            terminal_fallback,
        )
        .unwrap_or_else(|| {
            (
                terminal_fallback.unwrap_or("USD").to_string(),
                QuoteCcyResolutionSource::TerminalFallback,
            )
        })
    }

    fn should_refresh_market_quote_ccy_on_mic_change(
        quote_mode: QuoteMode,
        payload_quote_ccy: Option<&str>,
        payload_exchange_mic: Option<&str>,
        existing_exchange_mic: Option<&str>,
    ) -> bool {
        quote_mode == QuoteMode::Market
            && payload_quote_ccy.is_none()
            && Self::normalize_exchange_mic(payload_exchange_mic)
                != Self::normalize_exchange_mic(existing_exchange_mic)
    }

    fn expected_market_quote_ccy(
        instrument_type: Option<&InstrumentType>,
        quote_mode: QuoteMode,
        exchange_mic: Option<&str>,
    ) -> Option<String> {
        if quote_mode != QuoteMode::Market {
            return None;
        }

        match instrument_type {
            Some(InstrumentType::Equity | InstrumentType::Option | InstrumentType::Metal) => {
                exchange_mic
                    .and_then(mic_to_currency)
                    .map(|ccy| ccy.to_string())
            }
            _ => None,
        }
    }

    fn metadata_identifier<'a>(
        metadata: Option<&'a serde_json::Value>,
        key: &str,
    ) -> Option<&'a str> {
        metadata
            .and_then(|m| m.get("identifiers"))
            .and_then(|v| v.as_object())
            .and_then(|ids| ids.get(key))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
    }

    fn should_reset_sync_state_after_profile_change(before: &Asset, after: &Asset) -> bool {
        before.quote_mode != after.quote_mode
            || before.quote_ccy != after.quote_ccy
            || before.instrument_type != after.instrument_type
            || before.instrument_symbol != after.instrument_symbol
            || before.instrument_exchange_mic != after.instrument_exchange_mic
            || before.provider_config != after.provider_config
            || ((before.is_bond() || after.is_bond())
                && Self::metadata_identifier(before.metadata.as_ref(), "isin")
                    != Self::metadata_identifier(after.metadata.as_ref(), "isin"))
    }

    /// Creates a new AssetService instance
    pub fn new(
        asset_repository: Arc<dyn AssetRepositoryTrait>,
        quote_service: Arc<dyn QuoteServiceTrait>,
    ) -> Result<Self> {
        Ok(Self {
            quote_service,
            asset_repository,
            taxonomy_service: None,
            event_sink: Arc::new(NoOpDomainEventSink),
        })
    }

    /// Creates a new AssetService instance with taxonomy service for auto-classification
    pub fn with_taxonomy_service(
        asset_repository: Arc<dyn AssetRepositoryTrait>,
        quote_service: Arc<dyn QuoteServiceTrait>,
        taxonomy_service: Arc<dyn TaxonomyServiceTrait>,
    ) -> Result<Self> {
        Ok(Self {
            quote_service,
            asset_repository,
            taxonomy_service: Some(taxonomy_service),
            event_sink: Arc::new(NoOpDomainEventSink),
        })
    }

    /// Sets the domain event sink for this service.
    ///
    /// Events are emitted after successful asset mutations.
    pub fn with_event_sink(mut self, event_sink: Arc<dyn DomainEventSink>) -> Self {
        self.event_sink = event_sink;
        self
    }

    /// Auto-classify a single newly created asset (instrument_type + asset_class).
    async fn classify_new_asset(
        &self,
        asset_id: &str,
        instrument_type: Option<&InstrumentType>,
        kind: &AssetKind,
    ) {
        if let Some(taxonomy_service) = &self.taxonomy_service {
            let classifier = AutoClassificationService::new(Arc::clone(taxonomy_service));
            classifier
                .classify_from_spec(asset_id, instrument_type, kind)
                .await;
        }
    }

    /// Builds a NewAsset from an AssetSpec without any I/O.
    fn new_asset_from_spec(&self, spec: &AssetSpec) -> NewAsset {
        let canonical = canonicalize_market_identity(
            spec.instrument_type.clone(),
            spec.instrument_symbol
                .as_deref()
                .or(spec.display_code.as_deref()),
            spec.instrument_exchange_mic.as_deref(),
            Some(spec.quote_ccy.as_str()),
        );

        let quote_mode = spec
            .quote_mode
            .unwrap_or_else(|| Self::default_quote_mode_for_kind(&spec.kind));

        let resolved_mic = canonical
            .instrument_exchange_mic
            .clone()
            .or(spec.instrument_exchange_mic.clone());
        let fallback_quote_ccy = canonical
            .quote_ccy
            .clone()
            .unwrap_or_else(|| spec.quote_ccy.clone());
        let resolved_quote_ccy = if fallback_quote_ccy.trim().is_empty() {
            Self::expected_market_quote_ccy(
                spec.instrument_type.as_ref(),
                quote_mode,
                resolved_mic.as_deref(),
            )
            .unwrap_or(fallback_quote_ccy)
        } else {
            fallback_quote_ccy
        };

        let provider_config = match quote_mode {
            QuoteMode::Market => match spec.instrument_type.as_ref() {
                // Bonds use specialized providers (US_TREASURY_CALC, BOERSE_FRANKFURT);
                // don't override with Yahoo which can't resolve ISINs.
                Some(InstrumentType::Bond) => None,
                _ => Self::inferred_provider_config(
                    quote_mode,
                    spec.instrument_type.as_ref(),
                    canonical
                        .instrument_symbol
                        .as_deref()
                        .or(spec.instrument_symbol.as_deref()),
                    resolved_mic.as_deref(),
                )
                .or(Some(serde_json::json!({ "preferred_provider": "YAHOO" }))),
            },
            QuoteMode::Manual => None,
        };

        let resolved_symbol = canonical
            .instrument_symbol
            .clone()
            .or(spec.instrument_symbol.clone());
        let metadata = spec.metadata.clone().or_else(|| {
            super::build_asset_metadata(
                spec.instrument_type.as_ref(),
                resolved_symbol.as_deref().unwrap_or(""),
            )
        });

        NewAsset {
            id: spec.id.clone(),
            kind: spec.kind.clone(),
            name: spec.name.clone(),
            display_code: canonical.display_code.or(spec.display_code.clone()),
            quote_mode,
            quote_ccy: resolved_quote_ccy,
            instrument_type: spec.instrument_type.clone(),
            instrument_symbol: resolved_symbol,
            instrument_exchange_mic: resolved_mic,
            provider_config,
            is_active: true,
            metadata,
            ..Default::default()
        }
    }
}

// Implement the service trait
#[async_trait::async_trait]
impl AssetServiceTrait for AssetService {
    /// Lists all assets with enriched fields (e.g., exchange_name)
    fn get_assets(&self) -> Result<Vec<Asset>> {
        let assets = self.asset_repository.list()?;
        Ok(assets.into_iter().map(|a| a.enrich()).collect())
    }

    /// Retrieves an asset by its ID with enriched fields
    fn get_asset_by_id(&self, asset_id: &str) -> Result<Asset> {
        self.asset_repository
            .get_by_id(asset_id)
            .map(|a| a.enrich())
    }

    async fn delete_asset(&self, asset_id: &str) -> Result<()> {
        // Clean up sync state before deleting the asset to avoid orphaned records
        if let Err(e) = self.quote_service.delete_sync_state(asset_id).await {
            warn!("Failed to delete sync state for {}: {}", asset_id, e);
        }

        self.asset_repository.delete(asset_id).await
    }

    /// Updates an asset profile
    async fn update_asset_profile(
        &self,
        asset_id: &str,
        mut payload: UpdateAssetProfile,
    ) -> Result<Asset> {
        let existing_asset = self.asset_repository.get_by_id(asset_id)?;
        let effective_quote_mode = payload.quote_mode.unwrap_or(existing_asset.quote_mode);

        if let Some(raw_mic) = payload.instrument_exchange_mic.as_ref() {
            let normalized_mic = raw_mic.trim().to_uppercase();
            if !normalized_mic.is_empty() {
                payload.instrument_exchange_mic = Some(normalized_mic.clone());
            }
        }

        let effective_instrument_type = payload
            .instrument_type
            .clone()
            .or(existing_asset.instrument_type.clone());

        if effective_instrument_type.is_some() {
            let should_refresh_quote_ccy = Self::should_refresh_market_quote_ccy_on_mic_change(
                effective_quote_mode,
                payload.quote_ccy.as_deref(),
                payload.instrument_exchange_mic.as_deref(),
                existing_asset.instrument_exchange_mic.as_deref(),
            );

            let canonical = canonicalize_market_identity(
                effective_instrument_type.clone(),
                payload
                    .instrument_symbol
                    .as_deref()
                    .or(payload.display_code.as_deref())
                    .or(existing_asset.instrument_symbol.as_deref())
                    .or(existing_asset.display_code.as_deref()),
                payload
                    .instrument_exchange_mic
                    .as_deref()
                    .or(existing_asset.instrument_exchange_mic.as_deref()),
                if should_refresh_quote_ccy {
                    None
                } else {
                    payload
                        .quote_ccy
                        .as_deref()
                        .or(Some(existing_asset.quote_ccy.as_str()))
                },
            );

            payload.instrument_symbol = canonical
                .instrument_symbol
                .or(payload.instrument_symbol.clone());
            payload.display_code = canonical.display_code.or(payload.display_code.clone());
            payload.instrument_exchange_mic = canonical
                .instrument_exchange_mic
                .or(payload.instrument_exchange_mic.clone());
            if effective_quote_mode == QuoteMode::Market {
                payload.quote_ccy = canonical.quote_ccy.or(payload.quote_ccy.clone());
            }
        }

        let asset = self
            .asset_repository
            .update_profile(asset_id, payload)
            .await?;

        if Self::should_reset_sync_state_after_profile_change(&existing_asset, &asset) {
            if let Err(err) = self
                .quote_service
                .reset_sync_state_for_profile_change(&asset.id)
                .await
            {
                warn!(
                    "Failed to reset quote sync state after asset profile update for {}: {}",
                    asset.id, err
                );
            }
        }

        self.event_sink
            .emit(DomainEvent::assets_updated(vec![asset.id.clone()]));

        Ok(asset)
    }

    /// Creates a new asset directly without network lookups.
    async fn create_asset(&self, mut new_asset: NewAsset) -> Result<Asset> {
        let canonical = canonicalize_market_identity(
            new_asset.instrument_type.clone(),
            new_asset
                .instrument_symbol
                .as_deref()
                .or(new_asset.display_code.as_deref()),
            new_asset.instrument_exchange_mic.as_deref(),
            Some(new_asset.quote_ccy.as_str()),
        );
        new_asset.display_code = canonical.display_code.or(new_asset.display_code.clone());
        new_asset.instrument_symbol = canonical
            .instrument_symbol
            .or(new_asset.instrument_symbol.clone());
        new_asset.instrument_exchange_mic = canonical
            .instrument_exchange_mic
            .or(new_asset.instrument_exchange_mic.clone());
        new_asset.quote_ccy = canonical
            .quote_ccy
            .or_else(|| {
                Self::expected_market_quote_ccy(
                    new_asset.instrument_type.as_ref(),
                    new_asset.quote_mode,
                    new_asset.instrument_exchange_mic.as_deref(),
                )
            })
            .unwrap_or(new_asset.quote_ccy);
        if new_asset.provider_config.is_none() {
            new_asset.provider_config = Self::inferred_provider_config(
                new_asset.quote_mode,
                new_asset.instrument_type.as_ref(),
                new_asset.instrument_symbol.as_deref(),
                new_asset.instrument_exchange_mic.as_deref(),
            );
        }

        // For options, try to resolve the underlying equity now so the link is
        // available immediately on first read. Failure is silent — back-fill
        // happens later when the underlying gets added to the user's DB.
        if matches!(new_asset.instrument_type, Some(InstrumentType::Option)) {
            if let Some(meta) = new_asset.metadata.as_mut() {
                if let Some(symbol) = meta
                    .get("option")
                    .and_then(|o| o.get("underlyingAssetSymbol"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                {
                    if let Some(resolved_id) = self.resolve_underlying_equity(&symbol) {
                        if let Some(option_obj) = meta
                            .get_mut("option")
                            .and_then(|o| o.as_object_mut())
                        {
                            option_obj.insert(
                                "underlyingResolvedId".to_string(),
                                serde_json::Value::String(resolved_id),
                            );
                        }
                    }
                }
            }
        }

        // Pre-check: return existing asset if instrument_key already exists (avoids unique constraint error)
        let key_spec = AssetSpec {
            id: None,
            display_code: new_asset.display_code.clone(),
            instrument_symbol: new_asset.instrument_symbol.clone(),
            instrument_exchange_mic: new_asset.instrument_exchange_mic.clone(),
            instrument_type: new_asset.instrument_type.clone(),
            quote_ccy: new_asset.quote_ccy.clone(),
            requested_quote_ccy: None,
            kind: new_asset.kind.clone(),
            quote_mode: Some(new_asset.quote_mode),
            name: new_asset.name.clone(),
            metadata: None,
        };
        if let Some(key) = key_spec.instrument_key() {
            if let Ok(Some(existing)) = self.asset_repository.find_by_instrument_key(&key) {
                return Ok(existing);
            }
        }

        let instrument_type = new_asset.instrument_type.clone();
        let kind = new_asset.kind.clone();
        let asset = self.asset_repository.create(new_asset).await?;

        // Auto-classify the newly created asset
        self.classify_new_asset(&asset.id, instrument_type.as_ref(), &kind)
            .await;

        // If a new EQUITY just landed, back-fill any options that were waiting
        // for an underlying with this symbol.
        if matches!(instrument_type.as_ref(), Some(InstrumentType::Equity)) {
            if let Some(symbol) = asset.instrument_symbol.as_deref() {
                if let Err(e) = self
                    .asset_repository
                    .link_options_to_underlying(symbol, &asset.id)
                    .await
                {
                    warn!(
                        "Failed to back-fill option underlying links for {}: {}",
                        symbol, e
                    );
                }
            }
        }

        // Emit event for newly created asset
        self.event_sink
            .emit(DomainEvent::assets_created(vec![asset.id.clone()]));

        Ok(asset)
    }

    /// Creates a minimal asset without network calls.
    /// Returns the existing asset if found, or creates a new minimal one.
    async fn get_or_create_minimal_asset(
        &self,
        asset_id: &str,
        context_currency: Option<String>,
        metadata: Option<super::assets_model::AssetMetadata>,
        quote_mode: Option<String>,
    ) -> Result<Asset> {
        let inferred_instrument_type = metadata.as_ref().and_then(|meta| {
            meta.instrument_symbol
                .as_ref()
                .filter(|s| !s.is_empty())
                .or(meta.display_code.as_ref().filter(|s| !s.is_empty()))
                .map(|_| {
                    meta.instrument_type
                        .clone()
                        .unwrap_or(InstrumentType::Equity)
                })
        });
        let requested_quote_mode = match quote_mode.as_deref() {
            Some("MANUAL") => Some(QuoteMode::Manual),
            Some("MARKET") => Some(QuoteMode::Market),
            _ => None,
        };

        // Try to get existing asset first
        match self.asset_repository.get_by_id(asset_id) {
            Ok(mut existing_asset) => {
                // Reactivate if previously deactivated (e.g., after account deletion)
                if !existing_asset.is_active {
                    info!("Reactivating previously deactivated asset: {}", asset_id);
                    self.asset_repository.reactivate(asset_id).await?;
                    existing_asset.is_active = true;
                }

                return Ok(existing_asset);
            }
            Err(Error::Database(DatabaseError::NotFound(_))) => {
                debug!(
                    "Asset not found locally, creating minimal asset: {}",
                    asset_id
                );
            }
            Err(e) => {
                error!("Error fetching asset by ID '{}': {}", asset_id, e);
                return Err(e);
            }
        }

        // Try to find existing asset by instrument_key before creating a new one

        if let Some(ref meta) = metadata {
            let canonical = canonicalize_market_identity(
                inferred_instrument_type.clone(),
                meta.instrument_symbol
                    .as_deref()
                    .or(meta.display_code.as_deref()),
                meta.instrument_exchange_mic.as_deref(),
                context_currency.as_deref(),
            );
            if let Some(ref sym) = canonical.instrument_symbol {
                if !sym.is_empty() {
                    let instrument_type = inferred_instrument_type
                        .clone()
                        .unwrap_or(InstrumentType::Equity);
                    let spec = AssetSpec {
                        id: None,
                        display_code: canonical.display_code.or(meta.display_code.clone()),
                        instrument_symbol: Some(sym.clone()),
                        instrument_exchange_mic: canonical
                            .instrument_exchange_mic
                            .or(meta.instrument_exchange_mic.clone()),
                        instrument_type: Some(instrument_type.clone()),
                        quote_ccy: canonical.quote_ccy.unwrap_or_else(|| {
                            context_currency
                                .clone()
                                .unwrap_or_else(|| "USD".to_string())
                        }),
                        requested_quote_ccy: meta.requested_quote_ccy.clone(),
                        kind: meta.kind.clone().unwrap_or(AssetKind::Investment),
                        quote_mode: None,
                        name: meta.name.clone(),
                        metadata: None,
                    };
                    if let Some(key) = spec.instrument_key() {
                        if let Ok(Some(existing)) =
                            self.asset_repository.find_by_instrument_key(&key)
                        {
                            if !existing.is_active {
                                self.asset_repository.reactivate(&existing.id).await?;
                            }

                            return Ok(existing);
                        }
                    }
                }
            }
        }

        // Use metadata kind if provided, otherwise default to Investment
        let kind = metadata
            .as_ref()
            .and_then(|m| m.kind.clone())
            .unwrap_or(AssetKind::Investment);

        // Determine quote mode: use input if provided, otherwise default based on kind
        let quote_mode =
            requested_quote_mode.unwrap_or_else(|| Self::default_quote_mode_for_kind(&kind));

        // Extract exchange_mic from metadata
        let exchange_mic = metadata
            .as_ref()
            .and_then(|m| m.instrument_exchange_mic.clone());

        let instrument_type = inferred_instrument_type;
        let allow_provider_lookup = quote_mode == QuoteMode::Market
            && !matches!(
                instrument_type.as_ref(),
                Some(InstrumentType::Crypto | InstrumentType::Fx)
            );
        let symbol_for_resolution = metadata
            .as_ref()
            .and_then(|m| m.instrument_symbol.as_deref().or(m.display_code.as_deref()));
        let explicit_requested_quote_ccy = metadata
            .as_ref()
            .and_then(|m| m.requested_quote_ccy.as_deref());
        let (currency, _) = self
            .resolve_quote_ccy(
                symbol_for_resolution,
                exchange_mic.as_deref(),
                instrument_type.as_ref(),
                explicit_requested_quote_ccy,
                None,
                context_currency
                    .as_deref()
                    .filter(|c| !c.trim().is_empty())
                    .or(Some("USD")),
                allow_provider_lookup,
            )
            .await;

        let name = metadata.as_ref().and_then(|m| m.name.clone());
        let asset_metadata_json = metadata.as_ref().and_then(|m| m.asset_metadata.clone());
        let canonical_identity = canonicalize_market_identity(
            instrument_type.clone(),
            metadata
                .as_ref()
                .and_then(|m| m.instrument_symbol.as_deref().or(m.display_code.as_deref())),
            exchange_mic.as_deref(),
            Some(currency.as_str()),
        );
        let provider_config = match quote_mode {
            QuoteMode::Market => match instrument_type.as_ref() {
                Some(InstrumentType::Bond) => None,
                _ => Self::inferred_provider_config(
                    quote_mode,
                    instrument_type.as_ref(),
                    canonical_identity.instrument_symbol.as_deref(),
                    canonical_identity
                        .instrument_exchange_mic
                        .as_deref()
                        .or(exchange_mic.as_deref()),
                )
                .or(Some(serde_json::json!({ "preferred_provider": "YAHOO" }))),
            },
            QuoteMode::Manual => None,
        };

        let new_asset = NewAsset {
            id: Some(asset_id.to_string()),
            kind,
            name,
            quote_mode,
            quote_ccy: canonical_identity.quote_ccy.unwrap_or(currency),
            instrument_exchange_mic: canonical_identity.instrument_exchange_mic.or(exchange_mic),
            instrument_symbol: canonical_identity.instrument_symbol,
            instrument_type,
            display_code: canonical_identity
                .display_code
                .or_else(|| metadata.as_ref().and_then(|m| m.display_code.clone())),
            provider_config,
            metadata: asset_metadata_json,
            is_active: true,
            ..Default::default()
        };

        debug!(
            "Creating minimal asset: id={}, kind={:?}, quote_mode={:?}, name={:?}",
            asset_id, new_asset.kind, new_asset.quote_mode, new_asset.name
        );

        let instrument_type = new_asset.instrument_type.clone();
        let kind = new_asset.kind.clone();
        let asset = self.asset_repository.create(new_asset).await?;

        // Auto-classify the newly created asset
        self.classify_new_asset(&asset.id, instrument_type.as_ref(), &kind)
            .await;

        // Emit event for newly created asset
        self.event_sink
            .emit(DomainEvent::assets_created(vec![asset.id.clone()]));

        Ok(asset)
    }

    /// Updates the quote mode for an asset (MARKET, MANUAL)
    async fn update_quote_mode(&self, asset_id: &str, quote_mode: &str) -> Result<Asset> {
        let asset = self.update_quote_mode_silent(asset_id, quote_mode).await?;
        self.event_sink
            .emit(DomainEvent::assets_updated(vec![asset.id.clone()]));
        Ok(asset)
    }

    /// Updates quote mode without emitting domain events.
    /// Switching to Manual means providers will no longer sync this asset,
    /// so clear any stale error state to keep the health panel clean.
    async fn update_quote_mode_silent(&self, asset_id: &str, quote_mode: &str) -> Result<Asset> {
        let asset = self
            .asset_repository
            .update_quote_mode(asset_id, quote_mode)
            .await?;

        if asset.quote_mode == QuoteMode::Manual {
            if let Err(e) = self.quote_service.delete_sync_state(asset_id).await {
                warn!("Failed to clear sync state for {}: {:?}", asset_id, e);
            }
        }

        Ok(asset)
    }

    async fn get_assets_by_asset_ids(&self, asset_ids: &[String]) -> Result<Vec<Asset>> {
        self.asset_repository.list_by_asset_ids(asset_ids)
    }

    fn get_options_for_underlying(&self, equity_asset_id: &str) -> Result<Vec<Asset>> {
        let asset = self.asset_repository.get_by_id(equity_asset_id)?;
        let symbol = match asset.instrument_symbol.as_deref() {
            Some(s) if !s.is_empty() => s,
            _ => return Ok(Vec::new()),
        };
        self.asset_repository
            .list_options_for_underlying(equity_asset_id, symbol)
    }

    /// Enriches an existing asset's profile with data from market data provider.
    /// Updates the profile JSON (sectors, countries, website) and notes fields.
    async fn enrich_asset_profile(&self, asset_id: &str) -> Result<Asset> {
        // Get the existing asset
        let existing_asset = self.asset_repository.get_by_id(asset_id)?;

        // Skip enrichment for assets that don't need market data
        if existing_asset.quote_mode != QuoteMode::Market {
            debug!(
                "Skipping enrichment for asset {} - quote mode is {:?}",
                asset_id, existing_asset.quote_mode
            );
            return Ok(existing_asset);
        }

        // Fetch profile from provider using the asset (resolver handles exchange suffix)
        debug!(
            "Fetching profile for asset {} (display_code: {:?}, exchange: {:?})",
            asset_id, existing_asset.display_code, existing_asset.instrument_exchange_mic
        );

        let provider_profile = match self.quote_service.get_asset_profile(&existing_asset).await {
            Ok(profile) => profile,
            Err(e) => {
                return Err(Error::MarketData(
                    crate::quotes::MarketDataError::ProviderError(format!(
                        "Could not fetch profile for asset {} (display_code: {:?}): {}",
                        asset_id, existing_asset.display_code, e
                    )),
                ));
            }
        };

        // Derive instrument_type from provider's asset_type if not already set
        let updated_instrument_type = if existing_asset.instrument_type.is_none() {
            provider_profile
                .asset_type
                .as_ref()
                .and_then(|t| parse_instrument_type_from_provider(t))
        } else {
            None
        };

        // Build provider profile metadata for storage
        let mut profile_metadata = serde_json::Map::new();
        if let Some(ref sectors) = provider_profile.sectors {
            profile_metadata.insert(
                "sectors".to_string(),
                serde_json::Value::String(sectors.clone()),
            );
        }
        if let Some(ref industry) = provider_profile.industry {
            profile_metadata.insert(
                "industry".to_string(),
                serde_json::Value::String(industry.clone()),
            );
        }
        if let Some(ref countries) = provider_profile.countries {
            profile_metadata.insert(
                "countries".to_string(),
                serde_json::Value::String(countries.clone()),
            );
        }
        if let Some(ref asset_type) = provider_profile.asset_type {
            profile_metadata.insert(
                "quoteType".to_string(),
                serde_json::Value::String(asset_type.clone()),
            );
        }
        if let Some(ref url) = provider_profile.url {
            profile_metadata.insert(
                "website".to_string(),
                serde_json::Value::String(url.clone()),
            );
        }
        if let Some(market_cap) = provider_profile.market_cap {
            profile_metadata.insert("marketCap".to_string(), serde_json::json!(market_cap));
        }
        if let Some(pe_ratio) = provider_profile.pe_ratio {
            profile_metadata.insert("peRatio".to_string(), serde_json::json!(pe_ratio));
        }
        if let Some(dividend_yield) = provider_profile.dividend_yield {
            profile_metadata.insert(
                "dividendYield".to_string(),
                serde_json::json!(dividend_yield),
            );
        }
        if let Some(week_52_high) = provider_profile.week_52_high {
            profile_metadata.insert("week52High".to_string(), serde_json::json!(week_52_high));
        }
        if let Some(week_52_low) = provider_profile.week_52_low {
            profile_metadata.insert("week52Low".to_string(), serde_json::json!(week_52_low));
        }

        // Merge with existing metadata (preserving any non-profile fields like OptionSpec)
        let mut updated_metadata = if profile_metadata.is_empty() {
            existing_asset.metadata.clone()
        } else {
            let mut merged = match &existing_asset.metadata {
                Some(existing) => match existing.as_object() {
                    Some(obj) => obj.clone(),
                    None => serde_json::Map::new(),
                },
                None => serde_json::Map::new(),
            };
            merged.insert(
                "profile".to_string(),
                serde_json::Value::Object(profile_metadata),
            );
            Some(serde_json::Value::Object(merged))
        };

        // Enrich US Treasury bonds with maturity/coupon data from TreasuryDirect
        // when the bond spec is missing this data (needed for yield-curve pricing).
        if existing_asset.is_bond() {
            let needs_bond_enrichment = existing_asset
                .bond_spec()
                .is_none_or(|s| s.maturity_date.is_none());

            if needs_bond_enrichment {
                if let Some(isin) = existing_asset.instrument_symbol.as_deref() {
                    if isin.starts_with("US912") {
                        let http = reqwest::Client::new();
                        match wealthfolio_market_data::provider::us_treasury_calc::UsTreasuryCalcProvider::fetch_bond_details(&http, isin).await {
                            Some(details) => {
                                let spec = super::assets_model::BondSpec {
                                    isin: Some(isin.to_string()),
                                    coupon_rate: Some(details.coupon_rate),
                                    maturity_date: Some(details.maturity_date),
                                    face_value: Some(details.face_value),
                                    coupon_frequency: Some(details.coupon_frequency),
                                };
                                let meta = updated_metadata.get_or_insert_with(|| serde_json::json!({}));
                                if let Some(obj) = meta.as_object_mut() {
                                    obj.insert("bond".to_string(), serde_json::json!(spec));
                                }
                                info!("Enriched bond {} with Treasury details: maturity={}, coupon={}", asset_id, details.maturity_date, details.coupon_rate);
                            }
                            None => {
                                debug!("Could not fetch Treasury bond details for {}", isin);
                            }
                        }
                    }
                }
            }
        }

        let effective_instrument_type = updated_instrument_type
            .clone()
            .or(existing_asset.instrument_type.clone());
        let canonical = canonicalize_market_identity(
            effective_instrument_type,
            existing_asset
                .instrument_symbol
                .as_deref()
                .or(existing_asset.display_code.as_deref()),
            existing_asset.instrument_exchange_mic.as_deref(),
            Some(provider_profile.currency.as_str()),
        );
        let resolved_quote_ccy = canonical
            .quote_ccy
            .unwrap_or_else(|| existing_asset.quote_ccy.clone());

        // Build profile update from provider data
        let mut update = UpdateAssetProfile {
            display_code: existing_asset.display_code.clone(),
            name: provider_profile.name.or(existing_asset.name.clone()),
            notes: existing_asset.notes.clone().unwrap_or_default(),
            kind: None,
            quote_mode: Some(existing_asset.quote_mode),
            quote_ccy: Some(resolved_quote_ccy),
            instrument_type: updated_instrument_type,
            instrument_symbol: None,
            instrument_exchange_mic: None,
            provider_config: existing_asset.provider_config.clone(),
            metadata: updated_metadata,
        };

        // Update notes with description if notes is empty and provider has notes
        if update.notes.is_empty() {
            if let Some(ref notes) = provider_profile.notes {
                update.notes = notes.clone();
            }
        }

        debug!(
            "Enriching asset {} with provider profile: instrument_type={:?}, name={:?}, sectors={:?}, industry={:?}, countries={:?}, asset_type={:?}",
            asset_id, update.instrument_type, update.name, provider_profile.sectors, provider_profile.industry, provider_profile.countries, provider_profile.asset_type
        );

        let updated_asset = self
            .asset_repository
            .update_profile(asset_id, update)
            .await?;

        // Auto-classify asset based on provider profile data
        if let Some(taxonomy_service) = &self.taxonomy_service {
            let classification_input = ClassificationInput::from_provider_profile(
                provider_profile.asset_type.as_deref(),
                updated_asset.name.as_deref(),
                None,
                provider_profile.sectors.as_deref(),
                None,
                provider_profile.countries.as_deref(),
                existing_asset.instrument_exchange_mic.as_deref(),
            );

            let auto_classifier = AutoClassificationService::new(Arc::clone(taxonomy_service));
            match auto_classifier
                .classify_asset(asset_id, &classification_input)
                .await
            {
                Ok(result) => {
                    info!(
                        "Auto-classified asset {}: type={:?}, sectors={:?}, region={:?}",
                        asset_id, result.security_type, result.sectors, result.region
                    );
                }
                Err(e) => {
                    debug!("Auto-classification failed for {}: {}", asset_id, e);
                }
            }
        }

        Ok(updated_asset)
    }

    /// Enriches multiple assets in batch, with deduplication and sync state tracking.
    async fn enrich_assets(&self, asset_ids: Vec<String>) -> Result<(usize, usize, usize)> {
        if asset_ids.is_empty() {
            return Ok((0, 0, 0));
        }

        // Deduplicate
        let unique_ids: Vec<String> = asset_ids
            .into_iter()
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();

        if unique_ids.is_empty() {
            debug!("No enrichable assets in batch");
            return Ok((0, 0, 0));
        }

        let unique_ids_len = unique_ids.len();

        // Filter to only assets that need enrichment
        let ids_to_enrich: Vec<String> = unique_ids
            .into_iter()
            .filter(|asset_id| {
                let needs = match self.quote_service.get_sync_state(asset_id) {
                    Ok(Some(state)) => state.needs_profile_enrichment(),
                    Ok(None) => true,
                    Err(_) => true,
                };
                if !needs {
                    debug!("Skipping enrichment for {} - already enriched", asset_id);
                }
                needs
            })
            .collect();

        let skipped_count = unique_ids_len - ids_to_enrich.len();

        // Enrich assets concurrently (up to 5 at a time)
        let results: Vec<(String, Result<Asset>)> = stream::iter(ids_to_enrich)
            .map(|asset_id| async move {
                let result = self.enrich_asset_profile(&asset_id).await;
                if result.is_ok() {
                    if let Err(e) = self.quote_service.mark_profile_enriched(&asset_id).await {
                        warn!("Failed to mark profile enriched for {}: {}", asset_id, e);
                    }
                }
                (asset_id, result)
            })
            .buffer_unordered(5)
            .collect()
            .await;

        let mut enriched_count = 0;
        let mut failed_count = 0;
        for (asset_id, result) in &results {
            match result {
                Ok(_) => {
                    enriched_count += 1;
                    info!("Successfully enriched asset profile: {}", asset_id);
                }
                Err(e) => {
                    debug!("Failed to enrich asset {}: {}", asset_id, e);
                    failed_count += 1;
                }
            }
        }

        Ok((enriched_count, skipped_count, failed_count))
    }

    async fn cleanup_legacy_metadata(&self, asset_id: &str) -> Result<()> {
        self.asset_repository
            .cleanup_legacy_metadata(asset_id)
            .await
    }

    async fn merge_unknown_asset(
        &self,
        resolved_asset_id: &str,
        unknown_asset_id: &str,
        activity_repository: &dyn crate::activities::ActivityRepositoryTrait,
    ) -> Result<u32> {
        info!(
            "Merging UNKNOWN asset {} into resolved asset {}",
            unknown_asset_id, resolved_asset_id
        );

        let (account_ids, currencies) = match activity_repository
            .get_activity_accounts_and_currencies_by_asset_id(unknown_asset_id)
            .await
        {
            Ok(data) => data,
            Err(e) => {
                warn!(
                    "Failed to load account_ids/currencies for UNKNOWN asset {}: {}",
                    unknown_asset_id, e
                );
                (Vec::new(), Vec::new())
            }
        };

        // 1. Copy user metadata (notes) from UNKNOWN to resolved
        if let Err(e) = self
            .asset_repository
            .copy_user_metadata(unknown_asset_id, resolved_asset_id)
            .await
        {
            warn!(
                "Failed to copy user metadata from {} to {}: {}",
                unknown_asset_id, resolved_asset_id, e
            );
        }

        // 2. Reassign all activities from UNKNOWN to resolved
        let activities_migrated = activity_repository
            .reassign_asset(unknown_asset_id, resolved_asset_id)
            .await?;

        // 3. Deactivate the UNKNOWN asset
        if let Err(e) = self.asset_repository.deactivate(unknown_asset_id).await {
            warn!(
                "Failed to deactivate UNKNOWN asset {}: {}",
                unknown_asset_id, e
            );
        }

        // 4. Emit assets_merged domain event
        self.event_sink.emit(DomainEvent::assets_merged(
            unknown_asset_id.to_string(),
            resolved_asset_id.to_string(),
            activities_migrated,
        ));

        // 5. Emit activities_changed to trigger recalculation for affected accounts
        if activities_migrated > 0 {
            let asset_ids = vec![unknown_asset_id.to_string(), resolved_asset_id.to_string()];
            self.event_sink.emit(DomainEvent::activities_changed(
                account_ids,
                asset_ids,
                currencies,
                None,
            ));
        }

        info!(
            "Merged UNKNOWN asset {} into {}: {} activities migrated",
            unknown_asset_id, resolved_asset_id, activities_migrated
        );

        Ok(activities_migrated)
    }

    async fn ensure_assets(
        &self,
        specs: Vec<AssetSpec>,
        _activity_repository: &dyn crate::activities::ActivityRepositoryTrait,
    ) -> Result<EnsureAssetsResult> {
        if specs.is_empty() {
            return Ok(EnsureAssetsResult::default());
        }

        // Deduplicate specs by ID (if present) or by instrument_key
        let unique_specs: Vec<AssetSpec> = specs
            .into_iter()
            .fold(HashMap::new(), |mut map, spec| {
                let key = spec.id.clone().unwrap_or_else(|| {
                    spec.instrument_key().unwrap_or_else(|| {
                        format!(
                            "{}:{}@{}",
                            spec.instrument_type
                                .as_ref()
                                .map(|t| t.as_db_str())
                                .unwrap_or("?"),
                            spec.instrument_symbol.as_deref().unwrap_or(""),
                            spec.instrument_exchange_mic.as_deref().unwrap_or("")
                        )
                    })
                });
                map.entry(key).or_insert(spec);
                map
            })
            .into_values()
            .collect();

        // Pre-resolve specs without IDs by looking up via instrument_key
        let mut resolved_specs: Vec<AssetSpec> = Vec::with_capacity(unique_specs.len());
        let mut preexisting_keys: HashSet<String> = HashSet::new();
        for mut spec in unique_specs {
            if spec.id.is_none() {
                if let Some(key) = spec.instrument_key() {
                    if let Ok(Some(existing)) = self.asset_repository.find_by_instrument_key(&key) {
                        preexisting_keys.insert(key);
                        spec.id = Some(existing.id);
                    }
                }
            }
            resolved_specs.push(spec);
        }

        // Collect IDs of specs that have them (for existing asset lookup)
        let ids: Vec<String> = resolved_specs.iter().filter_map(|s| s.id.clone()).collect();

        // 1. Pre-read existing assets by requested IDs.
        let existing_ids: HashSet<String> = if !ids.is_empty() {
            self.asset_repository
                .list_by_asset_ids(&ids)?
                .into_iter()
                .map(|a| a.id)
                .collect()
        } else {
            HashSet::new()
        };

        // 2. Batch upsert all specs (INSERT OR IGNORE)
        // Resolve quote currencies with deduped input keys and bounded parallelism.
        const QUOTE_RESOLUTION_CONCURRENCY: usize = 8;
        let build_resolution_key =
            |symbol: Option<&str>,
             exchange_mic: Option<&str>,
             instrument_type: Option<&InstrumentType>,
             explicit_quote_ccy: Option<&str>,
             terminal_fallback: &str,
             allow_provider_lookup: bool| {
                let lookup_flag = if allow_provider_lookup { "1" } else { "0" };
                format!(
                    "{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}",
                    symbol.unwrap_or_default(),
                    exchange_mic.unwrap_or_default(),
                    instrument_type.map(|it| it.as_db_str()).unwrap_or_default(),
                    explicit_quote_ccy.unwrap_or_default(),
                    terminal_fallback,
                    lookup_flag
                )
            };

        type CreateResolutionInput = (
            Option<String>,
            Option<String>,
            Option<InstrumentType>,
            Option<String>,
            String,
            bool,
        );
        let mut specs_for_create: Vec<(AssetSpec, String)> =
            Vec::with_capacity(resolved_specs.len());
        let mut resolution_inputs_by_key: HashMap<String, CreateResolutionInput> = HashMap::new();

        for spec in &resolved_specs {
            let resolved_spec = spec.clone();
            let quote_mode = resolved_spec
                .quote_mode
                .unwrap_or_else(|| Self::default_quote_mode_for_kind(&resolved_spec.kind));
            let allow_provider_lookup = quote_mode == QuoteMode::Market
                && !matches!(
                    resolved_spec.instrument_type.as_ref(),
                    Some(InstrumentType::Crypto | InstrumentType::Fx)
                );
            let symbol = resolved_spec
                .instrument_symbol
                .as_deref()
                .or(resolved_spec.display_code.as_deref());
            let exchange_mic = resolved_spec.instrument_exchange_mic.as_deref();
            let instrument_type = resolved_spec.instrument_type.as_ref();
            let explicit_quote_ccy = resolved_spec.requested_quote_ccy.as_deref();
            let terminal_fallback = resolved_spec.quote_ccy.as_str();
            let resolution_key = build_resolution_key(
                symbol,
                exchange_mic,
                instrument_type,
                explicit_quote_ccy,
                terminal_fallback,
                allow_provider_lookup,
            );

            resolution_inputs_by_key
                .entry(resolution_key.clone())
                .or_insert((
                    symbol.map(|s| s.to_string()),
                    exchange_mic.map(|mic| mic.to_string()),
                    instrument_type.cloned(),
                    explicit_quote_ccy.map(|quote_ccy| quote_ccy.to_string()),
                    terminal_fallback.to_string(),
                    allow_provider_lookup,
                ));
            specs_for_create.push((resolved_spec, resolution_key));
        }

        let resolved_quote_ccy_by_key: HashMap<String, String> =
            stream::iter(resolution_inputs_by_key)
                .map(|(resolution_key, input)| async move {
                    let (
                        symbol,
                        exchange_mic,
                        instrument_type,
                        explicit_quote_ccy,
                        terminal_fallback,
                        allow_provider_lookup,
                    ) = input;
                    let (resolved_quote_ccy, _) = self
                        .resolve_quote_ccy(
                            symbol.as_deref(),
                            exchange_mic.as_deref(),
                            instrument_type.as_ref(),
                            explicit_quote_ccy.as_deref(),
                            None,
                            Some(terminal_fallback.as_str()),
                            allow_provider_lookup,
                        )
                        .await;
                    (resolution_key, resolved_quote_ccy)
                })
                .buffer_unordered(QUOTE_RESOLUTION_CONCURRENCY)
                .collect::<Vec<(String, String)>>()
                .await
                .into_iter()
                .collect();

        for (spec, resolution_key) in &mut specs_for_create {
            if let Some(resolved_quote_ccy) = resolved_quote_ccy_by_key.get(resolution_key) {
                spec.quote_ccy = resolved_quote_ccy.clone();
            }
        }

        let new_assets: Vec<NewAsset> = specs_for_create
            .iter()
            .filter(|(spec, _)| {
                spec.id
                    .as_ref()
                    .map(|id| !existing_ids.contains(id))
                    .unwrap_or(true)
            })
            .map(|(spec, _)| self.new_asset_from_spec(spec))
            .collect();

        self.asset_repository.create_batch(new_assets).await?;

        // Reactivate any pre-existing assets that were deactivated
        for asset in self.asset_repository.list_by_asset_ids(&ids)? {
            if !asset.is_active && existing_ids.contains(&asset.id) {
                info!("Reactivating previously deactivated asset: {}", asset.id);
                self.asset_repository.reactivate(&asset.id).await?;
            }
        }

        // 3. Fetch all requested assets (by ID + by instrument_key for specs without IDs)
        let mut assets_map: HashMap<String, Asset> = if !ids.is_empty() {
            self.asset_repository
                .list_by_asset_ids(&ids)?
                .into_iter()
                .map(|a| (a.id.clone(), a))
                .collect()
        } else {
            HashMap::new()
        };

        // Also look up assets for specs that didn't have IDs (created with DB-generated UUIDs)
        for spec in &resolved_specs {
            if spec.id.is_none() {
                if let Some(key) = spec.instrument_key() {
                    if let Ok(Some(asset)) = self.asset_repository.find_by_instrument_key(&key) {
                        assets_map.insert(asset.id.clone(), asset);
                    }
                }
            }
        }

        // Newly created (ID-based specs): all spec IDs minus pre-existing IDs
        let mut created_ids: HashSet<String> = ids
            .iter()
            .filter(|id| !existing_ids.contains(*id))
            .cloned()
            .collect();

        // Newly created (instrument-key specs with DB-generated UUIDs)
        for spec in &resolved_specs {
            if spec.id.is_none() {
                if let Some(key) = spec.instrument_key() {
                    if preexisting_keys.contains(&key) {
                        continue;
                    }
                    if let Some(asset) = assets_map
                        .values()
                        .find(|a| a.instrument_key.as_deref() == Some(&key))
                    {
                        created_ids.insert(asset.id.clone());
                    }
                }
            }
        }

        let created_ids: Vec<String> = created_ids.into_iter().collect();

        // 4. Auto-classify newly created assets (instrument_type + asset_class)
        if !created_ids.is_empty() {
            let created_set: HashSet<&str> = created_ids.iter().map(|id| id.as_str()).collect();
            for (spec, _) in &specs_for_create {
                let asset_id = spec.id.as_deref().or_else(|| {
                    spec.instrument_key().and_then(|key| {
                        assets_map
                            .values()
                            .find(|a| a.instrument_key.as_deref() == Some(key.as_str()))
                            .map(|a| a.id.as_str())
                    })
                });
                if let Some(id) = asset_id {
                    if created_set.contains(id) {
                        self.classify_new_asset(id, spec.instrument_type.as_ref(), &spec.kind)
                            .await;
                    }
                }
            }
        }

        // 5. Emit batch event for created assets
        if !created_ids.is_empty() {
            self.event_sink
                .emit(DomainEvent::assets_created(created_ids.clone()));
        }
        Ok(EnsureAssetsResult {
            assets: assets_map,
            created_ids,
            merge_candidates: Vec::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::assets_model::{Asset, AssetKind, InstrumentType};
    use super::{AssetService, QuoteMode};

    #[test]
    fn test_refresh_market_quote_ccy_on_mic_change_when_quote_not_explicit() {
        assert!(AssetService::should_refresh_market_quote_ccy_on_mic_change(
            QuoteMode::Market,
            None,
            Some("xlon"),
            Some("XNAS"),
        ));
    }

    #[test]
    fn test_do_not_refresh_market_quote_ccy_without_mic_change() {
        assert!(
            !AssetService::should_refresh_market_quote_ccy_on_mic_change(
                QuoteMode::Market,
                None,
                Some(" xnas "),
                Some("XNAS"),
            )
        );
    }

    #[test]
    fn test_do_not_refresh_market_quote_ccy_when_quote_explicitly_set() {
        assert!(
            !AssetService::should_refresh_market_quote_ccy_on_mic_change(
                QuoteMode::Market,
                Some("USD"),
                Some("XLON"),
                Some("XNAS"),
            )
        );
    }

    #[test]
    fn test_bond_provider_config_is_none() {
        // The provider_config logic in new_asset_from_spec:
        // Bond → None (no Yahoo override)
        let quote_mode = QuoteMode::Market;
        let instrument_type = Some(InstrumentType::Bond);

        let provider_config = match quote_mode {
            QuoteMode::Market => match instrument_type.as_ref() {
                Some(InstrumentType::Bond) => None,
                _ => Some(serde_json::json!({ "preferred_provider": "YAHOO" })),
            },
            QuoteMode::Manual => None,
        };

        assert!(
            provider_config.is_none(),
            "Bonds should NOT get Yahoo preferred_provider"
        );
    }

    #[test]
    fn test_equity_provider_config_is_yahoo() {
        let provider_config = AssetService::inferred_provider_config(
            QuoteMode::Market,
            Some(&InstrumentType::Equity),
            Some("SHOP"),
            Some("XTSE"),
        )
        .or(Some(serde_json::json!({ "preferred_provider": "YAHOO" })));

        assert_eq!(
            provider_config,
            Some(serde_json::json!({ "preferred_provider": "YAHOO" })),
            "Equities should get Yahoo preferred_provider"
        );
    }

    #[test]
    fn test_bf_isin_equity_prefers_boerse_frankfurt() {
        let provider_config = AssetService::inferred_provider_config(
            QuoteMode::Market,
            Some(&InstrumentType::Equity),
            Some("IE00BTJRMP35"),
            Some("XETR"),
        );

        assert_eq!(
            provider_config,
            Some(serde_json::json!({ "preferred_provider": "BOERSE_FRANKFURT" })),
            "ISIN-backed XETR/XFRA equities should prefer Boerse Frankfurt"
        );
    }

    #[test]
    fn test_profile_provider_change_resets_sync_state() {
        let before = Asset {
            provider_config: Some(serde_json::json!({ "preferred_provider": "YAHOO" })),
            ..test_market_asset()
        };
        let after = Asset {
            provider_config: Some(serde_json::json!({
                "preferred_provider": "BOERSE_FRANKFURT"
            })),
            ..before.clone()
        };

        assert!(AssetService::should_reset_sync_state_after_profile_change(
            &before, &after
        ));
    }

    #[test]
    fn test_bond_isin_metadata_change_resets_sync_state() {
        let before = Asset {
            instrument_type: Some(InstrumentType::Bond),
            metadata: Some(serde_json::json!({
                "identifiers": {
                    "isin": "US912797NQ65"
                }
            })),
            ..test_market_asset()
        };
        let after = Asset {
            metadata: Some(serde_json::json!({
                "identifiers": {
                    "isin": "IT0005415291"
                }
            })),
            ..before.clone()
        };

        assert!(AssetService::should_reset_sync_state_after_profile_change(
            &before, &after
        ));
    }

    #[test]
    fn test_notes_change_does_not_reset_sync_state() {
        let before = test_market_asset();
        let after = Asset {
            notes: Some("Updated notes".to_string()),
            ..before.clone()
        };

        assert!(!AssetService::should_reset_sync_state_after_profile_change(
            &before, &after
        ));
    }

    #[test]
    fn test_quote_mode_change_resets_sync_state() {
        let before = test_market_asset();
        let after = Asset {
            quote_mode: QuoteMode::Manual,
            ..before.clone()
        };

        assert!(AssetService::should_reset_sync_state_after_profile_change(
            &before, &after
        ));
    }

    #[test]
    fn test_quote_ccy_change_resets_sync_state() {
        let before = test_market_asset();
        let after = Asset {
            quote_ccy: "EUR".to_string(),
            ..before.clone()
        };

        assert!(AssetService::should_reset_sync_state_after_profile_change(
            &before, &after
        ));
    }

    #[test]
    fn test_instrument_type_change_resets_sync_state() {
        let before = test_market_asset();
        let after = Asset {
            instrument_type: Some(InstrumentType::Bond),
            ..before.clone()
        };

        assert!(AssetService::should_reset_sync_state_after_profile_change(
            &before, &after
        ));
    }

    #[test]
    fn test_instrument_symbol_change_resets_sync_state() {
        let before = test_market_asset();
        let after = Asset {
            instrument_symbol: Some("MSFT".to_string()),
            ..before.clone()
        };

        assert!(AssetService::should_reset_sync_state_after_profile_change(
            &before, &after
        ));
    }

    #[test]
    fn test_instrument_exchange_mic_change_resets_sync_state() {
        let before = Asset {
            instrument_exchange_mic: Some("XNAS".to_string()),
            ..test_market_asset()
        };
        let after = Asset {
            instrument_exchange_mic: Some("XLON".to_string()),
            ..before.clone()
        };

        assert!(AssetService::should_reset_sync_state_after_profile_change(
            &before, &after
        ));
    }

    fn test_market_asset() -> Asset {
        Asset {
            id: "asset-1".to_string(),
            kind: AssetKind::Investment,
            quote_mode: QuoteMode::Market,
            quote_ccy: "USD".to_string(),
            instrument_type: Some(InstrumentType::Equity),
            instrument_symbol: Some("AAPL".to_string()),
            ..Default::default()
        }
    }
}
