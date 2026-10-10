//! P-IMPACT: `impact` is sound. For every scenario and a set of single-fact
//! mutations (a close, an FX rate, an activity, an observed snapshot, an
//! asset's facts), each recorded the way the store's triggers record it, a
//! full rebuild after the change differs from the one before only where the
//! kernel said: nothing before an account's first stale day, nothing in an
//! account it did not name, and no fold output of an account it only
//! revalues.
//!
//! P-REVALUE: what `impact` only revalues can be revalued. Valued again from
//! what the last run stored, as the shell revalues it, such an account yields
//! the full rebuild's rows from its stale day.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]

mod support;

use std::collections::{BTreeMap, BTreeSet};

use chrono::{NaiveDate, TimeZone, Utc};
use rust_decimal::Decimal;
use serde_json::Value;
use support::*;
use wealthfolio_portfolio_engine::model::*;
use wealthfolio_portfolio_engine::{
    impact, value_window, Diagnostic, DiagnosticCode, FactChange, Impact, Resolved, ValueInputs,
    BEGINNING,
};

/// The fixtures (but shell-level ones) under every cost basis method, and the
/// generated scenarios under the default one: they add account shapes, not
/// methods.
fn corpus() -> Vec<Scenario> {
    let fixtures = under_every_method(
        load_all_scenarios()
            .into_iter()
            .filter(|s| !s.markers.iter().any(|m| m == "S") && scenario_selected(&s.id)),
    );
    let generated = generated_scenarios()
        .into_iter()
        .filter(|s| scenario_selected(&s.id));
    fixtures.chain(generated).collect()
}

struct Mutation {
    label: String,
    raw: RawFacts,
    changes: Vec<FactChange>,
}

fn account(id: &str) -> AccountId {
    AccountId::new(id)
}

/// What the activity triggers record for `activities`: each row's account
/// from the day before its UTC date, its transfer partners from theirs, and
/// for a split, the asset (its adjustment is asset-wide).
fn activity_changes(all: &[RawActivity], activities: &[&RawActivity]) -> Vec<FactChange> {
    let mut changes = Vec::new();
    let mark = |activity: &RawActivity, changes: &mut Vec<FactChange>| {
        let day = activity.timestamp.date_naive();
        changes.push(FactChange::Account {
            account: account(&activity.account_id),
            from: day.pred_opt().unwrap_or(day),
        });
    };
    for activity in activities {
        mark(activity, &mut changes);
        if let Some(group) = &activity.source_group_id {
            for partner in all
                .iter()
                .filter(|a| a.source_group_id.as_ref() == Some(group))
            {
                mark(partner, &mut changes);
            }
        }
        if activity.activity_type.eq_ignore_ascii_case("SPLIT") {
            if let Some(asset) = &activity.asset_id {
                changes.push(FactChange::Asset {
                    asset: AssetId::new(asset),
                });
            }
        }
    }
    changes
}

/// Activities a generated scenario mutates, spread over its history: they
/// repeat the fixtures' kinds of change, and mutating every one would make
/// the law slow.
const GENERATED_ACTIVITY_MUTATIONS: usize = 6;

