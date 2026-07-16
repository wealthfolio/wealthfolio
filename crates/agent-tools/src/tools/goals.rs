//! Goals tool - fetch investment goals.

use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::constants::MAX_GOALS;
use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};

/// Arguments for the get_goals tool (no required args).
#[derive(Debug, Default, Deserialize)]
pub struct GetGoalsArgs {}

/// DTO for goal data in tool output.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalDto {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub target_amount: f64,
    pub current_amount: f64,
    pub progress_percent: f64,
    pub deadline: Option<String>,
    pub is_achieved: bool,
}

/// Output envelope for goals tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetGoalsOutput {
    pub goals: Vec<GoalDto>,
    pub count: usize,
    pub total_target: f64,
    pub total_current: f64,
    pub achieved_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_count: Option<usize>,
}

/// Tool to get investment goals with progress.
pub struct GetGoals;

#[async_trait::async_trait]
impl AgentTool for GetGoals {
    fn name(&self) -> &'static str {
        "get_goals"
    }

    fn description(&self) -> &'static str {
        "Get investment goals with current progress. Returns goal title, target amount, current amount, progress percentage, and deadline for each goal."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {},
            "required": []
        })
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::FinancialPlanningRead]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let _args: GetGoalsArgs = serde_json::from_value(args)?;

        // Fetch goals
        let goals = env
            .goal_service()
            .get_goals()
            .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;

        let original_count = goals.len();

        // Convert to DTOs using persisted summary fields
        let goals_dto: Vec<GoalDto> = goals
            .into_iter()
            .take(MAX_GOALS)
            .map(|g| {
                let target = g.summary_target_amount.or(g.target_amount).unwrap_or(0.0);
                let current_amount = g.summary_current_value.unwrap_or(0.0);
                let progress_percent = g.summary_progress.unwrap_or(0.0) * 100.0;

                GoalDto {
                    id: g.id,
                    title: g.title,
                    description: g.description,
                    target_amount: target,
                    current_amount,
                    progress_percent,
                    deadline: g.target_date,
                    is_achieved: g.status_lifecycle == "achieved",
                }
            })
            .collect();

        let returned_count = goals_dto.len();
        let truncated = original_count > returned_count;

        // Calculate totals
        let total_target: f64 = goals_dto.iter().map(|g| g.target_amount).sum();
        let total_current: f64 = goals_dto.iter().map(|g| g.current_amount).sum();
        let achieved_count = goals_dto.iter().filter(|g| g.is_achieved).count();

        let output = GetGoalsOutput {
            goals: goals_dto,
            count: returned_count,
            total_target,
            total_current,
            achieved_count,
            truncated: if truncated { Some(true) } else { None },
            original_count: if truncated {
                Some(original_count)
            } else {
                None
            },
        };
        Ok(AgentToolResult {
            content: serde_json::to_value(output)?,
        })
    }
}
