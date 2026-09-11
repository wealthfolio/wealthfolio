//! Property suite (architecture §5) driven by the fixture corpus: every scenario is
//! a generator seed, and each law is checked over all of them.

mod support;

use std::collections::{BTreeMap, BTreeSet};

use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde_json::Value;
use support::*;
use wealthfolio_portfolio_engine::diagnostics::DiagnosticCode;
use wealthfolio_portfolio_engine::model::*;
use wealthfolio_portfolio_engine::value::{ValueInputs, Window};
use wealthfolio_portfolio_engine::{aggregate_scope, project};

const DUST: Decimal = Decimal::from_parts(1, 0, 0, false, 8);

fn corpus() -> Vec<Scenario> {
    load_all_scenarios()
        .into_iter()
        .filter(|s| !s.markers.iter().any(|m| m == "S") && scenario_selected(&s.id))
        .collect()
}

fn body(pipeline: &Pipeline, scenario: &Scenario) -> Value {
    capture_body(pipeline, &all_windows(scenario))
}

fn assert_same(id: &str, law: &str, left: &Value, right: &Value) {
    let mut differences = Vec::new();
    diff_values("", left, right, &mut differences);
    assert!(
        differences.is_empty(),
        "{id}: {law} violated:\n  {}",
        differences.join("\n  ")
    );
}

/// P-DET (I3): input vector order never changes an output.
#[test]
fn p_det_input_order_is_irrelevant() {
    for scenario in corpus() {
        let reference = body(&Pipeline::from_scenario(&scenario), &scenario);
        let mut raw = scenario.raw_facts();
        raw.accounts.reverse();
        raw.assets.reverse();
        raw.activities.reverse();
        raw.quotes.reverse();
        raw.fx_rates.reverse();
        raw.observed_snapshots.reverse();
        let shuffled = body(&Pipeline::run(raw).expect("pipeline"), &scenario);
        assert_same(&scenario.id, "P-DET", &shuffled, &reference);
    }
}

/// P-CHUNK / P-REPLAY / P-RESOLVE (I1, I2): projecting a range in chunks,
/// folding a serde-round-tripped checkpoint forward, yields the one-shot
/// bundle and the same valuation.
#[test]
fn p_chunk_partitions_are_equivalent() {
    for scenario in corpus() {
        let one_shot = Pipeline::from_scenario(&scenario);
        let range = one_shot.range;
        if range.start == range.end {
            continue;
        }
        let mut boundaries: BTreeSet<NaiveDate> = one_shot
            .ledger
            .events
            .iter()
            .map(|e| e.date)
            .filter(|d| *d >= range.start && *d < range.end)
            .collect();
        let midpoint = range.start + (range.end - range.start) / 2;
        boundaries.insert(midpoint);
        let partitions: Vec<Vec<NaiveDate>> = std::iter::once(vec![midpoint])
            .chain(std::iter::once(boundaries.iter().copied().collect()))
            .collect();
        for cuts in partitions {
            let chunked = project_chunked(&one_shot, &cuts);
            let left = serde_json::to_value(bundle_view(&chunked)).unwrap();
            let right = serde_json::to_value(bundle_view(&one_shot.bundle)).unwrap();
            assert_same(&scenario.id, &format!("P-CHUNK at {cuts:?}"), &left, &right);

            let chunked_series = wealthfolio_portfolio_engine::value(&ValueInputs {
                resolved: one_shot.resolved(),
                bundle: &chunked,
            });
            let left = serde_json::to_value(&chunked_series).unwrap();
            let right = serde_json::to_value(&one_shot.series).unwrap();
            assert_same(&scenario.id, "P-RESOLVE (chunked value)", &left, &right);
        }
    }
}

