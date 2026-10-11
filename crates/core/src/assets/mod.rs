//! Assets module - domain models, services, and traits.

mod alternative_assets_model;
mod alternative_assets_service;
mod alternative_assets_traits;
mod asset_id;
mod asset_logo_model;
mod asset_logo_service;
mod asset_logo_traits;
mod asset_resolution;
mod assets_constants;
mod assets_model;
mod assets_service;
mod assets_traits;
mod auto_classification;
mod bond_identity;
mod classification_service;
pub mod loan;

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
    AlternativeAssetRepositoryTrait, AlternativeAssetServiceTrait, LoanChange, PaymentTagChange,
};
pub use asset_id::{
    parse_crypto_pair_symbol, parse_symbol_with_exchange_suffix, parse_symbol_with_known_exchange,
    symbol_resolution_candidates,
};
pub use asset_logo_model::{
    decode_and_validate as decode_and_validate_asset_logo, AssetLogo, AssetLogoSummary,
    UpsertAssetLogo, ValidatedPng, ASSET_LOGO_MIME_PNG, MAX_ASSET_LOGO_BYTES,
    MAX_ASSET_LOGO_DIMENSION,
};
pub use asset_logo_service::AssetLogoService;
pub use asset_logo_traits::{AssetLogoRepositoryTrait, AssetLogoServiceTrait};
pub(crate) use asset_resolution::{asset_provider_alias_symbols, custom_provider_code};
pub use asset_resolution::{AssetResolutionInput, AssetResolutionOutput};
pub use assets_model::{
    build_asset_metadata, build_option_metadata, canonicalize_market_identity,
    contract_multiplier_from_asset_metadata, instrument_default_multiplier,
    normalize_quote_ccy_code, resolve_import_quote_ccy_precedence, resolve_quote_ccy_precedence,
    Asset, AssetKind, AssetMetadata, AssetProfile, AssetSpec, BondSpec, Country,
    EnsureAssetsResult, InstrumentId, InstrumentType, NewAsset, OptionSpec, ProviderProfile,
    QuoteCcyResolutionSource, QuoteMode, Sector, UpdateAssetProfile,
    CONTRACT_MULTIPLIER_METADATA_KEY,
};
pub use assets_service::AssetService;
pub use assets_traits::{AssetRepositoryTrait, AssetServiceTrait};
pub use auto_classification::{
    AutoClassificationService, ClassificationInput, ClassificationResult,
};
pub(crate) use bond_identity::resolve_bond_aliases;
pub use classification_service::{
    AssetClassificationService, AssetClassifications, CategoryWithWeight,
};
