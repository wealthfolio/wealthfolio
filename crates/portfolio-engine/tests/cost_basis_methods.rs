//! The lots each cost basis method relieves (rules R7.2), asserted on the
//! fixtures' hand-worked figures so a method's order is pinned beyond its
//! golden.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]

mod support;

use std::str::FromStr;

use rust_decimal::Decimal;
use support::*;
use wealthfolio_portfolio_engine::model::*;

fn d(value: &str) -> Decimal {
    Decimal::from_str(value).unwrap()
}

fn fixture(id: &str) -> Pipeline {
    let scenario = load_all_scenarios()
        .into_iter()
        .find(|s| s.id == id)
        .unwrap_or_else(|| panic!("no fixture {id}"));
    Pipeline::from_scenario(&scenario)
}

fn inline(yaml: &str) -> Pipeline {
    let scenario: Scenario = serde_yaml::from_str(yaml).expect("scenario");
    Pipeline::from_scenario(&scenario)
}

/// (lot, effective units, cost) of each disposal `event` made, in order.
fn relieved(pipeline: &Pipeline, event: &str) -> Vec<(String, Decimal, Decimal)> {
    pipeline
        .bundle
        .disposals
        .iter()
        .filter(|disposal| disposal.event.as_str() == event)
        .map(|disposal| {
            (
                disposal.lot_id.clone(),
                disposal.quantity.abs(),
                disposal.cost_basis.abs().round_dp(8),
            )
        })
        .collect()
}

fn position<'a>(pipeline: &'a Pipeline, account: &str, asset: &str) -> &'a Position {
    &pipeline.bundle.final_state.accounts[&AccountId::new(account)].positions[&AssetId::new(asset)]
}

/// The (effective units, cost) of each lot an account still holds, smallest
/// cost first, then fewest units.
fn lots_held(pipeline: &Pipeline, account: &str, asset: &str) -> Vec<(Decimal, Decimal)> {
    let mut lots: Vec<_> = position(pipeline, account, asset)
        .lots
        .iter()
        .map(|lot| (lot.effective_quantity(), lot.cost_basis.round_dp(8)))
        .collect();
    lots.sort_by(|a, b| a.1.cmp(&b.1).then(a.0.cmp(&b.0)));
    lots
}

fn lot(id: &str, units: &str, cost: &str) -> (String, Decimal, Decimal) {
    (id.to_string(), d(units), d(cost))
}

#[test]
fn lifo_relieves_the_newest_lots_first() {
    let pipeline = fixture("NOM-CB-02");
    assert_eq!(
        relieved(&pipeline, "sell-1"),
        vec![lot("buy-2", "5", "101")]
    );
    assert_eq!(
        relieved(&pipeline, "sell-2"),
        vec![lot("buy-3", "10", "302")]
    );

    let held = position(&pipeline, "acc-1", "aapl");
    assert_eq!(held.quantity, d("15"));
    assert_eq!(held.total_cost_basis.round_dp(8), d("203"));
}

#[test]
fn hifo_relieves_the_dearest_lots_first() {
    let pipeline = fixture("NOM-CB-03");
    assert_eq!(
        relieved(&pipeline, "sell-1"),
        vec![lot("buy-2", "5", "1000")]
    );
    assert_eq!(
        relieved(&pipeline, "sell-2"),
        vec![lot("buy-2", "5", "1000"), lot("buy-3", "5", "750")]
    );

    let held = position(&pipeline, "acc-1", "aapl");
    assert_eq!(held.quantity, d("15"));
    assert_eq!(held.total_cost_basis.round_dp(8), d("1750"));
}

#[test]
fn hifo_ranks_by_cost_per_unit_with_charges_and_breaks_ties_oldest_first() {
    let pipeline = fixture("EDGE-CB-06");
    assert_eq!(
        relieved(&pipeline, "sell-1"),
        vec![lot("buy-1", "5", "500"), lot("buy-2", "10", "1005")],
        "buy-2 (100.5 per unit) first, then buy-1 before buy-3 at 100"
    );
    assert_eq!(
        lots_held(&pipeline, "acc-1", "aapl"),
        vec![(d("5"), d("500")), (d("10"), d("1000"))]
    );
}

#[test]
fn hifo_ranks_by_cost_per_unit_after_splits() {
    let pipeline = fixture("EDGE-CB-07");
    assert_eq!(
        relieved(&pipeline, "sell-1"),
        vec![lot("buy-2", "5", "300")]
    );

    let held = position(&pipeline, "acc-1", "aapl");
    assert_eq!(held.quantity, d("25"));
    assert_eq!(held.total_cost_basis.round_dp(8), d("1300"));
}

#[test]
fn lifo_orders_a_transferred_lot_by_its_acquisition() {
    let pipeline = fixture("EDGE-CB-08");
    assert_eq!(
        relieved(&pipeline, "sell-1"),
        vec![lot("buy-b", "5", "1000")]
    );
    assert_eq!(
        lots_held(&pipeline, "acc-b", "aapl"),
        vec![(d("5"), d("1000")), (d("10"), d("1000"))]
    );
}

