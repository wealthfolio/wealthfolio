//! Cash FX attribution is derived from original currency exposure and must
//! reconcile equally through account and scope reads (#2155).
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]

mod support;

use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use support::{load_all_scenarios, Pipeline, Scenario};
use wealthfolio_portfolio_engine::model::{
    AccountId, PerformanceResult, QualityNote, QualityStatus, SummaryStatus,
};
use wealthfolio_portfolio_engine::{
    measure_account, measure_scope, EngineError, MeasureProfile, Window,
};

fn scenario(kind: &str, cash: Decimal, security: Decimal) -> Scenario {
    let security_rows = if security.is_zero() {
        String::new()
    } else {
        format!("  - {{ id: buy, account: acc, type: BUY, date: 2026-01-01T11:00:00Z, asset: fixed, quantity: 1, unit_price: {security}, amount: {security} }}\n")
    };
    serde_yaml::from_str(&format!(
        r#"
id: ISSUE-2155-{kind}
policy: {{ base_currency: CNY, timezone: UTC, as_of: 2026-01-02 }}
accounts:
  - {{ id: acc, currency: USD, account_type: {kind} }}
assets:
  - {{ id: fixed, quote_ccy: USD }}
activities:
  - {{ id: dep, account: acc, type: DEPOSIT, date: 2026-01-01T10:00:00Z, amount: {deposit} }}
{security_rows}
quotes:
  - {{ asset: fixed, day: 2026-01-01, close: {security} }}
  - {{ asset: fixed, day: 2026-01-02, close: {security} }}
fx_rates:
  - {{ from: USD, to: CNY, day: 2026-01-01, rate: 7 }}
  - {{ from: USD, to: CNY, day: 2026-01-02, rate: 6.9 }}
"#,
        deposit = cash + security,
    ))
    .unwrap()
}

fn expected_bucket_fx(pipeline: &Pipeline) -> Decimal {
    let fx = pipeline.fx();
    let base = pipeline.facts().policy().base_currency.as_str();
    let mut total = Decimal::ZERO;
    for (account, series) in &pipeline.series {
        for pair in series.days.windows(2) {
            let state = &pipeline.bundle.keyframes[account]
                .iter()
                .rev()
                .find(|frame| frame.date <= pair[0].date)
                .unwrap()
                .state;
            for (currency, amount) in &state.cash {
                let rate = |date| {
                    fx.rate(currency.as_str(), series.currency.as_str(), date)
                        .unwrap()
                        * fx.rate(series.currency.as_str(), base, date).unwrap()
                };
                total += amount * (rate(pair[1].date) - rate(pair[0].date));
            }
        }
    }
    total.round_dp(8)
}

fn check(kind: &str, cash: Decimal, security: Decimal, bounded: bool) {
    let pipeline = Pipeline::from_scenario(&scenario(kind, cash, security));
    assert_eq!(expected_bucket_fx(&pipeline), -cash * dec!(0.1));
    let lots = pipeline.lots();
    let inputs = pipeline.measure_inputs(&lots);
    let account = AccountId::new("acc");
    let window = Window {
        start: bounded.then(|| "2026-01-01".parse().unwrap()),
        end: bounded.then(|| "2026-01-02".parse().unwrap()),
    };
    let expected = -(cash + security) * dec!(0.1);
    for profile in [
        MeasureProfile::Full,
        MeasureProfile::Summary,
        MeasureProfile::Dashboard,
    ] {
        for scoped in [false, true] {
            let result = if scoped {
                measure_scope(
                    &inputs,
                    "scope",
                    std::slice::from_ref(&account),
                    window,
                    profile,
                    true,
                )
            } else {
                measure_account(&inputs, &account, window, profile, true)
            }
            .unwrap();
            assert_complete(&result, expected);
            assert_eq!(result.returns.twr, Some(dec!(-0.01428571)));
            if profile == MeasureProfile::Full {
                assert_eq!(result.returns.irr, Some(dec!(-0.01428571)));
            }
            if profile != MeasureProfile::Dashboard {
                assert_eq!(result.attribution.fx_effect, expected);
                assert_eq!(result.attribution.income, Decimal::ZERO);
                let days = &pipeline.series[&account].days;
                // Both windows cover inception, including the opening flow.
                let delta = days.last().unwrap().total_value_base;
                assert_eq!(
                    result.attribution.contributions - result.attribution.distributions
                        + result.attribution.pnl(),
                    delta
                );
            }
        }
    }
}

#[test]
fn foreign_cash_has_equal_account_and_scope_attribution() {
    check("CASH", dec!(1000), dec!(0), false);
}

#[test]
fn securities_cash_and_investment_fx_both_count_once() {
    check("SECURITIES", dec!(1000), dec!(1), false);
}

#[test]
fn cash_in_a_securities_account_is_attributed_without_a_position() {
    check("SECURITIES", dec!(1000), dec!(0), false);
}

#[test]
fn a_cash_fx_omission_below_warning_tolerance_is_still_incorrect() {
    check("SECURITIES", dec!(1), dec!(10000), false);
}

#[test]
fn attribution_requires_cash_fx_preparation_even_below_residual_tolerance() {
    let p = Pipeline::from_scenario(&scenario("SECURITIES", dec!(1), dec!(10000)));
    let lots = p.lots();
    let inputs = p.engine.measure_inputs(
        &p.series,
        &lots,
        &p.bundle.disposals,
        &p.bundle.rejected_activities(),
        MeasureProfile::Dashboard,
    );
    let account = AccountId::new("acc");
    for profile in [MeasureProfile::Full, MeasureProfile::Summary] {
        for scoped in [false, true] {
            let result = if scoped {
                measure_scope(
                    &inputs,
                    "scope",
                    std::slice::from_ref(&account),
                    Window::default(),
                    profile,
                    false,
                )
            } else {
                measure_account(&inputs, &account, Window::default(), profile, false)
            };
            assert!(
                matches!(result, Err(EngineError::CashFxNotPrepared { account }) if account == "acc")
            );
        }
    }
}

#[test]
fn missing_account_preparation_is_rejected() {
    let p = Pipeline::from_scenario(&scenario("CASH", dec!(1000), dec!(0)));
    let lots = p.lots();
    let mut inputs = p.measure_inputs(&lots);
    inputs
        .cash_fx
        .as_mut()
        .unwrap()
        .remove(&AccountId::new("acc"));
    for scoped in [false, true] {
        let account = AccountId::new("acc");
        let result = if scoped {
            measure_scope(
                &inputs,
                "scope",
                &[account],
                Window::default(),
                MeasureProfile::Summary,
                false,
            )
        } else {
            measure_account(
                &inputs,
                &account,
                Window::default(),
                MeasureProfile::Summary,
                false,
            )
        };
        assert!(
            matches!(result, Err(EngineError::CashFxNotPrepared { account }) if account == "acc")
        );
    }
}