/// The single-fact changes of `raw`; `activities` caps how many activities
/// are changed, moved, removed and rescheduled (`None`: every one).
fn mutations(raw: &RawFacts, activities: Option<usize>) -> Vec<Mutation> {
    let mut out = Vec::new();
    let scale = |value: Decimal, factor: Decimal| (value * factor).round_dp(8);

    // Closes: change, remove and add one in the middle of each asset's series.
    let mut assets: Vec<&str> = raw.quotes.iter().map(|q| q.asset_id.as_str()).collect();
    assets.sort();
    assets.dedup();
    for asset in assets {
        let mut days: Vec<(usize, NaiveDate)> = raw
            .quotes
            .iter()
            .enumerate()
            .filter(|(_, q)| q.asset_id == asset)
            .map(|(i, q)| (i, q.day))
            .collect();
        days.sort_by_key(|(_, day)| *day);
        let (index, day) = days[days.len() / 2];
        let prices = |day| {
            vec![FactChange::Prices {
                asset: AssetId::new(asset),
                from: day,
            }]
        };
        let mut changed = raw.clone();
        changed.quotes[index].close = scale(changed.quotes[index].close, Decimal::new(11, 1));
        out.push(Mutation {
            label: format!("close of {asset} on {day} changed"),
            raw: changed,
            changes: prices(day),
        });
        let mut removed = raw.clone();
        removed.quotes.remove(index);
        out.push(Mutation {
            label: format!("close of {asset} on {day} removed"),
            raw: removed,
            changes: prices(day),
        });
        let added_day = day + chrono::Duration::days(1);
        if !days.iter().any(|(_, d)| *d == added_day) {
            let mut added = raw.clone();
            let mut quote = raw.quotes[index].clone();
            quote.day = added_day;
            quote.close = scale(quote.close, Decimal::new(9, 1));
            added.quotes.push(quote);
            out.push(Mutation {
                label: format!("close of {asset} on {added_day} added"),
                raw: added,
                changes: prices(added_day),
            });
        }
    }

    // The two closes around a split decide whether the provider already
    // adjusted the series: rescale the one before by the ratio (flipping that
    // verdict) and remove either.
    for split in raw
        .activities
        .iter()
        .filter(|a| a.activity_type.eq_ignore_ascii_case("SPLIT"))
    {
        let (Some(asset), Some(ratio)) = (&split.asset_id, split.amount.or(split.quantity)) else {
            continue;
        };
        let split_day = split.timestamp.date_naive();
        let mut closes: Vec<(usize, NaiveDate)> = raw
            .quotes
            .iter()
            .enumerate()
            .filter(|(_, q)| &q.asset_id == asset)
            .map(|(i, q)| (i, q.day))
            .collect();
        closes.sort_by_key(|(_, day)| *day);
        let before = closes.iter().rev().find(|(_, day)| *day < split_day);
        let after = closes.iter().find(|(_, day)| *day >= split_day);
        let prices = |day| {
            vec![FactChange::Prices {
                asset: AssetId::new(asset),
                from: day,
            }]
        };
        if let Some(&(index, day)) = before {
            let mut rescaled = raw.clone();
            rescaled.quotes[index].close = scale(rescaled.quotes[index].close, ratio);
            out.push(Mutation {
                label: format!("close of {asset} before its split rescaled"),
                raw: rescaled,
                changes: prices(day),
            });
        }
        for &(index, day) in before.into_iter().chain(after) {
            let mut removed = raw.clone();
            removed.quotes.remove(index);
            out.push(Mutation {
                label: format!("close of {asset} on {day} next to its split removed"),
                raw: removed,
                changes: prices(day),
            });
        }
    }

    // FX rates: change, remove and add one in the middle of each pair.
    let mut pairs: Vec<(&str, &str)> = raw
        .fx_rates
        .iter()
        .map(|r| (r.from.as_str(), r.to.as_str()))
        .collect();
    pairs.sort();
    pairs.dedup();
    for (from, to) in pairs {
        let mut days: Vec<(usize, NaiveDate)> = raw
            .fx_rates
            .iter()
            .enumerate()
            .filter(|(_, r)| r.from == from && r.to == to)
            .map(|(i, r)| (i, r.day))
            .collect();
        days.sort_by_key(|(_, day)| *day);
        let (index, day) = days[days.len() / 2];
        let rate = |day| {
            vec![FactChange::FxRate {
                from: from.to_string(),
                to: to.to_string(),
                day,
            }]
        };
        let mut changed = raw.clone();
        changed.fx_rates[index].rate = scale(changed.fx_rates[index].rate, Decimal::new(105, 2));
        out.push(Mutation {
            label: format!("{from}/{to} rate on {day} changed"),
            raw: changed,
            changes: rate(day),
        });
        let mut removed = raw.clone();
        removed.fx_rates.remove(index);
        out.push(Mutation {
            label: format!("{from}/{to} rate on {day} removed"),
            raw: removed,
            changes: rate(day),
        });
        let added_day = day + chrono::Duration::days(2);
        if !days.iter().any(|(_, d)| *d == added_day) {
            let mut added = raw.clone();
            let mut observation = raw.fx_rates[index].clone();
            observation.day = added_day;
            observation.rate = scale(observation.rate, Decimal::new(95, 2));
            added.fx_rates.push(observation);
            out.push(Mutation {
                label: format!("{from}/{to} rate on {added_day} added"),
                raw: added,
                changes: rate(added_day),
            });
        }
    }

    // Activities: change the amount (or quantity), move it three days later,
    // or remove it.
    let step = activities.map_or(1, |cap| raw.activities.len().div_ceil(cap.max(1)).max(1));
    for (index, activity) in raw.activities.iter().enumerate().step_by(step) {
        let mut changed = raw.clone();
        let row = &mut changed.activities[index];
        match (row.amount, row.quantity) {
            (Some(amount), _) if !amount.is_zero() => {
                row.amount = Some(scale(amount, Decimal::new(11, 1)))
            }
            (_, Some(quantity)) if !quantity.is_zero() => {
                row.quantity = Some(scale(quantity, Decimal::new(11, 1)))
            }
            _ => row.fee = Some(Decimal::ONE),
        }
        let changes = activity_changes(&raw.activities, &[activity]);
        out.push(Mutation {
            label: format!("activity {} changed", activity.id),
            raw: changed,
            changes: changes.clone(),
        });

        let mut moved = raw.clone();
        moved.activities[index].timestamp += chrono::Duration::days(3);
        let after = moved.activities[index].clone();
        out.push(Mutation {
            label: format!("activity {} moved", activity.id),
            raw: moved,
            changes: activity_changes(&raw.activities, &[activity, &after]),
        });

        let mut removed = raw.clone();
        removed.activities.remove(index);
        out.push(Mutation {
            label: format!("activity {} removed", activity.id),
            raw: removed,
            changes,
        });

        // Rescheduled after `as_of`: its account may be left with nothing
        // to fold.
        let later = raw.policy.as_of + chrono::Duration::days(5);
        if activity.timestamp.date_naive() <= later {
            let mut scheduled = raw.clone();
            scheduled.activities[index].timestamp =
                Utc.from_utc_datetime(&later.and_hms_opt(12, 0, 0).unwrap());
            let after = scheduled.activities[index].clone();
            out.push(Mutation {
                label: format!("activity {} rescheduled after as_of", activity.id),
                raw: scheduled,
                changes: activity_changes(&raw.activities, &[activity, &after]),
            });
        }
    }

    // Every account gains a deposit: inside the range (for an account without
    // activity, its first) and after `as_of` (scheduled).
    let as_of = raw.policy.as_of;
    for account in &raw.accounts {
        for (label, day) in [
            ("dated", as_of - chrono::Duration::days(2)),
            ("scheduled", as_of + chrono::Duration::days(5)),
        ] {
            let instant = Utc.from_utc_datetime(&day.and_hms_opt(12, 0, 0).unwrap());
            let deposit = RawActivity {
                destination_amount: None,
                destination_currency: None,
                id: format!("{}-{label}-deposit", account.id),
                account_id: account.id.clone(),
                asset_id: None,
                activity_type: "DEPOSIT".to_string(),
                activity_type_override: None,
                subtype: None,
                status: "POSTED".to_string(),
                timestamp: instant,
                created_at: instant,
                quantity: None,
                unit_price: None,
                amount: Some(Decimal::ONE_HUNDRED),
                fee: None,
                tax: None,
                currency: account.currency.clone(),
                fx_rate: None,
                source_group_id: None,
                external_transfer: None,
                fx_conversion: None,
                source_system: None,
                is_user_modified: false,
                updated_at: instant,
            };
            let mut added = raw.clone();
            added.activities.push(deposit.clone());
            out.push(Mutation {
                label: format!("{label} deposit added to {}", account.id),
                raw: added,
                changes: activity_changes(&raw.activities, &[&deposit]),
            });
        }
    }

    // Observed snapshots: the snapshot triggers record the account from the
    // snapshot's day.
    for (index, snapshot) in raw.observed_snapshots.iter().enumerate() {
        let mut changed = raw.clone();
        let row = &mut changed.observed_snapshots[index];
        match row.cash.first_mut() {
            Some((_, amount)) => *amount += Decimal::ONE_HUNDRED,
            None => row.cash.push(("USD".to_string(), Decimal::ONE_HUNDRED)),
        }
        out.push(Mutation {
            label: format!(
                "snapshot of {} on {} changed",
                snapshot.account_id, snapshot.date
            ),
            raw: changed,
            changes: vec![FactChange::Account {
                account: account(&snapshot.account_id),
                from: snapshot.date,
            }],
        });
    }

    // Asset facts: its quote currency.
    for (index, asset) in raw.assets.iter().enumerate() {
        let mut changed = raw.clone();
        changed.assets[index].quote_currency = "EUR".to_string();
        out.push(Mutation {
            label: format!("quote currency of {} changed", asset.id),
            raw: changed,
            changes: vec![FactChange::Asset {
                asset: AssetId::new(&asset.id),
            }],
        });
    }
    out
}

