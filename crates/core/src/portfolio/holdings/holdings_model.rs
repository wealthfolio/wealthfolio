use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::VecDeque;

// Import Lot from its definition
use crate::assets::{AssetClassifications, AssetKind};
use crate::portfolio::snapshot::Lot;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum HoldingType {
    Cash,
    Security,
    /// Alternative assets: Property, Vehicle, Collectible, PhysicalPrecious, Liability, Other
    /// These assets use MANUAL data source for valuations and are excluded from TWR/IRR calculations.
    AlternativeAsset,
}

/// Instrument data needed for display
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Instrument {
    pub id: String,
    pub symbol: String,
    pub name: Option<String>,
    pub currency: String,
    pub notes: Option<String>,
    pub pricing_mode: String,
    pub preferred_provider: Option<String>,
    pub exchange_mic: Option<String>,

    // Taxonomy-based classifications
    pub classifications: Option<AssetClassifications>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MonetaryValue {
    pub local: Decimal,
    pub base: Decimal,
}

impl MonetaryValue {
    pub fn zero() -> Self {
        MonetaryValue {
            local: Decimal::ZERO,
            base: Decimal::ZERO,
        }
    }
}

/// Lightweight holding summary for allocation drill-down views.
/// Contains only the fields needed to display a list of holdings for a category.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HoldingSummary {
    pub id: String,
    pub symbol: String,
    pub name: Option<String>,
    pub holding_type: HoldingType,
    pub quantity: Decimal,
    pub market_value: Decimal,
    pub currency: String,
    pub weight_in_category: Decimal,
}

/// Position view model for frontend display with daily and total performance
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Holding {
    // Core identification
    pub id: String,
    pub account_id: String,

    // Position type and instrument info
    pub holding_type: HoldingType,
    pub instrument: Option<Instrument>,

    /// The asset kind classification (Security, Crypto, Property, Vehicle, etc.)
    /// Used to determine valuation logic and performance inclusion.
    pub asset_kind: Option<AssetKind>,

    // Position data
    pub quantity: Decimal,
    pub open_date: Option<DateTime<Utc>>,
    pub lots: Option<VecDeque<Lot>>,

    /// Contract multiplier for derivatives (e.g., 100 for equity options). Defaults to 1.
    pub contract_multiplier: Decimal,

    // Currency info
    pub local_currency: String,
    pub base_currency: String,
    pub fx_rate: Option<Decimal>,

    // Current valuation
    pub market_value: MonetaryValue,
    pub cost_basis: Option<MonetaryValue>,
    pub price: Option<Decimal>,

    /// Purchase price from asset metadata (for alternative assets).
    /// Used to calculate gain when no lot-based cost basis is available.
    pub purchase_price: Option<Decimal>,

    // Total performance (since inception or purchase)
    pub unrealized_gain: Option<MonetaryValue>,
    pub unrealized_gain_pct: Option<Decimal>,
    pub realized_gain: Option<MonetaryValue>,
    pub realized_gain_pct: Option<Decimal>,
    pub total_gain: Option<MonetaryValue>,
    pub total_gain_pct: Option<Decimal>,

    // Daily performance
    pub day_change: Option<MonetaryValue>,
    pub day_change_pct: Option<Decimal>,
    pub prev_close_value: Option<MonetaryValue>,

    // Portfolio allocation
    pub weight: Decimal,

    // Reference date for performance calculations
    pub as_of_date: NaiveDate,

    /// Asset metadata (JSON) for alternative assets.
    /// Contains purchase_price, purchase_date, sub_type, linked_asset_id, etc.
    pub metadata: Option<Value>,

    /// Source account IDs for aggregated holdings (portfolio or multi-account scope).
    /// Empty for single-account holdings; `account_id` is then the authoritative identity.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub source_account_ids: Vec<String>,
}
