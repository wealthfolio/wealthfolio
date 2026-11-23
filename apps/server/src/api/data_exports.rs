use std::sync::Arc;

use axum::{
    body::Body,
    extract::{Path, Query},
    http::{header, Response, StatusCode},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use wealthfolio_core::exports::{
    ExportDatasetSummary, ExportFileFormat, ExportOptions, ExportTarget,
};

use crate::{
    error::{ApiError, ApiResult},
    main_lib::AppState,
};

async fn export_summary_route(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Query(options): Query<ExportOptions>,
) -> ApiResult<Json<Vec<ExportDatasetSummary>>> {
    Ok(Json(state.data_export_service.summary(&options).await?))
}

async fn export_data_route(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Path((data_type, format)): Path<(String, String)>,
    Query(options): Query<ExportOptions>,
) -> ApiResult<Response<Body>> {
    let target = ExportTarget::parse(&data_type)?;
    let format = ExportFileFormat::parse(&format)?;
    let Some(file) = state
        .data_export_service
        .export(target, format, &options)
        .await?
    else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, file.content_type)
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", file.file_name),
        )
        .body(Body::from(file.content))
        .map_err(|e| ApiError::Internal(format!("Failed to build export response: {}", e)))
}

pub fn router<S: Clone + Send + Sync + 'static>() -> Router<S> {
    Router::new()
        .route("/utilities/export/summary", get(export_summary_route))
        .route(
            "/utilities/export/{data_type}/{format}",
            get(export_data_route),
        )
}