fn values<T: serde::Serialize>(items: impl Iterator<Item = T>) -> Vec<Value> {
    items
        .map(|item| serde_json::to_value(item).unwrap())
        .collect()
}

/// The first place `after` differs from `before` where `impact` said nothing
/// could have changed.
fn unsound(before: &Pipeline, after: &Pipeline, impact: &Impact) -> Option<String> {
    let mut accounts: Vec<AccountId> = before
        .series
        .keys()
        .chain(after.series.keys())
        .chain(before.bundle.keyframes.keys())
        .chain(after.bundle.keyframes.keys())
        .cloned()
        .collect();
    accounts.sort();
    accounts.dedup();
    for id in accounts {
        let refold = impact.refold.get(&id).copied();
        let stale = [refold, impact.revalue.get(&id).copied()]
            .into_iter()
            .flatten()
            .min();
        let fold_cutoff = refold.unwrap_or(NaiveDate::MAX);
        let value_cutoff = stale.unwrap_or(NaiveDate::MAX);

        let frames = |p: &Pipeline| {
            values(
                p.bundle
                    .keyframes
                    .get(&id)
                    .into_iter()
                    .flatten()
                    .filter(|f| f.date < fold_cutoff),
            )
        };
        if frames(before) != frames(after) {
            return Some(format!("{id}: keyframes before {fold_cutoff}"));
        }
        let disposals = |p: &Pipeline| {
            values(
                p.bundle
                    .disposals
                    .iter()
                    .filter(|d| d.account == id && d.date < fold_cutoff),
            )
        };
        if disposals(before) != disposals(after) {
            return Some(format!("{id}: disposals before {fold_cutoff}"));
        }
        if refold.is_none() {
            let state = |p: &Pipeline| {
                p.bundle
                    .final_state
                    .accounts
                    .get(&id)
                    .map(|s| serde_json::to_value(s).unwrap())
            };
            if state(before) != state(after) {
                return Some(format!("{id}: final state (fold output) without a refold"));
            }
        }
        let days = |p: &Pipeline| -> BTreeMap<NaiveDate, Value> {
            p.series
                .get(&id)
                .into_iter()
                .flat_map(|s| s.days.iter())
                .filter(|d| d.date < value_cutoff)
                .map(|d| (d.date, serde_json::to_value(d).unwrap()))
                .collect()
        };
        let (b, a) = (days(before), days(after));
        if b != a {
            let first = b
                .iter()
                .find(|(day, value)| a.get(day) != Some(value))
                .map(|(day, _)| *day)
                .or_else(|| a.keys().find(|day| !b.contains_key(day)).copied());
            return Some(format!(
                "{id}: valuations before {value_cutoff} differ (first {first:?})"
            ));
        }
    }
    None
}

