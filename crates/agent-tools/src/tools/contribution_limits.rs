//! Contribution limits tool - contribution room and usage by group.

use rust_decimal::prelude::ToPrimitive;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::constants::MAX_CONTRIBUTION_LIMITS;
use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};

/// Arguments for the get_contribution_limits tool (no required args).
#[derive(Debug, Default, Deserialize)]
pub struct GetContributionLimitsArgs {}

/// DTO for a contribution limit in tool output.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContributionLimitDto {
    pub id: String,
    pub group_name: String,
    pub contribution_year: i32,
    pub limit_amount: f64,
    /// Amount contributed so far against this limit, in base currency.
    pub used_amount: f64,
    /// Remaining room (`limit_amount - used_amount`), in base currency.
    pub remaining_amount: f64,
    pub currency: String,
}

/// Output envelope for the contribution limits tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetContributionLimitsOutput {
    pub limits: Vec<ContributionLimitDto>,
    pub count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_count: Option<usize>,
}

/// Tool to get contribution limits with usage and remaining room.
pub struct GetContributionLimits;

#[async_trait::async_trait]
impl AgentTool for GetContributionLimits {
    fn name(&self) -> &'static str {
        "get_contribution_limits"
    }

    fn description(&self) -> &'static str {
        "Get contribution limits (e.g. RRSP/TFSA/401k) with the configured yearly limit, the amount contributed so far, and the remaining contribution room in base currency."
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
        let _args: GetContributionLimitsArgs = serde_json::from_value(args)?;
        let base_currency = env.base_currency();
        let service = env.contribution_limit_service();

        let limits = service
            .get_contribution_limits()
            .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;

        let original_count = limits.len();
        let mut limits_dto: Vec<ContributionLimitDto> = Vec::new();
        for limit in limits.into_iter().take(MAX_CONTRIBUTION_LIMITS) {
            let used_amount = service
                .calculate_deposits_for_contribution_limit(&limit.id, &base_currency)
                .ok()
                .and_then(|deposits| deposits.total.to_f64())
                .unwrap_or(0.0);
            limits_dto.push(ContributionLimitDto {
                id: limit.id,
                group_name: limit.group_name,
                contribution_year: limit.contribution_year,
                limit_amount: limit.limit_amount,
                used_amount,
                remaining_amount: limit.limit_amount - used_amount,
                currency: base_currency.clone(),
            });
        }

        let returned_count = limits_dto.len();
        let truncated = original_count > returned_count;

        let output = GetContributionLimitsOutput {
            limits: limits_dto,
            count: returned_count,
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