fn project_chunked(pipeline: &Pipeline, cuts: &[NaiveDate]) -> ProjectionBundle {
    let fx = pipeline.fx();
    let mut state: Option<ProjectionState> = None;
    let mut merged: Option<ProjectionBundle> = None;
    let mut start = pipeline.range.start;
    let mut ends: Vec<NaiveDate> = cuts.to_vec();
    ends.push(pipeline.range.end);
    for end in ends {
        if end < start {
            continue;
        }
        let bundle = project(
            &pipeline.ledger,
            &pipeline.facts,
            &fx,
            state.take(),
            DateRange { start, end },
        )
        .expect("chunk projects");
        // The checkpoint crosses a storage boundary between chunks.
        let json = serde_json::to_string(&bundle.final_state).unwrap();
        state = Some(serde_json::from_str(&json).unwrap());
        merged = Some(match merged {
            None => bundle,
            Some(mut acc) => {
                for (account, frames) in bundle.keyframes {
                    acc.keyframes.entry(account).or_default().extend(frames);
                }
                acc.disposals.extend(bundle.disposals);
                acc.closures.extend(bundle.closures);
                acc.diagnostics.extend(bundle.diagnostics);
                acc.final_state = bundle.final_state;
                acc
            }
        });
        start = end.succ_opt().unwrap();
    }
    merged.expect("at least one chunk")
}

/// Bundle sections whose equality chunking must preserve (diagnostics are
/// compared as a multiset).
fn bundle_view(bundle: &ProjectionBundle) -> Value {
    let mut diagnostics: Vec<String> = bundle
        .diagnostics
        .iter()
        .map(|d| format!("{:?} {}: {}", d.code, d.source, d.message))
        .collect();
    diagnostics.sort();
    serde_json::json!({
        "keyframes": bundle.keyframes,
        "final_state": bundle.final_state,
        "disposals": bundle.disposals,
        "closures": bundle.closures,
        "diagnostics": diagnostics,
    })
}

/// P-CASH (I4): closing cash per account and bucket equals the sum of the
/// booked cash postings of every applied event.
#[test]
fn p_cash_conservation() {
    for scenario in corpus() {
        let pipeline = Pipeline::from_scenario(&scenario);
        let rejected: BTreeSet<&str> = pipeline
            .bundle
            .diagnostics
            .iter()
            .filter(|d| d.code == DiagnosticCode::ActivityRejected)
            .map(|d| d.source.as_str())
            .collect();
        let mut expected: BTreeMap<&AccountId, BTreeMap<String, Decimal>> = BTreeMap::new();
        for event in &pipeline.ledger.events {
            let Some(account) = pipeline.facts.accounts.get(&event.account) else {
                continue;
            };
            if account.archived
                || account.tracking == TrackingMode::Holdings
                || rejected.contains(event.id.as_str())
                || event.date < pipeline.range.start
                || event.date > pipeline.range.end
            {
                continue;
            }
            let Some(cash) = &event.cash else {
                continue;
            };
            let (currency, amount) = match cash.booking {
                Booking::ActivityCurrency => (event.currency.as_str().to_string(), cash.amount),
                Booking::AccountCurrency { rate } => {
                    (account.currency.as_str().to_string(), cash.amount * rate)
                }
            };
            *expected
                .entry(&event.account)
                .or_default()
                .entry(currency)
                .or_default() += amount;
        }
        for (account, state) in &pipeline.bundle.final_state.accounts {
            let expected = expected.get(account).cloned().unwrap_or_default();
            for (currency, amount) in &state.cash {
                let want = expected.get(currency.as_str()).copied().unwrap_or_default();
                assert!(
                    (*amount - want).abs() <= DUST,
                    "{}: P-CASH violated for {account} {currency}: state {amount} vs postings {want}",
                    scenario.id
                );
            }
            for (currency, want) in &expected {
                assert!(
                    state.cash.keys().any(|c| c.as_str() == currency.as_str()) || want.is_zero(),
                    "{}: P-CASH violated for {account} {currency}: postings {want} but no bucket",
                    scenario.id
                );
            }
        }
    }
}

