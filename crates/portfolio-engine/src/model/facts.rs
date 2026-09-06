//! Raw facts: the complete world the kernel is allowed to know, shaped like
//! the rows the shell loads. Strings are allowed HERE only; `normalize` turns
//! them into the canonical model. Per-invocation scope, not the database.

use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use super::policy::Policy;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RawFacts {
    pub policy: Policy,
    pub accounts: Vec<RawAccount>,
    pub assets: Vec<RawAsset>,
    pub activities: Vec<RawActivity>,
    pub quotes: Vec<RawQuote>,
    pub fx_rates: Vec<RawFxRate>,
    /// Holdings-mode keyframes: FACTS a user/broker observed, never rebuilt.
    pub observed_snapshots: Vec<RawObservedSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RawAccount {
    pub id: String,
    pub currency: String,
    /// `SECURITIES` | `CASH` | `CREDIT_CARD` | `CRYPTOCURRENCY` | other
    pub account_type: String,
    /// `TRANSACTIONS` | `HOLDINGS` | `NOT_SET`
    pub tracking_mode: String,
    pub is_archived: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RawAsset {
    pub id: String,
    pub quote_currency: String,
    /// `INVESTMENT` | `PROPERTY` | `VEHICLE` | `COLLECTIBLE` | `PRECIOUS_METAL` | …
    pub kind: String,
    /// `EQUITY` | `CRYPTO` | `OPTION` | `BOND` | `METAL` | `FX`, or none for
    /// an untyped legacy asset.
    pub instrument_type: Option<String>,
    /// Explicit `contractMultiplier` metadata; `None` means the instrument
    /// default (100 for options, 1 otherwise).
    pub contract_multiplier: Option<Decimal>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RawActivity {
    pub id: String,
    pub account_id: String,
    pub asset_id: Option<String>,
    pub activity_type: String,
    pub activity_type_override: Option<String>,
    pub subtype: Option<String>,
    /// `POSTED` | `PENDING` | `DRAFT` | `VOID`; only `POSTED` computes.
    pub status: String,
    pub timestamp: DateTime<Utc>,
    /// Row creation time: the tiebreaker for same-instant activities
    /// (date-only imports share one timestamp), before the id.
    pub created_at: DateTime<Utc>,
    pub quantity: Option<Decimal>,
    pub unit_price: Option<Decimal>,
    /// Stored FINAL cash (the writer's output); never re-derived at runtime.
    pub amount: Option<Decimal>,
    pub fee: Option<Decimal>,
    pub tax: Option<Decimal>,
    pub currency: String,
    pub fx_rate: Option<Decimal>,
    pub source_group_id: Option<String>,
    /// `metadata.flow.is_external` when present.
    pub external_transfer: Option<bool>,
    pub source_system: Option<String>,
    pub is_user_modified: bool,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RawQuote {
    pub asset_id: String,
    pub day: NaiveDate,
    pub close: Decimal,
    /// Empty means "the asset's quote currency".
    pub currency: String,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RawFxRate {
    pub from: String,
    pub to: String,
    pub day: NaiveDate,
    pub rate: Decimal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RawObservedSnapshot {
    pub account_id: String,
    pub date: NaiveDate,
    pub positions: Vec<RawObservedPosition>,
    pub cash: Vec<(String, Decimal)>,
    pub cost_basis: Decimal,
    pub net_contribution: Decimal,
    pub net_contribution_base: Decimal,
    pub cash_total_account_currency: Decimal,
    pub cash_total_base_currency: Decimal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RawObservedPosition {
    pub asset_id: String,
    /// Stored position currency; empty means the asset's quote currency.
    #[serde(default)]
    pub currency: String,
    pub quantity: Decimal,
    pub average_cost: Decimal,
    pub total_cost_basis: Decimal,
    pub cost_basis_account: Option<Decimal>,
    pub cost_basis_base: Option<Decimal>,
}
