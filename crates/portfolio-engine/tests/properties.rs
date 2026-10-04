//! Property suite (architecture §5) driven by the fixture corpus: every scenario is
//! a generator seed, and each law is checked over all of them.

mod support;

use std::collections::{BTreeMap, BTreeSet};

use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde_json::Value;
use support::*;
use wealthfolio_portfolio_engine::model::*;
use wealthfolio_portfolio_engine::{
    aggregate_scope, project, project_accounts, value_window, DiagnosticCode, QuoteSurface,
    Resolved, ResolvedSurfaces, ValueInputs, Window,
};

const DUST: Decimal = Decimal::from_parts(1, 0, 0, false, 8);

/// The fixtures (but shell-level ones) and the generated scenarios, each under
/// every cost basis method the engine computes (rules R7.3).
fn corpus() -> Vec<Scenario> {
    under_every_method(
        load_all_scenarios()
            .into_iter()
            .chain(generated_scenarios())
            .filter(|s| !s.markers.iter().any(|m| m == "S") && scenario_selected(&s.id)),
    )
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

        // Stores are unique per (key, day, source), so a day can carry the
        // same price or rate from several sources: which one wins must not
        // depend on the order the rows arrive in.
        let mut duplicated = scenario.raw_facts();
        let echoes: Vec<RawQuote> = duplicated
            .quotes
            .iter()
            .map(|q| RawQuote {
                close: q.close * Decimal::new(101, 2),
                source: "BROKER".into(),
                ..q.clone()
            })
            .collect();
        duplicated.quotes.extend(echoes);
        let echoes: Vec<RawFxRate> = duplicated
            .fx_rates
            .iter()
            .map(|r| RawFxRate {
                rate: r.rate * Decimal::new(101, 2),
                source: "YAHOO".into(),
                ..r.clone()
            })
            .collect();
        duplicated.fx_rates.extend(echoes);
        let forward = body(
            &Pipeline::run(duplicated.clone()).expect("pipeline"),
            &scenario,
        );
        duplicated.quotes.reverse();
        duplicated.fx_rates.reverse();
        let reversed = body(&Pipeline::run(duplicated).expect("pipeline"), &scenario);
        assert_same(
            &scenario.id,
            "P-DET (same-day duplicates)",
            &reversed,
            &forward,
        );
    }
}

/// P-CHUNK / P-REPLAY / P-RESOLVE (I1, I2): projecting a range in chunks,
/// folding a serde-round-tripped checkpoint forward, yields the one-shot
/// bundle and the same valuation.
#[test]
fn p_chunk_partitions_are_equivalent() {
    for scenario in corpus() {
        let one_shot = Pipeline::from_scenario(&scenario);
        let range = one_shot.range();
        if range.start == range.end {
            continue;
        }
        let mut boundaries: BTreeSet<NaiveDate> = one_shot
            .ledger()
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
                lots: None,
            });
            let left = serde_json::to_value(&chunked_series).unwrap();
            let right = serde_json::to_value(&one_shot.series).unwrap();
            assert_same(&scenario.id, "P-RESOLVE (chunked value)", &left, &right);
        }
    }
}

/// P-SCOPE: folding some accounts (the kernel adds their transfer closure)
/// yields exactly their part of the fold of every account, and reports
/// nothing the full fold does not.
#[test]
fn p_scope_a_scoped_fold_is_its_part_of_the_full_fold() {
    for scenario in corpus() {
        let pipeline = Pipeline::from_scenario(&scenario);
        let fx = pipeline.fx();
        let full_diagnostics = bundle_view(&pipeline.bundle)["diagnostics"].clone();
        for (id, account) in pipeline.facts().accounts() {
            let requested = BTreeSet::from([id.clone()]);
            let scoped = project_accounts(
                pipeline.ledger(),
                pipeline.facts(),
                &fx,
                None,
                pipeline.range(),
                Some(&requested),
            )
            .expect("scoped fold");
            let folded: BTreeSet<AccountId> = scoped.final_state.accounts.keys().cloned().collect();
            if !account.archived && account.tracking != TrackingMode::Holdings {
                assert!(folded.contains(id), "{}: P-SCOPE folds {id}", scenario.id);
            }
            assert_same(
                &scenario.id,
                &format!("P-SCOPE {id}"),
                &bundle_view(&restrict(&scoped, &folded, pipeline.facts())),
                &bundle_view(&restrict(&pipeline.bundle, &folded, pipeline.facts())),
            );
            let full: BTreeSet<String> = full_diagnostics
                .as_array()
                .into_iter()
                .flatten()
                .map(|d| d.to_string())
                .collect();
            for diagnostic in bundle_view(&scoped)["diagnostics"]
                .as_array()
                .into_iter()
                .flatten()
            {
                assert!(
                    full.contains(&diagnostic.to_string()),
                    "{}: P-SCOPE {id} reports {diagnostic} the full fold does not",
                    scenario.id
                );
            }
        }
    }
}

/// `bundle` restricted to `accounts`: their keyframes, states, in-flight
/// transfers, disposals, closures and the diagnostics of their activities.
fn restrict(
    bundle: &ProjectionBundle,
    accounts: &BTreeSet<AccountId>,
    facts: &CanonicalFacts,
) -> ProjectionBundle {
    let owned = facts
        .activities()
        .iter()
        .filter(|a| accounts.contains(&a.account));
    let activities: BTreeSet<&str> = owned.clone().map(|a| a.id.as_str()).collect();
    let groups: BTreeSet<&str> = owned.filter_map(|a| a.source_group_id.as_deref()).collect();
    ProjectionBundle {
        keyframes: bundle
            .keyframes
            .iter()
            .filter(|(id, _)| accounts.contains(*id))
            .map(|(id, frames)| (id.clone(), frames.clone()))
            .collect(),
        final_state: ProjectionState {
            date: bundle.final_state.date,
            accounts: bundle
                .final_state
                .accounts
                .iter()
                .filter(|(id, _)| accounts.contains(*id))
                .map(|(id, state)| (id.clone(), state.clone()))
                .collect(),
            transfer_cache: bundle
                .final_state
                .transfer_cache
                .iter()
                .filter(|(group, _)| groups.contains(group.as_str()))
                .map(|(group, lots)| (group.clone(), lots.clone()))
                .collect(),
        },
        disposals: bundle
            .disposals
            .iter()
            .filter(|d| accounts.contains(&d.account))
            .cloned()
            .collect(),
        closures: bundle
            .closures
            .iter()
            .filter(|c| accounts.contains(&c.account))
            .cloned()
            .collect(),
        diagnostics: bundle
            .diagnostics
            .iter()
            .filter(|d| activities.contains(d.source.as_str()))
            .cloned()
            .collect(),
    }
}

/// P-WIN: a windowed run (fold a window from the previous window's state,
/// value it from that seed with quotes observed in the window plus each
/// asset's last observation before it) yields the one-shot valuations, day for
/// day, however the range is cut.
#[test]
fn p_win_windowed_valuation_is_equivalent() {
    for scenario in corpus() {
        let one_shot = Pipeline::from_scenario(&scenario);
        let range = DateRange {
            start: genesis(&one_shot),
            end: one_shot.range().end,
        };
        if range.start == range.end {
            continue;
        }
        let event_days: Vec<NaiveDate> = one_shot
            .ledger()
            .events
            .iter()
            .map(|e| e.date)
            .filter(|d| *d >= range.start && *d < range.end)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let every_third: Vec<NaiveDate> = range
            .start
            .iter_days()
            .take_while(|d| *d < range.end)
            .step_by(3)
            .collect();
        let midpoint = vec![range.start + (range.end - range.start) / 2];
        for cuts in [midpoint, event_days, every_third] {
            let windowed = value_windowed(&one_shot, &cuts);
            for (account, series) in &one_shot.series {
                let left = serde_json::to_value(windowed.get(account).cloned().unwrap_or_default())
                    .unwrap();
                let right = serde_json::to_value(&series.days).unwrap();
                assert_same(
                    &scenario.id,
                    &format!("P-WIN {account} at {cuts:?}"),
                    &left,
                    &right,
                );
            }
            assert!(
                windowed.keys().all(|a| one_shot.series.contains_key(a)),
                "{}: P-WIN valued an account the one-shot run did not",
                scenario.id
            );
        }
    }
}

