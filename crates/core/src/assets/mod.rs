//! Assets module - domain models, services, and traits.

mod alternative_assets_model;
mod alternative_assets_service;
mod alternative_assets_traits;
mod asset_id;
mod asset_resolution;
mod assets_constants;
mod assets_model;
mod assets_service;
mod assets_traits;
mod auto_classification;
mod classification_service;

#[cfg(test)]
mod assets_model_tests;

// Re-export the public interface
pub use alternative_assets_model::{
    AlternativeHolding, CreateAlternativeAssetRequest, CreateAlternativeAssetResponse,
    LinkLiabilityRequest, LinkLiabilityResponse, UpdateAssetDetailsRequest,
    UpdateAssetDetailsResponse, UpdateValuationRequest, UpdateValuationResponse,
};
pub use alternative_assets_service::AlternativeAssetService;
pub use alternative_assets_traits::{
    AlternativeAssetRepositoryTrait, AlternativeAssetServiceTrait,
};
pub use asset_id::{
    parse_crypto_pair_symbol, parse_symbol_with_exchange_suffix, symbol_resolution_candidates,
    unknown_dotted_suffix_fallback,
};
pub(crate) use asset_resolution::asset_provider_alias_symbols;
pub use asset_resolution::{AssetResolutionInput, AssetResolutionOutput};
pub use assets_model::{
    build_asset_metadata, build_option_metadata, canonicalize_market_identity,
    normalize_quote_ccy_code, resolve_import_quote_ccy_precedence, resolve_quote_ccy_precedence,
    Asset, AssetKind, AssetMetadata, AssetProfile, AssetSpec, BondSpec, Country,
    EnsureAssetsResult, InstrumentId, InstrumentType, NewAsset, OptionSpec, ProviderProfile,
    QuoteCcyResolutionSource, QuoteMode, Sector, UpdateAssetProfile,
};
pub use assets_service::AssetService;
pub use assets_traits::{AssetRepositoryTrait, AssetServiceTrait};
pub use auto_classification::{
    AutoClassificationService, ClassificationInput, ClassificationResult,
};
pub use classification_service::{
    AssetClassificationService, AssetClassifications, CategoryWithWeight,
};
