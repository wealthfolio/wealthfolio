//! Payments from an account: tagged withdrawals matched to instalments and
//! split into the scheduled payment and extra principal (docs/architecture/loans.md,
//! "Payments from an account").
use chrono::{DateTime, NaiveDate, Utc};
use chrono_tz::Tz;
use rust_decimal::prelude::ToPrimitive;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{money, LoanCalculation};
use crate::accounts::account_types;
use crate::activities::{Activity, ACTIVITY_TYPE_WITHDRAWAL};
use crate::utils::time_utils::activity_date_in_tz;

/// Activity metadata key holding a withdrawal's loan payment tag.
pub const LOAN_PAYMENT_TAG_KEY: &str = "loan_payment";

/// What a payment's tag says it is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(try_from = "String", into = "String")]
pub enum PaymentTarget {
    /// The instalment due on this date.
    Instalment(NaiveDate),
    /// Extra principal, whatever the date.
    Extra,
}

impl TryFrom<String> for PaymentTarget {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value == "extra" {
            return Ok(Self::Extra);
        }
        value
            .parse()
            .map(Self::Instalment)
            .map_err(|_| format!("unknown payment target: {value}"))
    }
}

impl From<PaymentTarget> for String {
    fn from(target: PaymentTarget) -> Self {
        match target {
            PaymentTarget::Extra => "extra".to_string(),
            PaymentTarget::Instalment(date) => date.to_string(),
        }
    }
}

/// The tag stored in a withdrawal's metadata under [`LOAN_PAYMENT_TAG_KEY`].
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct LoanPaymentTag {
    pub loan_id: String,
    /// Escrow included in this payment.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub escrow: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applies_to: Option<PaymentTarget>,
}

fn is_zero(value: &f64) -> bool {
    *value == 0.0
}

impl LoanPaymentTag {
    pub fn read(metadata: Option<&Value>) -> Option<Self> {
        serde_json::from_value(metadata?.get(LOAN_PAYMENT_TAG_KEY)?.clone()).ok()
    }
}

/// A tagged withdrawal, as the engine counts it.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoanPayment {
    pub activity_id: String,
    /// The account it was paid from; for display only.
    #[serde(default)]
    pub account_id: String,
    pub date: NaiveDate,
    /// Total withdrawn, escrow included.
    pub amount: f64,
    #[serde(default)]
    pub escrow: f64,
    #[serde(default)]
    pub applies_to: Option<PaymentTarget>,
}

/// Rule 2: the amount of a posted withdrawal, after any type override, in a
/// cash account in the loan's currency; anything else cannot be a payment.
pub(super) fn payment_amount_of(
    activity: &Activity,
    account_type: &str,
    loan_currency: &str,
) -> Option<f64> {
    let amount = activity.amount?.abs().to_f64()?;
    (activity.is_posted()
        && activity.effective_type() == ACTIVITY_TYPE_WITHDRAWAL
        && account_type == account_types::CASH
        && activity.currency == loan_currency
        && amount > 0.0)
        .then_some(amount)
}

/// Rule 5: the day Wealthfolio shows for the withdrawal, in the settings time zone.
pub(super) fn payment_date(activity: &Activity, timezone: Tz) -> NaiveDate {
    activity_date_in_tz(activity.activity_date, timezone)
}

/// A tagged withdrawal that still qualifies, as stored: it keeps the
/// withdrawal's instant, and `dated` gives the payment the engine counts.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredPayment {
    pub activity_id: String,
    pub account_id: String,
    pub paid_at: DateTime<Utc>,
    /// Total withdrawn, escrow included.
    pub amount: f64,
    pub escrow: f64,
    pub applies_to: Option<PaymentTarget>,
}

impl StoredPayment {
    /// A tagged withdrawal that still qualifies, with the id of the loan it pays.
    pub fn from_activity(
        activity: &Activity,
        account_type: &str,
        loan_currency: &str,
    ) -> Option<(String, Self)> {
        let tag = LoanPaymentTag::read(activity.metadata.as_ref())?;
        let amount = payment_amount_of(activity, account_type, loan_currency)?;
        tag.escrow.is_finite().then(|| {
            let payment = Self {
                activity_id: activity.id.clone(),
                account_id: activity.account_id.clone(),
                paid_at: activity.activity_date,
                amount,
                escrow: tag.escrow,
                applies_to: tag.applies_to,
            };
            (tag.loan_id, payment)
        })
    }

