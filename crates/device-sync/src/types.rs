//! Types for device sync API requests and responses.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// Re-export the canonical SyncEntity from core to avoid duplication.
pub use wealthfolio_core::sync::SyncEntity;

// ─────────────────────────────────────────────────────────────────────────────
// Common Response Types
// ─────────────────────────────────────────────────────────────────────────────

/// API error response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiErrorResponse {
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub details: Option<serde_json::Value>,
}

/// Generic success response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuccessResponse {
    pub success: bool,
}

// ─────────────────────────────────────────────────────────────────────────────
// Device Types
// ─────────────────────────────────────────────────────────────────────────────

/// Platform types for devices.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum DevicePlatform {
    #[serde(rename = "ios")]
    Ios,
    #[serde(rename = "android")]
    Android,
    #[serde(rename = "mac", alias = "macos")]
    Mac,
    #[serde(rename = "windows")]
    Windows,
    #[serde(rename = "linux")]
    Linux,
    #[serde(rename = "web", alias = "server")]
    Web,
}

impl std::fmt::Display for DevicePlatform {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DevicePlatform::Ios => write!(f, "ios"),
            DevicePlatform::Android => write!(f, "android"),
            DevicePlatform::Mac => write!(f, "mac"),
            DevicePlatform::Windows => write!(f, "windows"),
            DevicePlatform::Linux => write!(f, "linux"),
            DevicePlatform::Web => write!(f, "web"),
        }
    }
}

impl DevicePlatform {
    /// Detect the current platform from the runtime environment.
    /// Uses compile-time detection via target_os.
    pub fn detect() -> Self {
        match std::env::consts::OS {
            "macos" => DevicePlatform::Mac,
            "windows" => DevicePlatform::Windows,
            "linux" => DevicePlatform::Linux,
            "ios" => DevicePlatform::Ios,
            "android" => DevicePlatform::Android,
            _ => DevicePlatform::Web,
        }
    }
}

/// Trust state for devices.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TrustState {
    Untrusted,
    Trusted,
    Revoked,
}

/// Request to register/enroll a new device.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterDeviceRequest {
    /// Device nonce (UUID) stored in OS Keychain for idempotent registration.
    /// This uniquely identifies a physical device and won't transfer with DB backup/restore.
    pub device_nonce: String,
    /// Display name of the device
    pub display_name: String,
    /// Platform identifier (ios, android, mac, windows, linux, web)
    pub platform: String,
    /// OS version (e.g., "14.5", "10.0.19041")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os_version: Option<String>,
    /// App version (e.g., "3.0.0")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_version: Option<String>,
}

/// Summary of a trusted device (used in PAIR mode response).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedDeviceSummary {
    /// Device ID
    pub id: String,
    /// Display name
    pub name: String,
    /// Platform identifier
    pub platform: String,
    /// Last seen timestamp
    #[serde(alias = "last_seen_at")]
    pub last_seen_at: Option<String>,
}

/// Response from device enrollment - discriminated union based on mode.
///
/// The server returns different responses depending on the device's enrollment state:
/// - BOOTSTRAP: First device for this team, generate RK locally
/// - PAIR: E2EE already enabled, device must pair with existing trusted device
/// - READY: Device is already trusted and ready to sync
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EnrollDeviceResponse {
    /// First device - generate root key locally and initialize E2EE
    Bootstrap {
        device_id: String,
        e2ee_key_version: i32,
    },
    /// Device must pair with an existing trusted device to receive root key
    Pair {
        device_id: String,
        e2ee_key_version: i32,
        require_sas: bool,
        pairing_ttl_seconds: i32,
        trusted_devices: Vec<TrustedDeviceSummary>,
    },
    /// Device is already trusted and ready to sync
    Ready {
        device_id: String,
        e2ee_key_version: i32,
        trust_state: TrustState,
    },
}

/// Full device information.
/// Uses camelCase for frontend serialization with snake_case aliases for API deserialization.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    /// Unique device ID
    pub id: String,
    /// User ID that owns this device
    #[serde(alias = "user_id")]
    pub user_id: String,
    /// Display name of the device
    #[serde(alias = "display_name")]
    pub display_name: String,
    /// Platform identifier
    pub platform: String,
    /// Device public key (base64 encoded)
    #[serde(alias = "device_public_key")]
    pub device_public_key: Option<String>,
    /// Trust state
    #[serde(alias = "trust_state")]
    pub trust_state: TrustState,
    /// Key version if trusted
    #[serde(alias = "trusted_key_version")]
    pub trusted_key_version: Option<f64>,
    /// OS version
    #[serde(alias = "os_version")]
    pub os_version: Option<String>,
    /// App version
    #[serde(alias = "app_version")]
    pub app_version: Option<String>,
    /// Last time this device was seen
    #[serde(alias = "last_seen_at")]
    pub last_seen_at: Option<String>,
    /// When the device was registered
    #[serde(alias = "created_at")]
    pub created_at: String,
}

