use super::*;
use crate::assets::loan::loan_calculation;
use serde_json::json;

fn date(s: &str) -> NaiveDate {
    s.parse().unwrap()
}

/// 1,200 at 3% from January; renewed in March to 0% and 200 a month, so it
/// settles before a later rate change.
fn mortgage() -> Value {
    json!({
        "original_amount": "1200",
        "origination_date": "2026-01-01",
        "renewal_maturity_date": "2026-07-01",
        "loan_projection": {
            "version": 1,
            "annualRate": 3,
            "paymentAmount": 100,
            "frequency": "monthly",
            "firstPaymentDate": "2026-02-01",
            "amortizationEndDate": "2027-01-01"
        },
        "loan_events": [
            { "type": "renewal", "effectiveDate": "2026-03-01", "annualRate": 0, "paymentAmount": 200 },
            { "type": "rate_change", "effectiveDate": "2026-12-01", "annualRate": 9 }
        ]
    })
}

#[test]
fn a_scheduled_loan_shows_the_terms_in_effect_and_when_it_is_paid_off() {
    let metadata = mortgage();
    let calculation = loan_calculation(&metadata, &[], &[], date("2026-05-15")).unwrap();
    let summary = LoanSummary::new(&metadata, Some(&calculation));
    assert!(summary.scheduled);
    assert_eq!(summary.original_amount, Some(1200.0));
    // The renewal applies; the later rate change does not yet.
    assert_eq!(summary.annual_rate, Some(0.0));
    assert_eq!(summary.payment_amount, Some(200.0));
    assert_eq!(summary.frequency, Some(LoanFrequency::Monthly));
    assert_eq!(summary.renewal_maturity, Some(date("2026-07-01")));
    assert!(summary.payoff_date.is_some());
    assert_eq!(summary.payoff_date, calculation.payoff_date);
}

#[test]
fn no_payoff_is_promised_while_a_residual_remains() {
    let metadata = mortgage();
    let mut calculation = loan_calculation(&metadata, &[], &[], date("2026-05-15")).unwrap();
    calculation.residual_interest = 0.5;
    assert_eq!(
        LoanSummary::new(&metadata, Some(&calculation)).payoff_date,
        None
    );
}

#[test]
fn a_manual_loan_shows_the_rate_it_was_entered_with() {
    // An earlier release stored the principal as purchase_price.
    let metadata = json!({
        "tracking_mode": "manual",
        "interest_rate": "4.5",
        "purchase_price": "900",
        "renewal_maturity_date": "2027-03-01"
    });
    let summary = LoanSummary::new(&metadata, None);
    assert!(!summary.scheduled);
    assert_eq!(summary.annual_rate, Some(4.5));
    assert_eq!(summary.original_amount, Some(900.0));
    assert_eq!(summary.payment_amount, None);
    assert_eq!(summary.frequency, None);
    assert_eq!(summary.payoff_date, None);
    assert_eq!(summary.renewal_maturity, Some(date("2027-03-01")));
}
