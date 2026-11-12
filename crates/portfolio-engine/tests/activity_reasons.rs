//! Activity reasons preserve machine-readable causes through the real pipeline.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]

mod support;

use support::{Pipeline, Scenario};
use wealthfolio_portfolio_engine::{ActivityReason, DiagnosticCode};

#[test]
fn activity_reasons_cover_rejections_and_warnings() {
    let scenario: Scenario = serde_yaml::from_str(r#"
id: ACTIVITY-REASONS
policy: { base_currency: USD, timezone: UTC, as_of: 2025-01-06 }
accounts:
  - { id: acc-1, currency: USD }
assets:
  - { id: aapl, quote_ccy: USD }
  - { id: short, quote_ccy: USD }
  - { id: empty, quote_ccy: USD }
  - { id: gbp-asset, quote_ccy: GBp }
activities:
  - { id: dep, account: acc-1, type: DEPOSIT, date: 2025-01-01T10:00:00Z, amount: 1000 }
  - { id: close-buy, account: acc-1, type: BUY, subtype: POSITION_CLOSE, date: 2025-01-02T10:00:00Z, asset: aapl, quantity: 1, unit_price: 10, amount: 10 }
  - { id: fx-buy, account: acc-1, type: BUY, date: 2025-01-02T11:00:00Z, asset: gbp-asset, quantity: 1, unit_price: 10, amount: 10 }
  - { id: buy, account: acc-1, type: BUY, date: 2025-01-03T10:00:00Z, asset: aapl, quantity: 10, unit_price: 10, amount: 100 }
  - { id: open-short, account: acc-1, type: SELL, subtype: POSITION_OPEN, date: 2025-01-03T11:00:00Z, asset: short, quantity: 1, unit_price: 10, amount: 10 }
  - { id: bad-short, account: acc-1, type: SELL, date: 2025-01-04T10:00:00Z, asset: short, quantity: 1, unit_price: 10, amount: 10 }
  - { id: oversell, account: acc-1, type: SELL, date: 2025-01-04T11:00:00Z, asset: aapl, quantity: 15, unit_price: 10, amount: 150 }
  - { id: zero-sell, account: acc-1, type: SELL, date: 2025-01-05T09:00:00Z, asset: aapl, quantity: 1, unit_price: 10, amount: 10 }
  - { id: empty-sell, account: acc-1, type: SELL, date: 2025-01-05T10:00:00Z, asset: empty, quantity: 1, unit_price: 10, amount: 10 }
  - { id: roc, account: acc-1, type: ADJUSTMENT, subtype: RETURN_OF_CAPITAL, date: 2025-01-05T11:00:00Z, asset: aapl, amount: 0 }
  - { id: fee, account: acc-1, type: FEE, date: 2025-01-06T10:00:00Z }
"#).unwrap();
    let pipeline = Pipeline::from_scenario(&scenario);
    let reported = |id: &str, code| {
        pipeline
            .bundle
            .diagnostics
            .iter()
            .chain(pipeline.ledger().diagnostics.iter())
            .find(|d| d.source == id && d.code == code)
            .unwrap_or_else(|| panic!("missing {id}: {:?}", pipeline.bundle.diagnostics))
    };
    let rejected = DiagnosticCode::ActivityRejected;
    assert_eq!(
        reported("close-buy", rejected).reason,
        Some(ActivityReason::CloseBuyWithoutShortPosition {
            asset: "aapl".into()
        })
    );
    let missing_fx = reported("fx-buy", rejected);
    assert_eq!(
        serde_json::to_value(&missing_fx.reason).unwrap(),
        serde_json::json!({
            "code": "MISSING_FX_RATE", "params": {"from":"USD", "to":"GBp", "date":"2025-01-02"}
        })
    );
    assert!(missing_fx.message.contains("failed to convert unit_price"));
    assert_eq!(
        reported("bad-short", rejected).reason,
        Some(ActivityReason::SellShortIntentRequired {
            asset: "short".into()
        })
    );
    assert_eq!(
        reported("roc", rejected).reason,
        Some(ActivityReason::ReturnOfCapitalAmountRequired)
    );
    assert_eq!(
        reported("empty-sell", DiagnosticCode::NoPositionToReduce).reason,
        Some(ActivityReason::SellWithoutPosition {
            asset: "empty".into()
        })
    );
    assert_eq!(
        reported("zero-sell", DiagnosticCode::NoPositionToReduce).reason,
        Some(ActivityReason::SellWithoutPosition {
            asset: "aapl".into()
        })
    );
    assert_eq!(
        reported("oversell", DiagnosticCode::InsufficientQuantity).reason,
        Some(ActivityReason::InsufficientQuantity {
            action: "SELL".into(),
            asset: "aapl".into(),
            requested: "15".into(),
            held: "10".into(),
            excess: "5".into(),
        })
    );
    assert_eq!(
        reported("fee", DiagnosticCode::MissingFinalCash).reason,
        Some(ActivityReason::MissingFinalCash)
    );
}

#[test]
fn conversion_reasons_are_kept_on_both_rows() {
    let scenario: Scenario =
        serde_yaml::from_str(include_str!("fixtures/scenarios/edge/EDGE-CONV-01.yaml")).unwrap();
    let pipeline = Pipeline::from_scenario(&scenario);
    for (ids, expected) in [
        (
            ["over-out", "over-in"],
            ActivityReason::ConversionInsufficientHoldings {
                asset: "fund-a".into(),
                requested: "12".into(),
                held: "10".into(),
            },
        ),
        (
            ["ccy-out", "ccy-in"],
            ActivityReason::ConversionCurrencyMismatch {
                from_asset: "fund-a".into(),
                from_currency: "USD".into(),
                to_asset: "fund-eur".into(),
                to_currency: "EUR".into(),
            },
        ),
    ] {
        for id in ids {
            let diagnostic = pipeline
                .bundle
                .diagnostics
                .iter()
                .find(|d| d.source == id)
                .unwrap();
            assert_eq!(diagnostic.code, DiagnosticCode::ActivityRejected);
            assert_eq!(diagnostic.reason.as_ref(), Some(&expected));
        }
    }
}

#[test]
fn an_out_of_range_conversion_is_not_reported_as_missing_fx() {
    let scenario: Scenario = serde_yaml::from_str(r#"
id: CONVERSION-RANGE
policy: { base_currency: USD, timezone: UTC, as_of: 2025-01-03 }
accounts:
  - { id: acc-1, currency: USD }
assets:
  - { id: eur-asset, quote_ccy: EUR }
activities:
  - { id: buy, account: acc-1, type: BUY, date: 2025-01-03T10:00:00Z, asset: eur-asset, currency: USD, quantity: 1, unit_price: "100000000000000000000", amount: "100000000000000000000" }
fx_rates:
  - { from: EUR, to: USD, day: 2025-01-03, rate: 0.5 }
"#).unwrap();
    let pipeline = Pipeline::from_scenario(&scenario);
    let rejected = pipeline
        .bundle
        .diagnostics
        .iter()
        .find(|d| d.source == "buy" && d.code == DiagnosticCode::ActivityRejected)
        .unwrap();
    assert!(rejected.message.contains("failed to convert unit_price"));
    assert_eq!(rejected.reason, None);
    assert!(pipeline
        .bundle
        .final_state
        .accounts
        .values()
        .all(|account| account.cash.is_empty()));
}
