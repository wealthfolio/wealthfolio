use std::{collections::HashMap, sync::Arc, time::Instant};

use crate::{
    error::{ApiError, ApiResult},
    main_lib::AppState,
};
use axum::{
    extract::{Query, State},
    routing::{get, post},
    Json, Router,
};
use wealthfolio_core::{
    accounts::{
        account_supports_portfolio_scope, account_supports_purpose, Account, AccountPurpose,
        AccountServiceTrait, TrackingMode,
    },
    portfolio::{
        income::IncomeSummary,
        performance::{
            calculate_performance_summary_batch_for_accounts, empty_performance_metrics,
            performance_account_ids_from_map, performance_account_tracking_modes_from_map,
            performance_account_types_from_map, performance_tracking_composition,
            sync_performance_summary_quality, unique_account_ids, DataQualityStatus,
            PerformanceResult, PerformanceSummaryBatchScope, PerformanceSummaryProfile,
            SimplePerformanceMetrics, PERFORMANCE_SUMMARY_BATCH_PARALLELISM,
        },
    },
    portfolios::AccountScope,
};

use super::shared::parse_date_optional;

#[derive(serde::Deserialize)]
struct AccountsSimplePerfBody {
    #[serde(rename = "accountIds")]
    account_ids: Option<Vec<String>>,
}

async fn calculate_accounts_simple_performance(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AccountsSimplePerfBody>,
) -> ApiResult<Json<Vec<SimplePerformanceMetrics>>> {
    let ids: Vec<String> = if let Some(ids) = body.account_ids {
        performance_account_ids(&state, &ids)?
    } else {
        state
            .account_service
            .get_active_non_archived_accounts()?
            .into_iter()
            .filter(|account| {
                account_supports_purpose(&account.account_type, AccountPurpose::Performance)
            })
            .map(|account| account.id)
            .collect()
    };
    if ids.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let metrics = state
        .performance_service
        .calculate_accounts_simple_performance(&ids)?;
    Ok(Json(metrics))
}

#[derive(serde::Deserialize)]
struct PerfBody {
    #[serde(rename = "itemType")]
    item_type: String,
    #[serde(rename = "itemId")]
    item_id: String,
    #[serde(rename = "startDate")]
    start_date: Option<String>,
    #[serde(rename = "endDate")]
    end_date: Option<String>,
    #[serde(rename = "trackingMode")]
    tracking_mode: Option<String>,
    filter: Option<AccountScope>,
    profile: Option<PerformanceSummaryProfile>,
}

#[derive(serde::Deserialize)]
struct PerformanceSummaryScopeBody {
    #[serde(rename = "accountIds")]
    account_ids: Vec<String>,
}

#[derive(serde::Deserialize)]
struct PerformanceSummariesBody {
    scopes: Vec<PerformanceSummaryScopeBody>,
    #[serde(rename = "startDate")]
    start_date: Option<String>,
    #[serde(rename = "endDate")]
    end_date: Option<String>,
    profile: Option<PerformanceSummaryProfile>,
}

fn parse_tracking_mode(mode: Option<String>) -> Option<TrackingMode> {
    mode.and_then(|m| match m.as_str() {
        "HOLDINGS" => Some(TrackingMode::Holdings),
        "TRANSACTIONS" => Some(TrackingMode::Transactions),
        _ => None,
    })
}

fn account_ids_for_purpose(
    state: &AppState,
    account_ids: &[String],
    purpose: AccountPurpose,
) -> ApiResult<Vec<String>> {
    Ok(state
        .account_service
        .get_accounts_by_ids(account_ids)?
        .into_iter()
        .filter(|account| account_supports_purpose(&account.account_type, purpose))
        .map(|account| account.id)
        .collect())
}

fn performance_account_ids(
    state: &AppState,
    account_ids: &[String],
) -> Result<Vec<String>, crate::error::ApiError> {
    Ok(state
        .account_service
        .get_accounts_by_ids(account_ids)?
        .into_iter()
        .filter(|account| account_supports_portfolio_scope(account, AccountPurpose::Performance))
        .map(|account| account.id)
        .collect())
}

fn performance_accounts_by_id(
    state: &AppState,
    account_ids: &[String],
) -> Result<HashMap<String, Account>, crate::error::ApiError> {
    Ok(state
        .account_service
        .get_accounts_by_ids(account_ids)?
        .into_iter()
        .map(|account| (account.id.clone(), account))
        .collect())
}

