//! Engine behaviour: schedules, dated events, confirmed balances and their boundaries.
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
        payments: Vec::new(),
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
