//! The database runtime: a stable managed handle around a takeable
//! [`ServiceContext`].
//!
//! Replacing the database file requires that *nothing* is connected to it, and
//! the pool is `Arc`-cloned into every repository and service that
//! `ServiceContext` owns. Tauri state cannot be removed safely —
//! `Manager::unmanage` exists but is deprecated, and its own documentation warns
//! it leaves dangling references, prescribing instead exactly the shape used
//! here: a `Mutex` plus `Option::take`.
//!
//! So the *managed* value is this stable handle and the *contents* are what
//! maintenance takes. Repository constructors are untouched: they keep taking
//! `Arc<DbPool>`. The pool also retains the runtime owner, so teardown detects
//! service or connection clones that outlive their context.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use log::{error, info, warn};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter};
use wealthfolio_ai::ProviderApiError;
use wealthfolio_core::errors::{DatabaseError, Error, Result as CoreResult};
use wealthfolio_core::events::DomainEvent;
use wealthfolio_core::secrets::SecretStore;
use wealthfolio_storage_sqlite::db::{
    self,
    maintenance::{self, MaintenanceOutcome, MaintenanceRequest},
    DatabaseOwner, DbAccess, DbEncryptionKey, EncryptionPolicy, KeyProvider, WriteHandle,
    WriterTask,
};
use wealthfolio_storage_sqlite::sync::ProfileSyncState;

use crate::context::{initialize_context, ServiceContext};
#[cfg(test)]
use crate::secret_store::shared_secret_store;

/// Keychain entry holding this device's database key.
use wealthfolio_core::profiles::{ProfilePaths, DATABASE_KEY_SECRET};

/// How long teardown waits for in-flight commands to release the context before
/// giving up. Long enough for an ordinary query, short enough that a stuck one
/// still fails promptly.
const OWNERSHIP_WAIT: Duration = Duration::from_secs(3);
const OWNERSHIP_POLL: Duration = Duration::from_millis(50);

/// Marks that this device's database is meant to be encrypted.
///
/// Read only when the database file is missing, to decide how to create the
/// replacement. Nothing infers the *current* state from it: that is always
/// resolved by probing the file.
fn encryption_marker(db_path: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(format!("{db_path}.encrypted"))
}

// ─────────────────────────────────────────────────────────────────────────────
// Unavailability
// ─────────────────────────────────────────────────────────────────────────────

/// Why a command cannot reach the database right now.
///
/// Commands surface this through `?`; the `From` impls below cover every error
/// type the command layer uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DatabaseUnavailable {
    /// The database file is being replaced. New work is rejected until it is.
    Maintenance,
    /// Startup has not finished, or it failed.
    NotInitialized,
    /// A runtime transition panicked; further database work requires a restart.
    StatePoisoned,
}

impl std::fmt::Display for DatabaseUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Maintenance => f.write_str(
                "The database is being updated. Please wait for the operation to finish.",
            ),
            Self::NotInitialized => f.write_str("The database is not available."),
            Self::StatePoisoned => f.write_str(
                "Database state is unavailable after an internal error. Restart the application before continuing."
            ),
        }
    }
}

impl std::error::Error for DatabaseUnavailable {}

impl From<DatabaseUnavailable> for String {
    fn from(value: DatabaseUnavailable) -> Self {
        value.to_string()
    }
}

