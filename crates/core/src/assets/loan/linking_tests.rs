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
    }
}

#[test]
fn linking_tags_the_withdrawal_and_keeps_its_other_metadata() {
    let activity = withdrawal(Some(json!({"flow": {"is_external": true}})));
    let target = Some(PaymentTarget::Extra);
    let metadata = link_payment(
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
        link_payment(&withdrawal(None), "CASH", Some(&loan), &link(escrow, None))
            .map(|metadata| metadata.unwrap()[LOAN_PAYMENT_TAG_KEY]["escrow"].clone())
    };
    assert_eq!(tagged(None), Ok(json!(30.0)));
    assert_eq!(tagged(Some(12.5)), Ok(json!(12.5)));
    // Escrow is part of the payment, so it cannot exceed it.
    assert_eq!(tagged(Some(131.0)), Err(LoanError::Invalid));
}

#[test]
fn only_a_qualifying_withdrawal_can_be_linked() {
    let loan = loan(json!({}));
    let refused = |activity: &Activity, account: &str| {
        link_payment(activity, account, Some(&loan), &link(None, None)).unwrap_err()
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
        link_payment(&activity, "CASH", Some(&manual), &link(None, None)),
        Err(LoanError::Invalid)
    );
    assert_eq!(
        link_payment(&activity, "CASH", None, &link(None, None)),
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
        link_payment(&tagged, "CASH", None, &PaymentLink::Unlink),
        Ok(Some(json!({"flow": {"is_external": true}})))
    );
    let only_tag = withdrawal(Some(json!({ LOAN_PAYMENT_TAG_KEY: {"loan_id": "loan"} })));
    assert_eq!(
        link_payment(&only_tag, "CASH", None, &PaymentLink::Unlink),
        Ok(None)
    );
    // Unlinking an untagged withdrawal changes nothing.
    let plain = withdrawal(Some(json!({"flow": {"is_external": true}})));
    assert_eq!(
        link_payment(&plain, "CASH", None, &PaymentLink::Unlink),
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
