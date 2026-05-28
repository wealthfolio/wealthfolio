//! Domain models for the private-assets ledger.
//!
//! These models follow the locked v1 contract: first-class private assets,
//! optional one-level look-through detail, and snapshot-first valuation facts.

use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PrivateAssetStatus {
    Active,
    Realized,
    Archived,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PrivateAssetVehicleKind {
    Fund,
    CoInvestment,
    Direct,
    RealEstate,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PrivateAssetStrategyType {
    Venture,
    PrivateEquity,
    HedgeFund,
    PrivateCredit,
    FundOfFunds,
    Energy,
    RealEstate,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PrivateSubAssetReportingBasis {
    Unknown,
    Gross,
    Net,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PrivateSnapshotValueSourceType {
    Manual,
    Statement,
    Estimated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PrivateSnapshotCashFlowType {
    TotalToDate,
    PeriodOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PrivateAssetFreshnessState {
    Current,
    Stale,
    Estimated,
    Missing,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FundManager {
    pub id: String,
    pub name: String,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewFundManager {
    pub id: Option<String>,
    pub name: String,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateFundManager {
    pub name: Option<String>,
    pub notes: Option<Option<String>>,
}

/// First-class owned private vehicle in the private-assets ledger.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateAsset {
    pub id: String,
    pub name: String,
    pub fund_manager_id: Option<String>,
    pub vehicle_kind: PrivateAssetVehicleKind,
    pub strategy_type: PrivateAssetStrategyType,
    pub currency: String,
    pub status: PrivateAssetStatus,
    pub commitment_amount: Option<Decimal>,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPrivateAsset {
    pub id: Option<String>,
    pub name: String,
    pub fund_manager_id: Option<String>,
    pub vehicle_kind: PrivateAssetVehicleKind,
    pub strategy_type: PrivateAssetStrategyType,
    pub currency: String,
    pub status: PrivateAssetStatus,
    pub commitment_amount: Option<Decimal>,
    pub notes: Option<String>,
}

/// Nested `Option` fields allow updates to distinguish "leave unchanged" from
/// "clear this nullable field".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePrivateAsset {
    pub name: Option<String>,
    pub fund_manager_id: Option<Option<String>>,
    pub vehicle_kind: Option<PrivateAssetVehicleKind>,
    pub strategy_type: Option<PrivateAssetStrategyType>,
    pub currency: Option<String>,
    pub status: Option<PrivateAssetStatus>,
    pub commitment_amount: Option<Option<Decimal>>,
    pub notes: Option<Option<String>>,
}

/// Optional one-level look-through detail for a private asset.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateSubAsset {
    pub id: String,
    pub private_asset_id: String,
    pub name: String,
    pub reporting_basis: PrivateSubAssetReportingBasis,
    pub strategy_type: Option<PrivateAssetStrategyType>,
    pub cost_basis: Option<Decimal>,
    pub current_value: Option<Decimal>,
    pub ownership_percent: Option<Decimal>,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPrivateSubAsset {
    pub id: Option<String>,
    pub private_asset_id: String,
    pub name: String,
    pub reporting_basis: PrivateSubAssetReportingBasis,
    pub strategy_type: Option<PrivateAssetStrategyType>,
    pub cost_basis: Option<Decimal>,
    pub current_value: Option<Decimal>,
    pub ownership_percent: Option<Decimal>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePrivateSubAsset {
    pub name: Option<String>,
    pub reporting_basis: Option<PrivateSubAssetReportingBasis>,
    pub strategy_type: Option<Option<PrivateAssetStrategyType>>,
    pub cost_basis: Option<Option<Decimal>>,
    pub current_value: Option<Option<Decimal>>,
    pub ownership_percent: Option<Option<Decimal>>,
    pub notes: Option<Option<String>>,
}

/// Snapshot-first valuation and rollup facts for a private asset.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateSnapshot {
    pub id: String,
    pub private_asset_id: String,
    pub contributed_amount: Decimal,
    pub distributed_amount: Decimal,
    pub cash_flow_type: PrivateSnapshotCashFlowType,
    pub current_value: Decimal,
    pub as_of_date: NaiveDate,
    pub value_source_type: PrivateSnapshotValueSourceType,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPrivateSnapshot {
    pub id: Option<String>,
    pub private_asset_id: String,
    pub contributed_amount: Decimal,
    pub distributed_amount: Decimal,
    pub cash_flow_type: PrivateSnapshotCashFlowType,
    pub current_value: Decimal,
    pub as_of_date: NaiveDate,
    pub value_source_type: PrivateSnapshotValueSourceType,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePrivateSnapshot {
    pub contributed_amount: Decimal,
    pub distributed_amount: Decimal,
    pub cash_flow_type: PrivateSnapshotCashFlowType,
    pub current_value: Decimal,
    pub as_of_date: NaiveDate,
    pub value_source_type: PrivateSnapshotValueSourceType,
    pub notes: Option<String>,
}

/// Read model for the private-assets list surface.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateAssetListRow {
    pub asset_id: String,
    pub name: String,
    pub fund_manager_name: Option<String>,
    pub vehicle_kind: PrivateAssetVehicleKind,
    pub strategy_type: PrivateAssetStrategyType,
    pub currency: String,
    pub status: PrivateAssetStatus,
    pub commitment_amount: Option<Decimal>,
    pub latest_snapshot: Option<PrivateSnapshot>,
    pub freshness_state: PrivateAssetFreshnessState,
}

/// Read model for the private-asset detail surface.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateAssetDetail {
    pub asset: PrivateAsset,
    pub fund_manager: Option<FundManager>,
    pub sub_assets: Vec<PrivateSubAsset>,
    pub latest_snapshot: Option<PrivateSnapshot>,
    pub snapshots: Vec<PrivateSnapshot>,
    pub freshness_state: PrivateAssetFreshnessState,
}

/// Current consolidated private-assets totals sourced from latest snapshots.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateAssetCurrentTotals {
    pub total_current_value: Decimal,
    pub total_contributed: Decimal,
    pub total_distributed: Decimal,
    pub latest_as_of_date: Option<NaiveDate>,
}

/// Historical carry-forward series for private-asset marks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateAssetHistoricalPoint {
    pub as_of_date: NaiveDate,
    pub total_current_value: Decimal,
    pub total_contributed: Decimal,
    pub total_distributed: Decimal,
}