/// Request to update a device.
/// Note: Uses snake_case for cloud API serialization.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UpdateDeviceRequest {
    /// New display name (optional)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// Metadata (optional)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, serde_json::Value>>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Team Keys Types (E2EE)
// ─────────────────────────────────────────────────────────────────────────────

/// Response from initializing team keys (Phase 1) - discriminated union based on mode.
///
/// The server returns different responses depending on the team's key state:
/// - BOOTSTRAP: Ready to initialize - challenge/nonce returned for key generation
/// - PAIRING_REQUIRED: Already initialized - device must pair with trusted device
/// - READY: Device already trusted at current key version
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum InitializeKeysResult {
    /// Ready to bootstrap - generate RK locally and call /commit
    Bootstrap {
        challenge: String,
        nonce: String,
        key_version: i32,
    },
    /// E2EE already initialized - device must pair with a trusted device
    PairingRequired {
        e2ee_key_version: i32,
        require_sas: bool,
        pairing_ttl_seconds: i32,
        trusted_devices: Vec<TrustedDeviceSummary>,
    },
    /// Device is already trusted at current key version
    Ready { e2ee_key_version: i32 },
}

/// Request to commit team key initialization (Phase 2).
/// Note: Uses snake_case for cloud API serialization.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitInitializeKeysRequest {
    /// Device ID
    pub device_id: String,
    /// Key version
    pub key_version: i32,
    /// Base64 encoded device key envelope
    pub device_key_envelope: String,
    /// Base64 encoded signature
    pub signature: String,
    /// Base64 encoded challenge response (optional)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub challenge_response: Option<String>,
    /// Base64 encoded recovery envelope (optional)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery_envelope: Option<String>,
}

/// Key state after initialization.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum KeyState {
    Active,
    Pending,
}

/// Response from committing team key initialization.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInitializeKeysResponse {
    pub success: bool,
    #[serde(alias = "key_state")]
    pub key_state: KeyState,
}

/// Response from starting key rotation (Phase 1).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RotateKeysResponse {
    /// Base64 encoded challenge
    pub challenge: String,
    /// Base64 encoded nonce
    pub nonce: String,
    /// New key version
    #[serde(alias = "new_key_version")]
    pub new_key_version: i32,
}

/// Envelope for a device during key rotation.
/// Note: Uses snake_case for cloud API serialization.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceKeyEnvelope {
    /// Device ID
    pub device_id: String,
    /// Base64 encoded device key envelope
    pub device_key_envelope: String,
}

/// Request to commit key rotation (Phase 2).
/// Note: Uses snake_case for cloud API serialization.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitRotateKeysRequest {
    /// New key version
    pub new_key_version: i32,
    /// Envelopes for all devices
    pub envelopes: Vec<DeviceKeyEnvelope>,
    /// Base64 encoded signature
    pub signature: String,
    /// Base64 encoded challenge response (optional)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub challenge_response: Option<String>,
}

/// Response from committing key rotation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRotateKeysResponse {
    pub success: bool,
    #[serde(alias = "key_version")]
    pub key_version: i32,
}

/// Response from resetting team sync.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetTeamSyncResponse {
    pub success: bool,
    #[serde(alias = "key_version")]
    pub key_version: i32,
    #[serde(alias = "reset_at")]
    pub reset_at: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Pairing Types
// ─────────────────────────────────────────────────────────────────────────────

/// Request to create a new pairing session.
/// Note: Uses snake_case for cloud API serialization.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreatePairingRequest {
    /// SHA-256 hash of pairing code (hex, 64 chars)
    pub code_hash: String,
    /// Ephemeral public key (base64 encoded)
    pub ephemeral_public_key: String,
}

/// Response from creating a pairing session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePairingResponse {
    /// Unique pairing ID
    #[serde(alias = "pairing_id")]
    pub pairing_id: String,
    /// When the session expires
    #[serde(alias = "expires_at")]
    pub expires_at: String,
    /// Key version
    #[serde(alias = "key_version")]
    pub key_version: i32,
    /// Whether SAS verification is required
    #[serde(alias = "require_sas")]
    pub require_sas: bool,
}

/// Pairing session status.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PairingStatus {
    Open,
    Claimed,
    Approved,
    Completed,
    Cancelled,
    Expired,
}

