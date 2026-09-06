//! `EconomicEvent`: the single economics authority (architecture §4.2). Every
//! downstream stage reads these; nobody re-interprets raw activities.
//!
//! An event says what an activity MEANS — signed cash, charges, the position
//! action, the net-contribution rule, and the external-flow classification —
//! without touching state. `project` applies actions to lots and cash;
//! `value` prices flows that need quotes.

use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use super::scalar::{AccountId, ActivityId, AssetId, Currency, EventId};
use crate::diagnostics::Diagnostic;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EconomicEvent {
    /// Synthetic legs keep traceable ids (`{activity}:dividend`, `{activity}:buy`).
    pub id: EventId,
    pub source: ActivityId,
    pub account: AccountId,
    pub date: NaiveDate,
    pub timestamp: DateTime<Utc>,
    /// Position in the ledger's total order.
    pub sequence: u32,
    /// Activity currency: charges and activity-currency bookings use it.
    pub currency: Currency,
    pub cash: Option<CashEffect>,
    pub charges: Charges,
    pub action: Action,
    pub contribution: Contribution,
    pub flow: Flow,
    pub diagnostics: Vec<Diagnostic>,
}

/// Signed cash movement resolved from the stored final amount.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CashEffect {
    /// Signed final cash in the activity currency (before booking).
    #[serde(with = "crate::model::decimal_serde")]
    pub amount: Decimal,
    /// Signed pre-charge economics (`None` when not derivable).
    #[serde(default, with = "crate::model::decimal_serde::option")]
    pub gross: Option<Decimal>,
    pub booking: Booking,
}

/// Which cash bucket the movement lands in.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum Booking {
    ActivityCurrency,
    /// Trades carrying a broker FX rate settle in account currency at
    /// `amount × rate`.
    AccountCurrency {
        rate: Decimal,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Charges {
    #[serde(with = "crate::model::decimal_serde")]
    pub fee: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub tax: Decimal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Action {
    None,
    Trade {
        asset: AssetId,
        side: Side,
        quantity: Decimal,
        /// Reported unit price (activity currency); the effective book price
        /// derives from the gross cash when available.
        unit_price: Decimal,
        intent: Option<Intent>,
    },
    SecurityTransfer {
        asset: AssetId,
        direction: Direction,
        quantity: Decimal,
        unit_price: Decimal,
        /// Legacy transfers carried the book basis in `amount`.
        legacy_amount: Option<Decimal>,
        /// Pairing key (present even when unpaired; the pair table decides).
        group: Option<String>,
    },
    Split {
        asset: AssetId,
        ratio: Decimal,
    },
    OptionExpiry {
        asset: AssetId,
        quantity: Decimal,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Side {
    Buy,
    Sell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Intent {
    Open,
    Close,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Direction {
    In,
    Out,
}

/// How the event moves net contribution (amounts are computed in `project`,
/// where lots and FX are known).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Contribution {
    None,
    /// Signed gross cash, converted to account and base currency.
    CashGross,
    /// Plus the delivered lots' book basis.
    SecurityIn,
    /// Minus the removed lots' book basis.
    SecurityOut,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Flow {
    pub boundary: Boundary,
    pub value: FlowValue,
}

impl Flow {
    pub const NONE: Flow = Flow {
        boundary: Boundary::None,
        value: FlowValue::None,
    };
}

/// Account-scope boundary; portfolio scope nets `Internal` pairs whose
/// counterparty is in the evaluated scope.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Boundary {
    None,
    External,
    Internal { counterparty: AccountId },
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum FlowValue {
    None,
    /// Gross cash magnitude in the activity currency.
    Cash(Decimal),
    /// Priced in `value`: transfer-day quote × quantity, else book basis,
    /// else (transfer-out) removed-lot basis, else legacy amount.
    SecurityAtMarket {
        quantity: Decimal,
        book_basis: Option<Decimal>,
        legacy_amount: Option<Decimal>,
    },
}
