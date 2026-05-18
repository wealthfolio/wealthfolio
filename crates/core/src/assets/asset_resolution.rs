use serde_json::Value;
use std::borrow::Cow;

use super::{Asset, AssetKind, InstrumentType, NewAsset, QuoteCcyResolutionSource, QuoteMode};
use wealthfolio_market_data::{
    ProviderId, ProviderInstrument, ProviderOverrides, QuoteContext, ResolverChain, SymbolResolver,
};

#[derive(Debug, Clone)]
pub struct AssetResolutionInput {
    pub key: String,
    pub source_symbol: String,
    pub account_currency: String,
    pub activity_currency: Option<String>,
    pub exchange_mic: Option<String>,
    pub quote_ccy: Option<String>,
    pub instrument_type: Option<InstrumentType>,
    pub quote_mode: Option<QuoteMode>,
    pub isin: Option<String>,
    pub asset_id: Option<String>,
    pub provider_id: Option<String>,
    pub provider_symbol: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct AssetResolutionOutput {
    pub key: String,
    pub source_symbol: String,
    pub canonical_symbol: Option<String>,
    pub exchange_mic: Option<String>,
    pub quote_ccy: Option<String>,
    pub quote_ccy_source: Option<QuoteCcyResolutionSource>,
    pub instrument_type: Option<InstrumentType>,
    pub kind: Option<AssetKind>,
    pub provider_id: Option<String>,
    pub provider_symbol: Option<String>,
    pub provider_config: Option<Value>,
    pub review_symbol: Option<String>,
    pub existing_asset_id: Option<String>,
    pub name: Option<String>,
    pub draft: Option<NewAsset>,
}

fn provider_overrides_for_asset(asset: &Asset) -> Option<ProviderOverrides> {
    asset
        .provider_overrides()
        .and_then(|json| ProviderOverrides::from_json(json).ok())
}

fn custom_provider_code(asset: &Asset) -> Option<String> {
    asset
        .provider_config
        .as_ref()
        .and_then(|config| config.get("custom_provider_code"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(crate) fn asset_provider_alias_symbols(asset: &Asset) -> Vec<String> {
    let mut aliases = Vec::new();
    if let Some(overrides) = provider_overrides_for_asset(asset) {
        aliases.extend(
            overrides
                .overrides
                .values()
                .map(ProviderInstrument::to_symbol_string),
        );
    }
    if let Some(custom_code) = custom_provider_code(asset) {
        aliases.push(custom_code);
    }
    if let (Some(provider), Some(instrument)) =
        (asset.preferred_provider(), asset.to_instrument_id())
    {
        let context = QuoteContext {
            instrument,
            overrides: provider_overrides_for_asset(asset),
            currency_hint: (!asset.quote_ccy.trim().is_empty())
                .then(|| Cow::Owned(asset.quote_ccy.clone())),
            preferred_provider: Some(Cow::Owned(provider.clone())),
            bond_metadata: None,
            custom_provider_code: custom_provider_code(asset),
        };
        let provider_id: ProviderId = Cow::Owned(provider);
        if let Ok(resolved) = ResolverChain::new().resolve(&provider_id, &context) {
            aliases.push(resolved.instrument.to_symbol_string());
        }
    }

    aliases.sort_by_key(|alias| alias.to_uppercase());
    aliases.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
    aliases
}
