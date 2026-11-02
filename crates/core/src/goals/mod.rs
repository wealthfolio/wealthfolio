//! Goals module - domain models, services, and traits.

pub const GOAL_SUMMARIES_UPDATED: &str = "goal:summaries-updated";

mod goals_model;
mod goals_service;
mod goals_traits;

pub use goals_model::{
    AccountValuationMap, Goal, GoalFundingRule, GoalFundingRuleInput, GoalPlan,
    GoalSummariesUpdated, GoalSummaryUpdate, GoalUpdate, NewGoal,
    PreparedRetirementSimulationInput, SaveGoalPlan,
};
pub use goals_service::{
    summary_refresh_error_kind, validate_retirement_plan, GoalService, GoalValuationServices,
};
pub use goals_traits::{GoalRepositoryTrait, GoalServiceTrait};
