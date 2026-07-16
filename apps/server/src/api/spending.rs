use std::sync::Arc;

use axum::{
    extract::{Path, Query, RawQuery, State},
    routing::{delete, get, post, put},
    Json, Router,
};
use serde::Deserialize;

use crate::{
    error::{ApiError, ApiResult},
    main_lib::AppState,
};
use wealthfolio_core::activities::Activity;
use wealthfolio_spending::activity_assignments::ActivityTaxonomyAssignment;
use wealthfolio_spending::activity_splits::{ActivitySplit, NewActivitySplit};
use wealthfolio_spending::analytics::{
    EventSpendingSummary, EventSummariesRequest, MonthlyReport, ReportRequest,
};
use wealthfolio_spending::budget::{
    BudgetSnapshot, NewBudgetGroup, NewBudgetRolloverSetting, NewBudgetTarget, UpdateBudgetGroup,
};
use wealthfolio_spending::cash_activities::{
    CashActivity, CashActivityFilter, CashActivitySearchRequest, CashActivitySearchResponse,
};
use wealthfolio_spending::categorization_rules::{
    CategorizationRule, CategorizationRulesService, NewCategorizationRule, UpdateCategorizationRule,
};
use wealthfolio_spending::events::{Event, EventType, NewEvent, NewEventType, UpdateEvent};
use wealthfolio_spending::insight::{SpendingInsight, SpendingInsightRequest};
use wealthfolio_spending::settings::{SpendingSettings, SpendingSettingsUpdate};

const MAX_BULK_CATEGORY_ASSIGNMENTS: usize = 1_000;

async fn get_spending_settings(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<SpendingSettings>> {
    let s = state.spending_settings_service.get().await?;
    Ok(Json(s))
}

async fn update_spending_settings(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SpendingSettingsUpdate>,
) -> ApiResult<Json<SpendingSettings>> {
    let (before, after) = state
        .spending_settings_service
        .update_with_previous(payload)
        .await?;

    // Newly-added accounts need a first-time categorize. Toggling `enabled`
    // false → true unfreezes the existing opted-in list, so we re-scan all
    // of it (rerun_all with only_uncategorized=true is idempotent).
    let just_enabled = !before.enabled && after.enabled;
    let to_categorize: Vec<String> = if just_enabled {
        after.account_ids.clone()
    } else if after.enabled {
        let before_set: std::collections::HashSet<&String> = before.account_ids.iter().collect();
        after
            .account_ids
            .iter()
            .filter(|id| !before_set.contains(id))
            .cloned()
            .collect()
    } else {
        Vec::new()
    };
    spawn_auto_categorize(state.categorization_rules_service.clone(), to_categorize);
    Ok(Json(after))
}

/// Fire-and-forget auto-categorize for direct (user-initiated) triggers.
/// See the Tauri counterpart in `apps/tauri/src/commands/spending.rs` for the
/// design rationale.
fn spawn_auto_categorize(rules_service: Arc<CategorizationRulesService>, account_ids: Vec<String>) {
    if account_ids.is_empty() {
        return;
    }
    tokio::spawn(async move {
        match rules_service
            .rerun_all(&account_ids, /* only_uncategorized */ true)
            .await
        {
            Ok(count) if count > 0 => {
                tracing::info!("Auto-categorization wrote {} assignment(s)", count);
            }
            Ok(_) => {}
            Err(e) => tracing::warn!("Auto-categorization failed: {}", e),
        }
    });
}

async fn spawn_auto_categorize_for_opted_in_accounts(state: &Arc<AppState>) {
    let settings = match state.spending_settings_service.get().await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(
                "Skipping auto-categorization after rule change: failed to load spending settings: {}",
                e
            );
            return;
        }
    };
    if !settings.enabled {
        return;
    }
    spawn_auto_categorize(
        state.categorization_rules_service.clone(),
        settings.account_ids,
    );
}

async fn spending_enabled(state: &Arc<AppState>) -> ApiResult<bool> {
    Ok(state.spending_settings_service.get().await?.enabled)
}

