use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use wealthfolio_core::quotes::MarketSyncMode;

/// Event emitted when core context/services are ready to use.
pub const APP_READY: &str = "app:ready";

/// Event requesting a portfolio update, which may include market data sync and recalculation.
pub const PORTFOLIO_TRIGGER_UPDATE: &str = "portfolio:trigger-update";

/// Event requesting a full portfolio recalculation, including market data sync for specified accounts/asset_ids.
pub const PORTFOLIO_TRIGGER_RECALCULATE: &str = "portfolio:trigger-recalculate";

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
    /// Earliest date affected by the triggering change. When set, recalculation
    /// starts from this date rather than the beginning of account history.
    pub since_date: Option<NaiveDate>,
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
    since_date: Option<NaiveDate>,
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

    /// Sets the earliest affected date for targeted recalculation.
    pub fn since_date(mut self, date: Option<NaiveDate>) -> Self {
        self.since_date = date;
        self
    }

    /// Builds the PortfolioRequestPayload.
    pub fn build(self) -> PortfolioRequestPayload {
        PortfolioRequestPayload {
            account_ids: self.account_ids,
            market_sync_mode: self.market_sync_mode,
            since_date: self.since_date,
        }
    }
}

/// Emits the PORTFOLIO_TRIGGER_UPDATE event for incremental updates.
pub fn emit_portfolio_trigger_update(handle: &tauri::AppHandle, payload: PortfolioRequestPayload) {
    handle
        .emit(PORTFOLIO_TRIGGER_UPDATE, &payload)
        .unwrap_or_else(|e| {
            log::error!(
                "Failed to emit {} event for payload {:?}: {}",
                PORTFOLIO_TRIGGER_UPDATE,
                payload,
                e
            )
        });
}

/// Emits the PORTFOLIO_TRIGGER_RECALCULATE event for full recalculations.
pub fn emit_portfolio_trigger_recalculate(
    handle: &tauri::AppHandle,
    payload: PortfolioRequestPayload,
) {
    handle
        .emit(PORTFOLIO_TRIGGER_RECALCULATE, &payload)
        .unwrap_or_else(|e| {
            log::error!(
                "Failed to emit {} event for payload {:?}: {}",
                PORTFOLIO_TRIGGER_RECALCULATE,
                payload,
                e
            )
        });
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
