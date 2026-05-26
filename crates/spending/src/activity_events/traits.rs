use std::collections::HashMap;

use anyhow::Result;
use async_trait::async_trait;

use super::model::ActivityEvent;

/// Repository for the `activity_events` join table.
///
/// Reads (`list_for_activities`, `list_for_event`) feed analytics / cash-activity
/// services that need to know which activities are tagged to which events.
#[async_trait]
pub trait ActivityEventsRepositoryTrait: Send + Sync {
    /// Returns activity_id → event_id for the requested activity ids.
    /// Untagged activities are absent from the map.
    async fn list_for_activities(&self, ids: &[String]) -> Result<HashMap<String, String>>;

    /// Activity ids currently tagged to a given event.
    async fn list_for_event(&self, event_id: &str) -> Result<Vec<String>>;

    /// Tag or untag an activity with a spending event.
    ///
    /// The tag lives in the `activity_events` join table, not on the core
    /// activity row. Implementations should bump the activity's `updated_at`
    /// in the same transaction so device sync sees both the surrounding
    /// activity edit and the join-row change atomically.
    async fn set_activity_event_tag(
        &self,
        activity_id: &str,
        event_id: Option<String>,
    ) -> Result<()>;

    /// Bulk delete by event id. Used when an event is deleted to untag all
    /// its activities atomically. Returns the number of rows removed.
    async fn delete_by_event(&self, event_id: &str) -> Result<usize>;

    /// Full table read — used by device-sync snapshotting.
    async fn list_all(&self) -> Result<Vec<ActivityEvent>>;
}