async fn list_cash_activities(
    State(state): State<Arc<AppState>>,
    RawQuery(raw_query): RawQuery,
) -> ApiResult<Json<Vec<CashActivity>>> {
    if !spending_enabled(&state).await? {
        return Ok(Json(Vec::new()));
    }
    let filter = parse_cash_activity_filter(raw_query)?;
    let activities = state.cash_activity_service.list(filter).await?;
    Ok(Json(activities))
}

fn parse_cash_activity_filter(raw_query: Option<String>) -> ApiResult<CashActivityFilter> {
    let Some(qs) = raw_query else {
        return Ok(CashActivityFilter::default());
    };

    let mut filter = CashActivityFilter::default();
    let pairs = serde_urlencoded::from_str::<Vec<(String, String)>>(&qs)
        .map_err(|e| ApiError::BadRequest(format!("Invalid cash activity query: {e}")))?;

    let mut account_ids = Vec::new();
    let mut activity_types = Vec::new();
    for (key, value) in pairs {
        match key.as_str() {
            "accountIds" | "accountIds[]" => account_ids.push(value),
            "activityTypes" | "activityTypes[]" => activity_types.push(value),
            "startDate" => filter.start_date = Some(value),
            "endDate" => filter.end_date = Some(value),
            _ => {}
        }
    }
    if !account_ids.is_empty() {
        filter.account_ids = Some(account_ids);
    }
    if !activity_types.is_empty() {
        filter.activity_types = Some(activity_types);
    }
    Ok(filter)
}

