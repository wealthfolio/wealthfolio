//! Spending-only discovery and transaction reads. Calculations and enrollment
//! remain in the existing Spending services; raw reads never fetch FX.

use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};
use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use wealthfolio_core::utils::time_utils::parse_user_timezone_or_default;
use wealthfolio_spending::cash_activities::model::EffectiveCategoryAllocation;
use wealthfolio_spending::cash_activities::{CashActivity, CashActivitySearchRequest};

pub struct GetSpendingContext;
pub struct SearchSpendingTransactions;
pub struct ListTransactionCategories;

fn execution_error(error: impl std::fmt::Display) -> AgentToolError {
    AgentToolError::ExecutionFailed(error.to_string())
}

fn timezone(env: &dyn AgentEnvironment) -> Result<String, AgentToolError> {
    let settings = env
        .settings_service()
        .get_settings()
        .map_err(execution_error)?;
    Ok(parse_user_timezone_or_default(&settings.timezone).to_string())
}

async fn context(env: &dyn AgentEnvironment) -> Result<Value, AgentToolError> {
    let context = env
        .cash_activity_service()
        .context()
        .await
        .map_err(execution_error)?;
    let availability = if !context.enabled {
        "disabled"
    } else if context.account_ids.is_empty() {
        "no_accounts"
    } else {
        "available"
    };
    // Resolve labels only for the effective enrollment, never list all accounts.
    let accounts = if context.account_ids.is_empty() {
        Vec::new()
    } else {
        env.account_service()
            .get_accounts_by_ids(&context.account_ids)
            .map_err(execution_error)?
    };
    Ok(
        json!({ "enabled": context.enabled, "availability": availability,
            "accountIds": context.account_ids,
            "accounts": accounts.into_iter().map(|account| json!({"id": account.id, "name": account.name, "currency": account.currency, "accountType": account.account_type})).collect::<Vec<_>>(),
            "excludedCategoryIds": context.excluded_category_ids,
            "baseCurrency": env.base_currency(), "timezone": timezone(env)?,
            "amountPolicy": "Transaction amounts and allocations are in each row's own currency. No FX is requested. Report and budget amounts use their separate period conversion policy."
        }),
    )
}

