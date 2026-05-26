//! Activity ↔ event tag join table.
//!
//! Sidecar relationship (1:1 by `activity_id` PK) that links an activity to a
//! spending event. Kept outside the core `activities` table so the portfolio
//! schema stays focused on universal fields (account, asset, type, amount,
//! date) and isn't coupled to a spending-domain concept.
//!
//! Mirrors the `activity_taxonomy_assignments` pattern.

pub mod model;
pub mod traits;

pub use model::{ActivityEvent, NewActivityEvent};
pub use traits::ActivityEventsRepositoryTrait;