async fn calculate_performance_history(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PerfBody>,
) -> ApiResult<Json<PerformanceResult>> {
    let start = parse_date_optional(body.start_date, "startDate")?;
    let end = parse_date_optional(body.end_date, "endDate")?;
    let tracking_mode = parse_tracking_mode(body.tracking_mode);
    let metrics = if let (true, Some(filter)) = (body.item_type == "account", body.filter.as_ref())
    {
        let base = state.base_currency.read().unwrap().clone();
        let resolved = state
            .portfolio_service
            .resolve_account_scope(filter, &base)
            .map_err(crate::error::ApiError::from)?;
        let accounts_by_id = performance_accounts_by_id(&state, &resolved.account_ids)?;
        let account_ids = performance_account_ids_from_map(&accounts_by_id, &resolved.account_ids);
        if account_ids.is_empty() {
            let mut result = empty_performance_metrics(
                &resolved.scope_id,
                resolved.base_currency.clone(),
                start,
                end,
            );
            if !resolved.account_ids.is_empty() {
                result.data_quality.warnings.push(
                    "Requested accounts were excluded because they are archived or not eligible for performance."
                        .to_string(),
                );
                sync_performance_summary_quality(&mut result);
            }
            return Ok(Json(result));
        }
        let tracking_modes =
            performance_account_tracking_modes_from_map(&accounts_by_id, &account_ids);
        let account_types = performance_account_types_from_map(&accounts_by_id, &account_ids);
        let mut result = state
            .performance_service
            .calculate_performance_history_for_accounts(
                &resolved.scope_id,
                &account_ids,
                &resolved.base_currency,
                &tracking_modes,
                &account_types,
                start,
                end,
            )
            .await?;
        if account_ids.len() != resolved.account_ids.len() {
            result.data_quality.warnings.push(
                "Some requested accounts were excluded because they are archived or not eligible for performance."
                    .to_string(),
            );
            result.data_quality.status = DataQualityStatus::Partial;
            sync_performance_summary_quality(&mut result);
        }
        result
    } else {
        let (authoritative_tracking_mode, authoritative_account_type) =
            if body.item_type == "account" {
                let account = state.account_service.get_account(&body.item_id)?;
                if !account_supports_portfolio_scope(&account, AccountPurpose::Performance) {
                    return Ok(Json(empty_performance_metrics(
                        &body.item_id,
                        account.currency,
                        start,
                        end,
                    )));
                }
                (Some(account.tracking_mode), Some(account.account_type))
            } else {
                (tracking_mode, None)
            };
        state
            .performance_service
            .calculate_performance_history(
                &body.item_type,
                &body.item_id,
                start,
                end,
                authoritative_tracking_mode,
                authoritative_account_type.as_deref(),
            )
            .await?
    };
    Ok(Json(metrics))
}