/// P-LOTS (I5): at every keyframe, open-lot effective quantities sum to the
/// position quantity and lots of one position share a sign.
#[test]
fn p_lots_reconcile_to_positions() {
    for scenario in corpus() {
        let pipeline = Pipeline::from_scenario(&scenario);
        for (account, frames) in &pipeline.bundle.keyframes {
            for frame in frames {
                for (asset, position) in &frame.state.positions {
                    let effective: Decimal =
                        position.lots.iter().map(Lot::effective_quantity).sum();
                    assert!(
                        (effective - position.quantity).abs() <= DUST,
                        "{}: P-LOTS violated for {account}/{asset} on {}: lots {effective} vs position {}",
                        scenario.id,
                        frame.date,
                        position.quantity
                    );
                    let positive = position.lots.iter().any(|l| l.quantity > Decimal::ZERO);
                    let negative = position.lots.iter().any(|l| l.quantity < Decimal::ZERO);
                    assert!(
                        !(positive && negative),
                        "{}: P-LOTS violated for {account}/{asset} on {}: mixed-sign lots",
                        scenario.id,
                        frame.date
                    );
                }
            }
        }
    }
}

/// P-SPLIT (I6): on a day carrying only split events, cost basis, cash and
/// external flows are unchanged.
#[test]
fn p_split_is_basis_and_cash_neutral() {
    for scenario in corpus() {
        let pipeline = Pipeline::from_scenario(&scenario);
        let mut by_account_day: BTreeMap<(&AccountId, NaiveDate), Vec<&EconomicEvent>> =
            BTreeMap::new();
        for event in &pipeline.ledger.events {
            by_account_day
                .entry((&event.account, event.date))
                .or_default()
                .push(event);
        }
        for ((account, day), events) in &by_account_day {
            if !events
                .iter()
                .all(|e| matches!(e.action, Action::Split { .. }))
            {
                continue;
            }
            let Some(frames) = pipeline.bundle.keyframes.get(*account) else {
                continue;
            };
            let index = frames
                .iter()
                .position(|f| f.date == *day)
                .expect("split day keyframe");
            if index == 0 {
                continue;
            }
            let (before, after) = (&frames[index - 1].state, &frames[index].state);
            assert_eq!(
                before.cash, after.cash,
                "{}: P-SPLIT cash changed on {day}",
                scenario.id
            );
            assert!(
                (before.cost_basis - after.cost_basis).abs() <= DUST,
                "{}: P-SPLIT cost basis changed on {day}",
                scenario.id
            );
            for (asset, position) in &after.positions {
                if let Some(previous) = before.positions.get(asset) {
                    assert!(
                        (previous.total_cost_basis - position.total_cost_basis).abs() <= DUST,
                        "{}: P-SPLIT basis of {asset} changed on {day}",
                        scenario.id
                    );
                }
            }
            if let Some(row) = pipeline
                .series
                .get(*account)
                .and_then(|s| s.days.iter().find(|d| d.date == *day))
            {
                assert!(
                    row.flow.inflow_base.is_zero() && row.flow.outflow_base.is_zero(),
                    "{}: P-SPLIT external flow on {day}",
                    scenario.id
                );
            }
        }
    }
}

/// P-TXF (I7): a day whose only scoped events are the two legs of matched
/// internal transfers has zero external flow at portfolio scope.
#[test]
fn p_txf_internal_pairs_cancel_at_portfolio_scope() {
    for scenario in corpus() {
        let pipeline = Pipeline::from_scenario(&scenario);
        let scope = pipeline.portfolio_scope();
        let Ok(portfolio) = aggregate_scope(
            &pipeline.resolved(),
            &pipeline.bundle.disposals,
            &pipeline.series,
            &scope,
            Window::default(),
        ) else {
            continue;
        };
        let mut by_day: BTreeMap<NaiveDate, Vec<&EconomicEvent>> = BTreeMap::new();
        for event in pipeline
            .ledger
            .events
            .iter()
            .filter(|e| scope.contains(&e.account))
        {
            by_day.entry(event.date).or_default().push(event);
        }
        for (day, events) in &by_day {
            let only_internal_pairs = !events.is_empty()
                && events.iter().all(|e| {
                    matches!(&e.flow.boundary, Boundary::Internal { counterparty } if scope.contains(counterparty))
                });
            if !only_internal_pairs {
                continue;
            }
            let Some(row) = portfolio.days.iter().find(|d| d.date == *day) else {
                continue;
            };
            assert!(
                row.flow.inflow_base.is_zero() && row.flow.outflow_base.is_zero(),
                "{}: P-TXF violated on {day}: portfolio flow {:?}",
                scenario.id,
                row.flow
            );
        }
    }
}

