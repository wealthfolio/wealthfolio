//! Category exclusion filtering for spending aggregates.
//!
//! `spending.excluded_category_ids` holds raw category ids from settings; an
//! activity's spend is excluded when its allocation lands on one of those ids
//! or any of their descendants. Every aggregation surface (insight, monthly
//! report, budget, event summaries) must derive included/excluded portions
//! from `split_spending_allocations` so headline totals, per-category
//! breakdowns, and daily series stay mutually reconciled.

use std::collections::{HashMap, HashSet};

use rust_decimal::Decimal;
use wealthfolio_core::taxonomies::Category;

use crate::activity_allocations::{
    allocations_for_taxonomy, ActivityAllocation, AssignmentsByActivity, SplitsByActivity,
};

#[derive(Debug, Default)]
pub(crate) struct ExclusionIndex {
    excluded: HashSet<String>,
}

impl ExclusionIndex {
    pub(crate) fn empty() -> Self {
        Self::default()
    }

    pub(crate) fn new(raw: &[String], meta: &HashMap<String, Category>) -> Self {
        let parents: HashMap<&str, Option<&str>> = meta
            .values()
            .map(|c| (c.id.as_str(), c.parent_id.as_deref()))
            .collect();
        Self::from_parent_map(raw, &parents)
    }

    pub(crate) fn from_parent_pairs<'a>(
        raw: &[String],
        pairs: impl Iterator<Item = (&'a str, Option<&'a str>)>,
    ) -> Self {
        let parents: HashMap<&str, Option<&str>> = pairs.collect();
        Self::from_parent_map(raw, &parents)
    }

    fn from_parent_map(raw: &[String], parents: &HashMap<&str, Option<&str>>) -> Self {
        // Raw ids are kept even when the category no longer exists so stale
        // assignments to a deleted-but-excluded category still filter out.
        let mut excluded: HashSet<String> = raw.iter().cloned().collect();
        if excluded.is_empty() {
            return Self { excluded };
        }
        let roots: HashSet<&str> = raw.iter().map(String::as_str).collect();

        // Guard against a corrupted taxonomy with a cyclic parent_id chain,
        // matching budget::service::top_category_id: bound the walk so a
        // parent_id loop can't hang the request thread.
        const MAX_DEPTH: usize = 32;
        for &id in parents.keys() {
            if roots.contains(id) {
                continue;
            }
            let mut seen: HashSet<&str> = HashSet::new();
            seen.insert(id);
            let mut current = id;
            for _ in 0..MAX_DEPTH {
                match parents.get(current).copied().flatten() {
                    Some(parent) if !seen.contains(parent) => {
                        if roots.contains(parent) {
                            excluded.insert(id.to_string());
                            break;
                        }
                        seen.insert(parent);
                        current = parent;
                    }
                    _ => break,
                }
            }
        }
        Self { excluded }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.excluded.is_empty()
    }

    pub(crate) fn is_excluded(&self, category_id: &str) -> bool {
        self.excluded.contains(category_id)
    }
}

/// Splits an activity's spending-bucket allocations into included lines and
/// the excluded native-currency total. Same precedence as
/// `allocations_for_taxonomy` (split lines win over assignments, else the
/// earliest assignment takes the full bucket). Signed amounts pass through
/// unchanged, so refund lines stay negative.
///
/// An activity with no allocations at all (uncategorized) returns
/// `(vec![], ZERO)` — uncategorized spend is never excluded.
pub(crate) fn split_spending_allocations(
    activity_id: &str,
    taxonomy_id: &str,
    bucket_amount: Decimal,
    assignments_by_activity: &AssignmentsByActivity,
    splits_by_activity: &SplitsByActivity,
    exclusions: &ExclusionIndex,
) -> (Vec<ActivityAllocation>, Decimal) {
    let allocations = allocations_for_taxonomy(
        activity_id,
        taxonomy_id,
        bucket_amount,
        assignments_by_activity,
        splits_by_activity,
    );
    if exclusions.is_empty() {
        return (allocations, Decimal::ZERO);
    }
    let mut excluded_native = Decimal::ZERO;
    let included = allocations
        .into_iter()
        .filter(|allocation| {
            if exclusions.is_excluded(&allocation.category_id) {
                excluded_native += allocation.amount;
                false
            } else {
                true
            }
        })
        .collect();
    (included, excluded_native)
}

/// Convenience wrapper for surfaces that only need the excluded portion of an
/// activity's spending bucket (daily/monthly series, pace): returns the
/// native-currency total allocated to excluded categories.
pub(crate) fn excluded_spending_native(
    activity_id: &str,
    taxonomy_id: &str,
    bucket_amount: Decimal,
    assignments_by_activity: &AssignmentsByActivity,
    splits_by_activity: &SplitsByActivity,
    exclusions: &ExclusionIndex,
) -> Decimal {
    if exclusions.is_empty() || bucket_amount == Decimal::ZERO {
        return Decimal::ZERO;
    }
    split_spending_allocations(
        activity_id,
        taxonomy_id,
        bucket_amount,
        assignments_by_activity,
        splits_by_activity,
        exclusions,
    )
    .1
}

#[cfg(test)]
mod tests {
    use chrono::{NaiveDate, NaiveDateTime};
    use rust_decimal::Decimal;

    use crate::activity_allocations::{group_assignments, group_splits};
    use crate::activity_assignments::ActivityTaxonomyAssignment;
    use crate::activity_splits::ActivitySplit;

