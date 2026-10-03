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
    #[serde(default, with = "crate::model::decimal_serde::option")]
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
    #[serde(default, with = "crate::model::decimal_serde::option")]
    pub quantity: Option<Decimal>,
    #[serde(default, with = "crate::model::decimal_serde::option")]
    pub unit_price: Option<Decimal>,
    /// Stored FINAL cash (the writer's output); never re-derived at runtime.
    #[serde(default, with = "crate::model::decimal_serde::option")]
    pub amount: Option<Decimal>,
    #[serde(default, with = "crate::model::decimal_serde::option")]
    pub fee: Option<Decimal>,
    #[serde(default, with = "crate::model::decimal_serde::option")]
    pub tax: Option<Decimal>,
    pub currency: String,
    #[serde(default, with = "crate::model::decimal_serde::option")]
    pub fx_rate: Option<Decimal>,
    pub source_group_id: Option<String>,
    /// `metadata.flow.is_external` when present.
    pub external_transfer: Option<bool>,
    /// `metadata.fx` when present: what the import linker recorded for a
    /// same-account cash FX conversion.
    #[serde(default)]
    pub fx_conversion: Option<RawFxConversion>,
    pub source_system: Option<String>,
    pub is_user_modified: bool,
    pub updated_at: DateTime<Utc>,
}

/// The FX pair an importer linked two cash legs with (`metadata.fx`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RawFxConversion {
    /// `implied_from_import` for pairs the import linker built.
    pub rate_source: String,
    pub source_currency: String,
    pub destination_currency: String,
    #[serde(default, with = "crate::model::decimal_serde::option")]
    pub source_amount: Option<Decimal>,
    #[serde(default, with = "crate::model::decimal_serde::option")]
    pub destination_amount: Option<Decimal>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RawQuote {
    pub asset_id: String,
    pub day: NaiveDate,
    #[serde(with = "crate::model::decimal_serde")]
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
    #[serde(with = "crate::model::decimal_serde")]
    pub rate: Decimal,
    /// Provider of the observation; ranks same-day rows like quotes.
    #[serde(default)]
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RawObservedSnapshot {
    pub account_id: String,
    pub date: NaiveDate,
    pub positions: Vec<RawObservedPosition>,
    #[serde(with = "crate::model::decimal_serde::pairs")]
    pub cash: Vec<(String, Decimal)>,
    #[serde(with = "crate::model::decimal_serde")]
    pub cost_basis: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub net_contribution: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub net_contribution_base: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub cash_total_account_currency: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub cash_total_base_currency: Decimal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RawObservedPosition {
    pub asset_id: String,
    /// Stored position currency; empty means the asset's quote currency.
    #[serde(default)]
    pub currency: String,
    #[serde(with = "crate::model::decimal_serde")]
    pub quantity: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub average_cost: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub total_cost_basis: Decimal,
    #[serde(default, with = "crate::model::decimal_serde::option")]
    pub cost_basis_account: Option<Decimal>,
    #[serde(default, with = "crate::model::decimal_serde::option")]
    pub cost_basis_base: Option<Decimal>,
}