/// P-RECON (I8): a complete day's values re-derive from the keyframe and the
/// public surfaces alone. Investments are Σ quantity × latest close (in the
/// quote currency's major unit) × contract multiplier × FX into the account
/// currency; cash is Σ bucket × FX. This walks `project` keyframes and
/// `resolve` surfaces directly, never `value`'s own bookkeeping, so it is an
/// independent recomputation, not a restatement. Days that are not
/// `COMPLETE` and assets with adjusted splits (the valuer's split factor is
/// its own rule) are left to the goldens.
#[test]
fn p_recon_complete_days_rederive_from_keyframes_and_surfaces() {
    let mut checked = 0usize;
    for scenario in corpus() {
        let pipeline = Pipeline::from_scenario(&scenario);
        let policy = &pipeline.facts.policy;
        let fx = pipeline.fx();
        let split_assets: BTreeSet<&AssetId> =
            pipeline.surfaces.splits.iter().map(|s| &s.asset).collect();
        for (account, series) in &pipeline.series {
            let Some(keyframes) = pipeline.bundle.keyframes.get(account) else {
                continue; // holdings-tracked: valued from observed snapshots
            };
            let account_currency = pipeline.facts.accounts[account].currency.as_str();
            for day in &series.days {
                if day.value_status != ValueStatus::Complete {
                    continue;
                }
                let Some(frame) = keyframes.iter().rev().find(|k| k.date <= day.date) else {
                    continue;
                };
                if frame
                    .state
                    .positions
                    .keys()
                    .any(|asset| split_assets.contains(asset))
                {
                    continue;
                }
                let mut investment = Decimal::ZERO;
                for (asset, position) in &frame.state.positions {
                    if position.alternative || position.quantity.is_zero() {
                        continue;
                    }
                    let quote = pipeline
                        .surfaces
                        .quotes
                        .latest_on_or_before(asset, day.date)
                        .expect("a COMPLETE day prices every held position");
                    let (quote_major, unit) = policy.normalize_currency(quote.currency.as_str());
                    let rate = fx
                        .rate(quote_major, account_currency, day.date)
                        .expect("a COMPLETE day converts every quote currency");
                    let multiplier = pipeline
                        .facts
                        .assets
                        .get(asset)
                        .map(|a| a.contract_multiplier)
                        .unwrap_or(Decimal::ONE);
                    investment += position.quantity * quote.close * unit * multiplier * rate;
                }
                let mut cash = Decimal::ZERO;
                for (currency, amount) in &frame.state.cash {
                    let (major, unit) = policy.normalize_currency(currency.as_str());
                    let rate = fx
                        .rate(major, account_currency, day.date)
                        .expect("a COMPLETE day converts every cash bucket");
                    cash += *amount * unit * rate;
                }
                let id = format!("{}: {account} {}", scenario.id, day.date);
                assert_eq!(day.investment_market_value, investment, "{id}: investments");
                assert_eq!(day.cash_balance, cash, "{id}: cash");
                assert_eq!(day.total_value, cash + investment, "{id}: total");
                checked += 1;
            }
        }
    }
    assert!(checked > 100, "only {checked} complete days re-derived");
}

