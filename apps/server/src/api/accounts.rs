use std::sync::Arc;

use crate::{
    error::ApiResult,
    main_lib::AppState,
    models::{Account, AccountUpdate, NewAccount},
};
use axum::{
    extract::{Path, Query},
    http::StatusCode,
    routing::{get, put},
    Json, Router,
};
use serde::Deserialize;
use wealthfolio_core::accounts::AccountServiceTrait;
use wealthfolio_core::activities::ActivityServiceTrait;

async fn credit_card_statements(
    Path(id): Path<String>,
    axum::Extension(state): axum::Extension<Arc<AppState>>,
) -> ApiResult<Json<Vec<wealthfolio_core::accounts::CreditCardStatement>>> {
    Ok(Json(
        state
            .activity_service
            .get_credit_card_statements(&id)
            .await?,
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListAccountsQuery {
    include_archived: Option<bool>,
}

#[utoipa::path(get, path="/api/v1/accounts", responses((status=200, body = [Account])))]
async fn list_accounts(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Query(query): Query<ListAccountsQuery>,
) -> ApiResult<Json<Vec<Account>>> {
    let include_archived = query.include_archived.unwrap_or(false);
    let accounts = if include_archived {
        state.account_service.get_all_accounts()?
    } else {
        state.account_service.get_non_archived_accounts()?
    };
    Ok(Json(accounts.into_iter().map(Account::from).collect()))
}

#[utoipa::path(post, path="/api/v1/accounts", request_body = NewAccount, responses((status=200, body = Account)))]
async fn create_account(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Json(payload): Json<NewAccount>,
) -> ApiResult<Json<Account>> {
    // A supplied broker link must not race replacement of its Connect identity.
    let _connect = (payload.provider.is_some() || payload.provider_account_id.is_some())
        .then(|| crate::profiles::connect_guard(&state))
        .transpose()
        .map_err(crate::error::ApiError::Forbidden)?;
    let core_new = payload.into();
    let created = state.account_service.create_account(core_new).await?;
    // Domain events handle portfolio recalculation
    Ok(Json(Account::from(created)))
}

#[utoipa::path(put, path="/api/v1/accounts/{id}", request_body = AccountUpdate, responses((status=200, body=Account)))]
async fn update_account(
    Path(id): Path<String>,
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Json(mut payload): Json<AccountUpdate>,
) -> ApiResult<Json<Account>> {
    payload.id = Some(id);
    let updated = state.account_service.update_account(payload.into()).await?;
    // Domain events handle portfolio recalculation
    Ok(Json(Account::from(updated)))
}

#[utoipa::path(delete, path="/api/v1/accounts/{id}", responses((status=204)))]
async fn delete_account(
    Path(id): Path<String>,
    axum::Extension(state): axum::Extension<Arc<AppState>>,
) -> ApiResult<StatusCode> {
    state.account_service.delete_account(&id).await?;
    // Domain events handle portfolio recalculation
    Ok(StatusCode::NO_CONTENT)
}

pub fn router<S: Clone + Send + Sync + 'static>() -> Router<S> {
    Router::new()
        .route("/accounts/{id}/statements", get(credit_card_statements))
        .route("/accounts", get(list_accounts).post(create_account))
        .route("/accounts/{id}", put(update_account).delete(delete_account))
}
