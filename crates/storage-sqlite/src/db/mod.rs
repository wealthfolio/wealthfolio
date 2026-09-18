#[cfg(test)]
use chrono::Local;
use log::{error, info, warn};
use rusqlite::Connection as RusqliteConnection;
use std::fs;
use std::io;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use diesel::connection::{Connection, SimpleConnection};
use diesel::r2d2;
use diesel::r2d2::{ConnectionManager, Pool, PooledConnection};
use diesel::sqlite::SqliteConnection;
use diesel_migrations::{embed_migrations, EmbeddedMigrations, MigrationHarness};

use wealthfolio_core::errors::{DatabaseError, Error, Result};

use crate::errors::StorageError;

// Keep this invocation in sync with the on-disk migrations directory.
const MIGRATIONS: EmbeddedMigrations = embed_migrations!();
const BACKUP_FILENAME_PREFIX: &str = "wealthfolio_backup_";
const BACKUP_FILENAME_SUFFIX: &str = ".db";
const BACKUP_FILENAME_TIMESTAMP_FORMAT: &str = "%Y%m%d_%H%M%S";

/// SQLCipher's documented key test. Reading `sqlite_master` forces the first
/// page to be decrypted: it errors when the key is wrong and returns a count
/// when the key is right. This is level 1 verification, run on every open.
const KEY_CHECK_SQL: &str = "SELECT count(*) FROM sqlite_master;";

/// The 16-byte header of an unencrypted SQLite file. Used only to word an error
/// message — never as the detection mechanism.
const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";

pub type DbPool = r2d2::Pool<ConnectionManager<SqliteConnection>>;
pub type DbConnection = PooledConnection<ConnectionManager<SqliteConnection>>;

pub mod encryption;
pub mod imports;
pub mod maintenance;
mod ownership;
pub mod portable;
pub mod recovery;
pub mod snapshots;
mod space;
pub mod write_actor;

pub use encryption::{DbEncryptionKey, KeyProvider, NoKeyProvider};
pub use ownership::DatabaseOwner;
pub use write_actor::{WriteHandle, WriterTask};

use encryption::{apply_key, apply_key_rusqlite};

/// How a database that does not exist yet should be created.
///
/// Says nothing about an existing file: its state is always determined by
/// probing, never inferred from policy or from the presence of a key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EncryptionPolicy {
    Plaintext,
    Encrypted,
}

/// Where the application database lives and, when it is encrypted, the key that
/// opens it.
///
/// Cloned into every connection site so that `PRAGMA key` is always the first
/// statement issued on a connection, as SQLCipher requires.
#[derive(Clone)]
pub struct DbAccess {
    path: Arc<str>,
    key: Option<Arc<DbEncryptionKey>>,
}

impl std::fmt::Debug for DbAccess {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DbAccess")
            .field("path", &self.path)
            .field("encrypted", &self.key.is_some())
            .finish()
    }
}

impl DbAccess {
    pub fn plaintext(path: impl AsRef<str>) -> Self {
        Self::new(path, None)
    }

    pub fn encrypted(path: impl AsRef<str>, key: Arc<DbEncryptionKey>) -> Self {
        Self::new(path, Some(key))
    }

    pub fn new(path: impl AsRef<str>, key: Option<Arc<DbEncryptionKey>>) -> Self {
        Self {
            path: Arc::from(path.as_ref()),
            key,
        }
    }

    pub fn path(&self) -> &str {
        &self.path
    }

    pub fn key(&self) -> Option<&Arc<DbEncryptionKey>> {
        self.key.as_ref()
    }

    pub fn is_encrypted(&self) -> bool {
        self.key.is_some()
    }

    /// Opens a Diesel connection with the key applied first (open site 1/2).
    pub fn connect(&self) -> Result<SqliteConnection> {
        let mut conn = SqliteConnection::establish(self.path()).map_err(StorageError::from)?;
        apply_key(&mut conn, self.key.as_deref())?;
        Ok(conn)
    }

    /// Opens a rusqlite connection with the key applied first (open sites 4-6).
    pub fn connect_rusqlite(&self) -> Result<RusqliteConnection> {
        open_rusqlite(self.path(), self.key.as_deref())
    }

    fn connect_existing_rusqlite(&self) -> Result<RusqliteConnection> {
        open_rusqlite_with_flags(
            self.path(),
            self.key.as_deref(),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
    }

    /// Creates the database directory and applies the app's connection pragmas.
    ///
    /// Opening also creates the file when it is missing — encrypted, when a key
    /// is present. That is why detection must never mint a key.
    pub fn prepare(&self) -> Result<()> {
        create_parent_dir(Path::new(self.path()))?;

        let mut conn = self.connect()?;
        conn.batch_execute(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = 30000;
            PRAGMA synchronous  = NORMAL;
        ",
        )
        .map_err(StorageError::from)?;

        Ok(())
    }

    pub fn create_pool(&self) -> Result<Arc<DbPool>> {
        self.create_pool_inner(None)
    }

    /// Retain ownership in r2d2, including raw clones and late connector tasks.
    pub fn create_pool_with_owner(&self, owner: Arc<DatabaseOwner>) -> Result<Arc<DbPool>> {
        owner.check_path(self.path())?;
        self.create_pool_inner(Some(owner))
    }

    fn create_pool_inner(&self, owner: Option<Arc<DatabaseOwner>>) -> Result<Arc<DbPool>> {
        let manager = ConnectionManager::<SqliteConnection>::new(self.path());
        let pool = r2d2::Pool::builder()
            .max_size(8)
            .min_idle(Some(1)) // Keep at least one connection ready
            .connection_timeout(Duration::from_secs(30))
            .connection_customizer(Box::new(ConnectionCustomizer {
                key: self.key.clone(),
                _owner: owner,
            }))
            .build(manager)
            .map_err(|e| DatabaseError::PoolCreationFailed(e.to_string()))?;
        Ok(Arc::new(pool))
    }

    /// Back up an existing database once before applying the pending batch.
    /// The caller must retain ownership until startup has finished.
    pub fn run_migrations_with_backup(
        &self,
        backup_root: &str,
        owner: &DatabaseOwner,
    ) -> Result<()> {
        owner.check_path(self.path())?;
        let conn = self.connect_rusqlite()?;
        // Inspect before Diesel's pending query, which creates its history table
        // if missing. An empty database (including history only) is fresh.
        let existing: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema
                 WHERE name NOT GLOB 'sqlite_*' AND name != '__diesel_schema_migrations')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| DatabaseError::QueryFailed(error.to_string()))?;
        if existing {
            conn.prepare("SELECT version, run_on FROM __diesel_schema_migrations")
                .map_err(|error| DatabaseError::MigrationFailed(format!(
                    "Cannot read migration history for an existing database: {error}. No migrations were run."
                )))?;
        }
        let pending = self
            .connect()?
            .pending_migrations(MIGRATIONS)
            .map_err(|error| DatabaseError::MigrationFailed(error.to_string()))?;
        if pending.is_empty() {
            info!("No pending migrations to apply.");
            return Ok(());
        }

