//! Central projector for transactional sync outbox appends.

use diesel::sqlite::SqliteConnection;
use serde_json::Value;
use wealthfolio_core::errors::Result;
use wealthfolio_core::sync::{SyncEntity, SyncOperation};

use super::repository::{insert_outbox_event, OutboxWriteRequest};
use crate::sync::SyncOutboxModel;

/// Captured mutation that can be projected to a sync outbox request at commit-time.
#[derive(Debug, Clone)]
pub(crate) struct ProjectedChange {
    pub entity: SyncEntity,
    pub entity_id: String,
    pub op: SyncOperation,
    pub payload: Value,
}

impl ProjectedChange {
    pub(crate) fn for_model<T: SyncOutboxModel>(model: &T, op: SyncOperation) -> Result<Self> {
        Ok(Self {
            entity: T::ENTITY,
            entity_id: model.sync_entity_id_owned(),
            op,
            payload: serde_json::to_value(model)?,
        })
    }

    pub(crate) fn delete_for_model<T: SyncOutboxModel>(entity_id: impl Into<String>) -> Self {
        let entity_id = entity_id.into();
        Self {
            entity: T::ENTITY,
            entity_id: entity_id.clone(),
            op: SyncOperation::Delete,
            payload: T::delete_payload(&entity_id),
        }
    }

    fn into_outbox_request(self) -> OutboxWriteRequest {
        OutboxWriteRequest::new(self.entity, self.entity_id, self.op, self.payload)
    }
}

pub(crate) fn flush_projected_outbox(
    conn: &mut SqliteConnection,
    requests: Vec<OutboxWriteRequest>,
    projected_changes: Vec<ProjectedChange>,
) -> Result<usize> {
    let mut inserted_count = 0;
    for mut request in requests.into_iter().chain(
        projected_changes
            .into_iter()
            .map(ProjectedChange::into_outbox_request),
    ) {
        // Old clients reject unknown payload columns. Keep the original event
        // readable, and send the complete row separately under a versioned
        // entity they skip. Recurrence and exclusions share the versioned conflict
        // clock so legacy edits cannot suppress settings they do not contain.
        let versioned = if request.entity == SyncEntity::ContributionLimit
            && request.op != SyncOperation::Delete
            && (request.payload.get("isRecurring").is_some()
                || request.payload.get("is_recurring").is_some())
        {
            let mut versioned = request.clone();
            versioned.entity = SyncEntity::ContributionLimitV2;
            versioned.event_id = None;
            if let Some(payload) = request.payload.as_object_mut() {
                payload.remove("isRecurring");
                payload.remove("is_recurring");
                payload.remove("excludedActivityIds");
                payload.remove("excluded_activity_ids");
            }
            Some(versioned)
        } else {
            None
        };
        insert_outbox_event(conn, request)?;
        inserted_count += 1;
        if let Some(mut versioned) = versioned {
            versioned.client_timestamp = chrono::Utc::now().to_rfc3339();
            insert_outbox_event(conn, versioned)?;
            inserted_count += 1;
        }
    }
    Ok(inserted_count)
}
