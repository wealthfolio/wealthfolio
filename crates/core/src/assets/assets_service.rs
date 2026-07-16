use log::{debug, error, info, warn};
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::events::{DomainEvent, DomainEventSink, NoOpDomainEventSink};
use crate::fx::normalize_amount;
use crate::quotes::{QuoteServiceTrait, SymbolSearchResult};
use crate::taxonomies::TaxonomyServiceTrait;
use crate::utils::isin::looks_like_isin;
use futures::stream::{self, StreamExt};

use super::assets_model::{
    canonicalize_market_identity, normalize_quote_ccy_code, resolve_import_quote_ccy_precedence,
    resolve_quote_ccy_precedence, Asset, AssetKind, AssetProfile, AssetSpec, EnsureAssetsResult,
    InstrumentType, NewAsset, QuoteCcyResolutionSource, QuoteMode, UpdateAssetProfile,
};
use super::assets_traits::{AssetRepositoryTrait, AssetServiceTrait};
use super::auto_classification::{
    AutoClassificationService, ClassificationInput, ProviderProfileClassification,
};
use super::{
    asset_provider_alias_symbols, parse_crypto_pair_symbol, parse_symbol_with_exchange_suffix,
    AssetResolutionInput, AssetResolutionOutput,
};
use crate::errors::{DatabaseError, Error, Result};

// Import mic_to_currency for resolving exchange trading currencies
use wealthfolio_market_data::{
    exchanges_for_currency, mic_to_currency, yahoo_equity_base_to_provider,
    yahoo_equity_provider_symbol_to_canonical, ExchangeMap, InstrumentId as MarketInstrumentId,
    ProviderId, ProviderInstrument, QuoteContext, ResolverChain, SymbolResolver,
};

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

fn normalized_lookup_key(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_uppercase())
}

fn instrument_key_for_identity(
    symbol: &str,
    exchange_mic: Option<&str>,
    instrument_type: Option<&InstrumentType>,
    quote_ccy: Option<&str>,
) -> Option<String> {
    let upper_symbol = normalized_lookup_key(symbol)?;
    let instrument_type = instrument_type?;
    match instrument_type {
        InstrumentType::Crypto | InstrumentType::Fx => quote_ccy.and_then(|ccy| {
            normalized_lookup_key(ccy)
                .map(|ccy| format!("{}:{}/{}", instrument_type.as_db_str(), upper_symbol, ccy))
        }),
        _ => exchange_mic
            .and_then(normalized_lookup_key)
            .map(|mic| format!("{}:{}@{}", instrument_type.as_db_str(), upper_symbol, mic)),
    }
}

fn asset_metadata_isin(asset: &Asset) -> Option<String> {
    asset
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("identifiers"))
        .and_then(|identifiers| identifiers.get("isin"))
        .and_then(|value| value.as_str())
        .and_then(normalized_lookup_key)
}

struct AssetResolutionLocalIndex {
    assets: Vec<Asset>,
    by_id: HashMap<String, usize>,
    by_isin: HashMap<String, Vec<usize>>,
    by_instrument_key: HashMap<String, usize>,
    by_symbol: HashMap<String, Vec<usize>>,
    by_provider_alias: HashMap<String, Vec<usize>>,
}

impl AssetResolutionLocalIndex {
    fn new(assets: Vec<Asset>) -> Self {
        let mut by_id = HashMap::new();
        let mut by_isin: HashMap<String, Vec<usize>> = HashMap::new();
        let mut by_instrument_key = HashMap::new();
        let mut by_symbol: HashMap<String, Vec<usize>> = HashMap::new();
        let mut by_provider_alias: HashMap<String, Vec<usize>> = HashMap::new();

        for (idx, asset) in assets.iter().enumerate() {
            by_id.insert(asset.id.clone(), idx);
            if let Some(isin) = asset_metadata_isin(asset) {
                by_isin.entry(isin).or_default().push(idx);
            }
            if let Some(key) = asset.instrument_key.as_ref() {
                by_instrument_key.insert(key.clone(), idx);
            }
            if let Some(symbol) = asset
                .instrument_symbol
                .as_deref()
                .and_then(normalized_lookup_key)
            {
                by_symbol.entry(symbol).or_default().push(idx);
            }
            for alias in asset_provider_alias_symbols(asset) {
                if let Some(alias) = normalized_lookup_key(&alias) {
                    by_provider_alias.entry(alias).or_default().push(idx);
                }
            }
        }

        Self {
            assets,
            by_id,
            by_isin,
            by_instrument_key,
            by_symbol,
            by_provider_alias,
        }
    }

    fn asset(&self, idx: usize) -> Option<Asset> {
        self.assets.get(idx).cloned()
    }

    fn find_by_id(&self, asset_id: Option<&str>) -> Option<Asset> {
        let asset_id = asset_id?.trim();
        self.by_id.get(asset_id).and_then(|idx| self.asset(*idx))
    }

    fn asset_matches_identity(
        asset: &Asset,
        symbol: &str,
        exchange_mic: Option<&str>,
        instrument_type: Option<&InstrumentType>,
        quote_ccy: Option<&str>,
        expected_key: Option<&str>,
    ) -> bool {
        if let (Some(expected), Some(actual)) = (expected_key, asset.instrument_key.as_deref()) {
            if expected == actual {
                return true;
            }
        }

        let Some(upper_symbol) = normalized_lookup_key(symbol) else {
            return false;
        };
        let Some(asset_symbol) = asset
            .instrument_symbol
            .as_deref()
            .and_then(normalized_lookup_key)
        else {
            return false;
        };
        if asset_symbol != upper_symbol {
            return false;
        }
        if let Some(expected_type) = instrument_type {
            if asset.instrument_type.as_ref() != Some(expected_type) {
                return false;
            }
        }
        match instrument_type {
            Some(InstrumentType::Crypto | InstrumentType::Fx) => {
                quote_ccy.is_none_or(|quote| asset.quote_ccy.eq_ignore_ascii_case(quote.trim()))
            }
            Some(InstrumentType::Option) => true,
            _ => match (exchange_mic, asset.instrument_exchange_mic.as_deref()) {
                (Some(expected), Some(actual)) => actual.eq_ignore_ascii_case(expected),
                (Some(_), _) => false,
                _ => {
                    quote_ccy.is_none_or(|quote| asset.quote_ccy.eq_ignore_ascii_case(quote.trim()))
                }
            },
        }
    }

    fn select_identity_match(
        &self,
        matches: Vec<usize>,
        exchange_mic: Option<&str>,
        quote_ccy: Option<&str>,
        instrument_type: Option<&InstrumentType>,
    ) -> Option<Asset> {
        let disambiguated = exchange_mic.is_some()
            || matches!(
                (instrument_type, quote_ccy),
                (Some(InstrumentType::Crypto | InstrumentType::Fx), Some(_))
            );
        if disambiguated {
            return matches.into_iter().next().and_then(|idx| self.asset(idx));
        }
        (matches.len() == 1)
            .then(|| matches[0])
            .and_then(|idx| self.asset(idx))
    }

    fn find_by_identity(
        &self,
        symbol: &str,
        exchange_mic: Option<&str>,
        instrument_type: Option<&InstrumentType>,
        quote_ccy: Option<&str>,
    ) -> Option<Asset> {
        let expected_key =
            instrument_key_for_identity(symbol, exchange_mic, instrument_type, quote_ccy);
        if let Some(idx) = expected_key
            .as_deref()
            .and_then(|key| self.by_instrument_key.get(key))
        {
            return self.asset(*idx);
        }

        let symbol_key = normalized_lookup_key(symbol)?;
        let matches = self
            .by_symbol
            .get(&symbol_key)?
            .iter()
            .copied()
            .filter(|idx| {
                self.assets.get(*idx).is_some_and(|asset| {
                    Self::asset_matches_identity(
                        asset,
                        symbol,
                        exchange_mic,
                        instrument_type,
                        quote_ccy,
                        expected_key.as_deref(),
                    )
                })
            })
            .collect();

        self.select_identity_match(matches, exchange_mic, quote_ccy, instrument_type)
    }

    fn find_by_isin(
        &self,
        isin: Option<&str>,
        symbol: &str,
        exchange_mic: Option<&str>,
        instrument_type: Option<&InstrumentType>,
        quote_ccy: Option<&str>,
    ) -> Option<Asset> {
        let isin = isin.and_then(normalized_lookup_key)?;
        let candidates = self.by_isin.get(&isin)?;
        if candidates.len() == 1 {
            return self.asset(candidates[0]);
        }

        let expected_key =
            instrument_key_for_identity(symbol, exchange_mic, instrument_type, quote_ccy);
        let matches = candidates
            .iter()
            .copied()
            .filter(|idx| {
                self.assets.get(*idx).is_some_and(|asset| {
                    Self::asset_matches_identity(
                        asset,
                        symbol,
                        exchange_mic,
                        instrument_type,
                        quote_ccy,
                        expected_key.as_deref(),
                    )
                })
            })
            .collect();
        self.select_identity_match(matches, exchange_mic, quote_ccy, instrument_type)
    }

    fn find_by_provider_alias(
        &self,
        provider_symbol: &str,
        symbol: &str,
        exchange_mic: Option<&str>,
        instrument_type: Option<&InstrumentType>,
        quote_ccy: Option<&str>,
    ) -> Option<Asset> {
        let alias = normalized_lookup_key(provider_symbol)?;
        let candidates = self.by_provider_alias.get(&alias)?;
        if candidates.len() == 1 {
            return self.asset(candidates[0]);
        }

        let expected_key =
            instrument_key_for_identity(symbol, exchange_mic, instrument_type, quote_ccy);
        let matches = candidates
            .iter()
            .copied()
            .filter(|idx| {
                self.assets.get(*idx).is_some_and(|asset| {
                    Self::asset_matches_identity(
                        asset,
                        symbol,
                        exchange_mic,
                        instrument_type,
                        quote_ccy,
                        expected_key.as_deref(),
                    )
                })
            })
            .collect();
        self.select_identity_match(matches, exchange_mic, quote_ccy, instrument_type)
    }

    #[allow(clippy::too_many_arguments)]
    fn find_for_import_input(
        &self,
        asset_id: Option<&str>,
        isin: Option<&str>,
        source_symbol: &str,
        canonical_symbol: &str,
        exchange_mic: Option<&str>,
        instrument_type: Option<&InstrumentType>,
        quote_ccy: Option<&str>,
    ) -> Option<Asset> {
        self.find_by_id(asset_id)
            .or_else(|| {
                self.find_by_isin(
                    isin,
                    canonical_symbol,
                    exchange_mic,
                    instrument_type,
                    quote_ccy,
                )
            })
            .or_else(|| {
                self.find_by_identity(canonical_symbol, exchange_mic, instrument_type, quote_ccy)
            })
            .or_else(|| {
                self.find_by_provider_alias(
                    source_symbol,
                    canonical_symbol,
                    exchange_mic,
                    instrument_type,
                    quote_ccy,
                )
            })
    }
}

