#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]

mod support;

use chrono::NaiveDate;
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use support::{load_all_scenarios, Dec, FxRateSpec, Pipeline, Scenario};
use wealthfolio_portfolio_engine::model::{
    AccountId, FlowSource, QualityStatus, SummaryStatus, TrackingMode, ValueStatus,
};
use wealthfolio_portfolio_engine::{
    aggregate_scope, measure_account, measure_scope, DiagnosticCode, MeasureProfile, Window,
};

fn fixture(id: &str) -> Scenario {
    load_all_scenarios()
        .into_iter()
        .find(|scenario| scenario.id == id)
        .unwrap_or_else(|| panic!("{id} fixture"))
}

fn day(number: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(2025, 1, number).unwrap()
}

fn measure_account_with_series(
    pipeline: &Pipeline,
    account: &AccountId,
) -> wealthfolio_portfolio_engine::model::PerformanceResult {
    let lots = pipeline.lots();
    let inputs = pipeline.measure_inputs(&lots);
    measure_account(
        &inputs,
        account,
        Window::default(),
        MeasureProfile::Full,
        true,
    )
    .unwrap()
}

#[test]
fn future_only_and_stale_fx_are_unavailable_through_measurement() {
    let stale = Pipeline::from_scenario(&fixture("EDGE-FX-07"));
    let account = AccountId::new("acc-1");
    let stale_series = &stale.series[&account];
    assert!(!stale_series.days.is_empty());
    assert!(stale_series
        .days
        .iter()
        .all(|day| day.value_status == ValueStatus::Unavailable));
    assert!(stale_series
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == DiagnosticCode::FxUnavailable));

    let stale_result = measure_account_with_series(&stale, &account);
    assert!(stale_result.returns.twr.is_none());
    assert!(stale_result.returns.value_return.is_none());
    assert_eq!(
        stale_result.summary.percent_status,
        SummaryStatus::Unavailable
    );
    assert_ne!(stale_result.data_quality.status, QualityStatus::Ok);
    assert!(
        stale_result.series.is_empty(),
        "an unavailable return must not be represented by a zero-valued curve"
    );

    let mut future_only = fixture("EDGE-FX-03");
    future_only.fx_rates.retain(|rate| rate.day > day(6));
    let future_only = Pipeline::from_scenario(&future_only);
    let future_series = &future_only.series[&account];
    assert!(future_series
        .days
        .iter()
        .any(|day| day.value_status == ValueStatus::Unavailable));
    assert!(future_series
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == DiagnosticCode::FxUnavailable));

    let future_result = measure_account_with_series(&future_only, &account);
    assert!(future_result.returns.twr.is_none());
    assert_eq!(
        future_result.summary.percent_status,
        SummaryStatus::Unavailable
    );
    assert!(future_result.series.is_empty());
}

#[test]
fn appending_a_future_fx_observation_preserves_prior_values_and_curve() {
    let mut before = fixture("EDGE-FX-03");
    let future = before
        .fx_rates
        .iter()
        .find(|rate| rate.day == day(11))
        .cloned()
        .expect("future FX observation");
    before.fx_rates.retain(|rate| rate.day != day(11));
    let mut after = before.clone();
    after.fx_rates.push(future);

    let before = Pipeline::from_scenario(&before);
    let after = Pipeline::from_scenario(&after);
    let account = AccountId::new("acc-1");
    let before_days = &before.series[&account].days;
    let after_days = &after.series[&account].days;
    let prefix_before: Vec<_> = before_days
        .iter()
        .filter(|value| value.date <= day(10))
        .map(|value| (value.date, value.total_value_base, value.value_status))
        .collect();
    let prefix_after: Vec<_> = after_days
        .iter()
        .filter(|value| value.date <= day(10))
        .map(|value| (value.date, value.total_value_base, value.value_status))
        .collect();
    assert_eq!(prefix_before, prefix_after);

    let before_result = measure_account_with_series(&before, &account);
    let after_result = measure_account_with_series(&after, &account);
    let curve_before: Vec<_> = before_result
        .series
        .iter()
        .filter(|point| point.date <= day(10))
        .cloned()
        .collect();
    let curve_after: Vec<_> = after_result
        .series
        .iter()
        .filter(|point| point.date <= day(10))
        .cloned()
        .collect();
    assert_eq!(curve_before, curve_after);
    assert_ne!(before_result.returns.twr, after_result.returns.twr);
}

