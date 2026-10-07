//! What the user enters for a loan. One function checks it and derives the
//! stored fields, so a preview and a save follow the same rules.
use chrono::{Datelike, NaiveDate};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::actions::{set_or_remove, LoanError};
use super::model::{
    ESCROW_AMOUNT_KEY, INTEREST_RATE_KEY, ORIGINAL_AMOUNT_KEY, ORIGINATION_DATE_KEY,
    PAYMENT_ACCOUNT_KEY,
};
use super::{
    amortization_horizon, money, payment_amount, payment_date, recalculate_loan, valid_amount,
    InterestMethod, LoanCalculationRequest, LoanFrequency, LoanRecalculationRequest, LoanTerms,
    LOAN_EVENTS_KEY, LOAN_PROJECTION_KEY, MAX_PAYMENTS, RENEWAL_MATURITY_KEY, TRACKING_MODE_KEY,
};

/// Fields that only a loan setup and loan actions write.
pub const LOAN_FIELDS: [&str; 9] = [
    LOAN_PROJECTION_KEY,
    LOAN_EVENTS_KEY,
    RENEWAL_MATURITY_KEY,
    TRACKING_MODE_KEY,
    PAYMENT_ACCOUNT_KEY,
    ESCROW_AMOUNT_KEY,
    ORIGINAL_AMOUNT_KEY,
    ORIGINATION_DATE_KEY,
    INTEREST_RATE_KEY,
];

/// The loan section of a liability as the user entered it.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoanSetup {
    #[serde(default)]
    pub original_amount: Option<f64>,
    #[serde(default)]
    pub origination_date: Option<NaiveDate>,
    #[serde(default)]
    pub interest_rate: Option<f64>,
    /// Omitted: tracked manually from recorded balances; a stored schedule is kept.
    #[serde(default)]
    pub schedule: Option<LoanSchedule>,
}

/// The payment schedule of a calculated loan.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoanSchedule {
    pub frequency: LoanFrequency,
    #[serde(default)]
    pub interest_method: InterestMethod,
    /// Omitted: one period after origination.
    #[serde(default)]
    pub first_payment_date: Option<NaiveDate>,
    /// Amortization in months, or a last payment date off the payment calendar.
    #[serde(default)]
    pub amortization_months: Option<u32>,
    #[serde(default)]
    pub last_payment_date: Option<NaiveDate>,
    /// Omitted: solved as at creation.
    #[serde(default)]
    pub payment_amount: Option<f64>,
    #[serde(default)]
    pub renewal_maturity: Option<NaiveDate>,
    #[serde(default)]
    pub payment_account_id: Option<String>,
    #[serde(default)]
    pub escrow_amount: Option<f64>,
}

/// What a schedule works out to, shown before saving.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoanSchedulePreview {
    pub first_payment_date: NaiveDate,
    pub last_payment_date: NaiveDate,
    pub payment_count: usize,
    pub payment_amount: f64,
}

/// The schedule a setup describes, or none for a manual loan. `stored` is the
/// loan's current metadata: its last payment is kept while the months match.
pub fn preview_loan_terms(
    setup: &LoanSetup,
    stored: &Value,
) -> Result<Option<LoanSchedulePreview>, LoanError> {
    check_amounts(setup)?;
    derive(setup, stored)
}

