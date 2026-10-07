//! Which stored outputs a change of facts makes stale (architecture §3.3). The
//! answer is derived here, from what the stages read, so the shell records only
//! what changed and never restates the kernel's dependencies.

use std::collections::{BTreeMap, BTreeSet};

use chrono::NaiveDate;

use crate::model::*;
use crate::resolve::ResolvedSurfaces;

/// "From the beginning": earlier than any fact.
pub const BEGINNING: NaiveDate = match NaiveDate::from_ymd_opt(1, 1, 1) {
    Some(day) => day,
    None => panic!("0001-01-01 is a valid date"),
};

/// A change the shell observed, as its store recorded it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FactChange {
    /// The account's activities, accounting settings or observed snapshots
    /// changed, the earliest from `from`.
    Account { account: AccountId, from: NaiveDate },
    /// The asset's own facts (kind, currency, instrument, splits) changed.
    Asset { asset: AssetId },
    /// The asset's prices changed, the earliest on `from`.
    Prices { asset: AssetId, from: NaiveDate },
    /// A rate between two currencies was added, changed or removed on `day`.
    FxRate {
        from: String,
        to: String,
        day: NaiveDate,
    },
    /// The valued range grew: the account's stored valuations end the day
    /// before `from`.
    Extended { account: AccountId, from: NaiveDate },
    /// The base currency or the timezone changed.
    Policy,
}

/// First stale day per account. A refolded account is folded again and its
/// rows rewritten from its day; a revalued one keeps its keyframes, lots and
/// disposals and has only its valuations rewritten from its day.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Impact {
    pub refold: BTreeMap<AccountId, NaiveDate>,
    pub revalue: BTreeMap<AccountId, NaiveDate>,
}