        let backup = if existing {
            // SQLCipher may return page_size as text; SQLite coerces it here.
            let (pages, page_size): (u32, u32) = conn
                .query_row(
                    "SELECT page_count, page_size + 0
                 FROM pragma_page_count(), pragma_page_size()",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(|error| DatabaseError::BackupFailed(error.to_string()))?;
            let bytes = u64::from(pages) * u64::from(page_size);
            drop(conn);
            let directory = Path::new(backup_root).join("backups");
            fs::create_dir_all(&directory).map_err(backup_failed)?;
            space::require(&directory, bytes).map_err(backup_failed)?;
            let path = snapshots::create(
                self,
                backup_root,
                snapshots::SnapshotReason::BeforeMigration,
            )
            .map_err(|error| DatabaseError::BackupFailed(error.to_string()))?;
            info!(
                "Pre-migration backup retained at {} (protection: {})",
                path.display(),
                if self.is_encrypted() {
                    "encrypted"
                } else {
                    "unencrypted"
                },
            );
            Some(path)
        } else {
            drop(conn);
            None
        };

        self.run_migrations().map_err(|error| match backup {
            Some(path) => DatabaseError::MigrationFailed(format!(
                "{error}. Pre-migration backup retained at {}",
                path.display(),
            ))
            .into(),
            None => error,
        })
    }

    /// Low-level runner, also used by disposable import/reference databases.
    pub fn run_migrations(&self) -> Result<()> {
        info!("Running database migrations");
        let mut connection = self.connect()?;

        connection
            .batch_execute(
                "
            PRAGMA journal_mode = WAL;
            PRAGMA busy_timeout = 5000;
            PRAGMA foreign_keys = OFF;
            PRAGMA synchronous = FULL;
            PRAGMA cache_size = -64000;
        ",
            )
            .map_err(StorageError::from)?;

        // Plaintext desktop/server migrations can spill large statement journals
        // and VACUUM scratch databases to disk instead of growing the heap.
        // SQLCipher does not encrypt every transient file: encrypted DBs must
        // keep MEMORY. Preserve mobile behavior too; Android forces it in its
        // SQLite build, and FILE has not been validated on iOS. DEFAULT is also
        // memory in our SQLCipher build, so plaintext must explicitly use FILE.
        // Measurements/rationale: docs/architecture/database-migration-backup-validation.md
        let temp_store =
            if self.is_encrypted() || cfg!(any(target_os = "android", target_os = "ios")) {
                "PRAGMA temp_store = MEMORY;"
            } else {
                "PRAGMA temp_store = FILE;"
            };
        connection
            .batch_execute(temp_store)
            .map_err(StorageError::from)?;

        let migration_result: Result<Vec<String>> = connection
            .run_pending_migrations(MIGRATIONS)
            .map(|versions| {
                versions
                    .into_iter()
                    .map(|version| version.to_string())
                    .collect()
            })
            .map_err(|e| {
                error!("Database migration failed: {}", e);
                Error::Database(DatabaseError::MigrationFailed(e.to_string()))
            });

        // Always attempt to restore connection pragmas, even if migration fails.
        if let Err(e) = connection.batch_execute(
            "
            PRAGMA temp_store = DEFAULT;
            PRAGMA cache_size = -2000;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;
        ",
        ) {
            error!("Failed to restore migration PRAGMAs: {}", e);
            if migration_result.is_ok() {
                return Err(Error::Database(DatabaseError::QueryFailed(e.to_string())));
            }
        }

        // Refresh query planner statistics only when migrations were actually
        // applied. `run_pending_migrations` returns the list of applied versions;
        // an empty list means the schema was already current, so running ANALYZE
        // (which rewrites sqlite_stat1) on every startup would be wasted work.
        if migration_result
            .as_ref()
            .map(|applied| !applied.is_empty())
            .unwrap_or(false)
        {
            connection
                .batch_execute("ANALYZE;")
                .unwrap_or_else(|e| warn!("ANALYZE after migration failed: {}", e));
        }

        // Flush WAL to main DB file before pool creation
        connection
            .batch_execute("PRAGMA wal_checkpoint(TRUNCATE);")
            .unwrap_or_else(|e| warn!("WAL checkpoint after migration failed: {}", e));
        drop(connection);

        let result = migration_result?;

        if result.is_empty() {
            info!("No pending migrations to apply.");
        } else {
            info!("Applied the following migrations:");
            for migration_version in &result {
                info!("  - {}", migration_version);
            }
        }

        Ok(())
    }
}

/// Opens (or creates) the database at `db_path` and resolves its encryption
/// state by probing.
///
/// Takes the resolved path rather than the app data directory so that it has no
/// hidden dependency on `$DATABASE_URL`; callers that want that override apply
/// [`get_db_path`] themselves.
///
/// This is the *whole* of startup's database logic: it opens `app.db` and
/// nothing more. It never looks for candidate files, pending markers or staged
/// restores — those only exist inside a maintenance operation, which always runs
/// to completion before the restart that follows it.
pub fn bootstrap(
    db_path: &str,
    provider: &dyn KeyProvider,
    policy: EncryptionPolicy,
) -> Result<DbAccess> {
    create_parent_dir(Path::new(db_path))?;

    // Detection must survive a key store that cannot be read at all — a Linux
    // desktop with no Secret Service, a locked keychain, a sandbox without
    // portal access. A plaintext database has no business failing to open
    // because of any of that, and the overwhelming majority never opted in.
    // Remember the reason: if the file *does* turn out to be encrypted, it is
    // the real answer rather than "no key is available".
    let (existing_key, key_error) = match provider.existing() {
        Ok(key) => (key, None),
        Err(e) => {
            warn!("Could not read the database key: {}", e);
            (None, Some(e.to_string()))
        }
    };

    let access = if database_file_exists(db_path) {
        probe(db_path, existing_key.map(Arc::new))
            .map_err(|e| explain_with_key_error(e, key_error.as_deref()))?
    } else {
        match policy {
            EncryptionPolicy::Plaintext => DbAccess::plaintext(db_path),
            // Creating an encrypted database genuinely requires the key, so an
            // unreadable store is fatal here — unlike during detection.
            EncryptionPolicy::Encrypted => {
                if let Some(reason) = key_error {
                    return Err(Error::Database(DatabaseError::Encryption(format!(
                        "Cannot create an encrypted database: the key store is unavailable ({reason})"
                    ))));
                }
                // Reuse a retained key rather than minting a second one, so
                // backups taken under the first key stay openable.
                let key = match existing_key {
                    Some(key) => key,
                    None => provider.create()?,
                };
                DbAccess::encrypted(db_path, Arc::new(key))
            }
        }
    };

    info!(
        "Opened database at {} ({})",
        access.path(),
        if access.is_encrypted() {
            "encrypted"
        } else {
            "plaintext"
        }
    );
    access.prepare()?;
    Ok(access)
}

/// Determines an existing database's encryption state by trying to open it.
///
/// Tries the key first when one is available, then falls back to an unkeyed open
/// on a *fresh* connection. A key that exists says nothing about the file: after
/// encryption is disabled the key is retained, so a retained key beside a
/// plaintext database is the normal state, not an anomaly.
pub(crate) fn probe(db_path: &str, key: Option<Arc<DbEncryptionKey>>) -> Result<DbAccess> {
    if let Some(key) = key {
        if opens_with(db_path, Some(&key)) {
            return Ok(DbAccess::encrypted(db_path, key));
        }
        if opens_with(db_path, None) {
            return Ok(DbAccess::plaintext(db_path));
        }
        return Err(unreadable_database(db_path, true));
    }

    if opens_with(db_path, None) {
        return Ok(DbAccess::plaintext(db_path));
    }
    Err(unreadable_database(db_path, false))
}

/// Names the key-store failure when it is the likely cause of an unopenable file.
fn explain_with_key_error(error: Error, key_error: Option<&str>) -> Error {
    match key_error {
        Some(reason) => Error::Database(DatabaseError::Encryption(format!(
            "{error} The database key could not be read, which is the likely cause: {reason}"
        ))),
        None => error,
    }
}

