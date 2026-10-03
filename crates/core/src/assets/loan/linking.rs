//! Linking a withdrawal to a loan as one of its payments.
use serde::Deserialize;
use serde_json::{Map, Value};

use super::model::escrow_amount;
use super::payments::payment_amount_of;
use super::{
    money, valid_amount, LoanError, LoanPaymentTag, LoanRecord, LoanTerms, PaymentTarget,
    LOAN_PAYMENT_TAG_KEY,
};
use crate::activities::Activity;

/// What to do with a withdrawal's loan tag.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PaymentLink {
    #[serde(rename_all = "camelCase")]
    Link {
        loan_id: String,
        /// Escrow included in this payment; the loan's usual escrow when omitted.
        #[serde(default)]
        escrow: Option<f64>,
        #[serde(default)]
        applies_to: Option<PaymentTarget>,
    },
    Unlink,
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

/// The withdrawal's metadata after linking or unlinking it. Linking checks the
/// withdrawal against the loan as stored; other metadata keys are kept.
pub fn link_payment(
    activity: &Activity,
    account_type: &str,
    loan: Option<&LoanRecord>,
    link: &PaymentLink,
) -> Result<Option<Value>, LoanError> {
    let mut metadata = match &activity.metadata {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    match link {
        PaymentLink::Unlink => {
            if metadata.remove(LOAN_PAYMENT_TAG_KEY).is_none() {
                return Ok(activity.metadata.clone());
            }
        }
        PaymentLink::Link {
            loan_id,
            escrow,
            applies_to,
        } => {
            let loan = loan
                .filter(|loan| &loan.asset_id == loan_id)
                .filter(|loan| LoanTerms::active(&loan.metadata).is_some())
                .ok_or(LoanError::Invalid)?;
            let amount = payment_amount_of(activity, account_type, &loan.currency)
                .ok_or(LoanError::PaymentNotEligible)?;
            let escrow = escrow.unwrap_or_else(|| escrow_amount(&loan.metadata));
            if !valid_amount(escrow) || escrow > amount {
                return Err(LoanError::Invalid);
            }
            let tag = LoanPaymentTag {
                loan_id: loan_id.clone(),
                escrow: money(escrow),
                applies_to: *applies_to,
            };
            metadata.insert(
                LOAN_PAYMENT_TAG_KEY.to_string(),
                serde_json::to_value(tag).map_err(|_| LoanError::Invalid)?,
            );
        }
    }
    Ok((!metadata.is_empty()).then_some(Value::Object(metadata)))
}

#[cfg(test)]
#[path = "linking_tests.rs"]
mod tests;
