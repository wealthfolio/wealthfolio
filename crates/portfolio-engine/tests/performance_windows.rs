//! A bounded transaction window covering inception includes the opening day's
//! gain, just like ALL. Transaction TWR/MWR still use the stored daily endpoints.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]

mod support;

use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use support::*;
use wealthfolio_portfolio_engine::model::{
    AccountId, PerformanceResult, QualityNote, SummaryStatus, ValueStatus,
};
use wealthfolio_portfolio_engine::{measure_account, measure_scope, MeasureProfile, Window};

const REPORT: &str = r#"
id: PERFORMANCE-WINDOW-INCEPTION
policy: { base_currency: USD, timezone: UTC, as_of: 2026-10-30 }
accounts:
  - { id: acc, currency: USD }
assets:
  - { id: vt, quote_ccy: USD }
activities:
  - { id: dep, account: acc, type: DEPOSIT, date: 2026-01-30T07:12:00Z, amount: 1000 }
  - { id: buy, account: acc, type: BUY, date: 2026-01-30T07:12:00Z, asset: vt, quantity: 1, unit_price: 50, amount: 50 }
quotes:
  - { asset: vt, day: 2026-01-30, close: 145.45 }
  - { asset: vt, day: 2026-10-30, close: 157.97 }
"#;

fn pipeline(yaml: &str) -> Pipeline {
    Pipeline::from_scenario(&serde_yaml::from_str::<Scenario>(yaml).unwrap())
}

fn window(start: Option<&str>) -> Window {
    Window {
        start: start.map(|date| date.parse().unwrap()),
        end: Some("2026-10-30".parse().unwrap()),
    }
}

fn account(p: &Pipeline, id: &str, window: Window) -> PerformanceResult {
    let lots = p.lots();
    measure_account(
        &p.measure_inputs(&lots),
        &AccountId::new(id),
        window,
        MeasureProfile::Full,
        true,
    )
    .unwrap()
}

fn scope(p: &Pipeline, ids: &[&str], window: Window) -> PerformanceResult {
    let lots = p.lots();
    measure_scope(
        &p.measure_inputs(&lots),
        "portfolio",
        &ids.iter().copied().map(AccountId::new).collect::<Vec<_>>(),
        window,
        MeasureProfile::Full,
        true,
    )
    .unwrap()
}

fn assert_gain(result: &PerformanceResult, amount: Decimal) {
    assert_eq!(result.summary.amount_status, SummaryStatus::Complete);
    assert_eq!(result.summary.amount, Some(amount));
    assert_eq!(result.attribution.pnl(), amount);
    assert_eq!(result.attribution.residual, Decimal::ZERO);
    assert!(
        !result.data_quality.warnings.iter().any(|note| matches!(
            note,
            QualityNote::AttributionIncomplete { .. }
                | QualityNote::MixedAttributionUnreconciled { .. }
        )),
        "{:?}",
        result.data_quality
    );
}

#[test]
fn full_history_ranges_include_the_first_day_gain_without_changing_returns() {
    // Quotes are constructed from the reported difference, not reporter data.
    let p = pipeline(REPORT);
    for all in [
        account(&p, "acc", window(None)),
        scope(&p, &["acc"], window(None)),
    ] {
        assert_gain(&all, dec!(107.97));
        assert_eq!(all.returns.twr, Some(dec!(0.01142909)));
        for start in ["2021-10-30", "2025-10-30", "2026-01-30"] {
            for bounded in [
                account(&p, "acc", window(Some(start))),
                scope(&p, &["acc"], window(Some(start))),
            ] {
                assert_gain(&bounded, dec!(107.97));
                assert_eq!(bounded.attribution, all.attribution);
                assert_eq!(bounded.returns, all.returns);
                assert_eq!(bounded.series, all.series);
                assert_eq!(bounded.risk, all.risk);
                assert_eq!(bounded.period_start, all.period_start);
                assert_eq!(bounded.period_end, all.period_end);
            }
        }
    }
    for bounded in [
        account(&p, "acc", window(Some("2026-02-01"))),
        scope(&p, &["acc"], window(Some("2026-02-01"))),
    ] {
        assert_gain(&bounded, dec!(12.52));
        assert_eq!(bounded.attribution.contributions, Decimal::ZERO);
    }
}