    /// Rule 5: the payment on the day Wealthfolio shows for it in `timezone`.
    pub fn dated(&self, timezone: Tz) -> LoanPayment {
        LoanPayment {
            activity_id: self.activity_id.clone(),
            account_id: self.account_id.clone(),
            date: activity_date_in_tz(self.paid_at, timezone),
            amount: self.amount,
            escrow: self.escrow,
            applies_to: self.applies_to,
        }
    }
}

/// How one payment was applied.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentAllocation {
    pub activity_id: String,
    pub account_id: String,
    pub date: NaiveDate,
    /// The instalment it settled, if any.
    pub instalment: Option<NaiveDate>,
    pub escrow: f64,
    /// Applied to the instalment's scheduled payment.
    pub applied: f64,
    /// Extra principal on the payment date.
    pub extra: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstalmentStatus {
    Paid,
    /// Not fully paid yet, still within its matching window.
    Due,
    Short,
    Missing,
}

/// A due instalment and what the counted payments covered of it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoanInstalment {
    pub due_date: NaiveDate,
    pub scheduled: f64,
    pub paid: f64,
    pub status: InstalmentStatus,
}

/// A dated payment change that would match how the loan is actually paid.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentChangeSuggestion {
    pub effective_date: NaiveDate,
    pub payment_amount: f64,
}

/// Matching windows by cadence: wide enough for early or late payments, narrow
/// enough that neighbouring instalments never overlap.
const MONTHLY_WINDOW_DAYS: i64 = 10;
const BIWEEKLY_WINDOW_DAYS: i64 = 6;
/// Payments that repeat the same difference this many times suggest a payment change.
const SUGGESTION_RUN: usize = 3;
const SUGGESTION_MIN_DIFFERENCE: f64 = 1.0;
const CENT: f64 = 0.005;

struct Instalment {
    date: NaiveDate,
    scheduled: f64,
    /// The scheduled payment without extra repayments recorded that day, which
    /// their own events already count.
    regular: f64,
    window: i64,
    remaining: f64,
}

/// Rule 15 leaves regular payments alone: one directed to an instalment, or one
/// matched to the instalment due on its own date. That instalment covers any
/// extra repayment recorded on the date (rule 8), so the money counts once.
pub(super) fn is_regular_payment(payment: &LoanPayment, allocations: &[PaymentAllocation]) -> bool {
    matches!(payment.applies_to, Some(PaymentTarget::Instalment(_)))
        || allocations
            .iter()
            .any(|a| a.activity_id == payment.activity_id && a.instalment == Some(payment.date))
}

/// The allocation of every payment against a schedule.
pub(super) struct PaymentPlan {
    pub allocations: Vec<PaymentAllocation>,
    instalments: Vec<Instalment>,
}

impl PaymentPlan {
    /// Extra principal to apply, by date.
    pub fn extras(&self) -> impl Iterator<Item = (NaiveDate, f64)> + '_ {
        self.allocations
            .iter()
            .filter(|a| a.extra > CENT)
            .map(|a| (a.date, a.extra))
    }
}

fn instalments(schedule: &LoanCalculation) -> Vec<Instalment> {
    let dates: Vec<_> = schedule
        .rows
        .iter()
        .filter(|row| row.scheduled_payment)
        // An extra repayment recorded on a due date is part of what that day's
        // payment covers, so a withdrawal paying both counts it once.
        .map(|row| {
            (
                row.date,
                row.payment,
                money(row.payment - row.extra_payment),
            )
        })
        .collect();
    dates
        .iter()
        .enumerate()
        .map(|(i, &(date, scheduled, regular))| {
            let gap = [i.checked_sub(1), Some(i + 1)]
                .into_iter()
                .flatten()
                .filter_map(|j| dates.get(j))
                .map(|(other, ..)| (date - *other).num_days().abs())
                .min();
            let window = match gap {
                Some(days) if days < 20 => BIWEEKLY_WINDOW_DAYS,
                _ => MONTHLY_WINDOW_DAYS,
            };
            Instalment {
                date,
                scheduled,
                regular,
                window,
                remaining: scheduled,
            }
        })
        .collect()
}