/// The first account `impact` only revalues whose rows, valued again from
/// what `before` stored (as the shell's revalue reads it), differ from
/// `after`'s from its stale day: its keyframes from that day, the last one
/// before as the seed, the stored lots and disposals of the revalued accounts
/// and the activities the last fold rejected, against the facts and surfaces
/// as they are now. A holdings account's keyframes are its observed snapshots.
fn unrevaluable(before: &Pipeline, after: &Pipeline, impact: &Impact) -> Option<String> {
    let revalued: BTreeSet<&AccountId> = impact
        .revalue
        .keys()
        .filter(|id| !impact.refold.contains_key(*id))
        .collect();
    if revalued.is_empty() {
        return None;
    }
    let owner: BTreeMap<&str, &AccountId> = before
        .facts()
        .activities()
        .iter()
        .map(|a| (a.id.as_str(), &a.account))
        .collect();
    let rejected: Vec<Diagnostic> = before
        .ledger()
        .diagnostics
        .iter()
        .chain(&before.bundle.diagnostics)
        .filter(|d| {
            d.code == DiagnosticCode::ActivityRejected
                && owner
                    .get(d.source.as_str())
                    .is_some_and(|account| revalued.contains(account))
        })
        .cloned()
        .collect();
    let disposals: Vec<LotDisposal> = before
        .bundle
        .disposals
        .iter()
        .filter(|d| revalued.contains(&d.account))
        .cloned()
        .collect();
    let lots: Vec<LotRecord> = before
        .lots()
        .into_iter()
        .filter(|lot| revalued.contains(&lot.account))
        .collect();
    let facts = after.facts();
    let as_of = facts.policy().as_of;
    // The shell's range starts at the first fact, clamped to `as_of`.
    let genesis = facts
        .activities()
        .iter()
        .map(|a| a.date)
        .chain(facts.observed_snapshots().iter().map(|s| s.date))
        .min()
        .unwrap_or(as_of)
        .min(as_of);
    for id in revalued {
        let from = impact.revalue[id];
        let start = from.max(genesis).min(as_of);
        let mut keyframes = BTreeMap::new();
        let mut seed = BTreeMap::new();
        if facts
            .accounts()
            .get(id)
            .is_some_and(|a| a.tracking != TrackingMode::Holdings)
        {
            let stored = before
                .bundle
                .keyframes
                .get(id)
                .map(Vec::as_slice)
                .unwrap_or_default();
            if let Some(last) = stored.iter().rev().find(|f| f.date < start) {
                seed.insert(id.clone(), last.state.clone());
            }
            keyframes.insert(
                id.clone(),
                stored
                    .iter()
                    .filter(|f| f.date >= start && f.date <= as_of)
                    .cloned()
                    .collect::<Vec<_>>(),
            );
        }
        let bundle = ProjectionBundle {
            keyframes,
            final_state: ProjectionState {
                date: as_of,
                accounts: BTreeMap::new(),
                transfer_cache: BTreeMap::new(),
            },
            disposals: disposals.clone(),
            closures: Vec::new(),
            diagnostics: rejected.clone(),
        };
        let only = BTreeSet::from([id.clone()]);
        let series = value_window(
            &ValueInputs {
                resolved: Resolved {
                    facts,
                    ledger: after.ledger(),
                    surfaces: after.surfaces(),
                    range: DateRange { start, end: as_of },
                },
                bundle: &bundle,
                lots: Some(&lots),
            },
            &seed,
            Some(&only),
        );
        let first = from.max(start);
        let days = |series: &BTreeMap<AccountId, ValuationSeries>| -> Vec<Value> {
            values(
                series
                    .get(id)
                    .into_iter()
                    .flat_map(|s| s.days.iter())
                    .filter(|d| d.date >= first),
            )
        };
        let (revalued, rebuilt) = (days(&series), days(&after.series));
        if revalued != rebuilt {
            return Some(format!(
                "{id}: revalued from {from}, {} rows from what was stored, {} in a full run",
                revalued.len(),
                rebuilt.len()
            ));
        }
    }
    None
}

