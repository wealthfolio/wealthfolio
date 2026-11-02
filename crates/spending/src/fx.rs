//! Currency conversion for the spending surfaces.
//!
//! Consolidates what were three byte-identical `fx_to_target` copies in
//! `insight`, `analytics` and `budget`, kept in step by comments. This lives in
//! its own module rather than beside the activity classifiers because it needs
//! a service and can fail — the classifiers are pure functions over `Activity`.

use chrono::NaiveDate;
use rust_decimal::Decimal;
use wealthfolio_core::fx::FxServiceTrait;

/// Converts `amount` from `from` into `to` at `as_of`.
///
/// Returns `None` only when the pair has no rate at all: the FX service already
/// resolves the nearest date, then falls back to the latest rate, before
/// failing.
///
/// Callers aggregating into a target currency must treat `None` as no
/// contribution. Substituting the unconverted amount mixes currencies into the
/// total — a missing EUR→JPY rate would add yen to a euro figure.
///
/// # Which date to pass
///
/// `as_of` is the caller's decision, and the crate deliberately runs two
/// conventions:
///
/// * `insight`, `analytics` and `budget` pass **one rate per report** — the
///   period's snapshot date, matching the net-worth convention. Period
///   comparisons then reflect spending rather than currency drift.
/// * `cash_activities` passes **each activity's own date**, because a
///   transaction list reports what a row actually cost at the time. This
///   matches how acquisitions are valued (`Lot::stored_fx_rate_to`, else the
///   acquisition-date rate).
///
/// The two therefore disagree by design, and a total on the transactions tab
/// need not equal the same span in Reports.
pub(crate) fn convert(
    fx: &dyn FxServiceTrait,
    amount: Decimal,
    from: &str,
    to: &str,
    as_of: NaiveDate,
) -> Option<Decimal> {
    if amount == Decimal::ZERO || from == to || from.is_empty() {
        return Some(amount);
    }
    match fx.convert_currency_for_date(amount, from, to, as_of) {
        Ok(converted) => Some(converted),
        Err(e) => {
            log::warn!(
                "spending FX conversion {}→{} on {} failed ({}); excluding native amount",
                from,
                to,
                as_of,
                e,
            );
            None
        }
    }
}

/// Coverage of the conversions attempted by a native calculation. Zero means
/// no missing rate, not a guarantee about the source data or accounting policy.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalculationQuality {
    pub missing_fx_transactions: usize,
    pub missing_fx_currencies: std::collections::BTreeSet<String>,
}

impl CalculationQuality {
    pub(crate) fn record_missing(&mut self, currency: &str) {
        self.missing_fx_transactions += 1;
        self.missing_fx_currencies.insert(currency.to_string());
    }
}
