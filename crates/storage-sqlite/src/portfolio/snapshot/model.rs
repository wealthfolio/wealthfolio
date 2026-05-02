//! Database model for account state snapshots.

use chrono::{NaiveDate, NaiveDateTime, Utc};
use diesel::prelude::*;
use diesel::sql_types::{Integer, Text};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::str::FromStr;

use wealthfolio_core::constants::DECIMAL_PRECISION;
use wealthfolio_core::portfolio::snapshot::{AccountStateSnapshot, Position, SnapshotSource};

/// Database model for account state snapshots
#[derive(Debug, Clone, Queryable, QueryableByName, Insertable, Serialize, Deserialize)]
#[diesel(table_name = crate::schema::holdings_snapshots)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct AccountStateSnapshotDB {
    #[diesel(sql_type = Text)]
    pub id: String,
    #[diesel(sql_type = Text)]
    pub account_id: String,
    #[diesel(sql_type = Text)]
    pub snapshot_date: String,
    #[diesel(sql_type = Text)]
    pub currency: String,
    #[diesel(sql_type = Text)]
    pub positions: String,
    #[diesel(sql_type = Text)]
    pub cash_balances: String,
    #[diesel(sql_type = Text)]
    pub cost_basis: String,
    #[diesel(sql_type = Text)]
    pub net_contribution: String,
    #[diesel(sql_type = Text)]
    pub calculated_at: String,
    #[diesel(sql_type = Text)]
    pub net_contribution_base: String,
    #[diesel(sql_type = Text)]
    pub cash_total_account_currency: String,
    #[diesel(sql_type = Text)]
    pub cash_total_base_currency: String,
    #[diesel(sql_type = Text)]
    pub source: String,
}

// Conversion from DB model to Domain model
impl From<AccountStateSnapshotDB> for AccountStateSnapshot {
    fn from(db: AccountStateSnapshotDB) -> Self {
        Self {
            id: db.id.clone(),
            account_id: db.account_id,
            snapshot_date: NaiveDate::parse_from_str(&db.snapshot_date, "%Y-%m-%d")
                .unwrap_or_default(),
            currency: db.currency,
            positions: HashMap::new(),
            cash_balances: serde_json::from_str(&db.cash_balances).unwrap_or_default(),
            cost_basis: Decimal::from_str(&db.cost_basis).unwrap_or_default(),
            net_contribution: Decimal::from_str(&db.net_contribution).unwrap_or_default(),
            net_contribution_base: Decimal::from_str(&db.net_contribution_base).unwrap_or_default(),
            cash_total_account_currency: Decimal::from_str(&db.cash_total_account_currency)
                .unwrap_or_default(),
            cash_total_base_currency: Decimal::from_str(&db.cash_total_base_currency)
                .unwrap_or_default(),
            calculated_at: NaiveDateTime::parse_from_str(
                &db.calculated_at,
                "%Y-%m-%dT%H:%M:%S%.fZ",
            )
            .unwrap_or_else(|e| {
                log::error!(
                    "Failed to parse DB calculated_at '{}': {}",
                    db.calculated_at,
                    e
                );
                Utc::now().naive_utc()
            }),
            source: serde_json::from_str(&format!("\"{}\"", db.source))
                .unwrap_or(SnapshotSource::Calculated),
        }
    }
}

// Conversion from Domain model to DB model
impl From<AccountStateSnapshot> for AccountStateSnapshotDB {
    fn from(domain: AccountStateSnapshot) -> Self {
        Self {
            id: domain.id.clone(),
            account_id: domain.account_id,
            snapshot_date: domain.snapshot_date.format("%Y-%m-%d").to_string(),
            currency: domain.currency,
            // Positions are now stored in the snapshot_positions table.
            // JSON column is vestigial — always write empty object.
            positions: "{}".to_string(),
            cash_balances: serde_json::to_string(&domain.cash_balances)
                .unwrap_or_else(|_| "{}".to_string()),
            cost_basis: domain.cost_basis.round_dp(DECIMAL_PRECISION).to_string(),
            net_contribution: domain
                .net_contribution
                .round_dp(DECIMAL_PRECISION)
                .to_string(),
            net_contribution_base: domain
                .net_contribution_base
                .round_dp(DECIMAL_PRECISION)
                .to_string(),
            cash_total_account_currency: domain
                .cash_total_account_currency
                .round_dp(DECIMAL_PRECISION)
                .to_string(),
            cash_total_base_currency: domain
                .cash_total_base_currency
                .round_dp(DECIMAL_PRECISION)
                .to_string(),
            calculated_at: domain
                .calculated_at
                .format("%Y-%m-%dT%H:%M:%S%.fZ")
                .to_string(),
            source: serde_json::to_string(&domain.source)
                .unwrap_or_else(|_| "\"CALCULATED\"".to_string())
                .trim_matches('"')
                .to_string(),
        }
    }
}