#[test]
fn prepared_zero_cash_fx_is_distinct_from_missing_preparation() {
    let mut s = scenario("CASH", dec!(1000), dec!(0));
    s.policy.base_currency = "USD".into();
    let p = Pipeline::from_scenario(&s);
    let lots = p.lots();
    let inputs = p.measure_inputs(&lots);
    let account = AccountId::new("acc");
    assert!(inputs.cash_fx.as_ref().unwrap()[&account].is_empty());
    for profile in [
        MeasureProfile::Full,
        MeasureProfile::Summary,
        MeasureProfile::Dashboard,
    ] {
        assert_complete(
            &measure_account(&inputs, &account, Window::default(), profile, false).unwrap(),
            dec!(0),
        );
        assert_complete(
            &measure_scope(
                &inputs,
                "scope",
                std::slice::from_ref(&account),
                Window::default(),
                profile,
                false,
            )
            .unwrap(),
            dec!(0),
        );
    }
}

#[test]
fn holdings_only_attribution_does_not_require_transaction_cash_fx() {
    let p = pipeline(
        r#"
id: CASH-FX-HOLDINGS-PREPARATION
policy: { base_currency: USD, timezone: UTC, as_of: 2026-01-02 }
accounts:
  - { id: acc, currency: USD, tracking_mode: HOLDINGS }
observed_snapshots:
  - { account: acc, date: 2026-01-01, cash: { USD: 1000 } }
  - { account: acc, date: 2026-01-02, cash: { USD: 1000 } }
"#,
    );
    let lots = p.lots();
    let inputs = p.engine.measure_inputs(
        &p.series,
        &lots,
        &p.bundle.disposals,
        &p.bundle.rejected_activities(),
        MeasureProfile::Dashboard,
    );
    assert!(inputs.cash_fx.is_none());
    let prepared = p.measure_inputs(&lots);
    let account = AccountId::new("acc");
    for profile in [MeasureProfile::Full, MeasureProfile::Summary] {
        assert_eq!(
            measure_account(&inputs, &account, Window::default(), profile, false).unwrap(),
            measure_account(&prepared, &account, Window::default(), profile, false).unwrap(),
        );
        assert_eq!(
            measure_scope(
                &inputs,
                "scope",
                std::slice::from_ref(&account),
                Window::default(),
                profile,
                false,
            )
            .unwrap(),
            measure_scope(
                &prepared,
                "scope",
                std::slice::from_ref(&account),
                Window::default(),
                profile,
                false,
            )
            .unwrap(),
        );
    }
}

#[test]
fn bounded_cash_attribution_uses_the_opening_exposure() {
    check("CASH", dec!(1000), dec!(0), true);
}

#[test]
fn bounded_securities_attribution_includes_cash() {
    check("SECURITIES", dec!(1000), dec!(1), true);
}

fn check_scope(raw: &str, expected: Decimal, expected_cash_fx: Decimal) {
    let scenario: Scenario = serde_yaml::from_str(raw).unwrap();
    let pipeline = Pipeline::from_scenario(&scenario);
    let bucket_fx = expected_bucket_fx(&pipeline);
    assert_eq!(bucket_fx, expected_cash_fx);
    let lots = pipeline.lots();
    let inputs = pipeline.measure_inputs(&lots);
    let scope = pipeline.portfolio_scope();
    let mut account_pnl = Decimal::ZERO;
    for account in &scope {
        let result = measure_account(
            &inputs,
            account,
            Window::default(),
            MeasureProfile::Full,
            true,
        )
        .unwrap();
        account_pnl += result.attribution.pnl();
    }
    assert_eq!(account_pnl, expected);
    let result = measure_scope(
        &inputs,
        "scope",
        &scope,
        Window::default(),
        MeasureProfile::Full,
        true,
    )
    .unwrap();
    assert_complete(&result, expected);
    assert_eq!(result.attribution.fx_effect, expected);
    let ending: Decimal = pipeline
        .series
        .values()
        .map(|history| history.days.last().unwrap().total_value_base)
        .sum();
    assert_eq!(
        result.attribution.contributions - result.attribution.distributions
            + result.attribution.pnl(),
        ending
    );
}

#[test]
fn mixed_account_types_and_currencies_reconcile() {
    check_scope(
        r#"
id: MULTI-ACCOUNT
policy: { base_currency: CNY, timezone: UTC, as_of: 2026-01-02 }
accounts:
  - { id: usd, currency: USD, account_type: CASH }
  - { id: eur, currency: EUR, account_type: SECURITIES }
assets:
  - { id: fixed, quote_ccy: EUR }
activities:
  - { id: usd-dep, account: usd, type: DEPOSIT, date: 2026-01-01T10:00:00Z, amount: 1000 }
  - { id: eur-dep, account: eur, type: DEPOSIT, date: 2026-01-01T10:00:00Z, amount: 501 }
  - { id: buy, account: eur, type: BUY, date: 2026-01-01T11:00:00Z, asset: fixed, quantity: 1, unit_price: 1, amount: 1 }
quotes:
  - { asset: fixed, day: 2026-01-01, close: 1 }
  - { asset: fixed, day: 2026-01-02, close: 1 }
fx_rates:
  - { from: USD, to: CNY, day: 2026-01-01, rate: 7 }
  - { from: USD, to: CNY, day: 2026-01-02, rate: 6.9 }
  - { from: EUR, to: CNY, day: 2026-01-01, rate: 8 }
  - { from: EUR, to: CNY, day: 2026-01-02, rate: 7.8 }
"#,
        dec!(-200.2),
        dec!(-200),
    );
}

