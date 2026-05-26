//! Typed errors for the spending module. Service methods return these wrapped in
//! `anyhow::Result` so the IPC / HTTP layers can `format!("{e}")` and surface a
//! useful message to the frontend.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum SpendingError {
    /// Event type is referenced by one or more events; user must delete the
    /// events first.
    #[error("Cannot delete event type: it is in use by {count} event(s)")]
    EventTypeInUse { count: usize },

    /// `start_date` was after `end_date` on an event create/update.
    #[error("Invalid date range: start_date must be on or before end_date")]
    InvalidEventRange,

    /// A rule was marked global and account-scoped simultaneously.
    #[error("Invalid rule: a global rule cannot also have an account_id")]
    GlobalRuleHasAccount,

    /// User-provided spending input failed validation before persistence.
    #[error("Invalid input: {message}")]
    InvalidInput { message: String },

    /// Requested spending entity does not exist.
    #[error("{entity} not found: {id}")]
    NotFound { entity: &'static str, id: String },
}
