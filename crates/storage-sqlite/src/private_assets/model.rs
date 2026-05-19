//! Database models for the private-assets storage layer.

use chrono::{DateTime, NaiveDate, Utc};
use diesel::prelude::*;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::str::FromStr;

use wealthfolio_core::errors::{DatabaseError, Error, Result};
use wealthfolio_core::private_assets::{
    FundManager, NewFundManager, NewPrivateAsset, NewPrivateSnapshot, NewPrivateSubAsset,
    PrivateAsset, PrivateAssetStatus, PrivateAssetStrategyType, PrivateAssetVehicleKind,
    PrivateSnapshot, PrivateSnapshotCashFlowType, PrivateSnapshotValueSourceType, PrivateSubAsset,
    PrivateSubAssetReportingBasis, UpdatePrivateSnapshot,
};

fn invalid_private_asset_value(field: &str, value: &str, error: impl ToString) -> Error {
    Error::Database(DatabaseError::Internal(format!(
        "Invalid persisted private-assets {} '{}': {}",
        field,
        value,
        error.to_string()
    )))
}

fn text_to_datetime(value: &str) -> Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.with_timezone(&Utc))
        .map_err(|error| invalid_private_asset_value("timestamp", value, error))
}

fn decimal_to_text(value: Decimal) -> String {
    value.to_string()
}

fn optional_decimal_to_text(value: Option<Decimal>) -> Option<String> {
    value.map(decimal_to_text)
}

fn text_to_decimal(value: &str) -> Result<Decimal> {
    Decimal::from_str(value).map_err(|error| invalid_private_asset_value("decimal", value, error))
}

fn optional_text_to_decimal(value: Option<String>) -> Result<Option<Decimal>> {
    value.map(|item| text_to_decimal(&item)).transpose()
}

fn private_asset_status_to_text(value: PrivateAssetStatus) -> String {
    match value {
        PrivateAssetStatus::Active => "ACTIVE".to_string(),
        PrivateAssetStatus::Realized => "REALIZED".to_string(),
        PrivateAssetStatus::Archived => "ARCHIVED".to_string(),
    }
}

fn text_to_private_asset_status(value: &str) -> Result<PrivateAssetStatus> {
    match value {
        "ACTIVE" => Ok(PrivateAssetStatus::Active),
        "REALIZED" => Ok(PrivateAssetStatus::Realized),
        "ARCHIVED" => Ok(PrivateAssetStatus::Archived),
        other => Err(invalid_private_asset_value(
            "status",
            other,
            "unsupported enum variant",
        )),
    }
}

fn vehicle_kind_to_text(value: PrivateAssetVehicleKind) -> String {
    match value {
        PrivateAssetVehicleKind::Fund => "FUND".to_string(),
        PrivateAssetVehicleKind::CoInvestment => "CO_INVESTMENT".to_string(),
        PrivateAssetVehicleKind::Direct => "DIRECT".to_string(),
        PrivateAssetVehicleKind::RealEstate => "REAL_ESTATE".to_string(),
        PrivateAssetVehicleKind::Other => "OTHER".to_string(),
    }
}

fn text_to_vehicle_kind(value: &str) -> Result<PrivateAssetVehicleKind> {
    match value {
        "FUND" => Ok(PrivateAssetVehicleKind::Fund),
        "CO_INVESTMENT" => Ok(PrivateAssetVehicleKind::CoInvestment),
        "DIRECT" => Ok(PrivateAssetVehicleKind::Direct),
        "REAL_ESTATE" => Ok(PrivateAssetVehicleKind::RealEstate),
        "OTHER" => Ok(PrivateAssetVehicleKind::Other),
        other => Err(invalid_private_asset_value(
            "vehicle kind",
            other,
            "unsupported enum variant",
        )),
    }
}

fn strategy_type_to_text(value: PrivateAssetStrategyType) -> String {
    match value {
        PrivateAssetStrategyType::Venture => "VENTURE".to_string(),
        PrivateAssetStrategyType::PrivateEquity => "PRIVATE_EQUITY".to_string(),
        PrivateAssetStrategyType::HedgeFund => "HEDGE_FUND".to_string(),
        PrivateAssetStrategyType::PrivateCredit => "PRIVATE_CREDIT".to_string(),
        PrivateAssetStrategyType::FundOfFunds => "FUND_OF_FUNDS".to_string(),
        PrivateAssetStrategyType::Energy => "ENERGY".to_string(),
        PrivateAssetStrategyType::RealEstate => "REAL_ESTATE".to_string(),
        PrivateAssetStrategyType::Other => "OTHER".to_string(),
    }
}

