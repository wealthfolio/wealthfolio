//! Linking a withdrawal to a loan as one of its payments.
use serde::Deserialize;
use serde_json::{Map, Value};

use chrono::NaiveDate;
use chrono_tz::Tz;

use super::actions::with_entries;
use super::model::escrow_amount;
use super::payments::{is_regular_payment, payment_amount_of, payment_date};
use super::{
    event_entries, money, valid_amount, LoanError, LoanEvent, LoanPayment, LoanPaymentTag,
    LoanRecord, LoanTerms, PaymentTarget, LOAN_PAYMENT_TAG_KEY,
};
use crate::activities::Activity;

/// What to do with a withdrawal's loan tag.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PaymentLink {
    #[serde(rename_all = "camelCase")]
    Link {
        loan_id: String,
        /// Escrow included in this payment; when omitted, the loan's usual escrow,
        /// or none for extra principal.
        #[serde(default)]
        escrow: Option<f64>,
        #[serde(default)]
        applies_to: Option<PaymentTarget>,
        /// The user confirmed this withdrawal is a recorded extra repayment: the
        /// event is removed and the withdrawal counts as that extra principal.
        #[serde(default)]
        replace_event: bool,
    },
    Unlink,
}

/// What a link writes, in one transaction.
#[derive(Debug, Clone, PartialEq)]
pub struct PaymentTagUpdate {
    /// The withdrawal's metadata after the change.
    pub activity: Option<Value>,
    /// The loan's metadata without the extra repayment the withdrawal replaces.
    pub loan: Option<Value>,
}

impl PaymentLink {
    /// The loan to read alongside the withdrawal.
    pub fn loan_id(&self) -> Option<&str> {
        match self {
            Self::Link { loan_id, .. } => Some(loan_id),
            Self::Unlink => None,
        }
    }
}

/// The writes for linking or unlinking a withdrawal. Linking checks the
/// withdrawal against the loan as stored, dating it in `timezone` as the loan's
/// payments are; other metadata keys are kept.
pub fn link_payment(
    activity: &Activity,
    account_type: &str,
    loan: Option<&LoanRecord>,
    link: &PaymentLink,
    timezone: Tz,
) -> Result<PaymentTagUpdate, LoanError> {
    let mut metadata = match &activity.metadata {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    let mut loan_metadata = None;
    match link {
        PaymentLink::Unlink => {
            return Ok(PaymentTagUpdate {
                activity: untagged(activity),
                loan: None,
            });
        }
        PaymentLink::Link {
            loan_id,
            escrow: link_escrow,
            applies_to,
            replace_event,
        } => {
            let loan = loan
                .filter(|loan| &loan.asset_id == loan_id)
                .filter(|loan| LoanTerms::active(&loan.metadata).is_some())
                .ok_or(LoanError::Invalid)?;
            let amount = payment_amount_of(activity, account_type, &loan.currency)
                .ok_or(LoanError::PaymentNotEligible)?;
            let fits = |escrow: f64| valid_amount(escrow) && escrow <= amount;
            if link_escrow.is_some_and(|escrow| !fits(escrow)) {
                return Err(LoanError::Invalid);
            }
            // Extra principal includes no escrow unless named, as when the loan
            // records an extra repayment itself.
            let mut escrow = link_escrow.unwrap_or_else(|| match applies_to {
                Some(PaymentTarget::Extra) => 0.0,
                _ => escrow_amount(&loan.metadata),
            });
            let payment = LoanPayment {
                activity_id: activity.id.clone(),
                account_id: activity.account_id.clone(),
                date: payment_date(activity, timezone),
                amount,
                escrow,
                applies_to: *applies_to,
            };
            // Rule 15: an extra repayment recorded that day for this amount is this money.
            let mut applies_to = *applies_to;
            if let Some(index) = recorded_extra(&loan.metadata, payment.date, amount)
                .filter(|_| !regular_payment(loan, &payment))
            {
                if !replace_event {
                    return Err(LoanError::PaymentDuplicatesEvent);
                }
                let mut entries = event_entries(&loan.metadata);
                entries.remove(index);
                loan_metadata = Some(with_entries(&loan.metadata, entries));
                applies_to = Some(PaymentTarget::Extra);
                // All of it is that extra principal, unless the user named escrow.
                escrow = link_escrow.unwrap_or(0.0);
            }
            // The usual escrow is checked once it applies, so a replacement smaller
            // than it is still offered.
            if !fits(escrow) {
                return Err(LoanError::Invalid);
            }
            let tag = LoanPaymentTag {
                loan_id: loan_id.clone(),
                escrow: money(escrow),
                applies_to,
            };
            metadata.insert(
                LOAN_PAYMENT_TAG_KEY.to_string(),
                serde_json::to_value(tag).map_err(|_| LoanError::Invalid)?,
            );
        }
    }
    Ok(PaymentTagUpdate {
        activity: (!metadata.is_empty()).then_some(Value::Object(metadata)),
        loan: loan_metadata,
    })
}

/// The withdrawal's metadata without its loan tag; other keys are kept.
pub fn untagged(activity: &Activity) -> Option<Value> {
    let mut metadata = match &activity.metadata {
        Some(Value::Object(map)) => map.clone(),
        _ => return activity.metadata.clone(),
    };
    if metadata.remove(LOAN_PAYMENT_TAG_KEY).is_none() {
        return activity.metadata.clone();
    }
    (!metadata.is_empty()).then_some(Value::Object(metadata))
}

/// Whether the withdrawal is a regular payment once allocated with the loan's
/// other payments.
fn regular_payment(loan: &LoanRecord, payment: &LoanPayment) -> bool {
    let mut payments: Vec<_> = loan
        .payments
        .iter()
        .filter(|other| other.activity_id != payment.activity_id)
        .cloned()
        .collect();
    payments.push(payment.clone());
    let allocated = LoanRecord {
        payments,
        ..loan.clone()
    }
    .calculation(&loan.metadata, payment.date)
    .map(|c| c.allocations)
    .unwrap_or_default();
    is_regular_payment(payment, &allocated)
}

/// The stored entry of an extra repayment recorded on `date` for `amount`.
fn recorded_extra(metadata: &Value, date: NaiveDate, amount: f64) -> Option<usize> {
    event_entries(metadata).iter().position(|entry| {
        matches!(
            LoanEvent::parse(entry),
            Some(LoanEvent::ExtraRepayment { effective_date, amount: recorded, .. })
                if effective_date == date && money(recorded) == money(amount)
        )
    })
}

#[cfg(test)]
#[path = "linking_tests.rs"]
mod tests;
