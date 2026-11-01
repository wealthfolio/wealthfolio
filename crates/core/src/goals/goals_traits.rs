//! Goal service and repository trait definitions.

use crate::errors::Result;
use crate::goals::goals_model::{
    AccountValuationMap, Goal, GoalFundingRule, GoalFundingRuleInput, GoalPlan, GoalSummaryUpdate,
    GoalUpdate, NewGoal, PreparedRetirementSimulationInput, SaveGoalPlan,
};
use crate::planning::SaveUpOverview;
use crate::portfolio::fire::RetirementOverview;
use async_trait::async_trait;

/// Trait for goal repository operations
#[async_trait]
pub trait GoalRepositoryTrait: Send + Sync {
    fn load_goals(&self) -> Result<Vec<Goal>>;
    fn load_goal(&self, goal_id: &str) -> Result<Goal>;
    async fn insert_new_goal(&self, new_goal: NewGoal) -> Result<Goal>;
    async fn insert_goal_with_funding(
        &self,
        new_goal: NewGoal,
        funding_rules: Vec<GoalFundingRuleInput>,
    ) -> Result<Goal>;
    async fn update_goal(&self, goal_update: Goal) -> Result<Goal>;
    async fn delete_goal(&self, goal_id_to_delete: String) -> Result<usize>;

    // Funding rules
    fn load_funding_rules(&self, goal_id: &str) -> Result<Vec<GoalFundingRule>>;
    fn load_participating_funding_rules(&self) -> Result<Vec<GoalFundingRule>>;
    async fn save_goal_funding(
        &self,
        goal_id: &str,
        rules: Vec<GoalFundingRuleInput>,
    ) -> Result<Vec<GoalFundingRule>>;

    // Plans
    fn load_goal_plan(&self, goal_id: &str) -> Result<Option<GoalPlan>>;
    async fn save_goal_plan(&self, plan: SaveGoalPlan) -> Result<GoalPlan>;
    async fn delete_goal_plan(&self, goal_id: &str) -> Result<usize>;

    // Goal summary
    async fn update_goal_summary_fields(
        &self,
        goal_id: &str,
        update: GoalSummaryUpdate,
    ) -> Result<()>;
}

/// Trait for goal service operations
#[async_trait]
pub trait GoalServiceTrait: Send + Sync {
    fn get_goals(&self) -> Result<Vec<Goal>>;
    fn get_goal(&self, goal_id: &str) -> Result<Goal>;
    async fn create_goal(&self, new_goal: NewGoal) -> Result<Goal>;
    async fn update_goal(&self, updated_goal_data: GoalUpdate) -> Result<Goal>;
    async fn delete_goal(&self, goal_id_to_delete: String) -> Result<usize>;

    // Funding
    fn get_goal_funding(&self, goal_id: &str) -> Result<Vec<GoalFundingRule>>;
    async fn save_goal_funding(
        &self,
        goal_id: &str,
        rules: Vec<GoalFundingRuleInput>,
    ) -> Result<Vec<GoalFundingRule>>;

    // Plans
    fn get_goal_plan(&self, goal_id: &str) -> Result<Option<GoalPlan>>;
    async fn save_goal_plan(&self, plan: SaveGoalPlan) -> Result<GoalPlan>;
    async fn delete_goal_plan(&self, goal_id: &str) -> Result<usize>;

    // Summary
    async fn current_valuation_map(&self) -> Result<AccountValuationMap>;
    async fn refresh_goal_summary(&self, goal_id: &str) -> Result<Goal>;
    async fn refresh_all_goal_summaries(&self) -> Result<Vec<Goal>>;

    // Retirement overview
    async fn compute_retirement_overview(
        &self,
        goal_id: &str,
        valuation_map: &AccountValuationMap,
    ) -> Result<RetirementOverview>;

    async fn prepare_retirement_simulation_input(
        &self,
        goal_id: &str,
        valuation_map: &AccountValuationMap,
    ) -> Result<PreparedRetirementSimulationInput>;

    // Save-up overview
    async fn compute_save_up_overview(
        &self,
        goal_id: &str,
        valuation_map: &AccountValuationMap,
    ) -> Result<SaveUpOverview>;
}