#[test]
fn a_withdrawal_empty_interval_and_new_deposit_do_not_create_exposure() {
    check_scope(
        r#"
id: EMPTY-INTERVAL
policy: { base_currency: CNY, timezone: UTC, as_of: 2026-01-05 }
accounts:
  - { id: acc, currency: USD, account_type: CASH }
activities:
  - { id: dep, account: acc, type: DEPOSIT, date: 2026-01-01T10:00:00Z, amount: 1000 }
  - { id: wd, account: acc, type: WITHDRAWAL, date: 2026-01-02T10:00:00Z, amount: 1000 }
  - { id: dep2, account: acc, type: DEPOSIT, date: 2026-01-04T10:00:00Z, amount: 500 }
fx_rates:
  - { from: USD, to: CNY, day: 2026-01-01, rate: 7 }
  - { from: USD, to: CNY, day: 2026-01-02, rate: 6.9 }
  - { from: USD, to: CNY, day: 2026-01-03, rate: 6.8 }
  - { from: USD, to: CNY, day: 2026-01-04, rate: 6.7 }
  - { from: USD, to: CNY, day: 2026-01-05, rate: 6.6 }
"#,
        dec!(-150),
        dec!(-150),
    );
}

#[test]
fn a_foreign_cash_bucket_is_attributed_in_a_base_currency_account() {
    check_scope(
        r#"
id: FOREIGN-BUCKET
policy: { base_currency: CNY, timezone: UTC, as_of: 2026-01-02 }
accounts:
  - { id: acc, currency: CNY, account_type: CASH }
activities:
  - { id: dep, account: acc, type: DEPOSIT, date: 2026-01-01T10:00:00Z, amount: 1000, currency: USD }
fx_rates:
  - { from: USD, to: CNY, day: 2026-01-01, rate: 7 }
  - { from: USD, to: CNY, day: 2026-01-02, rate: 6.9 }
"#,
        dec!(-100),
        dec!(-100),
    );
}

#[test]
fn an_internal_transfer_moves_exposure_without_creating_pnl() {
    check_scope(
        r#"
id: CASH-TRANSFER
policy: { base_currency: CNY, timezone: UTC, as_of: 2026-01-03 }
accounts:
  - { id: a, currency: USD, account_type: CASH }
  - { id: b, currency: USD, account_type: SECURITIES }
activities:
  - { id: dep, account: a, type: DEPOSIT, date: 2026-01-01T10:00:00Z, amount: 1000 }
  - { id: out, account: a, type: TRANSFER_OUT, date: 2026-01-02T10:00:00Z, amount: 400, source_group_id: transfer }
  - { id: in, account: b, type: TRANSFER_IN, date: 2026-01-02T11:00:00Z, amount: 400, source_group_id: transfer }
fx_rates:
  - { from: USD, to: CNY, day: 2026-01-01, rate: 7 }
  - { from: USD, to: CNY, day: 2026-01-02, rate: 6.9 }
  - { from: USD, to: CNY, day: 2026-01-03, rate: 6.8 }
"#,
        dec!(-200),
        dec!(-200),
    );
}

fn assert_complete(result: &PerformanceResult, amount: Decimal) {
    assert_eq!(result.summary.amount, Some(amount));
    assert_eq!(result.summary.amount_status, SummaryStatus::Complete);
    assert_eq!(
        result.data_quality.status,
        QualityStatus::Ok,
        "{:?}",
        result.data_quality
    );
    assert_eq!(result.attribution.pnl(), amount);
    assert_eq!(result.attribution.residual, Decimal::ZERO);
}

fn pipeline(raw: &str) -> Pipeline {
    Pipeline::from_scenario(&serde_yaml::from_str::<Scenario>(raw).unwrap())
}

fn account_and_scope(pipeline: &Pipeline, amount: Decimal, fx: Decimal) -> PerformanceResult {
    let lots = pipeline.lots();
    let inputs = pipeline.measure_inputs(&lots);
    let scope = pipeline.portfolio_scope();
    assert_eq!(scope.len(), 1);
    let account = measure_account(
        &inputs,
        &scope[0],
        Window::default(),
        MeasureProfile::Full,
        true,
    )
    .unwrap();
    let scoped = measure_scope(
        &inputs,
        "scope",
        &scope,
        Window::default(),
        MeasureProfile::Full,
        true,
    )
    .unwrap();
    assert_complete(&account, amount);
    assert_complete(&scoped, amount);
    assert_eq!(account.attribution, scoped.attribution);
    assert_eq!(account.returns, scoped.returns);
    assert_eq!(account.attribution.fx_effect, fx);
    account
}

#[test]
fn the_existing_foreign_cash_fixture_reconciles_in_both_paths() {
    let scenario = load_all_scenarios()
        .into_iter()
        .find(|s| s.id == "PERF-CASH-01")
        .unwrap();
    account_and_scope(&Pipeline::from_scenario(&scenario), dec!(46), dec!(46));
}

#[test]
fn income_fees_and_taxes_are_separate_from_cash_revaluation() {
    let p = pipeline(
        r#"
id: CASH-FX-INCOME
policy: { base_currency: CNY, timezone: UTC, as_of: 2026-01-02 }
accounts:
  - { id: acc, currency: USD }
assets:
  - { id: fixed, quote_ccy: USD }
activities:
  - { id: dep, account: acc, type: DEPOSIT, date: 2026-01-01T10:00:00Z, amount: 1000 }
  - { id: buy, account: acc, type: BUY, date: 2026-01-01T11:00:00Z, asset: fixed, quantity: 1, unit_price: 100, amount: 100 }
  - { id: income, account: acc, type: INTEREST, date: 2026-01-02T10:00:00Z, amount: 9, fee: 1, tax: 1 }
quotes:
  - { asset: fixed, day: 2026-01-01, close: 100 }
  - { asset: fixed, day: 2026-01-02, close: 100 }
fx_rates:
  - { from: USD, to: CNY, day: 2026-01-01, rate: 7 }
  - { from: USD, to: CNY, day: 2026-01-02, rate: 6.9 }
"#,
    );
    let result = account_and_scope(&p, dec!(-37.9), dec!(-100));
    assert_eq!(result.attribution.income, dec!(75.9));
    assert_eq!(result.attribution.fees, dec!(6.9));
    assert_eq!(result.attribution.taxes, dec!(6.9));
}

#[test]
fn a_purchase_does_not_turn_cash_movement_into_fx() {
    let mut scenario = scenario("SECURITIES", dec!(1000), dec!(1));
    scenario
        .activities
        .iter_mut()
        .find(|a| a.id == "buy")
        .unwrap()
        .date = "2026-01-02T11:00:00Z".into();
    account_and_scope(
        &Pipeline::from_scenario(&scenario),
        dec!(-100.1),
        dec!(-100.1),
    );
}