#[async_trait::async_trait]
impl AgentTool for GetSpendingContext {
    fn name(&self) -> &'static str {
        "get_spending_context"
    }
    fn description(&self) -> &'static str {
        "Discover whether Spending is enabled, its effective opted-in accounts, excluded categories, base currency and timezone. Read-only; never enables Spending or enrolls accounts. Categories and rule configuration remain discoverable even when disabled."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{},"additionalProperties":false})
    }
    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::SpendingRead]
    }
    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }
    fn sanitize_args_for_audit(&self, _: &Value) -> Value {
        json!({})
    }
    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        _: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        Ok(AgentToolResult {
            content: context(env.as_ref()).await?,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchArgs {
    #[serde(flatten)]
    request: CashActivitySearchRequest,
    query: Option<String>,
}

fn parse_search(args: Value) -> Result<CashActivitySearchRequest, AgentToolError> {
    let schema = SearchSpendingTransactions.input_schema();
    if args.as_object().is_none_or(|object| {
        object
            .keys()
            .any(|key| schema["properties"].get(key).is_none())
    }) {
        return Err(AgentToolError::InvalidInput(
            "Unknown Spending search arguments".to_string(),
        ));
    }
    let mut args: SearchArgs = serde_json::from_value(args).map_err(|_| {
        AgentToolError::InvalidInput("Invalid Spending search arguments".to_string())
    })?;
    let request = &mut args.request;
    request.search = args.query.or(request.search.take());
    if !(1..=100).contains(&request.limit) {
        return Err(AgentToolError::InvalidInput(
            "limit must be between 1 and 100".to_string(),
        ));
    }
    for ids in [
        &request.activity_ids,
        &request.account_ids,
        &request.category_ids,
        &request.subcategory_ids,
        &request.event_ids,
    ] {
        if ids
            .as_ref()
            .is_some_and(|ids| ids.len() > 100 || ids.iter().any(|id| id.trim().is_empty()))
        {
            return Err(AgentToolError::InvalidInput(
                "ID filters must contain at most 100 nonblank IDs".to_string(),
            ));
        }
    }
    let parse_date = |value: &Option<String>| {
        value
            .as_deref()
            .map(DateTime::parse_from_rfc3339)
            .transpose()
            .map_err(|_| {
                AgentToolError::InvalidInput("Dates must be RFC3339 timestamps".to_string())
            })
    };
    let start = parse_date(&request.start_date)?;
    let end = parse_date(&request.end_date)?;
    if start.zip(end).is_some_and(|(start, end)| start > end) {
        return Err(AgentToolError::InvalidInput(
            "startDate must not follow endDate".to_string(),
        ));
    }
    if request
        .min_amount
        .is_some_and(|n| !n.is_finite() || n < 0.0)
        || request
            .max_amount
            .is_some_and(|n| !n.is_finite() || n < 0.0)
        || request
            .min_amount
            .zip(request.max_amount)
            .is_some_and(|(min, max)| min > max)
    {
        return Err(AgentToolError::InvalidInput(
            "Amount bounds must be nonnegative and ordered".to_string(),
        ));
    }
    if request.activity_types.as_ref().is_some_and(|types| {
        types.iter().any(|kind| {
            !wealthfolio_spending::cash_activities::CASH_ACTIVITY_TYPES.contains(&kind.as_str())
        })
    }) {
        return Err(AgentToolError::InvalidInput(
            "Only Spending cash activity types are supported".to_string(),
        ));
    }
    Ok(args.request)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Transaction {
    #[serde(flatten)]
    row: CashActivity,
    effective_allocations: Vec<EffectiveCategoryAllocation>,
    has_hidden_assignment: bool,
}

#[async_trait::async_trait]
impl AgentTool for SearchSpendingTransactions {
    fn name(&self) -> &'static str {
        "search_spending_transactions"
    }
    fn description(&self) -> &'static str {
        "Search posted cash transactions only within enabled, opted-in Spending accounts. Filters intersect, including explicit activityIds. Returns totalCount, offset, limit and hasMore; paginate until hasMore is false. All amounts and effectiveAllocations are in each transaction's currency; do not add different currencies. Splits win over legacy hidden assignments: use effectiveAllocations for categories, and hasHiddenAssignment for diagnostics. Full splits are returned for explicit reviewed replacement through commit_transaction_categories(expectedSplits). No FX or investment access is needed."
    }
    fn input_schema(&self) -> Value {
        let ids = json!({"type":"array","maxItems":100,"items":{"type":"string","minLength":1}});
        json!({"type":"object","properties": {
            "query":{"type":"string","description":"Case-insensitive text search over transaction notes/payee."},
            "activityIds":ids, "accountIds":ids, "categoryIds":ids, "subcategoryIds":ids, "eventIds":ids,
            "activityTypes":{"type":"array","items":{"type":"string","enum":wealthfolio_spending::cash_activities::CASH_ACTIVITY_TYPES}},
            "status":{"type":"string","enum":["all","uncategorized","categorized","needs_review"]},
            "startDate":{"type":"string","description":"Inclusive RFC3339 timestamp."}, "endDate":{"type":"string","description":"Inclusive RFC3339 timestamp."},
            "minAmount":{"type":"number","minimum":0}, "maxAmount":{"type":"number","minimum":0},
            "sortBy":{"type":"string","enum":["date","amount"]}, "sortDir":{"type":"string","enum":["asc","desc"]},
            "offset":{"type":"integer","minimum":0,"default":0}, "limit":{"type":"integer","minimum":1,"maximum":100,"default":50}
        },"additionalProperties":false})
    }
    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::SpendingRead]
    }
    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }
    fn sanitize_args_for_audit(&self, _: &Value) -> Value {
        json!({})
    }
    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let request = parse_search(args)?;
        let offset = request.offset;
        let limit = request.limit;
        let requested_accounts = request.account_ids.clone();
        let period = json!({"start":request.start_date,"end":request.end_date});
        let response = env
            .cash_activity_service()
            .search(request)
            .await
            .map_err(execution_error)?;
        let mut context = context(env.as_ref()).await?;
        if let Some(accounts) = requested_accounts {
            context["accountIds"]
                .as_array_mut()
                .expect("context accountIds is an array")
                .retain(|id| {
                    id.as_str()
                        .is_some_and(|id| accounts.iter().any(|requested| requested == id))
                });
            let effective = context["accountIds"].clone();
            context["accounts"]
                .as_array_mut()
                .expect("context accounts is an array")
                .retain(|account| {
                    effective
                        .as_array()
                        .expect("array")
                        .contains(&account["id"])
                });
        }
        let items = response
            .items
            .into_iter()
            .map(|row| Transaction {
                effective_allocations: row.effective_allocations(),
                has_hidden_assignment: row.has_hidden_assignment(),
                row,
            })
            .collect::<Vec<_>>();
        Ok(AgentToolResult {
            content: json!({"context":context,"period":period,"items":items,"totalCount":response.total_count,"offset":offset,"limit":limit,
            "hasMore":offset.saturating_add(items.len()) < response.total_count,
            "amountCurrency":"per_transaction","fxRequested":false}),
        })
    }
}

