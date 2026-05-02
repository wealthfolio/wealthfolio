//! Tauri domain event sink implementation.
//!
//! Implements DomainEventSink by sending events to an mpsc channel
//! for async processing by the queue worker.

use std::sync::Arc;

use log::{error, info};
use tauri::AppHandle;
use tokio::sync::mpsc;
use wealthfolio_core::events::{DomainEvent, DomainEventSink};

use super::queue_worker::event_queue_worker;
use crate::context::ServiceContext;

/// Tauri implementation of the domain event sink.
///
/// Events are sent to an unbounded mpsc channel for processing by a background
/// worker task. This ensures `emit()` is fast and non-blocking.
pub struct TauriDomainEventSink {
    sender: mpsc::UnboundedSender<DomainEvent>,
}

impl TauriDomainEventSink {
    /// Creates a new TauriDomainEventSink with only the sender.
    ///
    /// The queue worker must be started separately using `start_queue_worker`
    /// after the ServiceContext is fully initialized.
    pub fn new() -> (Self, mpsc::UnboundedReceiver<DomainEvent>) {
        let (sender, receiver) = mpsc::unbounded_channel();
        info!("TauriDomainEventSink created (worker must be started separately)");
        (Self { sender }, receiver)
    }

    /// Starts the queue worker with the receiver, app handle, and context.
    ///
    /// This should be called after ServiceContext is fully initialized and
    /// the AppHandle is available.
    pub fn start_queue_worker(
        receiver: mpsc::UnboundedReceiver<DomainEvent>,
        app_handle: AppHandle,
        context: Arc<ServiceContext>,
    ) {
        tokio::spawn(event_queue_worker(receiver, app_handle, context));
        info!("TauriDomainEventSink queue worker started");
    }
}

impl Default for TauriDomainEventSink {
    fn default() -> Self {
        let (sink, _receiver) = Self::new();
        // Note: receiver is dropped here, so events won't be processed
        // This is only for trait compatibility; real usage should use new()
        sink
    }
}

impl DomainEventSink for TauriDomainEventSink {
    fn emit(&self, event: DomainEvent) {
        if let Err(e) = self.sender.send(event) {
            error!("Failed to send domain event to queue: {}", e);
        }
    }

    fn emit_batch(&self, events: Vec<DomainEvent>) {
        for event in events {
            if let Err(e) = self.sender.send(event) {
                error!("Failed to send domain event to queue: {}", e);
                // Continue trying to send remaining events
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_returns_sender_and_receiver() {
        let (sink, mut receiver) = TauriDomainEventSink::new();

        let event = DomainEvent::AssetsCreated {
            asset_ids: vec!["AAPL".to_string()],
        };

        sink.emit(event);

        // Check that event was sent
        let received = receiver.try_recv();
        assert!(received.is_ok());

        match received.unwrap() {
            DomainEvent::AssetsCreated { asset_ids } => {
                assert_eq!(asset_ids, vec!["AAPL".to_string()]);
            }
            _ => panic!("Expected AssetsCreated event"),
        }
    }

    #[test]
    fn test_emit_batch_sends_all_events() {
        let (sink, mut receiver) = TauriDomainEventSink::new();

        let events = vec![
            DomainEvent::AssetsCreated {
                asset_ids: vec!["AAPL".to_string()],
            },
            DomainEvent::AssetsCreated {
                asset_ids: vec!["MSFT".to_string()],
            },
        ];

        sink.emit_batch(events);

        // Check that both events were sent
        assert!(receiver.try_recv().is_ok());
        assert!(receiver.try_recv().is_ok());
        assert!(receiver.try_recv().is_err()); // No more events
    }
}