#[test]
fn conversion_execution_gain_and_later_cash_fx_count_once() {
    let p = pipeline(
        r#"
id: CASH-FX-CONVERSION
policy: { base_currency: USD, timezone: UTC, as_of: 2026-01-03 }
accounts:
  - { id: acc, currency: USD }
activities:
  - { id: dep, account: acc, type: DEPOSIT, date: 2026-01-01T10:00:00Z, amount: 1000 }
  - { id: out, account: acc, type: TRANSFER_OUT, date: 2026-01-02T10:00:00Z, amount: 100, currency: USD, source_group_id: conversion, metadata: { flow: { is_external: false } } }
  - { id: in, account: acc, type: TRANSFER_IN, date: 2026-01-02T11:00:00Z, amount: 90, currency: EUR, source_group_id: conversion, metadata: { flow: { is_external: false } } }
fx_rates:
  - { from: EUR, to: USD, day: 2026-01-01, rate: 1.1 }
  - { from: EUR, to: USD, day: 2026-01-02, rate: 1.2 }
  - { from: EUR, to: USD, day: 2026-01-03, rate: 1.3 }
"#,
    );
    assert_eq!(expected_bucket_fx(&p), dec!(9));
    // Execution gain: 90 * 1.2 - 100 = 8. Subsequent holding FX: 90 * 0.1 = 9.
    account_and_scope(&p, dec!(17), dec!(17));
}

#[test]
fn rejected_activities_do_not_change_cash_exposure() {
    let mut scenario = scenario("SECURITIES", dec!(1000), dec!(1));
    let mut rejected = scenario
        .activities
        .iter()
        .find(|a| a.id == "buy")
        .unwrap()
        .clone();
    rejected.id = "rejected".into();
    rejected.subtype = Some("POSITION_CLOSE".into());
    rejected.date = "2026-01-01T12:00:00Z".into();
    scenario.activities.push(rejected);
    let p = Pipeline::from_scenario(&scenario);
    assert!(p
        .bundle
        .rejected_activities()
        .iter()
        .any(|id| id.as_str() == "rejected"));
    account_and_scope(&p, dec!(-100.1), dec!(-100.1));
}

#[test]
fn missing_cash_fx_is_reported_even_when_the_residual_is_small() {
    let p = Pipeline::from_scenario(&scenario("SECURITIES", dec!(1), dec!(10000)));
    let lots = p.lots();
    let mut inputs = p.measure_inputs(&lots);
    inputs
        .cash_fx
        .as_mut()
        .unwrap()
        .get_mut(&AccountId::new("acc"))
        .unwrap()[0]
        .amount = None;
    for scoped in [false, true] {
        let scope = [AccountId::new("acc")];
        let result = if scoped {
            measure_scope(
                &inputs,
                "scope",
                &scope,
                Window::default(),
                MeasureProfile::Full,
                true,
            )
        } else {
            measure_account(
                &inputs,
                &scope[0],
                Window::default(),
                MeasureProfile::Full,
                true,
            )
        }
        .unwrap();
        assert_eq!(result.data_quality.status, QualityStatus::Partial);
        assert!(result
            .data_quality
            .warnings
            .iter()
            .any(|note| matches!(note, QualityNote::CashFxUnavailable { .. })));
        assert!(!result
            .data_quality
            .warnings
            .iter()
            .any(|note| matches!(note, QualityNote::AttributionIncomplete { .. })));
    }
}

#[test]
fn explicit_trade_fx_settles_cash_in_the_account_currency() {
    let p = pipeline(
        r#"
id: CASH-FX-BOOKING
policy: { base_currency: CNY, timezone: UTC, as_of: 2026-01-02 }
accounts:
  - { id: acc, currency: USD }
assets:
  - { id: fixed, quote_ccy: EUR }
activities:
  - { id: dep, account: acc, type: DEPOSIT, date: 2026-01-01T10:00:00Z, amount: 1000 }
  - { id: buy, account: acc, type: BUY, date: 2026-01-01T11:00:00Z, asset: fixed, quantity: 1, unit_price: 100, amount: 100, currency: EUR, fx_rate: 2 }
quotes:
  - { asset: fixed, day: 2026-01-01, close: 100 }
  - { asset: fixed, day: 2026-01-02, close: 100 }
fx_rates:
  - { from: EUR, to: USD, day: 2026-01-01, rate: 2 }
  - { from: EUR, to: USD, day: 2026-01-02, rate: 2.01 }
  - { from: USD, to: CNY, day: 2026-01-01, rate: 7 }
  - { from: USD, to: CNY, day: 2026-01-02, rate: 6.9 }
"#,
    );
    assert_eq!(expected_bucket_fx(&p), dec!(-80));
    let result = account_and_scope(&p, dec!(-93.1), dec!(-100));
    assert_eq!(result.attribution.unrealized_pnl_change, dec!(6.9));
}

#[test]
fn a_sale_keeps_realized_investment_pnl_separate_from_cash_fx() {
    let mut scenario = scenario("SECURITIES", dec!(1000), dec!(1));
    let mut sale = scenario
        .activities
        .iter()
        .find(|a| a.id == "buy")
        .unwrap()
        .clone();
    sale.id = "sell".into();
    sale.activity_type = "SELL".into();
    sale.date = "2026-01-02T11:00:00Z".into();
    scenario.activities.push(sale);
    let result = account_and_scope(
        &Pipeline::from_scenario(&scenario),
        dec!(-100.1),
        dec!(-100),
    );
    assert_eq!(result.attribution.realized_pnl, dec!(-0.1));
}

#[test]
fn mixed_tracking_keeps_transaction_cash_fx_and_holdings_pnl_separate() {
    let p = pipeline(
        r#"
id: CASH-FX-MIXED-TRACKING
policy: { base_currency: CNY, timezone: UTC, as_of: 2026-01-02 }
accounts:
  - { id: transactions, currency: USD, account_type: CASH }
  - { id: holdings, currency: CNY, tracking_mode: HOLDINGS }
assets:
  - { id: fixed, quote_ccy: CNY }
activities:
  - { id: dep, account: transactions, type: DEPOSIT, date: 2026-01-01T10:00:00Z, amount: 1000 }
observed_snapshots:
  - { account: holdings, date: 2026-01-01, positions: [{ asset: fixed, quantity: 1, average_cost: 100 }], cash: {} }
quotes:
  - { asset: fixed, day: 2026-01-01, close: 100 }
  - { asset: fixed, day: 2026-01-02, close: 110 }
fx_rates:
  - { from: USD, to: CNY, day: 2026-01-01, rate: 7 }
  - { from: USD, to: CNY, day: 2026-01-02, rate: 6.9 }
"#,
    );
    let lots = p.lots();
    let inputs = p.measure_inputs(&lots);
    assert!(!inputs
        .cash_fx
        .as_ref()
        .unwrap()
        .contains_key(&AccountId::new("holdings")));
    for window in [
        Window::default(),
        Window {
            start: Some("2026-01-01".parse().unwrap()),
            end: Some("2026-01-02".parse().unwrap()),
        },
    ] {
        let result = measure_scope(
            &inputs,
            "mixed",
            &p.portfolio_scope(),
            window,
            MeasureProfile::Full,
            true,
        )
        .unwrap();
        assert!(result.is_mixed_tracking_mode);
        assert_eq!(result.summary.amount, Some(dec!(-90)));
        assert_eq!(result.attribution.fx_effect, dec!(-100));
        assert_eq!(result.attribution.unrealized_pnl_change, dec!(10));
        assert_eq!(result.attribution.pnl(), dec!(-90));
        assert!(result.returns.twr.is_none());
        assert!(result.returns.irr.is_none());
    }
}

