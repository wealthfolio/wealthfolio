//! Goals module - domain models, services, and traits.

pub const GOAL_SUMMARIES_UPDATED: &str = "goal:summaries-updated";

mod goals_model;
mod goals_service;
mod goals_traits;

pub use goals_model::{
    AccountValuationMap, Goal, GoalFundingRule, GoalFundingRuleInput, GoalPlan, GoalSummaryUpdate,
    NewGoal, PreparedRetirementSimulationInput, SaveGoalPlan,
};
pub use goals_service::{validate_retirement_plan, GoalService, GoalValuationServices};
pub use goals_traits::{GoalRepositoryTrait, GoalServiceTrait};