/// `stored` with the setup's loan fields applied. Refused setups change nothing.
pub fn apply_loan_setup(stored: &Value, setup: &LoanSetup) -> Result<Value, LoanError> {
    check_amounts(setup)?;
    let preview = derive(setup, stored)?;
    let mut next = if stored.is_object() {
        stored.clone()
    } else {
        json!({})
    };
    set_or_remove(
        &mut next,
        ORIGINAL_AMOUNT_KEY,
        setup.original_amount.map(|a| text(money(a))),
    );
    set_or_remove(
        &mut next,
        ORIGINATION_DATE_KEY,
        setup.origination_date.map(|d| Value::String(d.to_string())),
    );
    set_or_remove(&mut next, INTEREST_RATE_KEY, setup.interest_rate.map(text));
    let (Some(schedule), Some(preview)) = (&setup.schedule, preview) else {
        next[TRACKING_MODE_KEY] = Value::String("manual".into());
        return Ok(next);
    };
    set_or_remove(&mut next, TRACKING_MODE_KEY, None);
    // Stored as JSON text, as the metadata API has always written it.
    next[LOAN_PROJECTION_KEY] = Value::String(
        json!({
            "version": 1,
            "annualRate": setup.interest_rate.unwrap_or(0.0),
            "paymentAmount": preview.payment_amount,
            "frequency": schedule.frequency,
            "interestMethod": schedule.interest_method,
            "firstPaymentDate": preview.first_payment_date,
            "amortizationEndDate": preview.last_payment_date,
        })
        .to_string(),
    );
    set_or_remove(
        &mut next,
        RENEWAL_MATURITY_KEY,
        schedule
            .renewal_maturity
            .map(|d| Value::String(d.to_string())),
    );
    set_or_remove(
        &mut next,
        PAYMENT_ACCOUNT_KEY,
        schedule.payment_account_id.clone().map(Value::String),
    );
    set_or_remove(
        &mut next,
        ESCROW_AMOUNT_KEY,
        schedule
            .escrow_amount
            .filter(|escrow| money(*escrow) > 0.0)
            .map(|escrow| text(money(escrow))),
    );
    Ok(next)
}

fn text(n: f64) -> Value {
    Value::String(n.to_string())
}

/// Rule 1: entered amounts are checked for manual and calculated loans alike.
fn check_amounts(setup: &LoanSetup) -> Result<(), LoanError> {
    if setup
        .original_amount
        .is_some_and(|a| !valid_amount(a) || money(a) <= 0.0)
    {
        return Err(LoanError::AmountRequired);
    }
    if setup
        .interest_rate
        .is_some_and(|r| !r.is_finite() || !(0.0..=100.0).contains(&r))
    {
        return Err(LoanError::RateInvalid);
    }
    Ok(())
}

/// Rules 2 to 6 for a calculated loan.
fn derive(setup: &LoanSetup, stored: &Value) -> Result<Option<LoanSchedulePreview>, LoanError> {
    let Some(schedule) = &setup.schedule else {
        return Ok(None);
    };
    let principal = setup.original_amount.ok_or(LoanError::AmountRequired)?;
    let origination = setup
        .origination_date
        .ok_or(LoanError::OriginationRequired)?;
    let frequency = schedule.frequency;
    let first = match schedule.first_payment_date {
        Some(date) => date,
        None => payment_date(origination, 1, frequency).ok_or(LoanError::Invalid)?,
    };
    if first <= origination {
        return Err(LoanError::FirstPaymentBeforeOrigination);
    }
    let last = match (schedule.last_payment_date, schedule.amortization_months) {
        // Two ways of stating one end could disagree; neither is picked silently.
        (Some(_), Some(_)) => return Err(LoanError::Invalid),
        (Some(last), None) => last,
        (None, Some(months)) => {
            // Saving other details never moves an off-cadence contractual end.
            let stored_end = LoanTerms::read(stored)
                .and_then(|terms| amortization_horizon(&terms))
                .filter(|end| amortization_months(first, *end, frequency) == Some(months));
            match stored_end {
                Some(end) => end,
                None => {
                    let count =
                        payment_count(months, frequency).ok_or(LoanError::AmortizationInvalid)?;
                    payment_date(first, count - 1, frequency)
                        .ok_or(LoanError::AmortizationInvalid)?
                }
            }
        }
        (None, None) => return Err(LoanError::AmortizationInvalid),
    };
    let count = count_payments(first, last, frequency);
    // The engine walks at most MAX_PAYMENTS payments: an end past the last one it
    // reaches would save but never value.
    let limit = payment_date(first, MAX_PAYMENTS - 1, frequency);
    if count == 0 || count > MAX_PAYMENTS || limit.is_none_or(|limit| last > limit) {
        return Err(LoanError::AmortizationInvalid);
    }
    if schedule
        .renewal_maturity
        .is_some_and(|maturity| maturity <= origination)
    {
        return Err(LoanError::MaturityBeforeOrigination);
    }
    if schedule.escrow_amount.is_some_and(|e| !valid_amount(e)) {
        return Err(LoanError::Invalid);
    }
    let rate = setup.interest_rate.unwrap_or(0.0);
    let payment = match schedule.payment_amount {
        Some(payment) if valid_amount(payment) && money(payment) > 0.0 => money(payment),
        Some(_) => return Err(LoanError::PaymentAmountInvalid),
        None => solved_payment(principal, origination, rate, schedule, first, last, count)?,
    };
    Ok(Some(LoanSchedulePreview {
        first_payment_date: first,
        last_payment_date: last,
        payment_count: count,
        payment_amount: payment,
    }))
}