#[test]
fn unavailable_rates_never_become_zero_cash_fx_with_ok_quality() {
    let mut scenario = scenario("CASH", dec!(1000), dec!(0));
    scenario.fx_rates.clear();
    let p = Pipeline::from_scenario(&scenario);
    let lots = p.lots();
    let inputs = p.measure_inputs(&lots);
    let cash_fx = &inputs.cash_fx.as_ref().unwrap()[&AccountId::new("acc")];
    assert_eq!(cash_fx.len(), 1);
    assert_eq!(cash_fx[0].amount, None);
    for scoped in [false, true] {
        let scope = [AccountId::new("acc")];
        let result = if scoped {
            measure_scope(
                &inputs,
                "scope",
                &scope,
                Window::default(),
                MeasureProfile::Full,
                true,
            )
        } else {
            measure_account(
                &inputs,
                &scope[0],
                Window::default(),
                MeasureProfile::Full,
                true,
            )
        }
        .unwrap();
        assert!(result.summary.amount.is_none());
        assert_ne!(result.data_quality.status, QualityStatus::Ok);
        assert!(result
            .data_quality
            .warnings
            .iter()
            .any(|note| matches!(note, QualityNote::CashFxUnavailable { .. })));
    }
}

#[test]
fn base_currency_cash_has_no_fx_effect() {
    let mut scenario = scenario("CASH", dec!(1000), dec!(0));
    scenario.policy.base_currency = "USD".into();
    account_and_scope(
        &Pipeline::from_scenario(&scenario),
        Decimal::ZERO,
        Decimal::ZERO,
    );
}

#[test]
fn an_unexplained_cash_value_difference_is_not_assigned_to_fx() {
    let mut scenario = scenario("CASH", dec!(1000), Decimal::ZERO);
    scenario.policy.base_currency = "USD".into();
    let p = Pipeline::from_scenario(&scenario);
    let mut series = p.series.clone();
    let end = series
        .get_mut(&AccountId::new("acc"))
        .unwrap()
        .days
        .last_mut()
        .unwrap();
    end.cash_balance_base += dec!(10);
    end.total_value_base += dec!(10);
    let lots = p.lots();
    let inputs = p.engine.measure_inputs(
        &series,
        &lots,
        &p.bundle.disposals,
        &p.bundle.rejected_activities(),
        MeasureProfile::Full,
    );
    let result = measure_scope(
        &inputs,
        "scope",
        &p.portfolio_scope(),
        Window::default(),
        MeasureProfile::Full,
        true,
    )
    .unwrap();
    assert_eq!(result.attribution.fx_effect, Decimal::ZERO);
    assert_eq!(result.summary.amount, Some(Decimal::ZERO));
    assert!(result.data_quality.warnings.iter().any(|note| matches!(note, QualityNote::AttributionIncomplete { difference, .. } if *difference == dec!(10))));
}

#[test]
fn unmarked_same_account_pairs_keep_their_execution_difference_as_capital() {
    let scenario = load_all_scenarios()
        .into_iter()
        .find(|s| s.id == "EDGE-TXF-05")
        .unwrap();
    let p = Pipeline::from_scenario(&scenario);
    let lots = p.lots();
    let inputs = p.measure_inputs(&lots);
    for (id, amount) in [("acc-plain", Decimal::ZERO), ("acc-linked", dec!(1.2))] {
        let account = AccountId::new(id);
        for scoped in [false, true] {
            let result = if scoped {
                measure_scope(
                    &inputs,
                    "scope",
                    std::slice::from_ref(&account),
                    Window::default(),
                    MeasureProfile::Full,
                    true,
                )
            } else {
                measure_account(
                    &inputs,
                    &account,
                    Window::default(),
                    MeasureProfile::Full,
                    true,
                )
            }
            .unwrap();
            assert_eq!(result.summary.amount, Some(amount));
            assert_eq!(
                result.attribution.contributions - result.attribution.distributions
                    + result.attribution.pnl(),
                dec!(1001.2)
            );
        }
    }
}

#[test]
fn a_window_cutting_a_conversion_does_not_attribute_principal_as_fx() {
    let p = pipeline(
        r#"
id: CASH-FX-CONVERSION-WINDOW
policy: { base_currency: USD, timezone: UTC, as_of: 2026-01-04 }
accounts:
  - { id: acc, currency: USD }
activities:
  - { id: dep, account: acc, type: DEPOSIT, date: 2026-01-01T10:00:00Z, amount: 1000 }
  - { id: out, account: acc, type: TRANSFER_OUT, date: 2026-01-02T10:00:00Z, amount: 100, currency: USD, source_group_id: conversion, metadata: { flow: { is_external: false } } }
  - { id: in, account: acc, type: TRANSFER_IN, date: 2026-01-03T11:00:00Z, amount: 90, currency: EUR, source_group_id: conversion, metadata: { flow: { is_external: false } } }
fx_rates:
  - { from: EUR, to: USD, day: 2026-01-01, rate: 1.1 }
  - { from: EUR, to: USD, day: 2026-01-02, rate: 1.2 }
  - { from: EUR, to: USD, day: 2026-01-03, rate: 1.2 }
  - { from: EUR, to: USD, day: 2026-01-04, rate: 1.3 }
"#,
    );
    let lots = p.lots();
    let inputs = p.measure_inputs(&lots);
    for (start, end, expected, unexplained) in [
        ("2026-01-01", "2026-01-02", dec!(0), dec!(-100)),
        ("2026-01-02", "2026-01-04", dec!(9), dec!(108)),
        ("2026-01-03", "2026-01-04", dec!(9), dec!(0)),
        ("2026-01-01", "2026-01-04", dec!(17), dec!(0)),
    ] {
        let window = Window {
            start: Some(start.parse().unwrap()),
            end: Some(end.parse().unwrap()),
        };
        for scoped in [false, true] {
            let account = AccountId::new("acc");
            let result = if scoped {
                measure_scope(
                    &inputs,
                    "scope",
                    std::slice::from_ref(&account),
                    window,
                    MeasureProfile::Summary,
                    false,
                )
            } else {
                measure_account(&inputs, &account, window, MeasureProfile::Summary, false)
            }
            .unwrap();
            assert_eq!(result.summary.amount, Some(expected));
            assert_eq!(result.attribution.fx_effect, expected);
            assert_transfer_residual(&result, unexplained);
        }
    }
}