/// Response from getting a pairing session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetPairingResponse {
    /// Pairing ID
    #[serde(alias = "pairing_id")]
    pub pairing_id: String,
    /// Session status
    pub status: PairingStatus,
    /// Claimer's device ID (if claimed)
    #[serde(alias = "claimer_device_id")]
    pub claimer_device_id: Option<String>,
    /// Claimer's ephemeral public key (if claimed, base64 encoded)
    #[serde(alias = "claimer_ephemeral_pub")]
    pub claimer_ephemeral_pub: Option<String>,
    /// When the session expires
    #[serde(alias = "expires_at")]
    pub expires_at: String,
}

/// Request to complete a pairing session (issuer side).
/// Note: Uses snake_case for cloud API serialization (matches OpenAPI spec).
/// The claimer's device ID is NOT sent - server knows it from the claim step.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompletePairingRequest {
    /// Base64 encoded encrypted key bundle
    pub encrypted_key_bundle: String,
    /// SAS proof (string or object)
    pub sas_proof: serde_json::Value,
    /// Base64 encoded signature
    pub signature: String,
}

/// Response from completing pairing (issuer side).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletePairingResponse {
    /// Operation succeeded
    pub success: bool,
    /// Whether a remote seed/snapshot already exists for the team
    #[serde(default, alias = "remote_seed_present")]
    pub remote_seed_present: Option<bool>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Claimer-Side Pairing Types
// ─────────────────────────────────────────────────────────────────────────────

/// Request to claim a pairing session (claimer/new device side).
/// Note: Uses snake_case for cloud API serialization.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaimPairingRequest {
    /// Pairing code displayed on the issuer device (plain text, not hash)
    pub code: String,
    /// Claimer's ephemeral public key for key exchange (base64 encoded)
    pub ephemeral_public_key: String,
}

/// Response from claiming a pairing session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimPairingResponse {
    /// Pairing session ID (same as pairing_id)
    #[serde(alias = "session_id")]
    pub session_id: String,
    /// Issuer's X25519 ephemeral public key for deriving shared secret (base64)
    #[serde(alias = "issuer_ephemeral_pub")]
    pub issuer_ephemeral_pub: String,
    /// Current E2EE key version (epoch)
    #[serde(alias = "e2ee_key_version")]
    pub e2ee_key_version: i32,
    /// Whether SAS verification is required
    #[serde(alias = "require_sas")]
    pub require_sas: bool,
    /// Session expiration timestamp
    #[serde(alias = "expires_at")]
    pub expires_at: String,
}

/// Message from issuer to claimer during pairing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingMessage {
    /// Message identifier
    pub id: String,
    /// Type of encrypted payload (e.g., 'rk_transfer_v1' for RK bundle)
    #[serde(alias = "payload_type")]
    pub payload_type: String,
    /// Encrypted payload (base64 encoded)
    pub payload: String,
    /// Message timestamp
    #[serde(alias = "created_at")]
    pub created_at: String,
}

/// Response from polling for messages (claimer side).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingMessagesResponse {
    /// Current session status
    #[serde(alias = "session_status")]
    pub session_status: PairingStatus,
    /// List of encrypted messages in the pairing session
    pub messages: Vec<PairingMessage>,
}

/// Request to confirm pairing and become trusted (claimer side).
/// Note: Uses snake_case for cloud API serialization.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfirmPairingRequest {
    /// Optional HMAC proof that device successfully decrypted the RK bundle
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proof: Option<String>,
}

/// Response from confirming pairing (claimer becomes trusted).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmPairingResponse {
    /// Operation succeeded
    pub success: bool,
    /// E2EE key version the device is now trusted at
    #[serde(alias = "key_version")]
    pub key_version: i32,
    /// Whether a remote seed/snapshot already exists for the team
    #[serde(default, alias = "remote_seed_present")]
    pub remote_seed_present: Option<bool>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync Events + Snapshots
// ─────────────────────────────────────────────────────────────────────────────

/// Event payload pushed to the remote oplog.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncPushEventRequest {
    pub event_id: String,
    pub device_id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub entity: SyncEntity,
    pub entity_id: String,
    pub client_timestamp: String,
    pub payload: String,
    pub payload_key_version: i32,
}

/// Push batch request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncPushRequest {
    pub events: Vec<SyncPushEventRequest>,
}

/// Event accepted/duplicate item returned by push API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncPushResultItem {
    #[serde(alias = "eventId")]
    pub event_id: String,
    pub seq: i64,
}

/// Push batch response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncPushResponse {
    pub accepted: Vec<SyncPushResultItem>,
    pub duplicate: Vec<SyncPushResultItem>,
    #[serde(alias = "serverCursor")]
    pub server_cursor: i64,
}