/// Rule 5: the smallest cent payment that settles the dated schedule by its last
/// payment. An accelerated payment stays at least half the monthly level payment.
fn solved_payment(
    principal: f64,
    origination: NaiveDate,
    rate: f64,
    schedule: &LoanSchedule,
    first: NaiveDate,
    last: NaiveDate,
    count: usize,
) -> Result<f64, LoanError> {
    let level = payment_amount(
        principal,
        rate,
        count,
        schedule.frequency,
        schedule.interest_method,
    )
    .map(money)
    .ok_or(LoanError::PaymentUnavailable)?;
    let metadata = json!({
        ORIGINAL_AMOUNT_KEY: principal.to_string(),
        ORIGINATION_DATE_KEY: origination.to_string(),
        LOAN_PROJECTION_KEY: {
            "version": 1,
            "annualRate": rate,
            "paymentAmount": level,
            "frequency": schedule.frequency,
            "interestMethod": schedule.interest_method,
            "firstPaymentDate": first,
            "amortizationEndDate": last,
        },
    });
    let solved = recalculate_loan(&LoanRecalculationRequest {
        loan: LoanCalculationRequest {
            metadata,
            balances: Vec::new(),
            as_of: origination,
            payments: Vec::new(),
        },
        annual_rate: rate,
    })
    .ok_or(LoanError::PaymentUnavailable)?;
    Ok(
        if schedule.frequency == LoanFrequency::AcceleratedBiweekly {
            solved.payment_amount.max(level)
        } else {
            solved.payment_amount
        },
    )
}

/// Whole payments in an amortization given in months.
fn payment_count(months: u32, frequency: LoanFrequency) -> Option<usize> {
    let count = (f64::from(months) / 12.0 * frequency.periods()).round() as usize;
    (1..=MAX_PAYMENTS).contains(&count).then_some(count)
}

/// Contractual payments due from the first payment through a date, inclusive.
fn count_payments(first: NaiveDate, through: NaiveDate, frequency: LoanFrequency) -> usize {
    if through < first {
        return 0;
    }
    if frequency != LoanFrequency::Monthly {
        return usize::try_from((through - first).num_days() / 14).unwrap_or(0) + 1;
    }
    let months = (month_index(through) - month_index(first)).max(0);
    let count = usize::try_from(months).unwrap_or(0) + 1;
    match payment_date(first, count - 1, frequency) {
        Some(last) if last > through => count - 1,
        _ => count,
    }
}

/// Whole months of amortization between the first and last payments.
fn amortization_months(first: NaiveDate, last: NaiveDate, frequency: LoanFrequency) -> Option<u32> {
    let count = count_payments(first, last, frequency);
    (count > 0).then(|| (count as f64 * 12.0 / frequency.periods()).round() as u32)
}

fn month_index(date: NaiveDate) -> i64 {
    i64::from(date.year()) * 12 + i64::from(date.month0())
}

#[cfg(test)]
#[path = "setup_tests.rs"]
mod tests;