fn opens_with(db_path: &str, key: Option<&Arc<DbEncryptionKey>>) -> bool {
    match open_rusqlite(db_path, key.map(Arc::as_ref)) {
        Ok(conn) => verify_key(&conn).is_ok(),
        Err(_) => false,
    }
}

/// Level 1 verification: proves the applied key opens this database.
pub(crate) fn verify_key(conn: &RusqliteConnection) -> Result<()> {
    conn.query_row(KEY_CHECK_SQL, [], |row| row.get::<_, i64>(0))
        .map(|_: i64| ())
        .map_err(|e| {
            Error::Database(DatabaseError::Encryption(format!(
                "Database key verification failed: {e}"
            )))
        })
}

/// Both attempts failed. Never mint a replacement key here: that would create a
/// brand-new empty database over the user's data.
fn unreadable_database(db_path: &str, key_was_tried: bool) -> Error {
    let detail = if looks_like_plaintext_sqlite(db_path) {
        "the file is an unencrypted SQLite database but could not be read, so it is likely corrupt"
    } else if key_was_tried {
        "the file is encrypted and this device's key did not open it"
    } else {
        "the file appears to be encrypted but no key is available on this device"
    };

    Error::Database(DatabaseError::Encryption(format!(
        "Cannot open database at {db_path}: {detail}. \
         Nothing was modified and no replacement key was generated."
    )))
}

fn looks_like_plaintext_sqlite(db_path: &str) -> bool {
    let mut header = [0u8; SQLITE_MAGIC.len()];
    fs::File::open(db_path)
        .and_then(|mut file| file.read_exact(&mut header))
        .is_ok()
        && &header == SQLITE_MAGIC
}

/// A zero-length file is not a database: both a keyed and an unkeyed open would
/// "succeed" on it and silently initialise it, so treat it as missing.
fn database_file_exists(db_path: &str) -> bool {
    fs::metadata(db_path).map(|m| m.len() > 0).unwrap_or(false)
}

fn create_parent_dir(path: &Path) -> Result<()> {
    if let Some(dir) = path.parent() {
        if !dir.as_os_str().is_empty() && !dir.exists() {
            fs::create_dir_all(dir)?;
        }
    }
    Ok(())
}

fn open_rusqlite(db_path: &str, key: Option<&DbEncryptionKey>) -> Result<RusqliteConnection> {
    open_rusqlite_with_flags(db_path, key, rusqlite::OpenFlags::default())
}

fn open_rusqlite_with_flags(
    db_path: &str,
    key: Option<&DbEncryptionKey>,
    flags: rusqlite::OpenFlags,
) -> Result<RusqliteConnection> {
    let conn = RusqliteConnection::open_with_flags(db_path, flags)
        .map_err(|e| Error::Database(DatabaseError::ConnectionFailed(e.to_string())))?;
    // `busy_timeout` goes through sqlite3_busy_timeout(), not SQL, so it does not
    // break SQLCipher's "key must be the first statement" rule either way.
    apply_key_rusqlite(&conn, key)?;
    conn.busy_timeout(Duration::from_secs(30))
        .map_err(|e| Error::Database(DatabaseError::ConnectionFailed(e.to_string())))?;
    Ok(conn)
}

#[cfg(test)]
mod encryption_tests {
    use super::*;
    use std::sync::Mutex;
    use tempfile::TempDir;

    /// A `KeyProvider` that records whether `create()` was ever reached, so the
    /// tests can assert that detection never mints a key.
    struct TestKeyProvider {
        key: Mutex<Option<DbEncryptionKey>>,
        creates: Mutex<usize>,
    }

    impl TestKeyProvider {
        fn empty() -> Self {
            Self {
                key: Mutex::new(None),
                creates: Mutex::new(0),
            }
        }

        fn with_key(key: DbEncryptionKey) -> Self {
            Self {
                key: Mutex::new(Some(key)),
                creates: Mutex::new(0),
            }
        }

        fn creates(&self) -> usize {
            *self.creates.lock().unwrap()
        }
    }

    impl KeyProvider for TestKeyProvider {
        fn existing(&self) -> Result<Option<DbEncryptionKey>> {
            Ok(self.key.lock().unwrap().clone())
        }

        fn create(&self) -> Result<DbEncryptionKey> {
            *self.creates.lock().unwrap() += 1;
            let key = DbEncryptionKey::generate();
            *self.key.lock().unwrap() = Some(key.clone());
            Ok(key)
        }
    }

    fn seed(access: &DbAccess) {
        access.prepare().unwrap();
        access.run_migrations().unwrap();
    }

    /// An explicit path under `dir`. Never `get_db_path`, which resolves to
    /// `$DATABASE_URL` when that is set and would point every test at one real
    /// database.
    fn temp_db_path(dir: &TempDir) -> String {
        dir.path().join("app.db").to_string_lossy().into_owned()
    }

    #[test]
    fn startup_clears_snapshots_left_behind_by_a_crash() {
        // Snapshot files are plaintext; the system temp directory used to have an
        // OS reaper and this one does not, so startup has to do it.
        let dir = TempDir::new().unwrap();
        let db = temp_db_path(&dir);
        DbAccess::plaintext(&db).prepare().unwrap();

        let scratch = scratch_dir_beside(Path::new(&db)).unwrap();
        let leaked = scratch.join("wf_snapshot_export_leaked.db");
        fs::write(&leaked, b"plaintext financial rows").unwrap();
        let portable = scratch.join("portable-abc123");
        let snapshot = dir.path().join("backups/.snapshot-abc123");
        for private in [&portable, &snapshot] {
            fs::create_dir_all(private).unwrap();
            fs::write(private.join("candidate.db"), b"staging").unwrap();
        }
        let saved = dir
            .path()
            .join("backups/wealthfolio_backup_20260913_120000.db");
        fs::write(&saved, b"saved snapshot").unwrap();
        let unrelated = scratch.join("user-folder");
        fs::create_dir(&unrelated).unwrap();

        purge_scratch_dir(Path::new(&db), dir.path());

        assert!(
            !leaked.exists(),
            "a leaked plaintext snapshot must not survive startup"
        );
        assert!(scratch.exists(), "the directory itself is kept");
        assert!(!portable.exists());
        assert!(!snapshot.exists());
        assert_eq!(fs::read(saved).unwrap(), b"saved snapshot");
        assert!(unrelated.exists());
    }

    #[test]
    fn opening_the_database_does_not_touch_another_process_scratch_files() {
        // `bootstrap` runs in the offline `db encrypt`/`db decrypt` command too,
        // which may be started while a server is serving. Purging there would
        // delete the running instance's in-flight snapshot mid-operation.
        let dir = TempDir::new().unwrap();
        let db = temp_db_path(&dir);
        DbAccess::plaintext(&db).prepare().unwrap();

        let scratch = scratch_dir_beside(Path::new(&db)).unwrap();
        let in_flight = scratch.join("wf_snapshot_server_in_flight.db");
        fs::write(&in_flight, b"another process is using this").unwrap();

        bootstrap(&db, &TestKeyProvider::empty(), EncryptionPolicy::Plaintext).unwrap();

        assert!(
            in_flight.exists(),
            "opening the database must not delete another process's scratch files"
        );
    }

    /// A provider whose backing store is unavailable (no Secret Service on
    /// Linux, a locked keychain) — which is not the same as having no key.
    struct BrokenKeyProvider;

