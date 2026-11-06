use std::collections::VecDeque;
use std::collections::{HashMap, HashSet};

use rust_decimal::Decimal;

use super::holdings_service::{asset_income_amount, gain_pct, refresh_total_return};
use super::{Holding, HoldingType, HoldingsRead, MonetaryValue};
use crate::activities::{
    Activity, NewActivity, ACTIVITY_SUBTYPE_OPTION_EXPIRY, ACTIVITY_SUBTYPE_RETURN_OF_CAPITAL,
};
use crate::fx::currency::{normalize_amount, normalize_currency_code};
use crate::fx::currency_converter::CurrencyConverter;
use crate::portfolio::snapshot::{AccountStateSnapshot, Position};
use crate::utils::time_utils::{activity_date_in_tz, parse_user_timezone_or_default};

/// Select a recorded book in the requested currency. Minor-unit denomination
/// changes are exact; changing historical FX or relabelling an amount is not.
pub(super) fn recorded(amount: Option<Decimal>, currency: &str, target: &str) -> Option<Decimal> {
    if normalize_currency_code(currency) != normalize_currency_code(target) {
        return None;
    }
    Some(normalize_amount(amount?, currency).0 / normalize_amount(Decimal::ONE, target).0)
}

pub(super) fn snapshot_cost(
    position: &Position,
    snapshot: &AccountStateSnapshot,
    target: &str,
) -> Option<Decimal> {
    recorded(Some(position.total_cost_basis), &position.currency, target)
        .or_else(|| recorded(position.cost_basis_account, &snapshot.currency, target))
        .or_else(|| {
            recorded(
                position.cost_basis_base,
                snapshot.base_currency.as_deref()?,
                target,
            )
        })
}

pub(super) fn translate(
    converter: &CurrencyConverter,
    amount: Decimal,
    from: &str,
    to: &str,
    day: chrono::NaiveDate,
) -> Option<Decimal> {
    let (amount, from) = normalize_amount(amount, from);
    let (factor, to) = normalize_amount(Decimal::ONE, to);
    converter
        .convert_amount(amount, from, to, day)
        .ok()
        .map(|value| value / factor)
}

pub(super) fn realizes(activity: &Activity) -> bool {
    let kind = activity.effective_type();
    let subtype = NewActivity::canonicalize_subtype(activity.subtype.as_deref());
    activity.is_posted()
        && (matches!(kind, "BUY" | "SELL" | "TRANSFER_IN")
            || (kind == "ADJUSTMENT" && subtype.as_deref() == Some(ACTIVITY_SUBTYPE_OPTION_EXPIRY))
            || (matches!(kind, "ADJUSTMENT" | "DIVIDEND")
                && subtype.as_deref() == Some(ACTIVITY_SUBTYPE_RETURN_OF_CAPITAL)))
}

