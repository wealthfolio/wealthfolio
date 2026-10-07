//! Personal backup API; deliberately does not require a device or sync identity.
use super::*;
use crate::{
    transfer::{ConnectTransferTransport, TransferDescriptor},
    DeviceSyncClient, DeviceSyncError,
};
use reqwest::Method;
use serde_json::json;

type ApiResult<T> = crate::Result<T>;
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPolicy {
    pub user_id: String,
    pub enabled: bool,
    pub source_id: Option<String>,
    pub revision: u32,
    pub team_id: Option<String>,
    pub next_due_at: Option<String>,
    pub last_backup_at: Option<String>,
    #[serde(default)]
    pub read_grace_expires_at: Option<String>,
    #[serde(default)]
    pub upload_entitled: bool,
}
impl BackupPolicy {
    pub fn delay_until_due(&self) -> ApiResult<std::time::Duration> {
        let due = self
            .next_due_at
            .as_deref()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .ok_or_else(|| DeviceSyncError::invalid_request("Invalid backup schedule"))?;
        Ok((due.with_timezone(&chrono::Utc) - chrono::Utc::now())
            .to_std()
            .unwrap_or_default())
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyRecord {
    pub key_id: String,
    pub recovery_envelope: RecoveryEnvelope,
    pub recovery_revision: u32,
    pub trusted_revision: u32,
    #[serde(default)]
    pub created: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPoint {
    pub backup_id: String,
    pub key_id: String,
    pub user_id: String,
    pub source_id: String,
    pub size_bytes: usize,
    pub checksum: String,
    pub format: u32,
    pub published_at: String,
    pub encrypted_metadata: String,
    #[serde(default, skip_deserializing)]
    pub metadata: Option<BackupMetadata>,
}
/// Encrypted metadata schema 1. Empty legacy objects remain valid.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct BackupMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_version: Option<String>,
}
impl BackupMetadata {
    fn bounded(mut self) -> Self {
        for value in [
            &mut self.device_name,
            &mut self.profile_name,
            &mut self.app_version,
        ] {
            *value = value.take().map(|s| s.chars().take(128).collect());
        }
        self
    }
}
fn metadata_aad(ctx: &BackupContext) -> Vec<u8> {
    context(&["metadata", "1", &ctx.user_id, &ctx.key_id, &ctx.backup_id])
}
impl BackupPoint {
    pub fn delay_until_next(&self) -> ApiResult<std::time::Duration> {
        let published = crate::parse_sync_datetime_to_utc(&self.published_at)
            .map_err(|_| DeviceSyncError::invalid_request("Invalid backup schedule"))?;
        Ok(
            (published.with_timezone(&chrono::Utc) + chrono::Duration::hours(24)
                - chrono::Utc::now())
            .to_std()
            .unwrap_or_default(),
        )
    }
}
#[derive(Deserialize)]
struct Prepared {
    ticket: Option<String>,
    transfer: Option<TransferDescriptor>,
    published: Option<BackupPoint>,
}
#[derive(Deserialize)]
struct Download {
    backup: BackupPoint,
    transfer: TransferDescriptor,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Trusted {
    key_id: String,
    revision: u32,
    envelope: Option<TrustedEnvelope>,
}
#[derive(Clone, Debug)]
pub struct BackupClient {
    api: DeviceSyncClient,
    transport: ConnectTransferTransport,
}
/// Ephemeral credentials captured under the runtime's lifecycle lock. Network
/// work uses this immutable material; applying a result requires the same lock.
pub struct BackupAccessMaterial {
    policy: BackupPolicy,
    identity: Option<zeroize::Zeroizing<String>>,
    master: Option<zeroize::Zeroizing<String>>,
    session: Option<zeroize::Zeroizing<String>>,
}
pub struct ResolvedBackupAccess {
    material: BackupAccessMaterial,
    access: BackupAccess,
    key: Option<(String, MasterKey)>,
}
impl ResolvedBackupAccess {
    pub fn apply(self, store: &dyn SecretStore) -> ApiResult<BackupAccess> {
        for (name, expected) in [
            (
                wealthfolio_core::secrets::SYNC_IDENTITY_KEY.to_string(),
                &self.material.identity,
            ),
            (
                format!("{MASTER_KEY_PREFIX}{}", self.material.policy.user_id),
                &self.material.master,
            ),
            (
                wealthfolio_core::secrets::CLOUD_REFRESH_TOKEN_KEY.to_string(),
                &self.material.session,
            ),
        ] {
            let current = store
                .get_secret(&name)
                .map_err(|_| crypto_error(BackupError::SecretStore))?
                .map(zeroize::Zeroizing::new);
            if current != *expected {
                return Err(DeviceSyncError::invalid_request(
                    "Backup access changed during key sharing",
                ));
            }
        }
        if let Some((key_id, master)) = self.key {
            master
                .save_for_key(store, &self.material.policy.user_id, &key_id)
                .map_err(crypto_error)?;
        }
        Ok(self.access)
    }
}
pub struct CaptureMaterial {
    master: MasterKey,
    key_id: String,
    source_id: String,
    policy: BackupPolicy,
}
pub struct EncodedCapture {
    body: serde_json::Value,
    encrypted: Vec<u8>,
}
pub enum CaptureUpload {
    Published(BackupPoint),
    Upload {
        ticket: String,
        descriptor: TransferDescriptor,
        encrypted: Vec<u8>,
    },
}
pub enum CaptureCompletion {
    Published(Box<BackupPoint>),
    Ticket {
        ticket: String,
        upload_error: Option<DeviceSyncError>,
    },
}

pub enum BackupSource {
    Inactive,
    SubscriptionRequired,
    AccessRequired,
    Ready(BackupPolicy),
}
impl BackupSource {
    /// Missing key access needs a lifecycle/user wake. Billing can renew on another
    /// device; one daily eligibility read prevents waiting forever for a local wake.
    pub fn wait_delay(&self) -> Option<std::time::Duration> {
        match self {
            Self::SubscriptionRequired => Some(std::time::Duration::from_secs(24 * 60 * 60)),
            _ => None,
        }
    }
}
impl BackupClient {
    pub fn new(api_url: &str) -> ApiResult<Self> {
        Ok(Self {
            api: DeviceSyncClient::new(api_url),
            transport: ConnectTransferTransport::configured_for_backups()?,
        })
    }
    async fn get<T: serde::de::DeserializeOwned>(&self, token: &str, path: &str) -> ApiResult<T> {
        self.api
            .send_json_no_body(Method::GET, format!("/api/v1/backups{path}"), token, None)
            .await
    }
    async fn send<T: serde::de::DeserializeOwned>(
        &self,
        token: &str,
        method: Method,
        path: &str,
        body: serde_json::Value,
    ) -> ApiResult<T> {
        self.api
            .send_json_body(method, format!("/api/v1/backups{path}"), token, None, &body)
            .await
    }
    pub async fn policy(&self, token: &str) -> ApiResult<BackupPolicy> {
        self.get(token, "/policy").await
    }
    pub async fn history(&self, token: &str) -> ApiResult<Vec<BackupPoint>> {
        self.get(token, "/history").await
    }
    pub async fn key(&self, token: &str) -> ApiResult<Option<KeyRecord>> {
        self.get(token, "/key").await
    }
    pub async fn set_source(
        &self,
        token: &str,
        policy: &BackupPolicy,
        source: Option<&str>,
    ) -> ApiResult<BackupPolicy> {
        self.send(token, Method::PUT, "/policy", json!({ "revision": policy.revision, "enabled": source.is_some(), "source_id": source })).await
    }
    /// Setup cannot enable transmission; UI must confirm recovery-code storage separately.
    pub async fn setup(&self, token: &str, store: &dyn SecretStore) -> ApiResult<String> {
        let policy = self.policy(token).await?;
        if let Some(record) = self.key(token).await? {
            if resolve_pending_master(store, &policy.user_id, &record.key_id)
                .map_err(crypto_error)?
            {
                return self.reissue_code(token, store).await;
            }
            return Err(DeviceSyncError::invalid_request(
                "BACKUP_KEY_ALREADY_EXISTS: Unlock the existing key or reissue its recovery code",
            ));
        }
        let (key_id, master) = pending_master(store, &policy.user_id)
            .map_err(crypto_error)?
            .unwrap_or_else(|| (uuid::Uuid::new_v4().to_string(), MasterKey::generate()));
        // Prove protected local persistence before creating an immutable cloud key.
        stage_master(store, &policy.user_id, &key_id, &master).map_err(crypto_error)?;
        let code = generate_recovery_code();
        let envelope =
            wrap_recovery(&master, &code, &policy.user_id, &key_id).map_err(crypto_error)?;
        let created: KeyRecord = self
            .send(
                token,
                Method::PUT,
                "/key",
                json!({ "key_id": key_id, "recovery_envelope": envelope }),
            )
            .await?;
        let confirmed = resolve_pending_master(store, &policy.user_id, &created.key_id)
            .map_err(crypto_error)?;
        if !confirmed || created.key_id != key_id {
            return Err(DeviceSyncError::invalid_request("BACKUP_SETUP_RACE: Another device created the backup key; use its recovery code or linked-device access"));
        }
        if !created.created {
            // An earlier request can have committed with an older transient code.
            return self.reissue_code(token, store).await;
        }
        Ok(code)
    }
    pub async fn recover_key(
        &self,
        token: &str,
        store: &dyn SecretStore,
        code: &str,
    ) -> ApiResult<()> {
        let policy = self.policy(token).await?;
        let record = self
            .key(token)
            .await?
            .ok_or_else(|| DeviceSyncError::invalid_request("BACKUP_SETUP_REQUIRED"))?;
        let master = unwrap_recovery(
            &record.recovery_envelope,
            code,
            &policy.user_id,
            &record.key_id,
        )
        .map_err(crypto_error)?;
        master
            .save_for_key(store, &policy.user_id, &record.key_id)
            .map_err(crypto_error)
    }
    /// Explicit lifecycle/action step. Status reads never publish an envelope.
    /// Runtime owners serialize this with their existing profile lifecycle lock.
    pub async fn ensure_access(
        &self,
        token: &str,
        store: &dyn SecretStore,
        policy: Option<&BackupPolicy>,
    ) -> ApiResult<BackupAccess> {
        let owned_policy;
        let policy = match policy {
            Some(policy) => policy,
            None => {
                owned_policy = self.policy(token).await?;
                &owned_policy
            }
        };
        self.resolve_access(token, Self::access_material(store, policy)?)
            .await?
            .apply(store)
    }
    pub fn access_material(
        store: &dyn SecretStore,
        policy: &BackupPolicy,
    ) -> ApiResult<BackupAccessMaterial> {
        let read = |name: &str| {
            store
                .get_secret(name)
                .map(|value| value.map(zeroize::Zeroizing::new))
                .map_err(|_| crypto_error(BackupError::SecretStore))
        };
        Ok(BackupAccessMaterial {
            policy: policy.clone(),
            identity: read(wealthfolio_core::secrets::SYNC_IDENTITY_KEY)?,
            master: read(&format!("{MASTER_KEY_PREFIX}{}", policy.user_id))?,
            session: read(wealthfolio_core::secrets::CLOUD_REFRESH_TOKEN_KEY)?,
        })
    }
    pub async fn resolve_access(
        &self,
        token: &str,
        material: BackupAccessMaterial,
    ) -> ApiResult<ResolvedBackupAccess> {
        let policy = &material.policy;
        let identity = material
            .identity
            .as_ref()
            .and_then(|value| serde_json::from_str::<crate::SyncIdentity>(value).ok());
        let local = material
            .master
            .as_ref()
            .map(|value| {
                decode_key(value.split_once(':').map_or(value.as_str(), |(_, key)| key))
                    .map(MasterKey)
            })
            .transpose()
            .map_err(crypto_error)?;
        let Some((identity, team)) = identity.zip(policy.team_id.as_deref()) else {
            let access = if local.is_some() {
                BackupAccess::Ready
            } else {
                BackupAccess::NotLinked
            };
            return Ok(ResolvedBackupAccess {
                material,
                access,
                key: None,
            });
        };
        let (Some(device), Some(root), Some(version)) = (
            identity.device_id,
            identity.root_key,
            identity.key_version.filter(|v| *v > 0),
        ) else {
            let access = if local.is_some() {
                BackupAccess::Ready
            } else {
                BackupAccess::NotLinked
            };
            return Ok(ResolvedBackupAccess {
                material,
                access,
                key: None,
            });
        };
        for attempt in 0..2 {
            let record: Trusted = match self
                .api
                .send_json_no_body(
                    Method::GET,
                    "/api/v1/backups/key/trusted-envelope".into(),
                    token,
                    Some(&device),
                )
                .await
            {
                Ok(record) => record,
                Err(error) if error.error_code() == Some("BACKUP_SETUP_REQUIRED") => {
                    return Ok(ResolvedBackupAccess {
                        material,
                        access: BackupAccess::Unavailable,
                        key: None,
                    })
                }
                Err(error) => return Err(error),
            };
            if material
                .master
                .as_ref()
                .and_then(|value| value.split_once(':'))
                .is_some_and(|(id, _)| id != record.key_id)
            {
                return Err(crypto_error(BackupError::KeyConflict));
            }
            let unwrapped = record.envelope.as_ref().and_then(|envelope| {
                unwrap_trusted(
                    envelope,
                    &root,
                    &policy.user_id,
                    &record.key_id,
                    team,
                    version as u32,
                )
                .ok()
            });
            match (&local, unwrapped) {
                (None, Some(master)) => {
                    return Ok(ResolvedBackupAccess {
                        material,
                        access: BackupAccess::Ready,
                        key: Some((record.key_id, master)),
                    });
                }
                (None, None) => {
                    return Ok(ResolvedBackupAccess {
                        material,
                        access: BackupAccess::Unavailable,
                        key: None,
                    })
                }
                (Some(master), Some(shared)) if master.0 == shared.0 => {
                    let master = MasterKey(master.0);
                    return Ok(ResolvedBackupAccess {
                        material,
                        access: BackupAccess::Ready,
                        key: Some((record.key_id, master)),
                    });
                }
                (Some(_), Some(_)) => return Err(crypto_error(BackupError::KeyConflict)),
                (Some(master), _) => {
                    let envelope = wrap_trusted(
                        master,
                        &root,
                        &policy.user_id,
                        &record.key_id,
                        team,
                        version as u32,
                    )
                    .map_err(crypto_error)?;
                    let result: ApiResult<Trusted> = self
                        .api
                        .send_json_body(
                            Method::PUT,
                            "/api/v1/backups/key/trusted-envelope".into(),
                            token,
                            Some(&device),
                            &json!({ "revision": record.revision, "envelope": envelope }),
                        )
                        .await;
                    match result {
                        Ok(_) => {
                            let master = MasterKey(master.0);
                            return Ok(ResolvedBackupAccess {
                                material,
                                access: BackupAccess::Ready,
                                key: Some((record.key_id, master)),
                            });
                        }
                        Err(error)
                            if attempt == 0
                                && error.error_code() == Some("BACKUP_TRUSTED_CONFLICT") =>
                        {
                            continue
                        }
                        Err(error) => return Err(error),
                    }
                }
            }
        }
        unreachable!("conflict is retried once")
    }
    /// Key sharing is optional for capture and sync: existing lifecycle points retry it.
    pub async fn share_access_best_effort(
        &self,
        token: &str,
        store: &dyn SecretStore,
        policy: Option<&BackupPolicy>,
    ) -> ApiResult<()> {
        if let Err(error) = self.ensure_access(token, store, policy).await {
            if Self::is_key_conflict(&error) {
                return Err(error);
            }
            log::warn!("Backup access could not be shared; retry on a linked device or use a recovery code");
        }
        Ok(())
    }
    pub fn is_key_conflict(error: &DeviceSyncError) -> bool {
        matches!(error, DeviceSyncError::InvalidRequest(message) if message.contains("BACKUP_KEY_CONFLICT"))
    }
    pub async fn reissue_code(&self, token: &str, store: &dyn SecretStore) -> ApiResult<String> {
        let policy = self.policy(token).await?;
        self.share_access_best_effort(token, store, Some(&policy))
            .await?;
        let record = self
            .key(token)
            .await?
            .ok_or_else(|| DeviceSyncError::invalid_request("BACKUP_SETUP_REQUIRED"))?;
        let master = MasterKey::load_for_key(store, &policy.user_id, &record.key_id)
            .map_err(crypto_error)?
            .ok_or_else(|| DeviceSyncError::invalid_request("BACKUP_RECOVERY_CODE_REQUIRED"))?;
        let code = generate_recovery_code();
        let envelope =
            wrap_recovery(&master, &code, &policy.user_id, &record.key_id).map_err(crypto_error)?;
        let _: serde_json::Value = self
            .send(
                token,
                Method::PUT,
                "/key/recovery-envelope",
                json!({ "revision": record.recovery_revision, "envelope": envelope }),
            )
            .await?;
        Ok(code)
    }
    /// Read account-bound secrets while the runtime holds Connect admission. The
    /// subsequent export/encryption/upload operates only on this immutable snapshot.
    pub async fn capture_material(
        &self,
        token: &str,
        store: &dyn SecretStore,
        policy: &BackupPolicy,
    ) -> ApiResult<CaptureMaterial> {
        let record = self
            .key(token)
            .await?
            .ok_or_else(|| DeviceSyncError::invalid_request("BACKUP_SETUP_REQUIRED"))?;
        let master = MasterKey::load_for_key(store, &policy.user_id, &record.key_id)
            .map_err(crypto_error)?
            .ok_or_else(|| DeviceSyncError::invalid_request("BACKUP_RECOVERY_CODE_REQUIRED"))?;
        Ok(CaptureMaterial {
            master,
            key_id: record.key_id,
            source_id: source_id(store, &policy.user_id).map_err(crypto_error)?,
            policy: policy.clone(),
        })
    }
    pub async fn encode_capture<R: Read + Send + 'static>(
        material: CaptureMaterial,
        database: R,
        trigger: &str,
        metadata: BackupMetadata,
    ) -> ApiResult<EncodedCapture> {
        let ctx = BackupContext {
            format: 1,
            user_id: material.policy.user_id.clone(),
            key_id: material.key_id.clone(),
            backup_id: uuid::Uuid::new_v4().to_string(),
        };
        let policy = material.policy.clone();
        let source = material.source_id.clone();
        let encryption_context = ctx.clone();
        let (encrypted, encrypted_metadata) = tokio::task::spawn_blocking(move || {
            let encrypted =
                encrypt_database_reader(&material.master, &encryption_context, database)?;
            let aad = metadata_aad(&encryption_context);
            let labels =
                serde_json::to_vec(&metadata.bounded()).map_err(|_| BackupError::Invalid)?;
            let metadata = BASE64.encode(seal(&derive(&material.master.0, &aad), &labels, &aad)?);
            Ok::<_, BackupError>((encrypted, metadata))
        })
        .await
        .map_err(|_| DeviceSyncError::invalid_request("Backup encryption task failed"))?
        .map_err(crypto_error)?;
        let body = json!({ "request_id": uuid::Uuid::new_v4().to_string(), "backup_id": ctx.backup_id, "key_id": ctx.key_id,
            "source_id": source, "policy_revision": policy.revision, "expected_due_at": policy.next_due_at,
            "format": 1, "size_bytes": encrypted.len(), "checksum": crate::crypto::sha256_checksum(&encrypted),
            "encrypted_metadata": encrypted_metadata, "trigger": trigger });
        Ok(EncodedCapture { body, encrypted })
    }
    pub async fn prepare_capture(
        &self,
        token: &str,
        encoded: EncodedCapture,
    ) -> ApiResult<CaptureUpload> {
        let prepared: Prepared = self
            .send(token, Method::POST, "/prepare-upload", encoded.body)
            .await?;
        if let Some(point) = prepared.published {
            return Ok(CaptureUpload::Published(point));
        }
        Ok(CaptureUpload::Upload {
            ticket: prepared
                .ticket
                .ok_or_else(|| DeviceSyncError::invalid_request("Invalid prepare response"))?,
            descriptor: prepared
                .transfer
                .ok_or_else(|| DeviceSyncError::invalid_request("Invalid transfer descriptor"))?,
            encrypted: encoded.encrypted,
        })
    }
    /// No mutable local credentials are read, and no lifecycle lock is needed for PUT.
    pub async fn upload_capture(&self, upload: CaptureUpload) -> ApiResult<CaptureCompletion> {
        Ok(match upload {
            CaptureUpload::Published(point) => CaptureCompletion::Published(Box::new(point)),
            CaptureUpload::Upload {
                ticket,
                descriptor,
                encrypted,
            } => {
                // A lost PUT response may still have stored the entire object.
                // Completion is authoritative, including for conditional PUT failures.
                let upload_error = match self.transport.upload(&descriptor, encrypted).await {
                    Err(error @ DeviceSyncError::InvalidRequest(_)) => return Err(error),
                    result => result.err(),
                };
                CaptureCompletion::Ticket {
                    ticket,
                    upload_error,
                }
            }
        })
    }
    pub async fn complete_capture(
        &self,
        token: &str,
        completion: CaptureCompletion,
    ) -> ApiResult<BackupPoint> {
        let (ticket, upload_error) = match completion {
            CaptureCompletion::Published(point) => return Ok(*point),
            CaptureCompletion::Ticket {
                ticket,
                upload_error,
            } => (ticket, upload_error),
        };
        let body = json!({ "ticket": ticket });
        for attempt in 0..3 {
            match self
                .send(token, Method::POST, "/complete-upload", body.clone())
                .await
            {
                Ok(point) => return Ok(point),
                Err(error) => {
                    if error.error_code() == Some("TRANSFER_OBJECT_MISSING") {
                        return Err(upload_error.unwrap_or(error));
                    }
                    let retry = error
                        .status_code()
                        .is_none_or(|s| s >= 500 || s == 408 || s == 429);
                    if !retry || attempt == 2 {
                        return Err(error);
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(250 * (1 << attempt)))
                        .await;
                }
            }
        }
        Err(DeviceSyncError::invalid_request("Backup completion failed"))
    }
    /// Convenience for callers without a mutable runtime lifecycle.
    pub async fn capture<R: Read + Send + 'static>(
        &self,
        token: &str,
        store: &dyn SecretStore,
        policy: &BackupPolicy,
        database: R,
        trigger: &str,
        metadata: BackupMetadata,
    ) -> ApiResult<BackupPoint> {
        self.share_access_best_effort(token, store, Some(policy))
            .await?;
        let material = self.capture_material(token, store, policy).await?;
        let encoded = Self::encode_capture(material, database, trigger, metadata).await?;
        let upload = self.prepare_capture(token, encoded).await?;
        let completion = self.upload_capture(upload).await?;
        self.complete_capture(token, completion).await
    }
    pub async fn package(&self, token: &str, backup_id: &str) -> ApiResult<Vec<u8>> {
        uuid::Uuid::parse_str(backup_id)
            .map_err(|_| DeviceSyncError::invalid_request("Invalid backup ID"))?;
        let download: Download = self
            .send(
                token,
                Method::POST,
                &format!("/{backup_id}/download-url"),
                json!({}),
            )
            .await?;
        let key = self
            .key(token)
            .await?
            .ok_or_else(|| DeviceSyncError::invalid_request("BACKUP_SETUP_REQUIRED"))?;
        if download.backup.key_id != key.key_id {
            return Err(DeviceSyncError::invalid_request(
                "Unsupported historical key",
            ));
        }
        let encrypted = self
            .transport
            .download(
                &download.transfer,
                download.backup.size_bytes,
                &download.backup.checksum,
            )
            .await?;
        let header = RecoveryPackageHeader {
            format: 1,
            context: BackupContext {
                format: download.backup.format,
                user_id: download.backup.user_id,
                key_id: key.key_id,
                backup_id: download.backup.backup_id,
            },
            recovery: key.recovery_envelope,
            checksum: download.backup.checksum,
            size_bytes: download.backup.size_bytes,
        };
        let mut package = Vec::new();
        write_recovery_package(&mut package, &header, &encrypted).map_err(crypto_error)?;
        Ok(package)
    }
    /// Authoritative due/source check before the runtime exports any database bytes.
    pub async fn source_policy(
        &self,
        token: &str,
        store: &dyn SecretStore,
    ) -> ApiResult<BackupSource> {
        let consent = store
            .get_secret(wealthfolio_core::secrets::CLOUD_BACKUP_CONSENT_KEY)
            .map_err(|_| DeviceSyncError::invalid_request("Backup consent unavailable"))?;
        let Some(user) = consent else {
            return Ok(BackupSource::Inactive);
        };
        let policy = self.policy(token).await?;
        let own_source = source_id(store, &policy.user_id).map_err(crypto_error)?;
        if user != policy.user_id
            || !policy.enabled
            || policy.source_id.as_deref() != Some(&own_source)
        {
            store
                .delete_secret(wealthfolio_core::secrets::CLOUD_BACKUP_CONSENT_KEY)
                .map_err(|_| DeviceSyncError::invalid_request("Backup consent unavailable"))?;
            return Ok(BackupSource::Inactive);
        }
        if !policy.upload_entitled {
            return Ok(BackupSource::SubscriptionRequired);
        }
        if MasterKey::load(store, &policy.user_id)
            .map_err(crypto_error)?
            .is_none()
        {
            return Ok(BackupSource::AccessRequired);
        }
        if policy.next_due_at.is_none() {
            return Ok(BackupSource::Inactive);
        }
        Ok(BackupSource::Ready(policy))
    }
    pub async fn management(
        &self,
        token: &str,
        store: &dyn SecretStore,
        operation: &BackupOperation,
    ) -> ApiResult<serde_json::Value> {
        match operation {
            BackupOperation::RuntimeStatus => {
                Err(DeviceSyncError::invalid_request("Runtime status is local"))
            }
            BackupOperation::Access => {
                serde_json::to_value(self.ensure_access(token, store, None).await?)
                    .map_err(Into::into)
            }
            BackupOperation::Setup => {
                let code = self.setup(token, store).await?;
                self.share_access_best_effort(token, store, None).await?;
                Ok(json!({ "recoveryCode": code }))
            }
            BackupOperation::Recover { code } => {
                self.recover_key(token, store, code).await?;
                self.share_access_best_effort(token, store, None).await?;
                Ok(json!({ "recovered": true }))
            }
            BackupOperation::Reissue => self
                .reissue_code(token, store)
                .await
                .map(|code| json!({ "recoveryCode": code })),
            BackupOperation::Enable { confirmed } => {
                if !confirmed {
                    return Err(DeviceSyncError::invalid_request(
                        "Confirm recovery-code storage before enabling backups",
                    ));
                }
                let policy = self.policy(token).await?;
                if MasterKey::load(store, &policy.user_id)
                    .map_err(crypto_error)?
                    .is_none()
                {
                    self.ensure_access(token, store, Some(&policy)).await?;
                } else {
                    self.share_access_best_effort(token, store, Some(&policy))
                        .await?;
                }
                if MasterKey::load(store, &policy.user_id)
                    .map_err(crypto_error)?
                    .is_none()
                {
                    return Err(DeviceSyncError::invalid_request(
                        "BACKUP_RECOVERY_CODE_REQUIRED",
                    ));
                }
                let source = source_id(store, &policy.user_id).map_err(crypto_error)?;
                let policy = self.set_source(token, &policy, Some(&source)).await?;
                store
                    .set_secret(
                        wealthfolio_core::secrets::CLOUD_BACKUP_CONSENT_KEY,
                        &policy.user_id,
                    )
                    .map_err(|_| DeviceSyncError::invalid_request("Backup consent unavailable"))?;
                serde_json::to_value(policy).map_err(Into::into)
            }
            BackupOperation::Disable => {
                store
                    .delete_secret(wealthfolio_core::secrets::CLOUD_BACKUP_CONSENT_KEY)
                    .map_err(|_| DeviceSyncError::invalid_request("Backup consent unavailable"))?;
                let policy = self.policy(token).await?;
                serde_json::to_value(self.set_source(token, &policy, None).await?)
                    .map_err(Into::into)
            }
            BackupOperation::Delete { backup_id } => {
                self.remove(token, backup_id.as_deref()).await?;
                Ok(json!({ "deleted": true }))
            }
            BackupOperation::Status => {
                let policy = self.policy(token).await?;
                let (master, has_key, mut history) = match self.key(token).await {
                    Ok(key) => {
                        if let Some(record) = &key {
                            resolve_pending_master(store, &policy.user_id, &record.key_id)
                                .map_err(crypto_error)?;
                        }
                        let master = match &key {
                            Some(record) => match MasterKey::load_for_key(
                                store,
                                &policy.user_id,
                                &record.key_id,
                            ) {
                                Ok(master) => master,
                                Err(BackupError::KeyConflict) => None,
                                Err(error) => return Err(crypto_error(error)),
                            },
                            None => None,
                        };
                        (master, key.is_some(), self.history(token).await?)
                    }
                    Err(error) if error.error_code() == Some("BACKUP_READ_GRACE_EXPIRED") => {
                        (None, false, Vec::new())
                    }
                    Err(error) => return Err(error),
                };
                if let Some(master) = &master {
                    for point in &mut history {
                        if point.user_id != policy.user_id {
                            continue;
                        }
                        let aad = metadata_aad(&BackupContext {
                            format: point.format,
                            user_id: point.user_id.clone(),
                            key_id: point.key_id.clone(),
                            backup_id: point.backup_id.clone(),
                        });
                        point.metadata = BASE64
                            .decode(&point.encrypted_metadata)
                            .ok()
                            .and_then(|bytes| open(&derive(&master.0, &aad), &bytes, &aad).ok())
                            .and_then(|bytes| serde_json::from_slice::<BackupMetadata>(&bytes).ok())
                            .map(BackupMetadata::bounded);
                    }
                }
                let source_consented = store
                    .get_secret(wealthfolio_core::secrets::CLOUD_BACKUP_CONSENT_KEY)
                    .map_err(|_| DeviceSyncError::invalid_request("Backup consent unavailable"))?
                    .as_deref()
                    == Some(policy.user_id.as_str());
                Ok(
                    json!({ "hasKey": has_key, "keyReady": master.is_some(), "isSource": policy.source_id.as_deref() == Some(&source_id(store, &policy.user_id).map_err(crypto_error)?), "sourceConsented": source_consented, "policy": policy, "history": history }),
                )
            }
        }
    }
    pub async fn remove(&self, token: &str, backup_id: Option<&str>) -> ApiResult<()> {
        if let Some(id) = backup_id {
            uuid::Uuid::parse_str(id)
                .map_err(|_| DeviceSyncError::invalid_request("Invalid backup ID"))?;
        }
        let _: serde_json::Value = self
            .api
            .send_json_no_body(
                Method::DELETE,
                format!(
                    "/api/v1/backups{}",
                    backup_id.map(|id| format!("/{id}")).unwrap_or_default()
                ),
                token,
                None,
            )
            .await?;
        Ok(())
    }
}
fn crypto_error(error: BackupError) -> DeviceSyncError {
    DeviceSyncError::invalid_request(error.to_string())
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum BackupOperation {
    Status,
    RuntimeStatus,
    Access,
    Setup,
    Enable {
        confirmed: bool,
    },
    Disable,
    Recover {
        code: String,
    },
    Reissue,
    Delete {
        #[serde(rename = "backupId")]
        backup_id: Option<String>,
    },
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BackupAccess {
    Ready,
    Unavailable,
    NotLinked,
}

#[cfg(test)]
mod access_tests {
    use super::*;
    #[test]
    fn policy_preserves_recovery_deadline_in_runtime_status_and_accepts_older_responses() {
        let mut response = json!({
            "userId": "owner", "enabled": true, "sourceId": "source", "revision": 1,
            "teamId": null, "nextDueAt": null, "lastBackupAt": null,
            "uploadEntitled": false, "readGraceExpiresAt": "2026-12-31T12:00:00Z"
        });
        let policy: BackupPolicy = serde_json::from_value(response.clone()).unwrap();
        assert_eq!(
            serde_json::to_value(policy).unwrap()["readGraceExpiresAt"],
            response["readGraceExpiresAt"]
        );
        response
            .as_object_mut()
            .unwrap()
            .remove("readGraceExpiresAt");
        assert!(serde_json::from_value::<BackupPolicy>(response).is_ok());
    }
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    #[derive(Default)]
    struct Store(Mutex<std::collections::HashMap<String, String>>);
    impl SecretStore for Store {
        fn get_secret(&self, key: &str) -> wealthfolio_core::Result<Option<String>> {
            Ok(self.0.lock().unwrap().get(key).cloned())
        }
        fn set_secret(&self, key: &str, value: &str) -> wealthfolio_core::Result<()> {
            self.0.lock().unwrap().insert(key.into(), value.into());
            Ok(())
        }
        fn delete_secret(&self, key: &str) -> wealthfolio_core::Result<()> {
            self.0.lock().unwrap().remove(key);
            Ok(())
        }
    }
    fn linked(store: &Store, root: &str) {
        store
            .set_secret(
                wealthfolio_core::secrets::SYNC_IDENTITY_KEY,
                &serde_json::to_string(&crate::SyncIdentity {
                    device_nonce: Some(uuid::Uuid::new_v4().to_string()),
                    device_id: Some(uuid::Uuid::new_v4().to_string()),
                    root_key: Some(root.into()),
                    key_version: Some(1),
                    ..Default::default()
                })
                .unwrap(),
            )
            .unwrap();
    }
    #[tokio::test]
    async fn lifecycle_access_publishes_once_then_joiner_recovers_without_code() {
        exercise_access(false).await;
    }
    #[tokio::test]
    async fn lifecycle_access_rereads_a_concurrent_publication() {
        exercise_access(true).await;
    }
    async fn exercise_access(conflict: bool) {
        let user = uuid::Uuid::new_v4().to_string();
        let team = uuid::Uuid::new_v4().to_string();
        let key = uuid::Uuid::new_v4().to_string();
        let policy: BackupPolicy = serde_json::from_value(json!({"userId":user,"teamId":team,"enabled":false,"sourceId":null,"revision":1,"nextDueAt":null,"lastBackupAt":null})).unwrap();
        let holder = Store::default();
        let joiner = Store::default();
        let root = crate::crypto::generate_root_key();
        linked(&holder, &root);
        linked(&joiner, &root);
        let master = MasterKey::generate();
        master.save(&holder, &user).unwrap();
        let puts = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn({
            let puts = puts.clone();
            async move {
                let mut envelope = serde_json::Value::Null;
                let mut revision = 0;
                loop {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let mut request = Vec::new();
                    loop {
                        let mut chunk = [0; 4096];
                        let n = socket.read(&mut chunk).await.unwrap();
                        if n == 0 {
                            break;
                        }
                        request.extend_from_slice(&chunk[..n]);
                        if let Some(end) = request.windows(4).position(|b| b == b"\r\n\r\n") {
                            let headers = String::from_utf8_lossy(&request[..end]);
                            let length: usize = headers
                                .lines()
                                .find_map(|l| {
                                    l.to_lowercase()
                                        .strip_prefix("content-length:")
                                        .map(|v| v.trim().parse().unwrap())
                                })
                                .unwrap_or(0);
                            if request.len() >= end + 4 + length {
                                break;
                            }
                        }
                    }
                    let end = request.windows(4).position(|b| b == b"\r\n\r\n").unwrap();
                    let headers = String::from_utf8_lossy(&request[..end]);
                    assert!(headers.contains("/api/v1/backups/key/trusted-envelope "));
                    let mut status = "200 OK";
                    if headers.starts_with("PUT ") {
                        let input: serde_json::Value =
                            serde_json::from_slice(&request[end + 4..]).unwrap();
                        assert_eq!(input["revision"], revision);
                        envelope = input["envelope"].clone();
                        revision += 1;
                        puts.fetch_add(1, Ordering::SeqCst);
                        if conflict {
                            status = "409 Conflict";
                        }
                    } else {
                        assert!(headers.starts_with("GET "));
                    }
                    let body = if status == "200 OK" {
                        json!({"keyId":key,"revision":revision,"envelope":envelope})
                    } else {
                        json!({"code":"BACKUP_TRUSTED_CONFLICT","message":"Concurrent publication"})
                    }
                    .to_string();
                    socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).as_bytes()).await.unwrap();
                }
            }
        });
        let client = BackupClient::new(&url).unwrap();
        assert_eq!(
            client
                .ensure_access("test", &joiner, Some(&policy))
                .await
                .unwrap(),
            BackupAccess::Unavailable
        );
        assert_eq!(
            client
                .ensure_access("test", &holder, Some(&policy))
                .await
                .unwrap(),
            BackupAccess::Ready
        );
        assert_eq!(
            client
                .ensure_access("test", &holder, Some(&policy))
                .await
                .unwrap(),
            BackupAccess::Ready
        );
        assert_eq!(
            puts.load(Ordering::SeqCst),
            1,
            "valid envelopes must not be republished"
        );
        assert_eq!(
            client
                .ensure_access("test", &joiner, Some(&policy))
                .await
                .unwrap(),
            BackupAccess::Ready
        );
        assert_eq!(
            MasterKey::load(&joiner, &user).unwrap().unwrap().0,
            master.0
        );
        assert_eq!(puts.load(Ordering::SeqCst), 1, "joining device reads only");
        let conflicting = Store::default();
        linked(&conflicting, &root);
        MasterKey::generate().save(&conflicting, &user).unwrap();
        let error = client
            .ensure_access("test", &conflicting, Some(&policy))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("BACKUP_KEY_CONFLICT"));
        assert_eq!(
            puts.load(Ordering::SeqCst),
            1,
            "a valid different key must never be overwritten"
        );
        server.abort();
    }
    #[tokio::test]
    async fn backup_only_key_holder_does_not_require_sync_or_make_trusted_requests() {
        let store = Store::default();
        let user = "synthetic-user";
        let master = MasterKey::generate();
        master.save(&store, user).unwrap();
        let policy: BackupPolicy = serde_json::from_value(json!({"userId":user,"teamId":"team","enabled":false,"sourceId":null,"revision":1,"nextDueAt":null,"lastBackupAt":null})).unwrap();
        let client = BackupClient::new("http://127.0.0.1:1").unwrap();
        assert_eq!(
            client
                .ensure_access("test", &store, Some(&policy))
                .await
                .unwrap(),
            BackupAccess::Ready
        );
        linked(&store, &crate::crypto::generate_root_key());
        client
            .share_access_best_effort("test", &store, Some(&policy))
            .await
            .unwrap();
        assert_eq!(
            MasterKey::load(&store, user).unwrap().unwrap().0,
            master.0,
            "sharing failures preserve capture key"
        );
    }