    impl KeyProvider for BrokenKeyProvider {
        fn existing(&self) -> Result<Option<DbEncryptionKey>> {
            Err(Error::Database(DatabaseError::Encryption(
                "Platform secure storage failure: no Secret Service available".into(),
            )))
        }
        fn create(&self) -> Result<DbEncryptionKey> {
            unreachable!()
        }
    }

    #[test]
    fn an_unreadable_key_store_never_blocks_a_plaintext_database() {
        // The common case by a wide margin: a user who never enabled encryption,
        // on a machine with no working secret store. Startup must not care.
        let dir = TempDir::new().unwrap();
        let db = temp_db_path(&dir);
        seed(&DbAccess::plaintext(&db));

        let access = bootstrap(&db, &BrokenKeyProvider, EncryptionPolicy::Plaintext)
            .expect("a plaintext database must open with no working key store");
        assert!(!access.is_encrypted());
    }

    #[test]
    fn an_unreadable_key_store_is_named_when_the_database_is_encrypted() {
        let dir = TempDir::new().unwrap();
        let db = temp_db_path(&dir);
        seed(&DbAccess::encrypted(
            &db,
            Arc::new(DbEncryptionKey::generate()),
        ));

        let error = bootstrap(&db, &BrokenKeyProvider, EncryptionPolicy::Plaintext).unwrap_err();

        assert!(
            error.to_string().contains("no Secret Service"),
            "the real cause must reach the user: {error}"
        );
    }

    #[test]
    fn a_missing_database_stays_plaintext_under_the_default_policy() {
        let dir = TempDir::new().unwrap();
        let provider = TestKeyProvider::empty();

        let access =
            bootstrap(&temp_db_path(&dir), &provider, EncryptionPolicy::Plaintext).unwrap();

        assert!(!access.is_encrypted());
        assert_eq!(provider.creates(), 0, "opting out must never mint a key");
    }

    #[test]
    fn a_missing_database_is_created_encrypted_under_an_encrypted_policy() {
        let dir = TempDir::new().unwrap();
        let provider = TestKeyProvider::empty();

        let access =
            bootstrap(&temp_db_path(&dir), &provider, EncryptionPolicy::Encrypted).unwrap();

        assert!(access.is_encrypted());
        assert_eq!(provider.creates(), 1);
        assert!(!looks_like_plaintext_sqlite(access.path()));
    }

    #[test]
    fn a_missing_database_reuses_a_retained_key_rather_than_minting_a_second() {
        let dir = TempDir::new().unwrap();
        let key = DbEncryptionKey::generate();
        let provider = TestKeyProvider::with_key(key.clone());

        let access =
            bootstrap(&temp_db_path(&dir), &provider, EncryptionPolicy::Encrypted).unwrap();

        assert_eq!(access.key().unwrap().as_hex(), key.as_hex());
        assert_eq!(provider.creates(), 0);
    }

    #[test]
    fn an_existing_plaintext_database_opens_through_the_unkeyed_fallback() {
        // A retained key beside a plaintext database is the normal state after a
        // disable, not an anomaly: only probing decides.
        let dir = TempDir::new().unwrap();
        seed(&DbAccess::plaintext(temp_db_path(&dir)));
        let provider = TestKeyProvider::with_key(DbEncryptionKey::generate());

        let access =
            bootstrap(&temp_db_path(&dir), &provider, EncryptionPolicy::Plaintext).unwrap();

        assert!(!access.is_encrypted());
        assert_eq!(provider.creates(), 0);
    }

    #[test]
    fn an_existing_encrypted_database_opens_with_the_stored_key() {
        let dir = TempDir::new().unwrap();
        let key = Arc::new(DbEncryptionKey::generate());
        seed(&DbAccess::encrypted(temp_db_path(&dir), Arc::clone(&key)));
        let provider = TestKeyProvider::with_key((*key).clone());

        let access =
            bootstrap(&temp_db_path(&dir), &provider, EncryptionPolicy::Plaintext).unwrap();

        assert!(access.is_encrypted());
        assert_eq!(provider.creates(), 0);
    }

    #[test]
    fn an_encrypted_database_with_no_key_fails_without_touching_anything() {
        let dir = TempDir::new().unwrap();
        let db_path = temp_db_path(&dir);
        seed(&DbAccess::encrypted(
            &db_path,
            Arc::new(DbEncryptionKey::generate()),
        ));
        let before = fs::read(&db_path).unwrap();
        let provider = TestKeyProvider::empty();

        let error =
            bootstrap(&temp_db_path(&dir), &provider, EncryptionPolicy::Plaintext).unwrap_err();

        assert!(error.to_string().contains("encrypted"), "{error}");
        assert_eq!(provider.creates(), 0, "no replacement key may be minted");
        assert_eq!(fs::read(&db_path).unwrap(), before);
    }

    #[test]
    fn a_wrong_key_is_reported_rather_than_replaced() {
        let dir = TempDir::new().unwrap();
        let db_path = temp_db_path(&dir);
        seed(&DbAccess::encrypted(
            &db_path,
            Arc::new(DbEncryptionKey::generate()),
        ));
        let provider = TestKeyProvider::with_key(DbEncryptionKey::generate());

        let error =
            bootstrap(&temp_db_path(&dir), &provider, EncryptionPolicy::Plaintext).unwrap_err();

        assert!(error.to_string().contains("did not open it"), "{error}");
        assert_eq!(provider.creates(), 0);
    }

    #[test]
    fn a_corrupt_plaintext_database_is_reported_as_corruption() {
        let dir = TempDir::new().unwrap();
        let db_path = temp_db_path(&dir);
        create_parent_dir(Path::new(&db_path)).unwrap();
        fs::write(&db_path, b"SQLite format 3\0 truncated garbage").unwrap();

        let error = bootstrap(
            &temp_db_path(&dir),
            &TestKeyProvider::empty(),
            EncryptionPolicy::Plaintext,
        )
        .unwrap_err();

        assert!(error.to_string().contains("corrupt"), "{error}");
    }

    #[test]
    fn an_encrypted_database_is_not_readable_as_plain_sqlite() {
        let dir = TempDir::new().unwrap();
        let key = Arc::new(DbEncryptionKey::generate());
        let access = DbAccess::encrypted(temp_db_path(&dir), key);
        seed(&access);

        let unkeyed = DbAccess::plaintext(access.path());
        assert!(unkeyed
            .connect_rusqlite()
            .and_then(|conn| verify_key(&conn))
            .is_err());
        assert!(!looks_like_plaintext_sqlite(access.path()));
    }

    #[test]
    fn an_internal_backup_inherits_the_sources_encryption() {
        let dir = TempDir::new().unwrap();
        let key = Arc::new(DbEncryptionKey::generate());
        let access = DbAccess::encrypted(temp_db_path(&dir), Arc::clone(&key));
        seed(&access);

        let backup_path = dir.path().join("internal.db");
        let backup_path = backup_path.to_str().unwrap();
        backup_database_to_file(&access, backup_path).unwrap();

        assert!(!looks_like_plaintext_sqlite(backup_path));
        let conn = DbAccess::encrypted(backup_path, key)
            .connect_rusqlite()
            .unwrap();
        verify_key(&conn).expect("an internal backup must open with the source key");
    }

