//! A bounded transaction window covering inception includes the opening day's
//! gain, just like ALL. Transaction TWR/MWR still use the stored daily endpoints.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]

mod support;

use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use support::*;
use wealthfolio_portfolio_engine::model::{
    AccountId, ActivityId, Amounts, AmountsPart, Currency, FlowKnowledge, PerformanceResult,
    QualityNote, SummaryStatus, TrackingMode, UnclassifiedTransfer, ValueStatus,
};
use wealthfolio_portfolio_engine::{
    measure_account, measure_scope, scope_cash_flows, MeasureProfile, Window,
};

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
        assert_eq!(all.returns.twr.period, Some(dec!(0.01142909)));
        for start in ["2021-10-30", "2025-10-30", "2026-01-30"] {
            for bounded in [
                account(&p, "acc", window(Some(start))),
                scope(&p, &["acc"], window(Some(start))),
            ] {
                assert_gain(&bounded, dec!(107.97));
                assert_eq!(bounded.attribution, all.attribution);
                assert_eq!(bounded.returns, all.returns);
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
                                     // Jan15 starts after holdings inception but before transaction inception.
    for start in ["2021-10-30", "2026-01-15", "2026-01-30"] {
        let bounded = scope(&p, &["acc", "holdings"], window(Some(start)));
        assert_gain(&bounded, dec!(127.97)); // 107.97 + 20 period gain.
        assert_eq!(bounded.attribution.contributions, dec!(1000));
        // A holdings account has no recorded deposits or withdrawals, so the
        // scope has neither a time-weighted nor a money-weighted return.
        assert_eq!(bounded.returns.twr.period, None);
        assert_eq!(bounded.returns.money_weighted.period, None);
        assert_eq!(
            bounded.returns.money_weighted.unavailable_reason,
            Some(QualityNote::MixedMoneyWeightedNotApplicable)
        );
        // Its one figure is ROI: (107.97 + 20) gain over (1000 contributed +
        // 200 holdings opening value) of capital, with no yearly rate.
        let roi = &bounded.returns.return_on_cost;
        assert_eq!(roi.period, Some(dec!(0.10664167)));
        assert_eq!(roi.annualized, None);
        assert!(roi.series.is_empty());
        assert!(bounded
            .data_quality
            .warnings
            .contains(&QualityNote::MixedSeriesUnavailable));
    }
    let within = scope(&p, &["acc", "holdings"], window(Some("2026-02-01")));
    assert_gain(&within, dec!(32.52));
    assert_eq!(
        within
            .returns
            .return_on_cost
            .series
            .last()
            .map(|point| point.value),
        within.returns.return_on_cost.period
    );
    assert!(!within
        .data_quality
        .warnings
        .contains(&QualityNote::MixedSeriesUnavailable));
    let lots = p.lots();
    let inputs = p.measure_inputs(&lots);
    let ids = [AccountId::new("acc"), AccountId::new("holdings")];
    for profile in [
        MeasureProfile::Full,
        MeasureProfile::Summary,
        MeasureProfile::Dashboard,
    ] {
        // Every profile counts the transactions' first-day gain when they
        // begin inside the window, so the Dashboard matches the account page.
        // A gain measured from inception cannot be drawn as a bounded series.
        let result = measure_scope(
            &inputs,
            "portfolio",
            &ids,
            window(Some("2026-01-15")),
            profile,
            profile == MeasureProfile::Dashboard,
        )
        .unwrap();
        assert_gain(&result, dec!(127.97));
        assert!(result.returns.return_on_cost.series.is_empty());
        assert_eq!(
            result
                .data_quality
                .warnings
                .contains(&QualityNote::MixedSeriesUnavailable),
            profile == MeasureProfile::Dashboard,
            "{profile:?}: only a series request reports the missing series"
        );
    }
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
            assert_eq!(result.returns.twr.period, None);
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
fn dashboard_counts_the_first_days_gain_like_the_account_page() {
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
            // 107.97 earned on the 1000 deposited, including the first day's
            // 95.45, as the full calculation reports it.
            assert_eq!(result.summary.amount, Some(dec!(107.97)));
        }
    }
}

