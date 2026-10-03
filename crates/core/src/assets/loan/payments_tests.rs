//! Payments from an account, rule by rule (docs/architecture/loans.md).
use super::super::{calculate_loan, recalculate_loan, LoanBalance, LoanCalculationRequest};
use super::*;
use serde_json::{json, Value};

fn date(s: &str) -> NaiveDate {
    s.parse().unwrap()
}

/// 1,200 at 0% on 2026-01-01, 100 a month from February to the next January.
fn monthly(payments: Vec<LoanPayment>) -> LoanCalculationRequest {
    LoanCalculationRequest {
        metadata: json!({"loan_projection": {"version":1,"annualRate":0,"paymentAmount":100,"frequency":"monthly","firstPaymentDate":"2026-02-01","amortizationEndDate":"2027-01-01"}}),
        balances: vec![LoanBalance {
            date: date("2026-01-01"),
            balance: 1200.0,
            notes: None,
        }],
        as_of: date("2026-06-15"),
        payments,
    }
}

fn pay(id: &str, day: &str, amount: f64) -> LoanPayment {
    LoanPayment {
        activity_id: id.into(),
        account_id: "chequing".into(),
        date: date(day),
        amount,
        escrow: 0.0,
        applies_to: None,
    }
}

fn calc(request: &LoanCalculationRequest) -> LoanCalculation {
    calculate_loan(request).unwrap()
}

fn status(result: &LoanCalculation, due: &str) -> Option<InstalmentStatus> {
    result
        .instalments
        .iter()
        .find(|i| i.due_date == date(due))
        .map(|i| i.status)
}

fn allocation<'a>(result: &'a LoanCalculation, id: &str) -> &'a PaymentAllocation {
    result
        .allocations
        .iter()
        .find(|a| a.activity_id == id)
        .unwrap()
}

#[test]
fn without_payments_nothing_is_reported() {
    let result = calc(&monthly(vec![]));
    assert_eq!(result.current_balance, 700.0);
    assert!(result.allocations.is_empty() && result.instalments.is_empty());
    assert!(result.payment_suggestion.is_none());
}

#[test]
fn matched_payments_settle_instalments_without_moving_the_balance() {
    let result = calc(&monthly(vec![
        pay("feb", "2026-02-02", 100.0),
        pay("mar", "2026-03-01", 100.0),
    ]));
    assert_eq!(result.current_balance, 700.0);
    let feb = allocation(&result, "feb");
    assert_eq!(
        (feb.instalment, feb.applied, feb.extra),
        (Some(date("2026-02-01")), 100.0, 0.0)
    );
    assert_eq!(status(&result, "2026-02-01"), Some(InstalmentStatus::Paid));
    assert_eq!(status(&result, "2026-03-01"), Some(InstalmentStatus::Paid));
}

#[test]
fn an_overpayment_is_extra_principal_from_its_date() {
    let result = calc(&monthly(vec![pay("mar", "2026-03-01", 150.0)]));
    let mar = allocation(&result, "mar");
    assert_eq!((mar.applied, mar.extra), (100.0, 50.0));
    assert_eq!(result.current_balance, 650.0);
    let march = result
        .rows
        .iter()
        .find(|row| row.date == date("2026-03-01"))
        .unwrap();
    assert_eq!(march.extra_payment, 50.0);
}

#[test]
fn escrow_is_never_principal_or_interest() {
    let mut payment = pay("mar", "2026-03-01", 130.0);
    payment.escrow = 30.0;
    let result = calc(&monthly(vec![payment.clone()]));
    let mar = allocation(&result, "mar");
    assert_eq!((mar.escrow, mar.applied, mar.extra), (30.0, 100.0, 0.0));
    assert_eq!(result.current_balance, 700.0);
    // Escrow cannot exceed the payment it is part of.
    payment.escrow = 500.0;
    let result = calc(&monthly(vec![payment]));
    let mar = allocation(&result, "mar");
    assert_eq!((mar.escrow, mar.applied, mar.extra), (130.0, 0.0, 0.0));
}

#[test]
fn monthly_payments_match_within_ten_days() {
    let result = calc(&monthly(vec![
        pay("late", "2026-03-11", 100.0),
        pay("early", "2026-04-22", 100.0),
    ]));
    assert_eq!(
        allocation(&result, "late").instalment,
        Some(date("2026-03-01"))
    );
    assert_eq!(
        allocation(&result, "early").instalment,
        Some(date("2026-05-01"))
    );
    // Eleven days late settles nothing: the whole payment is extra principal.
    let result = calc(&monthly(vec![pay("late", "2026-03-12", 100.0)]));
    let late = allocation(&result, "late");
    assert_eq!((late.instalment, late.extra), (None, 100.0));
    assert_eq!(result.current_balance, 600.0);
}