/// Rules 6 to 8: escrow first, then the matched instalment, then extra principal.
pub(super) fn allocate(schedule: &LoanCalculation, payments: &[LoanPayment]) -> PaymentPlan {
    let mut instalments = instalments(schedule);
    let mut ordered: Vec<&LoanPayment> = payments.iter().collect();
    ordered.sort_by(|a, b| (a.date, &a.activity_id).cmp(&(b.date, &b.activity_id)));
    let allocations = ordered
        .into_iter()
        .map(|payment| {
            let escrow = money(payment.escrow.clamp(0.0, payment.amount.max(0.0)));
            let net = money(payment.amount.max(0.0) - escrow);
            let unpaid = |i: &Instalment| i.remaining > CENT;
            let target = match payment.applies_to {
                Some(PaymentTarget::Extra) => None,
                Some(PaymentTarget::Instalment(due)) => instalments
                    .iter()
                    .position(|i| i.date == due)
                    .or_else(|| nearest(&instalments, payment.date, unpaid)),
                None => nearest(&instalments, payment.date, unpaid),
            };
            let applied = target.map_or(0.0, |i| money(net.min(instalments[i].remaining)));
            if let Some(i) = target {
                instalments[i].remaining = money(instalments[i].remaining - applied);
            }
            PaymentAllocation {
                activity_id: payment.activity_id.clone(),
                account_id: payment.account_id.clone(),
                date: payment.date,
                instalment: target.map(|i| instalments[i].date),
                escrow,
                applied,
                extra: money(net - applied),
            }
        })
        .collect();
    PaymentPlan {
        allocations,
        instalments,
    }
}

/// The nearest instalment within its window, the earlier one on a tie.
fn nearest(
    instalments: &[Instalment],
    date: NaiveDate,
    eligible: impl Fn(&Instalment) -> bool,
) -> Option<usize> {
    instalments
        .iter()
        .enumerate()
        .filter(|(_, i)| eligible(i) && (i.date - date).num_days().abs() <= i.window)
        .min_by_key(|(_, i)| ((i.date - date).num_days().abs(), i.date))
        .map(|(index, _)| index)
}

/// Rule 9: due instalments from the first counted payment onward. Payments
/// before the calculation starts are not counted, and instalments the final
/// schedule no longer has, such as after an early payoff, are left out.
pub(super) fn instalment_statuses(
    plan: &PaymentPlan,
    result: &LoanCalculation,
    as_of: NaiveDate,
) -> Vec<LoanInstalment> {
    let Some(first) = plan
        .allocations
        .iter()
        .map(|a| a.date)
        .filter(|date| *date >= result.calculation_start_date)
        .min()
    else {
        return Vec::new();
    };
    plan.instalments
        .iter()
        .filter(|i| i.date <= as_of && (i.date - first).num_days() >= -i.window)
        .filter(|i| {
            result
                .rows
                .iter()
                .any(|row| row.date == i.date && row.scheduled_payment)
        })
        .map(|i| {
            let paid = money(i.scheduled - i.remaining);
            let overdue = (as_of - i.date).num_days() > i.window;
            // An extra recorded that day counts through its own event, so the
            // regular payment settles the instalment.
            let status = if paid >= i.regular - CENT {
                InstalmentStatus::Paid
            } else if !overdue {
                InstalmentStatus::Due
            } else if paid > CENT {
                InstalmentStatus::Short
            } else {
                InstalmentStatus::Missing
            };
            LoanInstalment {
                due_date: i.date,
                scheduled: i.scheduled,
                paid,
                status,
            }
        })
        .collect()
}

/// Rule 10: the last payments that settled an instalment, whether matched or
/// directed to it, each differ from their instalment by the same amount.
pub(super) fn payment_suggestion(plan: &PaymentPlan) -> Option<PaymentChangeSuggestion> {
    let matched: Vec<(NaiveDate, f64, f64)> = plan
        .allocations
        .iter()
        .filter_map(|a| {
            let due = a.instalment?;
            let i = plan.instalments.iter().find(|i| i.date == due)?;
            // An extra recorded that day may be paid with the instalment or apart
            // from it, so anything from the regular payment to both is on target.
            let paid = a.applied + a.extra;
            let expected = paid.max(i.regular).min(i.scheduled);
            Some((due, i.regular, money(paid - expected)))
        })
        .collect();
    let run = matched.get(matched.len().checked_sub(SUGGESTION_RUN)?..)?;
    let difference = run[0].2;
    (difference.abs() >= SUGGESTION_MIN_DIFFERENCE
        && run.iter().all(|(_, _, d)| (d - difference).abs() < CENT)
        && run.windows(2).all(|pair| pair[0].0 < pair[1].0))
    .then(|| PaymentChangeSuggestion {
        effective_date: run[0].0,
        payment_amount: money(run[SUGGESTION_RUN - 1].1 + difference),
    })
}

#[cfg(test)]
#[path = "payments_tests.rs"]
mod tests;
