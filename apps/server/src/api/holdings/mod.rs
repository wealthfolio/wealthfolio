mod dto;
mod handlers;
mod mappers;

use std::sync::Arc;

use axum::{
    routing::{get, post},
    Router,
};

use crate::main_lib::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/holdings", get(handlers::get_holdings_for_account))
        .route("/holdings/query", post(handlers::get_holdings))
        .route(
            "/holdings/list",
            get(handlers::get_holdings_list_for_account),
        )
        .route("/holdings/list/query", post(handlers::get_holdings_list))
        .route("/holdings/item", get(handlers::get_holding))
        .route("/holdings/by-asset", get(handlers::get_asset_holdings))
        .route("/holdings/lots", get(handlers::get_asset_lots))
        .route(
            "/valuations/history",
            get(handlers::get_historical_valuations),
        )
        .route(
            "/valuations/history/query",
            post(handlers::get_historical_valuations_for_scope),
        )
        .route("/valuations/latest", get(handlers::get_latest_valuations))
        .route(
            "/valuations/current/query",
            post(handlers::get_current_valuation),
        )
        .route("/allocations", get(handlers::get_allocations_for_account))
        .route(
            "/allocations/query",
            post(handlers::get_portfolio_allocations),
        )
        .route(
            "/allocations/holdings",
            get(handlers::get_holdings_by_allocation_for_account),
        )
        .route(
            "/allocations/holdings/query",
            post(handlers::get_holdings_by_allocation),
        )
        .route(
            "/snapshots",
            get(handlers::get_snapshots)
                .post(handlers::save_manual_holdings_handler)
                .delete(handlers::delete_snapshot_handler),
        )
        .route("/snapshots/holdings", get(handlers::get_snapshot_by_date))
        .route(
            "/snapshots/import",
            post(handlers::import_holdings_csv_handler),
        )
        .route(
            "/snapshots/import/check",
            post(handlers::check_holdings_import_handler),
        )
}