fn text_to_strategy_type(value: &str) -> Result<PrivateAssetStrategyType> {
    match value {
        "VENTURE" => Ok(PrivateAssetStrategyType::Venture),
        "PRIVATE_EQUITY" => Ok(PrivateAssetStrategyType::PrivateEquity),
        "HEDGE_FUND" => Ok(PrivateAssetStrategyType::HedgeFund),
        "PRIVATE_CREDIT" => Ok(PrivateAssetStrategyType::PrivateCredit),
        "FUND_OF_FUNDS" => Ok(PrivateAssetStrategyType::FundOfFunds),
        "ENERGY" => Ok(PrivateAssetStrategyType::Energy),
        "REAL_ESTATE" => Ok(PrivateAssetStrategyType::RealEstate),
        "OTHER" => Ok(PrivateAssetStrategyType::Other),
        other => Err(invalid_private_asset_value(
            "strategy type",
            other,
            "unsupported enum variant",
        )),
    }
}

fn reporting_basis_to_text(value: PrivateSubAssetReportingBasis) -> String {
    match value {
        PrivateSubAssetReportingBasis::Unknown => "UNKNOWN".to_string(),
        PrivateSubAssetReportingBasis::Gross => "GROSS".to_string(),
        PrivateSubAssetReportingBasis::Net => "NET".to_string(),
    }
}

fn text_to_reporting_basis(value: &str) -> Result<PrivateSubAssetReportingBasis> {
    match value {
        "UNKNOWN" => Ok(PrivateSubAssetReportingBasis::Unknown),
        "GROSS" => Ok(PrivateSubAssetReportingBasis::Gross),
        "NET" => Ok(PrivateSubAssetReportingBasis::Net),
        other => Err(invalid_private_asset_value(
            "reporting basis",
            other,
            "unsupported enum variant",
        )),
    }
}

fn value_source_type_to_text(value: PrivateSnapshotValueSourceType) -> String {
    match value {
        PrivateSnapshotValueSourceType::Manual => "MANUAL".to_string(),
        PrivateSnapshotValueSourceType::Statement => "STATEMENT".to_string(),
        PrivateSnapshotValueSourceType::Estimated => "ESTIMATED".to_string(),
    }
}

fn text_to_value_source_type(value: &str) -> Result<PrivateSnapshotValueSourceType> {
    match value {
        "MANUAL" => Ok(PrivateSnapshotValueSourceType::Manual),
        "STATEMENT" => Ok(PrivateSnapshotValueSourceType::Statement),
        "ESTIMATED" => Ok(PrivateSnapshotValueSourceType::Estimated),
        other => Err(invalid_private_asset_value(
            "snapshot value source type",
            other,
            "unsupported enum variant",
        )),
    }
}

fn cash_flow_type_to_text(value: PrivateSnapshotCashFlowType) -> String {
    match value {
        PrivateSnapshotCashFlowType::TotalToDate => "TOTAL_TO_DATE".to_string(),
        PrivateSnapshotCashFlowType::PeriodOnly => "PERIOD_ONLY".to_string(),
    }
}

fn text_to_cash_flow_type(value: &str) -> Result<PrivateSnapshotCashFlowType> {
    match value {
        "TOTAL_TO_DATE" => Ok(PrivateSnapshotCashFlowType::TotalToDate),
        "PERIOD_ONLY" => Ok(PrivateSnapshotCashFlowType::PeriodOnly),
        other => Err(invalid_private_asset_value(
            "snapshot cash flow type",
            other,
            "unsupported enum variant",
        )),
    }
}

#[derive(
    Debug, Clone, Queryable, Identifiable, Selectable, AsChangeset, Serialize, Deserialize,
)]
#[diesel(table_name = crate::schema::fund_managers)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct FundManagerDB {
    pub id: String,
    pub name: String,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Insertable, Serialize, Deserialize)]
