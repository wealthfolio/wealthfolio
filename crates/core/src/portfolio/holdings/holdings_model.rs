use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::assets::{AssetClassifications, AssetKind};
use crate::lots::LotRecord;

/// Display-oriented lot view for the API response.
/// Converted directly from LotRecord, independent of the calculation Lot struct.
///
/// Quantity and price fields are reported in **as-acquired** (original) units.
/// `split_ratio` carries the cumulative post-acquisition split factor; the UI
/// can compute effective current shares as `remaining_quantity * split_ratio`
/// and adjusted per-current-share basis as `cost_per_unit / split_ratio`. A
/// `split_ratio` other than 1 means the row is presenting pre-split numbers
/// and the UI should label it accordingly (badge, tooltip, paired column).
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LotView {
    pub id: String,
    pub account_id: String,
    pub acquisition_date: String,
    pub original_quantity: Decimal,
    pub remaining_quantity: Decimal,
    pub cost_per_unit: Decimal,
    pub total_cost_basis: Decimal,
    pub fees: Decimal,
    /// Cumulative post-acquisition SPLIT factor. Defaults to 1 (no splits).
    pub split_ratio: Decimal,
    pub is_closed: bool,
    pub close_date: Option<String>,
}

impl LotView {
    pub fn from_record(r: &LotRecord) -> Option<Self> {
        let split_ratio: Decimal = r
            .split_ratio
            .parse()
            .ok()
            .filter(|v: &Decimal| !v.is_zero())
            .unwrap_or(Decimal::ONE);
        Some(LotView {
            id: r.id.clone(),
            account_id: r.account_id.clone(),
            acquisition_date: r.open_date.clone(),
            original_quantity: r.original_quantity.parse().ok()?,
            remaining_quantity: r.remaining_quantity.parse().ok()?,
            cost_per_unit: r.cost_per_unit.parse().ok()?,
            total_cost_basis: r.total_cost_basis.parse().ok()?,
            fees: r.fee_allocated.parse().unwrap_or_default(),
            split_ratio,
            is_closed: r.is_closed,
            close_date: r.close_date.clone(),
        })
    }
}

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

    /// Lot view including open and closed lots, for the lots tab display.
    /// Populated only when a specific asset's lots are requested.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lot_details: Option<Vec<LotView>>,

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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lots::{DisposalMethod, HoldingPeriod, LotRecord};
    use rust_decimal_macros::dec;

    fn make_lot_record(id: &str, account_id: &str, asset_id: &str, is_closed: bool) -> LotRecord {
        LotRecord {
            id: id.to_string(),
            account_id: account_id.to_string(),
            asset_id: asset_id.to_string(),
            open_date: "2025-06-15".to_string(),
            open_activity_id: Some("act-1".to_string()),
            original_quantity: "100".to_string(),
            remaining_quantity: if is_closed {
                "0".to_string()
            } else {
                "75".to_string()
            },
            cost_per_unit: "150.50".to_string(),
            total_cost_basis: "11287.50".to_string(),
            fee_allocated: "12.50".to_string(),
            split_ratio: "1".to_string(),
            disposal_method: DisposalMethod::Fifo,
            is_closed,
            close_date: if is_closed {
                Some("2026-01-10".to_string())
            } else {
                None
            },
            close_activity_id: None,
            is_wash_sale: false,
            holding_period: Some(HoldingPeriod::LongTerm),
            created_at: "2025-06-15T00:00:00Z".to_string(),
            updated_at: "2025-06-15T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn lot_view_from_open_record() {
        let record = make_lot_record("lot-1", "acc-1", "NVDA", false);
        let view = LotView::from_record(&record).unwrap();

        assert_eq!(view.id, "lot-1");
        assert_eq!(view.account_id, "acc-1");
        assert_eq!(view.acquisition_date, "2025-06-15");
        assert_eq!(view.original_quantity, dec!(100));
        assert_eq!(view.remaining_quantity, dec!(75));
        assert_eq!(view.cost_per_unit, dec!(150.50));
        assert_eq!(view.fees, dec!(12.50));
        assert!(!view.is_closed);
        assert!(view.close_date.is_none());
    }

    #[test]
    fn lot_view_from_closed_record() {
        let record = make_lot_record("lot-2", "acc-1", "NVDA", true);
        let view = LotView::from_record(&record).unwrap();

        assert!(view.is_closed);
        assert_eq!(view.remaining_quantity, dec!(0));
        assert_eq!(view.close_date, Some("2026-01-10".to_string()));
    }

    #[test]
    fn lot_view_returns_none_for_unparseable_quantity() {
        let mut record = make_lot_record("lot-3", "acc-1", "NVDA", false);
        record.original_quantity = "not_a_number".to_string();

        assert!(LotView::from_record(&record).is_none());
    }

    #[test]
    fn lot_view_defaults_fees_to_zero() {
        let mut record = make_lot_record("lot-4", "acc-1", "NVDA", false);
        record.fee_allocated = "".to_string();
        let view = LotView::from_record(&record).unwrap();

        assert_eq!(view.fees, dec!(0));
    }
}
