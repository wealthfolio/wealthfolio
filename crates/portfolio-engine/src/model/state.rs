//! Projection state: positions, lots, cash and net contribution per account,
//! plus the in-flight transfer cache. A `ProjectionState` is a lossless
//! checkpoint: `project(D..T, from state(D−1))` ≡ `project(genesis..T)` (I1).

use std::collections::BTreeMap;

use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use super::scalar::{AccountId, ActivityId, AssetId, Currency, EventId};
use crate::diagnostics::Diagnostic;

/// Inclusive calendar-date range.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DateRange {
    pub start: NaiveDate,
    pub end: NaiveDate,
}

impl DateRange {
    pub fn days(&self) -> impl Iterator<Item = NaiveDate> + use<> {
        let end = self.end;
        self.start.iter_days().take_while(move |day| *day <= end)
    }
}

/// State of every projected account at the end of `date`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectionState {
    pub date: NaiveDate,
    pub accounts: BTreeMap<AccountId, AccountState>,
    /// Lots removed by a TRANSFER_OUT awaiting the paired TRANSFER_IN, keyed
    /// by `source_group_id`. Part of the state so a checkpoint carries
    /// in-flight transfers across a range boundary.
    pub transfer_cache: BTreeMap<String, Vec<Lot>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AccountState {
    pub account: AccountId,
    pub currency: Currency,
    pub positions: BTreeMap<AssetId, Position>,
    #[serde(default, with = "crate::model::decimal_serde::map")]
    pub cash: BTreeMap<Currency, Decimal>,
    /// Book cost of all positions in the account currency (acquisition FX).
    #[serde(with = "crate::model::decimal_serde")]
    pub cost_basis: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub net_contribution: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub net_contribution_base: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub cash_total_account: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub cash_total_base: Decimal,
}