/// P-AGG (I9): scope aggregation is exact where it must be trivial and
/// classifies transfers independently of the valuer. A one-account scope is
/// that account's stored rows unchanged; on a day without a transfer pair
/// inside the scope the scope's flows are the sum of the account flows
/// (pair days are the netted case P-TXF and EDGE-TXF-02 pin); values sum and
/// statuses absorb on every day. Internal pairs come from the ledger's pair
/// table and activity dates, not from `aggregate_scope`. An account's
/// inception day is skipped for the flow sum: its opening money is that
/// account's starting value but an inflow to a scope that already exists.
#[test]
fn p_agg_scope_aggregation_is_exact() {
    let mut pair_days = 0usize;
    for scenario in corpus() {
        let pipeline = Pipeline::from_scenario(&scenario);
        let resolved = pipeline.resolved();
        let scope = pipeline.portfolio_scope();
        for account in &scope {
            let Some(own) = pipeline.series.get(account) else {
                continue;
            };
            let Ok(single) = aggregate_scope(
                &resolved,
                &pipeline.bundle.disposals,
                &pipeline.series,
                std::slice::from_ref(account),
                Window::default(),
            ) else {
                continue;
            };
            let stored: Vec<DailyValuation> = own.days.iter().map(DailyValuation::stored).collect();
            let id = format!("{}: {account}", scenario.id);
            assert_eq!(
                single.days.len(),
                stored.len(),
                "{id}: single-scope row count"
            );
            for (scoped, row) in single.days.iter().zip(&stored) {
                assert_eq!(
                    scoped.total_value_base, row.total_value_base,
                    "{id}: {}",
                    row.date
                );
                assert_eq!(
                    scoped.flow.inflow_base, row.flow.inflow_base,
                    "{id}: {} inflow",
                    row.date
                );
                assert_eq!(
                    scoped.flow.outflow_base, row.flow.outflow_base,
                    "{id}: {} outflow",
                    row.date
                );
            }
        }
        let Ok(portfolio) = aggregate_scope(
            &resolved,
            &pipeline.bundle.disposals,
            &pipeline.series,
            &scope,
            Window::default(),
        ) else {
            continue;
        };
        let activity_date = |id: &ActivityId| {
            pipeline
                .facts
                .activities
                .iter()
                .find(|a| &a.id == id)
                .map(|a| a.date)
        };
        let internal_days: BTreeSet<NaiveDate> = pipeline
            .facts
            .transfer_pairs
            .by_group
            .values()
            .filter(|pair| scope.contains(&pair.out_account) && scope.contains(&pair.in_account))
            .flat_map(|pair| {
                [
                    activity_date(&pair.transfer_out),
                    activity_date(&pair.transfer_in),
                ]
                .into_iter()
                .flatten()
            })
            .collect();
        let inception_days: BTreeSet<NaiveDate> = scope
            .iter()
            .filter_map(|id| pipeline.series.get(id))
            .filter_map(|s| s.days.first().map(|d| d.date))
            .collect();
        for day in &portfolio.days {
            let rows: Vec<DailyValuation> = scope
                .iter()
                .filter_map(|id| pipeline.series.get(id))
                .filter_map(|s| s.days.iter().find(|d| d.date == day.date))
                .map(DailyValuation::stored)
                .collect();
            let sum = |f: fn(&DailyValuation) -> Decimal| rows.iter().map(f).sum::<Decimal>();
            let id = format!("{}: {}", scenario.id, day.date);
            assert_eq!(
                day.total_value_base,
                sum(|d| d.total_value_base),
                "{id}: total"
            );
            assert_eq!(
                day.cash_balance_base,
                sum(|d| d.cash_balance_base),
                "{id}: cash"
            );
            assert_eq!(
                day.cost_basis_base,
                sum(|d| d.cost_basis_base),
                "{id}: basis"
            );
            if internal_days.contains(&day.date) {
                pair_days += 1;
            } else if inception_days.contains(&day.date) {
                continue;
            } else {
                assert_eq!(
                    day.flow.inflow_base,
                    sum(|d| d.flow.inflow_base),
                    "{id}: inflow"
                );
                assert_eq!(
                    day.flow.outflow_base,
                    sum(|d| d.flow.outflow_base),
                    "{id}: outflow"
                );
            }
            let value_status = rows
                .iter()
                .map(|d| d.value_status)
                .fold(ValueStatus::Complete, ValueStatus::combine);
            assert_eq!(day.value_status, value_status, "{id}: value status");
            let basis_status = rows
                .iter()
                .map(|d| d.basis_status)
                .fold(BasisStatus::NotApplicable, BasisStatus::combine);
            assert_eq!(day.basis_status, basis_status, "{id}: basis status");
        }
    }
    assert!(pair_days > 0, "the corpus has no internal transfer days");
}

