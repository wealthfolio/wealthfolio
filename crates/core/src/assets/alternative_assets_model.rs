//! Alternative Assets domain models.
//!
//! This module provides models for managing alternative assets such as
//! properties, vehicles, collectibles, precious metals, and liabilities.
//!
//! Alternative assets use a simplified value-based model:
//! - No dedicated accounts (avoids account clutter)
//! - No activities (avoids activity clutter)
//! - Just asset record + valuation quotes

use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::AssetKind;

/// Request for creating a new alternative asset.
///
/// This creates:
/// - A generated prefixed asset ID (e.g., PROP-a1b2c3d4)
/// - An asset record with metadata
/// - An initial valuation quote
///
/// NOTE: No account or activity is created - alternative assets are standalone.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAlternativeAssetRequest {
    /// The kind of alternative asset to create
    pub kind: AssetKind,
    /// User-provided name for the asset
    pub name: String,
    /// Currency for the asset
    pub currency: String,
    /// Current total value of the asset
    /// Users enter the total value directly (e.g., "$500,000" for a house)
    pub current_value: Decimal,
    /// Date of the valuation
    pub value_date: NaiveDate,
    /// Optional purchase price for gain calculation
    pub purchase_price: Option<Decimal>,
    /// Optional purchase date
    pub purchase_date: Option<NaiveDate>,
    /// Optional kind-specific metadata
    /// Example for Property: { "sub_type": "residence", "address": "123 Main St" }
    /// Example for Liability: { "sub_type": "mortgage", "linked_asset_id": "PROP-a1b2c3d4" }
    pub metadata: Option<Value>,
    /// For liabilities only: ID of the asset this liability finances (UI-only aggregation)
    pub linked_asset_id: Option<String>,
}

/// Response after creating an alternative asset.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAlternativeAssetResponse {
    /// The generated asset ID (e.g., "PROP-a1b2c3d4")
    pub asset_id: String,
    /// The initial valuation quote ID
    pub quote_id: String,
}

/// Request for updating an alternative asset's valuation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateValuationRequest {
    /// The asset ID to update valuation for
    pub asset_id: String,
    /// New valuation value
    pub value: Decimal,
    /// Date of the new valuation
    pub date: NaiveDate,
    /// Optional notes about the valuation
    pub notes: Option<String>,
}

/// Response after updating valuation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateValuationResponse {
    /// The created quote ID
    pub quote_id: String,
    /// The valuation date
    pub valuation_date: NaiveDate,
    /// The new value
    pub value: Decimal,
}

/// Request for linking a liability to an asset.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkLiabilityRequest {
    /// The liability asset ID (must be a liability)
    pub liability_id: String,
    /// The target asset ID to link to (e.g., property or vehicle)
    pub target_asset_id: String,
}

/// Response after linking/unlinking a liability.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkLiabilityResponse {
    /// The liability asset ID
    pub liability_id: String,
    /// The linked asset ID (None if unlinked)
    pub linked_asset_id: Option<String>,
}

/// Alternative holding for display in the Holdings page.
///
/// This is a simplified view of an alternative asset with its current valuation,
/// designed to be compatible with the Holding display format used for investments.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlternativeHolding {
    /// Asset ID (e.g., "PROP-a1b2c3d4")
    pub id: String,
    /// Asset kind (Property, Vehicle, Collectible, etc.)
    pub kind: AssetKind,
    /// Asset name
    pub name: String,
    /// Asset symbol (display type label, e.g., "Property", "Vehicle")
    pub symbol: String,
    /// Currency
    pub currency: String,
    /// Current market value (from latest quote)
    pub market_value: Decimal,
    /// Purchase price (from metadata, for gain calculation)
    pub purchase_price: Option<Decimal>,
    /// Purchase date (from metadata)
    pub purchase_date: Option<NaiveDate>,
    /// Unrealized gain (market_value - purchase_price)
    pub unrealized_gain: Option<Decimal>,
    /// Unrealized gain percentage
    pub unrealized_gain_pct: Option<Decimal>,
    /// Date of the latest valuation
    pub valuation_date: DateTime<Utc>,
    /// Asset metadata (sub_type, linked_asset_id, address, etc.)
    pub metadata: Option<Value>,
    /// For liabilities: the asset this liability is linked to
    pub linked_asset_id: Option<String>,
    /// Asset notes
    pub notes: Option<String>,
}

/// Request for updating an alternative asset's details.
///
/// This merges the provided fields with existing values.
/// If purchase_price or purchase_date changes, the purchase quote is also updated.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAssetDetailsRequest {
    /// The asset ID to update
    pub asset_id: String,
    /// Optional new name for the asset
    pub name: Option<String>,
    /// Optional notes for the asset (stored in asset.notes, not metadata)
    pub notes: Option<String>,
    /// Optional new metadata (merged with existing)
    /// Keys with None values are removed
    pub metadata: Option<std::collections::HashMap<String, Option<String>>>,
}

/// Response after updating asset details.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAssetDetailsResponse {
    /// The asset ID that was updated
    pub asset_id: String,
    /// Whether the purchase quote was updated
    pub purchase_quote_updated: bool,
}