/// The first day the app values (its genesis): the first activity or
/// observed snapshot, whichever comes first. A holdings account's first
/// snapshot can come before any activity (EDGE-MIX-04).
fn genesis(pipeline: &Pipeline) -> NaiveDate {
    let range = pipeline.range();
    pipeline
        .facts()
        .observed_snapshots()
        .iter()
        .map(|s| s.date)
        .filter(|day| *day <= range.end)
        .fold(range.start, NaiveDate::min)
}

fn value_windowed(
    pipeline: &Pipeline,
    cuts: &[NaiveDate],
) -> BTreeMap<AccountId, Vec<DailyValuation>> {
    let fx = pipeline.fx();
    let quotes = pipeline.facts().quotes();
    let mut state: Option<ProjectionState> = None;
    let mut started: BTreeSet<AccountId> = BTreeSet::new();
    let mut days: BTreeMap<AccountId, Vec<DailyValuation>> = BTreeMap::new();
    let mut start = genesis(pipeline);
    let mut ends: Vec<NaiveDate> = cuts.to_vec();
    ends.push(pipeline.range().end);
    for end in ends {
        if end < start {
            continue;
        }
        let window = DateRange { start, end };
        let seed: BTreeMap<AccountId, AccountState> = state
            .as_ref()
            .map(|s| {
                s.accounts
                    .iter()
                    .filter(|(id, _)| started.contains(*id))
                    .map(|(id, a)| (id.clone(), a.clone()))
                    .collect()
            })
            .unwrap_or_default();
        let bundle = project(
            pipeline.ledger(),
            pipeline.facts(),
            &fx,
            state.take(),
            window,
        )
        .expect("window projects");
        let mut last_before: BTreeMap<&AssetId, &QuoteObservation> = BTreeMap::new();
        for quote in quotes.iter().filter(|q| q.day < start) {
            let latest = last_before.entry(&quote.asset).or_insert(quote);
            if quote.day > latest.day {
                *latest = quote;
            }
        }
        let observations: Vec<QuoteObservation> = last_before
            .into_values()
            .chain(quotes.iter().filter(|q| q.day >= start && q.day <= end))
            .cloned()
            .collect();
        let surfaces = ResolvedSurfaces {
            quotes: QuoteSurface::from_observations(&observations),
            fx: pipeline.surfaces().fx.clone(),
            splits: pipeline.surfaces().splits.clone(),
            recorded_splits: pipeline.surfaces().recorded_splits.clone(),
        };
        let series = value_window(
            &ValueInputs {
                resolved: Resolved {
                    facts: pipeline.facts(),
                    ledger: pipeline.ledger(),
                    surfaces: &surfaces,
                    range: window,
                },
                bundle: &bundle,
                lots: None,
            },
            &seed,
            None,
        );
        for (account, series) in series {
            days.entry(account).or_default().extend(series.days);
        }
        started.extend(
            bundle
                .keyframes
                .iter()
                .filter(|(_, frames)| !frames.is_empty())
                .map(|(id, _)| id.clone()),
        );
        state = Some(bundle.final_state);
        start = end.succ_opt().unwrap();
    }
    days
}

