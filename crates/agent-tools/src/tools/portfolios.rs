//! Portfolios tool - list portfolios (named account groups).

use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::constants::MAX_PORTFOLIOS;
use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};

/// Arguments for the get_portfolios tool (no required args).
#[derive(Debug, Default, Deserialize)]
pub struct GetPortfoliosArgs {}

/// DTO for a portfolio in tool output.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioDto {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// Member account ids grouped by this portfolio.
    pub account_ids: Vec<String>,
    /// Number of member accounts.
    pub account_count: usize,
}

/// Output envelope for the portfolios tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetPortfoliosOutput {
    pub portfolios: Vec<PortfolioDto>,
    pub count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_count: Option<usize>,
}

/// Tool to list portfolios (named groups of accounts).
pub struct GetPortfolios;

#[async_trait::async_trait]
impl AgentTool for GetPortfolios {
    fn name(&self) -> &'static str {
        "get_portfolios"
    }

    fn description(&self) -> &'static str {
        "Get the list of saved portfolios. A portfolio is a named group of accounts used as a reporting scope. Returns each portfolio's id, name, description, and member account ids."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {},
            "required": []
        })
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::AccountsRead]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let _args: GetPortfoliosArgs = serde_json::from_value(args)?;

        let portfolios = env
            .portfolio_service()
            .list_portfolios()
            .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;

        let original_count = portfolios.len();
        let portfolios_dto: Vec<PortfolioDto> = portfolios
            .into_iter()
            .take(MAX_PORTFOLIOS)
            .map(|p| PortfolioDto {
                id: p.id,
                name: p.name,
                description: p.description,
                account_count: p.account_ids.len(),
                account_ids: p.account_ids,
            })
            .collect();

        let returned_count = portfolios_dto.len();
        let truncated = original_count > returned_count;

        let output = GetPortfoliosOutput {
            portfolios: portfolios_dto,
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
