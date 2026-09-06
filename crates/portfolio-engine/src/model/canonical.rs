//! Canonical (typed, ordered, validated) facts produced by `normalize`.

use std::collections::BTreeMap;

use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use super::policy::Policy;
use super::scalar::{AccountId, ActivityId, AssetId, Currency};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CanonicalFacts {
    pub policy: Policy,
    pub accounts: BTreeMap<AccountId, AccountFacts>,
    pub assets: BTreeMap<AssetId, AssetFacts>,
    /// Posted activities in the total order (local date, timestamp, id).
    pub activities: Vec<Activity>,
    pub transfer_pairs: TransferPairs,
    pub quotes: Vec<QuoteObservation>,
    pub fx_rates: Vec<FxObservation>,
    pub observed_snapshots: Vec<ObservedSnapshot>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AccountKind {
    Securities,
    Cash,
    CreditCard,
    Cryptocurrency,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TrackingMode {
    Transactions,
    Holdings,
    NotSet,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AccountFacts {
    pub id: AccountId,
    pub currency: Currency,
    pub kind: AccountKind,
    pub tracking: TrackingMode,
    pub archived: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AssetFacts {
    pub id: AssetId,
    /// May be a minor-unit code (`GBp`); the policy table normalizes it.
    /// `None` when the asset row carries no currency: positions then take
    /// the currency of the activity that opens them, never a default.
    pub quote_currency: Option<Currency>,
    /// Alternative assets (property, vehicles, …) are net-worth only.
    pub alternative: bool,
    #[serde(with = "crate::model::decimal_serde")]
    pub contract_multiplier: Decimal,
    /// Options and equity-like assets may carry negative (short) lots.
    pub allows_negative_lots: bool,
    /// Equity-like assets need explicit POSITION_OPEN/CLOSE intent to go short.
    pub requires_explicit_short_intent: bool,
}

impl AssetFacts {
    /// Facts assumed for an asset the request did not include (legacy: the
    /// activity currency, multiplier 1, not shortable).
    pub fn fallback(id: AssetId, currency: Currency) -> Self {
        Self {
            id,
            quote_currency: Some(currency),
            alternative: false,
            contract_multiplier: Decimal::ONE,
            allows_negative_lots: false,
            requires_explicit_short_intent: false,
        }
    }
}

/// The closed vocabulary of 14 activity types.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ActivityKind {
    Buy,
    Sell,
    Dividend,
    Interest,
    Deposit,
    Withdrawal,
    TransferIn,
    TransferOut,
    Fee,
    Tax,
    Split,
    Credit,
    Adjustment,
    Unknown,
}

impl ActivityKind {
    pub fn parse(raw: &str) -> Option<Self> {
        Some(match raw.trim() {
            "BUY" => Self::Buy,
            "SELL" => Self::Sell,
            "DIVIDEND" => Self::Dividend,
            "INTEREST" => Self::Interest,
            "DEPOSIT" => Self::Deposit,
            "WITHDRAWAL" => Self::Withdrawal,
            "TRANSFER_IN" => Self::TransferIn,
            "TRANSFER_OUT" => Self::TransferOut,
            "FEE" => Self::Fee,
            "TAX" => Self::Tax,
            "SPLIT" => Self::Split,
            "CREDIT" => Self::Credit,
            "ADJUSTMENT" => Self::Adjustment,
            "UNKNOWN" => Self::Unknown,
            _ => return None,
        })
    }

    pub fn is_transfer(self) -> bool {
        matches!(self, Self::TransferIn | Self::TransferOut)
    }
}

/// The 10 canonical subtypes (broker aliases collapse onto these).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Subtype {
    Drip,
    StakingReward,
    DividendInKind,
    Bonus,
    Rebate,
    Refund,
    Reimbursement,
    OptionExpiry,
    PositionOpen,
    PositionClose,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Activity {
    pub id: ActivityId,
    pub account: AccountId,
    pub asset: Option<AssetId>,
    /// Effective kind (`activity_type_override` wins).
    pub kind: ActivityKind,
    pub subtype: Option<Subtype>,
    /// User-local business date (policy timezone), computed once.
    pub date: NaiveDate,
    pub timestamp: DateTime<Utc>,
    /// Same-instant tiebreaker (insertion order), then the id.
    pub created_at: DateTime<Utc>,
    /// Magnitudes: direction comes solely from the kind.
    #[serde(with = "crate::model::decimal_serde")]
    pub quantity: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub unit_price: Decimal,
    /// Stored final cash magnitude; `None` books zero cash.
    #[serde(default, with = "crate::model::decimal_serde::option")]
    pub amount: Option<Decimal>,
    #[serde(with = "crate::model::decimal_serde")]
    pub fee: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub tax: Decimal,
    pub currency: Currency,
    /// Activity → account currency rate supplied with the row (positive).
    #[serde(default, with = "crate::model::decimal_serde::option")]
    pub fx_rate: Option<Decimal>,
    pub source_group_id: Option<String>,
    /// `metadata.flow.is_external` when present.
    pub external_transfer: Option<bool>,
    /// Transfer of a non-cash asset (cash placeholders count as cash).
    pub is_security_transfer: bool,
    /// Provenance used to rank competing split rows (`resolve_surfaces`).
    pub source_system: Option<String>,
    pub is_user_modified: bool,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TransferPair {
    pub group_id: String,
    pub transfer_out: ActivityId,
    pub transfer_in: ActivityId,
    pub out_account: AccountId,
    pub in_account: AccountId,
    pub security: bool,
}

impl TransferPair {
    pub fn counterparty(&self, activity: &ActivityId) -> Option<&AccountId> {
        if *activity == self.transfer_in {
            Some(&self.out_account)
        } else if *activity == self.transfer_out {
            Some(&self.in_account)
        } else {
            None
        }
    }
}

/// Resolved transfer pairs keyed by `source_group_id`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TransferPairs {
    pub by_group: BTreeMap<String, TransferPair>,
    group_by_activity: BTreeMap<ActivityId, String>,
}

impl TransferPairs {
    pub fn insert(&mut self, pair: TransferPair) {
        self.group_by_activity
            .insert(pair.transfer_in.clone(), pair.group_id.clone());
        self.group_by_activity
            .insert(pair.transfer_out.clone(), pair.group_id.clone());
        self.by_group.insert(pair.group_id.clone(), pair);
    }

    pub fn pair_for(&self, activity: &ActivityId) -> Option<&TransferPair> {
        self.group_by_activity
            .get(activity)
            .and_then(|group| self.by_group.get(group))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QuoteObservation {
    pub asset: AssetId,
    pub day: NaiveDate,
    #[serde(with = "crate::model::decimal_serde")]
    pub close: Decimal,
    pub currency: Currency,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FxObservation {
    pub from: Currency,
    pub to: Currency,
    pub day: NaiveDate,
    #[serde(with = "crate::model::decimal_serde")]
    pub rate: Decimal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ObservedSnapshot {
    pub account: AccountId,
    pub date: NaiveDate,
    pub positions: BTreeMap<AssetId, ObservedPosition>,
    #[serde(default, with = "crate::model::decimal_serde::map")]
    pub cash: BTreeMap<Currency, Decimal>,
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
pub struct ObservedPosition {
    /// Stored position currency; `None` means the asset's quote currency.
    #[serde(default)]
    pub currency: Option<Currency>,
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
