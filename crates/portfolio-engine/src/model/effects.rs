//! Priced events: what scope aggregation and `measure` need from the facts,
//! computed once by the value stage (`value::effects`). Plain data, so
//! measuring stored rows reads no raw facts and resolves no rates: every
//! amount here is already in base currency, and a conversion that failed is
//! `None` rather than a zero.

use std::collections::BTreeMap;

use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use super::canonical::{AccountKind, TrackingMode};
use super::event::Boundary;
use super::policy::CostBasisMethod;
use super::scalar::{AccountId, ActivityId, Currency, EventId};
use super::state::DateRange;
use super::valuation::FlowSource;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Effects {
    pub base_currency: Currency,
    /// The range the flows were priced over; events outside it carry none.
    pub range: DateRange,
    pub accounts: BTreeMap<AccountId, AccountProfile>,
    /// One entry per ledger event, in ledger order.
    pub events: Vec<EventEffect>,
    /// Resolved transfer pairs, in group order.
    pub pairs: Vec<PairEffect>,
}

impl Effects {
    pub fn account(&self, id: &AccountId) -> Option<&AccountProfile> {
        self.accounts.get(id)
    }
}

/// An account's static facts, as measurement needs them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AccountProfile {
    pub currency: Currency,
    pub tracking: TrackingMode,
    pub kind: AccountKind,
    pub archived: bool,
    /// How its disposals chose their lots: a WAC account's purchases pool
    /// (rules R7.2).
    #[serde(default)]
    pub cost_basis_method: CostBasisMethod,
    /// Whether it has started by `as_of`: a transactions account has an
    /// activity, a holdings account an observed snapshot. One that has not
    /// holds and moves nothing, so a scope leaves it out (P-IDLE).
    pub started: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventEffect {
    pub id: EventId,
    pub source: ActivityId,
    pub account: AccountId,
    pub date: NaiveDate,
    /// Activity currency (a pair of legs in two currencies carries FX).
    pub currency: Currency,
    /// Account-scope boundary; a scope decides whether an internal leg is
    /// external to it.
    pub boundary: Boundary,
    /// The event's flow priced for a boundary (external, or unknown for an
    /// unknown boundary); `None` for an event that is no flow or lies
    /// outside the priced range.
    pub flow: Option<PricedFlow>,
    /// Attribution in base (`EconomicEvent::attribution` converted on the
    /// event date); `None` when the conversion failed.
    #[serde(default, with = "crate::model::decimal_serde::option")]
    pub income: Option<Decimal>,
    #[serde(default, with = "crate::model::decimal_serde::option")]
    pub fee: Option<Decimal>,
    #[serde(default, with = "crate::model::decimal_serde::option")]
    pub tax: Option<Decimal>,
    /// Its disposals are realised P&L: a trade, an option's expiry, or a
    /// transfer in (the units it delivers cover a short). A transfer out
    /// moves lots at their cost and realizes nothing (rules R2.4).
    pub realizes: bool,
    /// The charges of a BUY or SELL row, in base, when it has any and they
    /// convert.
    pub trade_charge: Option<TradeCharge>,
    /// The row carried an explicit external-transfer marker.
    pub marked_external: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PricedFlow {
    #[serde(with = "crate::model::decimal_serde")]
    pub amount: Decimal,
    pub source: FlowSource,
    /// Direction at a scope boundary (the activity-flow classification).
    pub outflow: bool,
    /// Direction as a netted internal leg: a security transfer's direction
    /// decides, else the sign of its cash.
    pub leg_outflow: bool,
    /// The units a security transfer's flow prices: what an outgoing leg
    /// removed from its account, what an incoming leg records. Zero for
    /// other flows.
    #[serde(default, with = "crate::model::decimal_serde")]
    pub units: Decimal,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TradeCharge {
    #[serde(with = "crate::model::decimal_serde")]
    pub charge: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub quantity: Decimal,
    pub buy: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PairEffect {
    pub group: String,
    pub transfer_in: ActivityId,
    pub transfer_out: ActivityId,
    pub in_account: AccountId,
    pub out_account: AccountId,
    /// A pair of security legs (not cash).
    #[serde(default)]
    pub security: bool,
}
