//! Pairs the two legs of a broker-reported reverse stock split (a departing
//! "FROM" leg and an arriving "TO" leg, tagged in `mapping.rs`) and derives
//! the real split ratio from their quantities. The broker's `description`
//! text never carries a number for reverse splits (unlike forward splits,
//! which do and are handled entirely in `mapping.rs` -- single-leg, no
//! pairing needed).
//!
//! This has to run after `prepare_activities_for_sync`, once both legs'
//! assets are resolved and their `quantity`/`amount` are final `Decimal`s.
//! It mirrors `link_imported_transfer_pairs`
//! (`crates/core/src/activities/activities_service.rs`) in spirit -- match
//! key, shared `source_group_id` -- but that function can't be reused
//! directly: it's wired to `ActivityImport`, a CSV-import-only type the
//! broker-sync path never constructs.

use std::collections::HashMap;

use chrono::{DateTime, NaiveDate};
use uuid::Uuid;
use wealthfolio_core::activities::{ActivityStatus, PrepareActivitiesResult};

use super::mapping::{
    CORPORATE_ACTION_LEG_FROM, CORPORATE_ACTION_LEG_TO, METADATA_CORPORATE_ACTION_LEG,
};

fn corporate_action_leg(metadata: Option<&str>) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(metadata?).ok()?;
    value
        .get(METADATA_CORPORATE_ACTION_LEG)
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

fn activity_local_date(activity_date: &str) -> Option<NaiveDate> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(activity_date) {
        return Some(dt.date_naive());
    }
    NaiveDate::parse_from_str(activity_date, "%Y-%m-%d").ok()
}