fn assert_transfer_residual(result: &PerformanceResult, expected: Decimal) {
    let residual = result.data_quality.warnings.iter().find_map(|note| {
        if let QualityNote::AttributionIncomplete { difference, .. } = note {
            Some(*difference)
        } else {
            None
        }
    });
    assert_eq!(residual, (!expected.is_zero()).then_some(expected));
    if !expected.is_zero() {
        assert_eq!(result.data_quality.status, QualityStatus::Partial);
    }
}

fn split_cash_transfer(currency: &str, moving_fx: bool) -> Pipeline {
    let (incoming, middle_rate, end_rate) = if moving_fx {
        (dec!(90), dec!(1.2), dec!(1.3))
    } else {
        (dec!(100), dec!(1), dec!(1))
    };
    pipeline(&format!(
        r#"
id: SPLIT-TRANSFER-TWO-ACCOUNTS
policy: {{ base_currency: USD, timezone: UTC, as_of: 2026-01-04 }}
accounts:
  - {{ id: sender, currency: USD }}
  - {{ id: receiver, currency: {currency} }}
activities:
  - {{ id: dep, account: sender, type: DEPOSIT, date: 2026-01-01T10:00:00Z, amount: 1000 }}
  - {{ id: receiver-dep, account: receiver, type: DEPOSIT, date: 2026-01-01T10:00:00Z, amount: 1 }}
  - {{ id: out, account: sender, type: TRANSFER_OUT, date: 2026-01-02T10:00:00Z, amount: 100, source_group_id: pair }}
  - {{ id: in, account: receiver, type: TRANSFER_IN, date: 2026-01-03T10:00:00Z, amount: {incoming}, source_group_id: pair }}
fx_rates:
  - {{ from: EUR, to: USD, day: 2026-01-01, rate: 1 }}
  - {{ from: EUR, to: USD, day: 2026-01-02, rate: {middle_rate} }}
  - {{ from: EUR, to: USD, day: 2026-01-03, rate: {middle_rate} }}
  - {{ from: EUR, to: USD, day: 2026-01-04, rate: {end_rate} }}
"#
    ))
}

#[test]
fn split_transfers_between_two_accounts_do_not_turn_principal_into_fx() {
    for currency in ["USD", "EUR"] {
        let p = split_cash_transfer(currency, false);
        let lots = p.lots();
        let inputs = p.measure_inputs(&lots);
        for (start, end, unexplained) in [
            ("2026-01-01", "2026-01-02", dec!(-100)),
            ("2026-01-02", "2026-01-04", dec!(100)),
            ("2026-01-01", "2026-01-04", dec!(0)),
            ("2026-01-03", "2026-01-04", dec!(0)),
        ] {
            let window = Window {
                start: Some(start.parse().unwrap()),
                end: Some(end.parse().unwrap()),
            };
            for profile in [MeasureProfile::Full, MeasureProfile::Summary] {
                let result = measure_scope(
                    &inputs,
                    "both",
                    &p.portfolio_scope(),
                    window,
                    profile,
                    false,
                )
                .unwrap();
                assert_eq!(result.summary.amount, Some(Decimal::ZERO));
                assert_eq!(result.attribution.fx_effect, Decimal::ZERO);
                assert_transfer_residual(&result, unexplained);
                let dashboard = measure_scope(
                    &inputs,
                    "both",
                    &p.portfolio_scope(),
                    window,
                    MeasureProfile::Dashboard,
                    false,
                )
                .unwrap();
                assert_eq!(dashboard.summary.amount, Some(unexplained));
                assert_eq!(result.returns.twr, dashboard.returns.twr);
            }
            for account in p.portfolio_scope() {
                let result =
                    measure_account(&inputs, &account, window, MeasureProfile::Summary, false)
                        .unwrap();
                assert_complete(&result, Decimal::ZERO);
            }
        }
    }
}

#[test]
fn split_transfers_keep_actual_cash_fx_and_complete_pair_execution_gains() {
    let p = split_cash_transfer("EUR", true);
    let lots = p.lots();
    let inputs = p.measure_inputs(&lots);
    for (start, end, expected, unexplained) in [
        ("2026-01-01", "2026-01-02", dec!(0.2), dec!(-100)),
        ("2026-01-02", "2026-01-04", dec!(9.1), dec!(108)),
        ("2026-01-03", "2026-01-04", dec!(9.1), dec!(0)),
        ("2026-01-01", "2026-01-04", dec!(17.3), dec!(0)),
    ] {
        let result = measure_scope(
            &inputs,
            "both",
            &p.portfolio_scope(),
            Window {
                start: Some(start.parse().unwrap()),
                end: Some(end.parse().unwrap()),
            },
            MeasureProfile::Summary,
            false,
        )
        .unwrap();
        assert_eq!(result.attribution.fx_effect, expected);
        assert_eq!(result.summary.amount, Some(expected));
        assert_transfer_residual(&result, unexplained);
    }
}

