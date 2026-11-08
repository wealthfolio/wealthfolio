//! Historical FX policy: rates are causal and bounded.
//!
//! A conversion on a valued day may use only an observation on or before
//! that day, carried across at most seven calendar days. Calendar-day age is
//! intentional: weekends and market holidays can carry the last trading-day
//! rate, while a missing series eventually becomes unavailable.

use chrono::NaiveDate;
use rust_decimal::Decimal;

use super::FxSurface;

const MAX_AS_OF_AGE_DAYS: i64 = 7;

pub(super) fn direct_rate(
    surface: &FxSurface,
    from: &str,
    to: &str,
    date: NaiveDate,
) -> Option<(Decimal, i64)> {
    let history = surface.series.get(&(from.to_string(), to.to_string()))?;
    let (observed, rate) = history.range(..=date).next_back()?;
    let age = (date - *observed).num_days();
    if age > MAX_AS_OF_AGE_DAYS || *rate <= Decimal::ZERO {
        return None;
    }
    Some((*rate, age))
}
