//! Trade-economics, position-intent, and asset-fact cache helpers
//! shared across the holdings-calculator handlers.
use crate::activities::{
    Activity, ActivityType, NewActivity, ACTIVITY_SUBTYPE_POSITION_CLOSE,
    ACTIVITY_SUBTYPE_POSITION_OPEN,
};
use crate::constants::DECIMAL_PRECISION;
use crate::portfolio::economic_events::ActivityEconomicsResolver;
use crate::portfolio::snapshot::{AccountStateSnapshot, Position};
use rust_decimal::Decimal;
use std::collections::HashMap;
use std::str::FromStr;

/// Helper function for cash mutations.
/// Books cash in the specified currency (should be activity.currency per design spec).
#[inline]
pub(crate) fn add_cash(state: &mut AccountStateSnapshot, currency: &str, delta: Decimal) {
    *state
        .cash_balances
        .entry(currency.to_string())
        .or_insert(Decimal::ZERO) += delta;
}

#[derive(Clone)]
pub(crate) struct AssetPositionInfo {
    pub(crate) currency: String,
    pub(crate) is_alternative: bool,
    pub(crate) contract_multiplier: Decimal,
    pub(crate) is_bond: bool,
    pub(crate) allows_negative_lots: bool,
    pub(crate) requires_explicit_short_intent: bool,
}

pub(crate) type AssetCache = HashMap<String, AssetPositionInfo>;

impl AssetPositionInfo {
    pub(crate) fn fallback(activity_currency: &str) -> Self {
        Self {
            currency: activity_currency.to_string(),
            is_alternative: false,
            contract_multiplier: Decimal::ONE,
            is_bond: false,
            allows_negative_lots: false,
            requires_explicit_short_intent: false,
        }
    }
}

fn should_use_activity_amount(activity: &Activity, asset_info: &AssetPositionInfo) -> bool {
    let has_amount = activity.amount.is_some_and(|amount| !amount.is_zero());
    if !has_amount {
        return false;
    }

    if ActivityEconomicsResolver::is_security_transfer(activity) {
        return false;
    }

    let activity_type = ActivityType::from_str(activity.effective_type());
    let has_qty = activity.quantity.is_some_and(|qty| !qty.is_zero());
    let has_unit_price = activity.unit_price.is_some_and(|price| !price.is_zero());
    let is_buy_or_sell = matches!(activity_type, Ok(ActivityType::Buy | ActivityType::Sell));
    if !is_buy_or_sell {
        return true;
    }

    asset_info.is_bond || !has_qty || !has_unit_price
}

/// Gross trade value (pre-fee) for a BUY/SELL/TRANSFER lot.
/// Plain trades use qty * price; bonds and incomplete price/quantity rows use
/// broker amount when present.
#[inline]
pub(crate) fn gross_trade_amount(activity: &Activity, asset_info: &AssetPositionInfo) -> Decimal {
    if should_use_activity_amount(activity, asset_info) {
        activity.amt()
    } else {
        activity.qty() * activity.price() * asset_info.contract_multiplier
    }
}

/// Canonical position intent for an activity, resolved through the single
/// shared subtype vocabulary (`NewActivity::canonicalize_subtype_for_activity`)
/// rather than a calculator-local alias list. Returns the canonical subtype
/// (e.g. `POSITION_OPEN` / `POSITION_CLOSE`) or `None`.
fn canonical_position_intent(activity: &Activity) -> Option<String> {
    NewActivity::canonicalize_subtype_for_activity(
        activity.effective_type(),
        activity.subtype.as_deref(),
    )
}

pub(crate) fn has_position_close_intent(activity: &Activity) -> bool {
    canonical_position_intent(activity).as_deref() == Some(ACTIVITY_SUBTYPE_POSITION_CLOSE)
}

pub(crate) fn has_sell_short_open_intent(activity: &Activity) -> bool {
    canonical_position_intent(activity).as_deref() == Some(ACTIVITY_SUBTYPE_POSITION_OPEN)
}

pub(crate) fn parse_decimal_lossy(value: &str) -> Decimal {
    value.parse::<Decimal>().unwrap_or(Decimal::ZERO)
}

pub(crate) fn storage_money(value: Decimal) -> Decimal {
    value.round_dp(DECIMAL_PRECISION)
}

/// Per-share/per-contract acquisition price for a lot (multiplier-inclusive).
///
/// Mirrors `gross_trade_amount`: when `amount` is authoritative, derive the
/// per-unit price from it so the lot's cost basis matches the booked cash.
#[inline]
pub(crate) fn effective_unit_price(activity: &Activity, asset_info: &AssetPositionInfo) -> Decimal {
    let qty = activity.qty();
    if should_use_activity_amount(activity, asset_info) && !qty.is_zero() {
        activity.amt() / qty
    } else {
        activity.price() * asset_info.contract_multiplier
    }
}

pub(crate) fn proportional_amount(
    amount: Decimal,
    part_quantity: Decimal,
    total_quantity: Decimal,
) -> Decimal {
    if amount.is_zero() || part_quantity.is_zero() || total_quantity.is_zero() {
        Decimal::ZERO
    } else {
        amount * part_quantity / total_quantity
    }
}

pub(crate) fn positive_lot_effective_quantity(position: &Position) -> Decimal {
    position
        .lots
        .iter()
        .filter(|lot| lot.quantity > Decimal::ZERO)
        .map(|lot| lot.quantity * lot.effective_split_ratio())
        .sum()
}

pub(crate) fn negative_lot_effective_quantity_abs(position: &Position) -> Decimal {
    position
        .lots
        .iter()
        .filter(|lot| lot.quantity < Decimal::ZERO)
        .map(|lot| (lot.quantity * lot.effective_split_ratio()).abs())
        .sum()
}
