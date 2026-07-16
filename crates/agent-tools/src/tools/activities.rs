//! Activities tool - search transactions.

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use wealthfolio_core::activities::Sort;

use crate::constants::{DEFAULT_PAGE_SIZE, MAX_ACTIVITIES_ROWS};
use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};

/// Arguments for the search_activities tool.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchActivitiesArgs {
    /// Account ID filter (optional, all accounts if not provided).
    pub account_id: Option<String>,
    /// Activity type filter (e.g., "BUY", "SELL", "DIVIDEND").
    pub activity_type: Option<String>,
    /// Symbol/asset keyword filter.
    pub symbol: Option<String>,
    /// Start date filter in YYYY-MM-DD format (optional).
    pub date_from: Option<String>,
    /// End date filter in YYYY-MM-DD format (optional).
    pub date_to: Option<String>,
    /// Page number (1-based, default: 1).
    pub page: Option<i64>,
    /// Number of results per page (default: 50, max: 200).
    pub page_size: Option<i64>,
}

/// DTO for activity data in tool output.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDto {
    pub id: String,
    pub date: String,
    pub activity_type: String,
    pub symbol: Option<String>,
    pub quantity: Option<f64>,
    pub unit_price: Option<f64>,
    pub amount: Option<f64>,
    pub fee: Option<f64>,
    pub fx_rate: Option<f64>,
    pub currency: String,
    pub account_id: String,
    pub account_name: Option<String>,
}

/// Output envelope for activities tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchActivitiesOutput {
    pub activities: Vec<ActivityDto>,
    pub count: usize,
    pub total_row_count: usize,
    pub page: i64,
    pub page_size: i64,
    pub total_pages: i64,
    pub account_scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_amount: Option<f64>,
}

/// Tool to search activities/transactions.
pub struct SearchActivities;