#[async_trait::async_trait]
impl AgentTool for ListTransactionCategories {
    fn name(&self) -> &'static str {
        "list_transaction_categories"
    }
    fn description(&self) -> &'static str {
        "List expense, income and savings category trees by stable taxonomy and category IDs, including keys and parents. Available independently of transaction history and whether Spending is enabled. Category labels do not change a transaction's economic cash-flow bucket."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{},"additionalProperties":false})
    }
    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::SpendingRead]
    }
    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }
    fn sanitize_args_for_audit(&self, _: &Value) -> Value {
        json!({})
    }
    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        _: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let taxonomies = env
            .taxonomy_service()
            .get_taxonomies_with_categories()
            .map_err(execution_error)?;
        let taxonomies = taxonomies
            .into_iter()
            .filter(|entry| {
                [
                    "spending_categories",
                    "income_sources",
                    "savings_categories",
                ]
                .contains(&entry.taxonomy.id.as_str())
            })
            .collect::<Vec<_>>();
        Ok(AgentToolResult {
            content: json!({"taxonomies":taxonomies}),
        })
    }
}

pub struct GetBudget;
pub struct ListSpendingEvents;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BudgetArgs {
    period_key: Option<String>,
}

#[async_trait::async_trait]
impl AgentTool for GetBudget {
    fn name(&self) -> &'static str {
        "get_budget"
    }
    fn description(&self) -> &'static str {
        "Read the native budget configuration and computed snapshot without initializing or changing stored data. periodKey is YYYY-MM (omitted: current month in the configured timezone), or default for base targets. Default targets are inherited by ANY month without an override, including historical months; they are not effective-dated. Explicit monthly overrides win. Removing a monthly override restores the current default. Missing default groups are resolved in memory with native stable IDs. Amounts use the user's base currency and the native budget period FX convention."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"periodKey":{"type":"string","description":"YYYY-MM or default; omit for the current local month."}},"additionalProperties":false})
    }
    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::SpendingRead]
    }
    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }
    fn sanitize_args_for_audit(&self, _: &Value) -> Value {
        json!({})
    }
    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: BudgetArgs = serde_json::from_value(args).map_err(|_| {
            AgentToolError::InvalidInput("Invalid budget read arguments".to_string())
        })?;
        let context = context(env.as_ref()).await?;
        let snapshot = env
            .budget_service()
            .get_readonly(
                args.period_key,
                &env.base_currency(),
                &timezone(env.as_ref())?,
            )
            .await
            .map_err(execution_error)?;
        Ok(AgentToolResult {
            content: json!({"context":context,"budget":snapshot,"defaultPolicy":"All months without an explicit override inherit the current default, including historical months."}),
        })
    }
}

#[async_trait::async_trait]
impl AgentTool for ListSpendingEvents {
    fn name(&self) -> &'static str {
        "list_spending_events"
    }
    fn description(&self) -> &'static str {
        "List stored Spending event definitions and event types. Configuration is discoverable even with Spending disabled or no opted-in accounts. A transaction may be tagged outside an event's date range, including purchases before a trip. Use search_spending_transactions with eventIds to inspect opted-in transactions."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{},"additionalProperties":false})
    }
    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::SpendingRead]
    }
    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }
    fn sanitize_args_for_audit(&self, _: &Value) -> Value {
        json!({})
    }
    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        _: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let service = env.spending_events_service();
        let events = service.list_events().await.map_err(execution_error)?;
        let event_types = service.list_types().await.map_err(execution_error)?;
        Ok(AgentToolResult {
            content: json!({"events":events,"eventTypes":event_types}),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn search_rejects_bad_filters_without_echoing_private_values() {
        for args in [
            json!({"limit":0}),
            json!({"limit":101}),
            json!({"startDate":"private"}),
            json!({"startDate":"2026-10-02T00:00:00Z","endDate":"2026-10-01T00:00:00Z"}),
            json!({"activityIds":[""]}),
            json!({"activityTypes":["BUY"]}),
            json!({"minAmount":10,"maxAmount":1}),
            json!({"private":true}),
        ] {
            let error = parse_search(args).unwrap_err();
            assert!(!error.to_string().contains("private"));
        }
        let request =
            parse_search(json!({"query":"coffee","limit":50,"activityIds":["cash-1"]})).unwrap();
        assert_eq!(request.search.as_deref(), Some("coffee"));
        assert_eq!(request.activity_ids, Some(vec!["cash-1".to_string()]));
    }
}