#[diesel(table_name = crate::schema::fund_managers)]
pub struct NewFundManagerDB {
    pub id: Option<String>,
    pub name: String,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(
    Debug, Clone, Queryable, Identifiable, Selectable, AsChangeset, Serialize, Deserialize,
)]
#[diesel(table_name = crate::schema::private_assets)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct PrivateAssetDB {
    pub id: String,
    pub name: String,
    pub fund_manager_id: Option<String>,
    pub vehicle_kind: String,
    pub strategy_type: String,
    pub currency: String,
    pub status: String,
    pub commitment_amount: Option<String>,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Insertable, Serialize, Deserialize)]
#[diesel(table_name = crate::schema::private_assets)]
pub struct NewPrivateAssetDB {
    pub id: Option<String>,
    pub name: String,
    pub fund_manager_id: Option<String>,
    pub vehicle_kind: String,
    pub strategy_type: String,
    pub currency: String,
    pub status: String,
    pub commitment_amount: Option<String>,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(
    Debug, Clone, Queryable, Identifiable, Selectable, AsChangeset, Serialize, Deserialize,
)]
#[diesel(table_name = crate::schema::private_sub_assets)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct PrivateSubAssetDB {
    pub id: String,
    pub private_asset_id: String,
    pub name: String,
    pub reporting_basis: String,
    pub strategy_type: Option<String>,
    pub cost_basis: Option<String>,
    pub current_value: Option<String>,
    pub ownership_percent: Option<String>,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Insertable, Serialize, Deserialize)]
#[diesel(table_name = crate::schema::private_sub_assets)]
pub struct NewPrivateSubAssetDB {
    pub id: Option<String>,
    pub private_asset_id: String,
    pub name: String,
    pub reporting_basis: String,
    pub strategy_type: Option<String>,
    pub cost_basis: Option<String>,
    pub current_value: Option<String>,
    pub ownership_percent: Option<String>,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(
    Debug, Clone, Queryable, Identifiable, Selectable, AsChangeset, Serialize, Deserialize,
)]
#[diesel(table_name = crate::schema::private_snapshots)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct PrivateSnapshotDB {
    pub id: String,
    pub private_asset_id: String,
    pub contributed_amount: String,
    pub distributed_amount: String,
    pub cash_flow_type: String,
    pub current_value: String,
    pub as_of_date: NaiveDate,
    pub value_source_type: String,
    pub notes: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Insertable, Serialize, Deserialize)]
#[diesel(table_name = crate::schema::private_snapshots)]
pub struct NewPrivateSnapshotDB {
    pub id: Option<String>,
    pub private_asset_id: String,
    pub contributed_amount: String,
    pub distributed_amount: String,
    pub cash_flow_type: String,
    pub current_value: String,
    pub as_of_date: NaiveDate,
    pub value_source_type: String,
    pub notes: Option<String>,
    pub created_at: String,
}

impl TryFrom<FundManagerDB> for FundManager {
    type Error = Error;

    fn try_from(value: FundManagerDB) -> Result<Self> {
        Ok(Self {
            id: value.id,
            name: value.name,
            notes: value.notes,
            created_at: text_to_datetime(&value.created_at)?,
            updated_at: text_to_datetime(&value.updated_at)?,
        })
    }
}

impl From<NewFundManager> for NewFundManagerDB {
    fn from(value: NewFundManager) -> Self {
        let now = Utc::now().to_rfc3339();
        Self {
            id: value.id,
            name: value.name,
            notes: value.notes,
            created_at: now.clone(),
            updated_at: now,
        }
    }
}

impl TryFrom<PrivateAssetDB> for PrivateAsset {
    type Error = Error;

    fn try_from(value: PrivateAssetDB) -> Result<Self> {
        Ok(Self {
            id: value.id,
            name: value.name,
            fund_manager_id: value.fund_manager_id,
            vehicle_kind: text_to_vehicle_kind(&value.vehicle_kind)?,
            strategy_type: text_to_strategy_type(&value.strategy_type)?,
            currency: value.currency,
            status: text_to_private_asset_status(&value.status)?,
            commitment_amount: optional_text_to_decimal(value.commitment_amount)?,
            notes: value.notes,
            created_at: text_to_datetime(&value.created_at)?,
            updated_at: text_to_datetime(&value.updated_at)?,
        })
    }
}