/// Event item returned by pull API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncEvent {
    #[serde(alias = "eventId")]
    pub event_id: String,
    #[serde(alias = "deviceId")]
    pub device_id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub entity: String,
    #[serde(alias = "entityId")]
    pub entity_id: String,
    #[serde(alias = "clientTimestamp")]
    pub client_timestamp: String,
    pub payload: String,
    #[serde(alias = "payloadKeyVersion")]
    pub payload_key_version: i32,
    pub seq: i64,
    #[serde(alias = "userId")]
    pub user_id: String,
    #[serde(alias = "teamId")]
    pub team_id: String,
    #[serde(alias = "serverTimestamp")]
    pub server_timestamp: String,
}

/// Convert a remote wire entity string into the strict local sync entity enum.
pub fn sync_entity_from_remote(entity: &str) -> Option<SyncEntity> {
    match entity {
        "account" => Some(SyncEntity::Account),
        "asset" => Some(SyncEntity::Asset),
        "quote" => Some(SyncEntity::Quote),
        "asset_taxonomy_assignment" => Some(SyncEntity::AssetTaxonomyAssignment),
        "activity" => Some(SyncEntity::Activity),
        "broker_activity_user_patch" => Some(SyncEntity::BrokerActivityUserPatch),
        "activity_import_profile" => Some(SyncEntity::ActivityImportProfile),
        "import_template" => Some(SyncEntity::ImportTemplate),
        "goal" => Some(SyncEntity::Goal),
        "goal_plan" => Some(SyncEntity::GoalPlan),
        "goals_allocation" => Some(SyncEntity::GoalsAllocation),
        "ai_thread" => Some(SyncEntity::AiThread),
        "ai_message" => Some(SyncEntity::AiMessage),
        "ai_thread_tag" => Some(SyncEntity::AiThreadTag),
        "contribution_limit" => Some(SyncEntity::ContributionLimit),
        "platform" => Some(SyncEntity::Platform),
        "snapshot" => Some(SyncEntity::Snapshot),
        "custom_provider" => Some(SyncEntity::CustomProvider),
        "custom_taxonomy" => Some(SyncEntity::CustomTaxonomy),
        "import_run" => Some(SyncEntity::ImportRun),
        "portfolio" => Some(SyncEntity::Portfolio),
        "portfolio_account" => Some(SyncEntity::PortfolioAccount),
        "allocation_target" => Some(SyncEntity::AllocationTarget),
        "allocation_target_weight" => Some(SyncEntity::AllocationTargetWeight),
        "allocation_target_constraint" => Some(SyncEntity::AllocationTargetConstraint),
        "spending_setting" => Some(SyncEntity::SpendingSetting),
        "activity_taxonomy_assignment" => Some(SyncEntity::ActivityTaxonomyAssignment),
        "spending_activity_split" => Some(SyncEntity::SpendingActivitySplit),
        "spending_activity_event" => Some(SyncEntity::SpendingActivityEvent),
        "spending_categorization_rule" => Some(SyncEntity::SpendingCategorizationRule),
        "spending_preset_rule_deletion" => Some(SyncEntity::SpendingPresetRuleDeletion),
        "spending_event" => Some(SyncEntity::SpendingEvent),
        "spending_event_type" => Some(SyncEntity::SpendingEventType),
        "budget_group" => Some(SyncEntity::BudgetGroup),
        "budget_group_assignment" => Some(SyncEntity::BudgetGroupAssignment),
        "budget_target" => Some(SyncEntity::BudgetTarget),
        "budget_rollover_setting" => Some(SyncEntity::BudgetRolloverSetting),
        "addon_storage" => Some(SyncEntity::AddonStorage),
        _ => None,
    }
}

/// Pull response with pagination and GC/snapshot hints.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncPullResponse {
    pub from: i64,
    pub to: i64,
    #[serde(alias = "nextCursor")]
    pub next_cursor: i64,
    #[serde(alias = "hasMore")]
    pub has_more: bool,
    pub events: Vec<SyncEvent>,
    #[serde(default)]
    pub gc_watermark: Option<i64>,
    #[serde(default)]
    #[serde(alias = "latestSnapshotSeq")]
    pub latest_snapshot_seq: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncLatestSnapshotRef {
    #[serde(alias = "snapshotId")]
    pub snapshot_id: String,
    #[serde(alias = "schemaVersion")]
    pub schema_version: i32,
    #[serde(alias = "oplogSeq")]
    pub oplog_seq: i64,
}

