//! Net worth domain models.

use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A single point in net worth history.
///
/// Provides component-level breakdown for accurate gain calculation:
/// - Portfolio gain = (last.portfolio_value - last.net_contribution) - (first.portfolio_value - first.net_contribution)
/// - Alt asset gain = last.alternative_assets_value - first.alternative_assets_value
/// - Liability reduction = first.total_liabilities - last.total_liabilities
/// - Total gain = portfolio_gain + alt_asset_gain + liability_reduction
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NetWorthHistoryPoint {
    /// Date of this data point
    pub date: NaiveDate,

    // ─── Component Values ───────────────────────────────────────────────
    /// Portfolio value from real-account base-currency valuations
    pub portfolio_value: Decimal,
    /// Alternative assets value (properties, vehicles, collectibles, precious metals, other)
    pub alternative_assets_value: Decimal,
    /// Total liabilities in base currency (positive magnitude, subtracted for net worth)
    pub total_liabilities: Decimal,

    // ─── Totals ─────────────────────────────────────────────────────────
    /// Total assets = portfolio_value + alternative_assets_value
    pub total_assets: Decimal,
    /// Net worth = total_assets - total_liabilities
    pub net_worth: Decimal,

    // ─── For Gain Calculation ───────────────────────────────────────────
    /// Cumulative net contributions (deposits - withdrawals) from portfolio
    /// Used for contribution-adjusted gain: portfolio_gain = portfolio_value - net_contribution
    pub net_contribution: Decimal,

    /// Per-category / per-liability values at this date, enabling category-level
    /// trend and change calculations. Keys mirror the point-in-time breakdown:
    /// asset category keys (`cash`, `investments`, `properties`, ...) for aggregated
    /// asset categories, and the individual liability id (matching `BreakdownItem.asset_id`)
    /// for each liability.
    pub breakdown: BTreeMap<String, Decimal>,

    /// Base currency for all values
    pub currency: String,
}

/// Individual item in the assets or liabilities breakdown.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakdownItem {
    /// Category key (e.g., "cash", "investments", "properties")
    pub category: String,
    /// Display name
    pub name: String,
    /// Value in base currency (positive magnitude)
    pub value: Decimal,
    /// Optional: asset ID for individual items (liabilities, specific holdings)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    /// Individual items rolled up into this category, for drill-down. Empty for
    /// leaf items and for the Investments category (use allocation drill-down).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<BreakdownItem>,
}

/// Assets section of the balance sheet.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AssetsSection {
    /// Total assets value in base currency
    pub total: Decimal,
    /// Breakdown by category
    pub breakdown: Vec<BreakdownItem>,
}

/// Liabilities section of the balance sheet.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LiabilitiesSection {
    /// Total liabilities value in base currency (positive magnitude)
    pub total: Decimal,
    /// Breakdown by individual liability
    pub breakdown: Vec<BreakdownItem>,
}

/// Information about a stale asset valuation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaleAssetInfo {
    /// Asset ID
    pub asset_id: String,
    /// Asset name (if available)
    pub name: Option<String>,
    /// Date of the last valuation
    pub valuation_date: NaiveDate,
    /// Number of days since last valuation
    pub days_stale: i64,
}

/// Response model for net worth calculation - structured as a balance sheet.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetWorthResponse {
    /// The date for which net worth is calculated
    pub date: NaiveDate,
    /// Assets section with total and breakdown
    pub assets: AssetsSection,
    /// Liabilities section with total and breakdown
    pub liabilities: LiabilitiesSection,
    /// Net worth = assets.total - liabilities.total
    pub net_worth: Decimal,
    /// Base currency for all values
    pub currency: String,
    /// The oldest valuation date used in the calculation
    pub oldest_valuation_date: Option<NaiveDate>,
    /// Assets with valuations older than 90 days
    pub stale_assets: Vec<StaleAssetInfo>,
}

impl NetWorthResponse {
    /// Create a new empty net worth response for the given date and currency.
    pub fn empty(date: NaiveDate, currency: String) -> Self {
        Self {
            date,
            assets: AssetsSection::default(),
            liabilities: LiabilitiesSection::default(),
            net_worth: Decimal::ZERO,
            currency,
            oldest_valuation_date: None,
            stale_assets: Vec::new(),
        }
    }
}

/// Internal struct for tracking valuation info during calculation.
#[derive(Debug, Clone)]
pub struct ValuationInfo {
    /// Asset ID
    pub asset_id: String,
    /// Asset name
    pub name: Option<String>,
    /// Market value in base currency
    pub market_value_base: Decimal,
    /// Date of the valuation
    pub valuation_date: NaiveDate,
    /// Category for breakdown
    pub category: AssetCategory,
    /// True for balance snapshots that should not be treated like stale market data.
    pub is_cash_like: bool,
    /// Ownership percentage (0-100) if this valuation came from a partially-owned
    /// alternative asset. None for account-derived valuations (cash, investments,
    /// credit cards) and for fully-owned alternative assets.
    pub ownership_pct: Option<Decimal>,
}

/// Asset category for net worth breakdown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AssetCategory {
    /// Securities, Crypto, Options, Commodities, PrivateEquity
    Investment,
    /// Real estate
    Property,
    /// Vehicles
    Vehicle,
    /// Collectibles
    Collectible,
    /// Physical precious metals
    PreciousMetal,
    /// Other assets
    Other,
    /// Liabilities (stored positive, subtracted in aggregation)
    Liability,
    /// Cash holdings
    Cash,
}