#[test]
fn biweekly_payments_match_within_six_days() {
    let request = |payments| LoanCalculationRequest {
        metadata: json!({"loan_projection": {"version":1,"annualRate":0,"paymentAmount":50,"frequency":"biweekly","firstPaymentDate":"2026-02-02","paymentCount":24}}),
        balances: vec![LoanBalance {
            date: date("2026-01-26"),
            balance: 1200.0,
            notes: None,
        }],
        as_of: date("2026-04-01"),
        payments,
    };
    let result = calc(&request(vec![pay("six", "2026-02-22", 50.0)]));
    assert_eq!(
        allocation(&result, "six").instalment,
        Some(date("2026-02-16"))
    );
    // Seven days from two instalments is outside both windows.
    let result = calc(&request(vec![pay("seven", "2026-02-23", 50.0)]));
    assert_eq!(allocation(&result, "seven").instalment, None);
}

#[test]
fn a_second_payment_in_the_same_period_is_extra() {
    let result = calc(&monthly(vec![
        pay("first", "2026-03-01", 100.0),
        pay("second", "2026-03-03", 100.0),
    ]));
    assert_eq!(
        allocation(&result, "first").instalment,
        Some(date("2026-03-01"))
    );
    let second = allocation(&result, "second");
    assert_eq!((second.instalment, second.extra), (None, 100.0));
}

#[test]
fn a_named_target_overrides_matching() {
    let mut extra = pay("extra", "2026-03-01", 100.0);
    extra.applies_to = Some(PaymentTarget::Extra);
    let mut ahead = pay("ahead", "2026-03-20", 100.0);
    ahead.applies_to = Some(PaymentTarget::Instalment(date("2026-05-01")));
    let mut unknown = pay("unknown", "2026-04-02", 100.0);
    unknown.applies_to = Some(PaymentTarget::Instalment(date("2026-04-15")));
    let result = calc(&monthly(vec![extra, ahead, unknown]));
    assert_eq!(allocation(&result, "extra").extra, 100.0);
    assert_eq!(
        allocation(&result, "ahead").instalment,
        Some(date("2026-05-01"))
    );
    // A date that is no instalment falls back to matching.
    assert_eq!(
        allocation(&result, "unknown").instalment,
        Some(date("2026-04-01"))
    );
}

#[test]
fn an_already_settled_instalment_passes_the_rest_to_principal() {
    let mut again = pay("again", "2026-03-05", 100.0);
    again.applies_to = Some(PaymentTarget::Instalment(date("2026-03-01")));
    let result = calc(&monthly(vec![pay("mar", "2026-03-01", 100.0), again]));
    let again = allocation(&result, "again");
    assert_eq!((again.applied, again.extra), (0.0, 100.0));
}

#[test]
fn shortfalls_and_missed_instalments_are_flagged_not_guessed() {
    let result = calc(&monthly(vec![
        pay("mar", "2026-03-01", 60.0),
        pay("may", "2026-05-01", 100.0),
    ]));
    assert_eq!(status(&result, "2026-03-01"), Some(InstalmentStatus::Short));
    assert_eq!(
        status(&result, "2026-04-01"),
        Some(InstalmentStatus::Missing)
    );
    assert_eq!(status(&result, "2026-05-01"), Some(InstalmentStatus::Paid));
    // The balance still assumes every scheduled payment.
    assert_eq!(result.current_balance, 700.0);
}

#[test]
fn statuses_start_at_the_first_payment_and_wait_out_the_window() {
    let mut request = monthly(vec![pay("apr", "2026-04-01", 100.0)]);
    request.as_of = date("2026-06-05");
    let result = calc(&request);
    assert_eq!(status(&result, "2026-03-01"), None);
    assert_eq!(
        status(&result, "2026-05-01"),
        Some(InstalmentStatus::Missing)
    );
    assert_eq!(status(&result, "2026-06-01"), Some(InstalmentStatus::Due));
    assert_eq!(status(&result, "2026-07-01"), None);
}

#[test]
fn instalments_after_an_early_payoff_are_not_missing() {
    let result = calc(&monthly(vec![
        pay("mar", "2026-03-01", 100.0),
        pay("payoff", "2026-03-15", 1000.0),
    ]));
    assert_eq!(result.current_balance, 0.0);
    assert_eq!(status(&result, "2026-04-01"), None);
}

#[test]
fn a_repeated_difference_suggests_a_payment_change() {
    let suggestion = |payments| calc(&monthly(payments)).payment_suggestion;
    let three = |amount| {
        vec![
            pay("mar", "2026-03-01", amount),
            pay("apr", "2026-04-01", amount),
            pay("may", "2026-05-01", amount),
        ]
    };
    assert_eq!(
        suggestion(three(110.0)),
        Some(PaymentChangeSuggestion {
            effective_date: date("2026-03-01"),
            payment_amount: 110.0,
        })
    );
    assert_eq!(
        suggestion(three(90.0)).map(|s| s.payment_amount),
        Some(90.0)
    );
    assert_eq!(suggestion(three(100.5)), None);
    assert_eq!(suggestion(three(110.0)[1..].to_vec()), None);
    let mut uneven = three(110.0);
    uneven[2].amount = 120.0;
    assert_eq!(suggestion(uneven), None);
    // Payments the user directed are not evidence of a new payment amount.
    let mut directed = three(110.0);
    directed[0].applies_to = Some(PaymentTarget::Instalment(date("2026-03-01")));
    assert_eq!(suggestion(directed), None);
}

