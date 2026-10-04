use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use wealthfolio_core::quotes::MarketSyncMode;

/// Event emitted when core context/services are ready to use.
pub const APP_READY: &str = "app:ready";
pub const DATABASE_STATE_CHANGED: &str = "database-state-changed";

/// Event emitted when the background portfolio recalculation process starts.
pub const PORTFOLIO_UPDATE_START: &str = "portfolio:update-start";

/// Event emitted when the background portfolio recalculation process completes successfully.
pub const PORTFOLIO_UPDATE_COMPLETE: &str = "portfolio:update-complete";

/// Event emitted when the background portfolio recalculation process encounters an error.
pub const PORTFOLIO_UPDATE_ERROR: &str = "portfolio:update-error";

/// Event emitted when the market data sync process starts.
pub const MARKET_SYNC_START: &str = "market:sync-start";

/// Event emitted when the market data sync process completes successfully.
pub const MARKET_SYNC_COMPLETE: &str = "market:sync-complete";

/// Payload for market sync completion event.
#[derive(Serialize)]
pub struct MarketSyncResult {
    /// List of (asset_id, error_message) tuples for failed syncs.
    pub failed_syncs: Vec<(String, String)>,
    /// List of (asset_id, reason) tuples for skipped syncs.
    pub skipped_reasons: Vec<(String, String)>,
    /// Whether the frontend should display skipped reasons to the user.
    pub show_skipped_reasons: bool,
}

/// Event emitted when the market data sync process encounters an error.
pub const MARKET_SYNC_ERROR: &str = "market:sync-error";

/// Event emitted when asset taxonomy assignments change.
pub const ASSET_CLASSIFICATIONS_CHANGED: &str = "asset:classifications-changed";

/// Event emitted when the broker sync process starts.
pub const BROKER_SYNC_START: &str = "broker:sync-start";

/// Event emitted when the broker sync process completes successfully.
pub const BROKER_SYNC_COMPLETE: &str = "broker:sync-complete";

/// Event emitted when the broker sync process fails.
pub const BROKER_SYNC_ERROR: &str = "broker:sync-error";

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
pub struct PortfolioRequestPayload {
    /// Optional list of account IDs. None implies all/total accounts.
    pub account_ids: Option<Vec<String>>,
    /// Controls market data sync behavior for this portfolio job.
    #[serde(default)]
    pub market_sync_mode: MarketSyncMode,
    /// Rebuild from the first activity even when the accounts are fresh
    /// (the user asked for a recalculation).
    #[serde(default)]
    pub force_full: bool,
}

impl PortfolioRequestPayload {
    /// Creates a new builder for PortfolioRequestPayload.
    pub fn builder() -> PortfolioRequestPayloadBuilder {
        PortfolioRequestPayloadBuilder::default()
    }
}

/// Builder for creating PortfolioRequestPayload instances.
#[derive(Default)]
pub struct PortfolioRequestPayloadBuilder {
    account_ids: Option<Vec<String>>,
    market_sync_mode: MarketSyncMode,
    force_full: bool,
}

impl PortfolioRequestPayloadBuilder {
    /// Sets the account IDs for a targeted portfolio job.
    pub fn account_ids(mut self, account_ids: Option<Vec<String>>) -> Self {
        self.account_ids = account_ids;
        self
    }

    /// Sets the market sync mode for this portfolio job.
    pub fn market_sync_mode(mut self, mode: MarketSyncMode) -> Self {
        self.market_sync_mode = mode;
        self
    }

    /// Forces a fold from the first activity (user-requested recalculation).
    pub fn force_full(mut self, force_full: bool) -> Self {
        self.force_full = force_full;
        self
    }

    /// Builds the PortfolioRequestPayload.
    pub fn build(self) -> PortfolioRequestPayload {
        PortfolioRequestPayload {
            account_ids: self.account_ids,
            market_sync_mode: self.market_sync_mode,
            force_full: self.force_full,
        }
    }
}

pub fn emit_portfolio_trigger_update(
    handle: &tauri::AppHandle,
    payload: PortfolioRequestPayload,
    context: &std::sync::Arc<crate::context::ServiceContext>,
) {
    crate::listeners::handle_portfolio_request(handle.clone(), context.clone(), payload, false);
}
pub fn emit_portfolio_trigger_recalculate(
    handle: &tauri::AppHandle,
    payload: PortfolioRequestPayload,
    context: &std::sync::Arc<crate::context::ServiceContext>,
) {
    crate::listeners::handle_portfolio_request(handle.clone(), context.clone(), payload, true);
}

/// Emits the APP_READY event once the ServiceContext has been initialized.
pub fn emit_app_ready(handle: &tauri::AppHandle) {
    handle.emit(APP_READY, &()).unwrap_or_else(|e| {
        log::error!("Failed to emit {} event: {}", APP_READY, e);
    });
}

/// Event emitted when asset enrichment starts.
pub const ASSET_ENRICHMENT_START: &str = "asset:enrichment-start";

/// Event emitted when asset enrichment completes.
pub const ASSET_ENRICHMENT_COMPLETE: &str = "asset:enrichment-complete";

/// Event emitted for asset enrichment progress updates.
pub const ASSET_ENRICHMENT_PROGRESS: &str = "asset:enrichment-progress";

// Note: Broker sync events (start/complete/error) are emitted by the orchestrator
// via TauriProgressReporter in commands/brokers_sync.rs, not by helper functions here.
// The payload format is SyncResult from wealthfolio_connect.

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileEvent<T> {
    pub scope_id: uuid::Uuid,
    pub data: T,
}

pub fn emit_for_profile<T: serde::Serialize + Clone>(
    handle: &tauri::AppHandle,
    context: &crate::context::ServiceContext,
    event: &str,
    payload: T,
) -> tauri::Result<()> {
    let Some(scope_id) = handle
        .state::<crate::profiles::NativeProfiles>()
        .event_scope(context)
    else {
        return Ok(());
    };
    handle.emit(
        event,
        ProfileEvent {
            scope_id,
            data: payload,
        },
    )
}