struct ImportProviderSelectionConstraints<'a> {
    source_symbol: &'a str,
    canonical_symbol: &'a str,
    exchange_mic: Option<&'a str>,
    quote_ccy: Option<&'a str>,
    instrument_type: Option<&'a InstrumentType>,
    instrument_type_is_explicit: bool,
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

    fn parse_asset_kind_input(
        symbol: &str,
        exchange_mic: Option<&str>,
    ) -> (AssetKind, Option<InstrumentType>) {
        let upper_symbol = symbol.trim().to_uppercase();
        if let Some((_base, quote)) = upper_symbol.rsplit_once('-') {
            let quote = quote.trim();
            let crypto_quotes = [
                "USD", "CAD", "EUR", "GBP", "JPY", "CHF", "AUD", "NZD", "HKD", "SGD", "CNY", "SEK",
                "NOK", "DKK", "PLN", "CZK", "HUF", "TRY", "MXN", "BRL", "KRW", "INR", "ZAR", "BTC",
                "ETH", "USDT", "USDC", "DAI", "BUSD", "USDP", "TUSD", "FDUSD",
            ];
            if crypto_quotes.contains(&quote) {
                return (AssetKind::Investment, Some(InstrumentType::Crypto));
            }
        }

        if crate::utils::occ_symbol::looks_like_occ_symbol(&upper_symbol) {
            return (AssetKind::Investment, Some(InstrumentType::Option));
        }

        if exchange_mic.is_some() {
            return (AssetKind::Investment, Some(InstrumentType::Equity));
        }

        let common_crypto = [
            "BTC", "ETH", "XRP", "LTC", "BCH", "ADA", "DOT", "LINK", "XLM", "DOGE", "UNI", "SOL",
            "AVAX", "MATIC", "ATOM", "ALGO", "VET", "FIL", "TRX", "ETC", "XMR", "AAVE", "MKR",
            "COMP", "SNX", "YFI", "SUSHI", "CRV",
        ];
        if common_crypto.contains(&upper_symbol.as_str()) {
            return (AssetKind::Investment, Some(InstrumentType::Crypto));
        }

        (AssetKind::Investment, Some(InstrumentType::Equity))
    }

    fn import_provider_search_symbols(
        source_symbol: &str,
        canonical_symbol: &str,
        exchange_mic: Option<&str>,
        quote_ccy: Option<&str>,
        instrument_type: Option<&InstrumentType>,
    ) -> Vec<String> {
        let source_symbol = source_symbol.trim();
        if source_symbol.is_empty() {
            return Vec::new();
        }

        let mut candidates = Vec::new();
        let is_unsuffixed_equity = exchange_mic.is_none()
            && !source_symbol.contains('.')
            && instrument_type
                .map(|instrument_type| matches!(instrument_type, InstrumentType::Equity))
                .unwrap_or(true)
            && !looks_like_isin(source_symbol);

        if is_unsuffixed_equity {
            if let Some(quote_ccy) = normalize_quote_ccy_code(quote_ccy) {
                let exchange_map = ExchangeMap::new();
                let provider: ProviderId = Cow::Borrowed("YAHOO");
                let provider_base = yahoo_equity_base_to_provider(canonical_symbol);

                for mic in exchanges_for_currency(&quote_ccy) {
                    let mic: Cow<'static, str> = Cow::Borrowed(*mic);
                    let Some(suffix) = exchange_map
                        .get_suffix(&mic, &provider)
                        .filter(|suffix| !suffix.is_empty())
                    else {
                        continue;
                    };
                    let candidate = format!("{provider_base}{suffix}");
                    if !candidate.eq_ignore_ascii_case(source_symbol)
                        && !candidates
                            .iter()
                            .any(|existing: &String| existing.eq_ignore_ascii_case(&candidate))
                    {
                        candidates.push(candidate);
                        break;
                    }
                }
            }
        }

        if !candidates
            .iter()
            .any(|existing| existing.eq_ignore_ascii_case(source_symbol))
        {
            candidates.push(source_symbol.to_string());
        }

        candidates
    }

    fn kind_from_instrument_type(instrument_type: &InstrumentType) -> AssetKind {
        match instrument_type {
            InstrumentType::Fx => AssetKind::Fx,
            _ => AssetKind::Investment,
        }
    }

    fn import_asset_review_symbol(
        symbol: &str,
        exchange_mic: Option<&str>,
        instrument_type: Option<&InstrumentType>,
    ) -> Option<String> {
        let symbol = symbol.trim();
        if symbol.is_empty() {
            return None;
        }
        let is_exchange_qualified = instrument_type
            .map(|value| matches!(value, InstrumentType::Equity))
            .unwrap_or(true);
        if !is_exchange_qualified || symbol.contains('=') || looks_like_isin(symbol) {
            return Some(symbol.to_string());
        }

        let suffix = exchange_mic.and_then(|mic| {
            wealthfolio_market_data::ExchangeMap::new()
                .get_suffix(&Cow::Owned(mic.to_string()), &Cow::Borrowed("YAHOO"))
                .filter(|suffix| !suffix.is_empty())
                .map(str::to_string)
        });

        Some(match suffix {
            Some(suffix) => format!("{symbol}{suffix}"),
            None => symbol.to_string(),
        })
    }

    fn import_canonical_symbol(
        base_symbol: &str,
        instrument_type: Option<&InstrumentType>,
        provider_canonical_symbol: Option<String>,
    ) -> String {
        if let Some(symbol) = provider_canonical_symbol {
            return symbol;
        }

        match instrument_type {
            Some(InstrumentType::Crypto) => parse_crypto_pair_symbol(base_symbol)
                .map(|(base, _)| base)
                .unwrap_or_else(|| base_symbol.to_string()),
            Some(InstrumentType::Option) => {
                crate::utils::occ_symbol::normalize_option_symbol(base_symbol)
                    .unwrap_or_else(|| base_symbol.to_string())
            }
            _ => yahoo_equity_provider_symbol_to_canonical(base_symbol),
        }
    }

    fn provider_result_mic(result: &SymbolSearchResult) -> Option<&str> {
        result
            .canonical_exchange_mic
            .as_deref()
            .or(result.exchange_mic.as_deref())
    }

    fn provider_result_provider_id(result: &SymbolSearchResult) -> Option<&str> {
        result
            .provider_id
            .as_deref()
            .or(result.data_source.as_deref())
    }

    fn provider_result_provider_symbol(result: &SymbolSearchResult) -> &str {
        result.provider_symbol.as_deref().unwrap_or(&result.symbol)
    }

    fn provider_result_provider_symbol_matches_source(
        result: &SymbolSearchResult,
        source_symbol: &str,
    ) -> bool {
        let source_symbol = source_symbol.trim();
        !source_symbol.is_empty()
            && Self::provider_result_provider_symbol(result)
                .trim()
                .eq_ignore_ascii_case(source_symbol)
    }

    fn provider_result_matches_deterministic_provider_symbol(
        result: &SymbolSearchResult,
        constraints: &ImportProviderSelectionConstraints<'_>,
    ) -> bool {
        let Some(provider) = Self::provider_result_provider_id(result) else {
            return false;
        };
        let Some(instrument_type) = constraints.instrument_type else {
            return false;
        };
        let Some(instrument) = Self::instrument_id_from_identity(
            instrument_type,
            constraints.canonical_symbol,
            constraints.exchange_mic,
            constraints.quote_ccy,
        ) else {
            return false;
        };

        let context = QuoteContext {
            instrument,
            identifiers: Default::default(),
            overrides: None,
            currency_hint: constraints.quote_ccy.map(|ccy| Cow::Owned(ccy.to_string())),
            preferred_provider: Some(Cow::Owned(provider.to_string())),
            bond_metadata: None,
            custom_provider_code: None,
        };
        let provider_id: ProviderId = Cow::Owned(provider.to_string());
        let Some(deterministic_symbol) = ResolverChain::new()
            .resolve(&provider_id, &context)
            .ok()
            .map(|resolved| resolved.instrument.to_symbol_string())
        else {
            return false;
        };

        Self::provider_result_provider_symbol(result)
            .trim()
            .eq_ignore_ascii_case(deterministic_symbol.trim())
    }

    fn provider_result_canonical_matches(
        result: &SymbolSearchResult,
        canonical_symbol: &str,
    ) -> bool {
        let canonical_symbol = canonical_symbol.trim();
        !canonical_symbol.is_empty()
            && result
                .canonical_symbol
                .as_deref()
                .unwrap_or(&result.symbol)
                .trim()
                .eq_ignore_ascii_case(canonical_symbol)
    }

    fn provider_result_quote_matches(result: &SymbolSearchResult, quote_ccy: Option<&str>) -> bool {
        let Some(quote_ccy) = quote_ccy.map(str::trim).filter(|quote| !quote.is_empty()) else {
            return false;
        };

        result
            .currency
            .as_deref()
            .is_some_and(|currency| currency.trim().eq_ignore_ascii_case(quote_ccy))
    }

    fn provider_result_matches_import_instrument_type(
        result: &SymbolSearchResult,
        expected: Option<&InstrumentType>,
        expected_is_explicit: bool,
        source_symbol: &str,
    ) -> bool {
        let actual = InstrumentType::from_external_str(&result.quote_type);
        match expected {
            Some(InstrumentType::Crypto) => {
                actual == Some(InstrumentType::Crypto)
                    || (!expected_is_explicit
                        && Self::provider_result_provider_symbol_matches_source(
                            result,
                            source_symbol,
                        ))
            }
            Some(InstrumentType::Fx) => {
                actual == Some(InstrumentType::Fx)
                    || (!expected_is_explicit
                        && Self::provider_result_provider_symbol_matches_source(
                            result,
                            source_symbol,
                        ))
            }
            Some(InstrumentType::Equity) if expected_is_explicit => {
                actual.is_none_or(|actual| actual == InstrumentType::Equity)
            }
            Some(InstrumentType::Equity) => !matches!(
                actual,
                Some(
                    InstrumentType::Crypto
                        | InstrumentType::Fx
                        | InstrumentType::Option
                        | InstrumentType::Bond
                )
            ),
            Some(InstrumentType::Metal) => matches!(actual, Some(InstrumentType::Metal) | None),
            Some(InstrumentType::Option) => actual == Some(InstrumentType::Option),
            Some(InstrumentType::Bond) => actual == Some(InstrumentType::Bond),
            _ => true,
        }
    }

    fn provider_result_matches_import_constraints(
        result: &SymbolSearchResult,
        constraints: &ImportProviderSelectionConstraints<'_>,
    ) -> bool {
        if let Some(expected_mic) = constraints.exchange_mic {
            if !Self::provider_result_mic(result)
                .is_some_and(|mic| mic.eq_ignore_ascii_case(expected_mic))
            {
                return false;
            }
        }

        Self::provider_result_matches_import_instrument_type(
            result,
            constraints.instrument_type,
            constraints.instrument_type_is_explicit,
            constraints.source_symbol,
        )
    }

    fn import_provider_instrument_type(
        provider_result: Option<&SymbolSearchResult>,
        exchange_mic: Option<&str>,
    ) -> Option<InstrumentType> {
        let instrument_type = provider_result
            .and_then(|result| InstrumentType::from_external_str(&result.quote_type))?;
        if instrument_type == InstrumentType::Metal && exchange_mic.is_some() {
            return Some(InstrumentType::Equity);
        }

        Some(instrument_type)
    }

    fn provider_result_import_rank(
        result: &SymbolSearchResult,
        constraints: &ImportProviderSelectionConstraints<'_>,
    ) -> (u8, u8, u8, u8, u8, u8, u8, u8) {
        let actual_type = InstrumentType::from_external_str(&result.quote_type);
        let type_exact = constraints
            .instrument_type
            .is_some_and(|expected| actual_type.as_ref() == Some(expected));
        let explicit_type_exact = constraints.instrument_type_is_explicit && type_exact;
        let deterministic_provider_symbol =
            Self::provider_result_matches_deterministic_provider_symbol(result, constraints);
        let source_provider_symbol =
            Self::provider_result_provider_symbol_matches_source(result, constraints.source_symbol);
        let canonical_match =
            Self::provider_result_canonical_matches(result, constraints.canonical_symbol);
        let mic_match = constraints.exchange_mic.is_some_and(|expected_mic| {
            Self::provider_result_mic(result)
                .is_some_and(|mic| mic.eq_ignore_ascii_case(expected_mic))
        });
        let canonical_and_mic =
            canonical_match && (constraints.exchange_mic.is_none() || mic_match);
        let quote_match = Self::provider_result_quote_matches(result, constraints.quote_ccy);
        let has_provider_mic = Self::provider_result_mic(result).is_some();

        (
            explicit_type_exact as u8,
            deterministic_provider_symbol as u8,
            source_provider_symbol as u8,
            type_exact as u8,
            canonical_and_mic as u8,
            canonical_match as u8,
            quote_match as u8,
            has_provider_mic as u8,
        )
    }

    fn select_provider_result_for_import(
        results: Vec<SymbolSearchResult>,
        constraints: &ImportProviderSelectionConstraints<'_>,
    ) -> Option<SymbolSearchResult> {
        results
            .into_iter()
            .filter(|result| Self::provider_result_matches_import_constraints(result, constraints))
            .max_by(|a, b| {
                Self::provider_result_import_rank(a, constraints)
                    .cmp(&Self::provider_result_import_rank(b, constraints))
                    .then_with(|| {
                        a.score
                            .partial_cmp(&b.score)
                            .unwrap_or(std::cmp::Ordering::Equal)
                    })
            })
    }

    fn provider_instrument_from_symbol(
        instrument_type: Option<&InstrumentType>,
        provider_symbol: &str,
        quote_ccy: Option<&str>,
    ) -> Option<ProviderInstrument> {
        let symbol = Arc::from(provider_symbol);
        match instrument_type {
            Some(InstrumentType::Equity | InstrumentType::Option) | None => {
                Some(ProviderInstrument::EquitySymbol { symbol })
            }
            Some(InstrumentType::Crypto) => Some(ProviderInstrument::CryptoSymbol { symbol }),
            Some(InstrumentType::Fx) => Some(ProviderInstrument::FxSymbol { symbol }),
            Some(InstrumentType::Metal) => Some(ProviderInstrument::MetalSymbol {
                symbol,
                quote: Cow::Owned(quote_ccy.unwrap_or("USD").to_string()),
            }),
            Some(InstrumentType::Bond) => Some(ProviderInstrument::BondIsin { isin: symbol }),
        }
    }

    fn instrument_id_from_identity(
        instrument_type: &InstrumentType,
        symbol: &str,
        exchange_mic: Option<&str>,
        quote_ccy: Option<&str>,
    ) -> Option<MarketInstrumentId> {
        match instrument_type {
            InstrumentType::Equity => Some(MarketInstrumentId::Equity {
                ticker: Arc::from(symbol),
                mic: exchange_mic.map(|mic| Cow::Owned(mic.to_string())),
            }),
            InstrumentType::Crypto => Some(MarketInstrumentId::Crypto {
                base: Arc::from(symbol),
                quote: Cow::Owned(quote_ccy?.to_string()),
            }),
            InstrumentType::Fx => Some(MarketInstrumentId::Fx {
                base: Cow::Owned(symbol.to_string()),
                quote: Cow::Owned(quote_ccy?.to_string()),
            }),
            InstrumentType::Metal => Some(MarketInstrumentId::Metal {
                code: Arc::from(symbol),
                quote: Cow::Owned(quote_ccy.unwrap_or("USD").to_string()),
            }),
            InstrumentType::Option => Some(MarketInstrumentId::Option {
                occ_symbol: Arc::from(symbol),
            }),
            InstrumentType::Bond => Some(MarketInstrumentId::Bond {
                isin: Arc::from(symbol),
            }),
        }
    }

    fn provider_config_for_resolution(
        provider_id: Option<&str>,
        provider_symbol: Option<&str>,
        instrument_type: Option<&InstrumentType>,
        canonical_symbol: Option<&str>,
        exchange_mic: Option<&str>,
        quote_ccy: Option<&str>,
    ) -> Option<serde_json::Value> {
        let provider = provider_id
            .map(str::trim)
            .filter(|provider| !provider.is_empty())?;
        let mut config = serde_json::json!({ "preferred_provider": provider });
        let default_yahoo = provider.eq_ignore_ascii_case("YAHOO");

        let (Some(provider_symbol), Some(instrument_type), Some(canonical_symbol)) =
            (provider_symbol, instrument_type, canonical_symbol)
        else {
            return (!default_yahoo).then_some(config);
        };

        let Some(instrument) = Self::instrument_id_from_identity(
            instrument_type,
            canonical_symbol,
            exchange_mic,
            quote_ccy,
        ) else {
            return (!default_yahoo).then_some(config);
        };

        let context = QuoteContext {
            instrument,
            identifiers: Default::default(),
            overrides: None,
            currency_hint: quote_ccy.map(|ccy| Cow::Owned(ccy.to_string())),
            preferred_provider: Some(Cow::Owned(provider.to_string())),
            bond_metadata: None,
            custom_provider_code: None,
        };
        let provider_id: ProviderId = Cow::Owned(provider.to_string());
        let deterministic = ResolverChain::new()
            .resolve(&provider_id, &context)
            .ok()
            .map(|resolved| resolved.instrument.to_symbol_string());

        if deterministic
            .as_deref()
            .is_some_and(|symbol| symbol.eq_ignore_ascii_case(provider_symbol))
        {
            return (!default_yahoo).then_some(config);
        }

        if let Some(provider_instrument) =
            Self::provider_instrument_from_symbol(Some(instrument_type), provider_symbol, quote_ccy)
        {
            if let Some(obj) = config.as_object_mut() {
                obj.insert(
                    "overrides".to_string(),
                    serde_json::json!({ provider: provider_instrument }),
                );
            }
            return Some(config);
        }

        (!default_yahoo).then_some(config)
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

        let provider_config = spec.provider_config.clone().or_else(|| match quote_mode {
            QuoteMode::Market => Self::provider_config_for_resolution(
                spec.provider_id.as_deref(),
                spec.provider_symbol.as_deref(),
                spec.instrument_type.as_ref(),
                canonical
                    .instrument_symbol
                    .as_deref()
                    .or(spec.instrument_symbol.as_deref()),
                resolved_mic.as_deref(),
                Some(resolved_quote_ccy.as_str()),
            )
            .or_else(|| {
                Self::inferred_provider_config(
                    quote_mode,
                    spec.instrument_type.as_ref(),
                    canonical
                        .instrument_symbol
                        .as_deref()
                        .or(spec.instrument_symbol.as_deref()),
                    resolved_mic.as_deref(),
                )
            }),
            QuoteMode::Manual => None,
        });

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
            provider_id: spec.provider_id.clone(),
            provider_symbol: spec.provider_symbol.clone(),
            is_active: true,
            metadata,
            ..Default::default()
        }
    }
}