#[async_trait::async_trait]
impl AgentTool for SearchActivities {
    fn name(&self) -> &'static str {
        "search_activities"
    }

    fn description(&self) -> &'static str {
        "Search and get investment activities (transactions) such as buys, sells, dividends, deposits, and withdrawals. Supports filtering, date ranges, and pagination. Returns paginated results with totalPages so you can request more pages if needed."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "accountId": {
                    "type": "string",
                    "description": "Filter by account ID (optional, all accounts if not provided)"
                },
                "activityType": {
                    "type": "string",
                    "description": "Filter by activity type",
                    "enum": ["BUY", "SELL", "DIVIDEND", "DEPOSIT", "WITHDRAWAL", "TRANSFER_IN", "TRANSFER_OUT", "INTEREST", "FEE", "SPLIT", "TAX"]
                },
                "symbol": {
                    "type": "string",
                    "description": "Filter by symbol or asset keyword"
                },
                "dateFrom": {
                    "type": "string",
                    "description": "Start date filter in YYYY-MM-DD format (optional)"
                },
                "dateTo": {
                    "type": "string",
                    "description": "End date filter in YYYY-MM-DD format (optional)"
                },
                "page": {
                    "type": "integer",
                    "description": "Page number, 1-based (default: 1)",
                    "default": 1
                },
                "pageSize": {
                    "type": "integer",
                    "description": "Number of results per page (default: 50, max: 200)",
                    "default": 50
                }
            },
            "required": []
        })
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::ActivitiesRead]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        use chrono::NaiveDate;

        let args: SearchActivitiesArgs = serde_json::from_value(args)?;

        // Pagination: external tool API is 1-based, backend search uses 0-based page index
        let page = args.page.unwrap_or(1).max(1);
        let backend_page = page - 1;
        let page_size = args
            .page_size
            .unwrap_or(DEFAULT_PAGE_SIZE)
            .clamp(1, MAX_ACTIVITIES_ROWS as i64);

        let account_id = args.account_id.filter(|s| !s.is_empty());
        let activity_types = args
            .activity_type
            .filter(|s| !s.is_empty())
            .map(|t| vec![t]);
        let symbol_keyword = args.symbol.filter(|s| !s.is_empty());

        // Resolve account filter: if the value isn't a known account ID, try matching by name
        let account_ids = if let Some(ref raw) = account_id {
            let accounts = env
                .account_service()
                .get_active_non_archived_accounts()
                .unwrap_or_default();
            let is_known_id = accounts.iter().any(|a| a.id == *raw);
            if is_known_id {
                Some(vec![raw.clone()])
            } else {
                // Try case-insensitive name match
                let raw_lower = raw.to_lowercase();
                let matched: Vec<String> = accounts
                    .iter()
                    .filter(|a| a.name.to_lowercase() == raw_lower)
                    .map(|a| a.id.clone())
                    .collect();
                if matched.is_empty() {
                    // No match — pass raw value (will return 0 results)
                    Some(vec![raw.clone()])
                } else {
                    Some(matched)
                }
            }
        } else {
            None
        };

        // Parse date filters (skip empty strings)
        let date_from = args
            .date_from
            .filter(|s| !s.is_empty())
            .map(|s| {
                NaiveDate::parse_from_str(&s, "%Y-%m-%d").map_err(|_| {
                    AgentToolError::InvalidInput(format!("Invalid dateFrom format: {s}"))
                })
            })
            .transpose()?;
        let date_to = args
            .date_to
            .filter(|s| !s.is_empty())
            .map(|s| {
                NaiveDate::parse_from_str(&s, "%Y-%m-%d").map_err(|_| {
                    AgentToolError::InvalidInput(format!("Invalid dateTo format: {s}"))
                })
            })
            .transpose()?;

        // Sort by date descending
        let sort = Sort {
            id: "date".to_string(),
            desc: true,
        };

        // Search activities
        let response = env
            .activity_service()
            .search_activities(
                backend_page,
                page_size,
                account_ids.clone(),
                activity_types,
                symbol_keyword,
                Some(sort),
                None, // needs_review_filter
                date_from,
                date_to,
                None, // instrument_type_filter
                None, // activity_id_filter
            )
            .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;

        let total_row_count = response.meta.total_row_count as usize;
        let total_pages = ((total_row_count as i64) + page_size - 1) / page_size;

        // Convert to DTOs
        let activities: Vec<ActivityDto> = response
            .data
            .into_iter()
            .map(|a| {
                let quantity = a.quantity.as_ref().and_then(|v| v.parse::<f64>().ok());
                let unit_price = a.unit_price.as_ref().and_then(|v| v.parse::<f64>().ok());
                let fee = a.fee.as_ref().and_then(|v| v.parse::<f64>().ok());
                let fx_rate = a.fx_rate.as_ref().and_then(|v| v.parse::<f64>().ok());
                let amount = a
                    .amount
                    .as_ref()
                    .and_then(|s| s.parse::<f64>().ok())
                    .or_else(|| Some(quantity? * unit_price?));

                ActivityDto {
                    id: a.id,
                    date: a.date.clone(),
                    activity_type: a.activity_type,
                    symbol: if a.asset_symbol.is_empty() {
                        None
                    } else {
                        Some(a.asset_symbol)
                    },
                    quantity,
                    unit_price,
                    amount,
                    fee,
                    fx_rate,
                    currency: a.currency,
                    account_id: a.account_id.clone(),
                    account_name: Some(a.account_name),
                }
            })
            .collect();

        let returned_count = activities.len();

        // Calculate totals for metadata
        let total_amount: f64 = activities.iter().filter_map(|a| a.amount).sum();

        let account_scope = account_id.unwrap_or_else(|| "all".to_string());

        let output = SearchActivitiesOutput {
            activities,
            count: returned_count,
            total_row_count,
            page,
            page_size,
            total_pages,
            account_scope,
            total_amount: if total_amount > 0.0 {
                Some(total_amount)
            } else {
                None
            },
        };
        Ok(AgentToolResult {
            content: serde_json::to_value(output)?,
        })
    }
}
