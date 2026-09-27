//! Installation-local profile metadata and application-access protection.
//! Financial repositories continue to operate on one database, without profile columns.

mod registry;
mod sessions;

pub use registry::ProfileRegistry;
pub use sessions::{ProfileSession, ProfileSessions, PROFILE_IDLE_TIMEOUT};

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use uuid::Uuid;

use crate::secrets::SecretStore;

pub const PROFILE_LOCK_KEY: &str = "profile_lock";
pub const DATABASE_KEY_SECRET: &str = "database_encryption_key";
pub const PROFILE_SCOPE_HEADER: &str = "x-wf-profile-scope";
pub const PROFILE_ID_HEADER: &str = "x-wf-profile-id";
pub const DEFAULT_PROFILE_AVATAR: &str = "default";
pub const PROFILE_AVATARS: &[&str] = &[
    DEFAULT_PROFILE_AVATAR,
    "line-curls-animated",
    "line-wave-animated",
    "line-bob-animated",
    "line-silver-animated",
    "line-bun-animated",
    "line-beard-animated",
    "line-wisps-animated",
    "line-freckles-animated",
    "clay-pebble-animated",
    "clay-fluff-animated",
    "clay-bot-animated",
    "clay-sun-animated",
    "sketch-glasses-animated",
    "sketch-curls-animated",
    "sketch-beanie-animated",
    "sketch-scarf-animated",
    "pixel-explorer-animated",
    "pixel-fox-animated",
    "pixel-ghost-animated",
    "pixel-sprite-animated",
    "abstract-lantern",
    "abstract-comet",
    "abstract-duet",
    "abstract-mobile",
    "clay-artist-animated",
    "clay-traveler-animated",
    "clay-maker-animated",
    "clay-sailor-animated",
    "sketch-storyteller-animated",
    "sketch-thinker-animated",
    "sketch-wanderer-animated",
    "sketch-producer-animated",
    "pixel-wizard-animated",
    "pixel-inventor-animated",
    "pixel-courier-animated",
    "pixel-musician-animated",
    "abstract-architect-animated",
    "abstract-dancer-animated",
    "abstract-explorer-animated",
    "abstract-dreamer-animated",
];

#[derive(Debug, thiserror::Error)]
pub enum ProfileError {
    #[error("PROFILE_LOCKED: Unlock this profile to continue.")]
    Locked,
    #[error("PROFILE_STALE: This profile session has ended.")]
    Stale,
    #[error("PROFILE_NOT_FOUND: This profile does not exist.")]
    NotFound,
    #[error("PROFILE_INVALID: {0}")]
    Invalid(String),
    #[error("PROFILE_PASSWORD_INVALID: The password or recovery code is incorrect.")]
    IncorrectPassword,
    #[error("PROFILE_COOLDOWN: Try again in {0} seconds.")]
    Cooldown(u64),
    #[error("PROFILE_UNAVAILABLE: {0}")]
    Unavailable(String),
    #[error("PROFILE_UNAVAILABLE: Profile storage failed ({kind:?}, OS error {os_code:?}).")]
    StorageIo {
        kind: std::io::ErrorKind,
        os_code: Option<i32>,
    },
    #[error("CONNECT_PROFILE_EXISTS: This Connect account belongs to profile {0}.")]
    DuplicateIdentity(Uuid),
    #[error("CONNECT_IDENTITY_MISMATCH: Reconnect the original Connect account.")]
    IdentityMismatch,
    #[error("CONNECT_TEAM_CHANGED: Reconnect device sync after the team change.")]
    TeamChanged,
}

pub type ProfileResult<T> = Result<T, ProfileError>;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectBinding {
    pub issuer: String,
    pub user_id: String,
    pub team_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: Uuid,
    pub name: String,
    pub avatar_id: String,
    pub lock_enabled: bool,
    /// Only explicitly never-protected profiles can open without a secret store.
    /// Older registries default to consulting the authoritative lock record.
    #[serde(default)]
    pub(crate) never_protected: bool,
    /// Only the migrated default may own the pre-profile namespace and database.
    pub legacy_database: Option<PathBuf>,
    #[serde(default)]
    pub legacy_addons_root: Option<PathBuf>,
    pub connect: Option<ConnectBinding>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSummary {
    pub id: Uuid,
    pub name: String,
    pub avatar_id: String,
    pub lock_enabled: bool,
    pub is_legacy: bool,
    pub has_connect_binding: bool,
}

impl From<&Profile> for ProfileSummary {
    fn from(profile: &Profile) -> Self {
        Self {
            id: profile.id,
            name: profile.name.clone(),
            avatar_id: profile.avatar_id.clone(),
            lock_enabled: profile.lock_enabled,
            is_legacy: profile.legacy_database.is_some(),
            has_connect_binding: profile.connect.is_some(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct ProfilePaths {
    pub root: PathBuf,
    pub database: PathBuf,
}

impl ProfilePaths {
    pub fn backups(&self) -> PathBuf {
        self.root.join("backups")
    }
    pub fn scratch(&self) -> PathBuf {
        self.root.join("scratch")
    }
    pub fn addons(&self) -> PathBuf {
        self.root.join("addons")
    }
}

/// Prefixes logical keys before the platform store applies its service prefix.
/// Legacy add-on fallbacks therefore stay inside the same profile namespace.
pub struct ScopedSecretStore {
    inner: Arc<dyn SecretStore>,
    prefix: String,
    deletion_marker: PathBuf,
    gate: Arc<std::sync::Mutex<()>>,
}

impl ScopedSecretStore {
    pub fn new(
        inner: Arc<dyn SecretStore>,
        profile: &Profile,
        deletion_marker: PathBuf,
        gate: Arc<std::sync::Mutex<()>>,
    ) -> Self {
        Self {
            inner,
            deletion_marker,
            gate,
            prefix: if profile.legacy_database.is_some() {
                String::new()
            } else {
                format!("profile:{}:", profile.id)
            },
        }
    }

    fn admit(&self) -> crate::Result<std::sync::MutexGuard<'_, ()>> {
        let guard = self
            .gate
            .lock()
            .map_err(|_| crate::Error::Secret("Profile credentials are unavailable.".into()))?;
        if self.deletion_marker.exists() {
            return Err(crate::Error::Secret(
                "This profile is being deleted.".into(),
            ));
        }
        Ok(guard)
    }

    fn key(&self, key: &str) -> String {
        format!("{}{key}", self.prefix)
    }
}

impl SecretStore for ScopedSecretStore {
    fn get_secret(&self, key: &str) -> crate::Result<Option<String>> {
        let _guard = self.admit()?;
        self.inner.get_secret(&self.key(key))
    }
    fn set_secret(&self, key: &str, value: &str) -> crate::Result<()> {
        let _guard = self.admit()?;
        self.inner.set_secret(&self.key(key), value)
    }
    fn delete_secret(&self, key: &str) -> crate::Result<()> {
        let _guard = self.admit()?;
        self.inner.delete_secret(&self.key(key))
    }
}

mod auth_flow;
pub use auth_flow::ProfileAuthFlows;