impl From<DatabaseUnavailable> for ProviderApiError {
    fn from(value: DatabaseUnavailable) -> Self {
        ProviderApiError::ProviderError {
            message: value.to_string(),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Key provider
// ─────────────────────────────────────────────────────────────────────────────

/// Stores the database key in the OS keychain, alongside the app's other
/// secrets (`Security.framework` on macOS/iOS, Credential Manager on Windows,
/// the Secret Service on Linux, Android Keystore on Android).
pub struct KeychainKeyProvider {
    store: Arc<dyn SecretStore>,
}

impl KeychainKeyProvider {
    pub fn new(store: Arc<dyn SecretStore>) -> Self {
        Self { store }
    }
}

impl KeyProvider for KeychainKeyProvider {
    fn existing(&self) -> CoreResult<Option<DbEncryptionKey>> {
        match self.store.get_secret(DATABASE_KEY_SECRET)? {
            Some(value) if !value.trim().is_empty() => DbEncryptionKey::from_hex(&value).map(Some),
            _ => Ok(None),
        }
    }

    fn create(&self) -> CoreResult<DbEncryptionKey> {
        // Never replace a key that already exists. Internal and pre-operation
        // backups inherit the source database's encryption, so overwriting the
        // key would orphan every encrypted backup it opens. Replacing a key is
        // rotation, which Phase 1 does not do.
        if let Some(existing) = self.existing()? {
            return Ok(existing);
        }

        let key = DbEncryptionKey::generate();
        self.store.set_secret(DATABASE_KEY_SECRET, key.as_hex())?;

        // Read the key back before anything is encrypted with it. A backend
        // that accepts the write without persisting it — a session-only Secret
        // Service collection, a keyring shim — reports success here and returns
        // nothing after the restart, by which point the database is encrypted
        // and its plaintext pre-operation backup has been deleted. Failing now
        // costs the user a message; failing later costs them the database.
        match self.existing() {
            Ok(Some(stored)) if stored.as_hex() == key.as_hex() => {
                info!("Generated and stored a new database encryption key");
                Ok(key)
            }
            Ok(_) => Err(Error::Database(DatabaseError::Encryption(
                "The database key was not stored: this device's key store accepted it but did \
                 not keep it. Encryption was not enabled and the database is untouched."
                    .to_string(),
            ))),
            Err(e) => Err(Error::Database(DatabaseError::Encryption(format!(
                "The database key could not be read back after storing it ({e}). Encryption was \
                 not enabled and the database is untouched."
            )))),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime
// ─────────────────────────────────────────────────────────────────────────────

/// Everything that holds a database handle, so that all of it can be released
/// together.
struct Live {
    generation: uuid::Uuid,
    /// Which database the rest of this struct is serving. It belongs here, not
    /// in a field of its own: the two are set and cleared together, and a
    /// location that outlived the services would describe a database nothing is
    /// connected to.
    access: DbAccess,
    context: Arc<ServiceContext>,
    writer: WriteHandle,
    writer_task: WriterTask,
    /// Background tasks holding context or service clones. Each must be
    /// cancellable and joinable, or sole ownership can never be proven.
    workers: Vec<JoinHandle<()>>,
}

/// A direct-file job admitted by the runtime. Keep this value inside the
/// blocking task until its connection has closed, even if its caller cancels.
pub struct DatabaseFileAccess {
    access: DbAccess,
    _lease: Arc<()>,
}

impl std::ops::Deref for DatabaseFileAccess {
    type Target = DbAccess;

    fn deref(&self) -> &Self::Target {
        &self.access
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStartupStatus {
    pub generation: Option<uuid::Uuid>,
    pub ready: bool,
    pub maintenance: bool,
    pub error: Option<String>,
    pub can_recover: bool,
    pub recovery_encrypted: Option<bool>,
}

pub struct DatabaseRuntime {
    sync_state: Arc<ProfileSyncState>,
    pub profile_registry: Option<Arc<wealthfolio_core::profiles::ProfileRegistry>>,
    pub profile_id: uuid::Uuid,
    pub connect_transition: Arc<tokio::sync::RwLock<()>>,
    pub secret_store: Arc<dyn SecretStore>,
    db_path: String,
    suspended: AtomicBool,
    startup_error: Mutex<Option<String>>,
    pub backup_imports: db::imports::PendingImports,
    pub backup_export_slot: Arc<tokio::sync::Semaphore>,
    app_data_dir: String,
    key_provider: Arc<dyn KeyProvider>,
    live: Mutex<Option<Live>>,
    /// Set for the duration of a maintenance operation. Rejects new database
    /// work and serialises maintenance with itself.
    maintenance: AtomicBool,
    // Survive failed maintenance/rebuilds so retries still see older jobs.
    file_jobs: Arc<()>,
    retired_contexts: Mutex<Vec<Arc<ServiceContext>>>,
    // Kept while Live is taken and until the runtime itself is dropped.
    owner: Mutex<Option<Arc<DatabaseOwner>>>,
}

impl DatabaseRuntime {
    #[cfg(test)]
    pub fn new(app_data_dir: String) -> Self {
        let database = db::get_db_path(&app_data_dir).into();
        Self::for_profile(
            uuid::Uuid::nil(),
            ProfilePaths {
                root: app_data_dir.into(),
                database,
            },
            shared_secret_store(),
            Arc::default(),
        )
    }

    pub fn for_profile(
        profile_id: uuid::Uuid,
        paths: ProfilePaths,
        secret_store: Arc<dyn SecretStore>,
        sync_state: Arc<ProfileSyncState>,
    ) -> Self {
        Self {
            sync_state,
            profile_registry: None,
            connect_transition: Arc::new(tokio::sync::RwLock::new(())),
            profile_id,
            db_path: paths.database.to_string_lossy().into_owned(),
            suspended: AtomicBool::new(false),
            secret_store: secret_store.clone(),
            startup_error: Mutex::new(None),
            backup_imports: db::imports::PendingImports::default(),
            backup_export_slot: Arc::new(tokio::sync::Semaphore::new(1)),
            app_data_dir: paths.root.to_string_lossy().into_owned(),
            key_provider: Arc::new(KeychainKeyProvider::new(secret_store)),
            live: Mutex::new(None),
            maintenance: AtomicBool::new(false),
            file_jobs: Arc::new(()),
            retired_contexts: Mutex::new(Vec::new()),
            owner: Mutex::new(None),
        }
    }

    pub fn database_path(&self) -> &str {
        &self.db_path
    }

    fn check_available(&self) -> std::result::Result<(), DatabaseUnavailable> {
        self.check_state()?;
        if self.suspended.load(Ordering::SeqCst) {
            return Err(DatabaseUnavailable::NotInitialized);
        }
        Ok(())
    }

    pub fn generation(&self) -> Option<uuid::Uuid> {
        self.startup_status().generation
    }

    pub fn suspend(&self) {
        self.suspended.store(true, Ordering::SeqCst);
        if let Ok(live) = self.live.lock() {
            if let Some(live) = live.as_ref() {
                live.context.active.store(false, Ordering::SeqCst);
            }
        }
    }

    pub async fn shutdown(&self, handle: &AppHandle) -> std::result::Result<(), String> {
        self.suspended.store(true, Ordering::SeqCst);
        if let Some(live) = self.lock(&self.live)?.as_ref() {
            live.context.active.store(false, Ordering::SeqCst);
        }
        let deadline = Instant::now() + OWNERSHIP_WAIT;
        while self.maintenance.load(Ordering::SeqCst) && Instant::now() < deadline {
            tokio::time::sleep(OWNERSHIP_POLL).await;
        }
        if self.maintenance.load(Ordering::SeqCst) {
            return Err("Database maintenance is still completing. The profile is locked.".into());
        }
        self.teardown(handle).await?;
        // A previous teardown may have retired its live context. Repeated lock
        // attempts must still wait for that context's jobs before switching.
        while self.has_outstanding_jobs()? && Instant::now() < deadline {
            tokio::time::sleep(OWNERSHIP_POLL).await;
        }
        if self.has_outstanding_jobs()? {
            return Err(
                "The profile is locked; background database work is still completing.".into(),
            );
        }
        self.wait_for_pool_release(deadline).await?;
        *self.lock(&self.owner)? = None;
        Ok(())
    }

    pub fn app_data_dir(&self) -> &str {
        &self.app_data_dir
    }

    fn check_state(&self) -> std::result::Result<(), DatabaseUnavailable> {
        if self.live.is_poisoned()
            || self.owner.is_poisoned()
            || self.startup_error.is_poisoned()
            || self.retired_contexts.is_poisoned()
        {
            return Err(DatabaseUnavailable::StatePoisoned);
        }
        Ok(())
    }

    // The policy is shared by every runtime lock: never reuse a partially
    // completed transition, including when a different runtime lock was poisoned.
    fn lock<'a, T>(
        &self,
        mutex: &'a Mutex<T>,
    ) -> std::result::Result<MutexGuard<'a, T>, DatabaseUnavailable> {
        self.check_state()?;
        mutex.lock().map_err(|_| DatabaseUnavailable::StatePoisoned)
    }

    pub fn startup_status(&self) -> DatabaseStartupStatus {
        self.try_startup_status()
            .unwrap_or_else(|error| DatabaseStartupStatus {
                generation: None,
                ready: false,
                maintenance: self.maintenance.load(Ordering::SeqCst),
                error: Some(error.to_string()),
                can_recover: false,
                recovery_encrypted: None,
            })
    }

    fn try_startup_status(
        &self,
    ) -> std::result::Result<DatabaseStartupStatus, DatabaseUnavailable> {
        let maintenance = self.maintenance.load(Ordering::SeqCst);
        let (ready, generation) = {
            let live = self.lock(&self.live)?;
            (
                live.is_some() && !maintenance,
                live.as_ref().map(|live| live.generation),
            )
        };
        let error = self.lock(&self.startup_error)?.clone();
        let can_recover = !ready
            && error.is_some()
            && self.lock(&self.owner)?.is_some()
            && !self.maintenance.load(Ordering::SeqCst);
        let path = self.db_path.clone();
        let recovery_encrypted = can_recover.then(|| {
            db::recovery::requires_encryption(
                std::path::Path::new(&path),
                encryption_marker(&path).exists(),
            )
        });
        Ok(DatabaseStartupStatus {
            generation,
            ready,
            maintenance,
            error,
            can_recover,
            recovery_encrypted,
        })
    }

    /// Import inspection can run without an open database after startup failed,
    /// but still participates in the runtime's file-job admission proof.
    pub fn import_lease(&self) -> std::result::Result<Arc<()>, String> {
        self.check_available()?;
        // Share the live-state lock with teardown/recovery admission so a lease
        // cannot appear after their final outstanding-job check.
        let live = self.lock(&self.live)?;
        if self.maintenance.load(Ordering::SeqCst) {
            return Err(DatabaseUnavailable::Maintenance.to_string());
        }
        if live.is_none()
            && (self.lock(&self.startup_error)?.is_none() || self.lock(&self.owner)?.is_none())
        {
            return Err(DatabaseUnavailable::NotInitialized.to_string());
        }
        Ok(Arc::clone(&self.file_jobs))
    }

    pub fn retained_key(&self) -> std::result::Result<Option<Arc<DbEncryptionKey>>, String> {
        self.check_available()?;
        if let Some(key) = self
            .current_access()?
            .and_then(|access| access.key().cloned())
        {
            return Ok(Some(key));
        }
        // Plaintext and password-protected backups do not need the installation
        // key. Snapshot inspection already reports encrypted files unavailable
        // when their original key cannot be read.
        match self.key_provider.existing() {
            Ok(key) => Ok(key.map(Arc::new)),
            Err(error) => {
                warn!("Could not read the installation key for backups: {error}");
                Ok(None)
            }
        }
    }

    /// The live services.
    ///
    /// Commands call this at the top of their body; the returned clone keeps the
    /// context alive for the duration of the call, which is why maintenance
    /// aborts rather than proceeding while a command is in flight.
    pub fn context(&self) -> std::result::Result<Arc<ServiceContext>, DatabaseUnavailable> {
        self.check_available()?;
        if self.maintenance.load(Ordering::SeqCst) {
            return Err(DatabaseUnavailable::Maintenance);
        }
        self.lock(&self.live)?
            .as_ref()
            .map(|live| Arc::clone(&live.context))
            .ok_or(DatabaseUnavailable::NotInitialized)
    }

    /// The context if the runtime is up, for callers that must degrade rather
    /// than fail (event listeners, shutdown hooks).
    pub fn try_context(&self) -> Option<Arc<ServiceContext>> {
        self.context().ok()
    }

    /// Where the database is and how it is encrypted, for commands that open the
    /// file directly rather than going through a service — backups, mainly.
    ///
    /// Gated exactly like [`DatabaseRuntime::context`]: a backup started while
    /// the file is being replaced would pass its own open, then keep reading the
    /// outgoing inode after the rename and silently save stale data.
    pub fn access(&self) -> std::result::Result<DatabaseFileAccess, DatabaseUnavailable> {
        self.check_available()?;
        if self.maintenance.load(Ordering::SeqCst) {
            return Err(DatabaseUnavailable::Maintenance);
        }
        let live = self.lock(&self.live)?;
        let live = live.as_ref().ok_or(DatabaseUnavailable::NotInitialized)?;
        Ok(DatabaseFileAccess {
            access: live.access.clone(),
            _lease: Arc::clone(&self.file_jobs),
        })
    }

    /// The database location regardless of the gate, for status reads and for
    /// maintenance itself, which runs *inside* the gate.
    ///
    /// `None` once the runtime is down: there is then no database this process
    /// is serving, and answering with the last one it served would be a guess.
    fn current_access(&self) -> std::result::Result<Option<DbAccess>, DatabaseUnavailable> {
        Ok(self
            .lock(&self.live)?
            .as_ref()
            .map(|live| live.access.clone()))
    }

    /// Whether the database file is currently encrypted. This is the truth the
    /// UI should show — the `app_settings` flag only records intent.
    pub fn is_encrypted(&self) -> std::result::Result<bool, DatabaseUnavailable> {
        Ok(self
            .current_access()?
            .map(|access| access.is_encrypted())
            .unwrap_or(false))
    }

    /// Opens the database and brings the runtime up.
    ///
    /// This is the whole of startup's database logic: probe `app.db`, build the
    /// services, start the workers. It never looks for candidate files or
    /// pending markers, because maintenance always runs to completion before the
    /// restart that follows it.
    pub async fn initialize(
        &self,
        handle: &AppHandle,
    ) -> std::result::Result<Arc<ServiceContext>, String> {
        let result = self.initialize_inner(handle, true).await;
        *self.lock(&self.startup_error)? = result.as_ref().err().cloned();
        result
    }

    async fn initialize_inner(
        &self,
        handle: &AppHandle,
        purge_staging: bool,
    ) -> std::result::Result<Arc<ServiceContext>, String> {
        self.check_state()?;
        self.check_available()?;
        let db_path = self.db_path.clone();
        std::fs::create_dir_all(&self.app_data_dir).map_err(|e| e.to_string())?;
        {
            let mut owner = self.lock(&self.owner)?;
            if owner.is_none() {
                *owner = Some(Arc::new(
                    DatabaseOwner::acquire(&db_path).map_err(|e| e.to_string())?,
                ));
            }
        }

        // Ownership is already held and workers have not started, so abandoned
        // snapshots can be cleared without deleting an in-flight operation's files.
        if purge_staging {
            db::purge_scratch_dir(
                std::path::Path::new(&db_path),
                std::path::Path::new(&self.app_data_dir),
            );
        }

        // Native apps are opt-in: a database that does not exist yet is
        // created plaintext, and only the explicit enable path mints a key.
        // Unless the user already opted in — a database that has gone missing
        // must not come back plaintext underneath them. The policy applies to
        // nothing else: an existing file is always resolved by probing.
        let policy = if encryption_marker(&db_path).exists() {
            EncryptionPolicy::Encrypted
        } else {
            EncryptionPolicy::Plaintext
        };

        let access = db::bootstrap(&db_path, self.key_provider.as_ref(), policy)
            .map_err(|e| e.to_string())?;

        self.install(handle, access).await
    }

    /// Retry startup without removing the immutable previews staged since the
    /// first attempt. App ownership and file-job admission still apply.
    pub async fn retry_startup(
        self: &Arc<Self>,
        handle: &AppHandle,
    ) -> std::result::Result<(), String> {
        let handle = handle.clone();
        let runtime = self.clone();
        tauri::async_runtime::spawn(async move {
            runtime.check_available()?;
            if runtime
                .maintenance
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
            {
                return Err(DatabaseUnavailable::Maintenance.to_string());
            }
            let _gate = MaintenanceGate(&runtime.maintenance, None).notifying(&handle);
            {
                let live = runtime.lock(&runtime.live)?;
                if live.is_some() {
                    return Ok(());
                }
                if runtime.lock(&runtime.startup_error)?.is_none()
                    || runtime.has_outstanding_jobs()?
                    || runtime.has_pool_users()?
                {
                    return Err("Database startup or backup inspection is still running.".into());
                }
            }
            let result = runtime.initialize_inner(&handle, false).await;
            *runtime.lock(&runtime.startup_error)? = result.as_ref().err().cloned();
            result.map(|_| ())
        })
        .await
        .map_err(|e| format!("Database startup task failed: {e}"))?
    }

    async fn install(
        &self,
        handle: &AppHandle,
        access: DbAccess,
    ) -> std::result::Result<Arc<ServiceContext>, String> {
        let owner = self
            .lock(&self.owner)?
            .clone()
            .ok_or_else(|| "Database ownership is not available.".to_string())?;
        let init = initialize_context(
            &self.app_data_dir,
            &access,
            owner,
            self.profile_id,
            self.secret_store.clone(),
            self.sync_state.clone(),
        )
        .await
        .map_err(|e| e.to_string())?;

        let context = Arc::new(init.context);
        if let Some(registry) = &self.profile_registry {
            context
                .connect_service()
                .set_profile_binding(registry.clone(), self.profile_id);
        }
        match context.settings_service().requires_cloud_reconnect() {
            Ok(true) => {
                if let Err(error) =
                    wealthfolio_connect::clear_restored_sync_identity(self.secret_store.as_ref())
                {
                    warn!("Cloud reconnection remains required: {error}");
                }
            }
            Err(error) => warn!("Could not read cloud reconnection policy: {error}"),
            Ok(false) => {}
        }
        // If another transition failed while context construction was awaiting,
        // stop its writer before returning; never leave an uninstalled writer running.
        let error = {
            match self.lock(&self.live) {
                Ok(_) if self.suspended.load(Ordering::SeqCst) => "PROFILE_LOCKED".to_string(),
                Ok(mut live) => {
                    let mut workers = start_workers(
                        handle,
                        &context,
                        init.event_receiver,
                        init.sync_outbox_wake_receiver,
                    );
                    if let Some(rebuild) = init.final_cash_rebuild {
                        workers.push(tauri::async_runtime::spawn(rebuild));
                    }
                    self.record_encryption_state(&access);
                    *live = Some(Live {
                        generation: uuid::Uuid::new_v4(),
                        access,
                        context: Arc::clone(&context),
                        writer: init.writer,
                        writer_task: init.writer_task,
                        workers,
                    });
                    return Ok(context);
                }
                Err(error) => error.to_string(),
            }
        };
        init.writer.shutdown().await;
        init.writer_task.join().await;
        Err(error.to_string())
    }

    /// Real services for IPC tests, without starting native windows or background workers.
    #[cfg(test)]
    pub(crate) async fn initialize_for_test(&self) {
        std::fs::create_dir_all(&self.app_data_dir).unwrap();
        let owner = Arc::new(DatabaseOwner::acquire(&self.db_path).unwrap());
        let access = DbAccess::plaintext(&self.db_path);
        let init = initialize_context(
            &self.app_data_dir,
            &access,
            owner.clone(),
            self.profile_id,
            self.secret_store.clone(),
            self.sync_state.clone(),
        )
        .await
        .unwrap();
        *self.owner.lock().unwrap() = Some(owner);
        *self.live.lock().unwrap() = Some(Live {
            generation: uuid::Uuid::new_v4(),
            access,
            context: Arc::new(init.context),
            writer: init.writer,
            writer_task: init.writer_task,
            workers: vec![],
        });
    }

    #[cfg(test)]
    pub(crate) async fn shutdown_for_test(&self) {
        let live = self.live.lock().unwrap().take().unwrap();
        live.writer.shutdown().await;
        live.writer_task.join().await;
    }

    /// Records on disk whether the database this runtime just opened is
    /// encrypted, so that [`DatabaseRuntime::initialize`] can honour the user's
    /// choice when the database file itself is gone.
    ///
    /// The retained key cannot stand in for this. It is deliberately kept after
    /// encryption is disabled, so its presence says nothing about what the user
    /// asked for — a key beside a plaintext database is a normal state.
    ///
    /// Best effort: a marker that cannot be written must not fail an operation
    /// that has otherwise succeeded. It is also rewritten from the observed
    /// state on every open, so a marker that disagrees with the file corrects
    /// itself rather than compounding.
    fn record_encryption_state(&self, access: &DbAccess) {
        let marker = encryption_marker(&self.db_path.clone());
        let result = if access.is_encrypted() {
            std::fs::write(&marker, b"")
        } else {
            match std::fs::remove_file(&marker) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                other => other,
            }
        };

        if let Err(e) = result {
            warn!(
                "Failed to record the database encryption state at {}: {}",
                marker.display(),
                e
            );
        }
    }

    /// Runs a maintenance operation: tear the runtime down, replace the database
    /// file, then bring the runtime back up.
    ///
    /// The runtime is rebuilt on both the success and the failure path. A
    /// rollback that leaves no live context would strand the app with no
    /// database at all, which is worse than the failure it recovered from.
    pub async fn run_maintenance(
        self: &Arc<Self>,
        handle: &AppHandle,
        prepare: impl FnOnce(&Self) -> std::result::Result<MaintenanceRequest, String> + Send + 'static,
    ) -> std::result::Result<MaintenanceOutcome, String> {
        // The caller may close its window or cancel IPC while a blocking copy
        // runs. Keep the gate, teardown and rebuild owned by the app task.
        let handle = handle.clone();
        let runtime = self.clone();
        tauri::async_runtime::spawn(
            async move { runtime.run_owned_maintenance(&handle, prepare).await },
        )
        .await
        .map_err(|error| format!("Database maintenance task failed: {error}"))?
    }

    async fn run_owned_maintenance(
        &self,
        handle: &AppHandle,
        prepare: impl FnOnce(&Self) -> std::result::Result<MaintenanceRequest, String>,
    ) -> std::result::Result<MaintenanceOutcome, String> {
        self.check_available()?;
        let (_gate, request) = self.prepare_maintenance(Some(handle), prepare)?;
        let result = self.run_maintenance_inner(handle, request).await;
        self.record_maintenance_error(result.as_ref().err().map(String::as_str))?;
        result
    }

    fn prepare_maintenance<'a>(
        &'a self,
        handle: Option<&'a AppHandle>,
        prepare: impl FnOnce(&Self) -> std::result::Result<MaintenanceRequest, String>,
    ) -> std::result::Result<(MaintenanceGate<'a>, MaintenanceRequest), String> {
        if self
            .maintenance
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("Database maintenance is already in progress.".to_string());
        }
        // Clear the gate on every exit, including a panic: leaving it set would
        // reject database work for the rest of the process's life.
        let gate = MaintenanceGate(&self.maintenance, handle);
        // Preparation can block or fail (for example, a keychain prompt).
        // Notify before it starts so every observed busy state has an end event.
        gate.notify();

        // Preparation may persist a new encryption key. Reject overlapping
        // requests before either can change the key used by the other.
        let request = prepare(self)?;
        Ok((gate, request))
    }

    fn record_maintenance_error(
        &self,
        error: Option<&str>,
    ) -> std::result::Result<(), DatabaseUnavailable> {
        // A failed restore can leave no live services even though initial startup
        // succeeded. Expose that state to the same recovery UI and import guard.
        let unavailable = self.lock(&self.live)?.is_none();
        *self.lock(&self.startup_error)? = if unavailable {
            error.map(str::to_owned)
        } else {
            None
        };
        Ok(())
    }

    async fn run_maintenance_inner(
        &self,
        handle: &AppHandle,
        request: MaintenanceRequest,
    ) -> std::result::Result<MaintenanceOutcome, String> {
        let access = self
            .current_access()?
            .ok_or_else(|| DatabaseUnavailable::NotInitialized.to_string())?;

        let replaces_database = matches!(&request, MaintenanceRequest::Restore { .. });
        let outcome = match self.teardown(handle).await {
            // Two whole-database copies and an integrity scan: seconds to
            // minutes on a large portfolio, and every byte of it blocking file
            // and SQL I/O. On the async runtime it would stall the worker it
            // landed on, including the event that tells the UI what is
            // happening and the fast rejection other commands are waiting for.
            Ok(()) => {
                let app_data_dir = self.app_data_dir.clone();
                let source = access.clone();
                let owner = self
                    .lock(&self.owner)?
                    .clone()
                    .ok_or_else(|| "Database ownership is not available.".to_string())?;
                tauri::async_runtime::spawn_blocking(move || {
                    maintenance::run(&app_data_dir, &source, request, &owner)
                })
                .await
                .map_err(|e| format!("Database maintenance task failed: {e}"))?
                .map_err(|e: Error| e.to_string())
            }
            Err(e) => Err(e),
        };

        let previous_sync_state = (replaces_database && outcome.is_ok())
            .then(|| self.sync_state.take_for_database_replacement());
        let next_access = match &outcome {
            Ok(outcome) => outcome.access.clone(),
            Err(_) => access.clone(),
        };
        if self.suspended.load(Ordering::SeqCst) {
            self.record_encryption_state(&next_access);
            return outcome;
        }
        if let Err(rebuild_error) = self.install(handle, next_access.clone()).await {
            error!("Failed to rebuild the database runtime: {}", rebuild_error);
            if let Ok(completed) = &outcome {
                if let Some(backup) = &completed.pre_operation_backup {
                    self.wait_for_pool_release(Instant::now() + OWNERSHIP_WAIT)
                        .await?;
                    // Construction failure stops and joins its writer before
                    // returning. No background work starts on that path.
                    let owner = self
                        .lock(&self.owner)?
                        .clone()
                        .ok_or_else(|| "Database ownership is not available.".to_string())?;
                    let backup = backup.clone();
                    let original = access.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        maintenance::rollback_after_rebuild(
                            &next_access,
                            &original,
                            &backup,
                            &owner,
                        )
                    })
                    .await
                    .map_err(|e| format!("Database rollback task failed: {e}"))?
                    .map_err(|e| {
                        format!("Database rebuild failed ({rebuild_error}); rollback failed: {e}")
                    })?;
                    if let Some(previous) = previous_sync_state {
                        self.sync_state.restore_after_database_rollback(previous);
                    }
                    self.install(handle, access).await.map_err(|e| format!(
                        "The previous database was restored, but its services could not restart: {e}. Restart the application."
                    ))?;
                    return Err(format!("The database could not be reopened: {rebuild_error}. The previous database was restored."));
                }
            }
            if let Err(e) = outcome {
                error!("Maintenance had already failed: {}", e);
                return Err(format!(
                    "Database maintenance failed: {e}. The database could not be reopened: {rebuild_error}."
                ));
            }
            return Err(format!(
                "The database could not be reopened after maintenance: {rebuild_error}. \
                 Restart the application."
            ));
        }

        outcome
    }

    /// Releases every handle on the database, in the order that makes the
    /// ownership proof meaningful.
    async fn teardown(&self, handle: &AppHandle) -> std::result::Result<(), String> {
        let live = self.lock(&self.live)?.take();
        let Some(live) = live else {
            // Nothing was installed, so no worker can be starting a server right
            // now. Still stop one, in case an earlier teardown left it running.
            crate::mcp::stop_server(handle).await;
            return Ok(());
        };
        let Live {
            generation: _,
            access: _,
            context,
            writer,
            writer_task,
            workers,
        } = live;

        // Aborting drops each task's future, which is what releases the context
        // and service clones it captured. Awaiting each handle is what makes the
        // next step correct: once this loop ends, no task is still starting.
        for worker in workers {
            worker.abort();
            let _ = worker.await;
        }

        // A restore in progress starts engine and portfolio work; stop it before
        // stopping those. A replacement already handed to the writer still commits.
        #[cfg(feature = "device-sync")]
        context.device_sync_runtime().clear_restore().await;

        // Portfolio requests can outlive their caller; join them before closing the writer.
        context.portfolio_tasks.stop().await;

        // Startup and outbox workers can start the engine, so stop and join
        // them first. Then wait for the engine to release its own services.
        #[cfg(feature = "device-sync")]
        {
            let _guard = context.sync_lifecycle.lock().await;
            context
                .device_sync_runtime()
                .ensure_background_stopped()
                .await;
        }

        // The MCP server holds service clones — and therefore pool clones — that
        // do not travel through the context, so it must be stopped explicitly.
        //
        // *After* the workers, never before: one of them is the task that starts
        // this server. Stopping first leaves that task free to finish starting
        // one afterwards, and the server it records is not reachable from
        // `context`, so the ownership proof below would not see it either.
        crate::mcp::stop_server(handle).await;

        // The write actor takes a pooled connection at spawn and holds it for the
        // life of its task, and its pool handle is an independent clone that the
        // context does not own — so dropping the context would not release it.
        // Stopping it *before* the ownership check is not optional: doing it
        // after would mean the check can never pass.
        writer.shutdown().await;
        writer_task.join().await;

        // A command that entered before the gate was set still holds a clone and
        // may be awaiting a slow query. Give it a bounded moment to finish
        // rather than failing an operation the user just confirmed.
        let deadline = Instant::now() + OWNERSHIP_WAIT;
        while (Arc::strong_count(&context) > 1 || self.has_outstanding_jobs()?)
            && Instant::now() < deadline
        {
            tokio::time::sleep(OWNERSHIP_POLL).await;
        }

        // Keep timed-out contexts tracked across rebuilds. Otherwise a retry
        // would count only the new context while an older command still runs.
        if Arc::strong_count(&context) > 1 || self.has_outstanding_jobs()? {
            self.lock(&self.retired_contexts)?.push(context);
            return Err(
                "Database maintenance aborted: another part of the app is still using the \
             database. The database file was not replaced, but an operation that was \
             running may need to be retried. Wait for it to finish and try again."
                    .to_string(),
            );
        }
        drop(context);

        self.wait_for_pool_release(deadline).await
    }

    // The pool retains this existing owner in its r2d2 customizer. Unlike a
    // context count, this also sees raw pool clones and nested blocking jobs.
    fn has_pool_users(&self) -> std::result::Result<bool, DatabaseUnavailable> {
        Ok(self
            .lock(&self.owner)?
            .as_ref()
            .is_some_and(|owner| Arc::strong_count(owner) > 1))
    }

    async fn wait_for_pool_release(&self, deadline: Instant) -> std::result::Result<(), String> {
        while self.has_pool_users()? && Instant::now() < deadline {
            tokio::time::sleep(OWNERSHIP_POLL).await;
        }
        if self.has_pool_users()? {
            return Err("Background database work is still running. Wait for it to finish before retrying database maintenance.".into());
        }
        Ok(())
    }

    fn has_outstanding_jobs(&self) -> std::result::Result<bool, DatabaseUnavailable> {
        let mut retired = self.lock(&self.retired_contexts)?;
        retired.retain(|context| Arc::strong_count(context) > 1);
        Ok(Arc::strong_count(&self.file_jobs) > 1 || !retired.is_empty())
    }

    /// The validated candidate and its quota remain owned by the restore task,
    /// even if the confirmation IPC caller disappears.
    pub async fn restore_validated_import(
        self: &Arc<Self>,
        handle: &AppHandle,
        id: uuid::Uuid,
    ) -> std::result::Result<(), String> {
        let handle = handle.clone();
        let runtime = self.clone();
        tauri::async_runtime::spawn(async move {
            let candidate = runtime
                .backup_imports
                .take(id, "native")
                .map_err(|e| e.to_string())?;
            let request = MaintenanceRequest::Restore {
                backup_path: std::path::PathBuf::from(candidate.backup.access.path()),
                device_key: candidate.backup.access.key().cloned(),
            };
            let result = runtime
                .run_owned_maintenance(&handle, |_| Ok(request))
                .await;
            drop(candidate);
            result?;
            crate::commands::utilities::finish_database_maintenance(&handle, "database-restored")
        })
        .await
        .map_err(|error| format!("Database restore task failed: {error}"))?
    }

    pub async fn recover_validated_import(
        self: &Arc<Self>,
        handle: &AppHandle,
        id: uuid::Uuid,
    ) -> std::result::Result<(), String> {
        let handle = handle.clone();
        let runtime = self.clone();
        tauri::async_runtime::spawn(async move {
            runtime.check_available()?;
            if !runtime.startup_status().can_recover {
                return Err("Recovery is only available after database startup fails.".into());
            }
            if runtime.maintenance.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
                return Err(DatabaseUnavailable::Maintenance.to_string());
            }
            let _gate = MaintenanceGate(&runtime.maintenance, None).notifying(&handle);
            {
                let live = runtime.lock(&runtime.live)?;
                if live.is_some() || runtime.has_outstanding_jobs()? || runtime.has_pool_users()? {
                    return Err("Wait for background database work or backup inspection to finish before recovery.".into());
                }
            }
            let candidate = runtime.backup_imports.take(id, "native").map_err(|e| e.to_string())?;
            let path = runtime.db_path.clone();
            let encrypted = db::recovery::requires_encryption(std::path::Path::new(&path), encryption_marker(&path).exists());
            let key = if encrypted {
                Some(Arc::new(runtime.key_provider.create().map_err(|e| e.to_string())?))
            } else { None };
            let owner = runtime.lock(&runtime.owner)?.clone()
                .ok_or_else(|| "Database ownership is not available.".to_string())?;
            let recovered = tauri::async_runtime::spawn_blocking(move || {
                // The candidate survives cancellation and every file copy.
                let result = db::recovery::install_recovery(&candidate.backup.access,
                    std::path::Path::new(&path), key, &owner);
                drop(candidate);
                result
            }).await.map_err(|e| format!("Database recovery task failed: {e}"))?
                .map_err(|e| e.to_string())?;
            runtime.sync_state.clear();
            info!("Original database files preserved in {}", recovered.preserved_directory.display());
            if let Err(error) = runtime.install(&handle, recovered.access).await {
                *runtime.lock(&runtime.startup_error)? = Some(error.clone());
                return Err(format!("The backup was installed but could not be opened: {error}. Original files are preserved in {}", recovered.preserved_directory.display()));
            }
            *runtime.lock(&runtime.startup_error)? = None;
            drop(_gate);
            crate::commands::utilities::finish_database_maintenance(&handle, "database-restored")
        }).await.map_err(|e| format!("Database recovery task failed: {e}"))?
    }

