use anyhow::Result;
use async_trait::async_trait;

use super::model::{ActivityTaxonomyAssignment, NewActivityTaxonomyAssignment};

#[async_trait]
pub trait ActivityTaxonomyAssignmentRepositoryTrait: Send + Sync {
    /// All assignments for one activity.
    async fn list_for_activity(&self, activity_id: &str)
        -> Result<Vec<ActivityTaxonomyAssignment>>;

    /// All assignments for a batch of activities. Returns rows in arbitrary order;
    /// caller is responsible for grouping by `activity_id`. Used to avoid N+1 fetches
    /// from the cash-activity search endpoint.
    async fn list_for_activities(
        &self,
        activity_ids: &[String],
    ) -> Result<Vec<ActivityTaxonomyAssignment>>;

    /// Create or replace (for single-select taxonomies) the assignment.
    async fn upsert(
        &self,
        new_assignment: NewActivityTaxonomyAssignment,
    ) -> Result<ActivityTaxonomyAssignment>;

    /// Bulk variant of `assign_single` semantics: for each item, clear existing
    /// assignments tying its `activity_id` to its `taxonomy_id`, then insert the
    /// new one. All work happens inside a single DB transaction — atomic across
    /// the batch. Powers bulk-categorize on the transactions page and the AI
    /// "Apply N selected" widget action.
    async fn assign_many_single_select(
        &self,
        items: Vec<NewActivityTaxonomyAssignment>,
    ) -> Result<Vec<ActivityTaxonomyAssignment>>;

    /// Same single-select assignment semantics as `assign_many_single_select`,
    /// but also clears split lines for the affected activities in the same
    /// repository transaction.
    async fn assign_many_single_select_clearing_splits(
        &self,
        items: Vec<NewActivityTaxonomyAssignment>,
    ) -> Result<Vec<ActivityTaxonomyAssignment>>;

    /// Rule-rerun variant of `assign_many_single_select`.
    /// Re-checks current rows inside the write transaction so manual assignments
    /// are never overwritten by a stale precomputed rerun batch.
    async fn assign_rule_many_single_select(
        &self,
        items: Vec<NewActivityTaxonomyAssignment>,
        only_uncategorized: bool,
    ) -> Result<Vec<ActivityTaxonomyAssignment>>;

    /// Remove a single assignment by id.
    async fn delete(&self, id: &str) -> Result<()>;

    /// Remove all assignments tying `activity_id` to `taxonomy_id`.
    /// Used to clear a single-select taxonomy.
    async fn clear_for_taxonomy(&self, activity_id: &str, taxonomy_id: &str) -> Result<()>;
}