    #[test]
    fn two_devices_with_different_keys_read_the_same_plaintext_snapshot() {
        // The wire format for device-sync snapshots is plaintext, so a snapshot
        // exported by one encrypted device must open on another with a different
        // key. This is what `KEY ''` on both attachments guarantees.
        let first = TempDir::new().unwrap();
        let second = TempDir::new().unwrap();
        let device_a =
            DbAccess::encrypted(temp_db_path(&first), Arc::new(DbEncryptionKey::generate()));
        let device_b =
            DbAccess::encrypted(temp_db_path(&second), Arc::new(DbEncryptionKey::generate()));
        seed(&device_a);
        seed(&device_b);

        let snapshot = first.path().join("snapshot.db");
        let snapshot = snapshot.to_str().unwrap();
        copy_database(&device_a, snapshot, None).unwrap();

        let conn = device_b.connect_rusqlite().unwrap();
        conn.execute_batch(&format!(
            "ATTACH DATABASE '{}' AS snap KEY '';",
            escape_sql_string(snapshot)
        ))
        .expect("device B must be able to attach device A's snapshot");
        let tables: i64 = conn
            .query_row("SELECT count(*) FROM snap.sqlite_master", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert!(tables > 0);
    }
}

/// Plaintext test helpers.
///
/// Production code opens the database through [`bootstrap`] / [`DbAccess`] so
/// that `PRAGMA key` is applied at every site; these mirror the pre-encryption
/// free functions so the repository unit tests keep their existing shape.
#[cfg(test)]
mod test_helpers {
    use super::*;

    pub(crate) fn init(app_data_dir: &str) -> Result<String> {
        let access = DbAccess::plaintext(get_db_path(app_data_dir));
        access.prepare()?;
        Ok(access.path().to_string())
    }

    pub(crate) fn run_migrations(db_path: &str) -> Result<()> {
        DbAccess::plaintext(db_path).run_migrations()
    }

    pub(crate) fn create_pool(db_path: &str) -> Result<Arc<DbPool>> {
        DbAccess::plaintext(db_path).create_pool()
    }
}

#[cfg(test)]
pub(crate) use test_helpers::{create_pool, init, run_migrations};

pub fn get_db_path(input: &str) -> String {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        // On mobile (iOS/Android), always keep the database inside the app's sandbox
        // to avoid permission issues. Ignore DATABASE_URL entirely.
        return Path::new(input)
            .join("app.db")
            .to_string_lossy()
            .into_owned();
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        // Desktop/server behavior:
        // Prefer DATABASE_URL if provided and non-empty; otherwise, always
        // treat `input` as the app data directory and append `app.db`.
        if let Ok(url) = std::env::var("DATABASE_URL") {
            if !url.trim().is_empty() {
                return url;
            }
        }

        Path::new(input)
            .join("app.db")
            .to_string_lossy()
            .into_owned()
    }
}

#[cfg(test)]
mod migration_tests {
    use super::*;
    use diesel::prelude::*;
    use diesel::sql_types::BigInt;

    #[derive(QueryableByName)]
    struct CountRow {
        #[diesel(sql_type = BigInt)]
        count: i64,
    }

    fn count(conn: &mut SqliteConnection, sql: &str) -> i64 {
        diesel::sql_query(sql)
            .get_result::<CountRow>(conn)
            .unwrap()
            .count
    }