async fn calculate_performance_summary(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PerfBody>,
) -> ApiResult<Json<PerformanceResult>> {
    let start = parse_date_optional(body.start_date, "startDate")?;
    let end = parse_date_optional(body.end_date, "endDate")?;
    let tracking_mode = parse_tracking_mode(body.tracking_mode);
    let profile = body.profile.unwrap_or_default();
    let summary_start = Instant::now();
    let metrics = if let (true, Some(filter)) = (body.item_type == "account", body.filter.as_ref())
    {
        let base = state.base_currency.read().unwrap().clone();
        let resolved = state
            .portfolio_service
            .resolve_account_scope(filter, &base)
            .map_err(crate::error::ApiError::from)?;
        let accounts_by_id = performance_accounts_by_id(&state, &resolved.account_ids)?;
        let account_ids = performance_account_ids_from_map(&accounts_by_id, &resolved.account_ids);
        if account_ids.is_empty() {
            let mut result = empty_performance_metrics(
                &resolved.scope_id,
                resolved.base_currency.clone(),
                start,
                end,
            );
            if !resolved.account_ids.is_empty() {
                result.data_quality.warnings.push(
                    "Requested accounts were excluded because they are archived or not eligible for performance."
                        .to_string(),
                );
                sync_performance_summary_quality(&mut result);
            }
            return Ok(Json(result));
        }
        let tracking_modes =
            performance_account_tracking_modes_from_map(&accounts_by_id, &account_ids);
        let account_types = performance_account_types_from_map(&accounts_by_id, &account_ids);
        let tracking_composition = performance_tracking_composition(&tracking_modes, &account_ids);
        let performance_service = Arc::clone(&state.performance_service);
        let handle = tokio::runtime::Handle::current();
        let scope_id_for_task = resolved.scope_id.clone();
        let base_for_task = resolved.base_currency.clone();
        let account_ids_for_task = account_ids.clone();
        let tracking_modes_for_task = tracking_modes.clone();
        let account_types_for_task = account_types.clone();
        let mut result = tokio::task::spawn_blocking(move || {
            handle.block_on(async move {
                performance_service
                    .calculate_performance_summary_for_accounts(
                        &scope_id_for_task,
                        &account_ids_for_task,
                        &base_for_task,
                        &tracking_modes_for_task,
                        &account_types_for_task,
                        start,
                        end,
                        profile,
                    )
                    .await
            })
        })
        .await
        .map_err(|e| {
            ApiError::Internal(format!(
                "Failed to join performance summary calculation for {}: {}",
                resolved.scope_id, e
            ))
        })??;
        tracing::debug!(
            item_type = %body.item_type,
            scope_id = %resolved.scope_id,
            ?profile,
            account_count = account_ids.len(),
            tracking_composition = %tracking_composition,
            ?start,
            ?end,
            elapsed_ms = summary_start.elapsed().as_secs_f64() * 1000.0,
            "Performance summary timing"
        );
        if account_ids.len() != resolved.account_ids.len() {
            result.data_quality.warnings.push(
                "Some requested accounts were excluded because they are archived or not eligible for performance."
                    .to_string(),
            );
            result.data_quality.status = DataQualityStatus::Partial;
            sync_performance_summary_quality(&mut result);
        }
        result
    } else {
        let (authoritative_tracking_mode, authoritative_account_type) =
            if body.item_type == "account" {
                let account = state.account_service.get_account(&body.item_id)?;
                if !account_supports_portfolio_scope(&account, AccountPurpose::Performance) {
                    return Ok(Json(empty_performance_metrics(
                        &body.item_id,
                        account.currency,
                        start,
                        end,
                    )));
                }
                (Some(account.tracking_mode), Some(account.account_type))
            } else {
                (tracking_mode, None)
            };
        let result = state
            .performance_service
            .calculate_performance_summary(
                &body.item_type,
                &body.item_id,
                start,
                end,
                authoritative_tracking_mode,
                authoritative_account_type.as_deref(),
                profile,
            )
            .await?;
        tracing::debug!(
            item_type = %body.item_type,
            item_id = %body.item_id,
            ?profile,
            ?authoritative_tracking_mode,
            ?start,
            ?end,
            elapsed_ms = summary_start.elapsed().as_secs_f64() * 1000.0,
            "Performance summary timing"
        );
        result
    };
    Ok(Json(metrics))
}

async fn get_performance_summaries(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PerformanceSummariesBody>,
) -> ApiResult<Json<HashMap<String, PerformanceResult>>> {
    let start = parse_date_optional(body.start_date, "startDate")?;
    let end = parse_date_optional(body.end_date, "endDate")?;
    let base = state.base_currency.read().unwrap().clone();
    let profile = body.profile.unwrap_or_default();
    let requested_account_ids = unique_account_ids(
        body.scopes
            .iter()
            .flat_map(|scope| scope.account_ids.iter().cloned()),
    );
    let accounts_by_id = performance_accounts_by_id(&state, &requested_account_ids)?;
    let batch_scopes = body
        .scopes
        .into_iter()
        .map(|scope| PerformanceSummaryBatchScope {
            account_ids: scope.account_ids,
        })
        .collect();
    let batch = calculate_performance_summary_batch_for_accounts(
        Arc::clone(&state.performance_service),
        batch_scopes,
        accounts_by_id,
        base,
        start,
        end,
        profile,
    )
    .await;

    for timing in &batch.scope_timings {
        if timing.skipped {
            tracing::debug!(
                index = timing.index,
                total = timing.total,
                key = %timing.key,
                ?profile,
                requested_accounts = timing.requested_accounts,
                eligible_accounts = 0,
                tracking_composition = "none",
                skipped = true,
                elapsed_ms = timing.elapsed_ms,
                "Performance summaries scope timing"
            );
        } else if timing.failed {
            tracing::debug!(
                index = timing.index,
                total = timing.total,
                key = %timing.key,
                ?profile,
                requested_accounts = timing.requested_accounts,
                eligible_accounts = timing.eligible_accounts,
                tracking_composition = %timing.tracking_composition,
                failed = true,
                elapsed_ms = timing.elapsed_ms,
                "Performance summaries scope timing"
            );
        } else {
            tracing::debug!(
                index = timing.index,
                total = timing.total,
                key = %timing.key,
                ?profile,
                requested_accounts = timing.requested_accounts,
                eligible_accounts = timing.eligible_accounts,
                tracking_composition = %timing.tracking_composition,
                warnings = timing.warnings,
                elapsed_ms = timing.elapsed_ms,
                "Performance summaries scope timing"
            );
        }
    }

    tracing::debug!(
        ?profile,
        scopes = batch.scope_timings.len(),
        parallelism = PERFORMANCE_SUMMARY_BATCH_PARALLELISM,
        unique_requested_accounts = requested_account_ids.len(),
        result_count = batch.results.len(),
        failed_scopes = batch.failed_scope_count,
        ?start,
        ?end,
        elapsed_ms = batch.elapsed_ms,
        "Performance summaries batch timing"
    );

    Ok(Json(batch.results))
}