// Implement the service trait
#[async_trait::async_trait]
impl AssetServiceTrait for AssetService {
    async fn resolve_import_asset_inputs(
        &self,
        inputs: Vec<AssetResolutionInput>,
    ) -> Result<Vec<AssetResolutionOutput>> {
        if inputs.is_empty() {
            return Ok(Vec::new());
        }

        let local_index = AssetResolutionLocalIndex::new(self.get_assets()?);
        let mut outputs = Vec::with_capacity(inputs.len());

        for input in inputs {
            let source_symbol = input.source_symbol.trim().to_string();
            let resolution_symbol = if source_symbol.is_empty() {
                input
                    .isin
                    .as_deref()
                    .map(str::trim)
                    .filter(|isin| !isin.is_empty())
                    .unwrap_or_default()
                    .to_string()
            } else {
                source_symbol.clone()
            };
            let terminal_currency = input
                .activity_currency
                .as_deref()
                .map(str::trim)
                .filter(|currency| !currency.is_empty())
                .or_else(|| {
                    let account_currency = input.account_currency.trim();
                    (!account_currency.is_empty()).then_some(account_currency)
                })
                .unwrap_or("USD")
                .to_string();

            if resolution_symbol.is_empty() {
                outputs.push(AssetResolutionOutput {
                    key: input.key,
                    source_symbol,
                    ..Default::default()
                });
                continue;
            }

            let (base_symbol, suffix_mic) = parse_symbol_with_exchange_suffix(&resolution_symbol);
            let has_import_market_hint = input
                .exchange_mic
                .as_deref()
                .map(str::trim)
                .is_some_and(|mic| !mic.is_empty())
                || suffix_mic.is_some();
            let mut exchange_mic = input
                .exchange_mic
                .clone()
                .or_else(|| suffix_mic.map(str::to_string));
            let instrument_type_input = input.instrument_type.clone();
            let (inferred_kind, inferred_instrument_type) =
                Self::parse_asset_kind_input(base_symbol, exchange_mic.as_deref());
            let local_instrument_type = instrument_type_input
                .clone()
                .or_else(|| inferred_instrument_type.clone());
            let local_is_crypto = local_instrument_type.as_ref() == Some(&InstrumentType::Crypto);
            let local_is_non_security = matches!(
                local_instrument_type.as_ref(),
                Some(InstrumentType::Crypto | InstrumentType::Fx)
            );
            let local_is_option = local_instrument_type.as_ref() == Some(&InstrumentType::Option);
            let local_exchange_mic = if local_is_non_security || local_is_option {
                None
            } else {
                exchange_mic.clone()
            };
            let local_canonical_symbol =
                Self::import_canonical_symbol(base_symbol, local_instrument_type.as_ref(), None);
            let local_pair_quote_ccy = if local_is_crypto {
                parse_crypto_pair_symbol(base_symbol).map(|(_, quote)| quote)
            } else {
                None
            };
            let local_quote_ccy = input
                .quote_ccy
                .as_deref()
                .or(local_pair_quote_ccy.as_deref())
                .or(Some(&terminal_currency));
            let local_match_quote_ccy = input
                .quote_ccy
                .as_deref()
                .or(local_pair_quote_ccy.as_deref())
                .or(input
                    .activity_currency
                    .as_deref()
                    .map(str::trim)
                    .filter(|ccy| !ccy.is_empty()))
                .or_else(|| {
                    let account_currency = input.account_currency.trim();
                    (!account_currency.is_empty()).then_some(account_currency)
                });

            let local_existing_asset = local_index.find_for_import_input(
                input.asset_id.as_deref(),
                input.isin.as_deref(),
                &resolution_symbol,
                &local_canonical_symbol,
                local_exchange_mic.as_deref(),
                local_instrument_type.as_ref(),
                local_match_quote_ccy,
            );
            if let Some(asset) = local_existing_asset {
                let canonical_symbol = asset
                    .instrument_symbol
                    .clone()
                    .or_else(|| asset.display_code.clone())
                    .unwrap_or_else(|| local_canonical_symbol.clone());
                let exchange_mic = asset
                    .instrument_exchange_mic
                    .clone()
                    .or_else(|| local_exchange_mic.clone());
                let instrument_type = asset
                    .instrument_type
                    .clone()
                    .or_else(|| local_instrument_type.clone());
                let kind = asset.kind.clone();
                let quote_ccy = asset.quote_ccy.clone();
                let provider_id = asset.preferred_provider();
                let provider_config = asset.provider_config.clone();
                let review_symbol = Self::import_asset_review_symbol(
                    &canonical_symbol,
                    exchange_mic.as_deref(),
                    instrument_type.as_ref(),
                );
                let name = asset
                    .name
                    .clone()
                    .or_else(|| Some(canonical_symbol.clone()));

                outputs.push(AssetResolutionOutput {
                    key: input.key,
                    source_symbol,
                    canonical_symbol: Some(canonical_symbol),
                    exchange_mic,
                    quote_ccy: Some(quote_ccy),
                    instrument_type,
                    kind: Some(kind),
                    provider_id,
                    provider_symbol: None,
                    provider_config,
                    review_symbol,
                    existing_asset_id: Some(asset.id),
                    quote_ccy_source: Some(QuoteCcyResolutionSource::ExistingAsset),
                    name,
                    draft: None,
                });
                continue;
            }

            let provider_selection_constraints = ImportProviderSelectionConstraints {
                source_symbol: &resolution_symbol,
                canonical_symbol: &local_canonical_symbol,
                exchange_mic: exchange_mic.as_deref(),
                quote_ccy: local_quote_ccy,
                instrument_type: local_instrument_type.as_ref(),
                instrument_type_is_explicit: instrument_type_input.is_some(),
            };
            let mut provider_result = None;
            for search_symbol in Self::import_provider_search_symbols(
                &resolution_symbol,
                &local_canonical_symbol,
                exchange_mic.as_deref(),
                local_quote_ccy,
                local_instrument_type.as_ref(),
            ) {
                provider_result = self
                    .quote_service
                    .search_symbol_with_currency(&search_symbol, Some(&terminal_currency))
                    .await
                    .ok()
                    .and_then(|results| {
                        Self::select_provider_result_for_import(
                            results,
                            &provider_selection_constraints,
                        )
                    });
                if provider_result.is_some() {
                    break;
                }
            }

            if exchange_mic.is_none() {
                exchange_mic = provider_result.as_ref().and_then(|result| {
                    result
                        .canonical_exchange_mic
                        .clone()
                        .or_else(|| result.exchange_mic.clone())
                });
            }

            let mut instrument_type = instrument_type_input
                .clone()
                .or_else(|| {
                    Self::import_provider_instrument_type(
                        provider_result.as_ref(),
                        exchange_mic.as_deref(),
                    )
                })
                .or(inferred_instrument_type);
            let mut kind = instrument_type_input
                .as_ref()
                .map(Self::kind_from_instrument_type)
                .unwrap_or(inferred_kind);

            let is_crypto = instrument_type.as_ref() == Some(&InstrumentType::Crypto);
            let is_non_security = matches!(
                instrument_type.as_ref(),
                Some(InstrumentType::Crypto | InstrumentType::Fx)
            );
            let is_option = instrument_type.as_ref() == Some(&InstrumentType::Option);
            if is_non_security || is_option {
                exchange_mic = None;
            }

            let provider_canonical_symbol = provider_result
                .as_ref()
                .and_then(|result| result.canonical_symbol.clone());
            let mut canonical_symbol = Self::import_canonical_symbol(
                base_symbol,
                instrument_type.as_ref(),
                provider_canonical_symbol,
            );
            let pair_quote_ccy = if is_crypto {
                parse_crypto_pair_symbol(base_symbol).map(|(_, quote)| quote)
            } else {
                None
            };
            let existing_asset = local_index.find_by_identity(
                &canonical_symbol,
                exchange_mic.as_deref(),
                instrument_type.as_ref(),
                input.quote_ccy.as_deref().or(pair_quote_ccy.as_deref()),
            );
            let existing_asset_id = existing_asset.as_ref().map(|asset| asset.id.clone());
            if let Some(asset) = existing_asset.as_ref() {
                if let Some(symbol) = asset
                    .instrument_symbol
                    .as_deref()
                    .map(str::trim)
                    .filter(|symbol| !symbol.is_empty())
                {
                    canonical_symbol = symbol.to_string();
                }
                if exchange_mic.is_none() {
                    exchange_mic = asset.instrument_exchange_mic.clone();
                }
                if instrument_type.is_none() {
                    instrument_type = asset.instrument_type.clone();
                }
                kind = asset.kind.clone();
            }
            let existing_quote_ccy = existing_asset
                .as_ref()
                .map(|asset| asset.quote_ccy.as_str());

            let explicit_quote_ccy = input.quote_ccy.as_deref().or(pair_quote_ccy.as_deref());
            let activity_quote_ccy = if has_import_market_hint {
                input
                    .activity_currency
                    .as_deref()
                    .map(str::trim)
                    .filter(|currency| !currency.is_empty())
            } else {
                None
            };
            let provider_quote_ccy = provider_result
                .as_ref()
                .and_then(|result| result.currency.as_deref());
            let (quote_ccy, quote_ccy_source) = resolve_import_quote_ccy_precedence(
                explicit_quote_ccy,
                existing_quote_ccy,
                activity_quote_ccy,
                provider_quote_ccy,
                exchange_mic.as_deref().and_then(mic_to_currency),
                Some(&terminal_currency),
            )
            .unwrap_or_else(|| {
                (
                    terminal_currency.clone(),
                    QuoteCcyResolutionSource::TerminalFallback,
                )
            });

            let quote_mode = input.quote_mode.unwrap_or(QuoteMode::Market);
            let provider_id = input.provider_id.clone().or_else(|| {
                provider_result.as_ref().and_then(|result| {
                    result
                        .provider_id
                        .clone()
                        .or_else(|| result.data_source.clone())
                })
            });
            let provider_symbol = input.provider_symbol.clone().or_else(|| {
                provider_result.as_ref().and_then(|result| {
                    result
                        .provider_symbol
                        .clone()
                        .or_else(|| Some(result.symbol.clone()))
                })
            });
            let provider_config = match quote_mode {
                QuoteMode::Market => Self::provider_config_for_resolution(
                    provider_id.as_deref(),
                    provider_symbol.as_deref(),
                    instrument_type.as_ref(),
                    Some(canonical_symbol.as_str()),
                    exchange_mic.as_deref(),
                    Some(quote_ccy.as_str()),
                )
                .or_else(|| {
                    Self::inferred_provider_config(
                        quote_mode,
                        instrument_type.as_ref(),
                        Some(canonical_symbol.as_str()),
                        exchange_mic.as_deref(),
                    )
                }),
                QuoteMode::Manual => None,
            };
            let review_symbol = Self::import_asset_review_symbol(
                &canonical_symbol,
                exchange_mic.as_deref(),
                instrument_type.as_ref(),
            );
            let name = existing_asset
                .as_ref()
                .and_then(|asset| asset.name.clone())
                .or_else(|| {
                    provider_result
                        .as_ref()
                        .map(|result| result.long_name.clone())
                        .filter(|name| !name.trim().is_empty())
                })
                .or_else(|| Some(canonical_symbol.clone()));

            let draft = if existing_asset_id.is_none() {
                Some(NewAsset {
                    id: None,
                    kind: kind.clone(),
                    name: name.clone(),
                    display_code: Some(canonical_symbol.clone()),
                    is_active: true,
                    quote_mode,
                    quote_ccy: quote_ccy.clone(),
                    instrument_type: instrument_type.clone(),
                    instrument_symbol: Some(canonical_symbol.clone()),
                    instrument_exchange_mic: exchange_mic.clone(),
                    provider_config: provider_config.clone(),
                    provider_id: provider_id.clone(),
                    provider_symbol: provider_symbol.clone(),
                    notes: None,
                    metadata: None,
                })
            } else {
                None
            };

            outputs.push(AssetResolutionOutput {
                key: input.key,
                source_symbol,
                canonical_symbol: Some(canonical_symbol),
                exchange_mic,
                quote_ccy: Some(quote_ccy),
                quote_ccy_source: Some(quote_ccy_source),
                instrument_type,
                kind: Some(kind),
                provider_id,
                provider_symbol,
                provider_config,
                review_symbol,
                existing_asset_id,
                name,
                draft,
            });
        }

        Ok(outputs)
    }

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