    use super::*;

    fn dt() -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 1, 1)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap()
    }

    fn assignment(category_id: &str) -> ActivityTaxonomyAssignment {
        ActivityTaxonomyAssignment {
            id: format!("asg-{category_id}"),
            activity_id: "activity-1".to_string(),
            taxonomy_id: "spending_categories".to_string(),
            category_id: category_id.to_string(),
            weight: 10_000,
            source: "manual".to_string(),
            created_at: dt(),
            updated_at: dt(),
        }
    }

    fn split(category_id: &str, amount: Decimal) -> ActivitySplit {
        ActivitySplit {
            id: format!("split-{category_id}"),
            activity_id: "activity-1".to_string(),
            taxonomy_id: "spending_categories".to_string(),
            category_id: category_id.to_string(),
            amount,
            note: None,
            sort_order: 0,
            created_at: dt(),
            updated_at: dt(),
        }
    }

    fn index(raw: &[&str], pairs: &[(&'static str, Option<&'static str>)]) -> ExclusionIndex {
        let raw: Vec<String> = raw.iter().map(|s| s.to_string()).collect();
        ExclusionIndex::from_parent_pairs(&raw, pairs.iter().copied())
    }

    #[test]
    fn index_resolves_descendants_two_levels_down() {
        let idx = index(
            &["travel"],
            &[
                ("travel", None),
                ("flights", Some("travel")),
                ("baggage", Some("flights")),
                ("groceries", None),
            ],
        );
        assert!(idx.is_excluded("travel"));
        assert!(idx.is_excluded("flights"));
        assert!(idx.is_excluded("baggage"));
        assert!(!idx.is_excluded("groceries"));
    }

    #[test]
    fn index_keeps_raw_ids_missing_from_taxonomy() {
        let idx = index(&["deleted-cat"], &[("groceries", None)]);
        assert!(idx.is_excluded("deleted-cat"));
        assert!(!idx.is_excluded("groceries"));
    }

    #[test]
    fn index_terminates_on_cyclic_parent_chain() {
        let idx = index(
            &["travel"],
            &[("a", Some("b")), ("b", Some("a")), ("travel", None)],
        );
        assert!(!idx.is_excluded("a"));
        assert!(!idx.is_excluded("b"));
        assert!(idx.is_excluded("travel"));
    }

    #[test]
    fn single_excluded_assignment_removes_full_bucket() {
        let assignments = group_assignments(vec![assignment("travel")]);
        let splits = SplitsByActivity::new();
        let idx = index(&["travel"], &[("travel", None)]);

        let (included, excluded_native) = split_spending_allocations(
            "activity-1",
            "spending_categories",
            Decimal::new(12000, 2),
            &assignments,
            &splits,
            &idx,
        );

        assert!(included.is_empty());
        assert_eq!(excluded_native, Decimal::new(12000, 2));
    }

    #[test]
    fn split_removes_only_excluded_lines() {
        let assignments = group_assignments(vec![assignment("groceries")]);
        let splits = group_splits(vec![
            split("groceries", Decimal::new(8000, 2)),
            split("travel", Decimal::new(4000, 2)),
        ]);
        let idx = index(&["travel"], &[("travel", None), ("groceries", None)]);

        let (included, excluded_native) = split_spending_allocations(
            "activity-1",
            "spending_categories",
            Decimal::new(12000, 2),
            &assignments,
            &splits,
            &idx,
        );

        assert_eq!(included.len(), 1);
        assert_eq!(included[0].category_id, "groceries");
        assert_eq!(included[0].amount, Decimal::new(8000, 2));
        assert_eq!(excluded_native, Decimal::new(4000, 2));
    }

    #[test]
    fn refund_split_keeps_negative_excluded_total() {
        let assignments = AssignmentsByActivity::new();
        let splits = group_splits(vec![split("travel", Decimal::new(4000, 2))]);
        let idx = index(&["travel"], &[("travel", None)]);

        let (included, excluded_native) = split_spending_allocations(
            "activity-1",
            "spending_categories",
            Decimal::new(-4000, 2),
            &assignments,
            &splits,
            &idx,
        );

        assert!(included.is_empty());
        assert_eq!(excluded_native, Decimal::new(-4000, 2));
    }

    #[test]
    fn uncategorized_activity_is_never_excluded() {
        let assignments = AssignmentsByActivity::new();
        let splits = SplitsByActivity::new();
        let idx = index(&["travel"], &[("travel", None)]);

        let (included, excluded_native) = split_spending_allocations(
            "activity-1",
            "spending_categories",
            Decimal::new(5000, 2),
            &assignments,
            &splits,
            &idx,
        );

        assert!(included.is_empty());
        assert_eq!(excluded_native, Decimal::ZERO);
    }

    #[test]
    fn subcategory_assignment_excluded_via_parent() {
        let assignments = group_assignments(vec![assignment("flights")]);
        let splits = SplitsByActivity::new();
        let idx = index(
            &["travel"],
            &[("travel", None), ("flights", Some("travel"))],
        );

        let (included, excluded_native) = split_spending_allocations(
            "activity-1",
            "spending_categories",
            Decimal::new(9000, 2),
            &assignments,
            &splits,
            &idx,
        );

        assert!(included.is_empty());
        assert_eq!(excluded_native, Decimal::new(9000, 2));
    }
}