#[test]
fn p_impact_names_every_output_a_change_can_move() {
    let mut checked = 0;
    let mut failures = Vec::new();
    for scenario in corpus() {
        let raw = scenario.raw_facts();
        let Ok(before) = Pipeline::run(raw.clone()) else {
            continue;
        };
        let cap = scenario
            .id
            .starts_with("GEN-")
            .then_some(GENERATED_ACTIVITY_MUTATIONS);
        for mutation in mutations(&raw, cap) {
            let Ok(after) = Pipeline::run(mutation.raw) else {
                continue;
            };
            let impact = impact(after.facts(), after.surfaces(), &mutation.changes);
            checked += 1;
            if let Some(problem) = unsound(&before, &after, &impact) {
                failures.push(format!("{} / {}: {problem}", scenario.id, mutation.label));
            }
            if let Some(problem) = unrevaluable(&before, &after, &impact) {
                failures.push(format!(
                    "{} / {}: P-REVALUE {problem}",
                    scenario.id, mutation.label
                ));
            }
        }
    }
    assert!(checked > 0, "no mutation checked");
    assert!(
        failures.is_empty(),
        "P-IMPACT violated in {} of {checked} mutations:\n  {}",
        failures.len(),
        failures.join("\n  ")
    );
}

/// The day moves one, four or ten days on: the store holds valuations through the old
/// `as_of` and records each account's first missing day (an account never
/// valued, from the beginning).
#[test]
fn p_impact_covers_a_moving_day() {
    let mut checked = 0;
    let mut failures = Vec::new();
    for scenario in corpus() {
        let raw = scenario.raw_facts();
        for shift in [1, 4, 10] {
            let mut earlier = raw.clone();
            earlier.policy.as_of = raw.policy.as_of - chrono::Duration::days(shift);
            let (Ok(before), Ok(after)) = (Pipeline::run(earlier), Pipeline::run(raw.clone()))
            else {
                continue;
            };
            let changes: Vec<FactChange> = after
                .facts()
                .accounts()
                .keys()
                .map(
                    |id| match before.series.get(id).and_then(|s| s.days.last()) {
                        Some(last) => FactChange::Extended {
                            account: id.clone(),
                            from: last.date.succ_opt().unwrap(),
                        },
                        None => FactChange::Account {
                            account: id.clone(),
                            from: BEGINNING,
                        },
                    },
                )
                .collect();
            let impact = impact(after.facts(), after.surfaces(), &changes);
            checked += 1;
            if let Some(problem) = unsound(&before, &after, &impact) {
                failures.push(format!("{} (+{shift} days): {problem}", scenario.id));
            }
            if let Some(problem) = unrevaluable(&before, &after, &impact) {
                failures.push(format!(
                    "{} (+{shift} days): P-REVALUE {problem}",
                    scenario.id
                ));
            }
        }
    }
    assert!(checked > 0, "no day move checked");
    assert!(
        failures.is_empty(),
        "P-IMPACT violated in {} of {checked} day moves:\n  {}",
        failures.len(),
        failures.join("\n  ")
    );
}
