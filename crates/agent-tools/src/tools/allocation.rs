//! Asset allocation tool - get portfolio allocation using AllocationService.

use rust_decimal::prelude::ToPrimitive;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use wealthfolio_core::accounts::{account_supports_purpose, AccountPurpose};

use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};

/// Arguments for the get_asset_allocation tool.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetAssetAllocationArgs {
    /// Account ID. Omit for all accounts.
    #[serde(default)]
    pub account_id: Option<String>,

    /// Grouping method: "class", "sector", "region", "risk", or "security_type".
    #[serde(default = "default_group_by")]
    pub group_by: String,

    /// Optional: taxonomy ID for drill-down (e.g., "industries_gics").
    pub taxonomy_id: Option<String>,

    /// Optional: category ID for drill-down (e.g., "TECHNOLOGY").
    pub category_id: Option<String>,
}

fn default_group_by() -> String {
    "class".to_string()
}

/// DTO for allocation category in tool output.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllocationDto {
    pub category_id: String,
    pub category_name: String,
    pub value: f64,
    pub percentage: f64,
    pub color: String,
}

/// DTO for holding in drill-down output.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldingDto {
    pub symbol: String,
    pub name: Option<String>,
    pub value: f64,
    pub weight: f64,
}

/// Output envelope for asset allocation tool.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GetAssetAllocationOutput {
    /// Allocation categories (for allocation mode).
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub allocations: Vec<AllocationDto>,

    /// Total portfolio value.
    pub total_value: f64,

    /// Base currency.
    pub currency: String,

    /// Grouping method used.
    pub group_by: String,

    /// Taxonomy ID.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub taxonomy_id: Option<String>,

    /// Taxonomy name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub taxonomy_name: Option<String>,

    /// Holdings in category (for drill-down mode).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub holdings: Option<Vec<HoldingDto>>,

    /// Category name when in drill-down mode.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category_name: Option<String>,
}

/// Tool to get portfolio asset allocation.
pub struct GetAssetAllocation;

#[async_trait::async_trait]
impl AgentTool for GetAssetAllocation {
    fn name(&self) -> &'static str {
        "get_asset_allocation"
    }

    fn description(&self) -> &'static str {
        "Get portfolio asset allocation breakdown. Can group by asset class, sector, region, risk level, or security type. Supports drill-down to see holdings within a specific category."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "accountId": {
                    "type": "string",
                    "description": "Account ID to get allocation for. Omit for all accounts."
                },
                "groupBy": {
                    "type": "string",
                    "enum": ["class", "sector", "region", "risk", "security_type"],
                    "description": "Grouping: 'class' (Equity/Fixed Income/Cash), 'sector' (Technology/Healthcare/etc), 'region' (North America/Europe/etc), 'risk' (Low/Medium/High), 'security_type' (Stock/ETF/Bond)",
                    "default": "class"
                },
                "taxonomyId": {
                    "type": "string",
                    "description": "For drill-down: taxonomy ID (use value from previous allocation response)"
                },
                "categoryId": {
                    "type": "string",
                    "description": "For drill-down: category ID to show holdings for (use value from previous allocation response)"
                }
            },
            "required": []
        })
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::HoldingsRead]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: GetAssetAllocationArgs = serde_json::from_value(args)?;
        let base_currency = env.base_currency();
        let account_id = args.account_id.as_deref().filter(|id| !id.is_empty());
        let group_by = args.group_by.to_lowercase();
        let scoped_account_ids = if let Some(account_id) = account_id {
            let account = env
                .account_service()
                .get_account(account_id)
                .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;
            if !account_supports_purpose(&account.account_type, AccountPurpose::Holdings) {
                Some(Vec::new())
            } else {
                None
            }
        } else {
            Some(
                env.account_service()
                    .get_active_non_archived_accounts()
                    .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?
                    .into_iter()
                    .filter(|account| {
                        account_supports_purpose(&account.account_type, AccountPurpose::Holdings)
                    })
                    .map(|account| account.id)
                    .collect::<Vec<_>>(),
            )
        };

        // Drill-down mode: return holdings for a specific category
        if let (Some(taxonomy_id), Some(category_id)) = (&args.taxonomy_id, &args.category_id) {
            let result = if let Some(account_ids) = &scoped_account_ids {
                env.allocation_service()
                    .get_holdings_by_allocation_for_accounts(
                        account_ids,
                        &base_currency,
                        taxonomy_id,
                        category_id,
                        "all",
                    )
                    .await
                    .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?
            } else {
                env.allocation_service()
                    .get_holdings_by_allocation(
                        account_id.expect("single-account branch checked"),
                        &base_currency,
                        taxonomy_id,
                        category_id,
                    )
                    .await
                    .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?
            };

            let holding_dtos: Vec<HoldingDto> = result
                .holdings
                .into_iter()
                .map(|h| HoldingDto {
                    symbol: h.symbol,
                    name: h.name,
                    value: h.market_value.to_f64().unwrap_or(0.0),
                    weight: h.weight_in_category.to_f64().unwrap_or(0.0),
                })
                .collect();

            let output = GetAssetAllocationOutput {
                holdings: Some(holding_dtos),
                total_value: result.total_value.to_f64().unwrap_or(0.0),
                currency: result.currency,
                group_by,
                taxonomy_id: Some(result.taxonomy_id),
                taxonomy_name: Some(result.taxonomy_name),
                category_name: Some(result.category_name),
                ..Default::default()
            };
            return Ok(AgentToolResult {
                content: serde_json::to_value(output)?,
            });
        }

        // Allocation mode: get allocation breakdown
        let allocations = if let Some(account_ids) = &scoped_account_ids {
            env.allocation_service()
                .get_portfolio_allocations_for_accounts(account_ids, &base_currency, "all")
                .await
                .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?
        } else {
            env.allocation_service()
                .get_portfolio_allocations(
                    account_id.expect("single-account branch checked"),
                    &base_currency,
                )
                .await
                .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?
        };

        // Select the taxonomy based on group_by
        let taxonomy = match group_by.as_str() {
            "class" => &allocations.asset_classes,
            "sector" => &allocations.sectors,
            "region" => &allocations.regions,
            "risk" => &allocations.risk_category,
            "security_type" => &allocations.security_types,
            _ => {
                return Err(AgentToolError::ExecutionFailed(format!(
                    "Invalid groupBy value '{}'. Must be 'class', 'sector', 'region', 'risk', or 'security_type'.",
                    group_by
                )));
            }
        };

        // Convert categories to DTOs
        let allocation_dtos: Vec<AllocationDto> = taxonomy
            .categories
            .iter()
            .map(|c| AllocationDto {
                category_id: c.category_id.clone(),
                category_name: c.category_name.clone(),
                value: c.value.to_f64().unwrap_or(0.0),
                percentage: c.percentage.to_f64().unwrap_or(0.0),
                color: c.color.clone(),
            })
            .collect();

        let output = GetAssetAllocationOutput {
            allocations: allocation_dtos,
            total_value: allocations.total_value.to_f64().unwrap_or(0.0),
            currency: base_currency,
            group_by,
            taxonomy_id: Some(taxonomy.taxonomy_id.clone()),
            taxonomy_name: Some(taxonomy.taxonomy_name.clone()),
            ..Default::default()
        };
        Ok(AgentToolResult {
            content: serde_json::to_value(output)?,
        })
    }
}
