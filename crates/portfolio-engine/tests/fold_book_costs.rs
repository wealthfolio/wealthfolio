//! The fold recomputes book costs only for the positions a day's activities
//! touch; an unchanged position keeps its figures, except when its conversion
//! failed, which is reported again on every activity day as before.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]

mod support;

use support::*;
use wealthfolio_portfolio_engine::model::*;

#[test]
fn a_failed_book_cost_conversion_is_reported_on_every_activity_day() {
    let scenario = load_all_scenarios()
        .into_iter()
        .find(|s| s.id == "EDGE-CCY-02")
        .expect("EDGE-CCY-02 scenario");
    // acc-lower buys a `gbp`-quoted asset no rate converts on 01-03; a
    // deposit on 01-06 leaves the position untouched.
    let mut raw = scenario.raw_facts();
    let mut deposit = raw
        .activities
        .iter()
        .find(|a| a.id == "dep-lower")
        .expect("dep-lower")
        .clone();
    deposit.id = "dep-lower-2".to_string();
    deposit.timestamp += chrono::Duration::days(4);
    raw.activities.push(deposit);
    let pipeline = Pipeline::run(raw).expect("pipeline");

    let reported = pipeline
        .bundle
        .diagnostics
        .iter()
        .filter(|d| d.source == "lower-asset" && d.message.ends_with("book cost excluded"))
        .count();
    assert_eq!(reported, 2, "reported on 01-03 and again on 01-06");

    let frames = &pipeline.bundle.keyframes[&AccountId::new("acc-lower")];
    let cost = |day: &str| {
        frames
            .iter()
            .find(|f| f.date.to_string() == day)
            .map(|f| f.state.cost_basis)
            .unwrap_or_else(|| panic!("keyframe on {day}"))
    };
    assert_eq!(cost("2025-01-06"), cost("2025-01-03"));
}