pub(super) fn display_lots(
    read: &HoldingsRead,
    account: &str,
    position: &Position,
) -> Option<VecDeque<crate::portfolio::snapshot::Lot>> {
    let rows: Vec<_> = read
        .lots
        .iter()
        .filter(|lot| {
            lot.account_id == account && lot.asset_id == position.asset_id && !lot.is_closed
        })
        .collect();
    let mut quantity = Decimal::ZERO;
    let mut cost = Decimal::ZERO;
    let mut base_cost = Decimal::ZERO;
    let base_book = read
        .snapshots
        .get(account)
        .and_then(|snapshot| snapshot.base_currency.as_deref())
        .zip(position.cost_basis_base);
    let mut result = VecDeque::new();
    for row in rows {
        if normalize_currency_code(&row.currency) != normalize_currency_code(&position.currency)
            || chrono::NaiveDate::parse_from_str(&row.open_date, "%Y-%m-%d").is_err()
        {
            return None;
        }
        for value in [
            &row.original_quantity,
            &row.original_cost_basis,
            &row.cost_per_unit,
            &row.fee_allocated,
            &row.tax_allocated,
        ] {
            value.parse::<Decimal>().ok()?;
        }
        let split = row
            .split_ratio
            .parse::<Decimal>()
            .ok()
            .filter(|ratio| *ratio > Decimal::ZERO)?;
        quantity += row
            .remaining_quantity
            .parse::<Decimal>()
            .ok()?
            .checked_mul(split)?;
        cost += recorded(
            row.remaining_cost_basis.parse().ok(),
            &row.currency,
            &position.currency,
        )?;
        if let Some((currency, _)) = base_book {
            base_cost += recorded(
                row.remaining_cost_basis_base.parse().ok(),
                &row.base_currency,
                currency,
            )?;
        }
        let mut lot = crate::lots::lot_record_to_snapshot_lot(&position.id, row.clone());
        lot.fx_rate_to_base = lot.fx_rate_to_base.filter(|rate| *rate > Decimal::ZERO);
        lot.fx_rate_to_account = lot.fx_rate_to_account.filter(|rate| *rate > Decimal::ZERO);
        scale_lot(
            &mut lot,
            normalize_amount(Decimal::ONE, &row.currency).0
                / normalize_amount(Decimal::ONE, &position.currency).0,
        );
        result.push_back(lot);
    }
    if crate::portfolio::snapshot::is_quantity_significant(&(quantity - position.quantity))
        || !(cost - position.total_cost_basis)
            .round_dp(crate::constants::DECIMAL_PRECISION)
            .is_zero()
    {
        return None;
    }
    if base_book.is_some_and(|(_, recorded)| {
        !(base_cost - recorded)
            .round_dp(crate::constants::DECIMAL_PRECISION)
            .is_zero()
    }) {
        return None;
    }
    Some(result)
}

pub(super) fn scale_lot(lot: &mut crate::portfolio::snapshot::Lot, factor: Decimal) {
    lot.cost_basis *= factor;
    lot.acquisition_price *= factor;
    lot.acquisition_fees *= factor;
    lot.original_acquisition_fees *= factor;
    lot.original_acquisition_taxes *= factor;
    lot.acquisition_taxes *= factor;
    lot.fx_rate_to_position = lot.fx_rate_to_position.map(|rate| rate * factor);
    lot.fx_rate_to_base = lot.fx_rate_to_base.map(|rate| rate / factor);
    lot.fx_rate_to_account = lot.fx_rate_to_account.map(|rate| rate / factor);
}

#[allow(clippy::too_many_arguments)]
pub(super) fn income_from_activities(
    activities: &[Activity],
    rejected: &HashSet<String>,
    currencies: &HashMap<String, String>,
    base: &str,
    convert: impl Fn(Decimal, &str, &str, chrono::NaiveDate) -> Option<Decimal>,
    timezone: chrono_tz::Tz,
    as_of: chrono::NaiveDate,
) -> HashMap<String, MonetaryValue> {
    let mut result = HashMap::new();
    for activity in activities {
        let day = activity_date_in_tz(activity.activity_date, timezone);
        if !activity.is_posted() || rejected.contains(&activity.id) || day > as_of {
            continue;
        }
        let Some(asset) = activity.asset_id.as_ref() else {
            continue;
        };
        let Some(local) = currencies.get(asset) else {
            continue;
        };
        let Some(amount) = asset_income_amount(activity).filter(|amount| !amount.is_zero()) else {
            continue;
        };
        let value = MonetaryValue::new(
            convert(amount, &activity.currency, local, day),
            convert(amount, &activity.currency, base, day),
        );
        let entry = result
            .entry(asset.clone())
            .or_insert_with(MonetaryValue::zero);
        *entry = entry.add(&value);
    }
    result
}

