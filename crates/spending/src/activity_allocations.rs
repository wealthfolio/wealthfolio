use std::collections::HashMap;

use rust_decimal::Decimal;

use crate::activity_assignments::ActivityTaxonomyAssignment;
use crate::activity_splits::ActivitySplit;

pub(crate) type AssignmentsByActivity = HashMap<String, Vec<ActivityTaxonomyAssignment>>;
pub(crate) type SplitsByActivity = HashMap<String, Vec<ActivitySplit>>;

#[derive(Debug, Clone)]
pub(crate) struct ActivityAllocation {
    pub category_id: String,
    pub amount: Decimal,
}

pub(crate) fn group_assignments(
    assignments: Vec<ActivityTaxonomyAssignment>,
) -> AssignmentsByActivity {
    let mut out = HashMap::new();
    for assignment in assignments {
        out.entry(assignment.activity_id.clone())
            .or_insert_with(Vec::new)
            .push(assignment);
    }
    out
}

pub(crate) fn group_splits(splits: Vec<ActivitySplit>) -> SplitsByActivity {
    let mut out = HashMap::new();
    for split in splits {
        out.entry(split.activity_id.clone())
            .or_insert_with(Vec::new)
            .push(split);
    }
    out
}

pub(crate) fn allocations_for_taxonomy(
    activity_id: &str,
    taxonomy_id: &str,
    bucket_amount: Decimal,
    assignments_by_activity: &AssignmentsByActivity,
    splits_by_activity: &SplitsByActivity,
) -> Vec<ActivityAllocation> {
    if bucket_amount == Decimal::ZERO {
        return Vec::new();
    }

    let split_allocations = splits_by_activity
        .get(activity_id)
        .into_iter()
        .flatten()
        .filter(|split| split.taxonomy_id == taxonomy_id)
        .map(|split| ActivityAllocation {
            category_id: split.category_id.clone(),
            amount: apply_bucket_sign(split.amount, bucket_amount),
        })
        .collect::<Vec<_>>();
    if !split_allocations.is_empty() {
        return split_allocations;
    }

    let mut assignments = assignments_by_activity
        .get(activity_id)
        .into_iter()
        .flatten()
        .filter(|assignment| assignment.taxonomy_id == taxonomy_id)
        .collect::<Vec<_>>();
    assignments.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });

    assignments
        .first()
        .map(|assignment| {
            vec![ActivityAllocation {
                category_id: assignment.category_id.clone(),
                amount: bucket_amount,
            }]
        })
        .unwrap_or_default()
}

fn apply_bucket_sign(amount: Decimal, bucket_amount: Decimal) -> Decimal {
    if bucket_amount < Decimal::ZERO {
        -amount
    } else {
        amount
    }
}

#[cfg(test)]
mod tests {
    use chrono::{NaiveDate, NaiveDateTime};
    use rust_decimal::Decimal;

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

    #[test]
    fn allocation_uses_single_assignment_when_no_splits_exist() {
        let assignments = group_assignments(vec![assignment("groceries")]);
        let splits = SplitsByActivity::new();

        let allocations = allocations_for_taxonomy(
            "activity-1",
            "spending_categories",
            Decimal::new(12000, 2),
            &assignments,
            &splits,
        );

        assert_eq!(allocations.len(), 1);
        assert_eq!(allocations[0].category_id, "groceries");
        assert_eq!(allocations[0].amount, Decimal::new(12000, 2));
    }

    #[test]
    fn allocation_prefers_split_lines_over_single_assignment() {
        let assignments = group_assignments(vec![assignment("groceries")]);
        let splits = group_splits(vec![
            split("groceries", Decimal::new(8000, 2)),
            split("household", Decimal::new(2500, 2)),
            split("gift", Decimal::new(1500, 2)),
        ]);

        let allocations = allocations_for_taxonomy(
            "activity-1",
            "spending_categories",
            Decimal::new(12000, 2),
            &assignments,
            &splits,
        );

        let amounts: Vec<_> = allocations
            .iter()
            .map(|allocation| (allocation.category_id.as_str(), allocation.amount))
            .collect();
        assert_eq!(
            amounts,
            vec![
                ("groceries", Decimal::new(8000, 2)),
                ("household", Decimal::new(2500, 2)),
                ("gift", Decimal::new(1500, 2)),
            ]
        );
    }

    #[test]
    fn allocation_applies_negative_budget_sign_for_reimbursements() {
        let assignments = AssignmentsByActivity::new();
        let splits = group_splits(vec![split("groceries", Decimal::new(4000, 2))]);

        let allocations = allocations_for_taxonomy(
            "activity-1",
            "spending_categories",
            Decimal::new(-4000, 2),
            &assignments,
            &splits,
        );

        assert_eq!(allocations.len(), 1);
        assert_eq!(allocations[0].category_id, "groceries");
        assert_eq!(allocations[0].amount, Decimal::new(-4000, 2));
    }
}
