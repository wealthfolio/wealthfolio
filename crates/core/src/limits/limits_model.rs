//! Contribution limits domain models.

use chrono::{DateTime, NaiveDateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const MIN_CONTRIBUTION_YEAR: i32 = 1900;
pub const MAX_CONTRIBUTION_YEAR: i32 = 9999;

/// Domain model for contribution limit
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContributionLimit {
    pub id: String,
    pub group_name: String,
    pub contribution_year: i32,
    pub limit_amount: f64,
    pub account_ids: Option<String>,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub is_recurring: bool,
}

/// Input model for creating a new contribution limit
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NewContributionLimit {
    pub id: Option<String>,
    pub group_name: String,
    pub contribution_year: i32,
    pub limit_amount: f64,
    pub account_ids: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    #[serde(default)]
    pub is_recurring: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AccountDeposit {
    pub amount: Decimal,
    pub currency: String,
    pub converted_amount: Decimal,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DepositsCalculation {
    pub total: Decimal,
    pub base_currency: String,
    pub by_account: HashMap<String, AccountDeposit>,
}

/// Raw activity data for contribution calculation.
/// Fetched from DB, filtered in Rust for performance.
#[derive(Debug, Clone)]
pub struct ContributionActivity {
    pub id: String,
    pub account_id: String,
    pub activity_type: String,
    pub activity_instant: DateTime<Utc>,
    pub amount: Option<Decimal>,
    pub currency: String,
    pub metadata: Option<String>,
    pub source_group_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ContributionTreatment {
    Counted,
    ExcludedByUser,
    InternalTransfer,
    NotExternal,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContributionActivityDetail {
    pub id: String,
    pub account_id: String,
    pub activity_type: String,
    pub activity_instant: DateTime<Utc>,
    pub amount: Option<Decimal>,
    pub currency: String,
    pub counted_amount: Decimal,
    pub treatment: ContributionTreatment,
    pub can_exclude: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContributionLimitDetails {
    pub limit: ContributionLimit,
    pub calculation: DepositsCalculation,
    pub activities: Vec<ContributionActivityDetail>,
}