    fn get_asset_profile(&self, asset_id: &str) -> Result<AssetProfile> {
        let asset = self.get_asset_by_id(asset_id)?;
        let (valuation_market_price, valuation_market_currency) = self
            .quote_service
            .get_latest_quote(asset_id)
            .ok()
            .map(|quote| {
                let (amount, currency) = normalize_amount(quote.close, &quote.currency);
                (Some(amount), Some(currency.to_string()))
            })
            .unwrap_or((None, None));

        Ok(AssetProfile::new(
            asset,
            valuation_market_price,
            valuation_market_currency,
        ))
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
            new_asset.provider_config = Self::provider_config_for_resolution(
                new_asset.provider_id.as_deref(),
                new_asset.provider_symbol.as_deref(),
                new_asset.instrument_type.as_ref(),
                new_asset.instrument_symbol.as_deref(),
                new_asset.instrument_exchange_mic.as_deref(),
                Some(new_asset.quote_ccy.as_str()),
            )
            .or_else(|| {
                Self::inferred_provider_config(
                    new_asset.quote_mode,
                    new_asset.instrument_type.as_ref(),
                    new_asset.instrument_symbol.as_deref(),
                    new_asset.instrument_exchange_mic.as_deref(),
                )
            });
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
            provider_config: None,
            provider_id: None,
            provider_symbol: None,
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
                        provider_config: meta.provider_config.clone(),
                        provider_id: meta.provider_id.clone(),
                        provider_symbol: meta.provider_symbol.clone(),
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
        let explicit_provider_config = metadata.as_ref().and_then(|m| m.provider_config.clone());
        let provider_id = metadata.as_ref().and_then(|m| m.provider_id.clone());
        let provider_symbol = metadata.as_ref().and_then(|m| m.provider_symbol.clone());
        let canonical_identity = canonicalize_market_identity(
            instrument_type.clone(),
            metadata
                .as_ref()
                .and_then(|m| m.instrument_symbol.as_deref().or(m.display_code.as_deref())),
            exchange_mic.as_deref(),
            Some(currency.as_str()),
        );
        let provider_config = explicit_provider_config.or_else(|| match quote_mode {
            QuoteMode::Market => Self::provider_config_for_resolution(
                provider_id.as_deref(),
                provider_symbol.as_deref(),
                instrument_type.as_ref(),
                canonical_identity.instrument_symbol.as_deref(),
                canonical_identity
                    .instrument_exchange_mic
                    .as_deref()
                    .or(exchange_mic.as_deref()),
                Some(currency.as_str()),
            )
            .or_else(|| {
                Self::inferred_provider_config(
                    quote_mode,
                    instrument_type.as_ref(),
                    canonical_identity.instrument_symbol.as_deref(),
                    canonical_identity
                        .instrument_exchange_mic
                        .as_deref()
                        .or(exchange_mic.as_deref()),
                )
            }),
            QuoteMode::Manual => None,
        });

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
            provider_id,
            provider_symbol,
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
            let classification_input =
                ClassificationInput::from_provider_profile(ProviderProfileClassification {
                    quote_type: provider_profile.asset_type.as_deref(),
                    name: updated_asset.name.as_deref(),
                    sectors_json: provider_profile.sectors.as_deref(),
                    classes_json: provider_profile.classes.as_deref(),
                    countries_json: provider_profile.countries.as_deref(),
                    exchange_mic: existing_asset.instrument_exchange_mic.as_deref(),
                    ..Default::default()
                });

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
    use super::super::assets_model::{
        Asset, AssetKind, InstrumentType, NewAsset, ProviderProfile, QuoteCcyResolutionSource,
        UpdateAssetProfile,
    };
    use super::{AssetRepositoryTrait, AssetService, AssetServiceTrait, QuoteMode};
    use crate::assets::AssetResolutionInput;
    use crate::errors::{DatabaseError, Error, Result};
    use crate::quotes::{
        LatestQuotePair, LatestQuoteSnapshot, ProviderInfo, Quote, QuoteImport, QuoteServiceTrait,
        QuoteSyncState, SymbolSearchResult, SymbolSyncPlan, SyncMode, SyncResult,
    };
    use chrono::{NaiveDate, Utc};
    use rust_decimal::Decimal;
    use std::collections::{HashMap, HashSet};
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct TestAssetRepository {
        assets: Mutex<Vec<Asset>>,
    }

    impl TestAssetRepository {
        fn with_assets(assets: Vec<Asset>) -> Self {
            Self {
                assets: Mutex::new(assets),
            }
        }
    }

    #[async_trait::async_trait]
    impl AssetRepositoryTrait for TestAssetRepository {
        async fn create(&self, _new_asset: NewAsset) -> Result<Asset> {
            unimplemented!()
        }

        async fn create_batch(&self, _new_assets: Vec<NewAsset>) -> Result<Vec<Asset>> {
            unimplemented!()
        }

        async fn update_profile(
            &self,
            _asset_id: &str,
            _payload: UpdateAssetProfile,
        ) -> Result<Asset> {
            unimplemented!()
        }

        async fn update_quote_mode(&self, _asset_id: &str, _quote_mode: &str) -> Result<Asset> {
            unimplemented!()
        }

        fn get_by_id(&self, asset_id: &str) -> Result<Asset> {
            self.assets
                .lock()
                .unwrap()
                .iter()
                .find(|asset| asset.id == asset_id)
                .cloned()
                .ok_or_else(|| {
                    Error::Database(DatabaseError::NotFound(format!(
                        "Asset not found: {asset_id}"
                    )))
                })
        }

        fn list(&self) -> Result<Vec<Asset>> {
            Ok(self.assets.lock().unwrap().clone())
        }

        fn list_by_asset_ids(&self, asset_ids: &[String]) -> Result<Vec<Asset>> {
            Ok(self
                .assets
                .lock()
                .unwrap()
                .iter()
                .filter(|asset| asset_ids.contains(&asset.id))
                .cloned()
                .collect())
        }

        async fn delete(&self, _asset_id: &str) -> Result<()> {
            unimplemented!()
        }

        fn search_by_symbol(&self, query: &str) -> Result<Vec<Asset>> {
            let query = query.trim().to_uppercase();
            Ok(self
                .assets
                .lock()
                .unwrap()
                .iter()
                .filter(|asset| {
                    asset
                        .instrument_symbol
                        .as_deref()
                        .is_some_and(|symbol| symbol.to_uppercase().contains(&query))
                })
                .cloned()
                .collect())
        }

        fn find_by_instrument_key(&self, instrument_key: &str) -> Result<Option<Asset>> {
            Ok(self
                .assets
                .lock()
                .unwrap()
                .iter()
                .find(|asset| asset.instrument_key.as_deref() == Some(instrument_key))
                .cloned())
        }

        async fn cleanup_legacy_metadata(&self, _asset_id: &str) -> Result<()> {
            Ok(())
        }

        async fn deactivate(&self, _asset_id: &str) -> Result<()> {
            unimplemented!()
        }

        async fn reactivate(&self, _asset_id: &str) -> Result<()> {
            unimplemented!()
        }

        async fn copy_user_metadata(&self, _source_id: &str, _target_id: &str) -> Result<()> {
            unimplemented!()
        }

        async fn deactivate_orphaned_investments(&self) -> Result<Vec<String>> {
            Ok(Vec::new())
        }
    }

    #[derive(Default)]
    struct TestQuoteService {
        results: Arc<Mutex<HashMap<String, Vec<SymbolSearchResult>>>>,
        profiles: Arc<Mutex<HashMap<String, ProviderProfile>>>,
        latest_quotes: Arc<Mutex<HashMap<String, Quote>>>,
        search_calls: Arc<Mutex<Vec<String>>>,
    }

    impl TestQuoteService {
        fn with_result(self, query: &str, results: Vec<SymbolSearchResult>) -> Self {
            self.results
                .lock()
                .unwrap()
                .insert(query.to_uppercase(), results);
            self
        }

        fn with_latest_quote(self, asset_id: &str, quote: Quote) -> Self {
            self.latest_quotes
                .lock()
                .unwrap()
                .insert(asset_id.to_string(), quote);
            self
        }
    }

    #[async_trait::async_trait]
    impl QuoteServiceTrait for TestQuoteService {
        fn get_latest_quote(&self, symbol: &str) -> Result<Quote> {
            self.latest_quotes
                .lock()
                .unwrap()
                .get(symbol)
                .cloned()
                .ok_or_else(|| Error::Asset(format!("No latest quote for {symbol}")))
        }

        fn get_latest_quotes(&self, _symbols: &[String]) -> Result<HashMap<String, Quote>> {
            unimplemented!()
        }

        fn get_latest_quotes_as_of(
            &self,
            _symbols: &[String],
            _as_of: chrono::NaiveDate,
        ) -> Result<HashMap<String, Quote>> {
            Ok(HashMap::new())
        }

        fn get_latest_quotes_snapshot(
            &self,
            _asset_ids: &[String],
        ) -> Result<HashMap<String, LatestQuoteSnapshot>> {
            unimplemented!()
        }

        fn get_latest_quotes_pair(
            &self,
            _symbols: &[String],
        ) -> Result<HashMap<String, LatestQuotePair>> {
            unimplemented!()
        }

        fn get_historical_quotes(&self, _symbol: &str) -> Result<Vec<Quote>> {
            unimplemented!()
        }

        fn get_all_historical_quotes(&self) -> Result<HashMap<String, Vec<(NaiveDate, Quote)>>> {
            unimplemented!()
        }

        fn get_quotes_in_range(
            &self,
            _symbols: &HashSet<String>,
            _start: NaiveDate,
            _end: NaiveDate,
        ) -> Result<Vec<Quote>> {
            unimplemented!()
        }

        fn get_quotes_in_range_filled(
            &self,
            _symbols: &HashSet<String>,
            _start: NaiveDate,
            _end: NaiveDate,
        ) -> Result<Vec<Quote>> {
            unimplemented!()
        }

        async fn get_daily_quotes(
            &self,
            _asset_ids: &HashSet<String>,
            _start: NaiveDate,
            _end: NaiveDate,
        ) -> Result<HashMap<NaiveDate, HashMap<String, Quote>>> {
            unimplemented!()
        }

        async fn add_quote(&self, _quote: &Quote) -> Result<Quote> {
            unimplemented!()
        }

        async fn update_quote(&self, _quote: Quote) -> Result<Quote> {
            unimplemented!()
        }

        async fn delete_quote(&self, _quote_id: &str) -> Result<()> {
            unimplemented!()
        }

        async fn bulk_upsert_quotes(&self, _quotes: Vec<Quote>) -> Result<usize> {
            unimplemented!()
        }

        async fn search_symbol(&self, query: &str) -> Result<Vec<SymbolSearchResult>> {
            self.search_symbol_with_currency(query, None).await
        }

        async fn search_symbol_with_currency(
            &self,
            query: &str,
            _account_currency: Option<&str>,
        ) -> Result<Vec<SymbolSearchResult>> {
            self.search_calls.lock().unwrap().push(query.to_string());
            Ok(self
                .results
                .lock()
                .unwrap()
                .get(&query.to_uppercase())
                .cloned()
                .unwrap_or_default())
        }

        async fn get_asset_profile(
            &self,
            asset: &Asset,
        ) -> Result<super::super::assets_model::ProviderProfile> {
            let symbol = asset
                .instrument_symbol
                .as_deref()
                .or(asset.display_code.as_deref())
                .unwrap_or_default()
                .to_uppercase();
            self.profiles
                .lock()
                .unwrap()
                .get(&symbol)
                .cloned()
                .ok_or_else(|| Error::Asset(format!("No test profile for {symbol}")))
        }

        async fn fetch_quotes_from_provider(
            &self,
            _asset_id: &str,
            _start: NaiveDate,
            _end: NaiveDate,
        ) -> Result<Vec<Quote>> {
            unimplemented!()
        }

        async fn fetch_quotes_for_symbol(
            &self,
            _symbol: &str,
            _currency: &str,
            _start: NaiveDate,
            _end: NaiveDate,
        ) -> Result<Vec<Quote>> {
            unimplemented!()
        }

        async fn sync(
            &self,
            _mode: SyncMode,
            _asset_ids: Option<Vec<String>>,
        ) -> Result<SyncResult> {
            unimplemented!()
        }

        async fn resync(&self, _asset_ids: Option<Vec<String>>) -> Result<SyncResult> {
            unimplemented!()
        }

        async fn refresh_sync_state(&self) -> Result<()> {
            unimplemented!()
        }

        fn get_sync_plan(&self) -> Result<Vec<SymbolSyncPlan>> {
            unimplemented!()
        }

        async fn handle_activity_created(
            &self,
            _symbol: &str,
            _activity_date: NaiveDate,
        ) -> Result<()> {
            Ok(())
        }

        async fn handle_activity_deleted(&self, _symbol: &str) -> Result<()> {
            Ok(())
        }

        async fn delete_sync_state(&self, _symbol: &str) -> Result<()> {
            Ok(())
        }

        fn get_symbols_needing_sync(&self) -> Result<Vec<QuoteSyncState>> {
            Ok(Vec::new())
        }

        fn get_sync_state(&self, _symbol: &str) -> Result<Option<QuoteSyncState>> {
            Ok(None)
        }

        async fn mark_profile_enriched(&self, _symbol: &str) -> Result<()> {
            Ok(())
        }

        fn get_assets_needing_profile_enrichment(&self) -> Result<Vec<QuoteSyncState>> {
            Ok(Vec::new())
        }

        fn get_sync_states_with_errors(&self) -> Result<Vec<QuoteSyncState>> {
            Ok(Vec::new())
        }

        async fn reset_sync_errors(&self, _asset_ids: &[String]) -> Result<()> {
            Ok(())
        }

        async fn reset_sync_state_for_profile_change(&self, _asset_id: &str) -> Result<()> {
            Ok(())
        }

        async fn update_position_status_from_holdings(
            &self,
            _current_holdings: &HashMap<String, rust_decimal::Decimal>,
        ) -> Result<()> {
            Ok(())
        }

        async fn get_providers_info(&self) -> Result<Vec<ProviderInfo>> {
            Ok(Vec::new())
        }

        async fn update_provider_settings(
            &self,
            _provider_id: &str,
            _priority: i32,
            _enabled: bool,
        ) -> Result<()> {
            Ok(())
        }

        async fn check_quotes_import(
            &self,
            _content: &[u8],
            _has_header_row: bool,
        ) -> Result<Vec<QuoteImport>> {
            unimplemented!()
        }

        async fn import_quotes(
            &self,
            _quotes: Vec<QuoteImport>,
            _overwrite: bool,
        ) -> Result<Vec<QuoteImport>> {
            unimplemented!()
        }
    }

    fn import_input(symbol: &str, account_currency: &str) -> AssetResolutionInput {
        AssetResolutionInput {
            key: symbol.to_string(),
            source_symbol: symbol.to_string(),
            account_currency: account_currency.to_string(),
            activity_currency: Some(account_currency.to_string()),
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            isin: None,
            asset_id: None,
            provider_id: None,
            provider_symbol: None,
        }
    }

    fn yahoo_search_result(
        symbol: &str,
        canonical_symbol: &str,
        mic: &str,
        name: &str,
        currency: &str,
        provider_symbol: &str,
    ) -> SymbolSearchResult {
        SymbolSearchResult {
            symbol: symbol.to_string(),
            canonical_symbol: Some(canonical_symbol.to_string()),
            canonical_exchange_mic: Some(mic.to_string()),
            provider_id: Some("YAHOO".to_string()),
            provider_symbol: Some(provider_symbol.to_string()),
            short_name: name.to_string(),
            long_name: name.to_string(),
            exchange: mic.to_string(),
            exchange_mic: Some(mic.to_string()),
            exchange_name: None,
            quote_type: "EQUITY".to_string(),
            type_display: "Equity".to_string(),
            currency: Some(currency.to_string()),
            currency_source: Some("provider".to_string()),
            data_source: Some("YAHOO".to_string()),
            quote_mode: Some("MARKET".to_string()),
            is_existing: false,
            existing_asset_id: None,
            index: String::new(),
            score: 1.0,
        }
    }

    fn test_asset_service(assets: Vec<Asset>, quote_service: TestQuoteService) -> AssetService {
        AssetService::new(
            Arc::new(TestAssetRepository::with_assets(assets)),
            Arc::new(quote_service),
        )
        .unwrap()
    }

    #[test]
    fn get_asset_profile_normalizes_latest_quote_unit_market_price() {
        let asset = Asset {
            id: "asset-cty-lse".to_string(),
            kind: AssetKind::Investment,
            quote_mode: QuoteMode::Market,
            quote_ccy: "GBp".to_string(),
            created_at: Utc::now().naive_utc(),
            updated_at: Utc::now().naive_utc(),
            ..Default::default()
        };
        let quote = Quote {
            id: "quote-cty".to_string(),
            asset_id: asset.id.clone(),
            timestamp: Utc::now(),
            close: Decimal::new(565, 0),
            currency: "GBp".to_string(),
            created_at: Utc::now(),
            ..Default::default()
        };
        let service = test_asset_service(
            vec![asset],
            TestQuoteService::default().with_latest_quote("asset-cty-lse", quote),
        );

        let profile = service.get_asset_profile("asset-cty-lse").unwrap();

        assert_eq!(profile.asset.quote_ccy, "GBp");
        assert_eq!(profile.valuation_market_price, Some(Decimal::new(565, 2)));
        assert_eq!(profile.valuation_market_currency.as_deref(), Some("GBP"));

        let value = serde_json::to_value(profile).unwrap();
        assert_eq!(value["quoteCcy"], serde_json::json!("GBp"));
        assert_eq!(value["valuationMarketCurrency"], serde_json::json!("GBP"));
        assert!(value.get("valuationMarketPrice").is_some());
    }

    #[tokio::test]
    async fn test_resolve_import_asset_inputs_returns_canonical_xetra_draft() {
        let service = test_asset_service(
            Vec::new(),
            TestQuoteService::default().with_result(
                "APC.DE",
                vec![yahoo_search_result(
                    "APC.DE",
                    "APC",
                    "XETR",
                    "Apple Inc.",
                    "EUR",
                    "APC.DE",
                )],
            ),
        );

        let output = service
            .resolve_import_asset_inputs(vec![import_input("APC.DE", "EUR")])
            .await
            .unwrap()
            .pop()
            .unwrap();

        assert_eq!(output.canonical_symbol.as_deref(), Some("APC"));
        assert_eq!(output.exchange_mic.as_deref(), Some("XETR"));
        assert_eq!(output.quote_ccy.as_deref(), Some("EUR"));
        assert_eq!(output.provider_id.as_deref(), Some("YAHOO"));
        assert_eq!(output.provider_symbol.as_deref(), Some("APC.DE"));
        assert_eq!(output.review_symbol.as_deref(), Some("APC.DE"));
        assert_eq!(output.existing_asset_id, None);

        let draft = output.draft.expect("new XETRA asset draft");
        assert_eq!(draft.display_code.as_deref(), Some("APC"));
        assert_eq!(draft.instrument_symbol.as_deref(), Some("APC"));
        assert_eq!(draft.instrument_exchange_mic.as_deref(), Some("XETR"));
        assert_eq!(draft.provider_config, None);
        assert_eq!(draft.provider_id.as_deref(), Some("YAHOO"));
        assert_eq!(draft.provider_symbol.as_deref(), Some("APC.DE"));
    }

    #[tokio::test]
    async fn test_resolve_import_asset_inputs_preserves_lse_provider_display_name() {
        let service = test_asset_service(
            Vec::new(),
            TestQuoteService::default().with_result(
                "VOD.L",
                vec![yahoo_search_result(
                    "VOD.L",
                    "VOD",
                    "XLON",
                    "Vodafone Group Public Limited Company",
                    "GBp",
                    "VOD.L",
                )],
            ),
        );

        let output = service
            .resolve_import_asset_inputs(vec![import_input("VOD.L", "GBp")])
            .await
            .unwrap()
            .pop()
            .unwrap();

        assert_eq!(output.canonical_symbol.as_deref(), Some("VOD"));
        assert_eq!(output.exchange_mic.as_deref(), Some("XLON"));
        assert_eq!(output.quote_ccy.as_deref(), Some("GBp"));
        assert_eq!(output.provider_id.as_deref(), Some("YAHOO"));
        assert_eq!(output.provider_symbol.as_deref(), Some("VOD.L"));
        assert_eq!(output.review_symbol.as_deref(), Some("VOD.L"));
        assert_eq!(
            output.name.as_deref(),
            Some("Vodafone Group Public Limited Company")
        );

        let draft = output.draft.expect("new LSE asset draft");
        assert_eq!(
            draft.name.as_deref(),
            Some("Vodafone Group Public Limited Company")
        );
        assert_eq!(draft.display_code.as_deref(), Some("VOD"));
        assert_eq!(draft.instrument_symbol.as_deref(), Some("VOD"));
        assert_eq!(draft.instrument_exchange_mic.as_deref(), Some("XLON"));
        assert_eq!(draft.provider_config, None);
        assert_eq!(draft.provider_id.as_deref(), Some("YAHOO"));
        assert_eq!(draft.provider_symbol.as_deref(), Some("VOD.L"));
    }

    #[tokio::test]
    async fn test_resolve_import_asset_inputs_uses_activity_currency_before_provider_quote() {
        let service = test_asset_service(
            Vec::new(),
            TestQuoteService::default().with_result(
                "VOD.L",
                vec![yahoo_search_result(
                    "VOD.L",
                    "VOD",
                    "XLON",
                    "Vodafone Group Public Limited Company",
                    "GBp",
                    "VOD.L",
                )],
            ),
        );

        let output = service
            .resolve_import_asset_inputs(vec![import_input("VOD.L", "USD")])
            .await
            .unwrap()
            .pop()
            .unwrap();

        assert_eq!(output.canonical_symbol.as_deref(), Some("VOD"));
        assert_eq!(output.exchange_mic.as_deref(), Some("XLON"));
        assert_eq!(output.quote_ccy.as_deref(), Some("USD"));
        assert_eq!(
            output.quote_ccy_source,
            Some(QuoteCcyResolutionSource::ExplicitInput)
        );

        let draft = output.draft.expect("new LSE asset draft");
        assert_eq!(draft.quote_ccy, "USD");
        assert_eq!(draft.provider_symbol.as_deref(), Some("VOD.L"));
    }

    #[tokio::test]
    async fn test_resolve_import_asset_inputs_uses_activity_currency_before_mic_without_provider_quote(
    ) {
        let mut vod = yahoo_search_result(
            "VOD.L",
            "VOD",
            "XLON",
            "Vodafone Group Public Limited Company",
            "GBp",
            "VOD.L",
        );
        vod.currency = None;
        let service = test_asset_service(
            Vec::new(),
            TestQuoteService::default().with_result("VOD.L", vec![vod]),
        );

        let output = service
            .resolve_import_asset_inputs(vec![import_input("VOD.L", "USD")])
            .await
            .unwrap()
            .pop()
            .unwrap();

        assert_eq!(output.canonical_symbol.as_deref(), Some("VOD"));
        assert_eq!(output.exchange_mic.as_deref(), Some("XLON"));
        assert_eq!(output.quote_ccy.as_deref(), Some("USD"));
        assert_eq!(
            output.quote_ccy_source,
            Some(QuoteCcyResolutionSource::ExplicitInput)
        );

        let draft = output.draft.expect("new LSE asset draft");
        assert_eq!(draft.quote_ccy, "USD");
        assert_eq!(draft.provider_symbol.as_deref(), Some("VOD.L"));
    }

    #[tokio::test]
    async fn test_resolve_import_asset_inputs_keeps_provider_quote_unit_for_activity_major() {
        let service = test_asset_service(
            Vec::new(),
            TestQuoteService::default().with_result(
                "VOD.L",
                vec![yahoo_search_result(
                    "VOD.L",
                    "VOD",
                    "XLON",
                    "Vodafone Group Public Limited Company",
                    "GBp",
                    "VOD.L",
                )],
            ),
        );

        let output = service
            .resolve_import_asset_inputs(vec![import_input("VOD.L", "GBP")])
            .await
            .unwrap()
            .pop()
            .unwrap();

        assert_eq!(output.canonical_symbol.as_deref(), Some("VOD"));
        assert_eq!(output.exchange_mic.as_deref(), Some("XLON"));
        assert_eq!(output.quote_ccy.as_deref(), Some("GBp"));
        assert_eq!(
            output.quote_ccy_source,
            Some(QuoteCcyResolutionSource::ProviderQuote)
        );

        let draft = output.draft.expect("new LSE asset draft");
        assert_eq!(draft.quote_ccy, "GBp");
        assert_eq!(draft.provider_symbol.as_deref(), Some("VOD.L"));
    }

    #[tokio::test]
    async fn test_resolve_import_asset_inputs_uses_provider_when_activity_currency_is_missing() {
        let service = test_asset_service(
            Vec::new(),
            TestQuoteService::default().with_result(
                "VOD.L",
                vec![yahoo_search_result(
                    "VOD.L",
                    "VOD",
                    "XLON",
                    "Vodafone Group Public Limited Company",
                    "GBp",
                    "VOD.L",
                )],
            ),
        );
        let mut input = import_input("VOD.L", "USD");
        input.activity_currency = None;

        let output = service
            .resolve_import_asset_inputs(vec![input])
            .await
            .unwrap()
            .pop()
            .unwrap();

        assert_eq!(output.quote_ccy.as_deref(), Some("GBp"));
        assert_eq!(
            output.quote_ccy_source,
            Some(QuoteCcyResolutionSource::ProviderQuote)
        );
    }

    #[tokio::test]
    async fn test_resolve_import_asset_inputs_preserves_share_class_identity() {
        let mut wrong_display_match = yahoo_search_result(
            "BRK.B",
            "BRK.B",
            "XASE",
            "YieldMax BRK.B Option Income Strategy ETF",
            "USD",
            "BRK.B",
        );
        wrong_display_match.score = 10_000.0;
        let mut berkshire = yahoo_search_result(
            "BRK.B",
            "BRK.B",
            "XNYS",
            "Berkshire Hathaway Inc.",
            "USD",
            "BRK-B",
        );
        berkshire.score = 1.0;
        let service = test_asset_service(
            Vec::new(),
            TestQuoteService::default().with_result("BRK.B", vec![wrong_display_match, berkshire]),
        );

        let output = service
            .resolve_import_asset_inputs(vec![import_input("BRK.B", "USD")])
            .await
            .unwrap()
            .pop()
            .unwrap();

        assert_eq!(output.canonical_symbol.as_deref(), Some("BRK.B"));
        assert_eq!(output.exchange_mic.as_deref(), Some("XNYS"));
        assert_eq!(output.provider_symbol.as_deref(), Some("BRK-B"));
        assert_eq!(output.review_symbol.as_deref(), Some("BRK.B"));
        assert_eq!(output.name.as_deref(), Some("Berkshire Hathaway Inc."));

        let draft = output.draft.expect("new share-class draft");
        assert_eq!(draft.display_code.as_deref(), Some("BRK.B"));
        assert_eq!(draft.instrument_symbol.as_deref(), Some("BRK.B"));
        assert_eq!(draft.instrument_exchange_mic.as_deref(), Some("XNYS"));
        assert_eq!(draft.provider_config, None);
        assert_eq!(draft.provider_id.as_deref(), Some("YAHOO"));
        assert_eq!(draft.provider_symbol.as_deref(), Some("BRK-B"));
    }

    #[tokio::test]
    async fn test_resolve_import_asset_inputs_preserves_exchange_suffix_for_listed_etc() {
        let mut search_result =
            yahoo_search_result("4GLD.DE", "4GLD", "XETR", "Xetra-Gold", "EUR", "4GLD.DE");
        search_result.quote_type = "COMMODITY".to_string();
        let service = test_asset_service(
            Vec::new(),
            TestQuoteService::default().with_result("4GLD.DE", vec![search_result]),
        );

        let output = service
            .resolve_import_asset_inputs(vec![import_input("4GLD.DE", "EUR")])
            .await
            .unwrap()
            .pop()
            .unwrap();

        assert_eq!(output.canonical_symbol.as_deref(), Some("4GLD"));
        assert_eq!(output.exchange_mic.as_deref(), Some("XETR"));
        assert_eq!(output.instrument_type, Some(InstrumentType::Equity));
        assert_eq!(output.provider_symbol.as_deref(), Some("4GLD.DE"));
        assert_eq!(output.review_symbol.as_deref(), Some("4GLD.DE"));

        let draft = output.draft.expect("new listed ETC draft");
        assert_eq!(draft.display_code.as_deref(), Some("4GLD"));
        assert_eq!(draft.instrument_symbol.as_deref(), Some("4GLD"));
        assert_eq!(draft.instrument_exchange_mic.as_deref(), Some("XETR"));
        assert_eq!(draft.instrument_type, Some(InstrumentType::Equity));
        assert_eq!(draft.provider_config, None);
        assert_eq!(draft.provider_id.as_deref(), Some("YAHOO"));
        assert_eq!(draft.provider_symbol.as_deref(), Some("4GLD.DE"));
    }

    #[tokio::test]
    async fn test_resolve_import_asset_inputs_does_not_classify_invalid_provider_symbol_as_metal() {
        let quote_service = TestQuoteService::default();
        let search_calls = Arc::clone(&quote_service.search_calls);
        let service = test_asset_service(Vec::new(), quote_service);

        let output = service
            .resolve_import_asset_inputs(vec![import_input("WSLV.DE", "EUR")])
            .await
            .unwrap()
            .pop()
            .unwrap();

        assert_eq!(search_calls.lock().unwrap().as_slice(), ["WSLV.DE"]);
        assert_eq!(output.canonical_symbol.as_deref(), Some("WSLV"));
        assert_eq!(output.exchange_mic.as_deref(), Some("XETR"));
        assert_eq!(output.quote_ccy.as_deref(), Some("EUR"));
        assert_eq!(output.instrument_type, Some(InstrumentType::Equity));
        assert_eq!(output.review_symbol.as_deref(), Some("WSLV.DE"));
        assert_eq!(output.provider_symbol, None);
        assert_eq!(output.provider_config, None);

        let draft = output
            .draft
            .expect("unmatched invalid provider symbol draft");
        assert_eq!(draft.instrument_type, Some(InstrumentType::Equity));
        assert_eq!(draft.instrument_symbol.as_deref(), Some("WSLV"));
        assert_eq!(draft.instrument_exchange_mic.as_deref(), Some("XETR"));
        assert_eq!(draft.provider_config, None);
    }

    #[tokio::test]
    async fn test_resolve_import_asset_inputs_suffix_mic_beats_wrong_provider_result_order() {
        let mut wrong_mic =
            yahoo_search_result("APC", "APC", "XNAS", "ARKO Petroleum Corp.", "USD", "APC");
        wrong_mic.score = 10_000.0;
        let mut correct_mic =
            yahoo_search_result("APC.DE", "APC", "XETR", "Apple Inc.", "EUR", "APC.DE");
        correct_mic.score = 1.0;
        let service = test_asset_service(
            Vec::new(),
            TestQuoteService::default().with_result("APC.DE", vec![wrong_mic, correct_mic]),
        );

        let output = service
            .resolve_import_asset_inputs(vec![import_input("APC.DE", "EUR")])
            .await
            .unwrap()
            .pop()
            .unwrap();

        assert_eq!(output.name.as_deref(), Some("Apple Inc."));
        assert_eq!(output.canonical_symbol.as_deref(), Some("APC"));
        assert_eq!(output.exchange_mic.as_deref(), Some("XETR"));
        assert_eq!(output.quote_ccy.as_deref(), Some("EUR"));
        assert_eq!(output.provider_symbol.as_deref(), Some("APC.DE"));
        assert_eq!(output.review_symbol.as_deref(), Some("APC.DE"));
    }

    #[tokio::test]
    async fn test_resolve_import_asset_inputs_crypto_pair_rejects_incompatible_equity_result() {
        let service = test_asset_service(
            Vec::new(),
            TestQuoteService::default().with_result(
                "BTC-USD",
                vec![yahoo_search_result(
                    "0P0001P539",
                    "0P0001P539",
                    "OTCM",
                    "Franklin Templeton SinoAm Btchlg -USD",
                    "USD",
                    "0P0001P539",
                )],
            ),
        );

        let output = service
            .resolve_import_asset_inputs(vec![import_input("BTC-USD", "USD")])
            .await
            .unwrap()
            .pop()
            .unwrap();

        assert_eq!(output.canonical_symbol.as_deref(), Some("BTC"));
        assert_eq!(output.exchange_mic, None);
        assert_eq!(output.quote_ccy.as_deref(), Some("USD"));
        assert_eq!(output.instrument_type, Some(InstrumentType::Crypto));
        assert_eq!(output.provider_symbol, None);
        assert_eq!(output.review_symbol.as_deref(), Some("BTC"));

        let draft = output.draft.expect("new crypto draft");
        assert_eq!(draft.display_code.as_deref(), Some("BTC"));
        assert_eq!(draft.instrument_symbol.as_deref(), Some("BTC"));
        assert_eq!(draft.instrument_exchange_mic, None);
        assert_eq!(draft.instrument_type, Some(InstrumentType::Crypto));
    }

    #[tokio::test]
    async fn test_resolve_import_asset_inputs_crypto_pair_prefers_crypto_over_high_score_equity() {
        let mut bad_equity = yahoo_search_result(
            "0P0001P539",
            "0P0001P539",
            "OTCM",
            "Franklin Templeton SinoAm Btchlg -USD",
            "USD",
            "0P0001P539",
        );
        bad_equity.score = 10_000.0;
        let mut crypto_result =
            yahoo_search_result("BTC-USD", "BTC", "", "Bitcoin USD", "USD", "BTC-USD");
        crypto_result.quote_type = "CRYPTOCURRENCY".to_string();
        crypto_result.type_display = "Crypto".to_string();
        crypto_result.exchange_mic = None;
        crypto_result.canonical_exchange_mic = None;
        crypto_result.score = 1.0;

        let service = test_asset_service(
            Vec::new(),
            TestQuoteService::default().with_result("BTC-USD", vec![bad_equity, crypto_result]),
        );

        let output = service
            .resolve_import_asset_inputs(vec![import_input("BTC-USD", "USD")])
            .await
            .unwrap()
            .pop()
            .unwrap();

        assert_eq!(output.canonical_symbol.as_deref(), Some("BTC"));
        assert_eq!(output.exchange_mic, None);
        assert_eq!(output.quote_ccy.as_deref(), Some("USD"));
        assert_eq!(output.instrument_type, Some(InstrumentType::Crypto));
        assert_eq!(output.provider_symbol.as_deref(), Some("BTC-USD"));
        assert_eq!(output.review_symbol.as_deref(), Some("BTC"));
        assert_eq!(output.provider_config, None);
    }

    #[tokio::test]
    async fn test_resolve_import_asset_inputs_exact_hyphenated_equity_can_override_weak_crypto_shape(
    ) {
        let service = test_asset_service(
            Vec::new(),
            TestQuoteService::default().with_result(
                "ABC-USD",
                vec![yahoo_search_result(
                    "ABC-USD",
                    "ABC-USD",
                    "XNYS",
                    "ABC USD Preference Shares",
                    "USD",
                    "ABC-USD",
                )],
            ),
        );

        let output = service
            .resolve_import_asset_inputs(vec![import_input("ABC-USD", "USD")])
            .await
            .unwrap()
            .pop()
            .unwrap();

        assert_eq!(output.canonical_symbol.as_deref(), Some("ABC-USD"));
        assert_eq!(output.exchange_mic.as_deref(), Some("XNYS"));
        assert_eq!(output.instrument_type, Some(InstrumentType::Equity));
        assert_eq!(output.provider_symbol.as_deref(), Some("ABC-USD"));
        assert_eq!(output.review_symbol.as_deref(), Some("ABC-USD"));
    }

    #[tokio::test]
    async fn test_resolve_import_asset_inputs_uses_currency_suffix_for_unsuffixed_symbol() {
        let tsx = yahoo_search_result("SHOP.TO", "SHOP", "XTSE", "Shopify Inc.", "CAD", "SHOP.TO");
        let quote_service = TestQuoteService::default()
            .with_result("SHOP.TO", vec![tsx])
            .with_result(
                "SHOP",
                vec![yahoo_search_result(
                    "SHOP",
                    "SHOP",
                    "XNYS",
                    "Shopify Inc.",
                    "USD",
                    "SHOP",
                )],
            );
        let search_calls = Arc::clone(&quote_service.search_calls);
        let service = test_asset_service(Vec::new(), quote_service);

        let output = service
            .resolve_import_asset_inputs(vec![import_input("SHOP", "CAD")])
            .await
            .unwrap()
            .pop()
            .unwrap();

        assert_eq!(search_calls.lock().unwrap().as_slice(), ["SHOP.TO"]);
        assert_eq!(output.canonical_symbol.as_deref(), Some("SHOP"));
        assert_eq!(output.exchange_mic.as_deref(), Some("XTSE"));
        assert_eq!(output.quote_ccy.as_deref(), Some("CAD"));
        assert_eq!(output.provider_symbol.as_deref(), Some("SHOP.TO"));
        assert_eq!(output.review_symbol.as_deref(), Some("SHOP.TO"));
    }

    #[tokio::test]
    async fn test_resolve_import_asset_inputs_falls_back_to_raw_unsuffixed_symbol() {
        let nyse = yahoo_search_result("SHOP", "SHOP", "XNYS", "Shopify Inc.", "USD", "SHOP");
        let quote_service = TestQuoteService::default().with_result("SHOP", vec![nyse]);
        let search_calls = Arc::clone(&quote_service.search_calls);
        let service = test_asset_service(Vec::new(), quote_service);

        let output = service
            .resolve_import_asset_inputs(vec![import_input("SHOP", "CAD")])
            .await
            .unwrap()
            .pop()
            .unwrap();

        assert_eq!(search_calls.lock().unwrap().as_slice(), ["SHOP.TO", "SHOP"]);
        assert_eq!(output.canonical_symbol.as_deref(), Some("SHOP"));
        assert_eq!(output.exchange_mic.as_deref(), Some("XNYS"));
        assert_eq!(output.quote_ccy.as_deref(), Some("USD"));
        assert_eq!(output.provider_symbol.as_deref(), Some("SHOP"));
        assert_eq!(output.review_symbol.as_deref(), Some("SHOP"));
    }

    #[tokio::test]
    async fn test_resolve_import_asset_inputs_searches_provider_for_isin_only_input() {
        let isin = "US0378331005";
        let service = test_asset_service(
            Vec::new(),
            TestQuoteService::default().with_result(
                isin,
                vec![yahoo_search_result(
                    "AAPL",
                    "AAPL",
                    "XNAS",
                    "Apple Inc.",
                    "USD",
                    "AAPL",
                )],
            ),
        );
        let mut input = import_input("", "USD");
        input.key = "isin-only".to_string();
        input.isin = Some(isin.to_string());

        let output = service
            .resolve_import_asset_inputs(vec![input])
            .await
            .unwrap()
            .pop()
            .unwrap();

        assert_eq!(output.source_symbol, "");
        assert_eq!(output.canonical_symbol.as_deref(), Some("AAPL"));
        assert_eq!(output.exchange_mic.as_deref(), Some("XNAS"));
        assert_eq!(output.quote_ccy.as_deref(), Some("USD"));
        assert_eq!(output.provider_symbol.as_deref(), Some("AAPL"));
        assert!(output.draft.is_some());
    }

    #[tokio::test]
    async fn test_resolve_import_asset_inputs_uses_score_after_identity_constraints() {
        let mut lower_score =
            yahoo_search_result("ACME-A", "ACME", "XNYS", "Acme A", "USD", "ACME-A");
        lower_score.score = 1.0;
        let mut higher_score =
            yahoo_search_result("ACME-B", "ACME", "XNYS", "Acme B", "USD", "ACME-B");
        higher_score.score = 10_000.0;
        let service = test_asset_service(
            Vec::new(),
            TestQuoteService::default().with_result("ACME", vec![lower_score, higher_score]),
        );

        let output = service
            .resolve_import_asset_inputs(vec![import_input("ACME", "USD")])
            .await
            .unwrap()
            .pop()
            .unwrap();

        assert_eq!(output.canonical_symbol.as_deref(), Some("ACME"));
        assert_eq!(output.name.as_deref(), Some("Acme B"));
        assert_eq!(output.provider_symbol.as_deref(), Some("ACME-B"));
    }

    #[tokio::test]
    async fn test_resolve_import_asset_inputs_existing_isin_returns_canonical_identity() {
        let existing = Asset {
            id: "shop-nyse".to_string(),
            name: Some("Shopify Inc.".to_string()),
            display_code: Some("SHOP".to_string()),
            instrument_symbol: Some("SHOP".to_string()),
            instrument_exchange_mic: Some("XNYS".to_string()),
            instrument_type: Some(InstrumentType::Equity),
            quote_ccy: "USD".to_string(),
            kind: AssetKind::Investment,
            metadata: Some(serde_json::json!({
                "identifiers": {
                    "isin": "CA82509L1076"
                }
            })),
            ..Default::default()
        };
        let service = test_asset_service(vec![existing], TestQuoteService::default());
        let mut input = import_input("SHOP", "USD");
        input.isin = Some("ca82509l1076".to_string());

        let output = service
            .resolve_import_asset_inputs(vec![input])
            .await
            .unwrap()
            .pop()
            .unwrap();

        assert_eq!(output.existing_asset_id.as_deref(), Some("shop-nyse"));
        assert_eq!(output.canonical_symbol.as_deref(), Some("SHOP"));
        assert_eq!(output.exchange_mic.as_deref(), Some("XNYS"));
        assert_eq!(output.quote_ccy.as_deref(), Some("USD"));
        assert_eq!(output.name.as_deref(), Some("Shopify Inc."));
        assert!(output.draft.is_none());
    }

    #[tokio::test]
    async fn test_resolve_import_asset_inputs_uses_existing_asset_before_provider() {
        let existing = Asset {
            id: "shop-tsx".to_string(),
            name: Some("Shopify Inc.".to_string()),
            display_code: Some("SHOP".to_string()),
            instrument_symbol: Some("SHOP".to_string()),
            instrument_exchange_mic: Some("XTSE".to_string()),
            instrument_type: Some(InstrumentType::Equity),
            quote_ccy: "CAD".to_string(),
            kind: AssetKind::Investment,
            provider_config: Some(serde_json::json!({ "preferred_provider": "YAHOO" })),
            ..Default::default()
        };
        let quote_service = TestQuoteService::default().with_result(
            "SHOP.TO",
            vec![yahoo_search_result(
                "SHOP.TO",
                "SHOP",
                "XTSE",
                "Shopify Inc.",
                "CAD",
                "SHOP.TO",
            )],
        );
        let search_calls = Arc::clone(&quote_service.search_calls);
        let service = test_asset_service(vec![existing], quote_service);

        let output = service
            .resolve_import_asset_inputs(vec![import_input("SHOP.TO", "CAD")])
            .await
            .unwrap()
            .pop()
            .unwrap();

        assert!(search_calls.lock().unwrap().is_empty());
        assert_eq!(output.existing_asset_id.as_deref(), Some("shop-tsx"));
        assert_eq!(output.canonical_symbol.as_deref(), Some("SHOP"));
        assert_eq!(output.exchange_mic.as_deref(), Some("XTSE"));
        assert_eq!(output.quote_ccy.as_deref(), Some("CAD"));
        assert_eq!(output.review_symbol.as_deref(), Some("SHOP.TO"));
        assert!(output.draft.is_none());
    }

    #[tokio::test]
    async fn test_resolve_import_asset_inputs_uses_existing_provider_alias_before_provider() {
        let existing = Asset {
            id: "acme-us".to_string(),
            name: Some("Acme Corporation".to_string()),
            display_code: Some("ACME".to_string()),
            instrument_symbol: Some("ACME".to_string()),
            instrument_exchange_mic: Some("XNYS".to_string()),
            instrument_type: Some(InstrumentType::Equity),
            quote_ccy: "USD".to_string(),
            kind: AssetKind::Investment,
            provider_config: Some(serde_json::json!({
                "preferred_provider": "YAHOO",
                "overrides": {
                    "YAHOO": { "type": "equity_symbol", "symbol": "ACME-OLD" }
                }
            })),
            ..Default::default()
        };
        let quote_service = TestQuoteService::default().with_result(
            "ACME-OLD",
            vec![yahoo_search_result(
                "ACME-OLD",
                "ACME-OLD",
                "XNYS",
                "Wrong provider fallback",
                "USD",
                "ACME-OLD",
            )],
        );
        let search_calls = Arc::clone(&quote_service.search_calls);
        let service = test_asset_service(vec![existing], quote_service);

        let output = service
            .resolve_import_asset_inputs(vec![import_input("ACME-OLD", "USD")])
            .await
            .unwrap()
            .pop()
            .unwrap();

        assert!(search_calls.lock().unwrap().is_empty());
        assert_eq!(output.existing_asset_id.as_deref(), Some("acme-us"));
        assert_eq!(output.canonical_symbol.as_deref(), Some("ACME"));
        assert_eq!(output.exchange_mic.as_deref(), Some("XNYS"));
        assert_eq!(output.quote_ccy.as_deref(), Some("USD"));
        assert!(output.draft.is_none());
    }

    #[tokio::test]
    async fn test_resolve_import_asset_inputs_local_quote_disambiguates_unqualified_symbol() {
        let shop_nyse = Asset {
            id: "shop-nyse".to_string(),
            name: Some("Shopify Inc.".to_string()),
            display_code: Some("SHOP".to_string()),
            instrument_symbol: Some("SHOP".to_string()),
            instrument_exchange_mic: Some("XNYS".to_string()),
            instrument_type: Some(InstrumentType::Equity),
            quote_ccy: "USD".to_string(),
            kind: AssetKind::Investment,
            ..Default::default()
        };
        let shop_tsx = Asset {
            id: "shop-tsx".to_string(),
            name: Some("Shopify Inc.".to_string()),
            display_code: Some("SHOP".to_string()),
            instrument_symbol: Some("SHOP".to_string()),
            instrument_exchange_mic: Some("XTSE".to_string()),
            instrument_type: Some(InstrumentType::Equity),
            quote_ccy: "CAD".to_string(),
            kind: AssetKind::Investment,
            ..Default::default()
        };
        let quote_service = TestQuoteService::default().with_result(
            "SHOP",
            vec![yahoo_search_result(
                "SHOP.TO",
                "SHOP",
                "XTSE",
                "Shopify Inc.",
                "CAD",
                "SHOP.TO",
            )],
        );
        let search_calls = Arc::clone(&quote_service.search_calls);
        let service = test_asset_service(vec![shop_nyse, shop_tsx], quote_service);

        let output = service
            .resolve_import_asset_inputs(vec![import_input("SHOP", "CAD")])
            .await
            .unwrap()
            .pop()
            .unwrap();

        assert!(search_calls.lock().unwrap().is_empty());
        assert_eq!(output.existing_asset_id.as_deref(), Some("shop-tsx"));
        assert_eq!(output.canonical_symbol.as_deref(), Some("SHOP"));
        assert_eq!(output.exchange_mic.as_deref(), Some("XTSE"));
        assert_eq!(output.quote_ccy.as_deref(), Some("CAD"));
        assert!(output.draft.is_none());
    }

    #[tokio::test]
    async fn test_resolve_import_asset_inputs_unqualified_symbol_does_not_match_cross_listing_by_symbol_only(
    ) {
        let shop_tsx = Asset {
            id: "shop-tsx".to_string(),
            name: Some("Shopify Inc.".to_string()),
            display_code: Some("SHOP".to_string()),
            instrument_symbol: Some("SHOP".to_string()),
            instrument_exchange_mic: Some("XTSE".to_string()),
            instrument_type: Some(InstrumentType::Equity),
            quote_ccy: "CAD".to_string(),
            kind: AssetKind::Investment,
            ..Default::default()
        };
        let quote_service = TestQuoteService::default().with_result(
            "SHOP",
            vec![yahoo_search_result(
                "SHOP",
                "SHOP",
                "XNYS",
                "Shopify Inc.",
                "USD",
                "SHOP",
            )],
        );
        let search_calls = Arc::clone(&quote_service.search_calls);
        let service = test_asset_service(vec![shop_tsx], quote_service);

        let output = service
            .resolve_import_asset_inputs(vec![import_input("SHOP", "USD")])
            .await
            .unwrap()
            .pop()
            .unwrap();

        assert_eq!(search_calls.lock().unwrap().as_slice(), ["SHOP"]);
        assert_eq!(output.existing_asset_id, None);
        assert_eq!(output.canonical_symbol.as_deref(), Some("SHOP"));
        assert_eq!(output.exchange_mic.as_deref(), Some("XNYS"));
        assert_eq!(output.quote_ccy.as_deref(), Some("USD"));
        assert_eq!(output.review_symbol.as_deref(), Some("SHOP"));
        assert!(output.draft.is_some());
    }

    #[tokio::test]
    async fn test_resolve_import_asset_inputs_missing_activity_currency_uses_account_currency_to_avoid_cross_listing_match(
    ) {
        let shop_tsx = Asset {
            id: "shop-tsx".to_string(),
            name: Some("Shopify Inc.".to_string()),
            display_code: Some("SHOP".to_string()),
            instrument_symbol: Some("SHOP".to_string()),
            instrument_exchange_mic: Some("XTSE".to_string()),
            instrument_type: Some(InstrumentType::Equity),
            quote_ccy: "CAD".to_string(),
            kind: AssetKind::Investment,
            ..Default::default()
        };
        let quote_service = TestQuoteService::default().with_result(
            "SHOP",
            vec![yahoo_search_result(
                "SHOP",
                "SHOP",
                "XNYS",
                "Shopify Inc.",
                "USD",
                "SHOP",
            )],
        );
        let search_calls = Arc::clone(&quote_service.search_calls);
        let service = test_asset_service(vec![shop_tsx], quote_service);
        let mut input = import_input("SHOP", "USD");
        input.activity_currency = None;

        let output = service
            .resolve_import_asset_inputs(vec![input])
            .await
            .unwrap()
            .pop()
            .unwrap();

        assert_eq!(search_calls.lock().unwrap().as_slice(), ["SHOP"]);
        assert_eq!(output.existing_asset_id, None);
        assert_eq!(output.canonical_symbol.as_deref(), Some("SHOP"));
        assert_eq!(output.exchange_mic.as_deref(), Some("XNYS"));
        assert_eq!(output.quote_ccy.as_deref(), Some("USD"));
        assert_eq!(output.provider_symbol.as_deref(), Some("SHOP"));
        assert!(output.draft.is_some());
    }

    #[test]
    fn test_import_asset_review_symbol_branches() {
        assert_eq!(
            AssetService::import_asset_review_symbol(
                "",
                Some("XETR"),
                Some(&InstrumentType::Equity)
            ),
            None
        );
        assert_eq!(
            AssetService::import_asset_review_symbol(
                "SHOP",
                Some("XTSE"),
                Some(&InstrumentType::Equity)
            )
            .as_deref(),
            Some("SHOP.TO")
        );
        assert_eq!(
            AssetService::import_asset_review_symbol(
                "XAU",
                Some("XMIL"),
                Some(&InstrumentType::Metal)
            )
            .as_deref(),
            Some("XAU")
        );
        assert_eq!(
            AssetService::import_asset_review_symbol("BTC", None, Some(&InstrumentType::Crypto))
                .as_deref(),
            Some("BTC")
        );
        assert_eq!(
            AssetService::import_asset_review_symbol("EURUSD=X", None, Some(&InstrumentType::Fx))
                .as_deref(),
            Some("EURUSD=X")
        );
        assert_eq!(
            AssetService::import_asset_review_symbol(
                "US0378331005",
                Some("XNAS"),
                Some(&InstrumentType::Equity)
            )
            .as_deref(),
            Some("US0378331005")
        );
        assert_eq!(
            AssetService::import_asset_review_symbol(
                "ACME",
                Some("UNKNOWN"),
                Some(&InstrumentType::Equity)
            )
            .as_deref(),
            Some("ACME")
        );
    }

    #[test]
    fn test_provider_config_for_resolution_only_stores_required_overrides() {
        let deterministic = AssetService::provider_config_for_resolution(
            Some("YAHOO"),
            Some("SHOP.TO"),
            Some(&InstrumentType::Equity),
            Some("SHOP"),
            Some("XTSE"),
            Some("CAD"),
        );
        assert_eq!(deterministic, None);

        let share_class = AssetService::provider_config_for_resolution(
            Some("YAHOO"),
            Some("BRK-B"),
            Some(&InstrumentType::Equity),
            Some("BRK.B"),
            None,
            Some("USD"),
        );
        assert_eq!(share_class, None);

        let equity_override = AssetService::provider_config_for_resolution(
            Some("YAHOO"),
            Some("SHOP.TSX"),
            Some(&InstrumentType::Equity),
            Some("SHOP"),
            Some("XTSE"),
            Some("CAD"),
        )
        .unwrap();
        assert_eq!(
            equity_override.get("overrides"),
            Some(&serde_json::json!({
                "YAHOO": {
                    "type": "equity_symbol",
                    "symbol": "SHOP.TSX"
                }
            }))
        );

        let metal_override = AssetService::provider_config_for_resolution(
            Some("METAL_PRICE_API"),
            Some("XAU-1KG"),
            Some(&InstrumentType::Metal),
            Some("XAU"),
            None,
            Some("USD"),
        )
        .unwrap();
        assert_eq!(
            metal_override.get("overrides"),
            Some(&serde_json::json!({
                "METAL_PRICE_API": {
                    "type": "metal_symbol",
                    "symbol": "XAU-1KG",
                    "quote": "USD"
                }
            }))
        );

        let missing_crypto_quote = AssetService::provider_config_for_resolution(
            Some("YAHOO"),
            Some("BTC-USD"),
            Some(&InstrumentType::Crypto),
            Some("BTC"),
            None,
            None,
        );
        assert_eq!(missing_crypto_quote, None);

        assert_eq!(
            AssetService::provider_config_for_resolution(
                None,
                Some("SHOP.TO"),
                Some(&InstrumentType::Equity),
                Some("SHOP"),
                Some("XTSE"),
                Some("CAD"),
            ),
            None
        );
    }

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
        let provider_config = AssetService::inferred_provider_config(
            QuoteMode::Market,
            Some(&InstrumentType::Bond),
            Some("US91282CFT32"),
            None,
        );

        assert!(provider_config.is_none());
    }

    #[test]
    fn test_equity_provider_config_is_not_defaulted_to_yahoo() {
        let provider_config = AssetService::inferred_provider_config(
            QuoteMode::Market,
            Some(&InstrumentType::Equity),
            Some("SHOP"),
            Some("XTSE"),
        );

        assert!(provider_config.is_none());
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
