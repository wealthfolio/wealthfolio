//! Linking withdrawals to loans as payments.
use super::super::test_support::withdrawal;
use super::*;
use crate::activities::ActivityStatus;
use serde_json::json;

fn loan(extra: Value) -> LoanRecord {
    let mut metadata = json!({"loan_projection": {"version":1,"annualRate":0,"paymentAmount":100,"frequency":"monthly","firstPaymentDate":"2026-02-01","amortizationEndDate":"2027-01-01"}});
    if let (Some(target), Value::Object(fields)) = (metadata.as_object_mut(), extra) {
        target.extend(fields);
    }
    LoanRecord {
        asset_id: "loan".into(),
        currency: "CAD".into(),
        metadata,
        balances: vec![],
        payments: vec![],
        payment_accounts: vec!["chequing".into()],
    }
}

fn link(escrow: Option<f64>, applies_to: Option<PaymentTarget>) -> PaymentLink {
    PaymentLink::Link {
        loan_id: "loan".into(),
        escrow,
        applies_to,
        replace_event: false,
    }
}

/// The withdrawal's metadata a link writes.
fn activity_after(
    activity: &Activity,
    account_type: &str,
    loan: Option<&LoanRecord>,
    link: &PaymentLink,
) -> Result<Option<Value>, LoanError> {
    link_payment(activity, account_type, loan, link, Tz::UTC).map(|update| update.activity)
}

#[test]
fn linking_tags_the_withdrawal_and_keeps_its_other_metadata() {
    let activity = withdrawal(Some(json!({"flow": {"is_external": true}})));
    let target = Some(PaymentTarget::Extra);
    let metadata = activity_after(
        &activity,
        "CASH",
        Some(&loan(json!({}))),
        &link(None, target),
    )
    .unwrap()
    .unwrap();
    assert_eq!(metadata["flow"]["is_external"], true);
    assert_eq!(
        metadata[LOAN_PAYMENT_TAG_KEY],
        json!({"loan_id": "loan", "applies_to": "extra"})
    );
}

#[test]
fn escrow_defaults_to_the_loans_usual_escrow() {
    let loan = loan(json!({"escrow_amount": "30"}));
    let tagged = |escrow| {
        activity_after(&withdrawal(None), "CASH", Some(&loan), &link(escrow, None))
            .map(|metadata| metadata.unwrap()[LOAN_PAYMENT_TAG_KEY]["escrow"].clone())
    };
    assert_eq!(tagged(None), Ok(json!(30.0)));
    assert_eq!(tagged(Some(12.5)), Ok(json!(12.5)));
    // Escrow is part of the payment, so it cannot exceed it.
    assert_eq!(tagged(Some(131.0)), Err(LoanError::Invalid));
}

#[test]
fn extra_principal_has_no_escrow_unless_it_is_named() {
    let loan = loan(json!({"escrow_amount": "30"}));
    let tagged = |escrow| {
        let extra = link(escrow, Some(PaymentTarget::Extra));
        activity_after(&withdrawal(None), "CASH", Some(&loan), &extra)
            .map(|metadata| metadata.unwrap()[LOAN_PAYMENT_TAG_KEY]["escrow"].clone())
    };
    assert_eq!(tagged(None), Ok(Value::Null));
    assert_eq!(tagged(Some(12.5)), Ok(json!(12.5)));
}

#[test]
fn only_a_qualifying_withdrawal_can_be_linked() {
    let loan = loan(json!({}));
    let refused = |activity: &Activity, account: &str| {
        activity_after(activity, account, Some(&loan), &link(None, None)).unwrap_err()
    };
    let mut pending = withdrawal(None);
    pending.status = ActivityStatus::Pending;
    assert_eq!(refused(&pending, "CASH"), LoanError::PaymentNotEligible);
    let mut deposit = withdrawal(None);
    deposit.activity_type_override = Some("DEPOSIT".into());
    assert_eq!(refused(&deposit, "CASH"), LoanError::PaymentNotEligible);
    let mut dollars = withdrawal(None);
    dollars.currency = "USD".into();
    assert_eq!(refused(&dollars, "CASH"), LoanError::PaymentNotEligible);
    assert_eq!(
        refused(&withdrawal(None), "CREDIT_CARD"),
        LoanError::PaymentNotEligible
    );
}

#[test]
fn only_a_calculated_loan_that_exists_takes_payments() {
    let activity = withdrawal(None);
    let manual = loan(json!({"tracking_mode": "manual"}));
    assert_eq!(
        activity_after(&activity, "CASH", Some(&manual), &link(None, None)),
        Err(LoanError::Invalid)
    );
    assert_eq!(
        activity_after(&activity, "CASH", None, &link(None, None)),
        Err(LoanError::Invalid)
    );
}

