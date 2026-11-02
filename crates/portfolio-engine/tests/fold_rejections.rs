//! A rejected activity changes no state: not its account's cash, and not
//! the lots waiting in the transfer cache.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]

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
/// Rules R7.5: a conversion that fails after its leaving lots are relieved is
/// rejected whole. g-ratio fails on its ratio of units, right after the
/// relief; g-cost fails on the arriving position's average cost, after that
/// position was opened. Both rows of each are reported, the leaving lots are
/// back as they were, nothing opens in the arriving asset and no disposal or
/// closure is recorded. (A conversion refused before relief, such as one of
/// fewer units than a position holds, is in EDGE-CONV-01.)
#[test]
fn a_conversion_that_fails_after_relief_is_rejected_whole() {
    let scenario: Scenario = serde_yaml::from_str(
        r#"
id: REJECT-CONV-01
policy: { base_currency: USD, timezone: UTC, as_of: 2025-01-06 }
accounts:
  - { id: acc-a, currency: USD }
assets:
  - { id: fund-a, quote_ccy: USD }
  - { id: fund-b, quote_ccy: USD }
  - { id: fund-c, quote_ccy: USD }
  - { id: fund-d, quote_ccy: USD }
activities:
  - { id: dep, account: acc-a, type: DEPOSIT, date: 2025-01-01T10:00:00Z, amount: 1000 }
  - { id: buy-a, account: acc-a, type: BUY, date: 2025-01-01T11:00:00Z, asset: fund-a, quantity: 10, unit_price: 100, amount: 1000 }
  - { id: buy-c, account: acc-a, type: BUY, date: 2025-01-01T12:00:00Z, asset: fund-c, quantity: 1, unit_price: 0.000001, fee: 10000000000000, amount: 0.000001 }
  - { id: ratio-out, account: acc-a, type: ADJUSTMENT, subtype: CONVERSION_OUT, date: 2025-01-03T10:00:00Z, asset: fund-a, quantity: 0.0001, source_group_id: g-ratio }
  - { id: ratio-in, account: acc-a, type: ADJUSTMENT, subtype: CONVERSION_IN, date: 2025-01-03T10:01:00Z, asset: fund-b, quantity: 100000000000000000, source_group_id: g-ratio }
  - { id: cost-out, account: acc-a, type: ADJUSTMENT, subtype: CONVERSION_OUT, date: 2025-01-04T10:00:00Z, asset: fund-c, quantity: 1, source_group_id: g-cost }
  - { id: cost-in, account: acc-a, type: ADJUSTMENT, subtype: CONVERSION_IN, date: 2025-01-04T10:01:00Z, asset: fund-d, quantity: 0.00000001, source_group_id: g-cost }
"#,
    )
    .expect("scenario");
    let pipeline = Pipeline::from_scenario(&scenario);
    let fx = pipeline.fx();
    let range = pipeline.range();
    let bundle = project(pipeline.ledger(), pipeline.facts(), &fx, None, range).expect("project");

    let rejected = bundle.rejected_activities();
    for id in ["ratio-out", "ratio-in", "cost-out", "cost-in"] {
        assert!(
            rejected.contains(&ActivityId::new(id)),
            "{id}: {rejected:?}"
        );
    }
    // Both fail after the relief, so the savepoint undid it.
    for (id, failure) in [
        ("ratio-out", "conversion ratio"),
        ("cost-out", "average cost"),
    ] {
        assert!(
            bundle
                .diagnostics
                .iter()
                .any(|d| d.source == id && d.message.contains(failure)),
            "{id}: {:?}",
            bundle.diagnostics
        );
    }

    let account = &bundle.final_state.accounts[&AccountId::new("acc-a")];
    for (asset, quantity) in [("fund-a", Decimal::from(10)), ("fund-c", Decimal::ONE)] {
        let leaving = &account.positions[&AssetId::new(asset)];
        assert_eq!(leaving.quantity, quantity, "{asset}");
        assert_eq!(leaving.lots.len(), 1, "{asset}");
        assert_eq!(leaving.lots[0].quantity, quantity, "{asset}");
    }
    for asset in ["fund-b", "fund-d"] {
        assert!(
            account
                .positions
                .get(&AssetId::new(asset))
                .is_none_or(|position| position.quantity.is_zero() && position.lots.is_empty()),
            "{asset}"
        );
    }
    assert!(bundle.disposals.is_empty(), "{:?}", bundle.disposals);
    assert!(bundle.closures.is_empty(), "{:?}", bundle.closures);
}
