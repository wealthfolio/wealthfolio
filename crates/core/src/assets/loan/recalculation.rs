//! Solve a level payment using the same dated ledger as valuation, including
//! frequency resets, accrued interest, recorded events and cent rounding.
use super::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoanRecalculationRequest {
    #[serde(flatten)]
    pub loan: LoanCalculationRequest,
    pub annual_rate: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoanRecalculation {
    pub payment_amount: f64,
    pub remaining_payments: usize,
    pub current_balance: f64,
}

/// `as_of` is the effective date. Return the smallest cent payment that settles
/// principal and accrued interest by the existing amortization horizon.
pub fn recalculate_loan(request: &LoanRecalculationRequest) -> Option<LoanRecalculation> {
    if !request.annual_rate.is_finite() || !(0.0..=100.0).contains(&request.annual_rate) {
        return None;
    }
    let date = request.loan.as_of;
    let horizon = amortization_horizon(&terms(&request.loan.metadata)?)?;
    if date > horizon {
        return None;
    }
    let mut loan = request.loan.clone();
    // Solve from observations known at the effective date. Later confirmations
    // reconcile recorded history; they cannot prove that a proposed payment works.
    loan.balances.retain(|balance| balance.date <= date);
    let mut events = decoded(loan.metadata.get(LOAN_EVENTS_KEY))
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();
    events.retain(|value| {
        serde_json::from_value::<Event>(value.clone()).map_or(true, |event| event.date() <= horizon)
    });
    loan.metadata[LOAN_EVENTS_KEY] = Value::Array(events.clone());
    let original = calculate_loan(&loan)?;
    let confirmed_at_date = original
        .rows
        .iter()
        .find(|row| row.date == date && row.confirmed);
    let current_balance = confirmed_at_date.map(|row| row.balance).or_else(|| {
        original
            .rows
            .iter()
            .rev()
            .find(|r| r.date < date)
            .map(|r| r.balance)
            .or_else(|| original.rows.first().map(|r| r.opening_balance))
    })?;
    if current_balance <= 0.0 {
        return None;
    }
    events.push(serde_json::json!({"type":"rate_change", "effectiveDate":date, "annualRate":request.annual_rate}));
    events.push(
        serde_json::json!({"type":"payment_change", "effectiveDate":date, "paymentAmount":0.01}),
    );
    let payment_index = events.len() - 1;
    loan.metadata[LOAN_EVENTS_KEY] = Value::Array(events);
    let mut evaluate = |cents: u64| {
        loan.metadata[LOAN_EVENTS_KEY][payment_index]["paymentAmount"] =
            serde_json::json!(cents as f64 / 100.0);
        calculate_loan(&loan)
    };
    let settled = |result: &LoanCalculation| {
        result.residual_balance == 0.0
            && result.residual_interest == 0.0
            && result
                .payoff_date
                .is_some_and(|payoff| payoff >= date && payoff <= horizon)
    };
    let mut low = 1_u64;
    let mut high = (current_balance * 100.0).ceil().max(1.0) as u64;
    loop {
        let result = evaluate(high)?;
        if settled(&result) {
            break;
        }
        high = high.checked_mul(2)?;
        if high > 100_000_000_000_000_000 {
            return None;
        }
    }
    while low < high {
        let middle = low + (high - low) / 2;
        if evaluate(middle).as_ref().is_some_and(&settled) {
            high = middle;
        } else {
            low = middle + 1;
        }
    }
    let result = evaluate(low)?;
    let remaining_payments = result
        .rows
        .iter()
        .filter(|r| r.date >= date && r.scheduled_payment)
        .count();
    if remaining_payments == 0 {
        return None;
    }
    Some(LoanRecalculation {
        payment_amount: low as f64 / 100.0,
        remaining_payments,
        current_balance,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request() -> LoanRecalculationRequest {
        serde_json::from_value(json!({
            "metadata": {"loan_projection": {"version": 1,"annualRate":0,"paymentAmount":100,
                "frequency":"monthly","firstPaymentDate":"2026-02-01","amortizationEndDate":"2026-05-01"},
                "loan_events":[{"type":"payment_frequency_change","effectiveDate":"2026-02-10","frequency":"biweekly"}]},
            "balances":[{"date":"2026-01-01","balance":1200}], "asOf":"2026-03-01", "annualRate":0
        })).unwrap()
    }
    fn apply(request: &LoanRecalculationRequest, payment: f64) -> LoanCalculation {
        let mut loan = request.loan.clone();
        let mut events = decoded(loan.metadata.get(LOAN_EVENTS_KEY))
            .unwrap()
            .as_array()
            .unwrap()
            .clone();
        events.push(json!({"type":"rate_change","effectiveDate":loan.as_of,"annualRate":request.annual_rate}));
        events.push(
            json!({"type":"payment_change","effectiveDate":loan.as_of,"paymentAmount":payment}),
        );
        loan.metadata[LOAN_EVENTS_KEY] = json!(events);
        calculate_loan(&loan).unwrap()
    }
    #[test]
    fn recalculation_uses_reset_cadence_and_settles_at_horizon() {
        let q = request();
        let result = recalculate_loan(&q).unwrap();
        assert_eq!(result.current_balance, 1000.0);
        assert_eq!(result.remaining_payments, 4);
        assert_eq!(result.payment_amount, 250.0);
        assert_eq!(apply(&q, 200.0).residual_balance, 200.0); // Previous frontend result.
        assert_eq!(apply(&q, result.payment_amount).residual_balance, 0.0);
    }
    #[test]
    fn recalculation_includes_stub_interest_and_cent_postings() {
        let mut q = request();
        q.loan.metadata[LOAN_PROJECTION_KEY]["annualRate"] = json!(12);
        q.annual_rate = 8.0;
        let result = recalculate_loan(&q).unwrap();
        let applied = apply(&q, result.payment_amount);
        assert_eq!(applied.residual_balance, 0.0);
        assert_eq!(applied.residual_interest, 0.0);
        let insufficient = apply(&q, result.payment_amount - 0.01);
        assert!(insufficient.residual_balance + insufficient.residual_interest > 0.0);
    }
    #[test]
    fn recalculation_uses_contract_horizon_even_if_old_payment_finishes_early() {
        let mut q = request();
        q.loan.metadata[LOAN_EVENTS_KEY] = json!([]);
        q.loan.metadata[LOAN_PROJECTION_KEY]["paymentAmount"] = json!(500);
        q.loan.metadata[LOAN_PROJECTION_KEY]
            .as_object_mut()
            .unwrap()
            .remove("amortizationEndDate");
        q.loan.metadata[LOAN_PROJECTION_KEY]["paymentCount"] = json!(4);
        let result = recalculate_loan(&q).unwrap();
        assert_eq!(result.current_balance, 700.0);
        assert_eq!(result.remaining_payments, 3);
        assert_eq!(result.payment_amount, 233.34);
    }
    #[test]
    fn later_confirmations_cannot_settle_a_balance_left_at_the_horizon() {
        let mut q = request();
        q.loan.metadata[LOAN_EVENTS_KEY] = json!([]);
        for day in ["2026-06-01", "2026-06-02"] {
            q.loan.balances.push(LoanBalance {
                date: day.parse().unwrap(),
                balance: 0.0,
                notes: None,
            });
        }
        let result = recalculate_loan(&q).unwrap();
        assert_eq!(result.payment_amount, 366.67);
        assert_eq!(result.remaining_payments, 3);
        let applied = apply(&q, result.payment_amount);
        assert_eq!(
            applied
                .rows
                .iter()
                .find(|row| row.date == "2026-05-01".parse::<NaiveDate>().unwrap())
                .unwrap()
                .balance,
            0.0
        );
    }
    #[test]
    fn invalid_or_expired_recalculation_is_unavailable() {
        let mut q = request();
        q.annual_rate = 101.0;
        assert!(recalculate_loan(&q).is_none());
        q.annual_rate = 0.0;
        q.loan.as_of = "2026-06-01".parse().unwrap();
        assert!(recalculate_loan(&q).is_none());
    }
}

#[cfg(test)]
mod stabilization_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_later_confirmation_is_not_proof_of_payment_sufficiency() {
        let mut request: LoanRecalculationRequest = serde_json::from_value(json!({
            "metadata": {"loan_projection": {"version": 1,"annualRate":0,"paymentAmount":100,"frequency":"monthly","firstPaymentDate":"2026-02-01","paymentCount":12}},
            "balances":[{"date":"2026-01-01","balance":1200}], "asOf":"2026-03-01", "annualRate":0
        })).unwrap();
        request.loan.balances.push(LoanBalance {
            date: "2027-01-01".parse().unwrap(),
            balance: 0.0,
            notes: None,
        });
        let result = recalculate_loan(&request).unwrap();
        assert_eq!(result.current_balance, 1100.0);
        assert_eq!(result.payment_amount, 100.0);
        assert_eq!(result.remaining_payments, 11);
    }

    #[test]
    fn creation_payment_settles_delayed_first_instalment_with_cent_postings() {
        for first in ["2026-02-01", "2026-03-01"] {
            let metadata = json!({"original_amount":300000,"origination_date":"2026-01-01",
                "loan_projection":{"version": 1,"annualRate":6,"paymentAmount":1798.651575,"frequency":"monthly","firstPaymentDate":first,"paymentCount":360}});
            let mut request = LoanCalculationRequest {
                metadata,
                balances: vec![],
                as_of: "2026-01-01".parse().unwrap(),
            };
            let solved = recalculate_loan(&LoanRecalculationRequest {
                loan: request.clone(),
                annual_rate: 6.0,
            })
            .unwrap();
            request.metadata[LOAN_PROJECTION_KEY]["paymentAmount"] = json!(solved.payment_amount);
            let result = calculate_loan(&request).unwrap();
            assert_eq!(result.residual_balance, 0.0);
            assert_eq!(result.residual_interest, 0.0);
            assert_eq!(
                result.payoff_date,
                amortization_horizon(&terms(&request.metadata).unwrap())
            );
            request.metadata[LOAN_PROJECTION_KEY]["paymentAmount"] =
                json!(solved.payment_amount - 0.01);
            assert!(calculate_loan(&request).unwrap().residual_balance > 0.0);
        }
    }
}
