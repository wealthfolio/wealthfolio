use serde_json::Value;
use tokio::sync::broadcast;

/// Canonical event names shared with the desktop (Tauri) runtime.
pub const MARKET_SYNC_START: &str = "market:sync-start";
pub const MARKET_SYNC_COMPLETE: &str = "market:sync-complete";
pub const MARKET_SYNC_ERROR: &str = "market:sync-error";
pub const PORTFOLIO_UPDATE_START: &str = "portfolio:update-start";
pub const PORTFOLIO_UPDATE_COMPLETE: &str = "portfolio:update-complete";
pub const PORTFOLIO_UPDATE_ERROR: &str = "portfolio:update-error";
pub const ASSET_ENRICHMENT_START: &str = "asset:enrichment-start";
pub const ASSET_ENRICHMENT_COMPLETE: &str = "asset:enrichment-complete";
pub const ASSET_CLASSIFICATIONS_CHANGED: &str = "asset:classifications-changed";

pub const ASSET_ENRICHMENT_PROGRESS: &str = "asset:enrichment-progress";
pub const BROKER_SYNC_START: &str = "broker:sync-start";
pub const BROKER_SYNC_COMPLETE: &str = "broker:sync-complete";
pub const BROKER_SYNC_ERROR: &str = "broker:sync-error";

/// Payload published when a market data sync completes.
#[derive(Debug, serde::Serialize)]
pub struct MarketSyncResult {
    pub failed_syncs: Vec<(String, String)>,
    pub skipped_reasons: Vec<(String, String)>,
    pub show_skipped_reasons: bool,
}

/// Serializable envelope that carries event names and optional payloads.
#[derive(Clone, Debug)]
pub struct ServerEvent {
    pub name: &'static str,
    pub payload: Option<Value>,
}

impl ServerEvent {
    pub fn new(name: &'static str) -> Self {
        Self {
            name,
            payload: None,
        }
    }

    pub fn with_payload(name: &'static str, payload: Value) -> Self {
        Self {
            name,
            payload: Some(payload),
        }
    }
}

/// Lightweight broadcast bus that fans out events to any connected clients.
#[derive(Clone)]
pub struct EventBus {
    sender: broadcast::Sender<ServerEvent>,
}

impl EventBus {
    pub fn new(capacity: usize) -> Self {
        let (sender, _receiver) = broadcast::channel(capacity);
        Self { sender }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ServerEvent> {
        self.sender.subscribe()
    }

    pub fn publish(&self, event: ServerEvent) {
        // Lagging listeners are ignored to avoid blocking producers.
        let _ = self.sender.send(event);
    }
}
