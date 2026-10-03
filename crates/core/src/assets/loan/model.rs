//! The stored loan format: terms, dated events and balance provenance in asset
//! metadata and manual quotes. The engine reads it; the loan service writes it.
use chrono::NaiveDate;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use super::{money, valid_amount, InterestMethod, LoanFrequency, MAX_PAYMENTS};

pub const LOAN_PROJECTION_KEY: &str = "loan_projection";
pub const LOAN_EVENTS_KEY: &str = "loan_events";
pub const RENEWAL_MATURITY_KEY: &str = "renewal_maturity_date";
pub const TRACKING_MODE_KEY: &str = "tracking_mode";

/// Contractual terms as originally agreed; later changes are dated events.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoanTerms {
    pub version: u8,
    pub annual_rate: f64,
    pub payment_amount: f64,
    pub frequency: LoanFrequency,
    #[serde(default)]
    pub interest_method: InterestMethod,
    pub first_payment_date: NaiveDate,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payment_count: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amortization_end_date: Option<NaiveDate>,
}

impl LoanTerms {
    /// Stored terms, kept even while the loan is tracked manually.
    pub fn read(metadata: &Value) -> Option<Self> {
        let terms: Self =
            serde_json::from_value(decoded(metadata.get(LOAN_PROJECTION_KEY))?).ok()?;
        terms.valid().then_some(terms)
    }

    /// Terms that drive calculation; a loan switched to manual has none.
    pub fn active(metadata: &Value) -> Option<Self> {
        if metadata.get(TRACKING_MODE_KEY).and_then(Value::as_str) == Some("manual") {
            return None;
        }
        Self::read(metadata)
    }

    pub fn valid(&self) -> bool {
        self.version == 1
            && valid_amount(self.annual_rate)
            && self.annual_rate <= 100.0
            && valid_amount(self.payment_amount)
            && money(self.payment_amount) > 0.0
            && self
                .payment_count
                .is_none_or(|n| n > 0 && n <= MAX_PAYMENTS)
    }
}

/// A dated change to the loan. Unknown fields are ignored when reading.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LoanEvent {
    #[serde(rename_all = "camelCase")]
    ExtraRepayment {
        effective_date: NaiveDate,
        amount: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    RateChange {
        effective_date: NaiveDate,
        annual_rate: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    PaymentChange {
        effective_date: NaiveDate,
        payment_amount: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    PaymentFrequencyChange {
        effective_date: NaiveDate,
        frequency: LoanFrequency,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Renewal {
        effective_date: NaiveDate,
        annual_rate: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payment_amount: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        frequency: Option<LoanFrequency>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        interest_method: Option<InterestMethod>,
        /// End of the renewed term. A malformed date never invalidates the renewal.
        #[serde(
            default,
            deserialize_with = "lenient_date",
            skip_serializing_if = "Option::is_none"
        )]
        term_end_date: Option<NaiveDate>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
}

impl LoanEvent {
    pub fn date(&self) -> NaiveDate {
        match self {
            Self::ExtraRepayment { effective_date, .. }
            | Self::RateChange { effective_date, .. }
            | Self::PaymentChange { effective_date, .. }
            | Self::PaymentFrequencyChange { effective_date, .. }
            | Self::Renewal { effective_date, .. } => *effective_date,
        }
    }

    pub fn valid(&self) -> bool {
        match self {
            Self::ExtraRepayment { amount, .. } => valid_amount(*amount) && money(*amount) > 0.0,
            Self::RateChange { annual_rate, .. } => {
                valid_amount(*annual_rate) && *annual_rate <= 100.0
            }
            Self::PaymentChange { payment_amount, .. } => {
                valid_amount(*payment_amount) && money(*payment_amount) > 0.0
            }
            Self::Renewal {
                annual_rate,
                payment_amount,
                ..
            } => {
                valid_amount(*annual_rate)
                    && *annual_rate <= 100.0
                    && payment_amount.is_none_or(|p| valid_amount(p) && money(p) > 0.0)
            }
            Self::PaymentFrequencyChange { .. } => true,
        }
    }

    /// Whether the event replaces the regular payment amount.
    pub fn sets_payment(&self) -> bool {
        matches!(
            self,
            Self::PaymentChange { .. }
                | Self::Renewal {
                    payment_amount: Some(_),
                    ..
                }
        )
    }

    /// A stored entry this version understands and accepts.
    pub fn parse(value: &Value) -> Option<Self> {
        serde_json::from_value::<Self>(value.clone())
            .ok()
            .filter(Self::valid)
    }
}

fn lenient_date<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<NaiveDate>, D::Error> {
    Ok(Option::<Value>::deserialize(deserializer)?
        .and_then(|value| value.as_str().and_then(|text| text.parse().ok())))
}

/// Metadata values arrive either structured or as JSON text.
pub(crate) fn decoded(value: Option<&Value>) -> Option<Value> {
    value.and_then(|v| match v {
        Value::String(s) => serde_json::from_str(s).ok(),
        _ => Some(v.clone()),
    })
}

/// Every stored event entry in order, including entries this version cannot read.
pub fn event_entries(metadata: &Value) -> Vec<Value> {
    decoded(metadata.get(LOAN_EVENTS_KEY))
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
}

pub const LOAN_CLOSED_NOTE: &str = "loan_closed";
const NOTE_MARKER: &str = "|note=";

/// How a recorded balance was entered. Every recorded balance is a confirmation;
/// provenance in the quote's notes only says how it got there.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LoanBalanceKind {
    ConfirmedBalance,
    BalanceCorrection,
    ExtraRepayment,
    Closed,
}

fn has_provenance(notes: Option<&str>, provenance: &str) -> bool {
    notes.is_some_and(|notes| {
        notes
            .strip_prefix(provenance)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('|'))
    })
}

