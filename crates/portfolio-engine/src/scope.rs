//! `facts_needed`: what a coordinator must load for a scope and range
//! (architecture §4.3 / §4.8). Pure over already-loaded account, asset and activity
//! facts; quote and FX observations are what it asks for.

use std::collections::BTreeSet;

use crate::model::*;

/// The facts a kernel run over `scope` × `range` reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FactsRequest {
    /// The scope plus every transfer counterparty of a scoped activity
    /// (paired legs fold together and share the lot cache).
    pub accounts: BTreeSet<AccountId>,
    /// Assets referenced by those accounts' activities and observed
    /// snapshots.
    pub assets: BTreeSet<AssetId>,
    /// Currency pairs conversions may need (major codes, unordered pairs
    /// stored as `(from, to)` in both directions are not needed: the surface
    /// registers inverses).
    pub currency_pairs: BTreeSet<(String, String)>,
    /// Observation window. Loaders must add the latest observation on or
    /// before `range.start` per asset/pair (carry-forward seed) and, for FX,
    /// the nearest observation after `range.end` (nearest-neighbour
    /// resolution looks both ways).
    pub range: DateRange,
}

pub fn facts_needed(facts: &CanonicalFacts, scope: &[AccountId], range: DateRange) -> FactsRequest {
    let policy = &facts.policy;
    let base = policy
        .major_currency(policy.base_currency.as_str())
        .to_string();

    // Transfer closure, transitively: every account sharing a pair with an
    // account already in the closure, until no new account appears. A fold
    // must cover the whole chain (A -> B -> C) or B's second pair has one leg.
    let mut accounts: BTreeSet<AccountId> = scope.iter().cloned().collect();
    loop {
        let before = accounts.len();
        for activity in &facts.activities {
            if !accounts.contains(&activity.account) {
                continue;
            }
            if let Some(pair) = facts.transfer_pairs.pair_for(&activity.id) {
                accounts.insert(pair.out_account.clone());
                accounts.insert(pair.in_account.clone());
            }
        }
        if accounts.len() == before {
            break;
        }
    }

    let mut assets = BTreeSet::new();
    let mut currency_pairs = BTreeSet::new();
    let mut pair = |from: &str, to: &str| {
        let from = policy.major_currency(from).to_string();
        let to = policy.major_currency(to).to_string();
        if from != to {
            currency_pairs.insert((from, to));
        }
    };
    for account in accounts.iter().filter_map(|id| facts.accounts.get(id)) {
        pair(account.currency.as_str(), &base);
    }
    for activity in facts
        .activities
        .iter()
        .filter(|a| accounts.contains(&a.account))
    {
        if let Some(account) = facts.accounts.get(&activity.account) {
            pair(activity.currency.as_str(), account.currency.as_str());
        }
        pair(activity.currency.as_str(), &base);
        if let Some(asset) = &activity.asset {
            assets.insert(asset.clone());
        }
    }
    for snapshot in facts
        .observed_snapshots
        .iter()
        .filter(|s| accounts.contains(&s.account))
    {
        assets.extend(snapshot.positions.keys().cloned());
        if let Some(account) = facts.accounts.get(&snapshot.account) {
            for currency in snapshot.cash.keys() {
                pair(currency.as_str(), account.currency.as_str());
            }
        }
    }
    for asset in assets.iter().filter_map(|id| facts.assets.get(id)) {
        let Some(quote_currency) = &asset.quote_currency else {
            continue;
        };
        for account in accounts.iter().filter_map(|id| facts.accounts.get(id)) {
            pair(quote_currency.as_str(), account.currency.as_str());
        }
        pair(quote_currency.as_str(), &base);
    }

    FactsRequest {
        accounts,
        assets,
        currency_pairs,
        range,
    }
}

#[cfg(test)]
mod tests {
    use chrono::{NaiveDate, TimeZone, Utc};
    use rust_decimal_macros::dec;

    use super::*;
    use crate::model::{Policy, RawAccount, RawActivity, RawFacts};
    use crate::normalize::normalize;

    fn account(id: &str) -> RawAccount {
        RawAccount {
            id: id.into(),
            currency: "USD".into(),
            account_type: "SECURITIES".into(),
            tracking_mode: "TRANSACTIONS".into(),
            is_archived: false,
        }
    }

    fn transfer(id: &str, account: &str, kind: &str, group: &str, day: u32) -> RawActivity {
        let at = Utc.with_ymd_and_hms(2025, 1, day, 12, 0, 0).unwrap();
        RawActivity {
            id: id.into(),
            account_id: account.into(),
            asset_id: None,
            activity_type: kind.into(),
            activity_type_override: None,
            subtype: None,
            status: "POSTED".into(),
            timestamp: at,
            created_at: at,
            quantity: None,
            unit_price: None,
            amount: Some(dec!(100)),
            fee: None,
            tax: None,
            currency: "USD".into(),
            fx_rate: None,
            source_group_id: Some(group.into()),
            external_transfer: None,
            source_system: None,
            is_user_modified: false,
            updated_at: at,
        }
    }

    #[test]
    fn the_transfer_closure_is_transitive() {
        // A -> B (g1) then B -> C (g2): a fold scoped to A must load C too.
        let raw = RawFacts {
            policy: Policy::new(
                Currency::parse("USD").unwrap(),
                chrono_tz::UTC,
                NaiveDate::from_ymd_opt(2025, 1, 31).unwrap(),
            ),
            accounts: vec![account("a"), account("b"), account("c"), account("d")],
            assets: vec![],
            activities: vec![
                transfer("out-1", "a", "TRANSFER_OUT", "g1", 2),
                transfer("in-1", "b", "TRANSFER_IN", "g1", 2),
                transfer("out-2", "b", "TRANSFER_OUT", "g2", 5),
                transfer("in-2", "c", "TRANSFER_IN", "g2", 5),
            ],
            quotes: vec![],
            fx_rates: vec![],
            observed_snapshots: vec![],
        };
        let facts = normalize(raw).unwrap().facts;
        let request = facts_needed(
            &facts,
            &[AccountId::new("a")],
            DateRange {
                start: NaiveDate::from_ymd_opt(2025, 1, 1).unwrap(),
                end: NaiveDate::from_ymd_opt(2025, 1, 31).unwrap(),
            },
        );
        let closure: Vec<&str> = request.accounts.iter().map(|a| a.as_str()).collect();
        assert_eq!(
            closure,
            vec!["a", "b", "c"],
            "d shares no pair and stays out"
        );
    }
}
