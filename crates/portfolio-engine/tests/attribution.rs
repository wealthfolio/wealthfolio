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

#[test]
fn the_portfolio_attribution_explains_the_whole_gain() {
    // What came in, less what went out, plus the P&L attribution reports is
    // what the accounts hold at the end, where every lot that realized was
    // bought without charges carried across a transfer (rules §8).
    for id in [
        "NOM-OPT-01",
        "EDGE-TXF-10",
        "EDGE-TXF-19",
        "EDGE-POS-06",
        "EDGE-CB-04",
    ] {
        let scenario = load_all_scenarios()
            .into_iter()
            .find(|s| s.id == id)
            .unwrap();
        let pipeline = Pipeline::from_scenario(&scenario);
        let body = capture_body(&pipeline, &all_windows(&scenario));
        let held: Decimal = body["accounts"]
            .as_object()
            .unwrap()
            .values()
            .filter_map(|a| a["valuations"].as_array().and_then(|d| d.last()).cloned())
            .map(|day| number(&day["total_value_base"]))
            .sum();
        let all_time = &body["portfolio"]["all_time"];
        let attribution = &all_time["attribution"];
        let explained = number(&attribution["contributions"])
            - number(&attribution["distributions"])
            + number(&all_time["summary"]["amount"]);
        assert_eq!(explained, held, "{id}");
    }
}

#[test]
fn a_transfer_out_realizes_nothing() {
    // NOM-TXF-04: acc-a sends its lot (bought with a fee of 5) at its cost.
    assert_eq!(realized("NOM-TXF-04", "acc-a"), Decimal::ZERO);
}
