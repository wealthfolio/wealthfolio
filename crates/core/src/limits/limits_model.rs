//! Contribution limits domain models.

use chrono::{DateTime, NaiveDateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContributionType {
    Employee,
    Employer,
}

impl ContributionType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Employee => "employee",
            Self::Employer => "employer",
        }
    }
}

/// Domain model for contribution limit
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContributionLimit {
    pub id: String,
    pub group_name: String,
    pub contribution_year: i32,
    pub limit_amount: f64,
    pub account_ids: Option<String>,
    pub contribution_type: Option<ContributionType>,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
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
    pub contribution_type: Option<ContributionType>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
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
    pub account_id: String,
    pub activity_type: String,
    pub activity_instant: DateTime<Utc>,
    pub amount: Option<Decimal>,
    pub currency: String,
    pub metadata: Option<String>,
    pub source_group_id: Option<String>,
}
