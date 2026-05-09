//! Alternative Assets service and repository traits.
//!
//! These traits define the contract for alternative asset operations
//! (properties, vehicles, collectibles, precious metals, liabilities).
//!
//! Alternative assets use a simplified model:
//! - No dedicated accounts (avoids account clutter)
//! - No activities (avoids activity clutter)
//! - Just asset record + valuation quotes

use async_trait::async_trait;

use super::alternative_assets_model::{
    AlternativeHolding, CreateAlternativeAssetRequest, CreateAlternativeAssetResponse,
    LinkLiabilityRequest, LinkLiabilityResponse, UpdateAssetDetailsRequest,
    UpdateAssetDetailsResponse, UpdateValuationRequest, UpdateValuationResponse,
};
use crate::errors::Result;

/// Trait defining the contract for Alternative Asset service operations.
///
/// The service layer handles business logic for creating, updating,
/// and deleting alternative assets.
#[async_trait]
pub trait AlternativeAssetServiceTrait: Send + Sync {
    /// Creates a new alternative asset.
    ///
    /// This operation:
    /// 1. Generates a prefixed asset ID (e.g., PROP-a1b2c3d4)
    /// 2. Creates the asset record with metadata
    /// 3. Inserts the initial valuation as a quote (data_source = MANUAL)
    ///
    /// NOTE: No account or activity is created - alternative assets are standalone.
    ///
    /// # Arguments
    /// * `request` - The request containing asset details
    ///
    /// # Returns
    /// A response containing the asset ID and quote ID
    async fn create_alternative_asset(
        &self,
        request: CreateAlternativeAssetRequest,
    ) -> Result<CreateAlternativeAssetResponse>;

    /// Updates the valuation of an alternative asset.
    ///
    /// This inserts a new quote with data_source = MANUAL.
    /// Uses (symbol, data_source, date) uniqueness - will replace
    /// existing valuation for the same date if one exists.
    ///
    /// # Arguments
    /// * `request` - The valuation update request
    ///
    /// # Returns
    /// A response containing the quote details
    async fn update_valuation(
        &self,
        request: UpdateValuationRequest,
    ) -> Result<UpdateValuationResponse>;

    /// Deletes an alternative asset and associated data.
    ///
    /// This is a transactional operation that:
    /// 1. Unlinks any liabilities referencing this asset
    /// 2. Deletes all quotes for this asset (WHERE data_source = 'MANUAL')
    /// 3. Deletes the asset record
    ///
    /// # Arguments
    /// * `asset_id` - The ID of the alternative asset to delete
    ///
    /// # Returns
    /// Ok(()) on success
    async fn delete_alternative_asset(&self, asset_id: &str) -> Result<()>;

    /// Links a liability to an asset (UI-only aggregation).
    ///
    /// Updates the liability's metadata to add the linked_asset_id.
    /// This does NOT move the liability into the property's account -
    /// it's purely for UI presentation.
    ///
    /// # Arguments
    /// * `request` - The link request with liability and target asset IDs
    ///
    /// # Returns
    /// A response confirming the link
    async fn link_liability(&self, request: LinkLiabilityRequest) -> Result<LinkLiabilityResponse>;

    /// Unlinks a liability from its associated asset.
    ///
    /// Removes the linked_asset_id from the liability's metadata.
    /// The liability remains in its own account.
    ///
    /// # Arguments
    /// * `liability_id` - The ID of the liability to unlink
    ///
    /// # Returns
    /// A response confirming the unlink
    async fn unlink_liability(&self, liability_id: &str) -> Result<LinkLiabilityResponse>;

    /// Updates an alternative asset's details (name and/or metadata).
    ///
    /// This operation:
    /// 1. Merges new metadata with existing metadata
    /// 2. Recalculates symbol from updated metadata
    /// 3. If purchase_price or purchase_date changed, updates/creates the purchase quote
    ///
    /// # Arguments
    /// * `request` - The update request with new values
    ///
    /// # Returns
    /// A response indicating what was updated
    async fn update_asset_details(
        &self,
        request: UpdateAssetDetailsRequest,
    ) -> Result<UpdateAssetDetailsResponse>;

    /// Gets all alternative holdings (assets with their latest valuations).
    ///
    /// This retrieves all alternative assets (Property, Vehicle, Collectible,
    /// PhysicalPrecious, Liability, Other) with their latest quote values,
    /// formatted for display in the Holdings page.
    ///
    /// # Returns
    /// A list of alternative holdings with current valuations and gain calculations
    fn get_alternative_holdings(&self) -> Result<Vec<AlternativeHolding>>;
}

/// Trait for alternative asset repository operations.
///
/// The repository handles the transactional persistence operations
/// for alternative assets. It works with raw database types and
/// coordinates multi-table operations within transactions.
#[async_trait]
pub trait AlternativeAssetRepositoryTrait: Send + Sync {
    /// Deletes an alternative asset and all associated entities transactionally.
    ///
    /// # Arguments
    /// * `asset_id` - The ID of the alternative asset to delete
    ///
    /// # Returns
    /// Ok(()) on success
    async fn delete_alternative_asset(&self, asset_id: &str) -> Result<()>;

    /// Updates an asset's metadata (for linking/unlinking liabilities).
    ///
    /// # Arguments
    /// * `asset_id` - The ID of the asset to update
    /// * `metadata` - The new metadata JSON
    ///
    /// # Returns
    /// Ok(()) on success
    async fn update_asset_metadata(
        &self,
        asset_id: &str,
        metadata: Option<serde_json::Value>,
    ) -> Result<()>;

    /// Finds all liabilities linked to the given asset.
    ///
    /// # Arguments
    /// * `linked_asset_id` - The asset ID to find linked liabilities for
    ///
    /// # Returns
    /// List of liability asset IDs
    fn find_liabilities_linked_to(&self, linked_asset_id: &str) -> Result<Vec<String>>;

    /// Updates an asset's details (name and/or metadata).
    ///
    /// # Arguments
    /// * `asset_id` - The ID of the asset to update
    /// * `name` - Optional new name for the asset
    /// * `display_code` - Optional new display code for the asset
    /// * `metadata` - Optional new metadata JSON
    /// * `notes` - Optional notes for the asset
    ///
    /// # Returns
    /// Ok(()) on success
    async fn update_asset_details(
        &self,
        asset_id: &str,
        name: Option<&str>,
        display_code: Option<&str>,
        metadata: Option<serde_json::Value>,
        notes: Option<&str>,
    ) -> Result<()>;
}