    #[test]
    fn asset_multiplier_rebuild_clears_only_derived_valuations() {
        let mut conn = SqliteConnection::establish(":memory:").unwrap();
        conn.batch_execute(
            "
            CREATE TABLE daily_account_valuation (
                id TEXT PRIMARY KEY NOT NULL
            );
            CREATE TABLE holdings_snapshots (
                id TEXT PRIMARY KEY NOT NULL,
                source TEXT NOT NULL
            );
            INSERT INTO daily_account_valuation (id) VALUES ('valuation1');
            INSERT INTO holdings_snapshots (id, source) VALUES ('manual1', 'MANUAL_ENTRY');
            INSERT INTO holdings_snapshots (id, source) VALUES ('broker1', 'BROKER_IMPORTED');
            ",
        )
        .unwrap();

        conn.batch_execute(include_str!(
            "../../migrations/2026-08-02-000001_reclaim_storage/up.sql"
        ))
        .unwrap();

        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM daily_account_valuation"
            ),
            0
        );
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM holdings_snapshots"
            ),
            2
        );
    }

    #[test]
    fn lot_disposals_migration_clears_generated_data() {
        let mut conn = SqliteConnection::establish(":memory:").unwrap();
        conn.batch_execute(
            "
            PRAGMA foreign_keys = ON;

            CREATE TABLE accounts (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL
            );

            CREATE TABLE assets (
                id TEXT PRIMARY KEY NOT NULL
            );

            CREATE TABLE activities (
                id TEXT PRIMARY KEY NOT NULL,
                account_id TEXT,
                activity_date TEXT,
                status TEXT,
                activity_type TEXT,
                activity_type_override TEXT,
                source_group_id TEXT
            );

            CREATE TABLE lots (
                id TEXT PRIMARY KEY NOT NULL,
                account_id TEXT NOT NULL,
                asset_id TEXT NOT NULL,
                open_date TEXT NOT NULL,
                open_activity_id TEXT NULL,
                original_quantity TEXT NOT NULL,
                cost_per_unit TEXT NOT NULL,
                original_cost_basis TEXT NOT NULL,
                remaining_cost_basis TEXT NOT NULL,
                fee_allocated TEXT NOT NULL,
                remaining_quantity TEXT NOT NULL,
                split_ratio TEXT NOT NULL,
                is_closed INTEGER NOT NULL,
                close_date TEXT NULL,
                close_activity_id TEXT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE daily_account_valuation (
                id TEXT PRIMARY KEY NOT NULL
            );

            CREATE TABLE holdings_snapshots (
                id TEXT PRIMARY KEY NOT NULL,
                source TEXT NOT NULL
            );

            INSERT INTO accounts (id, name) VALUES ('acc1', 'Account');
            INSERT INTO assets (id) VALUES ('asset1');
            INSERT INTO activities (id) VALUES ('activity1');
            INSERT INTO lots (
                id, account_id, asset_id, open_date, original_quantity,
                cost_per_unit, original_cost_basis, remaining_cost_basis,
                fee_allocated, remaining_quantity, split_ratio, is_closed,
                created_at, updated_at
            ) VALUES (
                'lot1', 'acc1', 'asset1', '2026-01-01', '1',
                '10', '10', '10', '0', '1', '1', 0,
                '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
            );
            INSERT INTO daily_account_valuation (id) VALUES ('valuation1');
            INSERT INTO holdings_snapshots (id, source) VALUES ('snapshot1', 'CALCULATED');
            INSERT INTO holdings_snapshots (id, source) VALUES ('snapshot2', 'MANUAL_ENTRY');
            ",
        )
        .unwrap();

        conn.batch_execute(include_str!(
            "../../migrations/2026-05-26-000001_lot_disposals/up.sql"
        ))
        .unwrap();

        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM pragma_table_info('lots')
                 WHERE name = 'cost_basis_method'"
            ),
            1
        );
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM pragma_table_info('lot_disposals')
                 WHERE name = 'cost_basis_method' AND dflt_value = '''FIFO'''"
            ),
            1
        );
        assert_eq!(count(&mut conn, "SELECT COUNT(*) AS count FROM lots"), 0);
        assert_eq!(
            count(&mut conn, "SELECT COUNT(*) AS count FROM lot_disposals"),
            0
        );
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM daily_account_valuation"
            ),
            0
        );
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM holdings_snapshots WHERE source = 'CALCULATED'"
            ),
            0
        );
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM holdings_snapshots"
            ),
            1
        );
    }

    #[test]
    fn reset_derived_read_models_migration_drops_calculated_and_preserves_source() {
        let mut conn = SqliteConnection::establish(":memory:").unwrap();
        conn.batch_execute(
            "
            PRAGMA foreign_keys = OFF;

            CREATE TABLE accounts (
                id TEXT PRIMARY KEY NOT NULL,
                tracking_mode TEXT NOT NULL
            );

            CREATE TABLE holdings_snapshots (
                id TEXT PRIMARY KEY NOT NULL,
                account_id TEXT NOT NULL,
                source TEXT NOT NULL
            );

            CREATE TABLE daily_account_valuation (
                id TEXT PRIMARY KEY NOT NULL
            );

            CREATE TABLE lot_disposals (
                id TEXT PRIMARY KEY NOT NULL
            );

            -- Minimal lots table WITHOUT the new columns; the migration ALTERs
            -- them in, so this proves the ADD COLUMN statements run.
            CREATE TABLE lots (
                id TEXT PRIMARY KEY NOT NULL
            );

            -- Relational mirror of the snapshot positions. Migrations run with
            -- foreign_keys OFF, so the migration must delete orphans itself
            -- rather than relying on ON DELETE CASCADE.
            CREATE TABLE snapshot_positions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                snapshot_id TEXT NOT NULL REFERENCES holdings_snapshots(id) ON DELETE CASCADE,
                asset_id TEXT NOT NULL
            );

            -- One TRANSACTIONS account (replayed) and one HOLDINGS account
            -- (source data, not replayed).
            INSERT INTO accounts (id, tracking_mode) VALUES ('accT', 'TRANSACTIONS');
            INSERT INTO accounts (id, tracking_mode) VALUES ('accH', 'HOLDINGS');

            -- CALCULATED on a TRANSACTIONS account -> deleted.
            INSERT INTO holdings_snapshots (id, account_id, source) VALUES ('snapCalcT', 'accT', 'CALCULATED');
            -- CALCULATED on a HOLDINGS account -> converted to MANUAL_ENTRY (kept).
            INSERT INTO holdings_snapshots (id, account_id, source) VALUES ('snapCalcH', 'accH', 'CALCULATED');
            -- Source snapshots -> preserved untouched.
            INSERT INTO holdings_snapshots (id, account_id, source) VALUES ('snapManual', 'accT', 'MANUAL_ENTRY');
            INSERT INTO holdings_snapshots (id, account_id, source) VALUES ('snapCsv', 'accT', 'CSV_IMPORT');
            INSERT INTO holdings_snapshots (id, account_id, source) VALUES ('snapBroker', 'accH', 'BROKER_IMPORTED');

            INSERT INTO daily_account_valuation (id) VALUES ('val1');
            INSERT INTO lot_disposals (id) VALUES ('disp1');
            INSERT INTO lots (id) VALUES ('lot1');

            -- Position rows for a snapshot that gets deleted (orphaned), for a
            -- snapshot that is converted and kept, and for a preserved source
            -- snapshot.
            INSERT INTO snapshot_positions (snapshot_id, asset_id) VALUES ('snapCalcT', 'AAPL');
            INSERT INTO snapshot_positions (snapshot_id, asset_id) VALUES ('snapCalcH', 'AAPL');
            INSERT INTO snapshot_positions (snapshot_id, asset_id) VALUES ('snapManual', 'AAPL');
            ",
        )
        .unwrap();

        conn.batch_execute(include_str!(
            "../../migrations/2026-07-04-000001_reset_derived_read_models/up.sql"
        ))
        .unwrap();

        // No CALCULATED snapshots remain: the TRANSACTIONS one was deleted and
        // the HOLDINGS one was converted.
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM holdings_snapshots WHERE source = 'CALCULATED'"
            ),
            0
        );
        // TRANSACTIONS CALCULATED snapshot deleted outright.
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM holdings_snapshots WHERE id = 'snapCalcT'"
            ),
            0
        );
        // HOLDINGS CALCULATED snapshot converted to MANUAL_ENTRY, not deleted.
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM holdings_snapshots \
                 WHERE id = 'snapCalcH' AND source = 'MANUAL_ENTRY'"
            ),
            1
        );
        // Source snapshots preserved with unchanged source values.
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM holdings_snapshots \
                 WHERE id = 'snapManual' AND source = 'MANUAL_ENTRY'"
            ),
            1
        );
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM holdings_snapshots \
                 WHERE id = 'snapCsv' AND source = 'CSV_IMPORT'"
            ),
            1
        );
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM holdings_snapshots \
                 WHERE id = 'snapBroker' AND source = 'BROKER_IMPORTED'"
            ),
            1
        );
        // Exactly the four non-CALCULATED rows survive.
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM holdings_snapshots"
            ),
            4
        );

        // Generated read models emptied.
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM daily_account_valuation"
            ),
            0
        );
        assert_eq!(
            count(&mut conn, "SELECT COUNT(*) AS count FROM lot_disposals"),
            0
        );
        assert_eq!(count(&mut conn, "SELECT COUNT(*) AS count FROM lots"), 0);

        // Position rows orphaned by the snapshot delete are removed. Migrations
        // run with foreign_keys OFF, so no CASCADE fires and the migration must
        // clean these up explicitly.
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM snapshot_positions WHERE snapshot_id = 'snapCalcT'"
            ),
            0,
            "positions of a deleted CALCULATED snapshot must not be left orphaned"
        );
        // Rows whose snapshot survived are untouched (converted or preserved).
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM snapshot_positions WHERE snapshot_id = 'snapCalcH'"
            ),
            1
        );
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM snapshot_positions WHERE snapshot_id = 'snapManual'"
            ),
            1
        );
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM snapshot_positions"
            ),
            2
        );

        // Additive account-FX columns were created on lots.
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM pragma_table_info('lots') \
                 WHERE name = 'fx_rate_to_account'"
            ),
            1
        );
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM pragma_table_info('lots') \
                 WHERE name = 'account_currency'"
            ),
            1
        );
    }

    /// The full embedded migration chain must apply cleanly on a fresh database.
    ///
    /// This is the guard for the `VACUUM` migration: SQLite refuses `VACUUM`
    /// inside a transaction, and Diesel wraps migrations in one unless the
    /// migration directory carries `metadata.toml` with
    /// `run_in_transaction = false`. If that file is missing, renamed, or not
    /// honored by `embed_migrations!`, this test fails with "cannot VACUUM from
    /// within a transaction" rather than shipping a migration that bricks
    /// startup.
    #[test]
    fn full_embedded_migration_chain_applies_including_vacuum() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("chain.db");
        let db_path = db_path.to_str().unwrap();

        let access = DbAccess::plaintext(db_path);
        access
            .run_migrations()
            .expect("embedded migration chain must apply");

        // Re-running is a no-op: every migration is recorded as applied.
        access
            .run_migrations()
            .expect("re-running migrations must be a no-op");

        let mut conn = access.connect().unwrap();

        // The redundant quote index is dropped, while the unique index and the
        // (asset_id, source, day) index the latest-quote batch query needs both
        // survive.
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM sqlite_master \
                 WHERE type = 'index' AND name = 'idx_quotes_asset_day'"
            ),
            0,
            "the redundant (asset_id, day) prefix index must be dropped"
        );
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' \
                 AND name IN ('uq_quotes_asset_day_source', 'idx_quotes_asset_source_day')"
            ),
            2,
            "the unique index and the source-ordered index must be preserved"
        );

        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM __diesel_schema_migrations \
                 WHERE version = '20260802000001'"
            ),
            1,
            "the VACUUM migration must be recorded as applied exactly once"
        );
    }
}