#[test]
fn a_confirmed_balance_still_wins_over_payments() {
    let mut request = monthly(vec![pay("mar", "2026-03-01", 150.0)]);
    request.balances.push(LoanBalance {
        date: date("2026-04-15"),
        balance: 900.0,
        notes: None,
    });
    // Without the confirmation the extra principal would leave 650.
    assert_eq!(calc(&request).current_balance, 700.0);
}

#[test]
fn payments_before_the_first_known_balance_change_nothing() {
    let result = calc(&monthly(vec![pay("old", "2025-12-15", 300.0)]));
    assert_eq!(result.current_balance, 700.0);
    // An uncounted payment does not start tracking missed instalments either.
    assert!(result.instalments.is_empty());
}

#[test]
fn with_interest_a_matched_payment_covers_interest_and_principal() {
    let mut request = monthly(vec![]);
    request.metadata["loan_projection"]["annualRate"] = json!(12);
    request.metadata["loan_projection"]["paymentAmount"] = json!(106.62);
    let march = calc(&request)
        .rows
        .into_iter()
        .find(|row| row.date == date("2026-03-01"))
        .unwrap();
    assert!(march.interest > 0.0 && march.principal > 0.0);
    request.payments = vec![pay("mar", "2026-03-01", march.payment)];
    let result = calc(&request);
    let mar = allocation(&result, "mar");
    assert_eq!((mar.applied, mar.extra), (march.payment, 0.0));
}

#[test]
fn recalculation_ignores_payments_after_its_date() {
    let solve = |payments| {
        recalculate_loan(&super::super::LoanRecalculationRequest {
            loan: LoanCalculationRequest {
                as_of: date("2026-04-01"),
                ..monthly(payments)
            },
            annual_rate: 0.0,
        })
        .unwrap()
        .payment_amount
    };
    assert_eq!(
        solve(vec![pay("later", "2026-05-01", 500.0)]),
        solve(vec![])
    );
}

#[test]
fn tags_read_the_stored_target_shapes() {
    let payment: LoanPayment = serde_json::from_value(json!({
        "activityId": "a", "date": "2026-03-01", "amount": 100, "appliesTo": "extra"
    }))
    .unwrap();
    assert_eq!(payment.applies_to, Some(PaymentTarget::Extra));
    let payment: LoanPayment = serde_json::from_value(json!({
        "activityId": "a", "date": "2026-03-01", "amount": 100, "appliesTo": "2026-03-01"
    }))
    .unwrap();
    assert_eq!(
        payment.applies_to,
        Some(PaymentTarget::Instalment(date("2026-03-01")))
    );
    assert_eq!(String::from(PaymentTarget::Extra), "extra");
}

/// A withdrawal with external-flow metadata and an optional loan tag.
fn withdrawal(tag: Option<Value>) -> Activity {
    super::super::test_support::withdrawal(
        tag.map(|tag| json!({ "flow": {"is_external": true}, LOAN_PAYMENT_TAG_KEY: tag })),
    )
}

#[test]
fn a_tagged_posted_cash_withdrawal_in_the_loans_currency_is_a_payment() {
    let activity = withdrawal(Some(
        json!({"loan_id": "loan", "escrow": 30, "applies_to": "extra"}),
    ));
    let (loan, payment) = LoanPayment::from_activity(&activity, "CASH", "CAD").unwrap();
    assert_eq!(loan, "loan");
    assert_eq!(
        payment,
        LoanPayment {
            activity_id: "act".into(),
            account_id: "chequing".into(),
            date: date("2026-03-01"),
            amount: 130.0,
            escrow: 30.0,
            applies_to: Some(PaymentTarget::Extra),
        }
    );
}

#[test]
fn anything_that_stops_qualifying_is_ignored() {
    use crate::activities::ActivityStatus;
    let tag = || Some(json!({"loan_id": "loan"}));
    let counts = |activity: &Activity, account: &str, currency: &str| {
        LoanPayment::from_activity(activity, account, currency).is_some()
    };
    assert!(counts(&withdrawal(tag()), "CASH", "CAD"));
    assert!(!counts(&withdrawal(None), "CASH", "CAD"));
    assert!(!counts(&withdrawal(tag()), "CREDIT_CARD", "CAD"));
    assert!(!counts(&withdrawal(tag()), "CASH", "USD"));
    let mut pending = withdrawal(tag());
    pending.status = ActivityStatus::Pending;
    assert!(!counts(&pending, "CASH", "CAD"));
    let mut deposit = withdrawal(tag());
    deposit.activity_type_override = Some("DEPOSIT".into());
    assert!(!counts(&deposit, "CASH", "CAD"));
    let mut empty = withdrawal(tag());
    empty.amount = None;
    assert!(!counts(&empty, "CASH", "CAD"));
}

#[test]
fn tags_serialize_only_what_they_say() {
    let tag = LoanPaymentTag {
        loan_id: "loan".into(),
        escrow: 0.0,
        applies_to: None,
    };
    assert_eq!(
        serde_json::to_value(&tag).unwrap(),
        json!({"loan_id": "loan"})
    );
}