#[derive(serde::Deserialize)]
struct IncomeSummaryAccountQuery {
    #[serde(rename = "accountId")]
    account_id: Option<String>,
}

/// GET /income/summary?accountId=... — single-account or all-accounts scope
async fn get_income_summary_for_account(
    State(state): State<Arc<AppState>>,
    Query(q): Query<IncomeSummaryAccountQuery>,
) -> ApiResult<Json<Vec<IncomeSummary>>> {
    let account_ids: Vec<String> = if let Some(id) = q.account_id {
        account_ids_for_purpose(&state, &[id], AccountPurpose::Income)?
    } else {
        state
            .account_service
            .get_active_accounts()?
            .into_iter()
            .filter(|account| {
                account_supports_purpose(&account.account_type, AccountPurpose::Income)
            })
            .map(|account| account.id)
            .collect()
    };
    if account_ids.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let items = state
        .income_service
        .get_income_summary(Some(&account_ids))?;
    Ok(Json(items))
}

#[derive(serde::Deserialize)]
struct IncomeSummaryBody {
    filter: Option<wealthfolio_core::portfolios::AccountScope>,
}

/// POST /income/summary/query — typed scope query (all, portfolio, multi-account)
async fn get_income_summary(
    State(state): State<Arc<AppState>>,
    Json(body): Json<IncomeSummaryBody>,
) -> ApiResult<Json<Vec<IncomeSummary>>> {
    let account_ids: Vec<String> = match &body.filter {
        None => state
            .account_service
            .get_active_accounts()?
            .into_iter()
            .filter(|account| {
                account_supports_purpose(&account.account_type, AccountPurpose::Income)
            })
            .map(|account| account.id)
            .collect(),
        Some(filter) => {
            let base = state.base_currency.read().unwrap().clone();
            let resolved = state
                .portfolio_service
                .resolve_account_scope(filter, &base)
                .map_err(crate::error::ApiError::from)?;
            account_ids_for_purpose(&state, &resolved.account_ids, AccountPurpose::Income)?
        }
    };
    if account_ids.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let items = state
        .income_service
        .get_income_summary(Some(&account_ids))?;
    Ok(Json(items))
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/performance/accounts/simple",
            post(calculate_accounts_simple_performance),
        )
        .route("/performance/history", post(calculate_performance_history))
        .route("/performance/summary", post(calculate_performance_summary))
        .route("/performance/summaries", post(get_performance_summaries))
        .route("/income/summary", get(get_income_summary_for_account))
        .route("/income/summary/query", post(get_income_summary))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDateTime;
    use wealthfolio_core::accounts::account_types;

    fn account(id: &str, account_type: &str) -> Account {
        Account {
            id: id.to_string(),
            name: id.to_string(),
            account_type: account_type.to_string(),
            group: None,
            currency: "USD".to_string(),
            is_default: false,
            is_active: true,
            created_at: NaiveDateTime::default(),
            updated_at: NaiveDateTime::default(),
            platform_id: None,
            account_number: None,
            meta: None,
            provider: None,
            provider_account_id: None,
            is_archived: false,
            tracking_mode: TrackingMode::Transactions,
        }
    }

    #[test]
    fn performance_account_ids_keep_hidden_and_exclude_archived_accounts() {
        let mut hidden = account("hidden", account_types::SECURITIES);
        hidden.is_active = false;
        let mut archived = account("archived", account_types::SECURITIES);
        archived.is_archived = true;
        let accounts_by_id = HashMap::from([
            (
                "active".to_string(),
                account("active", account_types::SECURITIES),
            ),
            ("hidden".to_string(), hidden),
            ("archived".to_string(), archived),
            (
                "card".to_string(),
                account("card", account_types::CREDIT_CARD),
            ),
        ]);

        let ids = performance_account_ids_from_map(
            &accounts_by_id,
            &[
                "hidden".to_string(),
                "archived".to_string(),
                "active".to_string(),
                "card".to_string(),
                "hidden".to_string(),
            ],
        );

        assert_eq!(ids, vec!["hidden", "active"]);
    }
}