impl LoanBalanceKind {
    pub fn of(close: f64, notes: Option<&str>) -> Self {
        if has_provenance(notes, "loan_event|type=balance_correction") {
            Self::BalanceCorrection
        } else if has_provenance(notes, "loan_event|type=extra_repayment") {
            Self::ExtraRepayment
        } else if close == 0.0 && has_provenance(notes, LOAN_CLOSED_NOTE) {
            Self::Closed
        } else {
            Self::ConfirmedBalance
        }
    }

    fn provenance(self) -> Option<&'static str> {
        match self {
            Self::ConfirmedBalance => None,
            Self::BalanceCorrection => Some("loan_event|type=balance_correction"),
            Self::ExtraRepayment => Some("loan_event|type=extra_repayment"),
            Self::Closed => Some(LOAN_CLOSED_NOTE),
        }
    }
}

/// The user's own note on a recorded balance, without provenance.
pub fn balance_user_note(notes: Option<&str>) -> String {
    let Some(notes) = notes else {
        return String::new();
    };
    if !has_provenance(Some(notes), LOAN_CLOSED_NOTE) && !notes.starts_with("loan_event|") {
        return notes.to_string();
    }
    notes
        .find(NOTE_MARKER)
        .map(|start| {
            let encoded = &notes[start + NOTE_MARKER.len()..];
            urlencoding::decode(encoded)
                .map_or_else(|_| encoded.to_string(), |text| text.into_owned())
        })
        .unwrap_or_default()
}

fn with_note(provenance: Option<&str>, note: &str) -> Option<String> {
    match provenance {
        Some(provenance) if note.is_empty() => Some(provenance.to_string()),
        Some(provenance) => Some(format!(
            "{provenance}{NOTE_MARKER}{}",
            urlencoding::encode(note)
        )),
        None => (!note.is_empty()).then(|| note.to_string()),
    }
}

/// Notes for a new recorded balance of this kind with the user's note.
pub fn balance_notes(kind: LoanBalanceKind, note: &str) -> Option<String> {
    with_note(kind.provenance(), note)
}