/// Finds reverse-split FROM/TO leg pairs tagged by `mapping.rs`, derives the
/// real ratio (`TO.quantity / FROM.quantity`), and fixes up the TO leg so it
/// stops being excluded from calculations. A group only resolves when
/// there's exactly one leg of each role for the same account/date -- an
/// ambiguous group (e.g. two unrelated corporate actions the same day) is
/// left as `mapping.rs` produced it rather than guessing a pairing, the
/// same principle `transfer_pairs.rs` uses for invalid transfer groups.
pub(crate) fn resolve_reverse_split_pairs(prepare_result: &mut PrepareActivitiesResult) {
    let mut groups: HashMap<(String, NaiveDate), (Vec<usize>, Vec<usize>)> = HashMap::new();

    for (idx, prepared) in prepare_result.prepared.iter().enumerate() {
        let Some(leg) = corporate_action_leg(prepared.activity.metadata.as_deref()) else {
            continue;
        };
        let Some(date) = activity_local_date(&prepared.activity.activity_date) else {
            continue;
        };
        let entry = groups
            .entry((prepared.activity.account_id.clone(), date))
            .or_default();
        if leg == CORPORATE_ACTION_LEG_FROM {
            entry.0.push(idx);
        } else if leg == CORPORATE_ACTION_LEG_TO {
            entry.1.push(idx);
        }
    }

    for (from_indices, to_indices) in groups.into_values() {
        if from_indices.len() != 1 || to_indices.len() != 1 {
            // Zero or more-than-one candidate on either side -- ambiguous,
            // leave unresolved rather than guessing a pairing.
            continue;
        }
        let from_idx = from_indices[0];
        let to_idx = to_indices[0];

        let Some(from_quantity) = prepare_result.prepared[from_idx].activity.quantity else {
            continue;
        };
        let Some(to_quantity) = prepare_result.prepared[to_idx].activity.quantity else {
            continue;
        };
        if from_quantity.is_zero() {
            continue;
        }
        let ratio = to_quantity / from_quantity;
        if !ratio.is_sign_positive() || ratio.is_zero() {
            continue;
        }

        let group_id = Uuid::new_v4().to_string();
        prepare_result.prepared[from_idx].activity.source_group_id = Some(group_id.clone());

        let to_activity = &mut prepare_result.prepared[to_idx].activity;
        to_activity.amount = Some(ratio);
        to_activity.source_group_id = Some(group_id);
        // prepare_activities_for_sync already ran split-ratio validation
        // against this leg's still-invalid broker-raw amount and forced it
        // to Draft (excluded from calculations) -- now that the real ratio
        // is known, restore the normal Posted status every other activity
        // gets, or the corrected ratio would never take effect.
        if to_activity.status == Some(ActivityStatus::Draft) {
            to_activity.status = Some(ActivityStatus::Posted);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal::Decimal;
    use wealthfolio_core::activities::{NewActivity, PreparedActivity};

    fn leg_metadata(leg: &str) -> Option<String> {
        Some(serde_json::json!({ METADATA_CORPORATE_ACTION_LEG: leg }).to_string())
    }

    fn prepared_leg(
        account_id: &str,
        activity_date: &str,
        quantity: &str,
        amount: &str,
        status: ActivityStatus,
        leg: &str,
    ) -> PreparedActivity {
        PreparedActivity {
            activity: NewActivity {
                id: Some(format!("act-{leg}")),
                account_id: account_id.to_string(),
                asset: None,
                activity_type: "SPLIT".to_string(),
                subtype: None,
                activity_date: activity_date.to_string(),
                quantity: Some(Decimal::from_str_exact(quantity).unwrap()),
                unit_price: None,
                currency: "USD".to_string(),
                fee: None,
                tax: None,
                amount: Some(Decimal::from_str_exact(amount).unwrap()),
                status: Some(status),
                notes: None,
                fx_rate: None,
                metadata: leg_metadata(leg),
                needs_review: Some(true),
                source_system: None,
                source_record_id: None,
                source_group_id: None,
                idempotency_key: None,
                import_run_id: None,
            },
            resolved_asset_id: Some(format!("asset-{leg}")),
            fx_pair: None,
        }
    }

    #[test]
    fn resolves_matched_pair_and_computes_real_ratio() {
        // Honeywell's real reverse split: 10 departing shares -> 5 arriving
        // shares, ratio 0.5.
        let from = prepared_leg(
            "acct-1",
            "2026-06-29T00:00:00+00:00",
            "10",
            "1", // no-op amount mapping.rs already assigned
            ActivityStatus::Posted,
            CORPORATE_ACTION_LEG_FROM,
        );
        let to = prepared_leg(
            "acct-1",
            "2026-06-29T00:00:00+00:00",
            "5",
            "0", // still broker-raw/invalid until this pass runs
            ActivityStatus::Draft,
            CORPORATE_ACTION_LEG_TO,
        );
        let mut result = PrepareActivitiesResult {
            prepared: vec![from, to],
            ..Default::default()
        };

        resolve_reverse_split_pairs(&mut result);

        let to_activity = &result.prepared[1].activity;
        assert_eq!(
            to_activity.amount,
            Some(Decimal::from_str_exact("0.5").unwrap())
        );
        assert_eq!(to_activity.status, Some(ActivityStatus::Posted));

        let from_activity = &result.prepared[0].activity;
        assert!(from_activity.source_group_id.is_some());
        assert_eq!(
            from_activity.source_group_id, to_activity.source_group_id,
            "both legs of a resolved pair must share the same source_group_id"
        );
    }

    #[test]
    fn leaves_unmatched_lone_leg_unresolved() {
        let to = prepared_leg(
            "acct-1",
            "2026-06-29T00:00:00+00:00",
            "5",
            "0",
            ActivityStatus::Draft,
            CORPORATE_ACTION_LEG_TO,
        );
        let mut result = PrepareActivitiesResult {
            prepared: vec![to],
            ..Default::default()
        };

        resolve_reverse_split_pairs(&mut result);

        let to_activity = &result.prepared[0].activity;
        assert_eq!(to_activity.amount, Some(Decimal::ZERO));
        assert_eq!(to_activity.status, Some(ActivityStatus::Draft));
        assert!(to_activity.source_group_id.is_none());
    }

    #[test]
    fn leaves_ambiguous_group_unresolved() {
        // Two unrelated reverse splits landing in the same account on the
        // same day would produce two FROM legs and one TO leg -- must not
        // guess which FROM pairs with the TO.
        let from_a = prepared_leg(
            "acct-1",
            "2026-06-29T00:00:00+00:00",
            "10",
            "1",
            ActivityStatus::Posted,
            CORPORATE_ACTION_LEG_FROM,
        );
        let from_b = prepared_leg(
            "acct-1",
            "2026-06-29T00:00:00+00:00",
            "20",
            "1",
            ActivityStatus::Posted,
            CORPORATE_ACTION_LEG_FROM,
        );
        let to = prepared_leg(
            "acct-1",
            "2026-06-29T00:00:00+00:00",
            "5",
            "0",
            ActivityStatus::Draft,
            CORPORATE_ACTION_LEG_TO,
        );
        let mut result = PrepareActivitiesResult {
            prepared: vec![from_a, from_b, to],
            ..Default::default()
        };

        resolve_reverse_split_pairs(&mut result);

        let to_activity = &result.prepared[2].activity;
        assert_eq!(to_activity.amount, Some(Decimal::ZERO));
        assert_eq!(to_activity.status, Some(ActivityStatus::Draft));
        assert!(to_activity.source_group_id.is_none());
    }

    #[test]
    fn does_not_pair_legs_from_different_accounts() {
        let from = prepared_leg(
            "acct-1",
            "2026-06-29T00:00:00+00:00",
            "10",
            "1",
            ActivityStatus::Posted,
            CORPORATE_ACTION_LEG_FROM,
        );
        let to = prepared_leg(
            "acct-2",
            "2026-06-29T00:00:00+00:00",
            "5",
            "0",
            ActivityStatus::Draft,
            CORPORATE_ACTION_LEG_TO,
        );
        let mut result = PrepareActivitiesResult {
            prepared: vec![from, to],
            ..Default::default()
        };

        resolve_reverse_split_pairs(&mut result);

        let to_activity = &result.prepared[1].activity;
        assert_eq!(to_activity.amount, Some(Decimal::ZERO));
        assert_eq!(to_activity.status, Some(ActivityStatus::Draft));
    }
}