#[test]
fn unlinking_removes_only_the_tag() {
    let tagged = withdrawal(Some(json!({
        "flow": {"is_external": true},
        LOAN_PAYMENT_TAG_KEY: {"loan_id": "loan"},
    })));
    assert_eq!(
        activity_after(&tagged, "CASH", None, &PaymentLink::Unlink),
        Ok(Some(json!({"flow": {"is_external": true}})))
    );
    let only_tag = withdrawal(Some(json!({ LOAN_PAYMENT_TAG_KEY: {"loan_id": "loan"} })));
    assert_eq!(
        activity_after(&only_tag, "CASH", None, &PaymentLink::Unlink),
        Ok(None)
    );
    // Unlinking an untagged withdrawal changes nothing.
    let plain = withdrawal(Some(json!({"flow": {"is_external": true}})));
    assert_eq!(
        activity_after(&plain, "CASH", None, &PaymentLink::Unlink),
        Ok(plain.metadata.clone())
    );
}

#[test]
fn links_read_the_shape_the_frontend_sends() {
    let link: PaymentLink = serde_json::from_value(json!({
        "type": "link", "loanId": "loan", "escrow": 25, "appliesTo": "2026-03-01"
    }))
    .unwrap();
    assert_eq!(link.loan_id(), Some("loan"));
    let unlink: PaymentLink = serde_json::from_value(json!({"type": "unlink"})).unwrap();
    assert_eq!(unlink, PaymentLink::Unlink);
}

#[test]
fn a_recorded_extra_repayment_is_matched_on_the_withdrawals_local_day() {
    // 130.00 withdrawn at 8 pm on March 1 in Toronto, already March 2 in UTC.
    let events =
        json!([{ "type": "extra_repayment", "effectiveDate": "2026-03-01", "amount": 130 }]);
    let recorded = loan(json!({ "loan_events": events.to_string() }));
    let mut activity = withdrawal(None);
    activity.activity_date = "2026-03-02T01:00:00Z".parse().unwrap();
    let toronto = chrono_tz::America::Toronto;
    assert_eq!(
        link_payment(
            &activity,
            "CASH",
            Some(&recorded),
            &link(None, None),
            toronto
        )
        .unwrap_err(),
        LoanError::PaymentDuplicatesEvent
    );
}

#[test]
fn a_withdrawal_matching_a_recorded_extra_repayment_replaces_it_only_when_asked() {
    // The withdrawal is 130.00 on 2026-03-01.
    let events = json!([
        { "type": "extra_repayment", "effectiveDate": "2026-03-01", "amount": 130 },
        { "type": "rate_change", "effectiveDate": "2026-06-01", "annualRate": 2 },
    ]);
    let recorded = loan(json!({ "loan_events": events.to_string() }));
    let activity = withdrawal(None);
    assert_eq!(
        link_payment(
            &activity,
            "CASH",
            Some(&recorded),
            &link(None, None),
            Tz::UTC
        )
        .unwrap_err(),
        LoanError::PaymentDuplicatesEvent
    );
    let replace = PaymentLink::Link {
        loan_id: "loan".into(),
        escrow: None,
        applies_to: None,
        replace_event: true,
    };
    let update = link_payment(&activity, "CASH", Some(&recorded), &replace, Tz::UTC).unwrap();
    // It is that extra repayment, so it counts as extra principal.
    assert_eq!(
        update.activity.unwrap()[LOAN_PAYMENT_TAG_KEY]["applies_to"],
        "extra"
    );
    let remaining = event_entries(&update.loan.unwrap());
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0]["type"], "rate_change");

    // Another day or amount is other money.
    for other in [
        json!({ "type": "extra_repayment", "effectiveDate": "2026-03-01", "amount": 120 }),
        json!({ "type": "extra_repayment", "effectiveDate": "2026-03-02", "amount": 130 }),
    ] {
        let unrelated = loan(json!({ "loan_events": json!([other]).to_string() }));
        let update = link_payment(
            &activity,
            "CASH",
            Some(&unrelated),
            &link(None, None),
            Tz::UTC,
        )
        .unwrap();
        assert!(update.activity.is_some());
        assert!(update.loan.is_none());
    }
}

#[test]
fn a_replaced_extra_repayment_keeps_the_whole_withdrawal_as_principal() {
    let events =
        json!([{ "type": "extra_repayment", "effectiveDate": "2026-03-01", "amount": 130 }]);
    let recorded = loan(json!({ "escrow_amount": "50", "loan_events": events.to_string() }));
    let replace = |escrow| PaymentLink::Link {
        loan_id: "loan".into(),
        escrow,
        applies_to: None,
        replace_event: true,
    };
    let tag = |link| {
        link_payment(&withdrawal(None), "CASH", Some(&recorded), &link, Tz::UTC)
            .unwrap()
            .activity
            .unwrap()[LOAN_PAYMENT_TAG_KEY]
            .clone()
    };
    // Not the loan's usual escrow: the event was 130.00 of principal.
    assert_eq!(
        tag(replace(None)),
        json!({ "loan_id": "loan", "applies_to": "extra" })
    );
    // Escrow the user names is kept.
    assert_eq!(tag(replace(Some(30.0)))["escrow"], 30.0);
}