/// P-DIAG (I10): every degraded day and every silent-fallback input is
/// reported.
#[test]
fn p_diag_degradation_is_reported() {
    for scenario in corpus() {
        let pipeline = Pipeline::from_scenario(&scenario);
        for (account, series) in &pipeline.series {
            if series
                .days
                .iter()
                .any(|d| d.value_status != ValueStatus::Complete)
            {
                assert!(
                    series.diagnostics.iter().any(|d| {
                        matches!(
                            d.code,
                            DiagnosticCode::MissingQuote | DiagnosticCode::FxUnavailable
                        )
                    }),
                    "{}: {account} has degraded days without a diagnostic",
                    scenario.id
                );
            }
            if series
                .days
                .iter()
                .any(|d| d.flow.source == FlowSource::UnknownBoundaryTransfer)
            {
                assert!(
                    pipeline
                        .ledger
                        .diagnostics
                        .iter()
                        .any(|d| d.code == DiagnosticCode::UnknownTransferBoundary),
                    "{}: {account} has an unknown-boundary flow without a diagnostic",
                    scenario.id
                );
            }
        }
        let raw = scenario.raw_facts();
        for activity in raw
            .activities
            .iter()
            .filter(|a| a.currency.trim().is_empty() && a.status == "POSTED")
        {
            assert!(
                pipeline.normalize_diagnostics.iter().any(|d| {
                    d.code == DiagnosticCode::MissingCurrency && d.source == activity.id
                }),
                "{}: empty currency on {} not reported",
                scenario.id,
                activity.id
            );
        }
    }
}

/// P-EFFECTIVE (§4.7): outputs depend on the effective type only.
#[test]
fn p_effective_type_overrides_are_transparent() {
    for scenario in corpus() {
        let reference = body(&Pipeline::from_scenario(&scenario), &scenario);
        let mut raw = scenario.raw_facts();
        for activity in &mut raw.activities {
            if let Some(effective) = activity.activity_type_override.take() {
                activity.activity_type = effective;
            }
        }
        let folded = body(&Pipeline::run(raw).expect("pipeline"), &scenario);
        assert_same(
            &scenario.id,
            "P-EFFECTIVE (fold override)",
            &folded,
            &reference,
        );

        let mut raw = scenario.raw_facts();
        for activity in &mut raw.activities {
            if activity.activity_type_override.is_none() {
                activity.activity_type_override = Some(activity.activity_type.clone());
            }
        }
        let redundant = body(&Pipeline::run(raw).expect("pipeline"), &scenario);
        assert_same(
            &scenario.id,
            "P-EFFECTIVE (redundant override)",
            &redundant,
            &reference,
        );
    }
}

/// P-TOTAL (§4.3): no input mutation panics the kernel — drop any single
/// activity, blank every currency, zero every quantity.
#[test]
fn p_total_no_panics_on_mutated_inputs() {
    for scenario in load_all_scenarios() {
        let raw = scenario.raw_facts();
        let _ = Pipeline::run(raw.clone());
        for index in 0..raw.activities.len() {
            let mut mutated = raw.clone();
            mutated.activities.remove(index);
            let _ = Pipeline::run(mutated);
        }
        let mut blank = raw.clone();
        for activity in &mut blank.activities {
            activity.currency.clear();
        }
        let _ = Pipeline::run(blank);
        let mut zero = raw.clone();
        for activity in &mut zero.activities {
            activity.quantity = Some(Decimal::ZERO);
            activity.unit_price = Some(Decimal::ZERO);
        }
        let _ = Pipeline::run(zero);
        let mut no_surfaces = raw;
        no_surfaces.quotes.clear();
        no_surfaces.fx_rates.clear();
        let _ = Pipeline::run(no_surfaces);
    }
}