#[cfg(test)]
fn create_backup_filename(timestamp: chrono::DateTime<Local>) -> String {
    format!(
        "{}{}{}",
        BACKUP_FILENAME_PREFIX,
        timestamp.format(BACKUP_FILENAME_TIMESTAMP_FORMAT),
        BACKUP_FILENAME_SUFFIX
    )
}

pub fn is_valid_backup_filename(filename: &str) -> bool {
    const EXPECTED_LEN: usize =
        BACKUP_FILENAME_PREFIX.len() + "YYYYMMDD_HHMMSS".len() + BACKUP_FILENAME_SUFFIX.len();

    if filename.len() != EXPECTED_LEN && !snapshots::is_current_filename(filename) {
        return false;
    }
    if !filename.is_ascii()
        || filename.contains(['/', '\\'])
        || !filename.starts_with(BACKUP_FILENAME_PREFIX)
        || !filename.ends_with(BACKUP_FILENAME_SUFFIX)
    {
        return false;
    }

    let timestamp = &filename[BACKUP_FILENAME_PREFIX.len()..BACKUP_FILENAME_PREFIX.len() + 15];
    if timestamp.as_bytes().get(8) != Some(&b'_') {
        return false;
    }

    let compact = timestamp.replace('_', "");
    if compact.len() != 14 || !compact.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }

    chrono::NaiveDateTime::parse_from_str(timestamp, BACKUP_FILENAME_TIMESTAMP_FORMAT).is_ok()
}

pub fn create_backup_path(app_data_dir: &str) -> Result<String> {
    snapshots::new_path(app_data_dir, snapshots::SnapshotReason::Manual)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| Error::Database(DatabaseError::BackupFailed(error.to_string())))
}

/// Name of the private directory used for short-lived database files.
const SCRATCH_DIR_NAME: &str = "scratch";

/// Creates and returns a private directory for short-lived database files,
/// beside the application database.
///
/// Device-sync snapshots are plaintext by design — the wire format expects it,
/// and device sync's transport-level E2EE is what protects them — so they are
/// plaintext copies of synced financial rows. Writing those to the shared system
/// temp directory reads badly at the best of times and worse once the product
/// claims encryption at rest.
pub fn scratch_dir(app_data_dir: &str) -> Result<std::path::PathBuf> {
    scratch_dir_beside(Path::new(&get_db_path(app_data_dir)))
}

/// Cleans scratch files and abandoned maintenance candidates.
///
/// Device-sync scratch snapshots are plaintext copies of synced financial rows,
/// deleted as soon as they are consumed — but a crash between write and delete leaves
/// one behind, and unlike the system temp directory this one has no OS reaper.
/// Nothing here is meant to outlive a process, so startup clears it. Best
/// effort: a leftover file must never stop the app from opening.
///
/// **Call only while holding DatabaseOwner, before starting any operations.**
/// Another instance can have live snapshot/export files in these directories;
/// cleanup without ownership could delete them mid-operation. Offline maintenance
/// may also clean here after acquiring ownership, before creating its own files.
/// Backup staging lives under the explicit backup root; native database path
/// overrides can place it on a different filesystem from database scratch.
pub fn purge_scratch_dir(db_path: &Path, backup_root: &Path) {
    maintenance::purge_abandoned_candidates(db_path);
    // Only private operation directories are recursive cleanup targets.
    // Callers hold DatabaseOwner before reaching startup cleanup.
    if let Some(root) = db_path.parent() {
        for (directory, prefix) in [
            (backup_root.join("backups"), ".snapshot-"),
            (root.join(SCRATCH_DIR_NAME), "portable-"),
        ] {
            if let Ok(entries) = fs::read_dir(directory) {
                for entry in entries.flatten() {
                    if entry.file_name().to_string_lossy().starts_with(prefix)
                        && entry.file_type().is_ok_and(|kind| kind.is_dir())
                    {
                        if let Err(error) = fs::remove_dir_all(entry.path()) {
                            warn!("Failed to clean abandoned backup staging: {error}");
                        }
                    }
                }
            }
        }
    }
    // Read without creating: a device that never syncs should not grow a
    // `scratch/` directory just by starting up.
    let Some(dir) = db_path.parent().map(|parent| parent.join(SCRATCH_DIR_NAME)) else {
        return;
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };

    for entry in entries.flatten() {
        if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        match fs::remove_file(entry.path()) {
            Ok(()) => info!("Removed stale scratch file {}", entry.path().display()),
            Err(e) => warn!("Failed to remove stale scratch file: {}", e),
        }
    }
}

/// The scratch directory beside a known database file.
pub(crate) fn scratch_dir_beside(db_path: &Path) -> Result<std::path::PathBuf> {
    let parent = db_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));

    let dir = parent.join(SCRATCH_DIR_NAME);
    fs::create_dir_all(&dir).map_err(backup_failed)?;
    restrict_to_owner(&dir);
    Ok(dir)
}

#[cfg(unix)]
fn restrict_to_owner(path: &Path) {
    use std::os::unix::fs::PermissionsExt;

    if let Err(e) = fs::set_permissions(path, fs::Permissions::from_mode(0o700)) {
        warn!(
            "Failed to restrict permissions on {}: {}",
            path.display(),
            e
        );
    }
}

#[cfg(not(unix))]
fn restrict_to_owner(_path: &Path) {}

/// Writes a self-contained copy of `source` at `target_path`, encrypted with
/// `target_key` (`None` for a plaintext copy).
///
/// Uses SQLCipher's `sqlcipher_export()` rather than `VACUUM INTO` because it is
/// the only mechanism whose output key can differ from the source's, which is
/// what portable export, conversion and cross-state restore all need. One code
/// path serves every combination of source and target state.
///
/// SQLCipher documents that `sqlcipher_export` copies neither `user_version` nor
/// `auto_vacuum`; neither is used anywhere in this codebase.
pub(crate) fn copy_database(
    source: &DbAccess,
    target_path: &str,
    target_key: Option<&DbEncryptionKey>,
) -> Result<()> {
    create_parent_dir(Path::new(target_path))?;
    // `sqlcipher_export` requires an empty target.
    remove_database_files(target_path)?;

    let conn = source.connect_rusqlite()?;
    verify_key(&conn)?;
    conn.execute_batch("PRAGMA wal_checkpoint(FULL);")
        .unwrap_or_else(|e| warn!("WAL checkpoint before copy failed: {}", e));

    let attach_sql = format!(
        "ATTACH DATABASE '{}' AS wf_copy {};",
        escape_sql_string(target_path),
        encryption::attach_key_clause(target_key).as_str()
    );
    conn.execute_batch(&attach_sql).map_err(|e| {
        Error::Database(DatabaseError::BackupFailed(format!(
            "Failed to attach copy target {target_path}: {e}"
        )))
    })?;

    let exported = conn.execute_batch("SELECT sqlcipher_export('wf_copy');");
    let detached = conn.execute_batch("DETACH DATABASE wf_copy;");

    if let Err(e) = exported {
        let _ = remove_database_files(target_path);
        return Err(Error::Database(DatabaseError::BackupFailed(format!(
            "Failed to copy database to {target_path}: {e}"
        ))));
    }
    detached.map_err(|e| {
        Error::Database(DatabaseError::BackupFailed(format!(
            "Failed to detach copy target {target_path}: {e}"
        )))
    })?;

    Ok(())
}