async fn search_cash_activities(
    State(state): State<Arc<AppState>>,
    Json(request): Json<CashActivitySearchRequest>,
) -> ApiResult<Json<CashActivitySearchResponse>> {
    if !spending_enabled(&state).await? {
        return Ok(Json(CashActivitySearchResponse {
            items: Vec::new(),
            total_count: 0,
        }));
    }
    let response = state.cash_activity_service.search(request).await?;
    Ok(Json(response))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetEventBody {
    event_id: Option<String>,
}

async fn set_activity_event(
    State(state): State<Arc<AppState>>,
    Path(activity_id): Path<String>,
    Json(body): Json<SetEventBody>,
) -> ApiResult<Json<Activity>> {
    let activity = state
        .cash_activity_service
        .set_event(&activity_id, body.event_id)
        .await?;
    Ok(Json(activity))
}

async fn get_activity_assignments(
    State(state): State<Arc<AppState>>,
    Path(activity_id): Path<String>,
) -> ApiResult<Json<Vec<ActivityTaxonomyAssignment>>> {
    let rows = state
        .cash_activity_service
        .list_assignments(&activity_id)
        .await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssignBody {
    taxonomy_id: String,
    category_id: String,
}

async fn assign_activity_category(
    State(state): State<Arc<AppState>>,
    Path(activity_id): Path<String>,
    Json(body): Json<AssignBody>,
) -> ApiResult<Json<ActivityTaxonomyAssignment>> {
    let row = state
        .cash_activity_service
        .assign_category(&activity_id, &body.taxonomy_id, &body.category_id)
        .await?;
    Ok(Json(row))
}

async fn unassign_activity_category(
    State(state): State<Arc<AppState>>,
    Path((activity_id, taxonomy_id)): Path<(String, String)>,
) -> ApiResult<()> {
    state
        .cash_activity_service
        .unassign_category(&activity_id, &taxonomy_id)
        .await?;
    Ok(())
}

async fn get_activity_splits(
    State(state): State<Arc<AppState>>,
    Path(activity_id): Path<String>,
) -> ApiResult<Json<Vec<ActivitySplit>>> {
    let rows = state
        .cash_activity_service
        .list_splits(&activity_id)
        .await?;
    Ok(Json(rows))
}

async fn replace_activity_splits(
    State(state): State<Arc<AppState>>,
    Path(activity_id): Path<String>,
    Json(body): Json<Vec<NewActivitySplit>>,
) -> ApiResult<Json<Vec<ActivitySplit>>> {
    let rows = state
        .cash_activity_service
        .replace_splits(&activity_id, body)
        .await?;
    Ok(Json(rows))
}

async fn clear_activity_splits(
    State(state): State<Arc<AppState>>,
    Path(activity_id): Path<String>,
) -> ApiResult<()> {
    state
        .cash_activity_service
        .clear_splits(&activity_id)
        .await?;
    Ok(())
}

async fn bulk_assign_categories(
    State(state): State<Arc<AppState>>,
    Json(items): Json<Vec<wealthfolio_spending::activity_assignments::BulkCategoryAssignment>>,
) -> ApiResult<Json<Vec<ActivityTaxonomyAssignment>>> {
    if items.len() > MAX_BULK_CATEGORY_ASSIGNMENTS {
        return Err(ApiError::BadRequest(format!(
            "At most {MAX_BULK_CATEGORY_ASSIGNMENTS} category assignments can be submitted at once"
        )));
    }
    let result = state
        .cash_activity_service
        .bulk_assign_categories(&items)
        .await?;
    Ok(Json(result))
}

async fn list_categorization_rules(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Vec<CategorizationRule>>> {
    if !spending_enabled(&state).await? {
        return Ok(Json(Vec::new()));
    }
    Ok(Json(state.categorization_rules_service.list().await?))
}

async fn create_categorization_rule(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<NewCategorizationRule>,
) -> ApiResult<Json<CategorizationRule>> {
    let created = state.categorization_rules_service.create(payload).await?;
    spawn_auto_categorize_for_opted_in_accounts(&state).await;
    Ok(Json(created))
}

async fn update_categorization_rule(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<UpdateCategorizationRule>,
) -> ApiResult<Json<CategorizationRule>> {
    let updated = state
        .categorization_rules_service
        .update(&id, payload)
        .await?;
    spawn_auto_categorize_for_opted_in_accounts(&state).await;
    Ok(Json(updated))
}

async fn delete_categorization_rule(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<()> {
    state.categorization_rules_service.delete(&id).await?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RerunRulesBody {
    #[serde(default)]
    only_uncategorized: bool,
}

async fn rerun_categorization_rules(
    State(state): State<Arc<AppState>>,
    Json(body): Json<RerunRulesBody>,
) -> ApiResult<Json<usize>> {
    let s = state.spending_settings_service.get().await?;
    if !s.enabled {
        return Ok(Json(0));
    }
    Ok(Json(
        state
            .categorization_rules_service
            .rerun_all(&s.account_ids, body.only_uncategorized)
            .await?,
    ))
}

async fn list_rule_presets(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Vec<wealthfolio_spending::categorization_rules::RulePresetSummary>>> {
    if !spending_enabled(&state).await? {
        return Ok(Json(Vec::new()));
    }
    Ok(Json(
        state.categorization_rules_service.list_presets().await?,
    ))
}

async fn remove_rule_preset(
    State(state): State<Arc<AppState>>,
    Path(preset_id): Path<String>,
) -> ApiResult<Json<wealthfolio_spending::categorization_rules::RemovePresetResult>> {
    Ok(Json(
        state
            .categorization_rules_service
            .remove_preset(&preset_id)
            .await?,
    ))
}

async fn import_rule_preset(
    State(state): State<Arc<AppState>>,
    Path(preset_id): Path<String>,
) -> ApiResult<Json<wealthfolio_spending::categorization_rules::ImportPresetResult>> {
    let taxonomies = state.taxonomy_service.get_taxonomies_with_categories()?;
    let mut resolver: std::collections::HashMap<String, (String, String)> =
        std::collections::HashMap::new();
    for entry in taxonomies.iter().filter(|t| t.taxonomy.scope == "activity") {
        for cat in &entry.categories {
            resolver.insert(cat.key.clone(), (entry.taxonomy.id.clone(), cat.id.clone()));
        }
    }
    let result = state
        .categorization_rules_service
        .import_preset(&preset_id, &resolver)
        .await?;
    spawn_auto_categorize_for_opted_in_accounts(&state).await;
    Ok(Json(result))
}

async fn list_event_types(State(state): State<Arc<AppState>>) -> ApiResult<Json<Vec<EventType>>> {
    if !spending_enabled(&state).await? {
        return Ok(Json(Vec::new()));
    }
    Ok(Json(state.events_service.list_types().await?))
}

async fn create_event_type(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<NewEventType>,
) -> ApiResult<Json<EventType>> {
    Ok(Json(state.events_service.create_type(payload).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateEventTypeBody {
    #[serde(default)]
    name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_color")]
    color: Option<Option<String>>,
}

/// Distinguish missing field (None) from explicit `null` (Some(None)) so callers
/// can clear the color. Mirrors the Tauri `UpdateEventType.color` semantics.
fn deserialize_optional_color<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

async fn update_event_type(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<UpdateEventTypeBody>,
) -> ApiResult<Json<EventType>> {
    Ok(Json(
        state
            .events_service
            .update_type(&id, body.name, body.color)
            .await?,
    ))
}

async fn delete_event_type(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<()> {
    state.events_service.delete_type(&id).await?;
    Ok(())
}

async fn list_events(State(state): State<Arc<AppState>>) -> ApiResult<Json<Vec<Event>>> {
    if !spending_enabled(&state).await? {
        return Ok(Json(Vec::new()));
    }
    Ok(Json(state.events_service.list_events().await?))
}

async fn create_event(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<NewEvent>,
) -> ApiResult<Json<Event>> {
    Ok(Json(state.events_service.create_event(payload).await?))
}

async fn update_event(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<UpdateEvent>,
) -> ApiResult<Json<Event>> {
    Ok(Json(state.events_service.update_event(&id, payload).await?))
}

async fn delete_event(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> ApiResult<()> {
    state.events_service.delete_event(&id).await?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BudgetQuery {
    period_key: Option<String>,
}

async fn get_budget(
    State(state): State<Arc<AppState>>,
    Query(query): Query<BudgetQuery>,
) -> ApiResult<Json<BudgetSnapshot>> {
    let base = state.base_currency.read().unwrap().clone();
    let timezone = state.timezone.read().unwrap().clone();
    Ok(Json(
        state
            .budget_service
            .get(query.period_key, &base, &timezone)
            .await?,
    ))
}

async fn upsert_budget_target(
    State(state): State<Arc<AppState>>,
    Query(query): Query<BudgetQuery>,
    Json(payload): Json<NewBudgetTarget>,
) -> ApiResult<Json<BudgetSnapshot>> {
    let base = state.base_currency.read().unwrap().clone();
    let timezone = state.timezone.read().unwrap().clone();
    Ok(Json(
        state
            .budget_service
            .upsert_target(payload, query.period_key, &base, &timezone)
            .await?,
    ))
}

async fn delete_budget_target(
    State(state): State<Arc<AppState>>,
    Query(query): Query<BudgetQuery>,
    Path(id): Path<String>,
) -> ApiResult<Json<BudgetSnapshot>> {
    let base = state.base_currency.read().unwrap().clone();
    let timezone = state.timezone.read().unwrap().clone();
    Ok(Json(
        state
            .budget_service
            .delete_target(&id, query.period_key, &base, &timezone)
            .await?,
    ))
}

async fn upsert_budget_rollover_setting(
    State(state): State<Arc<AppState>>,
    Query(query): Query<BudgetQuery>,
    Json(payload): Json<NewBudgetRolloverSetting>,
) -> ApiResult<Json<BudgetSnapshot>> {
    let base = state.base_currency.read().unwrap().clone();
    let timezone = state.timezone.read().unwrap().clone();
    Ok(Json(
        state
            .budget_service
            .upsert_rollover_setting(payload, query.period_key, &base, &timezone)
            .await?,
    ))
}

async fn delete_budget_rollover_setting(
    State(state): State<Arc<AppState>>,
    Query(query): Query<BudgetQuery>,
    Path(id): Path<String>,
) -> ApiResult<Json<BudgetSnapshot>> {
    let base = state.base_currency.read().unwrap().clone();
    let timezone = state.timezone.read().unwrap().clone();
    Ok(Json(
        state
            .budget_service
            .delete_rollover_setting(&id, query.period_key, &base, &timezone)
            .await?,
    ))
}

async fn create_budget_group(
    State(state): State<Arc<AppState>>,
    Query(query): Query<BudgetQuery>,
    Json(payload): Json<NewBudgetGroup>,
) -> ApiResult<Json<BudgetSnapshot>> {
    let base = state.base_currency.read().unwrap().clone();
    let timezone = state.timezone.read().unwrap().clone();
    Ok(Json(
        state
            .budget_service
            .create_group(payload, query.period_key, &base, &timezone)
            .await?,
    ))
}

async fn update_budget_group(
    State(state): State<Arc<AppState>>,
    Query(query): Query<BudgetQuery>,
    Path(id): Path<String>,
    Json(payload): Json<UpdateBudgetGroup>,
) -> ApiResult<Json<BudgetSnapshot>> {
    let base = state.base_currency.read().unwrap().clone();
    let timezone = state.timezone.read().unwrap().clone();
    Ok(Json(
        state
            .budget_service
            .update_group(&id, payload, query.period_key, &base, &timezone)
            .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteBudgetGroupBody {
    reassign_to_group_id: String,
}

async fn delete_budget_group(
    State(state): State<Arc<AppState>>,
    Query(query): Query<BudgetQuery>,
    Path(id): Path<String>,
    Json(payload): Json<DeleteBudgetGroupBody>,
) -> ApiResult<Json<BudgetSnapshot>> {
    let base = state.base_currency.read().unwrap().clone();
    let timezone = state.timezone.read().unwrap().clone();
    Ok(Json(
        state
            .budget_service
            .delete_group(
                &id,
                &payload.reassign_to_group_id,
                query.period_key,
                &base,
                &timezone,
            )
            .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssignCategoryToGroupBody {
    category_id: String,
    group_id: String,
}

async fn assign_category_to_group(
    State(state): State<Arc<AppState>>,
    Query(query): Query<BudgetQuery>,
    Json(payload): Json<AssignCategoryToGroupBody>,
) -> ApiResult<Json<BudgetSnapshot>> {
    let base = state.base_currency.read().unwrap().clone();
    let timezone = state.timezone.read().unwrap().clone();
    Ok(Json(
        state
            .budget_service
            .assign_category_to_group(
                payload.category_id,
                payload.group_id,
                query.period_key,
                &base,
                &timezone,
            )
            .await?,
    ))
}

async fn reset_budget_groups(
    State(state): State<Arc<AppState>>,
    Query(query): Query<BudgetQuery>,
) -> ApiResult<Json<BudgetSnapshot>> {
    let base = state.base_currency.read().unwrap().clone();
    let timezone = state.timezone.read().unwrap().clone();
    Ok(Json(
        state
            .budget_service
            .reset_groups(query.period_key, &base, &timezone)
            .await?,
    ))
}

async fn get_spending_report(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ReportRequest>,
) -> ApiResult<Json<MonthlyReport>> {
    let timezone = state.timezone.read().unwrap().clone();
    let base_currency = state.base_currency.read().unwrap().clone();
    Ok(Json(
        state
            .spending_analytics_service
            .monthly_report(payload, &timezone, &base_currency)
            .await?,
    ))
}

async fn get_spending_insight(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SpendingInsightRequest>,
) -> ApiResult<Json<SpendingInsight>> {
    let currency = state.base_currency.read().unwrap().clone();
    let timezone = state.timezone.read().unwrap().clone();
    Ok(Json(
        state
            .spending_insight_service
            .compute(payload, &currency, &timezone)
            .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CopyBudgetTargetsBody {
    source_period_key: String,
    target_period_key: String,
    #[serde(default)]
    overwrite: bool,
}

async fn copy_budget_targets(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<CopyBudgetTargetsBody>,
) -> ApiResult<Json<BudgetSnapshot>> {
    let base = state.base_currency.read().unwrap().clone();
    let timezone = state.timezone.read().unwrap().clone();
    Ok(Json(
        state
            .budget_service
            .copy_period_targets(
                &payload.source_period_key,
                &payload.target_period_key,
                payload.overwrite,
                &base,
                &timezone,
            )
            .await?,
    ))
}

async fn get_event_spending_summaries(
    State(state): State<Arc<AppState>>,
    Json(request): Json<Option<EventSummariesRequest>>,
) -> ApiResult<Json<Vec<EventSpendingSummary>>> {
    let mut req = request.unwrap_or(EventSummariesRequest {
        start_date: None,
        end_date: None,
        currency: None,
    });
    if req.currency.is_none() {
        req.currency = Some(state.base_currency.read().unwrap().clone());
    }
    let timezone = state.timezone.read().unwrap().clone();
    Ok(Json(
        state
            .spending_analytics_service
            .event_spending_summaries(req, &timezone)
            .await?,
    ))
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/spending/settings", get(get_spending_settings))
        .route("/spending/settings", put(update_spending_settings))
        .route("/spending/cash-activities", get(list_cash_activities))
        .route(
            "/spending/cash-activities/search",
            post(search_cash_activities),
        )
        .route(
            "/spending/cash-activities/{activity_id}/event",
            put(set_activity_event),
        )
        .route(
            "/spending/activities/{activity_id}/assignments",
            get(get_activity_assignments).put(assign_activity_category),
        )
        .route(
            "/spending/activities/{activity_id}/assignments/{taxonomy_id}",
            delete(unassign_activity_category),
        )
        .route(
            "/spending/activities/{activity_id}/splits",
            get(get_activity_splits)
                .put(replace_activity_splits)
                .delete(clear_activity_splits),
        )
        .route("/spending/assignments/bulk", post(bulk_assign_categories))
        .route(
            "/spending/rules",
            get(list_categorization_rules).post(create_categorization_rule),
        )
        .route(
            "/spending/rules/{id}",
            put(update_categorization_rule).delete(delete_categorization_rule),
        )
        .route("/spending/rules/rerun", post(rerun_categorization_rules))
        .route("/spending/rule-presets", get(list_rule_presets))
        .route(
            "/spending/rule-presets/{preset_id}/import",
            post(import_rule_preset),
        )
        .route(
            "/spending/rule-presets/{preset_id}",
            delete(remove_rule_preset),
        )
        .route(
            "/spending/event-types",
            get(list_event_types).post(create_event_type),
        )
        .route(
            "/spending/event-types/{id}",
            put(update_event_type).delete(delete_event_type),
        )
        .route("/spending/events", get(list_events).post(create_event))
        .route(
            "/spending/events/{id}",
            put(update_event).delete(delete_event),
        )
        .route("/spending/budget", get(get_budget))
        .route("/spending/budget/targets", post(upsert_budget_target))
        .route(
            "/spending/budget/targets/{id}",
            delete(delete_budget_target),
        )
        .route(
            "/spending/budget/rollovers",
            post(upsert_budget_rollover_setting),
        )
        .route(
            "/spending/budget/rollovers/{id}",
            delete(delete_budget_rollover_setting),
        )
        .route("/spending/budget/groups", post(create_budget_group))
        .route("/spending/budget/groups/reset", post(reset_budget_groups))
        .route(
            "/spending/budget/groups/{id}",
            put(update_budget_group).delete(delete_budget_group),
        )
        .route(
            "/spending/budget/group-assignments",
            post(assign_category_to_group),
        )
        .route("/spending/budget/copy", post(copy_budget_targets))
        .route("/spending/report", post(get_spending_report))
        .route("/spending/insight", post(get_spending_insight))
        .route(
            "/spending/event-spending-summaries",
            post(get_event_spending_summaries),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cash_activity_array_query_filters() {
        let filter = parse_cash_activity_filter(Some(
            "accountIds[]=acc1&accountIds[]=acc2&activityTypes[]=WITHDRAWAL&activityTypes[]=TAX&startDate=2026-01-01T00%3A00%3A00Z&endDate=2026-01-31T23%3A59%3A59Z"
                .to_string(),
        ))
        .unwrap();

        assert_eq!(
            filter.account_ids,
            Some(vec!["acc1".to_string(), "acc2".to_string()])
        );
        assert_eq!(
            filter.activity_types,
            Some(vec!["WITHDRAWAL".to_string(), "TAX".to_string()])
        );
        assert_eq!(filter.start_date.as_deref(), Some("2026-01-01T00:00:00Z"));
        assert_eq!(filter.end_date.as_deref(), Some("2026-01-31T23:59:59Z"));
    }

    #[test]
    fn parses_cash_activity_repeated_query_filters() {
        let filter = parse_cash_activity_filter(Some(
            "accountIds=acc1&accountIds=acc2&activityTypes=DEPOSIT".to_string(),
        ))
        .unwrap();

        assert_eq!(
            filter.account_ids,
            Some(vec!["acc1".to_string(), "acc2".to_string()])
        );
        assert_eq!(filter.activity_types, Some(vec!["DEPOSIT".to_string()]));
    }
}
