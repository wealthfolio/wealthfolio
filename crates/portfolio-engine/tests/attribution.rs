//! Attribution's realized P&L counts every disposal that realizes, whatever
//! closed it: a trade, an option's expiry, or units a transfer delivered into
//! a short. A transfer out moves lots at their cost and realizes nothing.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]

mod support;

use std::str::FromStr;

use rust_decimal::Decimal;
use serde_json::Value;
use support::*;

/// An account's all-time attribution in a fixture's measured output.
fn all_time(id: &str, account: &str) -> Value {
    let scenario = load_all_scenarios()
        .into_iter()
        .find(|s| s.id == id)
        .unwrap_or_else(|| panic!("no fixture {id}"));
    let pipeline = Pipeline::from_scenario(&scenario);
    let body = capture_body(&pipeline, &all_windows(&scenario));
    body["accounts"][account]["performance"]["all_time"].clone()
}

fn number(value: &Value) -> Decimal {
    Decimal::from_str(
        value
            .as_str()
            .unwrap_or_else(|| panic!("not a number: {value}")),
    )
    .unwrap()
}

fn realized(id: &str, account: &str) -> Decimal {
    number(&all_time(id, account)["attribution"]["realized_pnl"])
}

#[test]
fn a_short_covered_by_arriving_units_is_realized() {
    // EDGE-TXF-10: 5 units arrive by an external transfer at 12 and cover a
    // short of 3 sold at 10: realized -6.
    assert_eq!(realized("EDGE-TXF-10", "acc-1"), Decimal::from(-6));
    // NOM-TXF-04: acc-a's lots cover acc-b's short of 4 sold at 100 with the
    // cost they carry, 402: realized -2.
    assert_eq!(realized("NOM-TXF-04", "acc-b"), Decimal::from(-2));
}

#[test]
fn an_option_closed_at_expiry_is_realized() {
    // NOM-OPT-01: the trades realize 150 before charges; exp-1 closes the
    // last short contract (basis -299, its 1 opening fee included): 300 more.
    let all_time = all_time("NOM-OPT-01", "acc-1");
    assert_eq!(
        number(&all_time["attribution"]["realized_pnl"]),
        Decimal::from(450)
    );
    // Cash 5000 -> 5445 with nothing held: the whole gain, after 5 of fees.
    assert_eq!(number(&all_time["summary"]["amount"]), Decimal::from(445));
}

/// What came in, less what went out, plus the P&L the portfolio's all-time
/// attribution reports, against what the accounts hold at the end.
fn explained_and_held(scenario: &Scenario) -> (Decimal, Decimal) {
    let pipeline = Pipeline::from_scenario(scenario);
    let body = capture_body(&pipeline, &all_windows(scenario));
    let held: Decimal = body["accounts"]
        .as_object()
        .unwrap()
        .values()
        .filter_map(|a| a["valuations"].as_array().and_then(|d| d.last()).cloned())
        .map(|day| number(&day["total_value_base"]))
        .sum();
    let all_time = &body["portfolio"]["all_time"];
    let attribution = &all_time["attribution"];
    let explained = number(&attribution["contributions"]) - number(&attribution["distributions"])
        + number(&all_time["summary"]["amount"]);
    (explained, held)
}

#[test]
fn the_portfolio_attribution_explains_the_whole_gain() {
    // NOM-TXF-02 moves lots bought with a fee; NOM-TXF-04 and EDGE-TXF-15
    // cover a short with such lots: the fee counts once, as a fee.
    // EDGE-CB-09 covers a LIFO account's short with delivered lots.
    for id in [
        "NOM-OPT-01",
        "EDGE-TXF-10",
        "EDGE-TXF-19",
        "EDGE-POS-06",
        "EDGE-CB-04",
        "NOM-TXF-02",
        "NOM-TXF-04",
        "EDGE-TXF-15",
        "EDGE-CB-09",
    ] {
        let scenario = load_all_scenarios()
            .into_iter()
            .find(|s| s.id == id)
            .unwrap();
        let (explained, held) = explained_and_held(&scenario);
        assert_eq!(explained, held, "{id}");
    }
}

#[test]
fn a_fee_carried_across_a_transfer_counts_once() {
    // acc-a buys 10 at 100 with a fee of 5 and sends them to acc-b, which
    // sells 4 at 110: the gain is 10 x 10 - 5 = 95, of which the fee's 2 in
    // the sold lots and 3 in the held ones are fees, not lower P&L.
    let scenario: Scenario = serde_yaml::from_str(
        r#"
id: INLINE-CARRIED-FEE
policy: { base_currency: USD, timezone: UTC, as_of: 2025-01-10 }
accounts:
  - { id: acc-a, currency: USD }
  - { id: acc-b, currency: USD }
assets:
  - { id: aapl, quote_ccy: USD }
activities:
  - { id: dep-1, account: acc-a, type: DEPOSIT, date: 2025-01-02T10:00:00Z, amount: 2000 }
  - { id: buy-1, account: acc-a, type: BUY, date: 2025-01-03T10:00:00Z, asset: aapl, quantity: 10, unit_price: 100, amount: 1005, fee: 5 }
  - { id: out-1, account: acc-a, type: TRANSFER_OUT, date: 2025-01-06T10:00:00Z, asset: aapl, quantity: 10, unit_price: 105, source_group_id: g1 }
  - { id: in-1, account: acc-b, type: TRANSFER_IN, date: 2025-01-06T11:00:00Z, asset: aapl, quantity: 10, unit_price: 105, source_group_id: g1 }
  - { id: sell-1, account: acc-b, type: SELL, date: 2025-01-08T10:00:00Z, asset: aapl, quantity: 4, unit_price: 110, amount: 440, fee: 0 }
quotes:
  - { asset: aapl, day: 2025-01-03, close: 100 }
  - { asset: aapl, day: 2025-01-06, close: 105 }
  - { asset: aapl, day: 2025-01-08, close: 110 }
  - { asset: aapl, day: 2025-01-10, close: 110 }
"#,
    )
    .expect("scenario");
    let (explained, held) = explained_and_held(&scenario);
    assert_eq!(held, Decimal::from(2095));
    assert_eq!(explained, held);
}

#[test]
fn a_transfer_out_realizes_nothing() {
    // NOM-TXF-04: acc-a sends its lot (bought with a fee of 5) at its cost.
    assert_eq!(realized("NOM-TXF-04", "acc-a"), Decimal::ZERO);
}