#[test]
fn summaries_and_history_use_the_same_baseline_and_respect_the_end_date() {
    let p = pipeline(REPORT);
    let lots = p.lots();
    let inputs = p.measure_inputs(&lots);
    let id = AccountId::new("acc");
    for (end, expected) in [("2026-02-01", dec!(95.45)), ("2026-10-30", dec!(107.97))] {
        for start in [None, Some("2021-10-30"), Some("2026-01-30")] {
            let window = Window {
                start: start.map(|date| date.parse().unwrap()),
                end: Some(end.parse().unwrap()),
            };
            for profile in [MeasureProfile::Full, MeasureProfile::Summary] {
                for result in [
                    measure_account(&inputs, &id, window, profile, false).unwrap(),
                    measure_scope(
                        &inputs,
                        "portfolio",
                        std::slice::from_ref(&id),
                        window,
                        profile,
                        false,
                    )
                    .unwrap(),
                ] {
                    assert_gain(&result, expected);
                    assert_eq!(result.attribution.contributions, dec!(1000));
                    assert_eq!(result.period_end, window.end);
                }
            }
        }
    }
}

#[test]
fn opening_income_trade_charges_and_realized_gain_are_attributed_once() {
    let p = pipeline(
        r#"
id: PERFORMANCE-WINDOW-CHARGES
policy: { base_currency: USD, timezone: UTC, as_of: 2026-10-30 }
accounts:
  - { id: acc, currency: USD }
assets:
  - { id: vt, quote_ccy: USD }
activities:
  - { id: dep, account: acc, type: DEPOSIT, date: 2026-01-30T07:00:00Z, amount: 1000 }
  - { id: buy, account: acc, type: BUY, date: 2026-01-30T08:00:00Z, asset: vt, quantity: 2, unit_price: 50, amount: 110, fee: 6, tax: 4 }
  - { id: sell, account: acc, type: SELL, date: 2026-01-30T09:00:00Z, asset: vt, quantity: 1, unit_price: 100, amount: 97, fee: 2, tax: 1 }
  - { id: income, account: acc, type: DIVIDEND, date: 2026-01-30T10:00:00Z, asset: vt, amount: 15, tax: 5 }
quotes:
  - { asset: vt, day: 2026-01-30, close: 145.45 }
  - { asset: vt, day: 2026-10-30, close: 157.97 }
"#,
    );
    // Ending cash 1000 - 110 + 97 + 15 = 1002; security 157.97.
    for start in [None, Some("2021-10-30"), Some("2026-01-30")] {
        for result in [
            account(&p, "acc", window(start)),
            scope(&p, &["acc"], window(start)),
        ] {
            assert_gain(&result, dec!(159.97));
            assert_eq!(result.attribution.contributions, dec!(1000));
            assert_eq!(result.attribution.income, dec!(20));
            assert_eq!(result.attribution.realized_pnl, dec!(50));
            assert_eq!(result.attribution.unrealized_pnl_change, dec!(107.97));
            assert_eq!(result.attribution.fees, dec!(8));
            assert_eq!(result.attribution.taxes, dec!(10));
        }
    }
    for result in [
        account(&p, "acc", window(Some("2026-02-01"))),
        scope(&p, &["acc"], window(Some("2026-02-01"))),
    ] {
        assert_gain(&result, dec!(12.52));
        assert_eq!(result.attribution.income, Decimal::ZERO);
        assert_eq!(result.attribution.realized_pnl, Decimal::ZERO);
        assert_eq!(result.attribution.fees, Decimal::ZERO);
        assert_eq!(result.attribution.taxes, Decimal::ZERO);
    }
}

#[test]
fn staggered_accounts_do_not_double_count_later_opening_gains() {
    let p = pipeline(
        r#"
id: PERFORMANCE-WINDOW-STAGGERED
policy: { base_currency: USD, timezone: UTC, as_of: 2026-10-30 }
accounts:
  - { id: early, currency: USD }
  - { id: late, currency: USD }
assets:
  - { id: vt, quote_ccy: USD }
activities:
  - { id: dep-early, account: early, type: DEPOSIT, date: 2026-01-30T07:00:00Z, amount: 1000 }
  - { id: buy-early, account: early, type: BUY, date: 2026-01-30T08:00:00Z, asset: vt, quantity: 1, unit_price: 50, amount: 50 }
  - { id: dep-late, account: late, type: DEPOSIT, date: 2026-03-01T07:00:00Z, amount: 500 }
  - { id: buy-late, account: late, type: BUY, date: 2026-03-01T08:00:00Z, asset: vt, quantity: 1, unit_price: 100, amount: 100 }
quotes:
  - { asset: vt, day: 2026-01-30, close: 145.45 }
  - { asset: vt, day: 2026-10-30, close: 157.97 }
"#,
    );
    for start in [None, Some("2021-10-30"), Some("2026-01-30")] {
        let result = scope(&p, &["early", "late"], window(start));
        assert_gain(&result, dec!(165.94));
        assert_eq!(result.attribution.contributions, dec!(1500));
    }
    // Excludes early's opening 95.45; includes late's full 57.97 once.
    let within = scope(&p, &["early", "late"], window(Some("2026-02-01")));
    assert_gain(&within, dec!(70.49));
    assert_eq!(within.attribution.contributions, dec!(500));
    // A selected subset must use its own inception, not other accounts'.
    for start in ["2026-02-01", "2026-03-01"] {
        assert_gain(&scope(&p, &["late"], window(Some(start))), dec!(57.97));
    }
}