#[test]
fn mixed_currency_scope_aggregation_sums_converted_account_rows() {
    let mut scenario = fixture("NOM-MIX-01");
    scenario
        .activities
        .retain(|activity| activity.id != "out-1" && activity.id != "in-1");
    scenario
        .accounts
        .iter_mut()
        .find(|account| account.id == "acc-b")
        .expect("CAD account")
        .currency = "CAD".to_string();
    scenario.fx_rates = [
        (day(2), dec!(0.70)),
        (day(6), dec!(0.72)),
        (day(9), dec!(0.73)),
        (day(12), dec!(0.74)),
    ]
    .into_iter()
    .map(|(day, rate)| FxRateSpec {
        from: "CAD".to_string(),
        to: "USD".to_string(),
        day,
        rate: Dec(rate),
        source: "MANUAL".to_string(),
    })
    .collect();
    let pipeline = Pipeline::from_scenario(&scenario);
    let lots = pipeline.lots();
    let inputs = pipeline.measure_inputs(&lots);
    let scope = pipeline.portfolio_scope();
    assert!(scope.iter().any(|id| {
        inputs
            .effects
            .account(id)
            .is_some_and(|account| account.currency.as_str() == "CAD")
    }));
    assert!(scope.iter().any(|id| {
        inputs
            .effects
            .account(id)
            .is_some_and(|account| account.tracking == TrackingMode::Holdings)
    }));

    let aggregate = aggregate_scope(&inputs.effects, inputs.series, &scope, Window::default())
        .expect("mixed-currency aggregate");
    let first_date = aggregate.days.first().map(|value| value.date);
    for day in &aggregate.days {
        let sum = scope
            .iter()
            .map(|account| {
                pipeline.series[account]
                    .days
                    .iter()
                    .find(|value| value.date == day.date)
                    .expect("account valuation date")
                    .total_value_base
            })
            .sum::<Decimal>();
        assert_eq!(day.total_value_base, sum, "aggregate on {}", day.date);
        if Some(day.date) != first_date {
            let inflow = scope
                .iter()
                .map(|account| {
                    pipeline.series[account]
                        .days
                        .iter()
                        .find(|value| value.date == day.date)
                        .expect("account flow date")
                        .flow
                        .inflow_base
                })
                .sum::<Decimal>();
            assert_eq!(
                day.flow.inflow_base, inflow,
                "flow aggregate on {}",
                day.date
            );
        }
    }
    let measured = measure_scope(
        &inputs,
        "portfolio",
        &scope,
        Window::default(),
        MeasureProfile::Full,
        true,
    )
    .unwrap();
    assert!(measured.is_mixed_tracking_mode);
    assert!(measured.returns.value_return.is_some());
}

#[test]
fn idle_foreign_account_without_fx_does_not_degrade_active_scope() {
    let mut scenario = fixture("EDGE-FX-03");
    scenario
        .accounts
        .push(serde_yaml::from_str("{ id: idle, currency: GBP }").unwrap());
    let pipeline = Pipeline::from_scenario(&scenario);
    let idle = &pipeline.series[&AccountId::new("idle")];
    assert!(idle
        .days
        .iter()
        .all(|day| day.value_status == ValueStatus::Unavailable));
    let lots = pipeline.lots();
    let inputs = pipeline.measure_inputs(&lots);
    let aggregate = aggregate_scope(
        &inputs.effects,
        inputs.series,
        &pipeline.portfolio_scope(),
        Window::default(),
    )
    .unwrap();
    assert!(!aggregate.days.is_empty());
    assert!(aggregate
        .days
        .iter()
        .all(|day| day.value_status == ValueStatus::Complete));
}

#[test]
fn paired_transfer_without_acquisition_fx_does_not_invent_a_receiver_flow() {
    let mut scenario = fixture("EDGE-TXF-16");
    scenario
        .activities
        .retain(|activity| activity.id != "short-1");
    // A transfer-day rate cannot supply the missing acquisition-date basis.
    scenario.fx_rates.retain(|rate| rate.day == day(8));
    let pipeline = Pipeline::from_scenario(&scenario);
    let lots = pipeline.lots();
    let inputs = pipeline.measure_inputs(&lots);
    let incoming = inputs
        .effects
        .events
        .iter()
        .find(|event| event.source.as_str() == "in-1")
        .and_then(|event| event.flow)
        .expect("incoming transfer flow");
    assert_eq!(incoming.amount, Decimal::ZERO);
    assert_eq!(incoming.source, FlowSource::Unknown);
}

#[test]
fn recovered_fx_endpoints_do_not_hide_an_unavailable_gap_in_the_curve() {
    let mut scenario = fixture("EDGE-FX-03");
    scenario.policy.as_of = day(20);
    scenario.fx_rates.retain(|rate| rate.day == day(6));
    scenario.fx_rates.push(FxRateSpec {
        from: "CAD".to_string(),
        to: "USD".to_string(),
        day: day(20),
        rate: Dec(dec!(0.80)),
        source: "MANUAL".to_string(),
    });
    let pipeline = Pipeline::from_scenario(&scenario);
    let account = AccountId::new("acc-1");
    let days = &pipeline.series[&account].days;
    assert_eq!(days.first().unwrap().value_status, ValueStatus::Complete);
    assert_eq!(days.last().unwrap().value_status, ValueStatus::Complete);
    assert!(days
        .iter()
        .any(|day| day.value_status == ValueStatus::Unavailable));
    let result = measure_account_with_series(&pipeline, &account);
    assert!(result.returns.twr.is_none());
    assert!(result.series.is_empty());
}

#[test]
fn mixed_scope_does_not_treat_an_unknown_transaction_flow_as_zero_gain() {
    let mut scenario = fixture("NOM-MIX-01");
    scenario
        .activities
        .retain(|activity| activity.id != "out-1" && activity.id != "in-1");
    let mut pipeline = Pipeline::from_scenario(&scenario);
    pipeline
        .series
        .get_mut(&AccountId::new("acc-a"))
        .unwrap()
        .days[1]
        .flow
        .source = FlowSource::Unknown;
    let lots = pipeline.lots();
    let inputs = pipeline.measure_inputs(&lots);
    let result = measure_scope(
        &inputs,
        "portfolio",
        &pipeline.portfolio_scope(),
        Window::default(),
        MeasureProfile::Full,
        true,
    )
    .unwrap();
    assert!(result.is_mixed_tracking_mode);
    assert!(result.returns.value_return.is_none());
    assert_eq!(result.summary.percent_status, SummaryStatus::Unavailable);
    assert_eq!(result.summary.amount_status, SummaryStatus::Unavailable);
    assert!(result.summary.amount.is_none());
}
