//! Web Push notification endpoints. Thin handlers over `crate::web_push`.

use std::sync::Arc;

use axum::{
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};

use crate::{
    error::{ApiError, ApiResult},
    main_lib::AppState,
    web_push::{self, NotificationPayload, PushSubscription, SendReport, WebPushError},
};

impl From<WebPushError> for ApiError {
    fn from(err: WebPushError) -> Self {
        match err {
            WebPushError::Invalid(message) => ApiError::BadRequest(message),
            other => ApiError::Internal(other.to_string()),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicKeyResponse {
    public_key: String,
}

async fn get_public_key(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
) -> ApiResult<Json<PublicKeyResponse>> {
    let public_key = web_push::public_key(state.secret_store.as_ref())?;
    Ok(Json(PublicKeyResponse { public_key }))
}

async fn subscribe(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Json(subscription): Json<PushSubscription>,
) -> ApiResult<StatusCode> {
    web_push::subscribe(state.secret_store.as_ref(), subscription).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct UnsubscribeBody {
    endpoint: String,
}

async fn unsubscribe(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Json(body): Json<UnsubscribeBody>,
) -> ApiResult<StatusCode> {
    web_push::unsubscribe(state.secret_store.as_ref(), &body.endpoint).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn send(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Json(payload): Json<NotificationPayload>,
) -> ApiResult<Json<SendReport>> {
    Ok(Json(
        web_push::send(state.secret_store.as_ref(), &payload).await?,
    ))
}

pub fn router<S: Clone + Send + Sync + 'static>() -> Router<S> {
    Router::new()
        .route("/notifications/push/public-key", get(get_public_key))
        .route("/notifications/push/subscriptions", post(subscribe))
        .route("/notifications/push/unsubscribe", post(unsubscribe))
        .route("/notifications/send", post(send))
}
