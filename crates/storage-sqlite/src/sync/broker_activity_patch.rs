use diesel::dsl::sql;
use diesel::prelude::*;
use diesel::sql_types::{Bool, Text};
use diesel::sqlite::SqliteConnection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fmt::Write;
use std::sync::Mutex;
use wealthfolio_core::activities::stored_type_override;
use wealthfolio_core::errors::{DatabaseError, Error};
use wealthfolio_core::sync::{should_apply_lww, SyncEntity, SyncOperation};
use wealthfolio_core::Result;

use crate::activities::ActivityDB;
use crate::errors::StorageError;
use crate::schema::{activities, sync_applied_events, sync_entity_metadata};
use crate::sync::app_sync::{SyncAppliedEventDB, SyncEntityMetadataDB};
use crate::sync::OutboxWriteRequest;

const ENTITY_ID_PREFIX: &str = "broker_activity_patch:";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BrokerActivityIdentity {
    pub source_system: String,
    pub provider_account_id: String,
    pub source_record_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrokerActivityUserPatchPayload {
    #[serde(alias = "source_system")]
    pub source_system: String,
    #[serde(alias = "provider_account_id")]
    pub provider_account_id: String,
    #[serde(alias = "source_record_id")]
    pub source_record_id: String,
    pub overlay: BrokerActivityUserOverlay,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrokerActivityUserOverlay {
    pub notes: Option<String>,
    #[serde(default)]
    #[serde(alias = "activity_type_override")]
    pub activity_type_override: Option<String>,
    #[serde(default)]
    pub subtype: Option<String>,
    #[serde(default)]
    #[serde(alias = "needs_review")]
    pub needs_review: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BrokerActivityUserPatchApplyOutcome {
    Applied,
    MissingTarget,
}

#[derive(Debug, Clone)]
struct PendingBrokerActivityUserPatch {
    entity_id: String,
    event_id: String,
    payload: BrokerActivityUserPatchPayload,
    client_timestamp: String,
    seq: i64,
    op: SyncOperation,
}

/// Pending edits for one profile/database, retained across writer recreation.
#[derive(Default)]
pub(crate) struct BrokerActivityPatchQueue(Mutex<HashMap<String, PendingBrokerActivityUserPatch>>);

impl BrokerActivityPatchQueue {
    /// Discard edits when the owning profile is deleted or its database is replaced.
    pub(crate) fn clear(&self) {
        drop(self.take());
    }

    /// Temporarily set edits aside while a replacement database is opened.
    pub(crate) fn take(&self) -> Self {
        let mut pending = self
            .0
            .lock()
            .expect("pending broker activity patch lock poisoned");
        Self(Mutex::new(std::mem::take(&mut *pending)))
    }

    /// Restore the original database's edits after rolling back a replacement.
    /// Call only while its writer is stopped.
    pub(crate) fn restore(&self, previous: Self) {
        *self
            .0
            .lock()
            .expect("pending broker activity patch lock poisoned") = previous
            .0
            .into_inner()
            .expect("pending broker activity patch lock poisoned");
    }
}

pub(crate) fn broker_activity_identity(
    source_system: Option<&str>,
    provider_account_id: Option<&str>,
    source_record_id: Option<&str>,
) -> Option<BrokerActivityIdentity> {
    let source_system = normalize_source_system(source_system?)?;
    if matches!(source_system.as_str(), "MANUAL" | "CSV") {
        return None;
    }

    Some(BrokerActivityIdentity {
        source_system,
        provider_account_id: normalize_required(provider_account_id?)?,
        source_record_id: normalize_required(source_record_id?)?,
    })
}

pub(crate) fn broker_activity_user_patch_entity_id(identity: &BrokerActivityIdentity) -> String {
    let mut hasher = Sha256::new();
    hash_component(&mut hasher, &identity.source_system);
    hash_component(&mut hasher, &identity.provider_account_id);
    hash_component(&mut hasher, &identity.source_record_id);
    let digest = hasher.finalize();
    format!("{ENTITY_ID_PREFIX}{}", hex_prefix(&digest, 32))
}

pub(crate) fn broker_activity_user_patch_request(
    activity: &ActivityDB,
    provider_account_id: Option<&str>,
) -> Result<Option<OutboxWriteRequest>> {
    let Some(identity) = broker_activity_identity(
        activity.source_system.as_deref(),
        provider_account_id,
        activity.source_record_id.as_deref(),
    ) else {
        return Ok(None);
    };

    let payload = BrokerActivityUserPatchPayload {
        source_system: identity.source_system.clone(),
        provider_account_id: identity.provider_account_id.clone(),
        source_record_id: identity.source_record_id.clone(),
        overlay: BrokerActivityUserOverlay {
            notes: activity.notes.clone(),
            activity_type_override: normalize_optional(activity.activity_type_override.as_deref()),
            subtype: normalize_optional(activity.subtype.as_deref()),
            needs_review: activity.needs_review != 0,
        },
    };

    Ok(Some(OutboxWriteRequest::new(
        SyncEntity::BrokerActivityUserPatch,
        broker_activity_user_patch_entity_id(&identity),
        SyncOperation::Update,
        serde_json::to_value(payload)?,
    )))
}

pub(crate) fn broker_activity_user_overlay_changed(
    before: &ActivityDB,
    after: &ActivityDB,
) -> bool {
    before.notes != after.notes
        || normalize_optional(before.activity_type_override.as_deref())
            != normalize_optional(after.activity_type_override.as_deref())
        || normalize_optional(before.subtype.as_deref())
            != normalize_optional(after.subtype.as_deref())
        || before.needs_review != after.needs_review
}

pub(crate) fn parse_broker_activity_user_patch_payload(
    payload: &serde_json::Value,
) -> Result<BrokerActivityUserPatchPayload> {
    let mut parsed = serde_json::from_value::<BrokerActivityUserPatchPayload>(payload.clone())?;
    let Some(identity) = broker_activity_identity(
        Some(&parsed.source_system),
        Some(&parsed.provider_account_id),
        Some(&parsed.source_record_id),
    ) else {
        return Err(Error::Database(DatabaseError::Internal(
            "Invalid broker activity user patch identity".to_string(),
        )));
    };

    parsed.source_system = identity.source_system;
    parsed.provider_account_id = identity.provider_account_id;
    parsed.source_record_id = identity.source_record_id;
    parsed.overlay.activity_type_override =
        stored_type_override(parsed.overlay.activity_type_override.as_deref());
    parsed.overlay.subtype = normalize_optional(parsed.overlay.subtype.as_deref());
    Ok(parsed)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn apply_broker_activity_user_patch_tx(
    conn: &mut SqliteConnection,
    pending: &BrokerActivityPatchQueue,
    entity_id: &str,
    event_id: &str,
    payload_json: &serde_json::Value,
    client_timestamp: &str,
    seq: i64,
    op: SyncOperation,
) -> Result<BrokerActivityUserPatchApplyOutcome> {
    let payload = parse_broker_activity_user_patch_payload(payload_json)?;
    let outcome = apply_broker_activity_user_patch_payload_tx(
        conn,
        entity_id,
        payload.clone(),
        client_timestamp,
    )?;
    if outcome == BrokerActivityUserPatchApplyOutcome::MissingTarget {
        defer_broker_activity_user_patch(
            pending,
            entity_id,
            event_id,
            payload,
            client_timestamp,
            seq,
            op,
        );
    }
    Ok(outcome)
}

pub(crate) fn apply_pending_broker_activity_user_patches_tx(
    conn: &mut SqliteConnection,
    queue: &BrokerActivityPatchQueue,
) -> Result<usize> {
    let pending = {
        let guard = queue
            .0
            .lock()
            .expect("pending broker activity patch lock poisoned");
        guard.values().cloned().collect::<Vec<_>>()
    };

    let mut applied_entity_ids = Vec::new();
    for patch in pending {
        if apply_broker_activity_user_patch_payload_tx(
            conn,
            &patch.entity_id,
            patch.payload.clone(),
            &patch.client_timestamp,
        )? == BrokerActivityUserPatchApplyOutcome::Applied
        {
            record_applied_broker_activity_patch_tx(conn, &patch)?;
            applied_entity_ids.push(patch.entity_id);
        }
    }

    if !applied_entity_ids.is_empty() {
        let mut guard = queue
            .0
            .lock()
            .expect("pending broker activity patch lock poisoned");
        for entity_id in &applied_entity_ids {
            guard.remove(entity_id);
        }
    }

    Ok(applied_entity_ids.len())
}

fn apply_broker_activity_user_patch_payload_tx(
    conn: &mut SqliteConnection,
    entity_id: &str,
    payload: BrokerActivityUserPatchPayload,
    client_timestamp: &str,
) -> Result<BrokerActivityUserPatchApplyOutcome> {
    let identity = broker_activity_identity(
        Some(&payload.source_system),
        Some(&payload.provider_account_id),
        Some(&payload.source_record_id),
    )
    .ok_or_else(|| {
        Error::Database(DatabaseError::Internal(
            "Invalid broker activity user patch identity".to_string(),
        ))
    })?;
    let expected_entity_id = broker_activity_user_patch_entity_id(&identity);
    if expected_entity_id != entity_id {
        return Err(Error::Database(DatabaseError::Internal(format!(
            "Broker activity user patch entity_id '{}' does not match payload identity '{}'",
            entity_id, expected_entity_id
        ))));
    }

    let activity_id = activities::table
        .filter(
            sql::<Bool>("UPPER(TRIM(COALESCE(activities.source_system, ''))) = ")
                .bind::<Text, _>(payload.source_system.clone()),
        )
        .filter(activities::source_record_id.eq(Some(payload.source_record_id.clone())))
        .filter(
            sql::<Bool>(
                "EXISTS (
                    SELECT 1 FROM accounts AS current_accounts
                    WHERE current_accounts.id = activities.account_id
                      AND TRIM(COALESCE(current_accounts.provider_account_id, '')) = ",
            )
            .bind::<Text, _>(payload.provider_account_id.clone())
            .sql(
                "
                ) OR EXISTS (
                    SELECT 1
                    FROM import_runs AS broker_import_runs
                    JOIN accounts AS import_accounts
                      ON import_accounts.id = broker_import_runs.account_id
                    WHERE broker_import_runs.id = activities.import_run_id
                      AND TRIM(COALESCE(import_accounts.provider_account_id, '')) = ",
            )
            .bind::<Text, _>(payload.provider_account_id.clone())
            .sql(")"),
        )
        .select(activities::id)
        .first::<String>(conn)
        .optional()
        .map_err(StorageError::from)?;

    let Some(activity_id) = activity_id else {
        return Ok(BrokerActivityUserPatchApplyOutcome::MissingTarget);
    };

    diesel::update(activities::table.find(activity_id))
        .set((
            activities::notes.eq(payload.overlay.notes),
            activities::activity_type_override.eq(payload.overlay.activity_type_override),
            activities::subtype.eq(payload.overlay.subtype),
            activities::needs_review.eq(if payload.overlay.needs_review { 1 } else { 0 }),
            activities::is_user_modified.eq(1),
            activities::updated_at.eq(client_timestamp),
        ))
        .execute(conn)
        .map_err(StorageError::from)?;

    Ok(BrokerActivityUserPatchApplyOutcome::Applied)
}

fn defer_broker_activity_user_patch(
    queue: &BrokerActivityPatchQueue,
    entity_id: &str,
    event_id: &str,
    payload: BrokerActivityUserPatchPayload,
    client_timestamp: &str,
    seq: i64,
    op: SyncOperation,
) {
    let mut guard = queue
        .0
        .lock()
        .expect("pending broker activity patch lock poisoned");
    let should_replace = guard.get(entity_id).is_none_or(|existing| {
        should_apply_lww(
            &existing.client_timestamp,
            &existing.event_id,
            client_timestamp,
            event_id,
        )
    });
    if !should_replace {
        return;
    }

    guard.insert(
        entity_id.to_string(),
        PendingBrokerActivityUserPatch {
            entity_id: entity_id.to_string(),
            event_id: event_id.to_string(),
            payload,
            client_timestamp: client_timestamp.to_string(),
            seq,
            op,
        },
    );
}

fn record_applied_broker_activity_patch_tx(
    conn: &mut SqliteConnection,
    patch: &PendingBrokerActivityUserPatch,
) -> Result<()> {
    let entity_db = sync_enum_to_db(&SyncEntity::BrokerActivityUserPatch)?;
    let op_db = sync_enum_to_db(&patch.op)?;

    diesel::insert_into(sync_entity_metadata::table)
        .values(SyncEntityMetadataDB {
            entity: entity_db.clone(),
            entity_id: patch.entity_id.clone(),
            last_event_id: patch.event_id.clone(),
            last_client_timestamp: patch.client_timestamp.clone(),
            last_op: op_db.clone(),
            last_seq: patch.seq,
        })
        .on_conflict((
            sync_entity_metadata::entity,
            sync_entity_metadata::entity_id,
        ))
        .do_update()
        .set((
            sync_entity_metadata::last_event_id.eq(patch.event_id.clone()),
            sync_entity_metadata::last_client_timestamp.eq(patch.client_timestamp.clone()),
            sync_entity_metadata::last_op.eq(op_db),
            sync_entity_metadata::last_seq.eq(patch.seq),
        ))
        .execute(conn)
        .map_err(StorageError::from)?;

    diesel::insert_into(sync_applied_events::table)
        .values(SyncAppliedEventDB {
            event_id: patch.event_id.clone(),
            seq: patch.seq,
            entity: entity_db,
            entity_id: patch.entity_id.clone(),
            applied_at: chrono::Utc::now().to_rfc3339(),
        })
        .on_conflict(sync_applied_events::event_id)
        .do_nothing()
        .execute(conn)
        .map_err(StorageError::from)?;

    Ok(())
}

fn sync_enum_to_db<T: serde::Serialize>(value: &T) -> Result<String> {
    Ok(serde_json::to_string(value)?.trim_matches('"').to_string())
}

fn normalize_source_system(value: &str) -> Option<String> {
    normalize_required(value).map(|source| source.to_ascii_uppercase())
}

fn normalize_required(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_optional(value: Option<&str>) -> Option<String> {
    value.and_then(normalize_required)
}

fn hash_component(hasher: &mut Sha256, value: &str) {
    hasher.update(value.len().to_string().as_bytes());
    hasher.update(b":");
    hasher.update(value.as_bytes());
    hasher.update(b";");
}

fn hex_prefix(bytes: &[u8], chars: usize) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut out, "{byte:02x}").expect("hex formatting should not fail");
    }
    out.truncate(chars);
    out
}
