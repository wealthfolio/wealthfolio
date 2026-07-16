//! Web domain event sink implementation.
//!
//! Receives domain events and sends them to a background queue worker
//! for debounced processing.

use std::sync::{atomic::AtomicBool, Arc, RwLock};

use tokio::sync::mpsc;
use wealthfolio_connect::{BrokerSyncServiceTrait, TokenLifecycleState};
use wealthfolio_core::{
    assets::AssetServiceTrait,
    events::{DomainEvent, DomainEventSink},
    goals::GoalServiceTrait,
    secrets::SecretStore,
};

use super::queue_worker::{event_queue_worker, QueueWorkerDeps};
use crate::events::EventBus;

/// Domain event sink for the web server runtime.
///
/// Sends events to a background worker that debounces and processes them.
///
/// # Two-Phase Initialization
///
/// Due to circular dependencies (AccountService needs sink, sink needs services
/// that depend on AccountService), this sink uses a two-phase initialization:
///
/// 1. Create the sink with `new()` - this just creates the channel
/// 2. Call `start_worker()` after all services are created - this spawns the worker
pub struct WebDomainEventSink {
    tx: mpsc::UnboundedSender<DomainEvent>,
    rx: std::sync::Mutex<Option<mpsc::UnboundedReceiver<DomainEvent>>>,
}

impl WebDomainEventSink {
    /// Creates a new WebDomainEventSink.
    ///
    /// The sink is immediately ready to receive events, but they will be
    /// buffered until `start_worker()` is called.
    pub fn new() -> Self {
        let (tx, rx) = mpsc::unbounded_channel();

        Self {
            tx,
            rx: std::sync::Mutex::new(Some(rx)),
        }
    }

    /// Starts the background worker that processes events.
    ///
    /// This must be called after all services are created. Events received
    /// before this call are buffered and will be processed once the worker starts.
    ///
    /// # Panics
    /// Panics if called more than once.
    #[allow(clippy::too_many_arguments)]
    pub fn start_worker(
        &self,
        asset_service: Arc<dyn AssetServiceTrait + Send + Sync>,
        connect_sync_service: Arc<dyn BrokerSyncServiceTrait + Send + Sync>,
        event_bus: EventBus,
        broker_sync_running: Arc<AtomicBool>,
        health_service: Arc<dyn wealthfolio_core::health::HealthServiceTrait + Send + Sync>,
        snapshot_service: Arc<
            dyn wealthfolio_core::portfolio::snapshot::SnapshotServiceTrait + Send + Sync,
        >,
        snapshot_repository: Arc<
            dyn wealthfolio_core::portfolio::snapshot::SnapshotRepositoryTrait + Send + Sync,
        >,
        quote_service: Arc<dyn wealthfolio_core::quotes::QuoteServiceTrait + Send + Sync>,
        valuation_service: Arc<
            dyn wealthfolio_core::portfolio::valuation::ValuationServiceTrait + Send + Sync,
        >,
        account_service: Arc<wealthfolio_core::accounts::AccountService>,
        goal_service: Arc<dyn GoalServiceTrait + Send + Sync>,
        fx_service: Arc<dyn wealthfolio_core::fx::FxServiceTrait + Send + Sync>,
        base_currency: Arc<RwLock<String>>,
        timezone: Arc<RwLock<String>>,
        secret_store: Arc<dyn SecretStore>,
        token_lifecycle: Arc<TokenLifecycleState>,
        spending_settings_service: Arc<wealthfolio_spending::settings::SpendingSettingsService>,
        categorization_rules_service: Arc<
            wealthfolio_spending::categorization_rules::CategorizationRulesService,
        >,
    ) {
        let rx = self
            .rx
            .lock()
            .unwrap()
            .take()
            .expect("start_worker() can only be called once");

        let deps = Arc::new(QueueWorkerDeps {
            asset_service,
            connect_sync_service,
            event_bus,
            broker_sync_running,
            health_service,
            snapshot_service,
            snapshot_repository,
            quote_service,
            valuation_service,
            account_service,
            goal_service,
            fx_service,
            base_currency,
            timezone,
            secret_store,
            token_lifecycle,
            spending_settings_service,
            categorization_rules_service,
        });

        // Spawn the background worker
        tokio::spawn(event_queue_worker(rx, deps));
    }

    /// Creates a WebDomainEventSink with just the sender.
    ///
    /// Use this when you want to manually control the worker lifecycle.
    /// The caller is responsible for spawning the worker with the receiver.
    #[cfg(test)]
    pub fn with_sender(tx: mpsc::UnboundedSender<DomainEvent>) -> Self {
        Self {
            tx,
            rx: std::sync::Mutex::new(None),
        }
    }
}

impl Default for WebDomainEventSink {
    fn default() -> Self {
        Self::new()
    }
}

impl DomainEventSink for WebDomainEventSink {
    fn emit(&self, event: DomainEvent) {
        // Send is non-blocking. If the channel is full or closed, we drop the event.
        // This is intentional - domain events are best-effort.
        if let Err(e) = self.tx.send(event) {
            tracing::warn!("Failed to emit domain event: {}", e);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    #[tokio::test]
    async fn test_sink_sends_events() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sink = WebDomainEventSink::with_sender(tx);

        sink.emit(DomainEvent::AssetsCreated {
            asset_ids: vec!["AAPL".to_string()],
        });

        let event = rx.try_recv().unwrap();
        match event {
            DomainEvent::AssetsCreated { asset_ids } => {
                assert_eq!(asset_ids, vec!["AAPL".to_string()]);
            }
            _ => panic!("Expected AssetsCreated event"),
        }

        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn test_sink_batch_sends_all_events() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sink = WebDomainEventSink::with_sender(tx);

        sink.emit_batch(vec![
            DomainEvent::AssetsCreated {
                asset_ids: vec!["AAPL".to_string()],
            },
            DomainEvent::AssetsCreated {
                asset_ids: vec!["MSFT".to_string()],
            },
        ]);

        let event1 = rx.try_recv().unwrap();
        let event2 = rx.try_recv().unwrap();

        assert!(matches!(event1, DomainEvent::AssetsCreated { .. }));
        assert!(matches!(event2, DomainEvent::AssetsCreated { .. }));
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn pull_complete_is_sent_to_queue() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sink = WebDomainEventSink::with_sender(tx);

        sink.emit(DomainEvent::device_sync_pull_complete());

        assert!(matches!(
            rx.try_recv().unwrap(),
            DomainEvent::DeviceSyncPullComplete
        ));
        assert!(rx.try_recv().is_err());
    }
}
