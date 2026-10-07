//! Calendar and edit-transition boundaries around the shared ledger.
use super::*;
use serde_json::json;

fn request() -> LoanCalculationRequest {
    serde_json::from_value(json!({
        "metadata": {"original_amount":"1200", "origination_date":"2026-01-01",
            "loan_projection":{"version": 1,"annualRate":0,"paymentAmount":100,
                "frequency":"monthly","firstPaymentDate":"2026-02-01","paymentCount":12}},
        "balances": [], "asOf":"2026-03-01"
    }))
    .unwrap()
}

#[test]
fn no_calculation_or_recalculation_before_the_first_known_balance() {
    for first in ["2026-01-01", "2026-02-01"] {
        let mut q = request();
        q.metadata[LOAN_PROJECTION_KEY]["firstPaymentDate"] = json!(first);
        q.as_of = "2025-12-31".parse().unwrap();
        assert!(calculate_loan(&q).is_none(), "first {first}");
        assert!(recalculate_loan(&LoanRecalculationRequest {
            loan: q.clone(),
            annual_rate: 0.0
        })
        .is_none());
        q.as_of = "2026-01-01".parse().unwrap();
        assert_eq!(calculate_loan(&q).unwrap().current_balance, 1200.0);
    }
}

#[test]
fn serialized_terms_keep_the_same_schedule() {
    let mut q = request();
    let reference = calculate_loan(&q).unwrap();
    assert_eq!(reference.current_balance, 1000.0);
    assert_eq!(
        reference
            .rows
            .iter()
            .filter(|r| r.scheduled_payment)
            .count(),
        12
    );
    assert_eq!(reference.payoff_date, Some("2027-01-01".parse().unwrap()));
    for (day, expected) in [
        ("2026-01-01", 1200.0),
        ("2026-01-31", 1200.0),
        ("2026-02-01", 1100.0),
    ] {
        q.as_of = day.parse().unwrap();
        assert_eq!(calculate_loan(&q).unwrap().current_balance, expected);
    }
    q.as_of = "2026-03-01".parse().unwrap();
    q.metadata[LOAN_PROJECTION_KEY] = json!(q.metadata[LOAN_PROJECTION_KEY].to_string());
    assert_eq!(
        serde_json::to_value(calculate_loan(&q).unwrap()).unwrap(),
        serde_json::to_value(reference).unwrap()
    );
}

#[test]
fn utc_quote_days_do_not_leak_into_the_previous_calendar_day() {
    // Covers leap-day and both North American DST boundaries. Quotes remain
    // calendar observations regardless of where the user opens the application.
    for (before, after) in [
        ("2024-02-29", "2024-03-01"),
        ("2026-03-07", "2026-03-08"),
        ("2026-10-31", "2026-11-01"),
    ] {
        let mut q = request();
        q.metadata["origination_date"] = json!(before);
        q.metadata[LOAN_PROJECTION_KEY]["firstPaymentDate"] = json!(after);
        let quote = Quote {
            timestamp: format!("{after}T00:00:00Z").parse().unwrap(),
            close: Decimal::new(700, 0),
            ..Default::default()
        };
        q.balances.push(LoanBalance::from(&quote));
        assert_eq!(q.balances[0].date.to_string(), after);
        q.as_of = before.parse().unwrap();
        assert_eq!(calculate_loan(&q).unwrap().current_balance, 1200.0);
        q.as_of = after.parse().unwrap();
        assert_eq!(calculate_loan(&q).unwrap().current_balance, 700.0);
    }
}

#[test]
fn removing_opening_confirmation_restores_original_terms_without_losing_events() {
    let mut q = request();
    q.metadata[LOAN_EVENTS_KEY] = json!([
        {"type":"extra_repayment","effectiveDate":"2026-02-01","amount":50},
        {"type":"renewal","effectiveDate":"2026-03-01","annualRate":0,"paymentAmount":150}
    ]);
    q.balances.push(LoanBalance {
        date: "2026-01-01".parse().unwrap(),
        balance: 1500.0,
        notes: None,
    });
    assert_eq!(calculate_loan(&q).unwrap().current_balance, 1200.0);
    q.balances.clear();
    let result = calculate_loan(&q).unwrap();
    assert_eq!(result.current_balance, 900.0);
    assert_eq!(result.payment_amount, 150.0);
    assert!(!result.rows[0].confirmed);
    assert_eq!(
        result.rows.iter().map(|r| r.extra_payment).sum::<f64>(),
        50.0
    );
}

#[test]
fn renewal_maturity_add_edit_remove_never_changes_valuation_or_amortization() {
    let mut q = request();
    q.metadata[LOAN_EVENTS_KEY] = json!([
        {"type":"renewal","effectiveDate":"2026-02-01","annualRate":6,"paymentAmount":120}
    ]);
    let reference = serde_json::to_value(calculate_loan(&q).unwrap()).unwrap();
    for maturity in [json!("2026-06-01"), json!("2026-09-01"), Value::Null] {
        q.metadata[LOAN_EVENTS_KEY][0]["termEndDate"] = maturity.clone();
        q.metadata["renewal_maturity_date"] = maturity;
        assert_eq!(
            serde_json::to_value(calculate_loan(&q).unwrap()).unwrap(),
            reference
        );
    }
}

#[test]
fn same_day_confirmed_closure_is_not_reopened_by_recalculation() {
    let mut q = request();
    q.balances.push(LoanBalance {
        date: q.as_of,
        balance: 0.0,
        notes: None,
    });
    assert_eq!(calculate_loan(&q).unwrap().current_balance, 0.0);
    assert!(recalculate_loan(&LoanRecalculationRequest {
        loan: q,
        annual_rate: 6.0
    })
    .is_none());
}

#[test]
fn oversized_extra_payment_caps_principal_but_preserves_accrued_interest() {
    let mut q = request();
    q.metadata[LOAN_PROJECTION_KEY]["annualRate"] = json!(12);
    q.metadata[LOAN_EVENTS_KEY] =
        json!([{ "type":"extra_repayment", "effectiveDate":"2026-01-16", "amount":5000 }]);
    q.as_of = "2026-01-16".parse().unwrap();
    let result = calculate_loan(&q).unwrap();
    assert_eq!(result.current_balance, 0.0);
    assert_eq!(
        result.rows.iter().map(|r| r.extra_payment).sum::<f64>(),
        1200.0
    );
    assert_eq!(result.payoff_date, Some("2026-02-01".parse().unwrap()));
    let final_row = result.rows.last().unwrap();
    assert_eq!(final_row.interest, 5.81); // 1200 * 1% * 15/31 days.
    assert_eq!(final_row.payment, 5.81);
    assert_eq!(final_row.principal, 0.0);
}