#[test]
fn scope_cash_flows_follow_the_money_weighted_opening() {
    let mut p = pipeline(
        r#"
id: PERFORMANCE-WINDOW-REPLAY
policy: { base_currency: USD, timezone: UTC, as_of: 2026-10-30 }
accounts:
  - { id: acc, currency: USD }
assets:
  - { id: vt, quote_ccy: USD }
activities:
  - { id: dep, account: acc, type: DEPOSIT, date: 2026-01-30T07:00:00Z, amount: 1000 }
  - { id: buy, account: acc, type: BUY, date: 2026-01-30T08:00:00Z, asset: vt, quantity: 1, unit_price: 50, amount: 50 }
  - { id: dep2, account: acc, type: DEPOSIT, date: 2026-03-02T07:00:00Z, amount: 500 }
quotes:
  - { asset: vt, day: 2026-01-30, close: 145.45 }
  - { asset: vt, day: 2026-10-30, close: 157.97 }
"#,
    );
    let lots = p.lots();
    let inputs = p.measure_inputs(&lots);
    let ids = [AccountId::new("acc")];
    let day = |date: &str| date.parse::<chrono::NaiveDate>().unwrap();

    // From inception: the money contributed by the first close.
    let all = scope_cash_flows(&inputs, &ids, window(None))
        .unwrap()
        .unwrap();
    assert_eq!(all.opening_date, day("2026-01-30"));
    assert_eq!(all.opening_capital, dec!(1000));
    assert_eq!(all.flows, vec![(day("2026-03-02"), dec!(500), dec!(0))]);

    // After inception: the first close of the window (950 cash + 145.45).
    let later = scope_cash_flows(&inputs, &ids, window(Some("2026-02-15")))
        .unwrap()
        .unwrap();
    assert_eq!(later.opening_date, day("2026-02-15"));
    assert_eq!(later.opening_capital, dec!(1095.45));
    assert_eq!(later.flows, all.flows);

    // An unvalued opening close is not capital to replay: the scope's own
    // money-weighted return is unavailable there too.
    let days = &mut p.series.get_mut(&ids[0]).unwrap().days;
    let opening = days
        .iter()
        .position(|d| d.date == day("2026-02-15"))
        .unwrap();
    days[opening].value_status = ValueStatus::Unavailable;
    let lots = p.lots();
    let inputs = p.measure_inputs(&lots);
    let window = window(Some("2026-02-15"));
    assert_eq!(scope_cash_flows(&inputs, &ids, window).unwrap(), None);
    assert_eq!(
        measure_scope(&inputs, "acc", &ids, window, MeasureProfile::Full, false)
            .unwrap()
            .returns
            .money_weighted
            .period,
        None
    );
}

const MIXED: &str = r#"
id: PERFORMANCE-AMOUNTS-MIXED
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
"#;

#[test]
fn the_amounts_behind_a_return_add_up_for_each_kind_of_scope() {
    let p = pipeline(MIXED);
    // A transactions account from inception: it opens empty, and the deposit
    // is the money in.
    assert_eq!(
        account(&p, "acc", window(None)).amounts,
        Amounts {
            start_date: None,
            start_value: Some(dec!(0)),
            money_in: Some(dec!(1000)),
            money_out: Some(dec!(0)),
            gain: Some(dec!(107.97)),
            end_value: Some(dec!(1107.97)),
            capital: None,
            flows: FlowKnowledge::Confirmed,
            parts: vec![],
        }
    );
    // A later window opens on what the account held: 950 cash and one share.
    assert_eq!(
        account(&p, "acc", window(Some("2026-02-01"))).amounts,
        Amounts {
            start_date: None,
            start_value: Some(dec!(1095.45)),
            money_in: Some(dec!(0)),
            money_out: Some(dec!(0)),
            gain: Some(dec!(12.52)),
            end_value: Some(dec!(1107.97)),
            capital: None,
            flows: FlowKnowledge::Confirmed,
            parts: vec![],
        }
    );
    // A holdings account over its full history: gain on what the position
    // cost, with no opening value and no dated flows.
    assert_eq!(
        account(&p, "holdings", window(None)).amounts,
        Amounts {
            gain: Some(dec!(120)),
            end_value: Some(dec!(220)),
            capital: Some(dec!(100)),
            flows: FlowKnowledge::Inferred,
            ..Amounts::default()
        }
    );
    // Over a window its flows are read from the snapshots: inferred.
    assert_eq!(
        account(&p, "holdings", window(Some("2026-02-01"))).amounts,
        Amounts {
            start_date: None,
            start_value: Some(dec!(200)),
            money_in: Some(dec!(0)),
            money_out: Some(dec!(0)),
            gain: Some(dec!(20)),
            end_value: Some(dec!(220)),
            capital: None,
            flows: FlowKnowledge::Inferred,
            parts: vec![],
        }
    );
}

