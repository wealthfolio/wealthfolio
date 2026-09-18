//! Device Enroll Service
//!
//! High-level service that orchestrates device enrollment and E2EE setup.
//! Accepts a SecretStore via dependency injection for cross-platform compatibility.

use log::{debug, info, warn};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex;
use tokio::time::{sleep, Duration};

use wealthfolio_core::secrets::{SecretStore, SYNC_IDENTITY_KEY};

use crate::{
    crypto, CommitInitializeKeysRequest, DevicePlatform, DeviceSyncClient, EnrollDeviceResponse,
    InitializeKeysResult, RegisterDeviceRequest, TrustState, TrustedDeviceSummary,
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const RESET_REASON_REINITIALIZE: &str = "reinitialize";

static ENROLL_OPERATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn enroll_operation_lock() -> &'static Mutex<()> {
    ENROLL_OPERATION_LOCK.get_or_init(|| Mutex::new(()))
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/// Sync identity stored in secret store
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncIdentity {
    /// Storage format version (defaults to 0 for old data without version field)
    #[serde(default)]
    pub version: i32,
    pub device_nonce: Option<String>,
    pub device_id: Option<String>,
    pub root_key: Option<String>,
    pub key_version: Option<i32>,
    pub device_secret_key: Option<String>,
    pub device_public_key: Option<String>,
}

/// Current sync state
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SyncState {
    /// No device nonce - never enrolled
    Fresh,
    /// Enrolled but no E2EE keys (needs pairing or bootstrap)
    Registered,
    /// Fully operational with E2EE keys
    Ready,
    /// Local keys out of date
    Stale,
    /// Device was revoked or removed
    Recovery,
    /// Keys exist on server but no trusted devices to pair with
    Orphaned,
}

/// Result from get_sync_state
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStateResult {
    pub state: SyncState,
    pub device_id: Option<String>,
    pub device_name: Option<String>,
    pub key_version: Option<i32>,
    pub server_key_version: Option<i32>,
    pub is_trusted: bool,
    pub trusted_devices: Vec<TrustedDeviceSummary>,
}

/// Result from enable_sync
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnableSyncResult {
    pub device_id: String,
    pub state: SyncState,
    pub key_version: Option<i32>,
    pub server_key_version: Option<i32>,
    pub needs_pairing: bool,
    pub trusted_devices: Vec<TrustedDeviceSummary>,
}

/// Service error
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollServiceError {
    pub code: String,
    pub message: String,
}

enum KeyInitializationOutcome {
    Initialized {
        key_version: i32,
    },
    PairingRequired {
        server_key_version: i32,
        trusted_devices: Vec<TrustedDeviceSummary>,
    },
}

impl std::fmt::Display for EnrollServiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for EnrollServiceError {}

impl From<String> for EnrollServiceError {
    fn from(message: String) -> Self {
        Self {
            code: "SYNC_ERROR".to_string(),
            message,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Device Enroll Service
// ─────────────────────────────────────────────────────────────────────────────

/// Service for managing device enrollment and E2EE setup.
///
/// Uses dependency injection for the secret store, allowing it to work with
/// different backends (keyring on desktop, file-based on web).
pub struct DeviceEnrollService {
    secret_store: Arc<dyn SecretStore>,
    client: DeviceSyncClient,
    device_display_name: String,
    app_version: Option<String>,
}

impl DeviceEnrollService {
    /// Create a new DeviceEnrollService with the given secret store and API base URL.
    pub fn new(
        secret_store: Arc<dyn SecretStore>,
        base_url: &str,
        device_display_name: String,
        app_version: Option<String>,
    ) -> Self {
        Self {
            secret_store,
            client: DeviceSyncClient::new(base_url),
            device_display_name,
            app_version,
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PUBLIC API
    // ═══════════════════════════════════════════════════════════════════════════

    /// Get the current sync state.
    /// Reads from secret store and optionally verifies with server.
    pub async fn get_sync_state(&self, token: &str) -> Result<SyncStateResult, EnrollServiceError> {
        // Read identity from secret store
        let identity = self.read_identity()?;

        // No identity or no nonce = FRESH
        if identity.device_nonce.is_none() {
            return Ok(SyncStateResult {
                state: SyncState::Fresh,
                device_id: None,
                device_name: None,
                key_version: None,
                server_key_version: None,
                is_trusted: false,
                trusted_devices: vec![],
            });
        }

        // Have nonce but no device ID = FRESH (enrollment incomplete)
        let device_id = match &identity.device_id {
            Some(id) => id.clone(),
            None => {
                return Ok(SyncStateResult {
                    state: SyncState::Fresh,
                    device_id: None,
                    device_name: None,
                    key_version: None,
                    server_key_version: None,
                    is_trusted: false,
                    trusted_devices: vec![],
                });
            }
        };

        // Verify device on server
        let device = match self.client.get_device(token, &device_id).await {
            Ok(d) => d,
            Err(e) => {
                // Device not found = RECOVERY
                let err_str = e.to_string();
                if err_str.contains("404") || err_str.contains("not found") {
                    warn!("[DeviceEnrollService] State: RECOVERY (device not found)");
                    return Ok(SyncStateResult {
                        state: SyncState::Recovery,
                        device_id: Some(device_id),
                        device_name: None,
                        key_version: identity.key_version,
                        server_key_version: None,
                        is_trusted: false,
                        trusted_devices: vec![],
                    });
                }
                return Err(format!("Failed to get device: {}", e).into());
            }
        };

        // Check if device was revoked
        if device.trust_state == TrustState::Revoked {
            warn!("[DeviceEnrollService] State: RECOVERY (device revoked)");
            return Ok(SyncStateResult {
                state: SyncState::Recovery,
                device_id: Some(device_id),
                device_name: Some(device.display_name),
                key_version: identity.key_version,
                server_key_version: device.trusted_key_version.map(|v| v as i32),
                is_trusted: false,
                trusted_devices: vec![],
            });
        }

        let server_key_version = device.trusted_key_version.map(|v| v as i32);
        let is_trusted = device.trust_state == TrustState::Trusted;

        // Check E2EE credentials
        let has_root_key = identity.root_key.is_some();
        let has_key_version = identity.key_version.is_some();

        if !has_root_key || !has_key_version {
            // REGISTERED or ORPHANED: local E2EE credentials are incomplete.
            return Ok(self
                .build_registered_or_orphaned_state(
                    token,
                    &device_id,
                    &device.display_name,
                    server_key_version,
                    is_trusted,
                )
                .await);
        }

        if !is_trusted {
            return Ok(self
                .build_registered_or_orphaned_state(
                    token,
                    &device_id,
                    &device.display_name,
                    server_key_version,
                    is_trusted,
                )
                .await);
        }

        // Check key version match
        if let (Some(local_version), Some(server_version)) =
            (identity.key_version, server_key_version)
        {
            if local_version != server_version {
                warn!(
                    "[DeviceEnrollService] State: STALE (version mismatch: local={}, server={})",
                    local_version, server_version
                );
                let trusted_devices = self.get_trusted_devices(token).await;
                return Ok(SyncStateResult {
                    state: SyncState::Stale,
                    device_id: Some(device_id),
                    device_name: Some(device.display_name),
                    key_version: identity.key_version,
                    server_key_version,
                    is_trusted,
                    trusted_devices,
                });
            }
        }

        // All checks passed = READY
        Ok(SyncStateResult {
            state: SyncState::Ready,
            device_id: Some(device_id),
            device_name: Some(device.display_name),
            key_version: identity.key_version,
            server_key_version,
            is_trusted,
            trusted_devices: vec![],
        })
    }

    /// Enable device sync - full flow from FRESH to READY (if bootstrap) or REGISTERED (if pairing needed).
    ///
    /// This does:
    /// 1. Generate device nonce
    /// 2. Enroll device with server
    /// 3. If BOOTSTRAP mode: initialize E2EE keys
    /// 4. Save all credentials to secret store
    pub async fn enable_sync(&self, token: &str) -> Result<EnableSyncResult, EnrollServiceError> {
        let _guard = enroll_operation_lock().lock().await;
        self.enable_sync_inner(token).await
    }

    async fn enable_sync_inner(&self, token: &str) -> Result<EnableSyncResult, EnrollServiceError> {
        info!("[DeviceEnrollService] Enabling sync...");

        let mut existing_identity = self.read_identity()?;
        let device_nonce = self.ensure_device_nonce(&mut existing_identity)?;
        if let Some(result) = self
            .try_resume_existing_sync(token, &existing_identity)
            .await?
        {
            return Ok(result);
        }

        let platform = DevicePlatform::detect().to_string();
        info!(
            "[DeviceEnrollService] Enrolling device: {} ({})",
            self.device_display_name, platform
        );

        let enroll_result = self
            .client
            .enroll_device(
                token,
                RegisterDeviceRequest {
                    device_nonce: device_nonce.clone(),
                    display_name: self.device_display_name.clone(),
                    platform,
                    os_version: None,
                    app_version: self.app_version.clone(),
                },
            )
            .await
            .map_err(|e| format!("Enrollment failed: {}", e))?;

        match enroll_result {
            EnrollDeviceResponse::Bootstrap {
                device_id,
                e2ee_key_version,
            } => {
                info!(
                    "[DeviceEnrollService] Device enrolled: {} (mode: BOOTSTRAP, server_key_version: {:?})",
                    device_id,
                    Some(e2ee_key_version)
                );
                self.save_enrolled_identity(&device_nonce, &device_id)?;
                let outcome = self.initialize_e2ee_keys(token, &device_id).await?;
                Ok(self.enable_result_from_key_init_outcome(device_id, outcome))
            }
            EnrollDeviceResponse::Pair {
                device_id,
                e2ee_key_version,
                trusted_devices,
                ..
            } => {
                info!(
                    "[DeviceEnrollService] Device enrolled: {} (mode: PAIR, server_key_version: {:?})",
                    device_id,
                    Some(e2ee_key_version)
                );
                self.save_enrolled_identity(&device_nonce, &device_id)?;
                if trusted_devices.is_empty() {
                    info!(
                        "[DeviceEnrollService] PAIR mode with no trusted devices - probing key initialization state..."
                    );
                    let outcome = self.initialize_e2ee_keys(token, &device_id).await?;
                    return Ok(self.enable_result_from_key_init_outcome(device_id, outcome));
                }
                Ok(EnableSyncResult {
                    device_id,
                    state: SyncState::Registered,
                    key_version: None,
                    server_key_version: Some(e2ee_key_version),
                    needs_pairing: true,
                    trusted_devices,
                })
            }
            EnrollDeviceResponse::Ready {
                device_id,
                e2ee_key_version,
                ..
            } => {
                info!(
                    "[DeviceEnrollService] Device enrolled: {} (mode: READY, server_key_version: {:?})",
                    device_id,
                    Some(e2ee_key_version)
                );
                self.save_enrolled_identity(&device_nonce, &device_id)?;
                let outcome = self.initialize_e2ee_keys(token, &device_id).await?;
                Ok(self.enable_result_from_key_init_outcome(device_id, outcome))
            }
        }
    }

    /// Clear all sync data and return to FRESH state.
    pub fn clear_sync_data(&self) -> Result<(), EnrollServiceError> {
        info!("[DeviceEnrollService] Clearing sync data...");
        let existing_identity = self.read_identity()?;
        let preserved_nonce = existing_identity.device_nonce;
        self.save_identity(&SyncIdentity {
            version: 2,
            device_nonce: preserved_nonce,
            ..Default::default()
        })?;
        Ok(())
    }

    /// Reinitialize sync - reset server data and enable sync in one operation.
    /// Used when sync is in orphaned state (keys exist but no devices).
    pub async fn reinitialize_sync(
        &self,
        token: &str,
    ) -> Result<EnableSyncResult, EnrollServiceError> {
        let _guard = enroll_operation_lock().lock().await;
        info!("[DeviceEnrollService] Reinitializing sync...");

        let existing_identity = self.read_identity()?;
        let preserved_nonce = existing_identity
            .device_nonce
            .unwrap_or_else(crypto::generate_device_id);
        self.reset_team_sync_checked(token, RESET_REASON_REINITIALIZE)
            .await?;
        self.save_identity(&SyncIdentity {
            version: 2,
            device_nonce: Some(preserved_nonce),
            ..Default::default()
        })?;

        self.enable_sync_inner(token).await
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // INTERNAL: E2EE KEY INITIALIZATION
    // ═══════════════════════════════════════════════════════════════════════════

    async fn initialize_e2ee_keys(
        &self,
        token: &str,
        device_id: &str,
    ) -> Result<KeyInitializationOutcome, EnrollServiceError> {
        // Phase 1: Get challenge from server
        let init_result = self
            .client
            .initialize_team_keys(token, device_id)
            .await
            .map_err(|e| format!("Failed to initialize keys: {}", e))?;

        let (challenge, nonce, key_version) = match init_result {
            InitializeKeysResult::Bootstrap {
                challenge,
                nonce,
                key_version,
            } => (challenge, nonce, key_version),
            InitializeKeysResult::PairingRequired {
                e2ee_key_version,
                trusted_devices,
                ..
            } => {
                return Ok(KeyInitializationOutcome::PairingRequired {
                    server_key_version: e2ee_key_version,
                    trusted_devices,
                });
            }
            InitializeKeysResult::Ready { e2ee_key_version } => {
                // Server reports this device as ready at current key version.
                // If local key material is missing, treat as pairing-required
                // recovery for this client.
                return Ok(KeyInitializationOutcome::PairingRequired {
                    server_key_version: e2ee_key_version,
                    trusted_devices: self.get_trusted_devices(token).await,
                });
            }
        };

        debug!("[DeviceEnrollService] Got challenge, generating keys...");

        // Generate root key
        let root_key = crypto::generate_root_key();

        // Generate device keypair for E2EE
        let device_keypair = crypto::generate_ephemeral_keypair();

        // Create device key envelope (encrypted root key for this device)
        let envelope_key = crypto::derive_session_key(&root_key, "envelope")
            .map_err(|e| format!("Failed to derive envelope key: {}", e))?;
        let device_key_envelope = crypto::encrypt(&envelope_key, &root_key)
            .map_err(|e| format!("Failed to create device key envelope: {}", e))?;

        // HMAC-keyed with root_key for cryptographic binding. The cloud API currently
        // ignores this field, but the signature is ready for server-side enforcement.
        let signature_data = format!("{}:{}:{}", challenge, key_version, device_key_envelope);
        let signature = crypto::hmac_sha256(&root_key, &signature_data)
            .map_err(|e| format!("Failed to compute bootstrap signature: {}", e))?;

        // Create challenge response (raw hash, no normalization)
        let challenge_response_data = format!("{}:{}", challenge, nonce);
        let challenge_response = crypto::hash_sha256(&challenge_response_data);

        debug!("[DeviceEnrollService] Committing keys...");

        // Phase 2: Commit the keys
        let commit_result = self
            .client
            .commit_initialize_team_keys(
                token,
                CommitInitializeKeysRequest {
                    device_id: device_id.to_string(),
                    key_version,
                    device_key_envelope,
                    signature,
                    challenge_response: Some(challenge_response),
                    recovery_envelope: None,
                },
            )
            .await
            .map_err(|e| format!("Failed to commit keys: {}", e))?;

        if !commit_result.success {
            return Err("Server rejected key commitment".to_string().into());
        }

        // Save E2EE credentials to secret store
        let mut identity = self.read_identity()?;
        identity.root_key = Some(root_key);
        identity.key_version = Some(key_version);
        identity.device_secret_key = Some(device_keypair.secret_key);
        identity.device_public_key = Some(device_keypair.public_key);
        self.save_identity(&identity)?;

        info!(
            "[DeviceEnrollService] E2EE keys initialized (version: {})",
            key_version
        );
        Ok(KeyInitializationOutcome::Initialized { key_version })
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // INTERNAL: SECRET STORE OPERATIONS
    // ═══════════════════════════════════════════════════════════════════════════

    fn read_identity(&self) -> Result<SyncIdentity, EnrollServiceError> {
        match self.secret_store.get_secret(SYNC_IDENTITY_KEY) {
            Ok(Some(json)) => {
                debug!("[DeviceEnrollService] Read identity from secret store");
                serde_json::from_str(&json)
                    .map_err(|e| format!("Failed to parse identity: {}", e).into())
            }
            Ok(None) => {
                debug!("[DeviceEnrollService] No identity in secret store");
                Ok(SyncIdentity::default())
            }
            Err(e) => Err(format!("Failed to read identity: {}", e).into()),
        }
    }

    fn save_identity(&self, identity: &SyncIdentity) -> Result<(), EnrollServiceError> {
        let json = serde_json::to_string(identity)
            .map_err(|e| format!("Failed to serialize identity: {}", e))?;
        self.secret_store
            .set_secret(SYNC_IDENTITY_KEY, &json)
            .map_err(|e| format!("Failed to save identity: {}", e).into())
    }

    fn ensure_device_nonce(
        &self,
        identity: &mut SyncIdentity,
    ) -> Result<String, EnrollServiceError> {
        let device_nonce = identity
            .device_nonce
            .clone()
            .unwrap_or_else(crypto::generate_device_id);
        if identity.device_nonce.is_none() {
            identity.version = 2;
            identity.device_nonce = Some(device_nonce.clone());
            self.save_identity(identity)?;
        }
        Ok(device_nonce)
    }

    fn save_enrolled_identity(
        &self,
        device_nonce: &str,
        device_id: &str,
    ) -> Result<(), EnrollServiceError> {
        self.save_identity(&SyncIdentity {
            version: 2,
            device_nonce: Some(device_nonce.to_string()),
            device_id: Some(device_id.to_string()),
            ..Default::default()
        })
    }

    async fn try_resume_existing_sync(
        &self,
        token: &str,
        identity: &SyncIdentity,
    ) -> Result<Option<EnableSyncResult>, EnrollServiceError> {
        if identity.device_id.is_none() {
            return Ok(None);
        }

        let state = self.get_sync_state(token).await?;
        match state.state {
            SyncState::Ready | SyncState::Registered | SyncState::Stale => {
                self.enable_result_from_state(state).map(Some)
            }
            SyncState::Orphaned => Ok(None),
            SyncState::Fresh | SyncState::Recovery => Ok(None),
        }
    }

    async fn build_registered_or_orphaned_state(
        &self,
        token: &str,
        device_id: &str,
        device_name: &str,
        server_key_version: Option<i32>,
        is_trusted: bool,
    ) -> SyncStateResult {
        let trusted_devices = if is_trusted {
            vec![]
        } else {
            self.get_trusted_devices(token).await
        };
        let orphaned = self
            .detect_orphaned_without_trusted_devices(
                token,
                device_id,
                server_key_version,
                is_trusted,
                &trusted_devices,
            )
            .await;
        SyncStateResult {
            state: if orphaned {
                SyncState::Orphaned
            } else {
                SyncState::Registered
            },
            device_id: Some(device_id.to_string()),
            device_name: Some(device_name.to_string()),
            key_version: None,
            server_key_version,
            is_trusted,
            trusted_devices,
        }
    }

    async fn reset_team_sync_checked(
        &self,
        token: &str,
        reason: &str,
    ) -> Result<(), EnrollServiceError> {
        let reset_result = self
            .client
            .reset_team_sync(token, Some(reason))
            .await
            .map_err(|e| format!("Failed to reset team sync: {}", e))?;
        if !reset_result.success {
            return Err(
                "Team sync reset was not accepted. Please verify account permissions and try again."
                    .to_string()
                    .into(),
            );
        }
        sleep(Duration::from_millis(350)).await;
        Ok(())
    }

    async fn get_trusted_devices(&self, token: &str) -> Vec<TrustedDeviceSummary> {
        match self.client.list_devices(token, Some("my")).await {
            Ok(devices) => devices
                .into_iter()
                .filter(|d| d.trust_state == TrustState::Trusted)
                .map(|d| TrustedDeviceSummary {
                    id: d.id,
                    name: d.display_name,
                    platform: d.platform,
                    last_seen_at: d.last_seen_at,
                })
                .collect(),
            Err(_) => vec![],
        }
    }

    async fn detect_orphaned_without_trusted_devices(
        &self,
        token: &str,
        device_id: &str,
        server_key_version: Option<i32>,
        is_trusted: bool,
        trusted_devices: &[TrustedDeviceSummary],
    ) -> bool {
        if is_trusted || !trusted_devices.is_empty() {
            return false;
        }

        let mut orphaned = server_key_version.map(|v| v > 0).unwrap_or(false);
        if orphaned {
            return true;
        }

        // Some server responses omit key version for untrusted devices.
        // In that case, probe key-init state to distinguish REGISTERED vs ORPHANED.
        match self.client.initialize_team_keys(token, device_id).await {
            Ok(InitializeKeysResult::PairingRequired {
                e2ee_key_version,
                trusted_devices: pairing_trusted_devices,
                ..
            }) => {
                orphaned = e2ee_key_version > 0 && pairing_trusted_devices.is_empty();
            }
            Ok(_) => {}
            Err(err) => {
                debug!(
                    "[DeviceEnrollService] initialize_team_keys probe failed while resolving REGISTERED/ORPHANED: {}",
                    err
                );
            }
        }
        orphaned
    }

    fn enable_result_from_state(
        &self,
        state: SyncStateResult,
    ) -> Result<EnableSyncResult, EnrollServiceError> {
        let SyncStateResult {
            state,
            device_id,
            key_version,
            server_key_version,
            trusted_devices,
            ..
        } = state;
        let device_id = device_id.ok_or_else(|| "Missing device ID in sync state".to_string())?;
        let needs_pairing = matches!(state, SyncState::Registered | SyncState::Stale);

        Ok(EnableSyncResult {
            device_id,
            needs_pairing,
            state,
            key_version,
            server_key_version,
            trusted_devices,
        })
    }

    fn enable_result_from_key_init_outcome(
        &self,
        device_id: String,
        outcome: KeyInitializationOutcome,
    ) -> EnableSyncResult {
        match outcome {
            KeyInitializationOutcome::Initialized { key_version } => EnableSyncResult {
                device_id,
                state: SyncState::Ready,
                key_version: Some(key_version),
                server_key_version: Some(key_version),
                needs_pairing: false,
                trusted_devices: vec![],
            },
            KeyInitializationOutcome::PairingRequired {
                server_key_version,
                trusted_devices,
            } => {
                let orphaned = trusted_devices.is_empty() && server_key_version > 0;
                EnableSyncResult {
                    device_id,
                    state: if orphaned {
                        SyncState::Orphaned
                    } else {
                        SyncState::Registered
                    },
                    key_version: None,
                    server_key_version: Some(server_key_version),
                    needs_pairing: !orphaned,
                    trusted_devices,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use wealthfolio_core::secrets::LEGACY_SYNC_DEVICE_ID_KEY;

    #[derive(Default)]
    struct MemorySecrets(std::sync::Mutex<HashMap<String, String>>);

    impl SecretStore for MemorySecrets {
        fn get_secret(&self, key: &str) -> wealthfolio_core::errors::Result<Option<String>> {
            Ok(self.0.lock().unwrap().get(key).cloned())
        }
        fn set_secret(&self, key: &str, value: &str) -> wealthfolio_core::errors::Result<()> {
            self.0.lock().unwrap().insert(key.into(), value.into());
            Ok(())
        }
        fn delete_secret(&self, key: &str) -> wealthfolio_core::errors::Result<()> {
            self.0.lock().unwrap().remove(key);
            Ok(())
        }
    }

    #[tokio::test]
    async fn legacy_only_installations_require_enrollment() {
        let store = Arc::new(MemorySecrets::default());
        store
            .set_secret(LEGACY_SYNC_DEVICE_ID_KEY, "old-device")
            .unwrap();
        let service = DeviceEnrollService::new(store, "http://127.0.0.1:1", "test".into(), None);
        let state = service.get_sync_state("test-token").await.unwrap();
        assert_eq!(state.state, SyncState::Fresh);
        assert!(state.device_id.is_none());
    }
}