    #[tokio::test]
    async fn capture_encrypts_with_immutable_account_material_after_credentials_change() {
        let store = Store::default();
        let user = uuid::Uuid::new_v4().to_string();
        let source = source_id(&store, &user).unwrap();
        let master = MasterKey::generate();
        let saved_master = MasterKey(master.0);
        let policy: BackupPolicy = serde_json::from_value(json!({"userId":user,"enabled":true,"uploadEntitled":true,"sourceId":source,"revision":1,"nextDueAt":"2026-01-01T00:00:00Z","lastBackupAt":null})).unwrap();
        let material = CaptureMaterial {
            master,
            key_id: uuid::Uuid::new_v4().to_string(),
            source_id: source.clone(),
            policy,
        };
        // The runtime may now release its Connect read guard: encryption has no
        // dependency on mutable secrets, token refresh or the currently signed-in account.
        store.0.lock().unwrap().clear();
        let encoded = BackupClient::encode_capture(
            material,
            std::io::Cursor::new(zeroize::Zeroizing::new(
                b"SQLite format 3\0immutable portfolio".to_vec(),
            )),
            "scheduled",
            Default::default(),
        )
        .await
        .unwrap();
        assert_eq!(encoded.body["source_id"], source);
        let ctx = BackupContext {
            format: 1,
            user_id: user,
            key_id: encoded.body["key_id"].as_str().unwrap().into(),
            backup_id: encoded.body["backup_id"].as_str().unwrap().into(),
        };
        assert_eq!(
            decrypt_database(&saved_master, &ctx, &encoded.encrypted)
                .unwrap()
                .as_slice(),
            b"SQLite format 3\0immutable portfolio"
        );
        assert!(
            store.0.lock().unwrap().is_empty(),
            "encryption must not recreate credentials for the old account"
        );
    }

