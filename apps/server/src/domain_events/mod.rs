//! Domain events runtime bridge for the web server.
//!
//! Receives domain events via DomainEventSink, debounces them, and triggers:
//! - Portfolio recalculation (market sync + snapshots + valuations)
//! - Asset enrichment for newly created assets
//! - Broker sync for eligible TrackingModeChanged events
//!
//! Events are debounced with a 1-second window and processed directly
//! by the queue worker to ensure proper tracking of in-progress work.

mod planner;
mod queue_worker;
mod sink;

pub use sink::WebDomainEventSink;

#[cfg(test)]
pub(crate) use queue_worker::perform_broker_sync_with_client;
