//! Events — date-ranged groupings (trips, holidays). Each event has an event_type.
//! Activities tag into events via `activities.event_id`.

pub mod model;
pub mod service;
pub mod traits;

pub use model::{Event, EventType, EventWithTypeName, NewEvent, NewEventType, UpdateEvent};
pub use service::EventsService;
pub use traits::{EventTypesRepositoryTrait, EventsRepositoryTrait};
