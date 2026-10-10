//! Same-account exchanges must remain atomic, neutral and precisely valued.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]
mod support;
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use support::*;
use wealthfolio_portfolio_engine::model::*;

fn scenario() -> Scenario {
    load_all_scenarios()
        .into_iter()
        .find(|s| s.id == "NOM-FX-EXCHANGE")
        .unwrap()
}

fn output(raw: RawFacts) -> serde_json::Value {
    capture_body(&Pipeline::run(raw).unwrap(), &all_windows(&scenario()))
}

#[test]
fn fx_exchange_balances_contribution_gain_and_returns() {
    let body = output(scenario().raw_facts());
    let account = &body["accounts"]["fx-account"];
    let last = account["keyframes"].as_array().unwrap().last().unwrap();
    assert_eq!(last["cash"]["USD"], "900");
    assert_eq!(last["cash"]["EUR"], "92");
    assert_eq!(last["net_contribution"], "1000");
    assert_eq!(last["cash_total_base_currency"], "1001.2");
    assert_eq!(
        account["performance"]["all_time"]["returns"]["twr"],
        "0.0012"
    );
    assert_eq!(
        account["performance"]["all_time"]["summary"]["amount"],
        "1.2"
    );
    assert_eq!(body["portfolio"]["all_time"]["summary"]["amount"], "1.2");
    assert!(account["lots"].as_array().unwrap().is_empty());
    assert!(account["flows"].as_array().unwrap().is_empty());
}

#[test]
fn fx_exchange_uses_native_currencies_not_account_or_reporting_currency() {
    let mut raw = scenario().raw_facts();
    raw.accounts[0].currency = "CAD".into();
    let exchange = raw.activities.last_mut().unwrap();
    exchange.currency = "EUR".into();
    exchange.destination_currency = Some("GBP".into());
    raw.fx_rates = raw
        .fx_rates
        .iter()
        .flat_map(|rate| {
            [("EUR", dec!(1.2)), ("GBP", dec!(1.3)), ("CAD", dec!(0.75))].map(|(from, value)| {
                RawFxRate {
                    from: from.into(),
                    to: "USD".into(),
                    day: rate.day,
                    rate: value,
                    source: rate.source.clone(),
                }
            })
        })
        .collect();
    let body = output(raw);
    let account = &body["accounts"]["fx-account"];
    let last = account["keyframes"].as_array().unwrap().last().unwrap();
    assert_eq!(last["cash"]["EUR"], "-100");
    assert_eq!(last["cash"]["GBP"], "92");
    assert_eq!(last["cash"]["USD"], "1000");
    assert_eq!(last["cash_total_base_currency"], "999.6");
    assert_eq!(last["net_contribution_base"], "1000");
    assert_eq!(
        account["performance"]["all_time"]["attribution"]["fx_effect"],
        "-0.4"
    );
    assert_eq!(body["portfolio"]["all_time"]["summary"]["amount"], "-0.4");
}

#[test]
fn fx_exchange_missing_valuation_rate_never_attributes_only_one_side() {
    let mut raw = scenario().raw_facts();
    raw.fx_rates.clear();
    let body = output(raw);
    let account = &body["accounts"]["fx-account"];
    let last = account["keyframes"].as_array().unwrap().last().unwrap();
    // Missing valuation data must not discard actual native cash balances.
    assert_eq!(last["cash"]["USD"], "900");
    assert_eq!(last["cash"]["EUR"], "92");
    assert_eq!(last["net_contribution_base"], "1000");
    assert_eq!(
        account["performance"]["all_time"]["attribution"]["fx_effect"],
        "0"
    );
    assert_eq!(
        body["portfolio"]["all_time"]["attribution"]["fx_effect"],
        "0"
    );
}

#[test]
fn fx_exchange_invalid_or_unposted_never_books_half_an_exchange() {
    for case in 0..10 {
        let mut raw = scenario().raw_facts();
        let exchange = raw.activities.last_mut().unwrap();
        match case {
            0 => exchange.destination_amount = None,
            1 => exchange.destination_amount = Some(Decimal::ZERO),
            2 => exchange.amount = Some(dec!(-100)),
            3 => exchange.destination_currency = Some("usd".into()),
            4 => exchange.destination_currency = Some("invalid".into()),
            5 => exchange.fee = Some(dec!(1)),
            6 => exchange.fx_rate = Some(dec!(0.92)),
            7 => exchange.status = "DRAFT".into(),
            8 => exchange.status = "PENDING".into(),
            _ => exchange.status = "VOID".into(),
        }
        let body = output(raw);
        let account = &body["accounts"]["fx-account"];
        let last = account["keyframes"].as_array().unwrap().last().unwrap();
        assert_eq!(last["cash"]["USD"], "1000", "case {case}");
        assert!(last["cash"].get("EUR").is_none(), "case {case}");
    }
}

#[test]
fn fx_exchange_edit_delete_precision_and_minor_units() {
    let mut raw = scenario().raw_facts();
    raw.activities.last_mut().unwrap().destination_amount = Some(dec!(92.12345678));
    let body = output(raw.clone());
    assert_eq!(
        body["accounts"]["fx-account"]["keyframes"][1]["cash"]["EUR"],
        "92.12345678"
    );
    raw.activities.pop();
    let body = output(raw);
    assert_eq!(
        body["accounts"]["fx-account"]["keyframes"][0]["cash"]["USD"],
        "1000"
    );
    let mut raw = scenario().raw_facts();
    let exchange = raw.activities.last_mut().unwrap();
    exchange.currency = "GBp".into();
    exchange.amount = Some(dec!(10000));
    let body = output(raw);
    let cash = &body["accounts"]["fx-account"]["keyframes"][1]["cash"];
    assert_eq!(cash["GBP"], "-100");
    assert!(cash.get("GBp").is_none());
}