/// The accounts `changes` make stale over the facts as they are now, and the
/// first day each must be rewritten from (P-IMPACT: everything before it, and
/// every account not named, is what a full rebuild would produce).
pub fn impact(
    facts: &CanonicalFacts,
    surfaces: &ResolvedSurfaces,
    changes: &[FactChange],
) -> Impact {
    let as_of = facts.policy.as_of;
    let mut holders: BTreeMap<&AssetId, BTreeSet<&AccountId>> = BTreeMap::new();
    let mut last_activity: BTreeMap<&AccountId, NaiveDate> = BTreeMap::new();
    // Accounts with an activity in the range: the fold keyframes them.
    let mut folded: BTreeSet<&AccountId> = BTreeSet::new();
    // Days of each account's activities and observed snapshots.
    let mut fact_days: BTreeMap<&AccountId, BTreeSet<NaiveDate>> = BTreeMap::new();
    let mut splits: BTreeMap<&AssetId, BTreeSet<NaiveDate>> = BTreeMap::new();
    for activity in &facts.activities {
        if activity.date <= as_of {
            folded.insert(&activity.account);
        }
        if let Some(asset) = &activity.asset {
            holders.entry(asset).or_default().insert(&activity.account);
            if activity.kind == ActivityKind::Split {
                splits.entry(asset).or_default().insert(activity.date);
            }
        }
        let last = last_activity
            .entry(&activity.account)
            .or_insert(activity.date);
        *last = (*last).max(activity.date);
        fact_days
            .entry(&activity.account)
            .or_default()
            .insert(activity.date);
    }
    for snapshot in &facts.observed_snapshots {
        for asset in snapshot.positions.keys() {
            holders.entry(asset).or_default().insert(&snapshot.account);
        }
        fact_days
            .entry(&snapshot.account)
            .or_default()
            .insert(snapshot.date);
    }
    let holders_of = |asset: &AssetId| holders.get(asset).into_iter().flatten().copied();

    let mut impact = Impact::default();
    for change in changes {
        match change {
            FactChange::Account { account, from } => {
                lower(&mut impact.refold, account, *from);
            }
            FactChange::Asset { asset } => {
                for account in holders_of(asset) {
                    lower(&mut impact.refold, account, BEGINNING);
                }
            }
            FactChange::Prices { asset, from } => {
                // Only valuation reads prices, from the day on. A close next
                // to a split also decides whether the provider already
                // adjusted it, which rescales every earlier price.
                let next_to_split = splits
                    .get(asset)
                    .is_some_and(|days| next_to_split(surfaces, asset, days, *from));
                let from = if next_to_split { BEGINNING } else { *from };
                for account in holders_of(asset) {
                    lower(&mut impact.revalue, account, from);
                }
            }
            FactChange::FxRate { from, to, day } => {
                // Conversions take the nearest observation either way, so a
                // rate reaches back to the day after the pair's previous one
                // (the recorded day and the rate's day may differ by one).
                // Valuations convert every day; the fold on activity days.
                let policy = &facts.policy;
                let before = day.pred_opt().unwrap_or(*day);
                let reach = surfaces
                    .fx
                    .previous_observation(
                        policy.major_currency(from),
                        policy.major_currency(to),
                        before,
                    )
                    .and_then(|previous| previous.succ_opt())
                    .unwrap_or(BEGINNING)
                    .min(*day);
                for account in facts.accounts.keys() {
                    lower(&mut impact.revalue, account, reach);
                    if last_activity
                        .get(account)
                        .is_some_and(|last| *last >= reach)
                    {
                        lower(&mut impact.refold, account, reach);
                    }
                }
            }
            FactChange::Extended { account, from } => {
                // The new days need valuations; facts dated in them were
                // after the previous range, so the fold skipped them. When
                // every fact is that recent, the stored days were only the
                // placeholder of a range that had not started.
                lower(&mut impact.revalue, account, *from);
                let new_days = *from..=as_of;
                if let Some(days) = fact_days
                    .get(account)
                    .filter(|days| days.range(new_days.clone()).next().is_some())
                {
                    let refold = if days.first().is_some_and(|first| first >= from) {
                        BEGINNING
                    } else {
                        *from
                    };
                    lower(&mut impact.refold, account, refold);
                }
                // A split entering the range rescales every earlier price of
                // its asset, for every holder.
                for (asset, days) in &splits {
                    if days.range(new_days.clone()).next().is_some() {
                        for holder in holders_of(asset) {
                            lower(&mut impact.revalue, holder, BEGINNING);
                        }
                    }
                }
            }
            FactChange::Policy => {
                for account in facts.accounts.keys() {
                    lower(&mut impact.refold, account, BEGINNING);
                }
            }
        }
    }

    // A refold reaches the account's transfer partners: their lots and flows
    // come from its legs.
    loop {
        let mut changed = false;
        for pair in facts.transfer_pairs.iter() {
            for (from, to) in [
                (&pair.out_account, &pair.in_account),
                (&pair.in_account, &pair.out_account),
            ] {
                if let Some(day) = impact.refold.get(from).copied() {
                    changed |= lower(&mut impact.refold, to, day);
                }
            }
        }
        if !changed {
            break;
        }
    }
    // Holdings-mode accounts never fold: their facts are observed snapshots.
    let observed: Vec<AccountId> = impact
        .refold
        .keys()
        .filter(|id| {
            facts
                .accounts
                .get(*id)
                .is_some_and(|a| a.tracking == TrackingMode::Holdings)
        })
        .cloned()
        .collect();
    for id in observed {
        if let Some(day) = impact.refold.remove(&id) {
            lower(&mut impact.revalue, &id, day);
        }
    }
    // A transactions account with no activity in the range has no keyframe:
    // valuation presents the fold's (empty) final state as one row on
    // `as_of`, which moves with it. A revalue reads stored keyframes only and
    // a rewrite from a later day would leave that row behind, so whatever
    // reaches such an account refolds it whole (P-REVALUE).
    for (id, account) in &facts.accounts {
        if account.archived || account.tracking == TrackingMode::Holdings || folded.contains(id) {
            continue;
        }
        if impact.revalue.remove(id).is_some() || impact.refold.contains_key(id) {
            impact.refold.insert(id.clone(), BEGINNING);
        }
    }
    // A refold rewrites valuations too.
    let covered: Vec<(AccountId, NaiveDate)> = impact
        .revalue
        .iter()
        .filter(|(id, _)| impact.refold.contains_key(*id))
        .map(|(id, day)| (id.clone(), *day))
        .collect();
    for (id, day) in covered {
        impact.revalue.remove(&id);
        lower(&mut impact.refold, &id, day);
    }
    impact
}

/// Lowers `account`'s first stale day to `day`; whether it changed.
fn lower(days: &mut BTreeMap<AccountId, NaiveDate>, account: &AccountId, day: NaiveDate) -> bool {
    match days.get_mut(account) {
        Some(existing) if *existing <= day => false,
        Some(existing) => {
            *existing = day;
            true
        }
        None => {
            days.insert(account.clone(), day);
            true
        }
    }
}

/// Whether a close on `day` is, or was, one of the two closes around one of
/// the `splits` of `asset` that decide whether the provider already adjusted
/// it.
fn next_to_split(
    surfaces: &ResolvedSurfaces,
    asset: &AssetId,
    splits: &BTreeSet<NaiveDate>,
    day: NaiveDate,
) -> bool {
    let mut closes: BTreeSet<NaiveDate> =
        surfaces.quotes.positive_closes(asset).into_keys().collect();
    closes.insert(day);
    splits.iter().any(|split| {
        closes.range(..*split).next_back() == Some(&day)
            || closes.range(*split..).next() == Some(&day)
    })
}
