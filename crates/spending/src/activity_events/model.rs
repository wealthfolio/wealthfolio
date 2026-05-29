use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};

/// A persisted activity↔event tag. 1:1 by `activity_id` (the PK).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEvent {
    pub activity_id: String,
    pub event_id: String,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

/// Insert/upsert payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewActivityEvent {
    pub activity_id: String,
    pub event_id: String,
}