#[test]
fn a_regular_payment_beside_an_extra_repayment_of_the_same_amount_is_not_that_repayment() {
    // A double-up: the 100.00 instalment due 2026-03-01 and an extra 100.00 that day.
    let events =
        json!([{ "type": "extra_repayment", "effectiveDate": "2026-03-01", "amount": 100 }]);
    let recorded = loan(json!({
        "original_amount": "1200",
        "origination_date": "2026-01-01",
        "loan_events": events.to_string(),
    }));
    let mut activity = withdrawal(None);
    activity.amount = Some(rust_decimal::Decimal::from(100));
    let due = chrono::NaiveDate::from_ymd_opt(2026, 3, 1).unwrap();
    // Directed to the instalment, or matched to it in full, it pays that instalment.
    for applies_to in [Some(PaymentTarget::Instalment(due)), None] {
        let update = link_payment(
            &activity,
            "CASH",
            Some(&recorded),
            &link(None, applies_to),
            Tz::UTC,
        )
        .unwrap();
        assert!(update.loan.is_none());
        assert!(update.activity.is_some());
    }
    // As extra principal it is the recorded repayment.
    assert_eq!(
        link_payment(
            &activity,
            "CASH",
            Some(&recorded),
            &link(None, Some(PaymentTarget::Extra)),
            Tz::UTC
        )
        .unwrap_err(),
        LoanError::PaymentDuplicatesEvent
    );
}

#[test]
fn a_replacement_smaller_than_the_usual_escrow_is_still_offered() {
    // The usual escrow of 250.00 is more than the 130.00 withdrawal.
    let events =
        json!([{ "type": "extra_repayment", "effectiveDate": "2026-03-01", "amount": 130 }]);
    let recorded = loan(json!({ "escrow_amount": "250", "loan_events": events.to_string() }));
    let activity = withdrawal(None);
    assert_eq!(
        link_payment(
            &activity,
            "CASH",
            Some(&recorded),
            &link(None, None),
            Tz::UTC
        )
        .unwrap_err(),
        LoanError::PaymentDuplicatesEvent
    );
    let replace = PaymentLink::Link {
        loan_id: "loan".into(),
        escrow: None,
        applies_to: None,
        replace_event: true,
    };
    let update = link_payment(&activity, "CASH", Some(&recorded), &replace, Tz::UTC).unwrap();
    assert_eq!(
        update.activity.unwrap()[LOAN_PAYMENT_TAG_KEY],
        json!({ "loan_id": "loan", "applies_to": "extra" })
    );
    // Without a recorded repayment the usual escrow still has to fit, and named
    // escrow is checked before anything else.
    let plain = loan(json!({ "escrow_amount": "250" }));
    assert_eq!(
        link_payment(&activity, "CASH", Some(&plain), &link(None, None), Tz::UTC).unwrap_err(),
        LoanError::Invalid
    );
    assert_eq!(
        link_payment(
            &activity,
            "CASH",
            Some(&recorded),
            &link(Some(200.0), None),
            Tz::UTC
        )
        .unwrap_err(),
        LoanError::Invalid
    );
}

#[test]
fn a_withdrawal_on_its_due_date_covers_the_extra_recorded_that_day() {
    // The instalment due 2026-03-01 is 100.00, with an extra repayment of the
    // withdrawal's amount recorded the same day.
    let linked = |amount: i64, day: &str| {
        let events = json!([{ "type": "extra_repayment", "effectiveDate": day, "amount": amount }]);
        let recorded = loan(json!({
            "original_amount": "1200",
            "origination_date": "2026-01-01",
            "loan_events": events.to_string(),
        }));
        let mut activity = withdrawal(None);
        activity.amount = Some(rust_decimal::Decimal::from(amount));
        activity.activity_date = format!("{day}T15:00:00Z").parse().unwrap();
        link_payment(
            &activity,
            "CASH",
            Some(&recorded),
            &link(None, None),
            Tz::UTC,
        )
    };
    // That day's instalment covers the extra, so the money counts once.
    for amount in [50, 100, 130] {
        assert!(linked(amount, "2026-03-01").unwrap().loan.is_none());
    }
    // On another day the withdrawal may be the recorded repayment.
    assert_eq!(
        linked(130, "2026-03-15").unwrap_err(),
        LoanError::PaymentDuplicatesEvent
    );
}