    /// Enables at-rest encryption, minting the device key if it does not exist.
    ///
    /// The key is stored *before* the candidate is built. If any later step
    /// fails the key is kept: the database is still plaintext, detection falls
    /// through to the unkeyed open, and the operation is safe to retry.
    pub async fn enable_encryption(
        self: &Arc<Self>,
        handle: &AppHandle,
    ) -> std::result::Result<MaintenanceOutcome, String> {
        self.run_maintenance(handle, |runtime| {
            let access = runtime
                .current_access()?
                .ok_or_else(|| DatabaseUnavailable::NotInitialized.to_string())?;
            if access.is_encrypted() {
                return Err("The database is already encrypted.".to_string());
            }

            let key = runtime
                .key_provider
                .create()
                .map_err(|e: Error| format!("Failed to prepare the database key: {e}"))?;

            Ok(MaintenanceRequest::Enable { key: Arc::new(key) })
        })
        .await
    }

    /// Disables at-rest encryption. The key stays in the keychain permanently,
    /// so encrypted backups taken before this point remain openable and a later
    /// re-enable reuses the same key.
    pub async fn disable_encryption(
        self: &Arc<Self>,
        handle: &AppHandle,
    ) -> std::result::Result<MaintenanceOutcome, String> {
        let access = self
            .current_access()?
            .ok_or_else(|| DatabaseUnavailable::NotInitialized.to_string())?;
        if !access.is_encrypted() {
            return Err("The database is not encrypted.".to_string());
        }

        self.run_maintenance(handle, |_| Ok(MaintenanceRequest::Disable))
            .await
    }
}