/// Internal and pre-operation backups are faithful copies: they inherit the
/// source database's encryption, so an encrypted database yields an encrypted
/// backup that only this device's retained key opens.
pub fn backup_database_to_file(access: &DbAccess, backup_path: &str) -> Result<()> {
    info!(
        "Creating database backup from {} to {}",
        access.path(),
        backup_path
    );
    copy_database(access, backup_path, access.key().map(Arc::as_ref))
}

pub fn backup_database(access: &DbAccess, app_data_dir: &str) -> Result<String> {
    snapshots::create(access, app_data_dir, snapshots::SnapshotReason::Manual)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| Error::Database(DatabaseError::BackupFailed(error.to_string())))
}

/// Gets a connection from the pool
pub fn get_connection(pool: &Pool<ConnectionManager<SqliteConnection>>) -> Result<DbConnection> {
    Ok(pool.get().map_err(StorageError::from)?)
}

#[derive(Debug)]
struct ConnectionCustomizer {
    key: Option<Arc<DbEncryptionKey>>,
    _owner: Option<Arc<DatabaseOwner>>,
}

impl r2d2::CustomizeConnection<SqliteConnection, diesel::r2d2::Error> for ConnectionCustomizer {
    fn on_acquire(
        &self,
        conn: &mut SqliteConnection,
    ) -> std::result::Result<(), diesel::r2d2::Error> {
        // SQLCipher requires `PRAGMA key` before any other statement, so it
        // cannot join the batch below. This covers the write actor too: its
        // dedicated connection is drawn from this pool.
        apply_key(conn, self.key.as_deref()).map_err(|e| {
            diesel::r2d2::Error::QueryError(diesel::result::Error::QueryBuilderError(
                e.to_string().into(),
            ))
        })?;

        // IMPORTANT: Use batch_execute (sqlite3_exec) instead of sql_query (sqlite3_prepare_v2).
        // sql_query only executes the FIRST statement; subsequent PRAGMAs are silently ignored.
        conn.batch_execute(
            "PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 30000;
             PRAGMA synchronous = NORMAL;",
        )
        .map_err(diesel::r2d2::Error::QueryError)?;

        Ok(())
    }
}

// --- Internal helpers for robust, cross-platform file operations ---

fn backup_failed(e: io::Error) -> Error {
    Error::Database(DatabaseError::BackupFailed(e.to_string()))
}

/// Escapes a value for interpolation into a single-quoted SQL string literal.
pub(crate) fn escape_sql_string(value: &str) -> String {
    value.replace('\'', "''")
}

/// Removes a database file together with its WAL and shared-memory sidecars.
pub(crate) fn remove_database_files(db_path: &str) -> Result<()> {
    remove_files([
        db_path.to_string(),
        format!("{db_path}-wal"),
        format!("{db_path}-shm"),
    ])
}

/// Removes only the WAL and shared-memory sidecars, leaving the database file.
pub(crate) fn remove_database_sidecars(db_path: &str) -> Result<()> {
    remove_files([format!("{db_path}-wal"), format!("{db_path}-shm")])
}

fn remove_files(paths: impl IntoIterator<Item = String>) -> Result<()> {
    for path in paths {
        match remove_file_with_retries(&path) {
            Ok(()) => {}
            Err(e) => {
                error!("Failed to remove '{}': {}", path, e);
                return Err(backup_failed(e));
            }
        }
    }
    Ok(())
}

/// Number of extra attempts made when a file is transiently locked.
const REMOVE_RETRIES: usize = 5;
const REMOVE_RETRY_SLEEP: Duration = Duration::from_millis(200);

/// Removes a file, tolerating a transient Windows sharing violation.
///
/// On Windows an antivirus scanner or the search indexer can hold a database
/// sidecar open for a moment after the app's own connections are gone, which
/// makes `remove_file` fail with error 32/33. That would abort a whole
/// maintenance operation the user just confirmed, so retry briefly before
/// giving up. The failure is still reported if the lock outlasts the retries —
/// proceeding with a live WAL in place would let it be replayed against the
/// incoming database.
fn remove_file_with_retries(path: &str) -> std::result::Result<(), io::Error> {
    for attempt in 0..=REMOVE_RETRIES {
        match fs::remove_file(path) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) if is_sharing_violation(&e) && attempt < REMOVE_RETRIES => {
                warn!(
                    "'{}' is in use ({}); retrying in {}ms",
                    path,
                    e,
                    REMOVE_RETRY_SLEEP.as_millis()
                );
                std::thread::sleep(REMOVE_RETRY_SLEEP);
            }
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// Windows `ERROR_SHARING_VIOLATION` (32) and `ERROR_LOCK_VIOLATION` (33).
fn is_sharing_violation(e: &io::Error) -> bool {
    #[cfg(windows)]
    {
        matches!(e.raw_os_error(), Some(32) | Some(33))
    }
    #[cfg(not(windows))]
    {
        let _ = e;
        false
    }
}

/// Trait for executing database transactions
pub trait DbTransactionExecutor {
    /// Execute operations within a transaction and return the result
    fn execute<F, T, E>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&mut DbConnection) -> std::result::Result<T, E>,
        E: Into<Error>;
}

/// Implementation of DbTransactionExecutor for DbPool
impl DbTransactionExecutor for DbPool {
    fn execute<F, T, E>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&mut DbConnection) -> std::result::Result<T, E>,
        E: Into<Error>,
    {
        let mut conn = self.get().map_err(StorageError::from)?;

        conn.transaction(|tx_conn| {
            f(tx_conn).map_err(|_| diesel::result::Error::RollbackTransaction)
        })
        .map_err(|e| Error::Database(DatabaseError::QueryFailed(e.to_string())))
    }
}

/// Implementation of DbTransactionExecutor for Arc<DbPool>
impl DbTransactionExecutor for Arc<DbPool> {
    fn execute<F, T, E>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&mut DbConnection) -> std::result::Result<T, E>,
        E: Into<Error>,
    {
        (**self).execute(f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use tempfile::tempdir;

    #[test]
    fn validates_backup_filename_contract() {
        assert!(is_valid_backup_filename(
            "wealthfolio_backup_20260514_150409.db"
        ));

        for filename in [
            "../wealthfolio_backup_20260514_150409.db",
            "wealthfolio_backup_20260514_150409.db\0",
            "wealthfolio_backup_20260514_150409.sqlite",
            "wealthfolio_backup_20260514_150409_123.db",
            "wealthfolio_backup_20260514150409.db",
            "wealthfolio_backup_20260514_15040x.db",
            "wealthfolio_backup_20260231_150409.db",
            "other_backup_20260514_150409.db",
        ] {
            assert!(
                !is_valid_backup_filename(filename),
                "expected {filename} to be rejected"
            );
        }
    }

    #[test]
    fn generated_backup_filename_matches_validator() {
        let timestamp = Local
            .with_ymd_and_hms(2026, 5, 14, 15, 4, 9)
            .single()
            .unwrap();

        assert_eq!(
            create_backup_filename(timestamp),
            "wealthfolio_backup_20260514_150409.db"
        );
        assert!(is_valid_backup_filename(&create_backup_filename(timestamp)));
    }

    #[test]
    fn create_backup_path_uses_valid_backup_filename() {
        let app_data = tempdir().unwrap();
        let backup_path = create_backup_path(app_data.path().to_str().unwrap()).unwrap();
        let filename = Path::new(&backup_path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap();

        assert!(is_valid_backup_filename(filename));
    }
}

#[cfg(test)]
mod pool_lifetime_tests;

#[cfg(test)]
mod migration_backup_tests;

#[cfg(test)]
mod account_delete_cleanup_tests;
