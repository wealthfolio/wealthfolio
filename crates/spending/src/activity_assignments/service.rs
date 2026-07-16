use std::sync::Arc;

use anyhow::Result;

use super::model::{ActivityTaxonomyAssignment, NewActivityTaxonomyAssignment};
use super::traits::ActivityTaxonomyAssignmentRepositoryTrait;

pub struct ActivityTaxonomyAssignmentService {
    repo: Arc<dyn ActivityTaxonomyAssignmentRepositoryTrait>,
}

impl ActivityTaxonomyAssignmentService {
    pub fn new(repo: Arc<dyn ActivityTaxonomyAssignmentRepositoryTrait>) -> Self {
        Self { repo }
    }

    pub async fn list_for_activity(
        &self,
        activity_id: &str,
    ) -> Result<Vec<ActivityTaxonomyAssignment>> {
        self.repo.list_for_activity(activity_id).await
    }

    pub async fn list_for_activities(
        &self,
        activity_ids: &[String],
    ) -> Result<Vec<ActivityTaxonomyAssignment>> {
        self.repo.list_for_activities(activity_ids).await
    }

    /// Set the (single) category for `activity_id` in `taxonomy_id`.
    /// Clears any prior assignments tying that activity to that taxonomy.
    pub async fn assign_single(
        &self,
        activity_id: &str,
        taxonomy_id: &str,
        category_id: &str,
    ) -> Result<ActivityTaxonomyAssignment> {
        let mut assigned = self
            .assign_many_single_select(&[BulkCategoryAssignment {
                activity_id: activity_id.to_string(),
                taxonomy_id: taxonomy_id.to_string(),
                category_id: category_id.to_string(),
            }])
            .await?;
        assigned
            .pop()
            .ok_or_else(|| anyhow::anyhow!("assignment write returned no row"))
    }

    pub async fn assign_single_clearing_splits(
        &self,
        activity_id: &str,
        taxonomy_id: &str,
        category_id: &str,
    ) -> Result<ActivityTaxonomyAssignment> {
        let mut assigned = self
            .assign_many_single_select_clearing_splits(&[BulkCategoryAssignment {
                activity_id: activity_id.to_string(),
                taxonomy_id: taxonomy_id.to_string(),
                category_id: category_id.to_string(),
            }])
            .await?;
        assigned
            .pop()
            .ok_or_else(|| anyhow::anyhow!("assignment write returned no row"))
    }

    pub async fn unassign(&self, activity_id: &str, taxonomy_id: &str) -> Result<()> {
        self.repo.clear_for_taxonomy(activity_id, taxonomy_id).await
    }

    /// Direct upsert (used by Activity Rules to apply rule-sourced assignments).
    pub async fn upsert(
        &self,
        new_assignment: NewActivityTaxonomyAssignment,
    ) -> Result<ActivityTaxonomyAssignment> {
        self.repo.upsert(new_assignment).await
    }

    /// Bulk single-select assignment. Each item replaces any existing assignment
    /// for its (`activity_id`, `taxonomy_id`) pair. Atomic across the batch.
    /// Source is hardcoded to `"manual"` — caller intent for v1 is "user explicitly
    /// confirmed these" (whether via bulk-select on the transactions page or via
    /// the AI proposal widget).
    pub async fn assign_many_single_select(
        &self,
        items: &[BulkCategoryAssignment],
    ) -> Result<Vec<ActivityTaxonomyAssignment>> {
        if items.is_empty() {
            return Ok(Vec::new());
        }
        let news: Vec<NewActivityTaxonomyAssignment> = items
            .iter()
            .map(|item| NewActivityTaxonomyAssignment {
                id: None,
                activity_id: item.activity_id.clone(),
                taxonomy_id: item.taxonomy_id.clone(),
                category_id: item.category_id.clone(),
                weight: 10_000,
                source: "manual".to_string(),
            })
            .collect();
        self.repo.assign_many_single_select(news).await
    }

    pub async fn assign_many_single_select_clearing_splits(
        &self,
        items: &[BulkCategoryAssignment],
    ) -> Result<Vec<ActivityTaxonomyAssignment>> {
        if items.is_empty() {
            return Ok(Vec::new());
        }
        let news: Vec<NewActivityTaxonomyAssignment> = items
            .iter()
            .map(|item| NewActivityTaxonomyAssignment {
                id: None,
                activity_id: item.activity_id.clone(),
                taxonomy_id: item.taxonomy_id.clone(),
                category_id: item.category_id.clone(),
                weight: 10_000,
                source: "manual".to_string(),
            })
            .collect();
        self.repo
            .assign_many_single_select_clearing_splits(news)
            .await
    }

    /// Bulk single-select with full control over `source` / `weight`. Used by
    /// the categorization rules "re-run" path so it can preserve
    /// `source = "rule"` while still benefiting from the single-transaction
    /// delete-then-insert semantics of `assign_many_single_select`.
    pub async fn bulk_apply(
        &self,
        items: Vec<NewActivityTaxonomyAssignment>,
    ) -> Result<Vec<ActivityTaxonomyAssignment>> {
        if items.is_empty() {
            return Ok(Vec::new());
        }
        self.repo.assign_many_single_select(items).await
    }

    pub async fn bulk_apply_rule_assignments(
        &self,
        items: Vec<NewActivityTaxonomyAssignment>,
        only_uncategorized: bool,
    ) -> Result<Vec<ActivityTaxonomyAssignment>> {
        if items.is_empty() {
            return Ok(Vec::new());
        }
        self.repo
            .assign_rule_many_single_select(items, only_uncategorized)
            .await
    }
}

/// Lightweight input for the bulk-assign service method. Doesn't carry weight
/// or source — those default to `10_000` and `"manual"`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkCategoryAssignment {
    pub activity_id: String,
    pub taxonomy_id: String,
    pub category_id: String,
}