fn project_chunked(pipeline: &Pipeline, cuts: &[NaiveDate]) -> ProjectionBundle {
    let fx = pipeline.fx();
    let mut state: Option<ProjectionState> = None;
    let mut merged: Option<ProjectionBundle> = None;
    let mut start = pipeline.range().start;
    let mut ends: Vec<NaiveDate> = cuts.to_vec();
    ends.push(pipeline.range().end);
    for end in ends {
        if end < start {
            continue;
        }
        let bundle = project(
            pipeline.ledger(),
            pipeline.facts(),
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
        for event in &pipeline.ledger().events {
            let Some(account) = pipeline.facts().accounts().get(&event.account) else {
                continue;
            };
            if account.archived
                || account.tracking == TrackingMode::Holdings
                || rejected.contains(event.id.as_str())
                || event.date < pipeline.range().start
                || event.date > pipeline.range().end
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

/// P-LOTS (I5): at the end of every event day, open-lot effective quantities
/// sum to the position quantity and lots of one position share a sign.
/// Keyframes carry totals only, so the law folds one chunk per event day and
/// checks each chunk's checkpoint, which carries the lots.
#[test]
fn p_lots_reconcile_to_positions() {
    for scenario in corpus() {
        let pipeline = Pipeline::from_scenario(&scenario);
        let range = pipeline.range();
        let days: BTreeSet<NaiveDate> = pipeline
            .ledger()
            .events
            .iter()
            .map(|e| e.date)
            .filter(|d| *d >= range.start && *d <= range.end)
            .collect();
        let fx = pipeline.fx();
        let mut state: Option<ProjectionState> = None;
        let mut start = range.start;
        for day in days {
            let bundle = project(
                pipeline.ledger(),
                pipeline.facts(),
                &fx,
                state.take(),
                DateRange { start, end: day },
            )
            .expect("chunk projects");
            for (account, account_state) in &bundle.final_state.accounts {
                for (asset, position) in &account_state.positions {
                    let effective: Decimal =
                        position.lots.iter().map(Lot::effective_quantity).sum();
                    assert!(
                        (effective - position.quantity).abs() <= DUST,
                        "{}: P-LOTS violated for {account}/{asset} on {day}: lots {effective} vs position {}",
                        scenario.id,
                        position.quantity
                    );
                    let positive = position.lots.iter().any(|l| l.quantity > Decimal::ZERO);
                    let negative = position.lots.iter().any(|l| l.quantity < Decimal::ZERO);
                    assert!(
                        !(positive && negative),
                        "{}: P-LOTS violated for {account}/{asset} on {day}: mixed-sign lots",
                        scenario.id
                    );
                }
            }
            state = Some(bundle.final_state);
            start = day.succ_opt().expect("next day");
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
        for event in &pipeline.ledger().events {
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
/// internal transfers has zero external flow at portfolio scope. The one
/// deliberate exception is a same-account FX conversion the import linker
/// did not record: it keeps the legacy per-leg contribution (#1655), which
/// surfaces as a net-contribution fallback flow. Days where something else
/// brings money in (a transfer's shortfall, a holdings snapshot, an account
/// opening) are P-AGG's: it states what each account adds.
#[test]
fn p_txf_internal_pairs_cancel_at_portfolio_scope() {
    for scenario in corpus() {
        let pipeline = Pipeline::from_scenario(&scenario);
        let scope = pipeline.portfolio_scope();
        let Ok(portfolio) = aggregate_scope(
            &pipeline.effects(
                &pipeline.bundle.disposals,
                &pipeline.lots(),
                &pipeline.bundle.rejected_activities(),
            ),
            &pipeline.series,
            &scope,
            Window::default(),
        ) else {
            continue;
        };
        let Some(start) = portfolio.days.first().map(|d| d.date) else {
            continue;
        };
        let mut by_day: BTreeMap<NaiveDate, Vec<&EconomicEvent>> = BTreeMap::new();
        for event in pipeline
            .ledger()
            .events
            .iter()
            .filter(|e| scope.contains(&e.account))
        {
            by_day.entry(event.date).or_default().push(event);
        }
        for (day, events) in &by_day {
            let unlinked_conversion = |e: &&EconomicEvent| {
                pipeline
                    .facts()
                    .transfer_pairs()
                    .pair_for(&e.source)
                    .is_some_and(|p| p.in_account == p.out_account && !p.contribution_neutral)
            };
            // A sender that held less than it sent reports the shortfall,
            // and the receiver books the difference: those units enter the
            // portfolio (EDGE-TXF-09).
            let shortfall = |e: &&EconomicEvent| {
                pipeline
                    .facts()
                    .transfer_pairs()
                    .pair_for(&e.source)
                    .is_some_and(|p| {
                        pipeline.bundle.diagnostics.iter().any(|d| {
                            matches!(
                                d.code,
                                DiagnosticCode::InsufficientQuantity
                                    | DiagnosticCode::NoPositionToReduce
                            ) && d.source == p.transfer_out.as_str()
                        })
                    })
            };
            // A transfer with a holdings account shows up in its snapshots.
            let holdings_pair = |e: &&EconomicEvent| {
                pipeline
                    .facts()
                    .transfer_pairs()
                    .pair_for(&e.source)
                    .is_some_and(|p| {
                        [&p.in_account, &p.out_account].iter().any(|id| {
                            pipeline.facts().accounts()[*id].tracking == TrackingMode::Holdings
                        })
                    })
            };
            let only_internal_pairs = !events.is_empty()
                && !events.iter().any(unlinked_conversion)
                && !events.iter().any(holdings_pair)
                && !events.iter().any(shortfall)
                && events.iter().all(|e| {
                    matches!(&e.flow.boundary, Boundary::Internal { counterparty } if scope.contains(counterparty))
                });
            // A holdings account's flows are inferred from its snapshots,
            // not from activities: a day it moves has another flow.
            let holdings_flow = scope.iter().any(|id| {
                pipeline.facts().accounts()[id].tracking == TrackingMode::Holdings
                    && pipeline.series.get(id).is_some_and(|s| {
                        s.days.iter().any(|d| {
                            d.date == *day
                                && (!d.flow.inflow_base.is_zero() || !d.flow.outflow_base.is_zero())
                        })
                    })
            });
            // An account opening inside the portfolio brings money in.
            let opening = *day != start
                && scope.iter().any(|id| {
                    pipeline
                        .series
                        .get(id)
                        .and_then(|s| s.days.first())
                        .is_some_and(|first| first.date == *day)
                });
            if !only_internal_pairs || holdings_flow || opening {
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

/// P-RECON (I8): a complete day's values re-derive from the keyframe (a
/// holdings account's observed snapshot, its units carried across the
/// recorded splits since) and the public surfaces alone. Investments are Σ quantity × latest close (in the
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
        let policy = pipeline.facts().policy();
        let fx = pipeline.fx();
        let split_assets: BTreeSet<&AssetId> = pipeline
            .surfaces()
            .splits
            .iter()
            .map(|s| &s.asset)
            .collect();
        for (account, series) in &pipeline.series {
            let keyframes = pipeline.bundle.keyframes.get(account);
            // A holdings-tracked account has no keyframes: it is valued from
            // its observed snapshots, by the same rule.
            let mut snapshots: Vec<&ObservedSnapshot> = pipeline
                .facts()
                .observed_snapshots()
                .iter()
                .filter(|s| &s.account == account)
                .collect();
            snapshots.sort_by_key(|s| s.date);
            let account_currency = pipeline.facts().accounts()[account].currency.as_str();
            for day in &series.days {
                if day.value_status != ValueStatus::Complete {
                    continue;
                }
                // What the account held: (asset, units, alternative) and cash.
                type Held<'a> = (
                    Vec<(&'a AssetId, Decimal, bool)>,
                    Vec<(&'a Currency, Decimal)>,
                );
                let (positions, buckets): Held = if let Some(keyframes) = keyframes {
                    let Some(frame) = keyframes.iter().rev().find(|k| k.date <= day.date) else {
                        continue;
                    };
                    (
                        frame
                            .state
                            .positions
                            .iter()
                            .map(|(asset, p)| (asset, p.quantity, p.alternative))
                            .collect(),
                        frame.state.cash.iter().map(|(c, a)| (c, *a)).collect(),
                    )
                } else {
                    let Some(snapshot) = snapshots.iter().rev().find(|s| s.date <= day.date) else {
                        continue;
                    };
                    (
                        snapshot
                            .positions
                            .iter()
                            .map(|(asset, p)| {
                                let alternative = pipeline
                                    .facts()
                                    .assets()
                                    .get(asset)
                                    .is_some_and(|a| a.alternative);
                                // Its units, carried across the splits after
                                // it (rules R1.5).
                                let split: Decimal = pipeline
                                    .surfaces()
                                    .recorded_splits
                                    .iter()
                                    .filter(|s| {
                                        &s.asset == asset
                                            && snapshot.date < s.split_date
                                            && s.split_date <= day.date
                                    })
                                    .map(|s| s.ratio)
                                    .product();
                                (asset, p.quantity * split, alternative)
                            })
                            .collect(),
                        snapshot.cash.iter().map(|(c, a)| (c, *a)).collect(),
                    )
                };
                if positions
                    .iter()
                    .any(|(asset, ..)| split_assets.contains(asset))
                {
                    continue;
                }
                let mut investment = Decimal::ZERO;
                for (asset, quantity, alternative) in &positions {
                    if *alternative || quantity.is_zero() {
                        continue;
                    }
                    let quote = pipeline
                        .surfaces()
                        .quotes
                        .latest_on_or_before(asset, day.date)
                        .expect("a COMPLETE day prices every held position");
                    let (quote_major, unit) = policy.normalize_currency(quote.currency.as_str());
                    let rate = fx
                        .rate(quote_major, account_currency, day.date)
                        .expect("a COMPLETE day converts every quote currency");
                    let multiplier = pipeline
                        .facts()
                        .assets()
                        .get(*asset)
                        .map(|a| a.contract_multiplier)
                        .unwrap_or(Decimal::ONE);
                    investment += *quantity * quote.close * unit * multiplier * rate;
                }
                let mut cash = Decimal::ZERO;
                for (currency, amount) in &buckets {
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
    assert!(
        filtered() || checked > 100,
        "only {checked} complete days re-derived"
    );
}

/// A holdings snapshot valued on `day` from the public surfaces, by P-RECON's
/// rule, in `currency`; `None` when a price or rate is missing, or a position
/// is alternative or split-adjusted.
fn value_snapshot(
    pipeline: &Pipeline,
    snapshot: &ObservedSnapshot,
    currency: &str,
    day: NaiveDate,
    split_assets: &BTreeSet<&AssetId>,
) -> Option<Decimal> {
    let policy = pipeline.facts().policy();
    let fx = pipeline.fx();
    let mut total = Decimal::ZERO;
    for (asset, position) in &snapshot.positions {
        if position.quantity.is_zero() {
            continue;
        }
        let facts = pipeline.facts().assets().get(asset);
        if facts.is_some_and(|a| a.alternative) || split_assets.contains(asset) {
            return None;
        }
        let quote = pipeline.surfaces().quotes.latest_on_or_before(asset, day)?;
        let (major, unit) = policy.normalize_currency(quote.currency.as_str());
        let multiplier = facts.map(|a| a.contract_multiplier).unwrap_or(Decimal::ONE);
        total +=
            position.quantity * quote.close * unit * multiplier * fx.rate(major, currency, day)?;
    }
    for (bucket, amount) in &snapshot.cash {
        let (major, unit) = policy.normalize_currency(bucket.as_str());
        total += *amount * unit * fx.rate(major, currency, day)?;
    }
    Some(total)
}

/// P-HOLD (rules R1.2): a holdings account's flows come only from its
/// snapshots, which hold what it records. It has a flow only on a snapshot
/// day after its first, and on every such day the net flow is the new
/// snapshot's value less the previous snapshot's holdings at that day's
/// prices, zero included: a deposit or transfer it records adds no flow of
/// its own (EDGE-MIX-04, EDGE-MIX-05). Re-derived where the account currency
/// is the base's, both snapshots are priced, and no asset split.
#[test]
fn p_hold_holdings_flows_come_from_snapshots() {
    let mut checked = 0usize;
    for scenario in corpus() {
        let pipeline = Pipeline::from_scenario(&scenario);
        let policy = pipeline.facts().policy();
        let base = policy
            .major_currency(policy.base_currency.as_str())
            .to_string();
        let split_assets: BTreeSet<&AssetId> = pipeline
            .surfaces()
            .splits
            .iter()
            .map(|s| &s.asset)
            .collect();
        for (account, series) in &pipeline.series {
            let facts = &pipeline.facts().accounts()[account];
            if facts.tracking != TrackingMode::Holdings {
                continue;
            }
            let mut snapshots: Vec<&ObservedSnapshot> = pipeline
                .facts()
                .observed_snapshots()
                .iter()
                .filter(|s| &s.account == account)
                .collect();
            snapshots.sort_by_key(|s| s.date);
            for (index, row) in series.days.iter().enumerate() {
                let id = format!("{}: P-HOLD {account} on {}", scenario.id, row.date);
                let snapshot_day = snapshots.iter().any(|s| s.date == row.date);
                assert!(
                    row.flow == DailyFlow::default() || (index > 0 && snapshot_day),
                    "{id}: a flow without a snapshot ({:?})",
                    row.flow
                );
                // Every snapshot after the first, with a flow or without one:
                // a flow it should carry and does not fails here too.
                if index == 0
                    || !snapshot_day
                    || !row.flow.source.has_known_amount()
                    || row.value_status != ValueStatus::Complete
                    || policy.major_currency(facts.currency.as_str()) != base
                {
                    continue;
                }
                let Some(previous) = snapshots.iter().rev().find(|s| s.date < row.date) else {
                    continue;
                };
                let Some(before) = value_snapshot(
                    &pipeline,
                    previous,
                    facts.currency.as_str(),
                    row.date,
                    &split_assets,
                ) else {
                    continue;
                };
                let net = row.flow.inflow_base - row.flow.outflow_base;
                let moved = row.total_value_base - before;
                assert!(
                    (net - moved).abs() <= DUST,
                    "{id}: net flow {net}, the snapshot moved {moved}"
                );
                checked += 1;
            }
        }
    }
    assert!(
        filtered() || checked > 10,
        "only {checked} holdings transitions checked"
    );
}

/// P-AGG (I9): scope aggregation adds up its accounts. A one-account scope is
/// that account's stored rows unchanged; values sum and statuses absorb on
/// every day. On every day after the first, the scope's net flow is what
/// each account adds: its row's flow, or on its first day inside the scope
/// the money that opened it, less its legs of transfers inside the scope
/// (an outgoing leg whole, an incoming one in the share of units its sender
/// gave). On a day without such a leg or an opening, each side is the plain
/// sum. A dated read is the full read after its first day.
#[test]
fn p_agg_scope_aggregation_is_exact() {
    let mut pair_days = 0usize;
    let mut dated_reads = 0usize;
    for scenario in corpus() {
        let pipeline = Pipeline::from_scenario(&scenario);
        let effects = pipeline.effects(
            &pipeline.bundle.disposals,
            &pipeline.lots(),
            &pipeline.bundle.rejected_activities(),
        );
        let scope = pipeline.portfolio_scope();
        for account in &scope {
            let Some(own) = pipeline.series.get(account) else {
                continue;
            };
            let Ok(single) = aggregate_scope(
                &effects,
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
                assert_eq!(
                    scoped.flow.source, row.flow.source,
                    "{id}: {} flow source",
                    row.date
                );
            }
        }
        let Ok(portfolio) = aggregate_scope(&effects, &pipeline.series, &scope, Window::default())
        else {
            continue;
        };
        let Some(start) = portfolio.days.first().map(|day| day.date) else {
            continue;
        };
        let inception: BTreeMap<&AccountId, NaiveDate> = scope
            .iter()
            .filter_map(|id| {
                let first = pipeline.series.get(id)?.days.first()?;
                Some((id, first.date))
            })
            .collect();
        let holdings =
            |id: &AccountId| pipeline.facts().accounts()[id].tracking == TrackingMode::Holdings;
        let by_source: BTreeMap<&ActivityId, &EventEffect> = effects
            .events
            .iter()
            .map(|event| (&event.source, event))
            .collect();
        // The legs of transfers inside the scope, signed (incoming adds,
        // outgoing takes away), by account and day: an outgoing leg whole,
        // an incoming one for what its sender gave (rules R2.1): priced at a
        // quote, in the share of units it gave; at cost, the cost it removed.
        // A transfer with a holdings account is not a pair here: its side
        // shows up in that account's snapshots.
        let mut legs: BTreeMap<(&AccountId, NaiveDate), Decimal> = BTreeMap::new();
        for pair in effects.pairs.iter().filter(|pair| {
            pair.in_account != pair.out_account
                && scope.contains(&pair.in_account)
                && scope.contains(&pair.out_account)
                && !holdings(&pair.in_account)
                && !holdings(&pair.out_account)
        }) {
            let leg = |source: &ActivityId| {
                by_source
                    .get(source)
                    .and_then(|event| event.flow.map(|flow| (*event, flow)))
            };
            let (incoming, outgoing) = (leg(&pair.transfer_in), leg(&pair.transfer_out));
            let given = match (incoming, outgoing) {
                (Some((_, inflow)), Some((_, outflow)))
                    if pair.security && inflow.units > outflow.units =>
                {
                    if inflow.source == FlowSource::QuoteDerivedMarketValue {
                        inflow.amount * outflow.units / inflow.units
                    } else {
                        outflow.amount.min(inflow.amount)
                    }
                }
                _ => incoming.map_or(Decimal::ZERO, |(_, inflow)| inflow.amount),
            };
            for (event, flow, amount) in [
                incoming.map(|(event, flow)| (event, flow, given)),
                outgoing.map(|(event, flow)| (event, flow, flow.amount)),
            ]
            .into_iter()
            .flatten()
            {
                let signed = if flow.leg_outflow { -amount } else { amount };
                *legs.entry((&event.account, event.date)).or_default() += signed;
            }
        }
        // What an account adds to the scope on a day, net: its row's flow,
        // or on its first day inside the scope the money that opened it (a
        // holdings account's first snapshot value, a transactions account's
        // activity flows, else its net contribution), less its legs.
        let adds = |id: &AccountId, row: &DailyValuation| -> Decimal {
            let opening = inception.get(id) == Some(&row.date) && row.date != start;
            let own = if opening && holdings(id) {
                if row.value_status != ValueStatus::Complete {
                    return Decimal::ZERO;
                }
                row.total_value_base
            } else if opening {
                let brought: Vec<PricedFlow> = effects
                    .events
                    .iter()
                    .filter(|event| {
                        &event.account == id
                            && event.date == row.date
                            && !matches!(&event.boundary, Boundary::Internal { counterparty } if counterparty == id)
                    })
                    .filter_map(|event| event.flow)
                    .collect();
                if brought.is_empty() {
                    row.net_contribution_base
                } else {
                    brought
                        .iter()
                        .map(|flow| {
                            if flow.outflow {
                                -flow.amount
                            } else {
                                flow.amount
                            }
                        })
                        .sum()
                }
            } else {
                row.flow.inflow_base - row.flow.outflow_base
            };
            own - legs.get(&(id, row.date)).copied().unwrap_or_default()
        };
        // Each account's day rounds to storage precision on its own.
        let tolerance = DUST * Decimal::from(scope.len() as u64 + 1);
        let activity_date = |id: &ActivityId| {
            pipeline
                .facts()
                .activities()
                .iter()
                .find(|a| &a.id == id)
                .map(|a| a.date)
        };
        let internal_days: BTreeSet<NaiveDate> = pipeline
            .facts()
            .transfer_pairs()
            .iter()
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
        let inception_days: BTreeSet<NaiveDate> = inception.values().copied().collect();
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
            } else if !inception_days.contains(&day.date) {
                // Without a pair or an opening, each side is the plain sum.
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
            if day.date > start {
                let expected: Decimal = scope
                    .iter()
                    .filter_map(|account| {
                        let row = pipeline
                            .series
                            .get(account)?
                            .days
                            .iter()
                            .find(|d| d.date == day.date)?;
                        Some(adds(account, &DailyValuation::stored(row)))
                    })
                    .sum();
                let net = day.flow.inflow_base - day.flow.outflow_base;
                assert!(
                    (net - expected).abs() <= tolerance,
                    "{id}: net flow {net}, its accounts add {expected} ({:?})",
                    day.flow
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

        // A dated read is the full read from its second day on (its first
        // opens it): cut between the legs of every transfer that spans days,
        // and halfway.
        let mut cuts: BTreeSet<NaiveDate> = effects
            .pairs
            .iter()
            .filter(|pair| scope.contains(&pair.in_account) && scope.contains(&pair.out_account))
            .filter_map(|pair| {
                let (out, incoming) = (
                    activity_date(&pair.transfer_out)?,
                    activity_date(&pair.transfer_in)?,
                );
                (out != incoming).then(|| out.min(incoming).succ_opt())?
            })
            .collect();
        if let Some(end) = portfolio.days.last().map(|day| day.date) {
            cuts.insert(start + (end - start) / 2);
        }
        for cut in cuts {
            let window = Window {
                start: Some(cut),
                end: None,
            };
            let Ok(dated) = aggregate_scope(&effects, &pipeline.series, &scope, window) else {
                continue;
            };
            for day in dated.days.iter().filter(|day| day.date > cut) {
                let full = portfolio
                    .days
                    .iter()
                    .find(|full| full.date == day.date)
                    .expect("a dated day is a full day");
                assert_eq!(
                    day.flow, full.flow,
                    "{}: {} read from {cut}",
                    scenario.id, day.date
                );
            }
            dated_reads += 1;
        }
    }
    assert!(
        filtered() || pair_days > 0,
        "the corpus has no internal transfer days"
    );
    assert!(
        filtered() || dated_reads > 100,
        "only {dated_reads} dated reads"
    );
}

fn portfolio_days(pipeline: &Pipeline) -> Option<Vec<DailyValuation>> {
    let effects = pipeline.effects(
        &pipeline.bundle.disposals,
        &pipeline.lots(),
        &pipeline.bundle.rejected_activities(),
    );
    aggregate_scope(
        &effects,
        &pipeline.series,
        &pipeline.portfolio_scope(),
        Window::default(),
    )
    .ok()
    .map(|scoped| scoped.days)
}

/// P-AGG-ADD (I9): a scope's flow on a day is what each of its accounts
/// adds, so what one account records never changes another's share. A
/// deposit of 1 into an extra account on every day something happens adds
/// exactly 1 to each of those days and changes no other: a transfer's
/// shortfall, a flow estimated from a net-contribution change, a holdings
/// snapshot and an account opening inside the scope keep their flows on a
/// busy day.
#[test]
fn p_agg_add_an_unrelated_deposit_adds_only_itself() {
    let mut checked = 0usize;
    for scenario in corpus() {
        let pipeline = Pipeline::from_scenario(&scenario);
        let Some(reference) = portfolio_days(&pipeline) else {
            continue;
        };
        let Some(start) = reference.first().map(|day| day.date) else {
            continue;
        };
        let scope = pipeline.portfolio_scope();
        let days: BTreeSet<NaiveDate> = reference.iter().map(|day| day.date).collect();
        let mut targets: BTreeSet<NaiveDate> = pipeline
            .facts()
            .activities()
            .iter()
            .filter(|activity| scope.contains(&activity.account))
            .map(|activity| activity.date)
            .collect();
        targets.extend(
            scenario
                .observed_snapshots
                .iter()
                .filter(|snapshot| scope.iter().any(|id| id.as_str() == snapshot.account))
                .map(|snapshot| snapshot.date),
        );
        targets.retain(|day| *day > start && days.contains(day));
        if targets.is_empty() {
            continue;
        }

        let tz: chrono_tz::Tz = scenario.policy.timezone.parse().expect("timezone");
        let mut busy = scenario.clone();
        busy.accounts.push(
            serde_yaml::from_str(&format!(
                "{{ id: zz-extra, currency: {} }}",
                scenario.policy.base_currency
            ))
            .unwrap(),
        );
        for (index, day) in targets.iter().enumerate() {
            let noon = day
                .and_hms_opt(12, 0, 0)
                .and_then(|noon| noon.and_local_timezone(tz).single())
                .expect("local noon")
                .with_timezone(&chrono::Utc)
                .format("%Y-%m-%dT%H:%M:%SZ");
            busy.activities.push(
                serde_yaml::from_str(&format!(
                    "{{ id: zz-dep-{index}, account: zz-extra, type: DEPOSIT, date: \"{noon}\", amount: 1 }}"
                ))
                .unwrap(),
            );
        }
        let changed = portfolio_days(&Pipeline::from_scenario(&busy))
            .unwrap_or_else(|| panic!("{}: the busy portfolio does not aggregate", scenario.id));
        let changed: BTreeMap<NaiveDate, &DailyValuation> =
            changed.iter().map(|day| (day.date, day)).collect();
        for day in &reference {
            let id = format!("{}: {}", scenario.id, day.date);
            let after = changed
                .get(&day.date)
                .unwrap_or_else(|| panic!("{id}: missing from the busy portfolio"));
            let added = if targets.contains(&day.date) {
                Decimal::ONE
            } else {
                Decimal::ZERO
            };
            assert_eq!(
                after.flow.inflow_base,
                day.flow.inflow_base + added,
                "{id}: inflow"
            );
            assert_eq!(
                after.flow.outflow_base, day.flow.outflow_base,
                "{id}: outflow"
            );
        }
        checked += 1;
    }
    assert!(
        filtered() || checked > 50,
        "only {checked} portfolios made busy"
    );
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
                            DiagnosticCode::MissingQuote
                                | DiagnosticCode::FxUnavailable
                                | DiagnosticCode::ValueOutOfRange
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
                        .ledger()
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
                pipeline.normalize_diagnostics().iter().any(|d| {
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
    // Every stage, `measure` included, runs on the mutated facts.
    let run = |raw: RawFacts, scenario: &Scenario| {
        if let Ok(pipeline) = Pipeline::run(raw) {
            body(&pipeline, scenario);
        }
    };
    for scenario in under_every_method(load_all_scenarios()) {
        let raw = scenario.raw_facts();
        run(raw.clone(), &scenario);
        for index in 0..raw.activities.len() {
            let mut mutated = raw.clone();
            mutated.activities.remove(index);
            run(mutated, &scenario);
        }
        let mut blank = raw.clone();
        for activity in &mut blank.activities {
            activity.currency.clear();
        }
        run(blank, &scenario);
        let mut zero = raw.clone();
        for activity in &mut zero.activities {
            activity.quantity = Some(Decimal::ZERO);
            activity.unit_price = Some(Decimal::ZERO);
        }
        run(zero, &scenario);
        let mut no_surfaces = raw.clone();
        no_surfaces.quotes.clear();
        no_surfaces.fx_rates.clear();
        run(no_surfaces, &scenario);

        // Magnitudes at and beyond the kernel range (architecture §4.3):
        // accepted inputs whose products overflow, rejected inputs, and
        // tiny divisors. Declined, diagnosed, never a panic.
        for (magnitude, tiny) in [
            (MAX_MAGNITUDE, MIN_RATE),
            (Decimal::MAX, Decimal::new(1, 28)),
        ] {
            let mut extreme = raw.clone();
            for activity in &mut extreme.activities {
                activity.quantity = activity.quantity.map(|_| magnitude);
                activity.unit_price = activity.unit_price.map(|_| magnitude);
                activity.amount = activity.amount.map(|_| magnitude);
                activity.fee = activity.fee.map(|_| magnitude);
                activity.fx_rate = activity.fx_rate.map(|_| magnitude);
            }
            run(extreme.clone(), &scenario);
            for quote in &mut extreme.quotes {
                quote.close = magnitude;
            }
            for rate in &mut extreme.fx_rates {
                rate.rate = magnitude;
            }
            run(extreme, &scenario);

            let mut tiny_divisors = raw.clone();
            for activity in &mut tiny_divisors.activities {
                activity.quantity = activity.quantity.map(|_| tiny);
                activity.fx_rate = activity.fx_rate.map(|_| tiny);
            }
            for quote in &mut tiny_divisors.quotes {
                quote.close = tiny;
            }
            for rate in &mut tiny_divisors.fx_rates {
                rate.rate = tiny;
            }
            run(tiny_divisors, &scenario);
        }
    }
}

/// Arrays sorted by content, so a comparison ignores the order rows come out
/// in (the order accounts are folded in, for one).
fn canonical(value: Value) -> Value {
    match value {
        Value::Array(items) => {
            let mut items: Vec<Value> = items.into_iter().map(canonical).collect();
            items.sort_by_cached_key(|item| item.to_string());
            Value::Array(items)
        }
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, canonical(value)))
                .collect(),
        ),
        other => other,
    }
}

/// P-NAMES: account ids name accounts, they do not order them. Renaming every
/// account so their sort order reverses changes no output once the names are
/// mapped back.
#[test]
fn p_names_account_ids_carry_no_order() {
    let mut checked = 0usize;
    for scenario in corpus() {
        if scenario.accounts.len() < 2 {
            continue;
        }
        let mut ids: Vec<String> = scenario.accounts.iter().map(|a| a.id.clone()).collect();
        ids.sort();
        let renamed_as: BTreeMap<String, String> = ids
            .iter()
            .enumerate()
            .map(|(i, id)| (id.clone(), format!("~{:03}~{id}", ids.len() - i)))
            .collect();
        let mut renamed = scenario.clone();
        for account in &mut renamed.accounts {
            account.id = renamed_as[&account.id].clone();
        }
        for activity in &mut renamed.activities {
            activity.account = renamed_as[&activity.account].clone();
        }
        for snapshot in &mut renamed.observed_snapshots {
            snapshot.account = renamed_as[&snapshot.account].clone();
        }
        for window in &mut renamed.performance_windows {
            for id in window.accounts.iter_mut().flatten() {
                *id = renamed_as[id.as_str()].clone();
            }
        }
        let mut text =
            serde_json::to_string(&body(&Pipeline::from_scenario(&renamed), &renamed)).unwrap();
        for (id, new) in &renamed_as {
            text = text.replace(new.as_str(), id);
        }
        let restored = canonical(serde_json::from_str(&text).unwrap());
        let reference = canonical(body(&Pipeline::from_scenario(&scenario), &scenario));
        assert_same(&scenario.id, "P-NAMES", &restored, &reference);
        checked += 1;
    }
    assert!(
        filtered() || checked > 20,
        "only {checked} multi-account scenarios renamed"
    );
}

/// What must not depend on the unit amounts were entered in: values, flows
/// and returns (lots and cash buckets keep the unit they were booked in).
fn money_view(body: Value) -> Value {
    let mut view = serde_json::Map::new();
    for (id, account) in body["accounts"].as_object().into_iter().flatten() {
        view.insert(
            id.clone(),
            serde_json::json!({
                "valuations": account["valuations"],
                "flows": account["flows"],
                "performance": account["performance"],
            }),
        );
    }
    serde_json::json!({
        "accounts": view,
        "portfolio": body["portfolio"],
        "portfolio_flows": body["portfolio_flows"],
    })
}

/// P-UNITS: an amount in a minor unit is the same money as in its major
/// unit. Rewriting every plain USD activity in cents (USX, amounts ×100)
/// changes no value, flow or return.
#[test]
fn p_units_minor_units_are_the_same_money() {
    const MONEY: [&str; 11] = [
        "DEPOSIT",
        "WITHDRAWAL",
        "BUY",
        "SELL",
        "DIVIDEND",
        "INTEREST",
        "FEE",
        "TAX",
        "TRANSFER_IN",
        "TRANSFER_OUT",
        "CREDIT",
    ];
    let hundred = Decimal::from(100);
    let mut checked = 0usize;
    for scenario in corpus() {
        let account_currency: BTreeMap<String, String> = scenario
            .accounts
            .iter()
            .map(|a| (a.id.clone(), a.currency.clone()))
            .collect();
        let mut cents = scenario.clone();
        let mut rewritten = 0usize;
        for activity in &mut cents.activities {
            let currency = activity
                .currency
                .clone()
                .unwrap_or_else(|| account_currency[&activity.account].clone());
            // A supplied rate or a currency in the metadata is quoted
            // against the unit as entered: leave those rows alone.
            let plain = activity.fx_rate.is_none()
                && activity.activity_type_override.is_none()
                && activity
                    .metadata
                    .as_ref()
                    .is_none_or(|m| !m.to_string().to_lowercase().contains("currency"));
            // In cents the row must still be valid input (EDGE-MAG-02 sits
            // at the largest accepted magnitude).
            let fits = [
                activity.amount,
                activity.unit_price,
                activity.fee,
                activity.tax,
            ]
            .iter()
            .flatten()
            .all(|value| (value.0 * hundred).abs() <= MAX_MAGNITUDE);
            if currency != "USD"
                || !plain
                || !fits
                || !MONEY.contains(&activity.activity_type.as_str())
            {
                continue;
            }
            activity.currency = Some("USX".to_string());
            for value in [
                &mut activity.amount,
                &mut activity.unit_price,
                &mut activity.fee,
                &mut activity.tax,
            ]
            .into_iter()
            .flatten()
            {
                value.0 *= hundred;
            }
            rewritten += 1;
        }
        if rewritten == 0 {
            continue;
        }
        let reference = money_view(body(&Pipeline::from_scenario(&scenario), &scenario));
        let in_cents = money_view(body(&Pipeline::from_scenario(&cents), &cents));
        assert_same(&scenario.id, "P-UNITS", &in_cents, &reference);
        checked += 1;
    }
    assert!(
        filtered() || checked > 20,
        "only {checked} scenarios rewritten in cents"
    );
}

/// An account state valued on `day` from the public surfaces, by P-RECON's
/// rule; `None` when a price or rate is missing, or a position is alternative
/// or split-adjusted (the valuer's own rules).
fn revalue(
    pipeline: &Pipeline,
    state: &AccountState,
    day: NaiveDate,
    split_assets: &BTreeSet<&AssetId>,
) -> Option<Decimal> {
    let policy = pipeline.facts().policy();
    let fx = pipeline.fx();
    let currency = state.currency.as_str();
    let mut total = Decimal::ZERO;
    for (asset, position) in &state.positions {
        if position.quantity.is_zero() {
            continue;
        }
        if position.alternative || split_assets.contains(asset) {
            return None;
        }
        let quote = pipeline.surfaces().quotes.latest_on_or_before(asset, day)?;
        let (major, unit) = policy.normalize_currency(quote.currency.as_str());
        let multiplier = pipeline
            .facts()
            .assets()
            .get(asset)
            .map(|a| a.contract_multiplier)
            .unwrap_or(Decimal::ONE);
        total +=
            position.quantity * quote.close * unit * multiplier * fx.rate(major, currency, day)?;
    }
    for (bucket, amount) in &state.cash {
        let (major, unit) = policy.normalize_currency(bucket.as_str());
        total += *amount * unit * fx.rate(major, currency, day)?;
    }
    Some(total)
}

/// P-FLOW: money moved in or out is what the account's value moved by. On a
/// day whose only events for an account are deposits, withdrawals and
/// transfers without charges, the account's value less its previous state's
/// value at the same prices equals the day's net flow. The account currency
/// shares the base's major unit, so no cross rate stands between them.
/// Catches a flow in the wrong unit, scale or direction, whichever stage got
/// it wrong.
#[test]
fn p_flow_flows_account_for_the_value_they_move() {
    let mut checked = 0usize;
    for scenario in corpus() {
        let pipeline = Pipeline::from_scenario(&scenario);
        let policy = pipeline.facts().policy();
        let base = policy
            .major_currency(policy.base_currency.as_str())
            .to_string();
        let split_assets: BTreeSet<&AssetId> = pipeline
            .surfaces()
            .splits
            .iter()
            .map(|s| &s.asset)
            .collect();
        let mut days: BTreeMap<(&AccountId, NaiveDate), Vec<&EconomicEvent>> = BTreeMap::new();
        for event in &pipeline.ledger().events {
            days.entry((&event.account, event.date))
                .or_default()
                .push(event);
        }
        let rejected = pipeline.bundle.rejected_activities();
        // A linked conversion inside one account moves no money in or out:
        // a rate better than the market's is a gain (#1655, as in P-TXF).
        let conversion = |e: &EconomicEvent| {
            pipeline
                .facts()
                .transfer_pairs()
                .pair_for(&e.source)
                .is_some_and(|p| p.in_account == p.out_account && p.contribution_neutral)
        };
        for ((account, day), events) in &days {
            let pure = events.iter().all(|e| {
                matches!(
                    e.kind,
                    ActivityKind::Deposit
                        | ActivityKind::Withdrawal
                        | ActivityKind::TransferIn
                        | ActivityKind::TransferOut
                ) && e.charges.fee.is_zero()
                    && e.charges.tax.is_zero()
                    && !rejected.contains(&e.source)
                    && !conversion(e)
            });
            if !pure
                || policy.major_currency(pipeline.facts().accounts()[*account].currency.as_str())
                    != base
            {
                continue;
            }
            let (Some(frames), Some(series)) = (
                pipeline.bundle.keyframes.get(*account),
                pipeline.series.get(*account),
            ) else {
                continue;
            };
            // The opening day's value is where returns start, not a flow.
            let Some(row) = series.days.iter().skip(1).find(|d| d.date == *day) else {
                continue;
            };
            if row.value_status != ValueStatus::Complete
                || matches!(
                    row.flow.source,
                    FlowSource::Unknown | FlowSource::UnknownBoundaryTransfer
                )
            {
                continue;
            }
            let Some(after) = frames.iter().find(|k| k.date == *day) else {
                continue;
            };
            let Some(value_after) = revalue(&pipeline, &after.state, *day, &split_assets) else {
                continue;
            };
            let value_before = match frames.iter().rev().find(|k| k.date < *day) {
                Some(before) => match revalue(&pipeline, &before.state, *day, &split_assets) {
                    Some(value) => value,
                    None => continue,
                },
                None => Decimal::ZERO,
            };
            let moved = value_after - value_before;
            let flow = row.flow.inflow_base - row.flow.outflow_base;
            assert!(
                (moved - flow).abs() <= DUST,
                "{}: P-FLOW violated for {account} on {day}: value moved {moved}, net flow {flow} ({:?})",
                scenario.id,
                row.flow.source
            );
            checked += 1;
        }
    }
    assert!(
        filtered() || checked > 20,
        "only {checked} flow days checked"
    );
}

/// P-REJECT: a rejected activity is as if it had never been entered. Folding
/// without it leaves every account in the same state, value and flow on every
/// day, and the fold reports nothing about the attempt but the rejection.
#[test]
fn p_reject_a_rejected_activity_leaves_no_trace() {
    let mut checked = 0usize;
    for scenario in corpus() {
        let pipeline = Pipeline::from_scenario(&scenario);
        let rejected = pipeline.bundle.rejected_activities();
        if rejected.is_empty() {
            continue;
        }
        let mut without = scenario.clone();
        without
            .activities
            .retain(|a| !rejected.contains(&ActivityId::new(a.id.as_str())));
        let other = Pipeline::from_scenario(&without);
        for (account, frames) in &pipeline.bundle.keyframes {
            for frame in frames {
                let other_frame = other
                    .bundle
                    .keyframes
                    .get(account)
                    .and_then(|f| f.iter().rev().find(|k| k.date <= frame.date));
                let expected = other_frame.map(|k| k.state.clone()).unwrap_or_else(|| {
                    AccountState::empty(account.clone(), frame.state.currency.clone())
                });
                let mut left = serde_json::to_value(&frame.state).unwrap();
                let mut right = serde_json::to_value(&expected).unwrap();
                // Totals at the day's rates are recomputed only on event
                // days: without the rejected activity the day may have none.
                if other_frame.is_none_or(|k| k.date != frame.date) {
                    for state in [&mut left, &mut right] {
                        for key in ["cash_total_account", "cash_total_base", "cost_basis"] {
                            state[key] = Value::Null;
                        }
                    }
                }
                assert_same(
                    &scenario.id,
                    &format!("P-REJECT ({account} on {})", frame.date),
                    &left,
                    &right,
                );
            }
        }
        // Nor anything valued or flowed on a day both runs value.
        for (account, series) in &pipeline.series {
            let Some(without_it) = other.series.get(account) else {
                continue;
            };
            for day in &series.days {
                let Some(same) = without_it.days.iter().find(|d| d.date == day.date) else {
                    continue;
                };
                let id = format!("{}: P-REJECT {account} on {}", scenario.id, day.date);
                assert_eq!(day.total_value_base, same.total_value_base, "{id}: value");
                assert_eq!(day.flow, same.flow, "{id}: flow");
            }
        }
        let reported: Vec<Value> = pipeline
            .bundle
            .diagnostics
            .iter()
            .filter(|d| {
                !(d.code == DiagnosticCode::ActivityRejected
                    && rejected.contains(&ActivityId::new(d.source.as_str())))
            })
            .map(|d| serde_json::to_value(d).unwrap())
            .collect();
        let expected: Vec<Value> = other
            .bundle
            .diagnostics
            .iter()
            .map(|d| serde_json::to_value(d).unwrap())
            .collect();
        assert_same(
            &scenario.id,
            "P-REJECT (diagnostics)",
            &canonical(Value::Array(reported)),
            &canonical(Value::Array(expected)),
        );
        checked += 1;
    }
    assert!(filtered() || checked > 0, "no scenario rejects an activity");
}

/// P-TXF-LEGS: a security transfer moves lots, it does not make them. The
/// incoming leg of a pair delivers what the outgoing leg removed (units, cost
/// in base and in the receiving currency, acquisition dates), plus the units
/// its sender lacked at the transfer's price, whether it opens lots or covers
/// an opposite position; no lot is left behind in the transfer cache. A pair
/// valued at cost flows the cost it moved, read from the sender.
#[test]
fn p_txf_legs_transfers_carry_their_lots() {
    let mut checked = 0usize;
    for scenario in corpus() {
        let pipeline = Pipeline::from_scenario(&scenario);
        let rejected = pipeline.bundle.rejected_activities();
        let lots = pipeline.lots();
        let fx = pipeline.fx();
        // Costs are stored rounded and then converted (into a minor unit or
        // another currency), which scales the rounding: equal within a
        // millionth, far below any currency's smallest unit.
        let close = |a: Decimal, b: Decimal| (a - b).abs() <= Decimal::new(1, 6);
        // The leg that moves the securities (a fee compiles into its own event).
        let event_of = |source: &ActivityId| {
            pipeline.ledger().events.iter().find(|e| {
                e.source == *source && matches!(e.action, Action::SecurityTransfer { .. })
            })
        };
        let opened_by = |event: &EconomicEvent| -> Vec<&LotRecord> {
            lots.iter()
                .filter(|l| {
                    l.account == event.account && l.open_activity.as_ref() == Some(&event.source)
                })
                .collect()
        };

        let effects = pipeline.effects(&pipeline.bundle.disposals, &lots, &rejected);
        let policy = pipeline.facts().policy();
        let base = policy.base_currency.as_str();

        // Lots move only between accounts the fold projects.
        let projected = |id: &AccountId| {
            pipeline
                .facts()
                .accounts()
                .get(id)
                .is_some_and(|a| !a.archived && a.tracking != TrackingMode::Holdings)
        };
        for pair in pipeline
            .facts()
            .transfer_pairs()
            .iter()
            .filter(|p| p.security)
        {
            if rejected.contains(&pair.transfer_out)
                || rejected.contains(&pair.transfer_in)
                || !projected(&pair.out_account)
                || !projected(&pair.in_account)
            {
                continue;
            }
            let (Some(out), Some(incoming)) =
                (event_of(&pair.transfer_out), event_of(&pair.transfer_in))
            else {
                continue;
            };
            let Action::SecurityTransfer {
                asset, quantity, ..
            } = &incoming.action
            else {
                continue;
            };
            // A lot record's split ratio includes splits after the transfer,
            // so units compare only without one; costs and dates do not split.
            let split_since = pipeline.facts().activities().iter().any(|a| {
                a.kind == ActivityKind::Split
                    && a.asset.as_ref() == Some(asset)
                    && a.date >= out.date
            });
            let removed: Vec<&LotDisposal> = pipeline
                .bundle
                .disposals
                .iter()
                .filter(|d| d.event == out.id)
                .collect();
            let added = opened_by(incoming);
            // Units an incoming leg uses to cover an opposite position close
            // lots instead of opening them (NOM-TXF-04): delivered all the
            // same, at the cost the cover's proceeds record.
            let covering: Vec<&LotDisposal> = pipeline
                .bundle
                .disposals
                .iter()
                .filter(|d| {
                    d.event == incoming.id && d.account == incoming.account && !d.quantity.is_zero()
                })
                .collect();
            let id = format!("{}: P-TXF-LEGS {}", scenario.id, pair.group_id);
            // A transfer moves cost and sells nothing: each lot the sender's
            // leg removes realizes nothing, in base as in its currency
            // (rules R2.4).
            for row in &removed {
                assert!(
                    row.realized_pnl.is_zero() && row.realized_pnl_base.is_zero(),
                    "{id}: {} realizes {} ({} in base)",
                    row.id,
                    row.realized_pnl,
                    row.realized_pnl_base
                );
            }
            let sent_units: Decimal = removed.iter().map(|d| d.quantity).sum();
            // Disposals count units after splits; a lot keeps its as-acquired
            // units and its ratio.
            let received_units: Decimal = added
                .iter()
                .map(|l| l.original_quantity * l.split_ratio)
                .sum::<Decimal>()
                - covering.iter().map(|d| d.quantity).sum::<Decimal>();
            // The receiver books the units its own activity records, a short
            // as a short; the sender gives what it held (nothing when it held
            // none), so a shortfall (a history that starts after the units
            // were acquired) arrives at the transfer's price and is the only
            // difference (rules R2.1, R2.5).
            let missing = *quantity - sent_units.abs();
            let topped_up = missing > DUST;
            let sign = if sent_units.is_sign_negative() {
                Decimal::NEGATIVE_ONE
            } else {
                Decimal::ONE
            };
            if !split_since {
                assert!(
                    (received_units - sign * quantity).abs() <= DUST,
                    "{id}: units {received_units} received, the activity records {quantity}"
                );
                assert!(
                    topped_up || (received_units - sent_units).abs() <= DUST,
                    "{id}: units {received_units} received, {sent_units} sent"
                );
            }

            // Cost in base: what the sender removed, plus the units it lacked
            // at the transfer's price. A leg's fee is capitalised into the
            // lots it delivers (§ the TRANSFER_IN row): costs compare only
            // without one. Units that cover keep their cost at the rates they
            // were acquired at, as opened lots do (rules R2.4, EDGE-TXF-16).
            let fees = !out.charges.fee.is_zero() || !incoming.charges.fee.is_zero();
            let sent_base: Decimal = removed.iter().map(|d| d.cost_basis_base).sum();
            let topped_up_base = if topped_up {
                pipeline
                    .facts()
                    .activities()
                    .iter()
                    .find(|a| a.id == pair.transfer_in)
                    .and_then(|activity| {
                        let (major, unit) = policy.normalize_currency(activity.currency.as_str());
                        let multiplier = pipeline
                            .facts()
                            .assets()
                            .get(asset)
                            .map(|a| a.contract_multiplier)
                            .unwrap_or(Decimal::ONE);
                        fx.convert(
                            sign * missing * activity.unit_price * unit * multiplier,
                            major,
                            base,
                            incoming.date,
                        )
                    })
            } else {
                Some(Decimal::ZERO)
            };
            let moved_base = topped_up_base
                .filter(|_| !fees)
                .map(|topped_up_base| sent_base + topped_up_base);
            if let Some(moved_base) = moved_base {
                let covered_base: Decimal = covering
                    .iter()
                    .map(|d| {
                        if d.quantity.is_sign_negative() {
                            d.proceeds_base.abs()
                        } else {
                            -d.proceeds_base.abs()
                        }
                    })
                    .sum();
                let received_base: Decimal = added
                    .iter()
                    .map(|l| l.original_cost_basis_base)
                    .sum::<Decimal>()
                    + covered_base;
                assert!(
                    close(received_base, moved_base),
                    "{id}: cost in base {received_base} received, {moved_base} moved"
                );
                // Without a quote both legs flow at cost: the incoming one
                // what the pair moved, read from the sender's records
                // (EDGE-TXF-15), never from what the receiver booked.
                let at_cost = effects
                    .events
                    .iter()
                    .find(|e| e.source == pair.transfer_in && e.account == incoming.account)
                    .and_then(|e| e.flow)
                    .filter(|flow| flow.source == FlowSource::CostBasisFallback);
                if let Some(flow) = at_cost {
                    assert!(
                        close(flow.amount, moved_base.abs()),
                        "{id}: the incoming leg flows {} at cost, the pair moved {moved_base}",
                        flow.amount
                    );
                }
            }

            let sources: Option<Vec<&LotRecord>> = removed
                .iter()
                .map(|d| {
                    lots.iter()
                        .find(|l| l.id == d.lot_id && l.account == out.account)
                })
                .collect();
            let Some(sources) = sources else {
                continue;
            };
            // As sets: a lot split by the sender's dust (a split's rounding)
            // is one acquisition, and dust is not booked. Units the sender
            // lacked are acquired on the transfer's day; covering units open
            // nothing.
            let sent_dates: BTreeSet<NaiveDate> = sources.iter().map(|l| l.open_date).collect();
            let received_dates: BTreeSet<NaiveDate> = added.iter().map(|l| l.open_date).collect();
            let mut allowed = sent_dates.clone();
            if topped_up {
                allowed.insert(incoming.date);
            }
            assert!(
                received_dates.is_subset(&allowed),
                "{id}: acquisition dates {received_dates:?} received, {sent_dates:?} sent"
            );
            if covering.is_empty() {
                assert!(
                    sent_dates.is_subset(&received_dates),
                    "{id}: acquisition dates {received_dates:?} received, {sent_dates:?} sent"
                );
            }
            let plain = !fees && !topped_up;
            let receiving = added
                .first()
                .map(|l| l.currency.as_str())
                .or_else(|| covering.first().map(|d| d.currency.as_str()));
            if let Some(receiving) = receiving.filter(|_| plain) {
                let sent = removed
                    .iter()
                    .zip(&sources)
                    .map(|(d, lot)| {
                        fx.convert(d.cost_basis, d.currency.as_str(), receiving, lot.open_date)
                    })
                    .sum::<Option<Decimal>>();
                if let Some(sent) = sent {
                    let covered: Decimal = covering
                        .iter()
                        .map(|d| {
                            if d.quantity.is_sign_negative() {
                                d.proceeds.abs()
                            } else {
                                -d.proceeds.abs()
                            }
                        })
                        .sum();
                    let received: Decimal =
                        added.iter().map(|l| l.original_cost_basis).sum::<Decimal>() + covered;
                    assert!(
                        close(received, sent),
                        "{id}: cost {received} {receiving} received, {sent} sent"
                    );
                }
            }
            checked += 1;
        }

        // Nothing stranded: a cached group waits for an incoming leg after the range.
        let end = pipeline.range().end;
        for group in pipeline.bundle.final_state.transfer_cache.keys() {
            let pending = pipeline
                .facts()
                .transfer_pairs()
                .iter()
                .find(|p| p.group_id == *group)
                .and_then(|p| event_of(&p.transfer_in))
                .is_some_and(|e| e.date > end);
            assert!(
                pending,
                "{}: P-TXF-LEGS lots of {group} left in the transfer cache",
                scenario.id
            );
        }

        // An unpaired transfer valued at cost carries the cost it booked,
        // less the charges capitalised into it (they are no flow,
        // NOM-TXF-03); a paired one is checked above against its sender.
        for effect in &effects.events {
            let Some(flow) = &effect.flow else { continue };
            if flow.source != FlowSource::CostBasisFallback
                || pipeline
                    .facts()
                    .transfer_pairs()
                    .pair_for(&effect.source)
                    .is_some()
            {
                continue;
            }
            let Some(event) = event_of(&effect.source) else {
                continue;
            };
            let added = opened_by(event);
            if added.is_empty() {
                continue;
            }
            // The leg's own fee (capitalised; its tax is not), not the fees
            // its lots carried in from the sender's purchases (part of the
            // cost).
            let Some(charges) =
                fx.convert(event.charges.fee, event.currency.as_str(), base, event.date)
            else {
                continue;
            };
            // A short's cost is negative; the flow carries the size.
            let booked: Decimal = (added
                .iter()
                .map(|l| l.original_cost_basis_base)
                .sum::<Decimal>()
                - charges)
                .abs();
            assert!(
                (flow.amount - booked).abs() <= DUST,
                "{}: P-TXF-LEGS {} flows {} at cost but booked {booked}",
                scenario.id,
                effect.source,
                flow.amount
            );
        }
    }
    assert!(
        filtered() || checked > 5,
        "only {checked} security transfer pairs checked"
    );
}