/// Lightweight current cursor response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncCursorResponse {
    pub cursor: i64,
    #[serde(default)]
    #[serde(alias = "gcWatermark")]
    pub gc_watermark: Option<i64>,
    #[serde(default)]
    #[serde(alias = "latestSnapshot")]
    pub latest_snapshot: Option<SyncLatestSnapshotRef>,
}

/// Snapshot metadata for bootstrap download.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotLatestResponse {
    #[serde(alias = "snapshotId")]
    pub snapshot_id: String,
    #[serde(alias = "schemaVersion")]
    pub schema_version: i32,
    #[serde(alias = "coversTables")]
    pub covers_tables: Vec<String>,
    #[serde(alias = "oplogSeq")]
    pub oplog_seq: i64,
    #[serde(alias = "sizeBytes")]
    pub size_bytes: i64,
    pub checksum: String,
    #[serde(alias = "createdAt")]
    pub created_at: String,
}

/// Headers returned with snapshot download blob.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotDownloadHeaders {
    pub schema_version: i32,
    pub covers_tables: Vec<String>,
    pub checksum: String,
}

/// Header metadata required for snapshot upload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotUploadHeaders {
    #[serde(alias = "eventId")]
    pub event_id: Option<String>,
    #[serde(alias = "schemaVersion")]
    pub schema_version: i32,
    #[serde(alias = "coversTables")]
    pub covers_tables: Vec<String>,
    #[serde(alias = "sizeBytes")]
    pub size_bytes: i64,
    pub checksum: String,
    #[serde(alias = "metadataPayload")]
    pub metadata_payload: String,
    #[serde(alias = "payloadKeyVersion")]
    pub payload_key_version: i32,
    /// Oplog seq at which the snapshot was generated.
    #[serde(default, alias = "baseSeq")]
    pub base_seq: Option<i64>,
}

/// Response from the reconcile-ready-state endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReconcileReadyStateResponse {
    /// "NOOP" | "PULL_TAIL" | "BOOTSTRAP_SNAPSHOT" | "WAIT_SNAPSHOT"
    pub action: String,
    #[serde(default)]
    pub cursor: Option<i64>,
    #[serde(default, alias = "latestSnapshot")]
    pub latest_snapshot: Option<SyncLatestSnapshotRef>,
}

/// Snapshot upload response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotUploadResponse {
    #[serde(alias = "snapshotId")]
    pub snapshot_id: String,
    #[serde(alias = "r2Key")]
    pub r2_key: String,
    #[serde(alias = "oplogSeq")]
    pub oplog_seq: i64,
    #[serde(alias = "createdAt")]
    pub created_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pull_response_deserializes_unknown_remote_entity() {
        let json = r#"{
            "from": 10,
            "to": 11,
            "nextCursor": 11,
            "hasMore": false,
            "events": [{
                "eventId": "evt-future-1",
                "deviceId": "device-2",
                "type": "future_entity.create.v1",
                "entity": "future_entity",
                "entityId": "future-1",
                "clientTimestamp": "2026-05-25T00:00:00Z",
                "payload": "not-json",
                "payloadKeyVersion": 1,
                "seq": 11,
                "userId": "user-1",
                "teamId": "team-1",
                "serverTimestamp": "2026-05-25T00:00:01Z"
            }]
        }"#;

        let response: SyncPullResponse =
            serde_json::from_str(json).expect("unknown entities should not break pull parsing");

        assert_eq!(response.events.len(), 1);
        assert_eq!(response.events[0].entity, "future_entity");
        assert_eq!(sync_entity_from_remote(&response.events[0].entity), None);
    }

    #[test]
    fn remote_entity_conversion_accepts_known_entities() {
        assert_eq!(
            sync_entity_from_remote("account"),
            Some(SyncEntity::Account)
        );
        assert_eq!(
            sync_entity_from_remote("budget_rollover_setting"),
            Some(SyncEntity::BudgetRolloverSetting)
        );
        assert_eq!(
            sync_entity_from_remote("allocation_target"),
            Some(SyncEntity::AllocationTarget)
        );
        assert_eq!(
            sync_entity_from_remote("allocation_target_weight"),
            Some(SyncEntity::AllocationTargetWeight)
        );
        assert_eq!(
            sync_entity_from_remote("spending_preset_rule_deletion"),
            Some(SyncEntity::SpendingPresetRuleDeletion)
        );
        assert_eq!(
            sync_entity_from_remote("broker_activity_user_patch"),
            Some(SyncEntity::BrokerActivityUserPatch)
        );
        assert_eq!(
            sync_entity_from_remote("addon_storage"),
            Some(SyncEntity::AddonStorage)
        );
    }
}
