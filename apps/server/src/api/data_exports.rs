use std::sync::Arc;

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, Response, StatusCode},
    response::IntoResponse,
    routing::get,
    Router,
};
use wealthfolio_core::{
    accounts::AccountServiceTrait,
    activities::Sort,
    exports::{
        export_file_name, format_holding_list_records, format_records, ExportDataType,
        ExportFileFormat,
    },
    portfolio::holdings::HoldingListItem,
    portfolios::AccountScope,
};

use crate::{
    api::shared::holdings_account_ids,
    error::{ApiError, ApiResult},
    main_lib::AppState,
};

const EXPORT_ACTIVITY_PAGE_SIZE: i64 = 9_007_199_254_740_991;

async fn build_data_export_content(
    state: &AppState,
    data_type: ExportDataType,
    format: ExportFileFormat,
) -> ApiResult<Option<Vec<u8>>> {
    match data_type {
        ExportDataType::Accounts => {
            let records = state.account_service.get_non_archived_accounts()?;
            Ok(format_records(&records, format)?)
        }
        ExportDataType::Activities => {
            let records = state
                .activity_service
                .search_activities(
                    0,
                    EXPORT_ACTIVITY_PAGE_SIZE,
                    None,
                    None,
                    None,
                    Some(Sort {
                        id: "date".to_string(),
                        desc: true,
                    }),
                    None,
                    None,
                    None,
                    None,
                    None,
                )?
                .data;
            Ok(format_records(&records, format)?)
        }
        ExportDataType::Holdings => {
            let base = state.base_currency.read().unwrap().clone();
            let resolved = state
                .portfolio_service
                .resolve_account_scope(&AccountScope::All, &base)?;
            let account_ids = holdings_account_ids(state, &resolved.account_ids)?;
            if account_ids.is_empty() {
                return Ok(None);
            }

            let holdings = if account_ids.len() == 1 {
                state
                    .holdings_service
                    .get_holdings(&account_ids[0], &base)
                    .await?
            } else {
                state
                    .holdings_service
                    .get_holdings_for_accounts(&account_ids, &base, &resolved.scope_id)
                    .await?
            };
            let records = holdings
                .into_iter()
                .map(HoldingListItem::from)
                .collect::<Vec<_>>();
            Ok(format_holding_list_records(&records, format)?)
        }
        ExportDataType::Goals => {
            let records = state.goal_service.get_goals()?;
            Ok(format_records(&records, format)?)
        }
        ExportDataType::PortfolioHistory => {
            let base = state.base_currency.read().unwrap().clone();
            let resolved = state
                .portfolio_service
                .resolve_account_scope(&AccountScope::All, &base)?;
            let records = state
                .valuation_service
                .get_historical_valuations_for_accounts(
                    &resolved.scope_id,
                    &resolved.account_ids,
                    &resolved.base_currency,
                    None,
                    None,
                )?;
            Ok(format_records(&records, format)?)
        }
    }
}

async fn export_data_route(
    State(state): State<Arc<AppState>>,
    Path((data_type, format)): Path<(String, String)>,
) -> ApiResult<Response<Body>> {
    let data_type = ExportDataType::parse(&data_type)?;
    let format = ExportFileFormat::parse(&format)?;
    let Some(content) = build_data_export_content(&state, data_type, format).await? else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };

    let filename = export_file_name(data_type, format, chrono::Local::now().date_naive());

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, format.content_type())
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", filename),
        )
        .body(Body::from(content))
        .map_err(|e| ApiError::Internal(format!("Failed to build export response: {}", e)))
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route(
        "/utilities/export/{data_type}/{format}",
        get(export_data_route),
    )
}