    #[tokio::test]
    async fn expected_source_waits_preserve_consent_without_reporting_a_failure() {
        for entitled in [false, true] {
            let store = Store::default();
            let user = uuid::Uuid::new_v4().to_string();
            store
                .set_secret(wealthfolio_core::secrets::CLOUD_BACKUP_CONSENT_KEY, &user)
                .unwrap();
            let source = source_id(&store, &user).unwrap();
            let policy = json!({"userId":user,"enabled":true,"uploadEntitled":entitled,"sourceId":source,"revision":1,"nextDueAt":"2026-01-01T00:00:00Z","lastBackupAt":null}).to_string();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = [0; 8192];
                let n = socket.read(&mut buffer).await.unwrap();
                assert!(String::from_utf8_lossy(&buffer[..n])
                    .starts_with("GET /api/v1/backups/policy "));
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{policy}", policy.len()).as_bytes()).await.unwrap();
            });
            let client = BackupClient::new(&url).unwrap();
            let check = client.source_policy("test", &store).await.unwrap();
            assert!(matches!(
                (entitled, check),
                (false, BackupSource::SubscriptionRequired) | (true, BackupSource::AccessRequired)
            ));
            assert_eq!(
                store
                    .get_secret(wealthfolio_core::secrets::CLOUD_BACKUP_CONSENT_KEY)
                    .unwrap(),
                Some(user)
            );
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn status_does_not_report_a_key_bound_to_another_backup_record_as_ready() {
        let store = Store::default();
        let user = uuid::Uuid::new_v4().to_string();
        let master = MasterKey::generate();
        master
            .save_for_key(&store, &user, &uuid::Uuid::new_v4().to_string())
            .unwrap();
        let source = source_id(&store, &user).unwrap();
        let key_id = uuid::Uuid::new_v4().to_string();
        let record = KeyRecord {
            recovery_envelope: wrap_recovery(&master, &generate_recovery_code(), &user, &key_id)
                .unwrap(),
            key_id,
            recovery_revision: 1,
            trusted_revision: 0,
            created: false,
        };
        let responses = [
            (
                "policy",
                json!({"userId":user,"teamId":null,"enabled":false,"sourceId":source,"revision":1,"nextDueAt":null,"lastBackupAt":null}),
            ),
            ("key", serde_json::to_value(record).unwrap()),
            ("history", json!([])),
        ];
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for (path, body) in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = [0; 8192];
                let n = socket.read(&mut buffer).await.unwrap();
                let path = if path.is_empty() {
                    "/api/v1/backups".into()
                } else {
                    format!("/api/v1/backups/{path}")
                };
                assert!(String::from_utf8_lossy(&buffer[..n]).starts_with(&format!("GET {path} ")));
                let body = body.to_string();
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            }
        });
        let status = BackupClient::new(&url)
            .unwrap()
            .management("test", &store, &BackupOperation::Status)
            .await
            .unwrap();
        assert_eq!(status["hasKey"], true);
        assert_eq!(status["keyReady"], false);
        assert!(
            MasterKey::load(&store, &user).unwrap().is_some(),
            "status preserves the local key"
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn source_check_does_not_share_keys_before_checking_due_time() {
        let store = Store::default();
        let user = uuid::Uuid::new_v4().to_string();
        let master = MasterKey::generate();
        master.save(&store, &user).unwrap();
        linked(&store, &crate::crypto::generate_root_key());
        store
            .set_secret(wealthfolio_core::secrets::CLOUD_BACKUP_CONSENT_KEY, &user)
            .unwrap();
        let source = source_id(&store, &user).unwrap();
        let tomorrow = (chrono::Utc::now() + chrono::Duration::days(1)).to_rfc3339();
        let policy = json!({"userId":user,"teamId":uuid::Uuid::new_v4(),"enabled":true,"uploadEntitled":true,"sourceId":source,"revision":1,"nextDueAt":tomorrow,"lastBackupAt":null}).to_string();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for path in ["policy"] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = [0; 8192];
                let n = socket.read(&mut buffer).await.unwrap();
                let request = String::from_utf8_lossy(&buffer[..n]);
                assert!(request.starts_with(&format!("GET /api/v1/backups/{path} ")));
                let (status, body) = if path == "policy" {
                    ("200 OK", policy.clone())
                } else {
                    (
                        "503 Service Unavailable",
                        json!({"code":"UNAVAILABLE","message":"Try later"}).to_string(),
                    )
                };
                socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            }
        });
        let client = BackupClient::new(&url).unwrap();
        let BackupSource::Ready(due) = client.source_policy("test", &store).await.unwrap() else {
            panic!("source should be ready")
        };
        assert_eq!(due.source_id.as_deref(), Some(source.as_str()));
        assert!(!due.delay_until_due().unwrap().is_zero());
        assert_eq!(MasterKey::load(&store, &user).unwrap().unwrap().0, master.0);
        assert_eq!(
            store
                .get_secret(wealthfolio_core::secrets::CLOUD_BACKUP_CONSENT_KEY)
                .unwrap(),
            Some(user)
        );
        server.await.unwrap();
    }
    #[tokio::test]
    async fn rejected_upload_returns_local_validation_without_completing() {
        let client = BackupClient::new("http://127.0.0.1:1").unwrap();
        for checksum in [None, Some("invalid")] {
            let mut headers =
                std::collections::BTreeMap::from([("content-length".into(), "3".into())]);
            if let Some(checksum) = checksum {
                headers.insert("x-amz-checksum-sha256".into(), checksum.into());
            }
            let result = client
                .upload_capture(CaptureUpload::Upload {
                    ticket: "unused".into(),
                    encrypted: vec![1, 2, 3],
                    descriptor: TransferDescriptor {
                        url: "http://invalid.test/object".into(),
                        method: "PUT".into(),
                        headers,
                        expires_at: "2099-01-01T00:00:00Z".into(),
                    },
                })
                .await;
            assert!(matches!(result, Err(DeviceSyncError::InvalidRequest(_))));
        }
    }
    #[test]
    fn resolved_key_access_cannot_recreate_credentials_after_signout() {
        let store = Store::default();
        let user = uuid::Uuid::new_v4().to_string();
        linked(&store, &crate::crypto::generate_root_key());
        let policy: BackupPolicy = serde_json::from_value(json!({"userId":user,"teamId":"team","enabled":false,"sourceId":null,"revision":1,"nextDueAt":null,"lastBackupAt":null})).unwrap();
        let material = BackupClient::access_material(&store, &policy).unwrap();
        let resolved = ResolvedBackupAccess {
            material,
            access: BackupAccess::Ready,
            key: Some((uuid::Uuid::new_v4().to_string(), MasterKey::generate())),
        };
        store.0.lock().unwrap().clear();
        assert!(resolved.apply(&store).is_err());
        assert!(store.0.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn completion_resolves_lost_put_responses_and_preserves_missing_upload_errors() {
        let backup_id = uuid::Uuid::new_v4().to_string();
        for published in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let point = json!({"backupId":backup_id,"keyId":"key","userId":"user","sourceId":"source","sizeBytes":3,"checksum":"unused","format":1,"publishedAt":"2026-01-01T00:00:00Z","encryptedMetadata":"opaque"});
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                let n = socket.read(&mut request).await.unwrap();
                assert!(String::from_utf8_lossy(&request[..n])
                    .starts_with("POST /api/v1/backups/complete-upload "));
                let (status, body) = if published {
                    ("200 OK", point)
                } else {
                    (
                        "404 Not Found",
                        json!({"code":"TRANSFER_OBJECT_MISSING","message":"missing"}),
                    )
                };
                let body = body.to_string();
                socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            });
            let client = BackupClient::new(&url).unwrap();
            let result = client
                .complete_capture(
                    "token",
                    CaptureCompletion::Ticket {
                        ticket: "same-attempt".into(),
                        upload_error: Some(DeviceSyncError::api(503, "Secure upload failed")),
                    },
                )
                .await;
            if published {
                assert_eq!(result.unwrap().backup_id, backup_id);
            } else {
                assert_eq!(result.unwrap_err().status_code(), Some(503));
            }
            server.await.unwrap();
        }
    }
    #[test]
    fn bound_keys_reject_a_different_cloud_key_id_without_relabeling() {
        let store = Store::default();
        let user = uuid::Uuid::new_v4().to_string();
        let key_id = uuid::Uuid::new_v4().to_string();
        let master = MasterKey::generate();
        master.save_for_key(&store, &user, &key_id).unwrap();
        assert_eq!(
            MasterKey::load_for_key(&store, &user, &key_id)
                .unwrap()
                .unwrap()
                .0,
            master.0
        );
        assert!(matches!(
            MasterKey::load_for_key(&store, &user, &uuid::Uuid::new_v4().to_string()),
            Err(BackupError::KeyConflict)
        ));
        assert_eq!(MasterKey::load(&store, &user).unwrap().unwrap().0, master.0);
    }
}
