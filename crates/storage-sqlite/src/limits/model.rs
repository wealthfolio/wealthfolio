//! Database models for contribution limits.

use chrono::NaiveDateTime;
use diesel::prelude::*;
use serde::{Deserialize, Serialize};

use wealthfolio_core::limits::{ContributionLimit, NewContributionLimit};

/// Database model for contribution limits
#[derive(Queryable, Insertable, Identifiable, Serialize, Deserialize, Debug, Clone)]
#[diesel(table_name = crate::schema::contribution_limits)]
#[serde(rename_all = "camelCase")]
pub struct ContributionLimitDB {
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

/// Database model for creating/updating contribution limits
#[derive(Insertable, AsChangeset, Serialize, Deserialize, Debug, Clone)]
#[diesel(table_name = crate::schema::contribution_limits)]
#[serde(rename_all = "camelCase")]
pub struct NewContributionLimitDB {
    pub id: Option<String>,
    pub group_name: String,
    pub contribution_year: i32,
    pub limit_amount: f64,
    pub account_ids: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub is_recurring: bool,
}

// Conversion implementations
impl From<ContributionLimitDB> for ContributionLimit {
    fn from(db: ContributionLimitDB) -> Self {
        Self {
            id: db.id,
            group_name: db.group_name,
            contribution_year: db.contribution_year,
            limit_amount: db.limit_amount,
            account_ids: db.account_ids,
            created_at: db.created_at,
            updated_at: db.updated_at,
            start_date: db.start_date,
            end_date: db.end_date,
            is_recurring: db.is_recurring,
        }
    }
}

impl From<NewContributionLimit> for NewContributionLimitDB {
    fn from(domain: NewContributionLimit) -> Self {
        Self {
            id: domain.id,
            group_name: domain.group_name,
            contribution_year: domain.contribution_year,
            limit_amount: domain.limit_amount,
            account_ids: domain.account_ids,
            start_date: domain.start_date,
            end_date: domain.end_date,
            is_recurring: domain.is_recurring,
        }
    }
}

impl From<ContributionLimit> for ContributionLimitDB {
    fn from(domain: ContributionLimit) -> Self {
        Self {
            id: domain.id,
            group_name: domain.group_name,
            contribution_year: domain.contribution_year,
            limit_amount: domain.limit_amount,
            account_ids: domain.account_ids,
            created_at: domain.created_at,
            updated_at: domain.updated_at,
            start_date: domain.start_date,
            end_date: domain.end_date,
            is_recurring: domain.is_recurring,
        }
    }
}