/// Current position basis is already supplied by the snapshot. This function
/// supplies only recorded realized history and income, from the captured read.
pub(super) fn apply_history(
    read: &HoldingsRead,
    converter: &CurrencyConverter,
    account_id: &str,
    holdings: &mut [Holding],
) -> crate::Result<()> {
    let timezone = parse_user_timezone_or_default(&read.timezone);
    let rejected: HashSet<String> = read
        .issues
        .iter()
        .filter(|i| i.kind == crate::portfolio::projection::ActivityIssueKind::Rejected)
        .map(|i| i.activity_id.clone())
        .collect();
    let activities: Vec<Activity> = read
        .activities
        .iter()
        .filter(|a| a.account_id == account_id)
        .cloned()
        .collect();
    let currencies: HashMap<String, String> = holdings
        .iter()
        .filter_map(|h| {
            h.instrument
                .as_ref()
                .map(|i| (i.id.clone(), h.local_currency.clone()))
        })
        .collect();
    let base = holdings
        .first()
        .map(|h| h.base_currency.as_str())
        .unwrap_or(&read.base_currency);
    let incomes = income_from_activities(
        &activities,
        &rejected,
        &currencies,
        base,
        |amount, from, to, day| translate(converter, amount, from, to, day),
        timezone,
        read.day,
    );
    let trades: HashSet<&str> = read
        .activities
        .iter()
        .filter(|a| a.account_id == account_id && realizes(a))
        .filter(|a| {
            activity_date_in_tz(a.activity_date, timezone) <= read.day
                && !rejected.contains(a.id.as_str())
        })
        .map(|a| a.id.as_str())
        .collect();
    let pending = read.history_pending(account_id, read.day);
    for holding in holdings {
        if holding.holding_type == HoldingType::Cash {
            holding.income = Some(MonetaryValue::zero());
            holding.return_basis = holding.cost_basis.clone();
            refresh_total_return(holding);
            continue;
        }
        let Some(asset_id) = holding.instrument.as_ref().map(|i| i.id.as_str()) else {
            continue;
        };
        let mut realized = MonetaryValue::zero();
        let mut disposed = MonetaryValue::zero();
        let mut has_disposals = false;
        for disposal in read.disposals.iter().filter(|d| {
            d.account_id == account_id
                && d.asset_id == asset_id
                && trades.contains(d.disposal_activity_id.as_str())
        }) {
            has_disposals = true;
            let local_profit = disposal.realized_pnl.parse().ok();
            let local_cost = disposal.cost_basis.parse().ok();
            let base_profit = (disposal.proceeds_base_known == Some(true)
                && disposal.cost_basis_base_known == Some(true))
            .then(|| disposal.realized_pnl_base.parse().ok())
            .flatten();
            let base_cost = (disposal.cost_basis_base_known == Some(true))
                .then(|| disposal.cost_basis_base.parse().ok())
                .flatten();
            let select = |local, base, target: &str| {
                recorded(local, &disposal.currency, target)
                    .or_else(|| recorded(base, &disposal.base_currency, target))
            };
            realized = realized.add(&MonetaryValue::new(
                select(local_profit, base_profit, &holding.local_currency),
                select(local_profit, base_profit, &holding.base_currency),
            ));
            disposed = disposed.add(&MonetaryValue::new(
                select(local_cost, base_cost, &holding.local_currency),
                select(local_cost, base_cost, &holding.base_currency),
            ));
        }
        // An observed cost does not establish a sales history. Retained,
        // compatible recorded sales remain useful, without overriding its basis.
        if pending || (holding.translate_observed_basis && !has_disposals) {
            realized = MonetaryValue::unavailable();
            disposed = MonetaryValue::unavailable();
        }
        holding.realized_gain_pct = gain_pct(realized.local, disposed.local);
        holding.realized_gain = Some(realized.clone());
        holding.return_basis = Some(
            holding
                .cost_basis
                .as_ref()
                .unwrap_or(&MonetaryValue::unavailable())
                .add(&disposed),
        );
        let unrealized = if holding.is_closed {
            MonetaryValue::zero()
        } else {
            holding
                .unrealized_gain
                .clone()
                .unwrap_or_else(MonetaryValue::unavailable)
        };
        holding.total_gain = Some(unrealized.add(&realized));
        let income = if pending {
            MonetaryValue::unavailable()
        } else {
            incomes
                .get(asset_id)
                .cloned()
                .unwrap_or_else(MonetaryValue::zero)
        };
        holding.income = Some(income);
        refresh_total_return(holding);
    }
    Ok(())
}
