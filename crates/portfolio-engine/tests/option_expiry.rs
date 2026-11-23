//! An option expiry books only against an option contract: one that names a
//! stock must never dispose of its shares.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]

mod support;

use rust_decimal::Decimal;
use support::{Pipeline, Scenario};
use wealthfolio_portfolio_engine::model::{AccountId, AssetId};
use wealthfolio_portfolio_engine::{ActivityReason, DiagnosticCode};

fn quantity(pipeline: &Pipeline, asset: &str) -> Option<Decimal> {
    pipeline.bundle.final_state.accounts[&AccountId::new("acc-1")]
        .positions
        .get(&AssetId::new(asset))
        .map(|position| position.quantity)
}

#[test]
fn an_expiry_naming_a_stock_is_rejected_and_keeps_the_shares() {
    // A broker sent the expiry with only the underlying ticker: it names the
    // stock the account also holds, with the contract count as quantity.
    let scenario: Scenario = serde_yaml::from_str(
        r#"
id: OPTION-EXPIRY-STOCK
policy: { base_currency: USD, timezone: UTC, as_of: 2025-01-20 }
accounts:
  - { id: acc-1, currency: USD }
assets:
  - { id: btg, quote_ccy: USD, instrument_type: EQUITY }
  - { id: btg-call, quote_ccy: USD, instrument_type: OPTION }
  - { id: legacy, quote_ccy: USD, instrument_type: NONE }
activities:
  - { id: dep, account: acc-1, type: DEPOSIT, date: 2025-01-02T10:00:00Z, amount: 10000 }
  - { id: buy-stock, account: acc-1, type: BUY, date: 2025-01-03T10:00:00Z, asset: btg, quantity: 100, unit_price: 4, amount: 400 }
  - { id: buy-call, account: acc-1, type: BUY, date: 2025-01-03T11:00:00Z, asset: btg-call, quantity: 99, unit_price: 0.03, amount: 297 }
  - { id: buy-legacy, account: acc-1, type: BUY, date: 2025-01-03T12:00:00Z, asset: legacy, quantity: 2, unit_price: 1, amount: 2 }
  - { id: exp-stock, account: acc-1, type: ADJUSTMENT, subtype: OPTION_EXPIRY, date: 2025-01-17T21:30:00Z, asset: btg, quantity: 99 }
  - { id: exp-call, account: acc-1, type: ADJUSTMENT, subtype: OPTION_EXPIRY, date: 2025-01-17T21:31:00Z, asset: btg-call, quantity: 99 }
  - { id: exp-legacy, account: acc-1, type: ADJUSTMENT, subtype: OPTION_EXPIRY, date: 2025-01-17T21:32:00Z, asset: legacy, quantity: 2 }
"#,
    )
    .unwrap();
    let pipeline = Pipeline::from_scenario(&scenario);

    let rejection = pipeline
        .bundle
        .diagnostics
        .iter()
        .find(|d| d.source == "exp-stock")
        .unwrap_or_else(|| panic!("exp-stock not reported: {:?}", pipeline.bundle.diagnostics));
    assert_eq!(rejection.code, DiagnosticCode::ActivityRejected);
    assert_eq!(
        rejection.reason,
        Some(ActivityReason::OptionExpiryNotOption {
            asset: "btg".into()
        })
    );
    assert_eq!(quantity(&pipeline, "btg"), Some(Decimal::from(100)));

    // The contract and an untyped (legacy) asset still expire.
    assert!(quantity(&pipeline, "btg-call").is_none_or(|q| q.is_zero()));
    assert!(quantity(&pipeline, "legacy").is_none_or(|q| q.is_zero()));
    for id in ["exp-call", "exp-legacy"] {
        assert!(
            !pipeline.bundle.diagnostics.iter().any(|d| d.source == id),
            "{id} reported: {:?}",
            pipeline.bundle.diagnostics
        );
    }
}
