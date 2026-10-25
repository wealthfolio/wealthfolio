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
            content: json!({"context":context,"budget":snapshot,"defaultPolicy":"All months without an explicit override inherit the current default, including historical months.","calculationQuality":report_quality()}),
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReportArgs {
    start_date: String,
    end_date: String,
    account_ids: Option<Vec<String>>,
    compare_start_date: Option<String>,
    compare_end_date: Option<String>,
    compare: Option<wealthfolio_spending::insight::CompareMode>,
}

fn report_schema(insight: bool) -> Value {
    let mut schema = json!({"type":"object","additionalProperties":false,"properties":{
        "startDate":{"type":"string","format":"date-time"},
        "endDate":{"type":"string","format":"date-time"},
        "accountIds":{"type":"array","maxItems":100,"items":{"type":"string"}}
    },"required":["startDate","endDate"]});
    if insight {
        schema["properties"]["compareStartDate"] = json!({"type":"string","format":"date-time"});
        schema["properties"]["compareEndDate"] = json!({"type":"string","format":"date-time"});
        schema["properties"]["compare"] =
            json!({"type":"string","enum":["prior","year_over_year"]});
    }
    schema
}

fn validate_window(start: &str, end: &str) -> Result<(), AgentToolError> {
    let start = DateTime::parse_from_rfc3339(start).ok();
    let end = DateTime::parse_from_rfc3339(end).ok();
    if start.zip(end).is_none_or(|(start, end)| start > end) {
        return Err(AgentToolError::InvalidInput(
            "Provide an ordered RFC3339 date window".into(),
        ));
    }
    Ok(())
}

async fn report_args(
    env: &dyn AgentEnvironment,
    args: Value,
    insight: bool,
) -> Result<ReportArgs, AgentToolError> {
    let schema = report_schema(insight);
    if args
        .as_object()
        .is_none_or(|args| args.keys().any(|k| schema["properties"].get(k).is_none()))
    {
        return Err(AgentToolError::InvalidInput(
            "Unknown report arguments".into(),
        ));
    }
    let mut args: ReportArgs = serde_json::from_value(args)
        .map_err(|_| AgentToolError::InvalidInput("Invalid report arguments".into()))?;
    validate_window(&args.start_date, &args.end_date)?;
    match (&args.compare_start_date, &args.compare_end_date) {
        (Some(start), Some(end)) => validate_window(start, end)?,
        (None, None) => (),
        _ => {
            return Err(AgentToolError::InvalidInput(
                "Both comparison bounds are required".into(),
            ))
        }
    }
    if let Some(ids) = &mut args.account_ids {
        if ids.len() > 100 || ids.iter().any(|id| id.trim().is_empty()) {
            return Err(AgentToolError::InvalidInput(
                "Provide at most 100 nonblank account IDs".into(),
            ));
        }
        let enrolled = env
            .cash_activity_service()
            .spending_account_ids()
            .await
            .map_err(execution_error)?;
        ids.retain(|id| enrolled.contains(id));
    }
    Ok(args)
}

/// Coverage comes from the same native conversion attempts as the totals.
fn report_quality() -> Value {
    json!({"coverage":"See calculationQuality on each native report period, insight current/prior window, event summary, or budget.computed. A nonzero missingFxTransactions means totals omit those transactions' unavailable conversions.",
        "budgetCoverage":"Includes months read for rollover as well as the selected month; defaults have no actuals.",
        "conversionPolicy":"Snapshot rate at each report window end; source transaction amounts remain in their own currencies. Zero missing FX is not a guarantee about source-data completeness or accounting policy. No accounting reclassification is performed by MCP."})
}

pub struct GetSpendingReport;
#[async_trait::async_trait]
impl AgentTool for GetSpendingReport {
    fn name(&self) -> &'static str {
        "get_spending_report"
    }
    fn description(&self) -> &'static str {
        "Read Wealthfolio's existing Spending report: current/prior income, consumption, saving, net, category breakdowns and daily series. Uses opted-in accounts, native transfer/exclusion policy and snapshot FX at each window end. Always inspect calculationQuality; native services omit unavailable FX and do not yet report completeness. No accounting changes or writes."
    }
    fn input_schema(&self) -> Value {
        report_schema(false)
    }
    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::SpendingRead]
    }
    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }
    fn sanitize_args_for_audit(&self, _: &Value) -> Value {
        json!({"report":"[redacted]"})
    }
    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args = report_args(env.as_ref(), args, false).await?;
        let timezone = timezone(env.as_ref())?;
        let currency = env.base_currency();
        let period = json!({"startDate":args.start_date,"endDate":args.end_date,"accountIds":args.account_ids,"timezone":timezone,"currency":currency});
        let report = env
            .spending_analytics_service()
            .monthly_report(
                wealthfolio_spending::analytics::ReportRequest {
                    start_date: args.start_date,
                    end_date: args.end_date,
                    account_ids: args.account_ids,
                },
                &timezone,
                &currency,
            )
            .await
            .map_err(|_| {
                AgentToolError::ExecutionFailed("Unable to calculate Spending report".into())
            })?;
        Ok(AgentToolResult {
            content: json!({"context":context(env.as_ref()).await?,"period":period,"report":report,"calculationQuality":report_quality()}),
        })
    }
}

