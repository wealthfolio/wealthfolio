//! Golden lifecycle values come from the independent decimal worksheet documented
//! in docs/architecture/loans.md, not this engine.
use super::*;
use serde_json::json;

#[test]
fn lifecycle_matches_independent_checkpoints_and_final_ledger() {
    let fixtures: Value = serde_json::from_str(include_str!("fixtures.json")).unwrap();
    let fixture = &fixtures["lifecycle"];
    for stage in fixture["stages"].as_array().unwrap() {
        let id = stage["id"].as_str().unwrap();
        let mut metadata = fixture["metadata"].clone();
        metadata[LOAN_EVENTS_KEY] = stage["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|key| fixture["events"][key.as_str().unwrap()].clone())
            .collect();
        let request: LoanCalculationRequest = serde_json::from_value(json!({
            "metadata": metadata, "balances": stage["balances"], "asOf": stage["asOf"]
        }))
        .unwrap();
        let result = calculate_loan(&request).unwrap();
        assert_eq!(
            result.current_balance,
            stage["expected"]["balance"].as_f64().unwrap(),
            "{id}: balance"
        );
        assert_eq!(
            result.interest_to_date,
            stage["expected"]["interestToDate"].as_f64().unwrap(),
            "{id}: interest"
        );
        assert_eq!(
            result.payoff_date.map(|d| d.to_string()),
            stage["expected"]["payoffDate"].as_str().map(str::to_owned),
            "{id}: payoff"
        );
        assert_eq!(result.residual_balance, 0.0, "{id}: residual principal");
        assert_eq!(result.residual_interest, 0.0, "{id}: residual interest");
        if let Some(rows) = stage["rows"].as_array() {
            for expected in rows {
                let date: NaiveDate = expected["date"].as_str().unwrap().parse().unwrap();
                let actual = result.rows.iter().find(|row| row.date == date).unwrap();
                for (key, value) in [
                    ("balance", actual.balance),
                    ("interest", actual.interest),
                    ("payment", actual.payment - actual.extra_payment),
                    ("extraPayment", actual.extra_payment),
                    ("balanceAdjustment", actual.balance_adjustment),
                ] {
                    assert_eq!(value, expected[key].as_f64().unwrap(), "{id} {date}: {key}");
                }
            }
        }
    }
    let mut creation: LoanCalculationRequest = serde_json::from_value(json!({
        "metadata": fixture["metadata"], "balances": [], "asOf":"2025-01-01"
    }))
    .unwrap();
    // The seed preview isn't the cent-rounded contractual payment.
    creation.metadata[LOAN_PROJECTION_KEY]["paymentAmount"] = json!(106.618546414);
    let result = recalculate_loan(&LoanRecalculationRequest {
        loan: creation,
        annual_rate: 12.0,
    })
    .unwrap();
    assert_eq!(
        result.payment_amount,
        fixture["metadata"][LOAN_PROJECTION_KEY]["paymentAmount"]
            .as_f64()
            .unwrap()
    );
}
