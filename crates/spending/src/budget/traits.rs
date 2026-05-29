use anyhow::Result;
use async_trait::async_trait;

use super::model::{
    BudgetGroup, BudgetGroupAssignment, BudgetRolloverSetting, BudgetTarget, NewBudgetGroup,
    NewBudgetGroupAssignment, NewBudgetRolloverSetting, NewBudgetTarget, UpdateBudgetGroup,
};

#[async_trait]
pub trait BudgetRepositoryTrait: Send + Sync {
    async fn list_groups(&self) -> Result<Vec<BudgetGroup>>;
    async fn create_group(&self, new_group: NewBudgetGroup) -> Result<BudgetGroup>;
    async fn update_group(&self, id: &str, patch: UpdateBudgetGroup) -> Result<BudgetGroup>;
    async fn delete_group(&self, id: &str) -> Result<()>;
    async fn delete_group_and_reassign(
        &self,
        id: &str,
        reassign_to_group_id: &str,
        reassignments: Vec<NewBudgetGroupAssignment>,
    ) -> Result<()>;
    async fn upsert_system_groups(&self, groups: Vec<NewBudgetGroup>) -> Result<Vec<BudgetGroup>>;

    async fn list_group_assignments(&self) -> Result<Vec<BudgetGroupAssignment>>;
    async fn upsert_group_assignment(
        &self,
        assignment: NewBudgetGroupAssignment,
    ) -> Result<BudgetGroupAssignment>;
    async fn upsert_group_assignments(
        &self,
        assignments: Vec<NewBudgetGroupAssignment>,
    ) -> Result<Vec<BudgetGroupAssignment>>;
    async fn upsert_system_group_assignments(
        &self,
        assignments: Vec<NewBudgetGroupAssignment>,
    ) -> Result<Vec<BudgetGroupAssignment>>;

    async fn list_targets(&self) -> Result<Vec<BudgetTarget>>;
    async fn upsert_target(&self, target: NewBudgetTarget) -> Result<BudgetTarget>;
    async fn delete_target(&self, id: &str) -> Result<()>;

    async fn list_rollover_settings(&self) -> Result<Vec<BudgetRolloverSetting>>;
    async fn upsert_rollover_setting(
        &self,
        setting: NewBudgetRolloverSetting,
    ) -> Result<BudgetRolloverSetting>;
    async fn delete_rollover_setting(&self, id: &str) -> Result<()>;
    async fn disable_category_rollovers(
        &self,
        taxonomy_id: &str,
        category_ids: &[String],
    ) -> Result<Vec<BudgetRolloverSetting>>;

    async fn copy_period_targets(
        &self,
        source_period_key: &str,
        target_period_key: &str,
        overwrite: bool,
    ) -> Result<Vec<BudgetTarget>>;
}
