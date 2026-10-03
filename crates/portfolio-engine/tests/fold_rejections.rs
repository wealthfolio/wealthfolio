//! A rejected activity changes no state: not its account's cash, and not
//! the lots waiting in the transfer cache.

mod support;

use chrono::NaiveDate;
use rust_decimal::Decimal;
use support::*;
use wealthfolio_portfolio_engine::model::*;
use wealthfolio_portfolio_engine::project;

/// A checkpoint can hold short lots of an asset that no longer allows them
/// (one made before the asset was reclassified). The incoming transfer that
/// finds only those lots books nothing, so it is rejected whole: its fee is
/// not taken from cash, and the lots stay cached.
#[test]
fn an_incoming_transfer_that_books_no_lot_is_rejected_whole() {
    let scenario: Scenario = serde_yaml::from_str(
        r#"
id: REJECT-TXF-01
policy: { base_currency: USD, timezone: UTC, as_of: 2025-01-06 }
accounts:
  - { id: acc-a, currency: USD }
  - { id: acc-b, currency: USD }
assets:
  - { id: bond, quote_ccy: USD, instrument_type: BOND }
activities:
  - { id: dep-b, account: acc-b, type: DEPOSIT, date: 2025-01-01T10:00:00Z, amount: 100 }
  - { id: buy, account: acc-a, type: BUY, date: 2025-01-01T11:00:00Z, asset: bond, quantity: 1, unit_price: 50, amount: 50 }
  - { id: out, account: acc-a, type: TRANSFER_OUT, date: 2025-01-02T10:00:00Z, asset: bond, quantity: 1, source_group_id: g }
  - { id: tin, account: acc-b, type: TRANSFER_IN, date: 2025-01-04T10:00:00Z, asset: bond, quantity: 1, fee: 5, source_group_id: g }
"#,
    )
    .expect("scenario");
    let pipeline = Pipeline::from_scenario(&scenario);
    let fx = pipeline.fx();
    let day = |d| NaiveDate::from_ymd_opt(2025, 1, d).expect("date");
    let range = pipeline.range();

    let mut checkpoint = project(
        pipeline.ledger(),
        pipeline.facts(),
        &fx,
        None,
        DateRange {
            start: range.start,
            end: day(3),
        },
    )
    .expect("first chunk")
    .final_state;
    for lot in &mut checkpoint
        .transfer_cache
        .get_mut("g")
        .expect("lots in flight")
        .lots
    {
        lot.quantity = -lot.quantity;
        lot.original_quantity = -lot.original_quantity;
    }
    let bundle = project(
        pipeline.ledger(),
        pipeline.facts(),
        &fx,
        Some(checkpoint),
        DateRange {
            start: day(4),
            end: range.end,
        },
    )
    .expect("second chunk");

    assert!(bundle
        .rejected_activities()
        .contains(&ActivityId::new("tin")));
    let received = &bundle.final_state.accounts[&AccountId::new("acc-b")];
    assert_eq!(
        received.cash[&Currency::parse("USD").expect("currency")],
        Decimal::from(100),
        "a rejected transfer pays no fee"
    );
    assert!(received.positions.values().all(|p| p.quantity.is_zero()));
    assert!(
        bundle.final_state.transfer_cache.contains_key("g"),
        "the lots stay cached"
    );
}