#[test]
fn dashboard_preparation_skips_cash_fx_without_changing_its_outputs() {
    let p = Pipeline::from_scenario(&scenario("SECURITIES", dec!(1000), dec!(1)));
    let lots = p.lots();
    let full_inputs = p.measure_inputs(&lots);
    let scope = p.portfolio_scope();
    for profile in [
        MeasureProfile::Full,
        MeasureProfile::Summary,
        MeasureProfile::Dashboard,
    ] {
        let inputs = p.engine.measure_inputs(
            &p.series,
            &lots,
            &p.bundle.disposals,
            &p.bundle.rejected_activities(),
            profile,
        );
        assert_eq!(
            inputs.cash_fx.is_none(),
            profile == MeasureProfile::Dashboard
        );
        for scoped in [false, true] {
            let measure = |inputs: &wealthfolio_portfolio_engine::MeasureInputs<'_>| {
                if scoped {
                    measure_scope(inputs, "scope", &scope, Window::default(), profile, true)
                } else {
                    measure_account(inputs, &scope[0], Window::default(), profile, true)
                }
                .unwrap()
            };
            let result = measure(&inputs);
            assert_eq!(
                serde_json::to_value(&result).unwrap(),
                serde_json::to_value(measure(&full_inputs)).unwrap()
            );
            assert_complete(&result, dec!(-100.1));
        }
    }
}

#[test]
fn missing_cash_fx_keeps_known_days_and_marks_the_subtotal_partial() {
    let mut scenario = scenario("CASH", dec!(1000), dec!(0));
    scenario.policy.as_of = "2026-01-03".parse().unwrap();
    let mut next = scenario.fx_rates.last().unwrap().clone();
    next.day = scenario.policy.as_of;
    next.rate = support::Dec(dec!(6.8));
    scenario.fx_rates.push(next);
    let p = Pipeline::from_scenario(&scenario);
    let lots = p.lots();
    let mut inputs = p.measure_inputs(&lots);
    let scope = p.portfolio_scope();
    let days = inputs.cash_fx.as_mut().unwrap().get_mut(&scope[0]).unwrap();
    assert_eq!(days.len(), 2);
    days[0].amount = None;
    for scoped in [false, true] {
        let result = if scoped {
            measure_scope(
                &inputs,
                "scope",
                &scope,
                Window::default(),
                MeasureProfile::Summary,
                false,
            )
        } else {
            measure_account(
                &inputs,
                &scope[0],
                Window::default(),
                MeasureProfile::Summary,
                false,
            )
        }
        .unwrap();
        assert_eq!(result.attribution.fx_effect, dec!(-100));
        assert_eq!(result.summary.amount, Some(dec!(-100)));
        assert_eq!(result.summary.quality, QualityStatus::Partial);
        assert!(result
            .summary
            .reasons
            .iter()
            .any(|note| matches!(note, QualityNote::CashFxUnavailable { .. })));
    }
}

#[test]
fn priced_cash_fx_matches_projected_currency_exposure_across_the_fixture_corpus() {
    use wealthfolio_portfolio_engine::model::{TrackingMode, ValueStatus};
    let mut checked = 0;
    for scenario in load_all_scenarios() {
        if scenario.markers.iter().any(|m| m == "S") {
            continue;
        }
        let p = Pipeline::from_scenario(&scenario);
        if p.facts()
            .accounts()
            .values()
            .any(|account| account.tracking == TrackingMode::Holdings)
            || p.series
                .values()
                .flat_map(|s| &s.days)
                .any(|d| d.value_status != ValueStatus::Complete)
        {
            continue;
        }
        let lots = p.lots();
        let inputs = p.measure_inputs(&lots);
        let actual = inputs
            .cash_fx
            .as_ref()
            .unwrap()
            .values()
            .flatten()
            .try_fold(Decimal::ZERO, |total, day| {
                day.amount.map(|amount| total + amount)
            });
        assert_eq!(
            actual.map(|amount| amount.round_dp(8)),
            Some(expected_bucket_fx(&p)),
            "{}",
            scenario.id
        );
        checked += 1;
    }
    assert!(
        checked > 100,
        "only {checked} complete transaction fixtures checked"
    );
}

#[test]
fn holdings_conversion_activities_do_not_add_to_snapshot_based_pnl() {
    let p = pipeline(
        r#"
id: CASH-FX-HOLDINGS-CONVERSION
policy: { base_currency: USD, timezone: UTC, as_of: 2026-01-03 }
accounts:
  - { id: holdings, currency: USD, tracking_mode: HOLDINGS }
  - { id: transactions, currency: USD }
activities:
  - { id: dep, account: transactions, type: DEPOSIT, date: 2026-01-01T10:00:00Z, amount: 100 }
  - { id: out, account: holdings, type: TRANSFER_OUT, date: 2026-01-02T10:00:00Z, amount: 100, currency: USD, source_group_id: conversion, metadata: { flow: { is_external: false } } }
  - { id: in, account: holdings, type: TRANSFER_IN, date: 2026-01-02T11:00:00Z, amount: 90, currency: EUR, source_group_id: conversion, metadata: { flow: { is_external: false } } }
observed_snapshots:
  - { account: holdings, date: 2026-01-01, cash: { USD: 1000 } }
  - { account: holdings, date: 2026-01-02, cash: { USD: 900, EUR: 90 } }
fx_rates:
  - { from: EUR, to: USD, day: 2026-01-01, rate: 1.2 }
  - { from: EUR, to: USD, day: 2026-01-03, rate: 1.2 }
"#,
    );
    let lots = p.lots();
    let inputs = p.measure_inputs(&lots);
    let holdings = AccountId::new("holdings");
    for window in [
        Window::default(),
        Window {
            start: Some("2026-01-01".parse().unwrap()),
            end: Some("2026-01-03".parse().unwrap()),
        },
    ] {
        for result in [
            measure_account(&inputs, &holdings, window, MeasureProfile::Full, true).unwrap(),
            measure_scope(
                &inputs,
                "holdings",
                std::slice::from_ref(&holdings),
                window,
                MeasureProfile::Full,
                true,
            )
            .unwrap(),
            measure_scope(
                &inputs,
                "mixed",
                &p.portfolio_scope(),
                window,
                MeasureProfile::Full,
                true,
            )
            .unwrap(),
        ] {
            // Snapshot policy infers the USD8 change as a contribution. The
            // activity pair must not turn that same change into extra P&L.
            assert_eq!(result.summary.amount, Some(Decimal::ZERO));
            assert_eq!(result.attribution.fx_effect, Decimal::ZERO);
            assert_eq!(result.attribution.pnl(), Decimal::ZERO);
        }
    }
}