#[test]
fn a_mixed_scope_shows_the_gain_and_capital_of_its_two_halves() {
    let p = pipeline(MIXED);
    let part = |tracking, gain, capital| AmountsPart {
        tracking,
        gain,
        capital,
    };
    let within = scope(&p, &["acc", "holdings"], window(Some("2026-02-01")));
    assert_eq!(
        within.amounts,
        Amounts {
            start_date: None,
            start_value: Some(dec!(1295.45)),
            money_in: Some(dec!(0)),
            money_out: Some(dec!(0)),
            gain: Some(dec!(32.52)),
            end_value: Some(dec!(1327.97)),
            capital: Some(dec!(1295.45)),
            flows: FlowKnowledge::Inferred,
            parts: vec![
                part(TrackingMode::Transactions, dec!(12.52), dec!(1095.45)),
                part(TrackingMode::Holdings, dec!(20), dec!(200)),
            ],
        }
    );
    // The ROI is the two halves added up.
    assert_eq!(
        within.returns.return_on_cost.period,
        Some((dec!(32.52) / dec!(1295.45)).round_dp(8))
    );
    // Over the full history the holdings half has no opening value or flows,
    // so the scope has none either: gain and capital only.
    let all = scope(&p, &["acc", "holdings"], window(None));
    assert_eq!(
        all.amounts,
        Amounts {
            gain: Some(dec!(227.97)),
            end_value: Some(dec!(1327.97)),
            capital: Some(dec!(1100)),
            flows: FlowKnowledge::Inferred,
            parts: vec![
                part(TrackingMode::Transactions, dec!(107.97), dec!(1000)),
                part(TrackingMode::Holdings, dec!(120), dec!(100)),
            ],
            ..Amounts::default()
        }
    );
}

#[test]
fn a_mixed_scope_curve_ends_on_its_headline() {
    // The transactions account doubles and is emptied a day into the window,
    // so its average capital is negative (100 − 200 × 9/10 = −80). The curve
    // counts it as the headline does: 100 over 1,000 − 80.
    let p = pipeline(
        r#"
id: PERFORMANCE-MIXED-CURVE
policy: { base_currency: USD, timezone: UTC, as_of: 2026-02-11 }
accounts:
  - { id: acc, currency: USD }
  - { id: holdings, currency: USD, tracking_mode: HOLDINGS }
assets:
  - { id: vt, quote_ccy: USD }
  - { id: held, quote_ccy: USD }
activities:
  - { id: dep, account: acc, type: DEPOSIT, date: 2026-01-20T07:00:00Z, amount: 100 }
  - { id: buy, account: acc, type: BUY, date: 2026-01-20T08:00:00Z, asset: vt, quantity: 1, unit_price: 100, amount: 100 }
  - { id: sell, account: acc, type: SELL, date: 2026-02-02T08:00:00Z, asset: vt, quantity: 1, unit_price: 200, amount: 200 }
  - { id: wd, account: acc, type: WITHDRAWAL, date: 2026-02-02T09:00:00Z, amount: 200 }
quotes:
  - { asset: vt, day: 2026-01-20, close: 100 }
  - { asset: vt, day: 2026-02-01, close: 100 }
  - { asset: vt, day: 2026-02-02, close: 200 }
  - { asset: held, day: 2026-01-01, close: 1000 }
  - { asset: held, day: 2026-02-11, close: 1000 }
observed_snapshots:
  - { account: holdings, date: 2026-01-01, positions: [{ asset: held, quantity: 1, average_cost: 1000 }], cash: {} }
"#,
    );
    let emptied = scope(
        &p,
        &["acc", "holdings"],
        Window {
            start: Some("2026-02-01".parse().unwrap()),
            end: Some("2026-02-11".parse().unwrap()),
        },
    );
    assert_eq!(emptied.amounts.capital, Some(dec!(920)));
    assert_eq!(
        emptied.returns.return_on_cost.period,
        Some((dec!(100) / dec!(920)).round_dp(8))
    );
    let steady = scope(
        &pipeline(MIXED),
        &["acc", "holdings"],
        window(Some("2026-02-01")),
    );
    for result in [emptied, steady] {
        let roi = &result.returns.return_on_cost;
        assert!(roi.period.is_some());
        assert_eq!(roi.series.last().map(|point| point.value), roi.period);
    }
}