#[test]
fn mixed_scopes_fix_transaction_components_and_keep_holdings_rules() {
    let p = pipeline(
        r#"
id: PERFORMANCE-WINDOW-MIXED
policy: { base_currency: USD, timezone: UTC, as_of: 2026-10-30 }
accounts:
  - { id: acc, currency: USD }
  - { id: holdings, currency: USD, tracking_mode: HOLDINGS }
assets:
  - { id: vt, quote_ccy: USD }
  - { id: held, quote_ccy: USD }
activities:
  - { id: dep, account: acc, type: DEPOSIT, date: 2026-01-30T07:00:00Z, amount: 1000 }
  - { id: buy, account: acc, type: BUY, date: 2026-01-30T08:00:00Z, asset: vt, quantity: 1, unit_price: 50, amount: 50 }
quotes:
  - { asset: vt, day: 2026-01-30, close: 145.45 }
  - { asset: vt, day: 2026-10-30, close: 157.97 }
  - { asset: held, day: 2026-01-01, close: 200 }
  - { asset: held, day: 2026-10-30, close: 220 }
observed_snapshots:
  - { account: holdings, date: 2026-01-01, positions: [{ asset: held, quantity: 1, average_cost: 100 }], cash: {} }
"#,
    );
    let all = scope(&p, &["acc", "holdings"], window(None));
    assert_gain(&all, dec!(227.97)); // 107.97 transaction + 120 book gain.
    for start in ["2021-10-30", "2026-01-30"] {
        let bounded = scope(&p, &["acc", "holdings"], window(Some(start)));
        assert_gain(&bounded, dec!(127.97)); // 107.97 + 20 period gain.
        assert_eq!(bounded.attribution.contributions, dec!(1000));
        assert_eq!(bounded.returns.twr, None);
        assert_eq!(bounded.returns.irr, None);
        assert_eq!(bounded.returns.value_return, Some(dec!(0.09878421)));
    }
    assert_gain(
        &scope(&p, &["acc", "holdings"], window(Some("2026-02-01"))),
        dec!(32.52),
    );
    // Holdings-only retains the existing book-basis vs period distinction.
    assert_eq!(
        account(&p, "holdings", window(None)).summary.amount,
        Some(dec!(120))
    );
    for start in ["2021-10-30", "2026-01-01"] {
        assert_eq!(
            account(&p, "holdings", window(Some(start))).summary.amount,
            Some(dec!(20))
        );
        assert_eq!(
            scope(&p, &["holdings"], window(Some(start))).summary.amount,
            Some(dec!(20))
        );
    }
}

#[test]
fn inception_selection_preserves_unavailable_and_missing_history() {
    for first in [true, false] {
        let mut p = pipeline(REPORT);
        let days = &mut p.series.get_mut(&AccountId::new("acc")).unwrap().days;
        let index = if first { 0 } else { days.len() - 1 };
        days[index].value_status = ValueStatus::Unavailable;
        for result in [
            account(&p, "acc", window(Some("2021-10-30"))),
            scope(&p, &["acc"], window(Some("2021-10-30"))),
        ] {
            assert_eq!(result.summary.amount_status, SummaryStatus::Unavailable);
            assert_eq!(result.summary.amount, None);
            assert_eq!(result.returns.twr, None);
        }
    }
    let mut p = pipeline(REPORT);
    p.series.clear();
    for result in [
        account(&p, "acc", window(Some("2021-10-30"))),
        scope(&p, &["acc"], window(Some("2021-10-30"))),
    ] {
        assert_eq!(result.summary.amount_status, SummaryStatus::Unavailable);
        assert_eq!(result.summary.amount, None);
    }
}

#[test]
fn dashboard_keeps_its_existing_endpoint_value_change() {
    let p = pipeline(REPORT);
    let lots = p.lots();
    let inputs = p.measure_inputs(&lots);
    let id = AccountId::new("acc");
    for start in [None, Some("2021-10-30"), Some("2026-01-30")] {
        for result in [
            measure_account(
                &inputs,
                &id,
                window(start),
                MeasureProfile::Dashboard,
                false,
            )
            .unwrap(),
            measure_scope(
                &inputs,
                "portfolio",
                std::slice::from_ref(&id),
                window(start),
                MeasureProfile::Dashboard,
                false,
            )
            .unwrap(),
        ] {
            assert_eq!(result.summary.amount, Some(dec!(12.52)));
        }
    }
}