// --- snapshot_positions table ---

#[derive(Debug, Clone, Queryable, QueryableByName, Insertable)]
#[diesel(table_name = crate::schema::snapshot_positions)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct SnapshotPositionRecord {
    #[diesel(sql_type = Integer)]
    pub id: i32,
    #[diesel(sql_type = Text)]
    pub snapshot_id: String,
    #[diesel(sql_type = Text)]
    pub asset_id: String,
    #[diesel(sql_type = Text)]
    pub quantity: String,
    #[diesel(sql_type = Text)]
    pub average_cost: String,
    #[diesel(sql_type = Text)]
    pub total_cost_basis: String,
    #[diesel(sql_type = Text)]
    pub currency: String,
    #[diesel(sql_type = Text)]
    pub inception_date: String,
    #[diesel(sql_type = Integer)]
    pub is_alternative: i32,
    #[diesel(sql_type = Text)]
    pub contract_multiplier: String,
    #[diesel(sql_type = Text)]
    pub created_at: String,
    #[diesel(sql_type = Text)]
    pub last_updated: String,
}

/// Insertable version without the autoincrement `id`.
#[derive(Debug, Clone, Insertable)]
#[diesel(table_name = crate::schema::snapshot_positions)]
pub struct NewSnapshotPositionRecord {
    pub snapshot_id: String,
    pub asset_id: String,
    pub quantity: String,
    pub average_cost: String,
    pub total_cost_basis: String,
    pub currency: String,
    pub inception_date: String,
    pub is_alternative: i32,
    pub contract_multiplier: String,
    pub created_at: String,
    pub last_updated: String,
}

impl SnapshotPositionRecord {
    /// Convert a DB row into the in-memory Position struct.
    pub fn to_position(&self, account_id: &str) -> Position {
        let parse_dt = |s: &str| -> chrono::DateTime<Utc> {
            chrono::DateTime::parse_from_rfc3339(s)
                .map(|dt| dt.with_timezone(&Utc))
                .or_else(|_| {
                    chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.fZ")
                        .map(|ndt| ndt.and_utc())
                })
                .unwrap_or_else(|_| Utc::now())
        };

        Position {
            id: format!("POS-{}-{}", self.asset_id, account_id),
            account_id: account_id.to_string(),
            asset_id: self.asset_id.clone(),
            quantity: Decimal::from_str(&self.quantity).unwrap_or_default(),
            average_cost: Decimal::from_str(&self.average_cost).unwrap_or_default(),
            total_cost_basis: Decimal::from_str(&self.total_cost_basis).unwrap_or_default(),
            currency: self.currency.clone(),
            inception_date: parse_dt(&self.inception_date),
            lots: VecDeque::new(),
            created_at: parse_dt(&self.created_at),
            last_updated: parse_dt(&self.last_updated),
            is_alternative: self.is_alternative != 0,
            contract_multiplier: Decimal::from_str(&self.contract_multiplier)
                .unwrap_or(Decimal::ONE),
        }
    }
}

impl NewSnapshotPositionRecord {
    /// Build from an in-memory Position for a given snapshot_id.
    pub fn from_position(snapshot_id: &str, pos: &Position) -> Self {
        Self {
            snapshot_id: snapshot_id.to_string(),
            asset_id: pos.asset_id.clone(),
            quantity: pos.quantity.round_dp(DECIMAL_PRECISION).to_string(),
            average_cost: pos.average_cost.round_dp(DECIMAL_PRECISION).to_string(),
            total_cost_basis: pos.total_cost_basis.round_dp(DECIMAL_PRECISION).to_string(),
            currency: pos.currency.clone(),
            inception_date: pos.inception_date.to_rfc3339(),
            is_alternative: if pos.is_alternative { 1 } else { 0 },
            contract_multiplier: pos.contract_multiplier.to_string(),
            created_at: pos.created_at.to_rfc3339(),
            last_updated: pos.last_updated.to_rfc3339(),
        }
    }
}