#[test]
fn income_before_the_first_deposit_is_not_a_gain_on_it() {
    // A savings account is credited interest for months before any money is
    // put in. Neither method has capital to measure on until the deposit:
    // over the full history both open on the close before it, on the 508.50
    // the account holds then, exactly as a period dated from that close.
    let p = pipeline(
        r#"
id: PERFORMANCE-INCOME-BEFORE-FUNDING
policy: { base_currency: USD, timezone: UTC, as_of: 2026-11-20 }
accounts:
  - { id: savings, currency: USD }
activities:
  - { id: int-1, account: savings, type: INTEREST, date: 2023-06-30T10:00:00Z, amount: 85.50 }
  - { id: int-2, account: savings, type: INTEREST, date: 2024-06-30T10:00:00Z, amount: 423 }
  - { id: dep, account: savings, type: DEPOSIT, date: 2025-02-04T10:00:00Z, amount: 20000 }
  - { id: int-3, account: savings, type: INTEREST, date: 2026-02-04T10:00:00Z, amount: 700 }
"#,
    );
    let window = |start: Option<&str>| Window {
        start: start.map(|date| date.parse().unwrap()),
        end: Some("2026-11-20".parse().unwrap()),
    };
    let funded = "2025-02-03".parse::<chrono::NaiveDate>().unwrap();
    let all = account(&p, "savings", window(None));
    let dated = account(&p, "savings", window(Some("2025-02-03")));

    // 700 earned on 20,508.50: about 3.4 %, by either method.
    let earned = (dec!(700) / dec!(20508.50)).round_dp(8);
    assert_eq!(all.returns.twr.period, Some(earned));
    assert_eq!(all.returns.money_weighted.period, Some(earned));
    assert_eq!(
        all.returns.money_weighted.period,
        dated.returns.money_weighted.period
    );
    assert_eq!(
        all.returns.money_weighted.annualized,
        dated.returns.money_weighted.annualized
    );
    // No point of the curve leaves that range: before the deposit it is 0.
    assert!(all
        .returns
        .money_weighted
        .series
        .iter()
        .all(|point| point.value >= dec!(0) && point.value <= earned));
    // The amounts open on the same close, and add up to the end value.
    assert_eq!(
        all.amounts,
        Amounts {
            start_date: Some(funded),
            start_value: Some(dec!(508.50)),
            money_in: Some(dec!(20000)),
            money_out: Some(dec!(0)),
            gain: Some(dec!(700)),
            end_value: Some(dec!(21208.50)),
            capital: None,
            flows: FlowKnowledge::Confirmed,
            parts: vec![],
        }
    );
    assert_eq!(
        dated.amounts,
        Amounts {
            start_date: None,
            ..all.amounts.clone()
        }
    );
    // The period, and the gain shown for it, still cover the whole history.
    assert_eq!(all.period_start, Some("2023-06-30".parse().unwrap()));
    assert_gain(&all, dec!(1208.50));

    // A benchmark replays the same money from the same close.
    let lots = p.lots();
    let inputs = p.measure_inputs(&lots);
    let ids = [AccountId::new("savings")];
    let replay = scope_cash_flows(&inputs, &ids, window(None))
        .unwrap()
        .unwrap();
    assert_eq!(replay.opening_date, funded);
    assert_eq!(replay.opening_capital, dec!(508.50));
    assert_eq!(
        replay.flows,
        vec![("2025-02-04".parse().unwrap(), dec!(20000), dec!(0))]
    );
}

