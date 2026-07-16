use anyhow::Result;
use async_trait::async_trait;

use super::model::{ActivitySplit, NewActivitySplit};

#[async_trait]
pub trait ActivitySplitRepositoryTrait: Send + Sync {
    async fn list_for_activity(&self, activity_id: &str) -> Result<Vec<ActivitySplit>>;

    async fn list_for_activities(&self, activity_ids: &[String]) -> Result<Vec<ActivitySplit>>;

    async fn categories_belong_to_taxonomy(
        &self,
        taxonomy_id: &str,
        category_ids: &[String],
    ) -> Result<bool>;

    async fn replace_for_activity(
        &self,
        activity_id: &str,
        splits: Vec<NewActivitySplit>,
    ) -> Result<Vec<ActivitySplit>>;

    async fn replace_for_activity_clearing_assignment(
        &self,
        activity_id: &str,
        taxonomy_id: &str,
        splits: Vec<NewActivitySplit>,
    ) -> Result<Vec<ActivitySplit>>;

    async fn clear_for_activity(&self, activity_id: &str) -> Result<()>;
}