impl AccountState {
    pub fn empty(account: AccountId, currency: Currency) -> Self {
        Self {
            account,
            currency,
            positions: BTreeMap::new(),
            cash: BTreeMap::new(),
            cost_basis: Decimal::ZERO,
            net_contribution: Decimal::ZERO,
            net_contribution_base: Decimal::ZERO,
            cash_total_account: Decimal::ZERO,
            cash_total_base: Decimal::ZERO,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Position {
    pub asset: AssetId,
    /// Asset quote currency; lot costs are stored in it.
    pub currency: Currency,
    /// Effective (post-split) units; single-signed per asset.
    #[serde(with = "crate::model::decimal_serde")]
    pub quantity: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub average_cost: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub total_cost_basis: Decimal,
    /// FIFO book, sorted by acquisition instant; quantities are as-acquired.
    pub lots: Vec<Lot>,
    pub alternative: bool,
    #[serde(with = "crate::model::decimal_serde")]
    pub contract_multiplier: Decimal,
    pub inception: DateTime<Utc>,
    /// Book cost at acquisition FX in the account / base currency; `None`
    /// when a lot's acquisition-date rate is unavailable.
    #[serde(default, with = "crate::model::decimal_serde::option")]
    pub cost_basis_account: Option<Decimal>,
    #[serde(default, with = "crate::model::decimal_serde::option")]
    pub cost_basis_base: Option<Decimal>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Lot {
    pub id: String,
    pub acquisition: DateTime<Utc>,
    /// User-local acquisition date: the FX lookup key.
    pub acquisition_date: NaiveDate,
    /// Signed, as-acquired units (negative = short).
    #[serde(with = "crate::model::decimal_serde")]
    pub quantity: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub original_quantity: Decimal,
    /// Total paid for the lot in the position currency, charges included.
    #[serde(with = "crate::model::decimal_serde")]
    pub cost_basis: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub acquisition_price: Decimal,
    /// Remaining fee/tax allocation (reduced on partial sells).
    #[serde(with = "crate::model::decimal_serde")]
    pub fees: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub original_fees: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub taxes: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub original_taxes: Decimal,
    #[serde(default, with = "crate::model::decimal_serde::option")]
    pub fx_rate_to_position: Option<Decimal>,
    #[serde(default, with = "crate::model::decimal_serde::option")]
    pub fx_rate_to_account: Option<Decimal>,
    pub account_currency: Option<Currency>,
    #[serde(default, with = "crate::model::decimal_serde::option")]
    pub fx_rate_to_base: Option<Decimal>,
    pub base_currency: Option<Currency>,
    /// Event (activity or composite leg) that opened the lot.
    pub source_event: Option<EventId>,
    /// Cumulative post-acquisition split ratio; effective units = quantity × ratio.
    #[serde(with = "crate::model::decimal_serde")]
    pub split_ratio: Decimal,
}

impl Lot {
    pub fn effective_quantity(&self) -> Decimal {
        self.quantity * self.split_ratio
    }

    /// Stored acquisition rate to `target`, when the lot recorded one.
    pub fn stored_fx_rate_to(&self, target: &str) -> Option<Decimal> {
        let matches = |currency: &Option<Currency>| {
            currency
                .as_ref()
                .is_some_and(|c| c.as_str().eq_ignore_ascii_case(target))
        };
        if matches(&self.account_currency) {
            if let Some(rate) = self.fx_rate_to_account.filter(|r| !r.is_zero()) {
                return Some(rate);
            }
        }
        if matches(&self.base_currency) {
            if let Some(rate) = self.fx_rate_to_base.filter(|r| !r.is_zero()) {
                return Some(rate);
            }
        }
        None
    }
}

/// One sold/transferred/expired slice of a lot (realized P&L fact).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LotDisposal {
    pub id: String,
    pub lot_id: String,
    pub account: AccountId,
    pub asset: AssetId,
    /// Disposing event (activity or composite leg).
    pub event: EventId,
    pub date: NaiveDate,
    /// Effective units disposed (signed like the lot).
    #[serde(with = "crate::model::decimal_serde")]
    pub quantity: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub proceeds: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub cost_basis: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub realized_pnl: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub proceeds_base: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub cost_basis_base: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub realized_pnl_base: Decimal,
    pub currency: Currency,
    #[serde(with = "crate::model::decimal_serde")]
    pub fx_rate_to_base: Decimal,
}

/// A lot fully consumed on `close_date`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LotClosure {
    pub lot_id: String,
    pub account: AccountId,
    pub asset: AssetId,
    pub close_date: NaiveDate,
    pub close_event: EventId,
    pub open_event: Option<EventId>,
    pub open_date: NaiveDate,
    #[serde(with = "crate::model::decimal_serde")]
    pub original_quantity: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub cost_per_unit: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub original_cost_basis: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub original_cost_basis_base: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub fee_allocated: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub fee_allocated_base: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub tax_allocated: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub tax_allocated_base: Decimal,
    pub currency: Currency,
    #[serde(with = "crate::model::decimal_serde")]
    pub fx_rate_to_base: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub split_ratio: Decimal,
}

/// A lot as storage keeps it (open or closed), the shape hosts persist and
/// attribution reads.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LotRecord {
    pub id: String,
    pub account: AccountId,
    pub asset: AssetId,
    pub open_date: NaiveDate,
    /// The opening activity, when the lot was opened by a stored activity
    /// row rather than a synthetic composite leg.
    pub open_activity: Option<ActivityId>,
    #[serde(with = "crate::model::decimal_serde")]
    pub original_quantity: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub remaining_quantity: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub cost_per_unit: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub original_cost_basis: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub remaining_cost_basis: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub original_cost_basis_base: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub remaining_cost_basis_base: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub fee_allocated: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub fee_allocated_base: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub tax_allocated: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub tax_allocated_base: Decimal,
    pub currency: Currency,
    #[serde(with = "crate::model::decimal_serde")]
    pub fx_rate_to_base: Decimal,
    #[serde(default, with = "crate::model::decimal_serde::option")]
    pub fx_rate_to_account: Option<Decimal>,
    #[serde(with = "crate::model::decimal_serde")]
    pub split_ratio: Decimal,
    pub close_date: Option<NaiveDate>,
    pub close_event: Option<EventId>,
}

impl LotRecord {
    pub fn is_closed(&self) -> bool {
        self.close_date.is_some()
    }
}

/// Sparse keyframe: an account's state on a day it changed (or its first day).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Keyframe {
    pub date: NaiveDate,
    pub state: AccountState,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectionBundle {
    /// Keyframes per account, sorted by date.
    pub keyframes: BTreeMap<AccountId, Vec<Keyframe>>,
    /// State at the end of the range: the next chunk's input (I2).
    pub final_state: ProjectionState,
    pub disposals: Vec<LotDisposal>,
    pub closures: Vec<LotClosure>,
    pub diagnostics: Vec<Diagnostic>,
}
