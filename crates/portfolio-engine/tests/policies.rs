//! The kernel's rules for ambiguous data (architecture §4.5), each decided
//! one way and reported so the health center can show it: directions of a
//! pair that disagree, a reduction beyond the position, and a posted row
//! without a final amount.

mod support;

use rust_decimal::Decimal;
use support::*;
use wealthfolio_portfolio_engine::model::*;
use wealthfolio_portfolio_engine::{fx_conflicts, normalize_fx_rates, DiagnosticCode};

fn scenario(yaml: &str) -> Pipeline {
    let scenario: Scenario = serde_yaml::from_str(yaml).expect("scenario");
    Pipeline::run(scenario.raw_facts()).expect("pipeline")
}

fn rate(from: &str, to: &str, day: &str, rate: Decimal) -> RawFxRate {
    RawFxRate {
        from: from.to_string(),
        to: to.to_string(),
        day: day.parse().unwrap(),
        rate,
        source: "MANUAL".to_string(),
    }
}

#[test]
fn directions_that_disagree_each_convert_at_their_own_rate_and_are_reported() {
    let pipeline = scenario(
        r#"
id: POLICY-FX
policy: { base_currency: USD, timezone: UTC, as_of: 2025-01-03 }
accounts:
  - { id: acc-1, currency: CAD }
activities:
  - { id: dep-1, account: acc-1, type: DEPOSIT, date: 2025-01-02T10:00:00Z, amount: 1000 }
fx_rates:
  - { from: CAD, to: USD, day: 2025-01-02, rate: 0.70 }
  - { from: USD, to: CAD, day: 2025-01-02, rate: 1.30 }
  - { from: USD, to: CAD, day: 2025-01-03, rate: 1.25 }
"#,
    );
    let fx = pipeline.fx();
    let day = "2025-01-02".parse().unwrap();
    assert_eq!(fx.rate("CAD", "USD", day), Some(Decimal::new(70, 2)));
    assert_eq!(fx.rate("USD", "CAD", day), Some(Decimal::new(130, 2)));

    let reported: Vec<_> = pipeline
        .normalize_diagnostics()
        .iter()
        .filter(|d| d.code == DiagnosticCode::ConflictingFxRates)
        .collect();
    assert_eq!(reported.len(), 1, "{reported:?}");
    assert_eq!(reported[0].source, "fx CAD/USD");
}

#[test]
fn directions_within_the_tolerance_are_no_conflict() {
    let mut diagnostics = Vec::new();
    let observations = normalize_fx_rates(
        vec![
            // 1.10 x 0.9050 = 0.99550: within 1%.
            rate("EUR", "USD", "2025-01-02", Decimal::new(110, 2)),
            rate("USD", "EUR", "2025-01-02", Decimal::new(9050, 4)),
            // 1.10 x 0.8000 = 0.88: a conflict.
            rate("EUR", "USD", "2025-01-03", Decimal::new(110, 2)),
            rate("USD", "EUR", "2025-01-03", Decimal::new(80, 2)),
        ],
        &mut diagnostics,
    );
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let conflicts = fx_conflicts(&observations);
    assert_eq!(conflicts.len(), 1, "{conflicts:?}");
    assert_eq!(conflicts[0].from.as_str(), "EUR");
    assert_eq!(conflicts[0].to.as_str(), "USD");
    assert_eq!(conflicts[0].days, 1);
    assert_eq!(conflicts[0].first_day.to_string(), "2025-01-03");
}

#[test]
fn a_sale_beyond_the_position_disposes_what_is_held_and_names_the_activity() {
    let pipeline = scenario(
        r#"
id: POLICY-OVERSELL
policy: { base_currency: USD, timezone: UTC, as_of: 2025-01-06 }
accounts:
  - { id: acc-1, currency: USD }
assets:
  - { id: aapl, quote_ccy: USD }
activities:
  - { id: dep-1, account: acc-1, type: DEPOSIT, date: 2025-01-02T10:00:00Z, amount: 1000 }
  - { id: buy-1, account: acc-1, type: BUY, date: 2025-01-03T10:00:00Z, asset: aapl, quantity: 10, unit_price: 50, amount: 500 }
  - { id: sell-1, account: acc-1, type: SELL, date: 2025-01-06T10:00:00Z, asset: aapl, quantity: 15, unit_price: 60, amount: 900 }
quotes:
  - { asset: aapl, day: 2025-01-03, close: 50 }
  - { asset: aapl, day: 2025-01-06, close: 60 }
"#,
    );
    let reported: Vec<_> = pipeline
        .bundle
        .diagnostics
        .iter()
        .filter(|d| d.code == DiagnosticCode::InsufficientQuantity)
        .collect();
    assert_eq!(reported.len(), 1, "{reported:?}");
    assert_eq!(reported[0].source, "sell-1");

    // The ten held units are disposed with their share of the proceeds.
    let disposal = &pipeline.bundle.disposals[0];
    assert_eq!(disposal.quantity, Decimal::from(10));
    assert_eq!(disposal.proceeds, Decimal::from(600));
}

#[test]
fn a_posted_row_without_a_final_amount_books_no_cash_and_names_the_activity() {
    let pipeline = scenario(
        r#"
id: POLICY-NO-AMOUNT
policy: { base_currency: USD, timezone: UTC, as_of: 2025-01-03 }
accounts:
  - { id: acc-1, currency: USD }
activities:
  - { id: dep-1, account: acc-1, type: DEPOSIT, date: 2025-01-02T10:00:00Z, amount: 1000 }
  - { id: fee-1, account: acc-1, type: FEE, date: 2025-01-03T10:00:00Z }
"#,
    );
    let reported: Vec<_> = pipeline
        .ledger()
        .diagnostics
        .iter()
        .filter(|d| d.code == DiagnosticCode::MissingFinalCash)
        .collect();
    assert_eq!(reported.len(), 1, "{reported:?}");
    assert_eq!(reported[0].source, "fee-1");
    let last = pipeline.series[&AccountId::new("acc-1")]
        .days
        .last()
        .unwrap()
        .clone();
    assert_eq!(last.cash_balance, Decimal::from(1000));
}
