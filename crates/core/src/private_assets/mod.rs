//! Private assets module - domain models for the private ledger subsystem.

mod private_assets_model;
mod private_assets_projection_service;
mod private_assets_service;
mod private_assets_traits;

pub use private_assets_model::{
    FundManager, NewFundManager, NewPrivateAsset, NewPrivateSnapshot, NewPrivateSubAsset,
    PrivateAsset, PrivateAssetCurrentTotals, PrivateAssetDetail, PrivateAssetFreshnessState,
    PrivateAssetHistoricalPoint, PrivateAssetListRow, PrivateAssetStatus, PrivateAssetStrategyType,
    PrivateAssetVehicleKind, PrivateSnapshot, PrivateSnapshotCashFlowType,
    PrivateSnapshotValueSourceType, PrivateSubAsset, PrivateSubAssetReportingBasis,
    UpdateFundManager, UpdatePrivateAsset, UpdatePrivateSnapshot, UpdatePrivateSubAsset,
};
pub use private_assets_projection_service::{
    derive_private_asset_freshness, PrivateAssetProjectionService,
};
pub use private_assets_service::PrivateAssetsService;
pub use private_assets_traits::{
    FundManagerRepositoryTrait, PrivateAssetProjectionServiceTrait, PrivateAssetRepositoryTrait,
    PrivateAssetsServiceTrait, PrivateSnapshotRepositoryTrait, PrivateSubAssetRepositoryTrait,
};
