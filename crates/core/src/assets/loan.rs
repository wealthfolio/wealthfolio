//! Calendar-date loan valuation shared by holdings, net worth and both UI runtimes.
//! Quotes are closing observations: on the same day they override payments and events.
use chrono::{Days, Months, NaiveDate};
use rust_decimal::{
    prelude::{FromPrimitive, ToPrimitive},
    Decimal, RoundingStrategy,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::quotes::Quote;

mod interest;
mod recalculation;
pub use interest::{payment_amount, InterestMethod};
pub use recalculation::{recalculate_loan, LoanRecalculation, LoanRecalculationRequest};

pub const LOAN_PROJECTION_KEY: &str = "loan_projection";
pub const LOAN_EVENTS_KEY: &str = "loan_events";
const MAX_PAYMENTS: usize = 2600;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum LoanFrequency {
    #[default]
    Monthly,
    Biweekly,
    AcceleratedBiweekly,
}
impl LoanFrequency {
    fn periods(self) -> f64 {
        if self == Self::Monthly {
            12.0
        } else {
            26.0
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Terms {
    version: u8,
    annual_rate: f64,
    payment_amount: f64,
    frequency: LoanFrequency,
    #[serde(default)]
    interest_method: InterestMethod,
    first_payment_date: NaiveDate,
    payment_count: Option<usize>,
    amortization_end_date: Option<NaiveDate>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Event {
    #[serde(rename_all = "camelCase")]
    ExtraRepayment {
        effective_date: NaiveDate,
        amount: f64,
    },
    #[serde(rename_all = "camelCase")]
    RateChange {
        effective_date: NaiveDate,
        annual_rate: f64,
    },
    #[serde(rename_all = "camelCase")]
    PaymentChange {
        effective_date: NaiveDate,
        payment_amount: f64,
    },
    #[serde(rename_all = "camelCase")]
    PaymentFrequencyChange {
        effective_date: NaiveDate,
        frequency: LoanFrequency,
    },
    #[serde(rename_all = "camelCase")]
    Renewal {
        effective_date: NaiveDate,
        annual_rate: f64,
        payment_amount: Option<f64>,
        frequency: Option<LoanFrequency>,
        interest_method: Option<InterestMethod>,
    },
}
impl Event {
    fn date(&self) -> NaiveDate {
        match self {
            Self::ExtraRepayment { effective_date, .. }
            | Self::RateChange { effective_date, .. }
            | Self::PaymentChange { effective_date, .. }
            | Self::PaymentFrequencyChange { effective_date, .. }
            | Self::Renewal { effective_date, .. } => *effective_date,
        }
    }
    fn valid(&self) -> bool {
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
    fn sets_payment(&self) -> bool {
        matches!(
            self,
            Self::PaymentChange { .. }
                | Self::Renewal {
                    payment_amount: Some(_),
                    ..
                }
        )
    }
}
fn valid_amount(value: f64) -> bool {
    value.is_finite() && (0.0..=1e15).contains(&value)
}
fn decoded(value: Option<&Value>) -> Option<Value> {
    value.and_then(|v| match v {
        Value::String(s) => serde_json::from_str(s).ok(),
        _ => Some(v.clone()),
    })
}
fn terms(metadata: &Value) -> Option<Terms> {
    if metadata.get("tracking_mode").and_then(Value::as_str) == Some("manual") {
        return None;
    }
    let t: Terms = serde_json::from_value(decoded(metadata.get(LOAN_PROJECTION_KEY))?).ok()?;
    (t.version == 1
        && valid_amount(t.annual_rate)
        && t.annual_rate <= 100.0
        && valid_amount(t.payment_amount)
        && money(t.payment_amount) > 0.0
        && t.payment_count.is_none_or(|n| n > 0 && n <= MAX_PAYMENTS))
    .then_some(t)
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoanBalance {
    pub date: NaiveDate,
    pub balance: f64,
    pub notes: Option<String>,
}
impl From<&Quote> for LoanBalance {
    fn from(q: &Quote) -> Self {
        Self {
            date: q.timestamp.date_naive(),
            balance: q.close.abs().to_f64().unwrap_or_default(),
            notes: q.notes.clone(),
        }
    }
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoanCalculationRequest {
    pub metadata: Value,
    pub balances: Vec<LoanBalance>,
    pub as_of: NaiveDate,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoanRow {
    pub date: NaiveDate,
    pub opening_balance: f64,
    pub balance: f64,
    pub payment: f64,
    pub extra_payment: f64,
    pub scheduled_payment: bool,
    pub principal: f64,
    pub interest: f64,
    pub confirmed: bool,
    /// A closing observation's adjustment, never counted as a repayment.
    pub balance_adjustment: f64,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoanCalculation {
    pub current_balance: f64,
    pub annual_rate: f64,
    pub payment_amount: f64,
    pub frequency: LoanFrequency,
    pub interest_method: InterestMethod,
    /// Historical interest covers this date onward, not necessarily origination.
    pub calculation_start_date: NaiveDate,
    pub rows: Vec<LoanRow>,
    pub remaining_payments: usize,
    pub interest_to_date: f64,
    pub projected_interest: f64,
    pub residual_balance: f64,
    /// Accrued but unposted interest at the projection horizon; never principal.
    pub residual_interest: f64,
    pub payoff_date: Option<NaiveDate>,
}
fn money(n: f64) -> f64 {
    // Convert only at posting boundaries: binary multiplication by 100 can turn
    // a decimal midpoint such as 1.005 into 100.499999 and round the wrong way.
    // Preserve non-convertible values so boundary validation can reject them.
    Decimal::from_f64(n)
        .map(|value| value.round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero))
        .and_then(|value| value.to_f64())
        .unwrap_or(n)
}
/// Monthly payments keep the first payment's day, clamped to the end of shorter
/// months: the 31st falls on each month's last day, the 30th stays the 30th.
fn payment_date(anchor: NaiveDate, index: usize, frequency: LoanFrequency) -> Option<NaiveDate> {
    if frequency != LoanFrequency::Monthly {
        return anchor.checked_add_days(Days::new(index as u64 * 14));
    }
    anchor.checked_add_months(Months::new(index as u32))
}

fn previous_payment_date(date: NaiveDate, frequency: LoanFrequency) -> Option<NaiveDate> {
    if frequency != LoanFrequency::Monthly {
        return date.checked_sub_days(Days::new(14));
    }
    date.checked_sub_months(Months::new(1))
}

fn amortization_horizon(t: &Terms) -> Option<NaiveDate> {
    t.amortization_end_date.or_else(|| {
        payment_date(
            t.first_payment_date,
            t.payment_count?.checked_sub(1)?,
            t.frequency,
        )
    })
}

/// Returns None for manual/invalid loan terms; callers retain ordinary quote valuation.
/// Estimates are never written back as quotes. Dated terms apply before that day's payment;
/// balance events apply after it; a confirmed closing quote wins over both.
pub fn calculate_loan(request: &LoanCalculationRequest) -> Option<LoanCalculation> {
    if request.balances.len() > 10_000 {
        return None;
    }
    let mut t = terms(&request.metadata)?;
    // Observations past the longest schedule the engine can walk (a mistyped year)
    // are ignored rather than invalidating the whole calculation.
    let limit = t
        .first_payment_date
        .checked_add_days(Days::new((MAX_PAYMENTS as u64 - 1) * 14))?;
    let mut balances: Vec<_> = request
        .balances
        .iter()
        .filter(|b| valid_amount(b.balance) && b.date <= limit)
        .collect();
    balances.sort_by_key(|b| b.date);
    let origin = request
        .metadata
        .get("origination_date")
        .and_then(Value::as_str)
        .and_then(|s| s.parse::<NaiveDate>().ok());
    let original = request.metadata.get("original_amount").and_then(|v| {
        v.as_f64()
            .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
    });
    let initial_balance = match (origin, original) {
        (Some(date), Some(balance))
            if valid_amount(balance) && balances.first().is_none_or(|b| date < b.date) =>
        {
            Some(LoanBalance {
                date,
                balance,
                notes: None,
            })
        }
        _ => None,
    };
    if let Some(initial) = &initial_balance {
        balances.insert(0, initial);
    }
    let initial = balances.first()?;
    if initial.date > request.as_of {
        return None;
    }
    let horizon = amortization_horizon(&t)?;
    // A bounded engine must not silently return a partial schedule as complete.
    if horizon > payment_date(t.first_payment_date, MAX_PAYMENTS - 1, t.frequency)? {
        return None;
    }
    let mut events: Vec<Event> = decoded(request.metadata.get(LOAN_EVENTS_KEY))
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .filter(|event: &Event| event.valid() && event.date() <= limit)
        .collect();
    if events.len() > 10_000 {
        return None;
    }
    events.sort_by_key(Event::date);
    let mut balance = money(initial.balance);
    let mut current = balance;
    let mut rate_now = t.annual_rate;
    let mut payment_now = t.payment_amount;
    let mut frequency_now = t.frequency;
    let mut interest_method_now = t.interest_method;
    let mut rows = Vec::new();
    let mut event_index = 0;
    let mut balance_index = 1;
    let mut anchor = t.first_payment_date;
    let mut index = 0;
    // Consume initial-day balance events without replaying them, but retain term changes.
    let mut day = initial.date;
    let mut next_payment = payment_date(anchor, index, t.frequency)?;
    let mut period_start = previous_payment_date(next_payment, t.frequency)?;
    while next_payment <= initial.date {
        period_start = next_payment;
        index += 1;
        if index > MAX_PAYMENTS {
            return None;
        }
        next_payment = payment_date(anchor, index, t.frequency)?;
    }
    let mut previous_day = day;
    let mut accrued_interest = 0.0;
    let mut finished = false;
    let mut payoff_date = None;
    for _ in 0..(MAX_PAYMENTS + events.len() + balances.len()) {
        let opening = balance;
        // Closing events affect the next segment. Never apply a new rate or lower
        // principal retroactively to days before that event.
        let elapsed = (day.min(horizon) - previous_day.min(horizon)).num_days();
        let period_days = (next_payment - period_start).num_days();
        if elapsed > 0 && period_days > 0 {
            accrued_interest += balance
                * t.interest_method.periodic_rate(t.annual_rate, t.frequency)
                * elapsed as f64
                / period_days as f64;
        }
        previous_day = day;
        let mut frequency_reset = None;
        let start_event = event_index;
        while event_index < events.len() && events[event_index].date() <= day {
            match events[event_index] {
                Event::RateChange { annual_rate, .. } => t.annual_rate = annual_rate,
                Event::PaymentChange { payment_amount, .. } => t.payment_amount = payment_amount,
                Event::PaymentFrequencyChange {
                    frequency,
                    effective_date,
                } if frequency != t.frequency => {
                    frequency_reset = Some(effective_date);
                    t.frequency = frequency;
                }
                Event::Renewal {
                    annual_rate,
                    payment_amount,
                    frequency,
                    interest_method,
                    effective_date,
                    ..
                } => {
                    t.annual_rate = annual_rate;
                    if let Some(p) = payment_amount {
                        t.payment_amount = p;
                    }
                    if let Some(f) = frequency {
                        if f != t.frequency {
                            frequency_reset = Some(effective_date);
                            t.frequency = f;
                        }
                    }
                    if let Some(method) = interest_method {
                        t.interest_method = method;
                    }
                }
                _ => {}
            }
            event_index += 1;
        }
        let due = day == next_payment && day <= horizon;
        let interest = if due && (balance > 0.0 || accrued_interest > 0.0) {
            money(accrued_interest)
        } else {
            0.0
        };
        let mut payment = if due {
            money(t.payment_amount).min(balance + interest)
        } else {
            0.0
        };
        let scheduled_payment = due && payment > 0.0;
        if due {
            accrued_interest = 0.0;
        }
        let mut principal = payment - interest;
        let mut extra_payment = 0.0;
        balance = money((balance + interest - payment).max(0.0));
        let mut balance_adjustment = 0.0;
        for event in &events[start_event..event_index] {
            if event.date() < initial.date
                || (event.date() == initial.date && initial_balance.is_none())
            {
                continue;
            }
            if let Event::ExtraRepayment { amount, .. } = event {
                let extra = money(*amount).min(balance);
                balance = money(balance - extra);
                payment += extra;
                principal += extra;
                extra_payment += extra;
            }
        }
        let mut confirmed = day == initial.date && initial_balance.is_none();
        while balance_index < balances.len() && balances[balance_index].date <= day {
            balance_adjustment += money(balances[balance_index].balance) - balance;
            balance = money(balances[balance_index].balance);
            balance_index += 1;
            confirmed = true;
        }
        if confirmed && balance == 0.0 {
            accrued_interest = 0.0;
        }
        if !valid_amount(balance) || !valid_amount(accrued_interest) {
            return None;
        }
        if balance == 0.0 && money(accrued_interest) == 0.0 {
            payoff_date.get_or_insert(day);
        } else {
            payoff_date = None;
        }
        rows.push(LoanRow {
            date: day,
            opening_balance: money(opening),
            balance: money(balance),
            payment: money(payment),
            extra_payment: money(extra_payment),
            scheduled_payment,
            principal: money(principal),
            interest: money(interest),
            confirmed,
            balance_adjustment: money(balance_adjustment),
        });
        if day <= request.as_of {
            current = balance;
            rate_now = t.annual_rate;
            payment_now = t.payment_amount;
            frequency_now = t.frequency;
            interest_method_now = t.interest_method;
        }
        if due || frequency_reset.is_some() {
            period_start = day;
            if let Some(reset_date) = frequency_reset {
                anchor = reset_date;
                period_start = reset_date;
                index = 1;
            } else {
                index += 1;
            }
            next_payment = payment_date(anchor, index, t.frequency)?;
        }
        // Zero principal may skip months before a later correction reopens the loan.
        // Keep the original cadence; a past due date must never strand the schedule.
        while next_payment <= day {
            period_start = next_payment;
            index += 1;
            if index > MAX_PAYMENTS {
                return None;
            }
            next_payment = payment_date(anchor, index, t.frequency)?;
        }
        let next = [
            (next_payment <= horizon && (balance > 0.005 || accrued_interest > 0.005))
                .then_some(next_payment),
            events.get(event_index).map(Event::date),
            balances.get(balance_index).map(|b| b.date),
        ]
        .into_iter()
        .flatten()
        .filter(|d| *d > day)
        .min();
        match next {
            Some(d) => day = d,
            None => {
                finished = true;
                break;
            }
        }
    }
    if !finished {
        return None;
    }
    if day < horizon && balance > 0.0 {
        let elapsed = (horizon - day).num_days();
        let period_days = (next_payment - period_start).num_days();
        if period_days > 0 {
            accrued_interest += balance
                * t.interest_method.periodic_rate(t.annual_rate, t.frequency)
                * elapsed as f64
                / period_days as f64;
        }
    }
    let remaining_payments = rows
        .iter()
        .filter(|r| r.date > request.as_of && r.scheduled_payment)
        .count();
    let interest_to_date = money(
        rows.iter()
            .filter(|r| r.date <= request.as_of)
            .map(|r| r.interest)
            .sum(),
    );
    let projected_interest = money(
        rows.iter()
            .filter(|r| r.date > request.as_of)
            .map(|r| r.interest)
            .sum(),
    );
    Some(LoanCalculation {
        current_balance: money(current),
        annual_rate: rate_now,
        payment_amount: money(payment_now),
        frequency: frequency_now,
        interest_method: interest_method_now,
        calculation_start_date: initial.date,
        rows,
        remaining_payments,
        interest_to_date,
        projected_interest,
        residual_balance: money(balance),
        residual_interest: money(accrued_interest),
        payoff_date,
    })
}

pub fn loan_value(metadata: Option<&Value>, quotes: &[Quote], date: NaiveDate) -> Option<Decimal> {
    let metadata = metadata?;
    let result = calculate_loan(&LoanCalculationRequest {
        metadata: metadata.clone(),
        balances: quotes.iter().map(LoanBalance::from).collect(),
        as_of: date,
    })?;
    Decimal::from_f64_retain(result.current_balance).map(|v| v.round_dp(2))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn date(s: &str) -> NaiveDate {
        s.parse().unwrap()
    }
    fn request() -> LoanCalculationRequest {
        LoanCalculationRequest {
            metadata: json!({"loan_projection": {"version": 1,"annualRate":0,"paymentAmount":100,"frequency":"monthly","firstPaymentDate":"2026-02-01","amortizationEndDate":"2027-01-01"}}),
            balances: vec![LoanBalance {
                date: date("2026-01-01"),
                balance: 1200.0,
                notes: None,
            }],
            as_of: date("2026-04-15"),
        }
    }
    #[test]
    fn automatic_balances_and_remaining_payments() {
        let r = calculate_loan(&request()).unwrap();
        assert_eq!(r.current_balance, 900.0);
        assert_eq!(r.remaining_payments, 9);
        assert_eq!(r.residual_balance, 0.0);
    }
    #[test]
    fn confirmed_closing_balance_wins_on_payment_and_event_date() {
        let mut q = request();
        q.metadata[LOAN_EVENTS_KEY] =
            json!([{"type":"extra_repayment","effectiveDate":"2026-04-01","amount":200}]);
        q.balances.push(LoanBalance {
            date: date("2026-04-01"),
            balance: 750.0,
            notes: None,
        });
        let r = calculate_loan(&q).unwrap();
        assert_eq!(r.current_balance, 750.0);
        assert_eq!(
            r.rows
                .iter()
                .find(|r| r.date == date("2026-05-01"))
                .unwrap()
                .balance,
            650.0
        );
    }
    #[test]
    fn renewal_maturity_does_not_truncate_amortization() {
        let mut q = request();
        q.metadata[LOAN_EVENTS_KEY] = json!([{"type":"renewal","effectiveDate":"2026-04-01","annualRate":0,"paymentAmount":100,"termEndDate":"2026-06-01"}]);
        assert_eq!(
            calculate_loan(&q).unwrap().rows.last().unwrap().date,
            date("2027-01-01")
        );
    }
    #[test]
    fn monthly_anchor_survives_february() {
        assert_eq!(
            payment_date(date("2026-01-30"), 2, LoanFrequency::Monthly),
            Some(date("2026-03-30"))
        );
    }
    #[test]
    fn dated_recalculation_changes_only_subsequent_payments() {
        let mut q = request();
        q.metadata[LOAN_EVENTS_KEY] = json!([{"type":"rate_change","effectiveDate":"2026-04-01","annualRate":12},{"type":"payment_change","effectiveDate":"2026-04-01","paymentAmount":150}]);
        let r = calculate_loan(&q).unwrap();
        assert_eq!(r.rows[2].interest, 0.0);
        // The new rate starts on April 1; it cannot change March's interest.
        assert_eq!(r.current_balance, 850.0);
        assert_eq!(r.annual_rate, 12.0);
    }
    #[test]
    fn extra_repayment_uses_effective_date_estimate() {
        let mut q = request();
        q.metadata[LOAN_EVENTS_KEY] =
            json!([{"type":"extra_repayment","effectiveDate":"2026-04-10","amount":200}]);
        let result = calculate_loan(&q).unwrap();
        assert_eq!(result.current_balance, 700.0);
        assert!(
            !result
                .rows
                .iter()
                .find(|row| row.date == date("2026-04-10"))
                .unwrap()
                .scheduled_payment
        );
        assert!(
            result
                .rows
                .iter()
                .find(|row| row.date == date("2026-04-01"))
                .unwrap()
                .scheduled_payment
        );
    }
    #[test]
    fn original_terms_seed_history_before_a_confirmed_balance() {
        let mut q = request();
        q.metadata["original_amount"] = json!("1200");
        q.metadata["origination_date"] = json!("2026-01-01");
        q.balances = vec![LoanBalance {
            date: date("2026-03-01"),
            balance: 1050.0,
            notes: None,
        }];
        let result = calculate_loan(&q).unwrap();
        assert_eq!(result.rows[1].balance, 1100.0);
        assert_eq!(result.current_balance, 950.0);
    }
    #[test]
    fn biweekly_dates_cross_dst_as_calendar_dates() {
        let mut q = request();
        q.metadata[LOAN_PROJECTION_KEY]["frequency"] = json!("accelerated_biweekly");
        q.metadata[LOAN_PROJECTION_KEY]["firstPaymentDate"] = json!("2026-03-01");
        let r = calculate_loan(&q).unwrap();
        assert_eq!(r.rows[2].date, date("2026-03-15"));
        assert_eq!(r.rows[3].date, date("2026-03-29"));
    }
    #[test]
    fn closure_stops_future_payments() {
        let mut q = request();
        q.balances.push(LoanBalance {
            date: date("2026-03-15"),
            balance: 0.0,
            notes: Some("loan_closed".into()),
        });
        let r = calculate_loan(&q).unwrap();
        assert_eq!(r.current_balance, 0.0);
        assert_eq!(r.remaining_payments, 0);
    }
    #[test]
    fn manual_or_invalid_terms_do_not_generate_estimates() {
        let mut q = request();
        q.metadata["tracking_mode"] = json!("manual");
        assert!(calculate_loan(&q).is_none());
        q.metadata.as_object_mut().unwrap().remove("tracking_mode");
        q.metadata[LOAN_PROJECTION_KEY]["paymentAmount"] = json!(-1);
        assert!(calculate_loan(&q).is_none());
    }
    #[test]
    fn insufficient_payment_exposes_unpaid_principal() {
        let mut q = request();
        q.metadata[LOAN_PROJECTION_KEY]["paymentAmount"] = json!(1);
        q.metadata[LOAN_PROJECTION_KEY]["annualRate"] = json!(12);
        let r = calculate_loan(&q).unwrap();
        assert!(r.current_balance > 1200.0);
        assert!(r.residual_balance > 1200.0);
    }

    #[test]
    fn mid_period_changes_accrue_only_for_their_actual_segment() {
        let mut q = request();
        q.metadata[LOAN_PROJECTION_KEY]["annualRate"] = json!(12);
        q.metadata[LOAN_EVENTS_KEY] = json!([
            {"type":"extra_repayment","effectiveDate":"2026-01-16","amount":200},
            {"type":"rate_change","effectiveDate":"2026-01-21","annualRate":24}
        ]);
        let r = calculate_loan(&q).unwrap();
        let row = r
            .rows
            .iter()
            .find(|r| r.date == date("2026-02-01"))
            .unwrap();
        // Jan 1–16: 1,200 at 12%; Jan 16–21: 1,000 at 12%;
        // Jan 21–Feb 1: 1,000 at 24%, all within a 31-day payment period.
        assert_eq!(
            row.interest,
            money((1200.0 * 0.01 * 15.0 + 1000.0 * 0.01 * 5.0 + 1000.0 * 0.02 * 11.0) / 31.0)
        );
    }

    #[test]
    fn future_extra_repayment_is_not_a_remaining_instalment() {
        let mut q = request();
        q.metadata[LOAN_EVENTS_KEY] = json!([
            {"type":"extra_repayment","effectiveDate":"2026-04-20","amount":50}
        ]);
        let r = calculate_loan(&q).unwrap();
        assert_eq!(r.remaining_payments, 9);
    }

    #[test]
    fn synthetic_origination_is_not_a_confirmed_statement() {
        let mut q = request();
        q.metadata["original_amount"] = json!(1200);
        q.metadata["origination_date"] = json!("2026-01-01");
        q.balances.clear();
        let r = calculate_loan(&q).unwrap();
        assert!(!r.rows[0].confirmed);
    }

    #[test]
    fn confirmation_adjustment_does_not_inflate_repayments() {
        let mut q = request();
        q.balances.push(LoanBalance {
            date: date("2026-02-01"),
            balance: 1050.0,
            notes: None,
        });
        let r = calculate_loan(&q).unwrap();
        assert_eq!(r.rows[1].balance_adjustment, -50.0);
        assert_eq!(r.rows[1].principal, 100.0);
        assert_eq!(r.rows[1].payment, 100.0);
        assert_eq!(r.rows[2].opening_balance, 1050.0);
    }

    #[test]
    fn paying_principal_between_instalments_does_not_erase_accrued_interest() {
        let mut q = request();
        q.metadata[LOAN_PROJECTION_KEY]["annualRate"] = json!(12);
        q.metadata[LOAN_EVENTS_KEY] = json!([
            {"type":"extra_repayment","effectiveDate":"2026-01-16","amount":1200}
        ]);
        let r = calculate_loan(&q).unwrap();
        assert_eq!(r.rows[2].payment, money(12.0 * 15.0 / 31.0));
        assert_eq!(r.rows[2].principal, 0.0);
        assert_eq!(r.rows.len(), 3);
    }

    #[test]
    fn renewal_changes_compounding_only_after_its_effective_date() {
        let mut q = request();
        q.metadata[LOAN_PROJECTION_KEY]["annualRate"] = json!(12);
        q.metadata[LOAN_EVENTS_KEY] = json!([{
            "type":"renewal", "effectiveDate":"2026-02-01", "annualRate":12,
            "interestMethod":"semiannual"
        }]);
        let r = calculate_loan(&q).unwrap();
        assert_eq!(r.rows[1].interest, 12.0);
        assert_eq!(
            r.rows[2].interest,
            money(1112.0 * (1.06_f64.powf(1.0 / 6.0) - 1.0))
        );
        assert_eq!(r.interest_method, InterestMethod::Semiannual);
    }

    #[test]
    fn extra_on_synthetic_origination_is_not_discarded() {
        let mut q = request();
        q.metadata["original_amount"] = json!(1200);
        q.metadata["origination_date"] = json!("2026-01-01");
        q.balances.clear();
        q.metadata[LOAN_EVENTS_KEY] = json!([{
            "type":"extra_repayment", "effectiveDate":"2026-01-01", "amount":50
        }]);
        assert_eq!(calculate_loan(&q).unwrap().rows[0].balance, 1150.0);
    }

    #[test]
    fn a_mistyped_far_future_balance_is_ignored() {
        let q = request();
        let mut typo = q.clone();
        typo.balances.push(LoanBalance {
            date: date("2926-03-01"),
            balance: 1.0,
            notes: None,
        });
        assert_eq!(
            calculate_loan(&typo).unwrap().current_balance,
            calculate_loan(&q).unwrap().current_balance
        );
    }

    #[test]
    fn month_end_and_leap_day_keep_the_schedule_anchor() {
        let anchor = date("2024-01-31");
        assert_eq!(
            payment_date(anchor, 1, LoanFrequency::Monthly),
            Some(date("2024-02-29"))
        );
        assert_eq!(
            payment_date(anchor, 2, LoanFrequency::Monthly),
            Some(date("2024-03-31"))
        );
        assert_eq!(
            payment_date(date("2024-01-30"), 2, LoanFrequency::Monthly),
            Some(date("2024-03-30"))
        );
        // A first payment on the last day of a short month keeps its day.
        assert_eq!(
            payment_date(date("2026-06-30"), 1, LoanFrequency::Monthly),
            Some(date("2026-07-30"))
        );
        assert_eq!(
            payment_date(date("2026-02-28"), 1, LoanFrequency::Monthly),
            Some(date("2026-03-28"))
        );
    }

    #[test]
    fn no_op_event_does_not_change_posted_interest() {
        let mut q = request();
        q.metadata[LOAN_PROJECTION_KEY]["annualRate"] = json!(5);
        let original = calculate_loan(&q).unwrap();
        q.metadata[LOAN_EVENTS_KEY] = json!([{
            "type":"rate_change", "effectiveDate":"2026-01-16", "annualRate":5
        }]);
        let split = calculate_loan(&q).unwrap();
        assert_eq!(original.current_balance, split.current_balance);
        assert_eq!(original.interest_to_date, split.interest_to_date);
    }

    #[test]
    fn excessively_long_horizon_is_unavailable_instead_of_silently_truncated() {
        let mut q = request();
        q.metadata[LOAN_PROJECTION_KEY]["amortizationEndDate"] = json!("9999-01-01");
        assert!(calculate_loan(&q).is_none());
    }

    #[test]
    fn a_later_positive_confirmation_restarts_the_existing_payment_cadence() {
        let mut q = request();
        q.balances[0].balance = 900.0;
        q.metadata[LOAN_PROJECTION_KEY]["annualRate"] = json!(12);
        q.metadata[LOAN_PROJECTION_KEY]["paymentAmount"] = json!(1000);
        q.balances.push(LoanBalance {
            date: date("2026-04-15"),
            balance: 1000.0,
            notes: None,
        });
        q.as_of = date("2026-05-01");
        let r = calculate_loan(&q).unwrap();
        let may = r.rows.iter().find(|row| row.date == q.as_of).unwrap();
        assert!(may.scheduled_payment);
        assert_eq!(may.interest, 5.33);
        assert_eq!(r.current_balance, 5.33);
        assert_eq!(r.remaining_payments, 1);
    }

    #[test]
    fn inherited_frequency_change_uses_its_event_date_not_the_first_statement_date() {
        let mut q = request();
        q.balances[0].date = date("2026-03-01");
        q.metadata[LOAN_EVENTS_KEY] = json!([{
            "type":"payment_frequency_change", "effectiveDate":"2026-02-10", "frequency":"biweekly"
        }]);
        let r = calculate_loan(&q).unwrap();
        assert_eq!(r.rows[1].date, date("2026-03-10"));
        assert_eq!(r.rows[2].date, date("2026-03-24"));
    }

    #[test]
    fn horizon_before_next_instalment_exposes_unpaid_interest_even_with_zero_principal() {
        let mut q = request();
        q.metadata[LOAN_PROJECTION_KEY]["annualRate"] = json!(12);
        q.metadata[LOAN_PROJECTION_KEY]["amortizationEndDate"] = json!("2026-01-20");
        q.metadata[LOAN_EVENTS_KEY] = json!([{
            "type":"extra_repayment", "effectiveDate":"2026-01-16", "amount":1200
        }]);
        let r = calculate_loan(&q).unwrap();
        assert_eq!(r.residual_balance, 0.0);
        assert_eq!(r.residual_interest, 5.81);
        assert_eq!(r.current_balance, 0.0);
        assert_eq!(r.payoff_date, None);
    }

    #[test]
    fn confirmed_closure_settles_pending_interest_without_trailing_events_moving_payoff() {
        let mut q = request();
        q.metadata[LOAN_PROJECTION_KEY]["annualRate"] = json!(12);
        q.metadata[LOAN_EVENTS_KEY] = json!([
            {"type":"extra_repayment", "effectiveDate":"2026-01-16", "amount":1200},
            {"type":"rate_change", "effectiveDate":"2026-04-15", "annualRate":5}
        ]);
        q.balances.push(LoanBalance {
            date: date("2026-01-20"),
            balance: 0.0,
            notes: None,
        });
        q.balances.push(LoanBalance {
            date: date("2026-02-20"),
            balance: 0.0,
            notes: None,
        });
        let r = calculate_loan(&q).unwrap();
        assert_eq!(r.payoff_date, Some(date("2026-01-20")));
        assert_eq!(r.residual_interest, 0.0);
    }

    #[test]
    fn decimal_midpoints_round_consistently_at_money_posting_boundaries() {
        for (input, expected) in [(1.005, 1.01), (1.015, 1.02), (0.145, 0.15), (-1.005, -1.01)] {
            assert_eq!(money(input), expected);
        }
        let mut q = request();
        q.balances[0].balance = 100.005;
        q.metadata[LOAN_PROJECTION_KEY]["paymentAmount"] = json!(1.005);
        q.as_of = date("2026-02-01");
        let r = calculate_loan(&q).unwrap();
        assert_eq!(r.rows[0].balance, 100.01);
        assert_eq!(r.rows[1].payment, 1.01);
        assert_eq!(r.current_balance, 99.0);
        q.balances[0].balance = 100.5;
        q.metadata[LOAN_PROJECTION_KEY]["annualRate"] = json!(12);
        let r = calculate_loan(&q).unwrap();
        assert_eq!(r.rows[1].interest, 1.01);
    }
}

#[cfg(test)]
#[path = "loan/reference_tests.rs"]
mod reference_tests;

#[cfg(test)]
mod lifecycle_tests;

#[cfg(test)]
mod boundary_tests;
