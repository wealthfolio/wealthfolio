//! P-IMPACT: `impact` is sound. For every scenario and a set of single-fact
//! mutations (a close, an FX rate, an activity, an observed snapshot, an
//! asset's facts), each recorded the way the store's triggers record it, a
//! full rebuild after the change differs from the one before only where the
//! kernel said: nothing before an account's first stale day, nothing in an
//! account it did not name, and no fold output of an account it only
//! revalues.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]

mod support;

use std::collections::BTreeMap;

use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde_json::Value;
use support::*;
use wealthfolio_portfolio_engine::model::*;
use wealthfolio_portfolio_engine::{impact, FactChange, Impact, BEGINNING};

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

fn mutations(raw: &RawFacts) -> Vec<Mutation> {
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
    for (index, activity) in raw.activities.iter().enumerate() {
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

#[test]
fn p_impact_names_every_output_a_change_can_move() {
    let mut checked = 0;
    let mut failures = Vec::new();
    for scenario in under_every_method(
        load_all_scenarios()
            .into_iter()
            .filter(|s| !s.markers.iter().any(|m| m == "S") && scenario_selected(&s.id)),
    ) {
        let raw = scenario.raw_facts();
        let Ok(before) = Pipeline::run(raw.clone()) else {
            continue;
        };
        for mutation in mutations(&raw) {
            let Ok(after) = Pipeline::run(mutation.raw) else {
                continue;
            };
            let impact = impact(after.facts(), after.surfaces(), &mutation.changes);
            checked += 1;
            if let Some(problem) = unsound(&before, &after, &impact) {
                failures.push(format!("{} / {}: {problem}", scenario.id, mutation.label));
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
    for scenario in under_every_method(
        load_all_scenarios()
            .into_iter()
            .filter(|s| !s.markers.iter().any(|m| m == "S") && scenario_selected(&s.id)),
    ) {
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