/// Notes after editing a recorded balance: a closure reopened by a non-zero
/// balance becomes a correction; any other provenance is kept.
pub fn edited_balance_notes(original: Option<&str>, balance: f64, note: &str) -> Option<String> {
    let closed = has_provenance(original, LOAN_CLOSED_NOTE);
    let provenance = if closed && balance == 0.0 {
        Some(LOAN_CLOSED_NOTE)
    } else if closed {
        LoanBalanceKind::BalanceCorrection.provenance()
    } else {
        original
            .filter(|notes| notes.starts_with("loan_event|"))
            .map(|notes| notes.split(NOTE_MARKER).next().unwrap_or(notes))
    };
    with_note(provenance, note)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn date(s: &str) -> NaiveDate {
        s.parse().unwrap()
    }

    #[test]
    fn events_serialize_in_the_stored_shape() {
        let renewal = LoanEvent::Renewal {
            effective_date: date("2027-07-01"),
            annual_rate: 4.25,
            payment_amount: None,
            frequency: Some(LoanFrequency::Monthly),
            interest_method: None,
            term_end_date: Some(date("2032-07-01")),
            note: None,
        };
        let stored = json!({"type":"renewal","effectiveDate":"2027-07-01","annualRate":4.25,"frequency":"monthly","termEndDate":"2032-07-01"});
        assert_eq!(serde_json::to_value(&renewal).unwrap(), stored);
        assert_eq!(LoanEvent::parse(&stored), Some(renewal));
    }

    #[test]
    fn a_malformed_term_end_keeps_the_renewal() {
        let stored = json!({"type":"renewal","effectiveDate":"2027-07-01","annualRate":4,"termEndDate":"soon"});
        assert!(matches!(
            LoanEvent::parse(&stored),
            Some(LoanEvent::Renewal {
                term_end_date: None,
                ..
            })
        ));
    }

    #[test]
    fn invalid_or_unknown_entries_are_not_events_but_stay_stored() {
        let metadata = json!({"loan_events": serde_json::to_string(&json!([
            {"type":"extra_repayment","effectiveDate":"2026-01-15","amount":0.001},
            {"type":"payment_holiday","effectiveDate":"2026-02-01"},
            {"type":"rate_change","effectiveDate":"2026-03-01","annualRate":4,"note":"Letter"}
        ])).unwrap()});
        let entries = event_entries(&metadata);
        assert_eq!(entries.len(), 3);
        let events: Vec<_> = entries.iter().filter_map(LoanEvent::parse).collect();
        assert_eq!(
            events,
            vec![LoanEvent::RateChange {
                effective_date: date("2026-03-01"),
                annual_rate: 4.0,
                note: Some("Letter".into()),
            }]
        );
    }

    #[test]
    fn manual_tracking_keeps_terms_but_deactivates_them() {
        let terms = json!({"version":1,"annualRate":3,"paymentAmount":100,"frequency":"monthly","firstPaymentDate":"2026-02-01"});
        let metadata = json!({"loan_projection": terms.clone(), "tracking_mode": "manual"});
        assert!(LoanTerms::active(&metadata).is_none());
        assert!(LoanTerms::read(&metadata).is_some());
        assert!(LoanTerms::active(&json!({ "loan_projection": terms })).is_some());
    }

    #[test]
    fn balance_provenance_and_notes_round_trip() {
        assert_eq!(
            LoanBalanceKind::of(100.0, None),
            LoanBalanceKind::ConfirmedBalance
        );
        assert_eq!(
            LoanBalanceKind::of(100.0, Some("Statement")),
            LoanBalanceKind::ConfirmedBalance
        );
        let correction = balance_notes(LoanBalanceKind::BalanceCorrection, "Bank | 50% off");
        assert_eq!(
            LoanBalanceKind::of(100.0, correction.as_deref()),
            LoanBalanceKind::BalanceCorrection
        );
        assert_eq!(balance_user_note(correction.as_deref()), "Bank | 50% off");
        assert_eq!(
            LoanBalanceKind::of(0.0, Some("loan_closed")),
            LoanBalanceKind::Closed
        );
        // Notes written by the previous frontend decode the same way.
        assert_eq!(
            balance_user_note(Some(
                "loan_event|type=extra_repayment|note=Bonus%20%26%20gift"
            )),
            "Bonus & gift"
        );
        assert_eq!(balance_notes(LoanBalanceKind::ConfirmedBalance, ""), None);
    }

    #[test]
    fn editing_a_closure_to_a_balance_makes_it_a_correction() {
        assert_eq!(
            edited_balance_notes(Some("loan_closed"), 0.0, "").as_deref(),
            Some("loan_closed")
        );
        assert_eq!(
            edited_balance_notes(Some("loan_closed"), 10.0, "").as_deref(),
            Some("loan_event|type=balance_correction")
        );
        assert_eq!(
            edited_balance_notes(
                Some("loan_event|type=extra_repayment|note=Old"),
                10.0,
                "New"
            )
            .as_deref(),
            Some("loan_event|type=extra_repayment|note=New")
        );
        assert_eq!(
            edited_balance_notes(Some("Statement"), 10.0, "").as_deref(),
            None
        );
        assert_eq!(
            edited_balance_notes(None, 10.0, "Mine").as_deref(),
            Some("Mine")
        );
    }
}