impl From<NewPrivateAsset> for NewPrivateAssetDB {
    fn from(value: NewPrivateAsset) -> Self {
        let now = Utc::now().to_rfc3339();
        Self {
            id: value.id,
            name: value.name,
            fund_manager_id: value.fund_manager_id,
            vehicle_kind: vehicle_kind_to_text(value.vehicle_kind),
            strategy_type: strategy_type_to_text(value.strategy_type),
            currency: value.currency,
            status: private_asset_status_to_text(value.status),
            commitment_amount: optional_decimal_to_text(value.commitment_amount),
            notes: value.notes,
            created_at: now.clone(),
            updated_at: now,
        }
    }
}

impl TryFrom<PrivateSubAssetDB> for PrivateSubAsset {
    type Error = Error;

    fn try_from(value: PrivateSubAssetDB) -> Result<Self> {
        Ok(Self {
            id: value.id,
            private_asset_id: value.private_asset_id,
            name: value.name,
            reporting_basis: text_to_reporting_basis(&value.reporting_basis)?,
            strategy_type: value
                .strategy_type
                .map(|item| text_to_strategy_type(&item))
                .transpose()?,
            cost_basis: optional_text_to_decimal(value.cost_basis)?,
            current_value: optional_text_to_decimal(value.current_value)?,
            ownership_percent: optional_text_to_decimal(value.ownership_percent)?,
            notes: value.notes,
            created_at: text_to_datetime(&value.created_at)?,
            updated_at: text_to_datetime(&value.updated_at)?,
        })
    }
}

impl From<NewPrivateSubAsset> for NewPrivateSubAssetDB {
    fn from(value: NewPrivateSubAsset) -> Self {
        let now = Utc::now().to_rfc3339();
        Self {
            id: value.id,
            private_asset_id: value.private_asset_id,
            name: value.name,
            reporting_basis: reporting_basis_to_text(value.reporting_basis),
            strategy_type: value.strategy_type.map(strategy_type_to_text),
            cost_basis: optional_decimal_to_text(value.cost_basis),
            current_value: optional_decimal_to_text(value.current_value),
            ownership_percent: optional_decimal_to_text(value.ownership_percent),
            notes: value.notes,
            created_at: now.clone(),
            updated_at: now,
        }
    }
}

impl TryFrom<PrivateSnapshotDB> for PrivateSnapshot {
    type Error = Error;

    fn try_from(value: PrivateSnapshotDB) -> Result<Self> {
        Ok(Self {
            id: value.id,
            private_asset_id: value.private_asset_id,
            contributed_amount: text_to_decimal(&value.contributed_amount)?,
            distributed_amount: text_to_decimal(&value.distributed_amount)?,
            cash_flow_type: text_to_cash_flow_type(&value.cash_flow_type)?,
            current_value: text_to_decimal(&value.current_value)?,
            as_of_date: value.as_of_date,
            value_source_type: text_to_value_source_type(&value.value_source_type)?,
            notes: value.notes,
            created_at: text_to_datetime(&value.created_at)?,
        })
    }
}

impl From<NewPrivateSnapshot> for NewPrivateSnapshotDB {
    fn from(value: NewPrivateSnapshot) -> Self {
        Self {
            id: value.id,
            private_asset_id: value.private_asset_id,
            contributed_amount: decimal_to_text(value.contributed_amount),
            distributed_amount: decimal_to_text(value.distributed_amount),
            cash_flow_type: cash_flow_type_to_text(value.cash_flow_type),
            current_value: decimal_to_text(value.current_value),
            as_of_date: value.as_of_date,
            value_source_type: value_source_type_to_text(value.value_source_type),
            notes: value.notes,
            created_at: Utc::now().to_rfc3339(),
        }
    }
}

impl From<UpdatePrivateSnapshot> for PrivateSnapshotDB {
    fn from(value: UpdatePrivateSnapshot) -> Self {
        Self {
            id: String::new(),
            private_asset_id: String::new(),
            contributed_amount: decimal_to_text(value.contributed_amount),
            distributed_amount: decimal_to_text(value.distributed_amount),
            cash_flow_type: cash_flow_type_to_text(value.cash_flow_type),
            current_value: decimal_to_text(value.current_value),
            as_of_date: value.as_of_date,
            value_source_type: value_source_type_to_text(value.value_source_type),
            notes: value.notes,
            created_at: String::new(),
        }
    }
}
