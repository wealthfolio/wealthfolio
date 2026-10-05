//! What a liability shows on the Holdings page, taken from the calculation that
//! values it so a card needs no calculation of its own.
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::model::{INTEREST_RATE_KEY, ORIGINAL_AMOUNT_KEY, RENEWAL_MATURITY_KEY};
use super::{LoanCalculation, LoanFrequency, LoanTerms};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoanSummary {
    /// The balance follows a payment schedule rather than manual updates.
    pub scheduled: bool,
    /// The original principal, for the share repaid.
    pub original_amount: Option<f64>,
    /// Terms in effect on the valuation date.
    pub annual_rate: Option<f64>,
    pub payment_amount: Option<f64>,
    pub frequency: Option<LoanFrequency>,
    /// When principal and accrued interest are settled; none while a residual remains.
    pub payoff_date: Option<NaiveDate>,
    pub renewal_maturity: Option<NaiveDate>,
}

impl LoanSummary {
    /// `calculation` is the loan's valuation, when its terms support one.
    pub fn new(metadata: &Value, calculation: Option<&LoanCalculation>) -> Self {
        let terms = LoanTerms::active(metadata);
        let (annual_rate, payment_amount, frequency) = match (calculation, &terms) {
            (Some(c), _) => (
                Some(c.annual_rate),
                Some(c.payment_amount),
                Some(c.frequency),
            ),
            (None, Some(t)) => (
                Some(t.annual_rate),
                Some(t.payment_amount),
                Some(t.frequency),
            ),
            // A manual loan shows the rate it was entered with.
            (None, None) => (number(metadata, INTEREST_RATE_KEY), None, None),
        };
        Self {
            scheduled: terms.is_some(),
            // Liabilities from earlier releases stored the principal as purchase_price.
            original_amount: number(metadata, ORIGINAL_AMOUNT_KEY)
                .or_else(|| number(metadata, "purchase_price"))
                .filter(|amount| *amount > 0.0),
            annual_rate,
            payment_amount: payment_amount.filter(|payment| *payment > 0.0),
            frequency,
            payoff_date: calculation
                .filter(|c| c.residual_balance == 0.0 && c.residual_interest == 0.0)
                .and_then(|c| c.payoff_date),
            renewal_maturity: metadata
                .get(RENEWAL_MATURITY_KEY)
                .and_then(Value::as_str)
                .and_then(|date| date.parse().ok()),
        }
    }
}

/// A stored number, written as text by the metadata API or as a JSON number.
fn number(metadata: &Value, key: &str) -> Option<f64> {
    let value = metadata.get(key)?;
    value
        .as_f64()
        .or_else(|| value.as_str()?.trim().parse().ok())
        .filter(|n: &f64| n.is_finite())
}

#[cfg(test)]
#[path = "summary_tests.rs"]
mod tests;
