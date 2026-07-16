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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_name: Option<String>,
    pub holding_type: HoldingType,
    pub quantity: Decimal,
    pub market_value: Decimal,
    pub currency: String,
    pub weight_in_category: Decimal,
    /// Actual market price per share from the quote provider.
    /// Use this for trade sizing instead of market_value/quantity,
    /// which gives a wrong result when market_value is weighted across categories.
    pub unit_price: Option<Decimal>,
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
    pub income: Option<MonetaryValue>,
    pub total_return: Option<MonetaryValue>,
    pub total_return_pct: Option<Decimal>,
    pub return_basis: Option<MonetaryValue>,

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

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HoldingListInstrument {
    pub id: String,
    pub symbol: String,
    pub name: Option<String>,
    pub currency: String,
    #[serde(rename = "quoteMode")]
    pub quote_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub isin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exchange_mic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub classifications: Option<AssetClassifications>,
}

/// List-oriented holding payload for app tables and dashboards.
/// Omits full asset profile fields such as notes, provider config, lots, and metadata.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HoldingListItem {
    pub id: String,
    pub account_id: String,
    pub holding_type: HoldingType,
    pub instrument: Option<HoldingListInstrument>,
    pub asset_kind: Option<AssetKind>,
    pub quantity: Decimal,
    pub open_date: Option<DateTime<Utc>>,
    pub contract_multiplier: Decimal,
    pub local_currency: String,
    pub base_currency: String,
    pub fx_rate: Option<Decimal>,
    pub market_value: MonetaryValue,
    pub cost_basis: Option<MonetaryValue>,
    pub price: Option<Decimal>,
    pub unrealized_gain: Option<MonetaryValue>,
    pub unrealized_gain_pct: Option<Decimal>,
    pub realized_gain: Option<MonetaryValue>,
    pub realized_gain_pct: Option<Decimal>,
    pub total_gain: Option<MonetaryValue>,
    pub total_gain_pct: Option<Decimal>,
    pub income: Option<MonetaryValue>,
    pub total_return: Option<MonetaryValue>,
    pub total_return_pct: Option<Decimal>,
    pub return_basis: Option<MonetaryValue>,
    pub day_change: Option<MonetaryValue>,
    pub day_change_pct: Option<Decimal>,
    pub prev_close_value: Option<MonetaryValue>,
    pub weight: Decimal,
    pub as_of_date: NaiveDate,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub source_account_ids: Vec<String>,
}

impl From<Holding> for HoldingListItem {
    fn from(holding: Holding) -> Self {
        let isin = holding_metadata_isin(holding.metadata.as_ref());
        let instrument = holding.instrument.map(|instrument| {
            let classifications = instrument
                .classifications
                .as_ref()
                .and_then(|classifications| {
                    classifications.asset_type.as_ref()?;
                    Some(AssetClassifications {
                        asset_type: classifications.asset_type.clone(),
                        ..AssetClassifications::default()
                    })
                });

            HoldingListInstrument {
                id: instrument.id,
                symbol: instrument.symbol,
                name: instrument.name,
                currency: instrument.currency,
                quote_mode: instrument.pricing_mode,
                isin,
                exchange_mic: instrument.exchange_mic,
                classifications,
            }
        });

        Self {
            id: holding.id,
            account_id: holding.account_id,
            holding_type: holding.holding_type,
            instrument,
            asset_kind: holding.asset_kind,
            quantity: holding.quantity,
            open_date: holding.open_date,
            contract_multiplier: holding.contract_multiplier,
            local_currency: holding.local_currency,
            base_currency: holding.base_currency,
            fx_rate: holding.fx_rate,
            market_value: holding.market_value,
            cost_basis: holding.cost_basis,
            price: holding.price,
            unrealized_gain: holding.unrealized_gain,
            unrealized_gain_pct: holding.unrealized_gain_pct,
            realized_gain: holding.realized_gain,
            realized_gain_pct: holding.realized_gain_pct,
            total_gain: holding.total_gain,
            total_gain_pct: holding.total_gain_pct,
            income: holding.income,
            total_return: holding.total_return,
            total_return_pct: holding.total_return_pct,
            return_basis: holding.return_basis,
            day_change: holding.day_change,
            day_change_pct: holding.day_change_pct,
            prev_close_value: holding.prev_close_value,
            weight: holding.weight,
            as_of_date: holding.as_of_date,
            source_account_ids: holding.source_account_ids,
        }
    }
}

fn holding_metadata_isin(metadata: Option<&Value>) -> Option<String> {
    metadata
        .and_then(|metadata| {
            metadata
                .pointer("/identifiers/isin")
                .or_else(|| metadata.pointer("/bond/isin"))
        })
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|isin| !isin.is_empty())
        .map(ToOwned::to_owned)
}