/// Clears the maintenance gate when it goes out of scope.
struct MaintenanceGate<'a>(&'a AtomicBool, Option<&'a AppHandle>);

impl<'a> MaintenanceGate<'a> {
    fn notifying(mut self, handle: &'a AppHandle) -> Self {
        self.1 = Some(handle);
        self.notify();
        self
    }

    fn notify(&self) {
        if let Some(handle) = self.1 {
            if let Err(error) = handle.emit(crate::events::DATABASE_STATE_CHANGED, ()) {
                warn!("Failed to notify database state change: {error}");
            }
        }
    }
}

impl Drop for MaintenanceGate<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
        self.notify();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Background workers
// ─────────────────────────────────────────────────────────────────────────────

/// Spawns every long-lived task that holds a context or service clone, and
/// returns their handles so maintenance can stop them.
///
/// Anything spawned here without its handle being returned would keep a pool
/// clone alive and make the zero-connection proof fail.
fn start_workers(
    handle: &AppHandle,
    context: &Arc<ServiceContext>,
    event_receiver: tokio::sync::mpsc::UnboundedReceiver<DomainEvent>,
    #[allow(unused_variables)] sync_outbox_wake_receiver: tokio::sync::mpsc::Receiver<()>,
) -> Vec<JoinHandle<()>> {
    let mut workers = Vec::new();

    #[cfg(feature = "device-sync")]
    workers.push(crate::start_sync_outbox_wake_worker(
        sync_outbox_wake_receiver,
        Arc::clone(context),
    ));

    workers.push(
        crate::domain_events::TauriDomainEventSink::start_queue_worker(
            event_receiver,
            handle.clone(),
            Arc::clone(context),
        ),
    );

    {
        let startup_handle = handle.clone();
        let startup_context = Arc::clone(context);
        workers.push(tauri::async_runtime::spawn(async move {
            crate::scheduler::run_startup_sync(&startup_handle, &startup_context).await;
        }));
    }

    #[cfg(desktop)]
    {
        let mcp_handle = handle.clone();
        let mcp_context = Arc::clone(context);
        workers.push(tauri::async_runtime::spawn(async move {
            crate::mcp::start_if_enabled(&mcp_handle, &mcp_context).await;
        }));

        // Periodic market data sync (6h interval, 2min initial delay).
        let periodic_quote_service = Arc::clone(&context.quote_service);
        workers.push(tauri::async_runtime::spawn(async move {
            wealthfolio_core::quotes::scheduler::run_periodic_sync(
                periodic_quote_service,
                std::time::Duration::from_secs(120),
                std::time::Duration::from_secs(6 * 3600),
            )
            .await;
        }));
    }

    // Background device sync engine (self-skips when the device is not READY).
    #[cfg(feature = "device-sync")]
    {
        let device_sync_context = Arc::clone(context);
        workers.push(tauri::async_runtime::spawn(async move {
            if let Err(err) =
                crate::commands::device_sync::ensure_background_engine_started(device_sync_context)
                    .await
            {
                warn!("Failed to start background device sync engine: {}", err);
            }
        }));
    }

    workers
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    fn runtime() -> DatabaseRuntime {
        DatabaseRuntime::new("/tmp/wealthfolio-test".to_string())
    }

    #[test]
    fn poisoned_runtime_rejects_access_and_reports_restart_without_panicking() {
        for field in 0..4 {
            let runtime = runtime();
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match field {
                0 => {
                    let _guard = runtime.live.lock().unwrap();
                    panic!("live transition");
                }
                1 => {
                    let _guard = runtime.owner.lock().unwrap();
                    panic!("ownership transition");
                }
                2 => {
                    let _guard = runtime.startup_error.lock().unwrap();
                    panic!("status transition");
                }
                _ => {
                    let _guard = runtime.retired_contexts.lock().unwrap();
                    panic!("retirement transition");
                }
            }));
            assert_eq!(
                runtime.context().err(),
                Some(DatabaseUnavailable::StatePoisoned)
            );
            assert_eq!(
                runtime.access().err(),
                Some(DatabaseUnavailable::StatePoisoned)
            );
            assert_eq!(
                runtime.is_encrypted().err(),
                Some(DatabaseUnavailable::StatePoisoned)
            );
            assert!(runtime.import_lease().is_err());
            assert!(runtime.retained_key().is_err());
            assert!(runtime.has_pool_users().is_err());
            assert!(runtime.has_outstanding_jobs().is_err());
            let status = runtime.startup_status();
            assert!(!status.ready && !status.can_recover);
            assert!(status.error.unwrap().contains("Restart"));
            assert!(runtime.record_maintenance_error(None).is_err());
        }
    }

    #[tokio::test]
    async fn cancelled_caller_cannot_hide_a_blocking_pool_user_from_maintenance() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = DatabaseRuntime::new(directory.path().to_string_lossy().into_owned());
        let path = runtime.db_path.clone();
        let owner = Arc::new(DatabaseOwner::acquire(&path).unwrap());
        let pool = DbAccess::plaintext(&path)
            .create_pool_with_owner(Arc::clone(&owner))
            .unwrap();
        *runtime.owner.lock().unwrap() = Some(owner);
        // Raw r2d2 clones can outlive every ServiceContext and outer Arc<DbPool>.
        let raw_pool = pool.as_ref().clone();
        drop(pool);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let caller = tokio::spawn(async move {
            tokio::task::spawn_blocking(move || {
                let connection = raw_pool.get().unwrap();
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                drop(connection);
            })
            .await
            .unwrap();
        });
        started_rx.await.unwrap();
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        assert!(runtime.wait_for_pool_release(Instant::now()).await.is_err());
        release_tx.send(()).unwrap();
        runtime
            .wait_for_pool_release(Instant::now() + OWNERSHIP_WAIT)
            .await
            .unwrap();
        assert!(!runtime.has_pool_users().unwrap());
    }

    #[test]
    fn failed_startup_inspection_requires_ownership_and_obeys_maintenance() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = DatabaseRuntime::new(directory.path().to_string_lossy().into_owned());
        assert!(!runtime.startup_status().can_recover);
        assert!(runtime.import_lease().is_err());
        *runtime.startup_error.lock().unwrap() = Some("missing device key".into());
        assert!(!runtime.startup_status().can_recover);
        let path = runtime.db_path.clone();
        *runtime.owner.lock().unwrap() = Some(Arc::new(DatabaseOwner::acquire(&path).unwrap()));
        assert!(runtime.startup_status().can_recover);
        assert_eq!(runtime.startup_status().recovery_encrypted, Some(false));
        std::fs::write(encryption_marker(&path), b"").unwrap();
        assert_eq!(runtime.startup_status().recovery_encrypted, Some(true));
        let lease = runtime.import_lease().unwrap();
        assert!(runtime.has_outstanding_jobs().unwrap());
        runtime.maintenance.store(true, Ordering::SeqCst);
        assert!(!runtime.startup_status().can_recover);
        assert!(runtime.import_lease().is_err());
        drop(lease);
        assert!(!runtime.has_outstanding_jobs().unwrap());
    }

    #[test]
    fn failed_live_maintenance_exposes_recovery_after_teardown() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = DatabaseRuntime::new(directory.path().to_string_lossy().into_owned());
        let path = runtime.db_path.clone();
        *runtime.owner.lock().unwrap() = Some(Arc::new(DatabaseOwner::acquire(&path).unwrap()));
        runtime.maintenance.store(true, Ordering::SeqCst);
        runtime
            .record_maintenance_error(Some("Restored services and rollback could not reopen"))
            .unwrap();
        assert!(!runtime.startup_status().can_recover);
        runtime.maintenance.store(false, Ordering::SeqCst);
        let status = runtime.startup_status();
        assert!(!status.ready);
        assert!(status.can_recover);
        assert!(status.error.unwrap().contains("rollback"));
        assert!(runtime.import_lease().is_ok());
        assert!(DatabaseOwner::acquire(&path).is_err());
    }

    /// A key store that accepts writes and keeps them, like a working keychain.
    #[derive(Default)]
    struct FakeSecretStore {
        stored: StdMutex<Option<String>>,
        unreadable: bool,
        /// Drop every write instead of keeping it, like a keyring backend
        /// writing to a collection that does not survive the session.
        forgetful: bool,
    }

    impl SecretStore for FakeSecretStore {
        fn set_secret(&self, _service: &str, secret: &str) -> CoreResult<()> {
            if !self.forgetful {
                *self.stored.lock().unwrap() = Some(secret.to_string());
            }
            Ok(())
        }

        fn get_secret(&self, _service: &str) -> CoreResult<Option<String>> {
            if self.unreadable {
                return Err(Error::Database(DatabaseError::Encryption(
                    "The keychain is unavailable".into(),
                )));
            }
            Ok(self.stored.lock().unwrap().clone())
        }

        fn delete_secret(&self, _service: &str) -> CoreResult<()> {
            *self.stored.lock().unwrap() = None;
            Ok(())
        }
    }

    #[tokio::test]
    async fn cancelled_backup_caller_does_not_release_the_running_file_job() {
        let runtime = runtime();
        let access = DatabaseFileAccess {
            access: DbAccess::plaintext("/unused.db"),
            _lease: Arc::clone(&runtime.file_jobs),
        };
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let job = tokio::task::spawn_blocking(move || {
            started_tx.send(()).unwrap();
            finish_rx.recv().unwrap();
            drop(access);
            done_tx.send(()).unwrap();
        });
        started_rx.await.unwrap();
        job.abort(); // A running blocking task continues after caller cancellation.
        drop(job);
        assert!(runtime.has_outstanding_jobs().unwrap());
        runtime.maintenance.store(true, Ordering::SeqCst);
        assert!(runtime.has_outstanding_jobs().unwrap());
        finish_tx.send(()).unwrap();
        done_rx.await.unwrap();
        assert!(!runtime.has_outstanding_jobs().unwrap());
    }

    #[test]
    fn backups_without_an_installation_key_work_when_the_keychain_is_unavailable() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().to_str().unwrap();
        let mut runtime = DatabaseRuntime::new(root.into());
        runtime.key_provider = Arc::new(KeychainKeyProvider::new(Arc::new(FakeSecretStore {
            unreadable: true,
            ..Default::default()
        })));
        let key = runtime.retained_key().unwrap();
        assert!(key.is_none());

        let source = DbAccess::plaintext(db::get_db_path(root));
        source.prepare().unwrap();
        source.run_migrations().unwrap();
        let snapshot =
            db::snapshots::create(&source, root, db::snapshots::SnapshotReason::Manual).unwrap();
        let listed = db::snapshots::list(root, key.clone()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].protection, "unencrypted");
        let lease =
            db::snapshots::acquire(root, snapshot.file_name().unwrap().to_str().unwrap()).unwrap();
        let saved = lease.access(key.clone()).unwrap();

        for password in [None, Some("backup test password")] {
            let exported = db::portable::export(&saved, directory.path(), password).unwrap();
            let prepared = db::portable::prepare_import(
                &exported.path,
                directory.path(),
                password,
                key.clone(),
            )
            .unwrap();
            assert!(prepared.access.connect_rusqlite().is_ok());
        }
    }

    #[test]
    fn a_key_store_that_forgets_the_key_is_caught_before_anything_is_encrypted() {
        // The failure this prevents is unrecoverable: the database would be
        // encrypted with a key that is gone after the restart, and enabling
        // deletes the plaintext pre-operation backup on its way out.
        let provider = KeychainKeyProvider::new(Arc::new(FakeSecretStore {
            forgetful: true,
            ..Default::default()
        }));

        let error = provider.create().expect_err("a lost key must not be used");

        assert!(
            error.to_string().contains("did not keep it"),
            "the user must be told the key store is the problem: {error}"
        );
    }

    #[test]
    fn a_working_key_store_mints_a_key_once_and_reuses_it() {
        let provider = KeychainKeyProvider::new(Arc::new(FakeSecretStore::default()));

        let first = provider.create().expect("mint");
        let second = provider.create().expect("reuse");

        assert_eq!(first.as_hex(), second.as_hex());
        assert_eq!(
            provider
                .existing()
                .unwrap()
                .map(|key| key.as_hex().to_string()),
            Some(first.as_hex().to_string())
        );
    }

    #[test]
    fn overlapping_encryption_requests_are_rejected_before_key_creation() {
        let store = Arc::new(FakeSecretStore::default());
        let mut runtime = runtime();
        runtime.key_provider = Arc::new(KeychainKeyProvider::new(store.clone()));
        let runtime = Arc::new(runtime);
        let first_runtime = Arc::clone(&runtime);
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();

        let first = std::thread::spawn(move || {
            let (_gate, request) = first_runtime
                .prepare_maintenance(None, |runtime| {
                    // Hold the first request before it creates a key, while
                    // the keychain is still empty and a second request enters.
                    started_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                    Ok(MaintenanceRequest::Enable {
                        key: Arc::new(runtime.key_provider.create().unwrap()),
                    })
                })
                .unwrap();
            assert!(first_runtime.maintenance.load(Ordering::SeqCst));
            match request {
                MaintenanceRequest::Enable { key } => key,
                _ => panic!("expected an encryption request"),
            }
        });

        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(store.stored.lock().unwrap().is_none());
        let mut second_prepared = false;
        let second = runtime.prepare_maintenance(None, |runtime| {
            second_prepared = true;
            Ok(MaintenanceRequest::Enable {
                key: Arc::new(runtime.key_provider.create().unwrap()),
            })
        });
        release_tx.send(()).unwrap();
        let first_key = first.join().unwrap();

        assert_eq!(
            second.err().as_deref(),
            Some("Database maintenance is already in progress.")
        );
        assert!(!second_prepared);
        assert_eq!(
            store.stored.lock().unwrap().as_deref(),
            Some(first_key.as_hex())
        );
        assert!(!runtime.maintenance.load(Ordering::SeqCst));

        // A preparation failure must also release the gate for a retry.
        assert!(runtime
            .prepare_maintenance(None, |_| Err("keychain unavailable".into()))
            .is_err());
        assert!(!runtime.maintenance.load(Ordering::SeqCst));
        assert!(runtime
            .prepare_maintenance(None, |_| Ok(MaintenanceRequest::Disable))
            .is_ok());
    }

    #[test]
    fn commands_are_rejected_before_the_database_is_open() {
        assert_eq!(
            runtime().context().err(),
            Some(DatabaseUnavailable::NotInitialized)
        );
    }

    #[test]
    fn a_runtime_that_is_down_describes_no_database() {
        // The location used to live in a second `Option` under its own lock, so
        // a failed rebuild left it answering with the outgoing database while no
        // runtime was serving it. Holding both in `Live` makes that
        // unrepresentable: they are set and cleared in one move.
        let runtime = runtime();

        assert!(runtime.current_access().unwrap().is_none());
        assert!(!runtime.is_encrypted().unwrap());
        assert_eq!(
            runtime.access().err(),
            Some(DatabaseUnavailable::NotInitialized)
        );
        assert_eq!(
            runtime.context().err(),
            Some(DatabaseUnavailable::NotInitialized)
        );
    }

    #[test]
    fn maintenance_mode_rejects_new_database_work() {
        let runtime = runtime();
        runtime.maintenance.store(true, Ordering::SeqCst);

        assert_eq!(
            runtime.context().err(),
            Some(DatabaseUnavailable::Maintenance)
        );
        assert!(runtime.try_context().is_none());
    }

    #[test]
    fn maintenance_mode_also_rejects_direct_file_access() {
        // Backups open the database file themselves, so they must be gated too:
        // one started mid-replacement would read the outgoing inode.
        let runtime = runtime();
        runtime.maintenance.store(true, Ordering::SeqCst);

        assert_eq!(
            runtime.access().err(),
            Some(DatabaseUnavailable::Maintenance)
        );
    }

    #[test]
    fn the_gate_clears_itself_even_when_the_scope_unwinds() {
        let runtime = runtime();
        runtime.maintenance.store(true, Ordering::SeqCst);

        let unwound = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _gate = MaintenanceGate(&runtime.maintenance, None);
            panic!("maintenance blew up");
        }));

        assert!(unwound.is_err());
        assert!(!runtime.maintenance.load(Ordering::SeqCst));
    }
}