fn assert_bounded_cash_fx(p: &Pipeline, expected: Decimal) {
    use wealthfolio_portfolio_engine::model::ValueStatus;
    let lots = p.lots();
    let inputs = p.measure_inputs(&lots);
    let account = AccountId::new("acc");
    assert!(p.series[&account]
        .days
        .iter()
        .all(|day| day.value_status == ValueStatus::Complete));
    let window = Window {
        start: Some("2026-01-01".parse().unwrap()),
        end: Some("2026-01-02".parse().unwrap()),
    };
    for result in [
        measure_account(&inputs, &account, window, MeasureProfile::Summary, false).unwrap(),
        measure_scope(
            &inputs,
            "scope",
            std::slice::from_ref(&account),
            window,
            MeasureProfile::Summary,
            false,
        )
        .unwrap(),
    ] {
        assert_complete(&result, expected);
        assert_eq!(result.attribution.fx_effect, expected);
    }
}

#[test]
fn small_cash_exposures_are_valued_before_combining_large_rates() {
    // Open before the measured window to test period cash FX separately
    // from inception contribution conversion at these extreme rates.
    let p = pipeline(
        r#"
id: CASH-FX-SMALL-EXPOSURE
policy: { base_currency: CNY, timezone: UTC, as_of: 2026-01-02 }
accounts:
  - { id: acc, currency: EUR, account_type: CASH }
activities:
  - { id: dep, account: acc, type: DEPOSIT, date: 2025-12-31T10:00:00Z, amount: 0.000001, currency: USD }
fx_rates:
  - { from: USD, to: EUR, day: 2025-12-31, rate: 100000000000 }
  - { from: USD, to: EUR, day: 2026-01-01, rate: 100000000000 }
  - { from: USD, to: EUR, day: 2026-01-02, rate: 100000000000 }
  - { from: EUR, to: CNY, day: 2025-12-31, rate: 10000000000 }
  - { from: EUR, to: CNY, day: 2026-01-01, rate: 10000000000 }
  - { from: EUR, to: CNY, day: 2026-01-02, rate: 11000000000 }
"#,
    );
    assert_bounded_cash_fx(&p, dec!(100000000000000));
}

#[test]
fn a_transient_large_balance_does_not_lose_a_valid_closing_exposure() {
    let p = pipeline(
        r#"
id: CASH-FX-TRANSIENT-BALANCE
policy: { base_currency: CNY, timezone: UTC, as_of: 2026-01-02 }
accounts:
  - { id: acc, currency: USD, account_type: CASH }
activities:
  - { id: dep, account: acc, type: DEPOSIT, date: 2026-01-01T10:00:00Z, amount: "100000000000000000000" }
  - { id: dep2, account: acc, type: DEPOSIT, date: 2026-01-01T11:00:00Z, amount: "100000000000000000000" }
  - { id: wd, account: acc, type: WITHDRAWAL, date: 2026-01-01T12:00:00Z, amount: "100000000000000000000" }
fx_rates:
  - { from: USD, to: CNY, day: 2026-01-01, rate: 1 }
  - { from: USD, to: CNY, day: 2026-01-02, rate: 0.9 }
"#,
    );
    assert!(p.bundle.rejected_activities().is_empty());
    assert_bounded_cash_fx(&p, dec!(-10000000000000000000));
}

#[test]
fn opposing_currency_movements_are_netted_before_bounding_daily_fx() {
    let p = pipeline(
        r#"
id: CASH-FX-NET-MOVEMENT
policy: { base_currency: USD, timezone: UTC, as_of: 2026-01-02 }
accounts:
  - { id: acc, currency: USD, account_type: CASH }
activities:
  - { id: cad, account: acc, type: DEPOSIT, date: 2026-01-01T10:00:00Z, amount: 1, currency: CAD }
  - { id: eur, account: acc, type: DEPOSIT, date: 2026-01-01T11:00:00Z, amount: 1, currency: EUR }
  - { id: gbp, account: acc, type: WITHDRAWAL, date: 2026-01-01T12:00:00Z, amount: 1, currency: GBP }
fx_rates:
  - { from: CAD, to: USD, day: 2026-01-01, rate: "10000000000000000000" }
  - { from: CAD, to: USD, day: 2026-01-02, rate: "70000000000000000000" }
  - { from: EUR, to: USD, day: 2026-01-01, rate: "10000000000000000000" }
  - { from: EUR, to: USD, day: 2026-01-02, rate: "70000000000000000000" }
  - { from: GBP, to: USD, day: 2026-01-01, rate: "10000000000000000000" }
  - { from: GBP, to: USD, day: 2026-01-02, rate: "50000000000000000000" }
"#,
    );
    assert_bounded_cash_fx(&p, dec!(80000000000000000000));
}

#[test]
fn minor_unit_accounts_use_the_same_major_currency_valuation_hop() {
    let p = pipeline(
        r#"
id: CASH-FX-MINOR-ACCOUNT
policy: { base_currency: USD, timezone: UTC, as_of: 2026-01-02 }
accounts:
  - { id: acc, currency: GBX, account_type: CASH }
activities:
  - { id: dep, account: acc, type: DEPOSIT, date: 2026-01-01T10:00:00Z, amount: "10000000000000000000", currency: GBP }
fx_rates:
  - { from: GBP, to: USD, day: 2026-01-01, rate: 1 }
  - { from: GBP, to: USD, day: 2026-01-02, rate: 0.9 }
"#,
    );
    assert_bounded_cash_fx(&p, dec!(-1000000000000000000));
}

#[test]
fn opposing_cash_buckets_are_netted_before_reporting_currency_conversion() {
    let p = pipeline(
        r#"
id: CASH-FX-NET-BEFORE-BASE
policy: { base_currency: USD, timezone: UTC, as_of: 2026-01-02 }
accounts:
  - { id: acc, currency: EUR, account_type: CASH }
activities:
  - { id: cad, account: acc, type: DEPOSIT, date: 2026-01-01T10:00:00Z, amount: 1, currency: CAD }
  - { id: gbp, account: acc, type: WITHDRAWAL, date: 2026-01-01T11:00:00Z, amount: 1, currency: GBP }
fx_rates:
  - { from: CAD, to: EUR, day: 2026-01-01, rate: 1 }
  - { from: CAD, to: EUR, day: 2026-01-02, rate: 2 }
  - { from: GBP, to: EUR, day: 2026-01-01, rate: 0.9 }
  - { from: GBP, to: EUR, day: 2026-01-02, rate: 1.8 }
  - { from: EUR, to: USD, day: 2026-01-01, rate: "100000000000000000000" }
  - { from: EUR, to: USD, day: 2026-01-02, rate: "100000000000000000000" }
"#,
    );
    assert!(p.bundle.rejected_activities().is_empty());
    assert_bounded_cash_fx(&p, dec!(10000000000000000000));
}