#[test]
fn an_unvalued_day_in_one_account_puts_no_dip_in_a_mixed_curve() {
    // The transactions account cannot be valued on one day in the middle
    // (its row carries zero): it holds its last gain and capital that day.
    let mut p = pipeline(MIXED);
    let gap = "2026-06-15".parse::<chrono::NaiveDate>().unwrap();
    let day = p
        .series
        .get_mut(&AccountId::new("acc"))
        .unwrap()
        .days
        .iter_mut()
        .find(|day| day.date == gap)
        .unwrap();
    day.value_status = ValueStatus::Unavailable;
    day.total_value_base = dec!(0);
    let roi = scope(&p, &["acc", "holdings"], window(Some("2026-02-01")))
        .returns
        .return_on_cost;
    let at = |date| {
        roi.series
            .iter()
            .find(|point| point.date == date)
            .map(|point| point.value)
    };
    assert!(at(gap).is_some());
    assert_eq!(at(gap), at(gap.pred_opt().unwrap()));
    assert_eq!(roi.series.last().map(|point| point.value), roi.period);
}

#[test]
fn a_transfer_with_no_known_boundary_is_named_where_it_withholds_a_return() {
    let p = pipeline(
        r#"
id: PERFORMANCE-UNCLASSIFIED-TRANSFER
policy: { base_currency: USD, timezone: UTC, as_of: 2025-01-08 }
accounts:
  - { id: acc-a, currency: USD }
  - { id: acc-b, currency: USD }
activities:
  - { id: dep-a, account: acc-a, type: DEPOSIT, date: 2025-01-02T10:00:00Z, amount: 1000 }
  - { id: tin-a, account: acc-a, type: TRANSFER_IN, date: 2025-01-04T10:00:00Z, amount: 200 }
  - { id: dep-b, account: acc-b, type: DEPOSIT, date: 2025-01-02T11:00:00Z, amount: 1000 }
"#,
    );
    let window = |start: Option<&str>| Window {
        start: start.map(|date| date.parse().unwrap()),
        end: Some("2025-01-08".parse().unwrap()),
    };
    let transfer = UnclassifiedTransfer {
        activity: ActivityId::new("tin-a"),
        account: AccountId::new("acc-a"),
        date: "2025-01-04".parse().unwrap(),
        amount: Some(dec!(200)),
        currency: Currency::parse("USD").unwrap(),
        outflow: false,
    };
    for (result, end_value) in [
        (account(&p, "acc-a", window(None)), dec!(1200)),
        (scope(&p, &["acc-a", "acc-b"], window(None)), dec!(2200)),
    ] {
        assert_eq!(result.unclassified_transfers, vec![transfer.clone()]);
        assert_eq!(result.returns.twr.period, None);
        assert_eq!(result.returns.money_weighted.period, None);
        // The money in cannot be totalled, so neither can the gain.
        assert_eq!(result.amounts.flows, FlowKnowledge::Missing);
        assert_eq!(result.amounts.money_in, None);
        assert_eq!(result.amounts.gain, None);
        assert_eq!(result.amounts.end_value, Some(end_value));
    }
    // The other account is untouched, and so is a window that opens after it.
    assert!(account(&p, "acc-b", window(None))
        .unclassified_transfers
        .is_empty());
    let after = account(&p, "acc-a", window(Some("2025-01-04")));
    assert!(after.unclassified_transfers.is_empty());
    assert_eq!(after.returns.twr.period, Some(dec!(0)));
    assert_eq!(after.amounts.flows, FlowKnowledge::Confirmed);
}