pub struct GetSpendingInsight;
#[async_trait::async_trait]
impl AgentTool for GetSpendingInsight {
    fn name(&self) -> &'static str {
        "get_spending_insight"
    }
    fn description(&self) -> &'static str {
        "Read the native Spending insight, reconciled groups, budgets, comparisons, pace and remaining amounts for a date window. Reuses Wealthfolio's current accounting and pure missing-group resolution. Both explicit comparison bounds override compare. Inspect calculationQuality before interpreting converted totals as complete."
    }
    fn input_schema(&self) -> Value {
        report_schema(true)
    }
    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::SpendingRead]
    }
    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }
    fn sanitize_args_for_audit(&self, _: &Value) -> Value {
        json!({"insight":"[redacted]"})
    }
    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args = report_args(env.as_ref(), args, true).await?;
        let insight = env
            .spending_insight_service()
            .compute(
                wealthfolio_spending::insight::SpendingInsightRequest {
                    start_date: args.start_date,
                    end_date: args.end_date,
                    account_ids: args.account_ids,
                    compare_start_date: args.compare_start_date,
                    compare_end_date: args.compare_end_date,
                    compare: args.compare,
                },
                &env.base_currency(),
                &timezone(env.as_ref())?,
            )
            .await
            .map_err(|_| {
                AgentToolError::ExecutionFailed("Unable to calculate Spending insight".into())
            })?;
        Ok(AgentToolResult {
            content: json!({"context":context(env.as_ref()).await?,"insight":insight,"calculationQuality":report_quality()}),
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EventSummaryArgs {
    start_date: Option<String>,
    end_date: Option<String>,
}
pub struct GetEventSpendingSummaries;
#[async_trait::async_trait]
impl AgentTool for GetEventSpendingSummaries {
    fn name(&self) -> &'static str {
        "get_event_spending_summaries"
    }
    fn description(&self) -> &'static str {
        "Read native per-event Spending totals, categories and daily breakdowns in base currency. Optional date bounds select events by overlap; all opted-in transactions tagged to visible events contribute, including purchases outside event dates. FX uses the end bound or now. Inspect calculationQuality; unavailable FX is excluded by the native service."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","additionalProperties":false,"properties":{"startDate":{"type":"string","format":"date-time"},"endDate":{"type":"string","format":"date-time"}}})
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
        let args: EventSummaryArgs = serde_json::from_value(args)
            .map_err(|_| AgentToolError::InvalidInput("Invalid event summary arguments".into()))?;
        for value in [&args.start_date, &args.end_date].into_iter().flatten() {
            if DateTime::parse_from_rfc3339(value).is_err() {
                return Err(AgentToolError::InvalidInput(
                    "Date bounds must be RFC3339".into(),
                ));
            }
        }
        if let (Some(start), Some(end)) = (&args.start_date, &args.end_date) {
            validate_window(start, end)?;
        }
        let timezone = timezone(env.as_ref())?;
        let currency = env.base_currency();
        let period = json!({"startDate":args.start_date,"endDate":args.end_date,"timezone":timezone,"currency":currency});
        let summaries = env
            .spending_analytics_service()
            .event_spending_summaries(
                wealthfolio_spending::analytics::EventSummariesRequest {
                    start_date: args.start_date,
                    end_date: args.end_date,
                    currency: Some(currency),
                },
                &timezone,
            )
            .await
            .map_err(|_| {
                AgentToolError::ExecutionFailed("Unable to calculate event summaries".into())
            })?;
        Ok(AgentToolResult {
            content: json!({"context":context(env.as_ref()).await?,"period":period,"summaries":summaries,"calculationQuality":report_quality()}),
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