#[test]
fn delivered_lots_cover_a_short_in_the_receivers_method_order() {
    // EDGE-CB-09 delivers lots bought at 100, 200 and 150 into acc-b's short
    // of 5: the lot its method takes first covers it, the others open.
    for (method, held) in [
        ("LIFO", [("5", "500"), ("5", "1000")]),
        ("HIFO", [("5", "500"), ("5", "750")]),
        ("FIFO", [("5", "750"), ("5", "1000")]),
    ] {
        let mut scenario = load_all_scenarios()
            .into_iter()
            .find(|s| s.id == "EDGE-CB-09")
            .unwrap();
        for account in &mut scenario.accounts {
            if account.id == "acc-b" {
                account.cost_basis_method = Some(method.to_string());
            }
        }
        let pipeline = Pipeline::from_scenario(&scenario);
        let expected: Vec<_> = held.iter().map(|(u, c)| (d(u), d(c))).collect();
        assert_eq!(lots_held(&pipeline, "acc-b", "aapl"), expected, "{method}");
    }
}

const SHORTS: &str = r#"
id: INLINE-CB-SHORT
policy: { base_currency: USD, timezone: UTC, as_of: 2025-01-10 }
accounts:
  - { id: acc-1, currency: USD, cost_basis_method: METHOD }
assets:
  - { id: aapl, quote_ccy: USD }
activities:
  - { id: dep-1, account: acc-1, type: DEPOSIT, date: 2025-01-02T10:00:00Z, amount: 1000 }
  - { id: short-1, account: acc-1, type: SELL, subtype: POSITION_OPEN, date: 2025-01-03T10:00:00Z, asset: aapl, quantity: 5, unit_price: 100, amount: 500, fee: 0 }
  - { id: short-2, account: acc-1, type: SELL, subtype: POSITION_OPEN, date: 2025-01-05T10:00:00Z, asset: aapl, quantity: 5, unit_price: 150, amount: 750, fee: 0 }
  - { id: short-3, account: acc-1, type: SELL, subtype: POSITION_OPEN, date: 2025-01-06T10:00:00Z, asset: aapl, quantity: 5, unit_price: 120, amount: 600, fee: 0 }
  - { id: cover-1, account: acc-1, type: BUY, subtype: POSITION_CLOSE, date: 2025-01-08T10:00:00Z, asset: aapl, quantity: 5, unit_price: 90, amount: 450, fee: 0 }
quotes:
  - { asset: aapl, day: 2025-01-03, close: 100 }
  - { asset: aapl, day: 2025-01-05, close: 150 }
  - { asset: aapl, day: 2025-01-06, close: 120 }
  - { asset: aapl, day: 2025-01-08, close: 90 }
"#;

#[test]
fn a_short_is_covered_in_the_method_order() {
    // Shorts sold at 100, 150 and 120, oldest first. LIFO closes the newest,
    // HIFO the one with the highest cost per unit, as for longs (sold at
    // 150), FIFO the oldest.
    for (method, closed) in [
        ("LIFO", "short-3"),
        ("HIFO", "short-2"),
        ("FIFO", "short-1"),
    ] {
        let pipeline = inline(&SHORTS.replace("METHOD", method));
        let lots: Vec<_> = relieved(&pipeline, "cover-1")
            .into_iter()
            .map(|l| l.0)
            .collect();
        assert_eq!(lots, vec![closed.to_string()], "{method}");
    }
}

const SAME_INSTANT: &str = r#"
id: INLINE-CB-TIE
policy: { base_currency: USD, timezone: UTC, as_of: 2025-01-10 }
accounts:
  - { id: acc-1, currency: USD, cost_basis_method: METHOD }
assets:
  - { id: aapl, quote_ccy: USD }
activities:
  - { id: dep-1, account: acc-1, type: DEPOSIT, date: 2025-01-02T10:00:00Z, amount: 3000 }
  - { id: buy-1, account: acc-1, type: BUY, date: 2025-01-03T10:00:00Z, asset: aapl, quantity: 10, unit_price: 100, amount: 1000, fee: 0 }
  - { id: buy-2, account: acc-1, type: BUY, date: 2025-01-03T10:00:00Z, asset: aapl, quantity: 10, unit_price: 100, amount: 1000, fee: 0 }
  - { id: sell-1, account: acc-1, type: SELL, date: 2025-01-08T10:00:00Z, asset: aapl, quantity: 5, unit_price: 120, amount: 600, fee: 0 }
quotes:
  - { asset: aapl, day: 2025-01-03, close: 100 }
  - { asset: aapl, day: 2025-01-08, close: 120 }
"#;

#[test]
fn lots_tied_on_their_ranking_go_in_the_order_they_opened_or_its_reverse() {
    // Bought at the same instant and price: HIFO takes them as FIFO does,
    // LIFO in reverse.
    let first = |method: &str| {
        let pipeline = inline(&SAME_INSTANT.replace("METHOD", method));
        relieved(&pipeline, "sell-1")[0].0.clone()
    };
    let fifo = first("FIFO");
    assert_eq!(first("HIFO"), fifo);
    assert_ne!(first("LIFO"), fifo);
}
