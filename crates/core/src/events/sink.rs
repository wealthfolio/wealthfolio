//! Domain event sink trait and implementations.

use std::sync::{Arc, Mutex};

use super::DomainEvent;

/// Trait for receiving domain events.
///
/// Implementations translate domain events into platform-specific actions.
/// Core services emit events through this trait after successful mutations.
///
/// # Design Rules
///
/// - `emit()` must be fast and non-blocking (no network calls, no DB writes)
/// - Implementations should queue events for async processing
/// - Failure to emit must not affect domain operations (best-effort)
pub trait DomainEventSink: Send + Sync {
    /// Emit a single domain event.
    fn emit(&self, event: DomainEvent);

    /// Emit multiple domain events.
    ///
    /// Default implementation calls `emit()` for each event.
    /// Implementations may override for batch optimization.
    fn emit_batch(&self, events: Vec<DomainEvent>) {
        for event in events {
            self.emit(event);
        }
    }
}

/// No-op implementation for tests or contexts that don't need events.
#[derive(Clone, Default)]
pub struct NoOpDomainEventSink;

impl DomainEventSink for NoOpDomainEventSink {
    fn emit(&self, _event: DomainEvent) {
        // Intentionally empty - events are discarded
    }
}

/// Mock sink for testing - collects emitted events.
#[derive(Clone, Default)]
pub struct MockDomainEventSink {
    events: Arc<Mutex<Vec<DomainEvent>>>,
}

impl MockDomainEventSink {
    pub fn new() -> Self {
        Self {
            events: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Returns all collected events.
    pub fn events(&self) -> Vec<DomainEvent> {
        self.events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Clears collected events.
    pub fn clear(&self) {
        self.events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }

    /// Returns the number of collected events.
    pub fn len(&self) -> usize {
        self.events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len()
    }

    /// Returns true if no events have been collected.
    pub fn is_empty(&self) -> bool {
        self.events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_empty()
    }
}

impl DomainEventSink for MockDomainEventSink {
    fn emit(&self, event: DomainEvent) {
        self.events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_noop_sink_does_not_panic() {
        let sink = NoOpDomainEventSink;
        sink.emit(DomainEvent::assets_created(vec!["AAPL".to_string()]));
        sink.emit_batch(vec![
            DomainEvent::assets_created(vec!["MSFT".to_string()]),
            DomainEvent::assets_created(vec!["GOOG".to_string()]),
        ]);
    }

    #[test]
    fn test_mock_sink_collects_events() {
        let sink = MockDomainEventSink::new();
        assert!(sink.is_empty());

        sink.emit(DomainEvent::assets_created(vec!["AAPL".to_string()]));
        assert_eq!(sink.len(), 1);

        sink.emit_batch(vec![
            DomainEvent::assets_created(vec!["MSFT".to_string()]),
            DomainEvent::assets_created(vec!["GOOG".to_string()]),
        ]);
        assert_eq!(sink.len(), 3);

        let events = sink.events();
        assert_eq!(events.len(), 3);

        sink.clear();
        assert!(sink.is_empty());
    }
}
