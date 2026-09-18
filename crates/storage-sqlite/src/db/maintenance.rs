//! Whole-file database maintenance: restore, enable encryption, disable
//! encryption.
//!
//! All three are the same operation — replace `app.db` with a verified candidate
//! while nothing is connected — so one implementation serves all three.
//!
//! The work runs in process and finishes *before* the caller's intentional
//! restart. Normal startup never resumes candidates, pending markers or staged
//! restores: it opens `app.db` and nothing else. Any candidate
//! left behind by a crash is inert, and is swept on startup or before maintenance.
//!
//! # Precondition
//!
//! The caller must have torn the database runtime down first: stopped background
//! workers, joined the write actor, and dropped every pooled and standalone
//! connection. The caller must retain [`DatabaseOwner`] throughout this operation.
//! A SQLite probe additionally rejects active external connections, but cannot
//! detect every open handle or prevent tools that ignore our ownership lock.

use log::{error, info, warn};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use uuid::Uuid;

use rusqlite::Connection as RusqliteConnection;
use wealthfolio_core::errors::{DatabaseError, Error, Result};

use super::{
    copy_database, probe, remove_database_files, remove_database_sidecars, verify_key,
    DatabaseOwner, DbAccess, DbEncryptionKey,
};

/// Marks disposable files beside the live database, swept while ownership is held.
const CANDIDATE_MARKER: &str = ".maintenance-";

/// Startup cleanup must run under database ownership before any operation starts.
pub(super) fn purge_abandoned_candidates(db_path: &Path) {
    if let Ok(workspace) = Workspace::new(db_path) {
        workspace.sweep_stale_candidates();
    }
}

/// What to replace the live database with.
pub enum MaintenanceRequest {
    /// Reinstate the contents of a backup file, landing on this device's current
    /// encryption state regardless of the backup's own.
    Restore {
        backup_path: PathBuf,
        /// The key this device holds, tried when the backup turns out to be
        /// encrypted. It is deliberately *not* the live database's key: the key
        /// is retained across a disable, so a plaintext device must still be
        /// able to open backups taken while it was encrypted.
        device_key: Option<Arc<DbEncryptionKey>>,
    },
    /// Convert the live database to encrypted under `key`.
    Enable { key: Arc<DbEncryptionKey> },
    /// Convert the live database back to plaintext.
    Disable,
}

impl MaintenanceRequest {
    fn label(&self) -> &'static str {
        match self {
            Self::Restore { .. } => "restore",
            Self::Enable { .. } => "enable-encryption",
            Self::Disable => "disable-encryption",
        }
    }

    /// The encryption state the database must be in when the operation finishes.
    fn target_key(&self, current: &DbAccess) -> Option<Arc<DbEncryptionKey>> {
        match self {
            // A restored backup never overrides the device's encryption policy.
            Self::Restore { .. } => current.key().cloned(),
            Self::Enable { key } => Some(Arc::clone(key)),
            Self::Disable => None,
        }
    }
}

pub struct MaintenanceOutcome {
    /// How to reopen the database now that the operation has completed.
    pub access: DbAccess,
    /// The pre-operation backup, when one is still on disk. Enable uses the
    /// destination key and deletes its recovery copy after durable success.
    pub pre_operation_backup: Option<String>,
}

/// Replaces `app.db` with a verified candidate.
///
/// Ordering matters and is not negotiable: every step that can fail runs before
/// anything destructive, and the pre-operation backup exists before the atomic
/// replace so a failed verification can be rolled back.
pub fn run(
    app_data_dir: &str,
    current: &DbAccess,
    request: MaintenanceRequest,
    owner: &DatabaseOwner,
) -> Result<MaintenanceOutcome> {
    owner.check_path(current.path())?;
    let db_path = PathBuf::from(current.path());
    let workspace = Workspace::new(&db_path)?;

    info!(
        "Starting database maintenance: {} ({} -> {})",
        request.label(),
        state_label(current.is_encrypted()),
        state_label(request.target_key(current).is_some()),
    );

    // Also reject SQLite connections already holding locks. Process ownership
    // remains held throughout the copy, install and any rollback.
    check_sqlite_locks(current)?;
    workspace.sweep_stale_candidates();

    let target_key = request.target_key(current);
    let candidate = DbAccess::new(path_str(&workspace.candidate)?, target_key.clone());

    // Steps 2-6: build and verify the candidate. Everything here is recoverable
    // by deleting the candidate; the live database has not been touched.
    let build = build_candidate(&request, current, &candidate, &workspace);
    if let Err(e) = build {
        workspace.discard();
        return Err(e);
    }

    // Enable changes only encryption, so its verified candidate contains the
    // original data under the already-stored destination key. Preserve that as
    // an encrypted managed snapshot: it remains recoverable after a failed
    // rollback/restart without leaving a plaintext scratch copy.
    let enabling = matches!(request, MaintenanceRequest::Enable { .. });
    let backup_source = if enabling { &candidate } else { current };
    let reason = if matches!(request, MaintenanceRequest::Restore { .. }) {
        super::snapshots::SnapshotReason::BeforeRestore
    } else {
        super::snapshots::SnapshotReason::BeforeMaintenance
    };
    let pre_operation_backup = super::snapshots::create(backup_source, app_data_dir, reason)
        .map_err(|error| {
            workspace.discard();
            Error::Database(DatabaseError::BackupFailed(error.to_string()))
        })?
        .to_string_lossy()
        .into_owned();
    let backup_access = DbAccess::new(&pre_operation_backup, backup_source.key().cloned());
    info!("Pre-operation backup written to {}", pre_operation_backup);

    // Candidate and pre-operation snapshot are already on disk. Before replacing
    // the live file, require room to stage that snapshot if rollback is needed.
    // Other writers can still consume space; all subsequent write errors remain
    // authoritative and must preserve the recovery artifact.
    let space = fs::metadata(&pre_operation_backup)
        .and_then(|metadata| super::space::require(&workspace.dir, metadata.len()));
    if let Err(error) = space {
        workspace.discard();
        return Err(error.into());
    }

    // Step 8: install the candidate. `fs::rename` over the live database is
    // atomic on the same filesystem, so a crash here leaves either the complete
    // old file or the complete new one.
    if let Err(e) = install(&workspace.candidate, &db_path) {
        workspace.discard();
        return Err(e);
    }

    // After rename, a failure must roll back rather than run pre-install cleanup.
    // The rollback snapshot remains managed even if another filesystem operation
    // fails; startup cleanup cannot erase the only recovery copy.
    let installed = DbAccess::new(current.path(), target_key);
    if let Err(error) = fsync_parent_dir(&db_path).and_then(|()| verify_installed(&installed)) {
        error!("Installed database could not be confirmed ({error}); rolling back");
        if let Err(rollback_error) = roll_back(&workspace, &backup_access, current) {
            return Err(Error::Database(DatabaseError::RestoreFailed(format!(
                "Database installation failed ({error}); rollback failed ({rollback_error}). \
                 Recovery snapshot retained at {pre_operation_backup}."
            ))));
        }
        workspace.discard();
        if enabling {
            let _ = remove_database_files(&pre_operation_backup);
        }
        return Err(error);
    }

    // The original-data copy used only for Enable is no longer needed after
    // durable success. Cleanup failure is harmless to encryption: it is keyed.
    let pre_operation_backup = if enabling {
        match remove_database_files(&pre_operation_backup) {
            Ok(()) => {
                info!("Removed the enable-encryption recovery snapshot after verification");
                None
            }
            Err(e) => {
                error!(
                    "The encrypted recovery snapshot at {} could not be removed ({}). Delete it manually.",
                    pre_operation_backup, e
                );
                Some(pre_operation_backup)
            }
        }
    } else {
        Some(pre_operation_backup)
    };

    info!("Database maintenance completed: {}", request.label());
    Ok(MaintenanceOutcome {
        access: installed,
        pre_operation_backup,
    })
}

/// Best-effort detection of external SQLite users. This is not the ownership
/// guard: an unqueried connection may hold no SQLite lock, and the connection
/// below releases its lock on return. Keep external database tools closed.
pub fn check_sqlite_locks(access: &DbAccess) -> Result<()> {
    let conn = access.connect_existing_rusqlite()?;
    conn.execute_batch(
        "PRAGMA locking_mode = EXCLUSIVE;
         BEGIN IMMEDIATE;
         COMMIT;",
    )
    .map_err(|e| {
        Error::Database(DatabaseError::TransactionFailed(format!(
            "Database maintenance aborted: connections to {} are still open ({e}). \
             Nothing was modified.",
            access.path()
        )))
    })
}

fn build_candidate(
    request: &MaintenanceRequest,
    current: &DbAccess,
    candidate: &DbAccess,
    workspace: &Workspace,
) -> Result<()> {
    match request {
        MaintenanceRequest::Restore {
            backup_path,
            device_key,
        } => {
            // Never modify or consume the user's backup: work on a scratch copy,
            // which also avoids read-only-open edge cases on WAL-mode files.
            if !backup_path.exists() {
                return Err(Error::Database(DatabaseError::RestoreFailed(format!(
                    "Backup file not found: {}",
                    backup_path.display()
                ))));
            }
            stage_backup(backup_path, &workspace.scratch)?;

            // A backup may be plaintext (a portable export) or encrypted with
            // this device's key (an internal or pre-operation backup).
            let source = probe(
                path_str(&workspace.scratch)?,
                device_key.clone().or_else(|| current.key().cloned()),
            )?;
            let conn = source.connect_rusqlite()?;
            verify_key(&conn)?;
            integrity_check(&conn)?;
            drop(conn);

            copy_database(&source, candidate.path(), candidate.key().map(Arc::as_ref))?;
            remove_database_files(path_str(&workspace.scratch)?)?;
        }
        MaintenanceRequest::Enable { .. } | MaintenanceRequest::Disable => {
            copy_database(current, candidate.path(), candidate.key().map(Arc::as_ref))?;
        }
    }

    verify_candidate(candidate)
}

/// Copies a backup into the scratch slot, sidecars included.
///
/// Not every backup is self-contained. The app's own exports are checkpointed
/// copies, but a backup that is a plain file copy of a live database — the
/// `.pre-restore-*` artifacts older versions wrote, or a user's own copy — keeps
/// its most recent transactions in `-wal`. Staging the main file alone leaves a
/// database that opens and passes its integrity check at the last checkpoint,
/// so those transactions would be dropped with no error anywhere.
fn stage_backup(backup_path: &Path, scratch: &Path) -> Result<()> {
    let staged = |e: std::io::Error| {
        Error::Database(DatabaseError::RestoreFailed(format!(
            "Failed to stage the selected backup: {e}"
        )))
    };

    fs::copy(backup_path, scratch).map_err(staged)?;

    for suffix in ["-wal", "-shm"] {
        let sidecar = sidecar_path(backup_path, suffix);
        if sidecar.exists() {
            fs::copy(&sidecar, sidecar_path(scratch, suffix)).map_err(staged)?;
        }
    }

    Ok(())
}

/// `path` with `suffix` appended to its file name, the way SQLite names the WAL
/// and shared-memory files beside a database.
fn sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

/// Levels 1-3 on the candidate, then flush it to disk.
fn verify_candidate(candidate: &DbAccess) -> Result<()> {
    let conn = candidate.connect_rusqlite()?;
    verify_key(&conn)?;
    integrity_check(&conn)?;
    if candidate.is_encrypted() {
        cipher_integrity_check(&conn)?;
    }
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .unwrap_or_else(|e| warn!("WAL checkpoint of the candidate failed: {}", e));
    drop(conn);

    fsync_file(Path::new(candidate.path()))
}

/// Validate an existing database before retrying service construction after an
/// ambiguous maintenance failure. Never turn a missing file into an empty app.
pub fn verify_for_reopen(access: &DbAccess) -> Result<()> {
    if !std::fs::metadata(access.path())
        .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
    {
        return Err(Error::Database(DatabaseError::RestoreFailed(
            "Database file is missing or empty; recovery is required".into(),
        )));
    }
    let conn = access.connect_existing_rusqlite()?;
    let tables: i64 = conn.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('accounts', 'activities', 'app_settings', '__diesel_schema_migrations')", [], |row| row.get(0)).map_err(|error| Error::Database(DatabaseError::RestoreFailed(error.to_string())))?;
    if tables != 4 {
        return Err(Error::Database(DatabaseError::RestoreFailed(
            "This file is not a Wealthfolio database".into(),
        )));
    }
    verify_key(&conn)?;
    integrity_check(&conn)?;
    if access.is_encrypted() {
        cipher_integrity_check(&conn)?;
    }
    Ok(())
}

fn verify_installed(installed: &DbAccess) -> Result<()> {
    let conn = installed.connect_rusqlite()?;
    verify_key(&conn)
}

/// Level 2: standard SQLite structural integrity. A healthy database returns
/// **exactly one row containing `ok`**; anything else is a failure.
pub(super) fn integrity_check(conn: &RusqliteConnection) -> Result<()> {
    let rows = pragma_rows(conn, "PRAGMA integrity_check;")?;
    if rows.len() == 1 && rows[0].eq_ignore_ascii_case("ok") {
        return Ok(());
    }
    Err(Error::Database(DatabaseError::RestoreFailed(format!(
        "Database failed its integrity check: {}",
        rows.join("; ")
    ))))
}

/// Level 3: SQLCipher page-HMAC verification, for encrypted databases only.
///
/// **Success is signalled by returning no rows at all.** Applying level 2's
/// "one row saying `ok`" condition here would report every healthy encrypted
/// database as corrupt.
pub(super) fn cipher_integrity_check(conn: &RusqliteConnection) -> Result<()> {
    let rows = pragma_rows(conn, "PRAGMA cipher_integrity_check;")?;
    if rows.is_empty() {
        return Ok(());
    }
    Err(Error::Database(DatabaseError::Encryption(format!(
        "Encrypted database failed its cipher integrity check: {}",
        rows.join("; ")
    ))))
}

fn pragma_rows(conn: &RusqliteConnection, sql: &str) -> Result<Vec<String>> {
    let mut statement = conn
        .prepare(sql)
        .map_err(|e| Error::Database(DatabaseError::QueryFailed(e.to_string())))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .and_then(|rows| rows.collect::<rusqlite::Result<Vec<String>>>())
        .map_err(|e| Error::Database(DatabaseError::QueryFailed(e.to_string())))?;
    Ok(rows)
}

fn install(candidate: &Path, db_path: &Path) -> Result<()> {
    // The outgoing WAL and shared-memory files describe the outgoing file. They
    // must not survive to be replayed against the incoming one. `app.db` itself
    // is *not* removed: the rename replaces it in one step, so a crash here
    // leaves either the complete old file or the complete new one. Deleting it
    // first would open a window where there is no database at all.
    remove_database_sidecars(path_str(db_path)?)?;

    fs::rename(candidate, db_path).map_err(|e| {
        Error::Database(DatabaseError::RestoreFailed(format!(
            "Failed to install the verified database: {e}"
        )))
    })?;
    Ok(())
}

/// Recover after service construction failed over an otherwise valid installed
/// database. The runtime must first stop and join all failed-build users. This
/// reuses the verified pre-operation snapshot without requiring another backup.
pub fn rollback_after_rebuild(
    installed: &DbAccess,
    original: &DbAccess,
    pre_operation_backup: &str,
    owner: &DatabaseOwner,
) -> Result<()> {
    owner.check_path(installed.path())?;
    owner.check_path(original.path())?;
    check_sqlite_locks(installed)?;
    let workspace = Workspace::new(Path::new(original.path()))?;
    let backup = probe(
        pre_operation_backup,
        installed.key().cloned().or_else(|| original.key().cloned()),
    )?;
    let result = roll_back(&workspace, &backup, original);
    workspace.discard();
    result
}

/// Reinstates the pre-operation backup and confirms it opens.
///
/// A rollback that leaves an unopenable database is worse than the failure it is
/// recovering from, so it stages the copy and installs it through the same
/// atomic rename, then reports its own failure loudly.
fn roll_back(workspace: &Workspace, backup: &DbAccess, original: &DbAccess) -> Result<()> {
    let staged = &workspace.rollback;
    let pre_operation_backup = backup.path();
    let copied = if backup.is_encrypted() && !original.is_encrypted() {
        copy_database(backup, path_str(staged)?, None)
    } else {
        fs::copy(pre_operation_backup, staged)
            .map(|_| ())
            .map_err(Error::from)
    };
    copied.map_err(|e| {
        Error::Database(DatabaseError::RestoreFailed(format!(
            "Rollback failed: could not stage {pre_operation_backup}: {e}. \
             The database is unusable; restore this file manually."
        )))
    })?;
    let staged_access = DbAccess::new(path_str(staged)?, original.key().cloned());
    {
        let conn = staged_access.connect_rusqlite()?;
        integrity_check(&conn)?;
        if staged_access.is_encrypted() {
            cipher_integrity_check(&conn)?;
        }
    }
    fsync_file(staged)?;
    install(staged, Path::new(original.path()))?;
    fsync_parent_dir(Path::new(original.path()))?;

    let conn = original.connect_rusqlite()?;
    verify_key(&conn)?;
    info!("Rolled back to the pre-operation backup");
    Ok(())
}

/// Uniquely named scratch files beside the live database, so that a crash can
/// never leave a file whose name a later run would mistake for its own.
struct Workspace {
    dir: PathBuf,
    file_name: String,
    candidate: PathBuf,
    scratch: PathBuf,
    rollback: PathBuf,
}

impl Workspace {
    fn new(db_path: &Path) -> Result<Self> {
        let dir = db_path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let file_name = db_path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| {
                Error::Database(DatabaseError::RestoreFailed(format!(
                    "Database path has no file name: {}",
                    db_path.display()
                )))
            })?
            .to_string();

        let token = Uuid::new_v4();
        Ok(Self {
            candidate: dir.join(format!("{file_name}{CANDIDATE_MARKER}{token}.new")),
            scratch: dir.join(format!("{file_name}{CANDIDATE_MARKER}{token}.src")),
            rollback: dir.join(format!("{file_name}{CANDIDATE_MARKER}{token}.rollback")),
            dir,
            file_name,
        })
    }

    /// Removes candidates left behind by an interrupted run. A disable candidate
    /// can be plaintext even while the live database remains encrypted.
    fn sweep_stale_candidates(&self) {
        let prefix = format!("{}{}", self.file_name, CANDIDATE_MARKER);
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return;
        };

        for entry in entries.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if !name.starts_with(&prefix) {
                continue;
            }
            if let Err(e) = fs::remove_file(entry.path()) {
                warn!("Failed to sweep stale maintenance file {}: {}", name, e);
            } else {
                info!("Swept stale maintenance file {}", name);
            }
        }
    }

    fn discard(&self) {
        for path in [&self.candidate, &self.scratch, &self.rollback] {
            if let Some(path) = path.to_str() {
                let _ = remove_database_files(path);
            }
        }
    }
}

fn fsync_file(path: &Path) -> Result<()> {
    // Must be opened writable: on Windows `sync_all` is `FlushFileBuffers`,
    // which requires GENERIC_WRITE and fails with ACCESS_DENIED on the
    // read-only handle `File::open` produces.
    fs::OpenOptions::new()
        .write(true)
        .open(path)
        .and_then(|file| file.sync_all())
        .map_err(|e| {
            Error::Database(DatabaseError::BackupFailed(format!(
                "Failed to flush {}: {e}",
                path.display()
            )))
        })
}

/// Unix directory sync makes the renamed entry durable. Other platforms retain
/// their existing rename behavior; do not claim a Unix durability barrier there.
fn fsync_parent_dir(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        let dir = path
            .parent()
            .filter(|dir| !dir.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        fs::File::open(dir)
            .and_then(|file| {
                #[cfg(test)]
                if SYNC_FAILURES.with(|remaining| {
                    let count = remaining.get();
                    remaining.set(count.saturating_sub(1));
                    count > 0
                }) {
                    return Err(std::io::Error::other("injected directory sync failure"));
                }
                file.sync_all()
            })
            .map_err(|error| {
                Error::Database(DatabaseError::RestoreFailed(format!(
                    "Failed to flush database directory {}: {error}",
                    dir.display()
                )))
            })?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(all(test, unix))]
thread_local! {
    static SYNC_FAILURES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn path_str(path: &Path) -> Result<&str> {
    path.to_str().ok_or_else(|| {
        Error::Database(DatabaseError::RestoreFailed(format!(
            "Path is not valid UTF-8: {}",
            path.display()
        )))
    })
}

fn state_label(encrypted: bool) -> &'static str {
    if encrypted {
        "encrypted"
    } else {
        "plaintext"
    }
}

#[cfg(test)]
mod tests {
    use super::super::backup_database_to_file;
    use super::*;
    use tempfile::TempDir;

    #[cfg(unix)]
    #[test]
    fn relative_database_path_syncs_the_current_directory() {
        SYNC_FAILURES.with(|value| value.set(1));
        let result = fsync_parent_dir(Path::new("app.db"));
        let remaining = SYNC_FAILURES.with(|value| value.replace(0));
        let error = result
            .expect_err("the directory flush must be attempted")
            .to_string();
        assert!(error.contains("directory .:"), "{error}");
        assert_eq!(remaining, 0);
        fsync_parent_dir(Path::new("app.db")).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn directory_sync_failure_rolls_back_and_preserves_uncertain_recovery() {
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                SYNC_FAILURES.with(|value| value.set(0));
            }
        }
        for operation in ["enable", "disable", "restore-plain", "restore-encrypted"] {
            for failures in [1, 2] {
                let dir = TempDir::new().unwrap();
                let source_dir = TempDir::new().unwrap();
                let key = Arc::new(DbEncryptionKey::generate());
                let encrypted = matches!(operation, "disable" | "restore-encrypted");
                let current = seeded_database(&dir, encrypted.then(|| key.clone()));
                let source = seeded_database(&source_dir, None);
                set_setting(&source, "base_currency", "EUR");
                let request = match operation {
                    "enable" => MaintenanceRequest::Enable { key: key.clone() },
                    "disable" => MaintenanceRequest::Disable,
                    _ => MaintenanceRequest::Restore {
                        backup_path: source.path().into(),
                        device_key: None,
                    },
                };
                let _reset = Reset;
                SYNC_FAILURES.with(|value| value.set(failures));
                let error = run(dir.path().to_str().unwrap(), &current, request)
                    .err()
                    .expect("a failed durability barrier must not report success")
                    .to_string();
                assert!(error.contains("directory sync failure"), "{error}");
                assert_eq!(SYNC_FAILURES.with(|value| value.get()), 0);
                assert_eq!(
                    read_setting(&current, "base_currency").as_deref(),
                    Some("CAD")
                );
                assert_eq!(
                    probe(current.path(), Some(key.clone()))
                        .unwrap()
                        .is_encrypted(),
                    encrypted
                );
                let backups = fs::read_dir(dir.path().join("backups"))
                    .unwrap()
                    .map(|entry| entry.unwrap().path())
                    .collect::<Vec<_>>();
                if failures == 2 {
                    assert!(error.contains("rollback failed"), "{error}");
                    assert_eq!(backups.len(), 1);
                    assert!(error.contains(backups[0].to_str().unwrap()));
                    let _owner = DatabaseOwner::acquire(current.path()).unwrap();
                    super::super::purge_scratch_dir(Path::new(current.path()), dir.path());
                    let backup = probe(backups[0].to_str().unwrap(), Some(key.clone())).unwrap();
                    assert_eq!(backup.is_encrypted(), encrypted || operation == "enable");
                    assert_eq!(
                        read_setting(&backup, "base_currency").as_deref(),
                        Some("CAD")
                    );
                } else if operation == "enable" {
                    assert!(
                        backups.is_empty(),
                        "durable rollback can remove Enable's copy"
                    );
                }
            }
        }
    }

    #[test]
    fn startup_removes_plaintext_candidate_after_process_exit() {
        const CHILD_PATH: &str = "WF_TEST_INTERRUPTED_DISABLE_DB";
        let key = Arc::new(DbEncryptionKey::from_bytes(&[37; 32]));
        if let Some(path) = std::env::var_os(CHILD_PATH) {
            let path = PathBuf::from(path);
            let current = DbAccess::encrypted(path.to_str().unwrap(), key);
            let _owner = DatabaseOwner::acquire(current.path()).unwrap();
            let workspace = Workspace::new(&path).unwrap();
            let candidate = DbAccess::plaintext(workspace.candidate.to_str().unwrap());
            build_candidate(
                &MaintenanceRequest::Disable,
                &current,
                &candidate,
                &workspace,
            )
            .unwrap();
            assert_eq!(
                read_setting(&candidate, "base_currency").as_deref(),
                Some("CAD")
            );
            // Exit without unwinding or running destructors after real candidate
            // creation and verification, before live-file replacement.
            std::process::exit(86);
        }

        let dir = TempDir::new().unwrap();
        let current = seeded_database(&dir, Some(key));
        let original = fs::read(current.path()).unwrap();
        let saved = dir.path().join("backups/retained.db");
        let archive = dir.path().join("recovery-original-retained/app.db");
        let other = dir.path().join("other.db.maintenance-retained.new");
        for path in [&saved, &archive, &other] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"retained").unwrap();
        }
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "db::maintenance::tests::startup_removes_plaintext_candidate_after_process_exit",
            ])
            .env(CHILD_PATH, current.path())
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(86));
        let candidate = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("app.db.maintenance-")
                    && path.extension().is_some_and(|extension| extension == "new")
            })
            .expect("interrupted conversion must leave its candidate");
        assert!(fs::read(&candidate)
            .unwrap()
            .starts_with(b"SQLite format 3\0"));
        let _owner = DatabaseOwner::acquire(current.path()).unwrap();
        super::super::purge_scratch_dir(Path::new(current.path()), dir.path());
        assert!(!candidate.exists());
        assert_eq!(fs::read(current.path()).unwrap(), original);
        assert_eq!(
            read_setting(&current, "base_currency").as_deref(),
            Some("CAD")
        );
        for path in [&saved, &archive, &other] {
            assert_eq!(fs::read(path).unwrap(), b"retained");
        }
    }

    #[test]
    fn insufficient_rollback_space_does_not_replace_the_live_database() {
        for encrypted in [false, true] {
            let dir = TempDir::new().unwrap();
            let key = encrypted.then(|| Arc::new(DbEncryptionKey::generate()));
            let current = seeded_database(&dir, key);
            let source_dir = TempDir::new().unwrap();
            let source = seeded_database(&source_dir, None);
            set_setting(&source, "base_currency", "EUR");
            let result = super::super::space::with_available(0, || {
                run(
                    dir.path().to_str().unwrap(),
                    &current,
                    MaintenanceRequest::Restore {
                        backup_path: source.path().into(),
                        device_key: None,
                    },
                )
            });
            assert!(result
                .err()
                .unwrap()
                .to_string()
                .contains("Not enough free space"));
            assert_eq!(
                read_setting(&current, "base_currency").as_deref(),
                Some("CAD")
            );
            assert_eq!(
                read_setting(&source, "base_currency").as_deref(),
                Some("EUR")
            );
            let snapshots =
                super::super::snapshots::list(dir.path().to_str().unwrap(), current.key().cloned())
                    .unwrap();
            assert_eq!(snapshots.len(), 1, "keep the verified pre-restore snapshot");
            assert!(!fs::read_dir(dir.path()).unwrap().any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(CANDIDATE_MARKER)));
        }
    }

    #[test]
    fn insufficient_space_keeps_conversion_policy_and_removes_plaintext_scratch() {
        for encrypted in [false, true] {
            let dir = TempDir::new().unwrap();
            let key = Arc::new(DbEncryptionKey::generate());
            let current = seeded_database(&dir, encrypted.then(|| key.clone()));
            let request = if encrypted {
                MaintenanceRequest::Disable
            } else {
                MaintenanceRequest::Enable { key: key.clone() }
            };
            let result = super::super::space::with_available(0, || {
                run(dir.path().to_str().unwrap(), &current, request)
            });
            assert!(result
                .err()
                .unwrap()
                .to_string()
                .contains("Not enough free space"));
            assert_eq!(
                probe(current.path(), Some(key.clone()))
                    .unwrap()
                    .is_encrypted(),
                encrypted
            );
            assert_eq!(
                read_setting(&current, "base_currency").as_deref(),
                Some("CAD")
            );
            let snapshots =
                super::super::snapshots::list(dir.path().to_str().unwrap(), Some(key)).unwrap();
            assert_eq!(
                snapshots.len(),
                1,
                "retain the encrypted recovery snapshot on refusal"
            );
            assert_eq!(snapshots[0].protection, "encrypted");
            let scratch = dir.path().join(super::super::SCRATCH_DIR_NAME);
            if scratch.exists() {
                assert_eq!(
                    fs::read_dir(scratch).unwrap().count(),
                    0,
                    "do not retain the failed enable's plaintext scratch backup"
                );
            }
        }
    }

    fn run(
        app_data_dir: &str,
        current: &DbAccess,
        request: MaintenanceRequest,
    ) -> Result<MaintenanceOutcome> {
        let owner = DatabaseOwner::acquire(current.path())?;
        super::run(app_data_dir, current, request, &owner)
    }

    /// A migrated database with one recognisable row, in the requested state.
    fn seeded_database(dir: &TempDir, key: Option<Arc<DbEncryptionKey>>) -> DbAccess {
        let db_path = dir.path().join("app.db");
        let access = DbAccess::new(db_path.to_str().unwrap(), key);
        access.prepare().unwrap();
        access.run_migrations().unwrap();
        set_setting(&access, "base_currency", "CAD");
        access
    }

    fn set_setting(access: &DbAccess, key: &str, value: &str) {
        let conn = access.connect_rusqlite().unwrap();
        conn.execute(
            "INSERT INTO app_settings (setting_key, setting_value) VALUES (?1, ?2) \
             ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value",
            rusqlite::params![key, value],
        )
        .unwrap();
    }

    fn read_setting(access: &DbAccess, key: &str) -> Option<String> {
        let conn = access.connect_rusqlite().unwrap();
        conn.query_row(
            "SELECT setting_value FROM app_settings WHERE setting_key = ?1",
            rusqlite::params![key],
            |row| row.get::<_, String>(0),
        )
        .ok()
    }

    fn file_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn rebuild_rollback_can_decrypt_enables_recovery_snapshot() {
        let dir = TempDir::new().unwrap();
        let original = seeded_database(&dir, None);
        let installed = run(
            dir.path().to_str().unwrap(),
            &original,
            MaintenanceRequest::Enable {
                key: Arc::new(DbEncryptionKey::generate()),
            },
        )
        .unwrap()
        .access;
        let backup = super::super::snapshots::create(
            &installed,
            dir.path().to_str().unwrap(),
            super::super::snapshots::SnapshotReason::BeforeMaintenance,
        )
        .unwrap();
        set_setting(&installed, "base_currency", "EUR");
        let owner = DatabaseOwner::acquire(original.path()).unwrap();
        rollback_after_rebuild(&installed, &original, backup.to_str().unwrap(), &owner).unwrap();
        assert_eq!(
            read_setting(&original, "base_currency").as_deref(),
            Some("CAD")
        );
        assert!(fs::read(original.path())
            .unwrap()
            .starts_with(b"SQLite format 3\0"));
        assert!(!fs::read(backup).unwrap().starts_with(b"SQLite format 3\0"));
    }

    #[test]
    fn rebuild_rollback_uses_existing_snapshot_and_rejects_damage_before_replace() {
        for encrypted in [false, true] {
            let dir = TempDir::new().unwrap();
            let original = seeded_database(
                &dir,
                encrypted.then(|| Arc::new(DbEncryptionKey::generate())),
            );
            let owner = DatabaseOwner::acquire(original.path()).unwrap();
            let backup = super::super::snapshots::create(
                &original,
                dir.path().to_str().unwrap(),
                super::super::snapshots::SnapshotReason::BeforeRestore,
            )
            .unwrap();
            set_setting(&original, "base_currency", "USD");
            let before = file_names(&dir.path().join("backups"));
            rollback_after_rebuild(&original, &original, backup.to_str().unwrap(), &owner).unwrap();
            assert_eq!(
                read_setting(&original, "base_currency").as_deref(),
                Some("CAD")
            );
            assert_eq!(file_names(&dir.path().join("backups")), before);
            fs::write(&backup, b"damaged rollback file").unwrap();
            assert!(
                rollback_after_rebuild(&original, &original, backup.to_str().unwrap(), &owner)
                    .is_err()
            );
            assert_eq!(
                read_setting(&original, "base_currency").as_deref(),
                Some("CAD")
            );
        }
    }

    #[test]
    fn ownership_is_retained_through_conversion_and_until_rebuild_finishes() {
        let dir = TempDir::new().unwrap();
        let access = seeded_database(&dir, None);
        let owner = DatabaseOwner::acquire(access.path()).unwrap();
        let outcome = super::run(
            dir.path().to_str().unwrap(),
            &access,
            MaintenanceRequest::Enable {
                key: Arc::new(DbEncryptionKey::generate()),
            },
            &owner,
        )
        .unwrap();
        assert!(outcome.access.is_encrypted());
        assert_eq!(
            read_setting(&outcome.access, "base_currency").as_deref(),
            Some("CAD")
        );
        assert!(DatabaseOwner::acquire(access.path()).is_err());
        drop(owner);
        assert!(DatabaseOwner::acquire(access.path()).is_ok());
    }

    #[test]
    fn ownership_for_another_database_cannot_authorize_maintenance() {
        let dir = TempDir::new().unwrap();
        let access = seeded_database(&dir, None);
        let owner = DatabaseOwner::acquire(dir.path().join("other.db").to_str().unwrap()).unwrap();
        let before = fs::read(access.path()).unwrap();
        let err = super::run(
            dir.path().to_str().unwrap(),
            &access,
            MaintenanceRequest::Enable {
                key: Arc::new(DbEncryptionKey::generate()),
            },
            &owner,
        )
        .err()
        .expect("wrong owner must fail");
        assert!(err.to_string().contains("does not match"));
        assert_eq!(fs::read(access.path()).unwrap(), before);
    }

    #[cfg(unix)]
    #[test]
    fn maintenance_rejects_symlink_alias_before_replacing_it() {
        let dir = TempDir::new().unwrap();
        let access = seeded_database(&dir, None);
        let alias = dir.path().join("alias.db");
        std::os::unix::fs::symlink(access.path(), &alias).unwrap();
        let alias_access = DbAccess::plaintext(alias.to_str().unwrap());
        let owner = DatabaseOwner::acquire(alias_access.path()).unwrap();
        let before = fs::read(access.path()).unwrap();
        let error = super::run(
            dir.path().to_str().unwrap(),
            &alias_access,
            MaintenanceRequest::Enable {
                key: Arc::new(DbEncryptionKey::generate()),
            },
            &owner,
        )
        .err()
        .expect("a symlink cannot be replaced while locking its target");
        assert!(error.to_string().contains("real database path"));
        assert!(fs::symlink_metadata(&alias)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read(access.path()).unwrap(), before);
        assert!(!dir.path().join("backups").exists());
    }

    #[test]
    fn enable_encrypts_in_place_and_leaves_no_plaintext_copy() {
        let dir = TempDir::new().unwrap();
        let access = seeded_database(&dir, None);
        let key = Arc::new(DbEncryptionKey::generate());

        let outcome = run(
            dir.path().to_str().unwrap(),
            &access,
            MaintenanceRequest::Enable {
                key: Arc::clone(&key),
            },
        )
        .expect("enable");

        assert!(outcome.access.is_encrypted());
        assert_eq!(
            read_setting(&outcome.access, "base_currency").as_deref(),
            Some("CAD")
        );

        // The plaintext file must no longer open without the key.
        assert!(DbAccess::plaintext(access.path())
            .connect_rusqlite()
            .and_then(|conn| verify_key(&conn))
            .is_err());

        // Neither the replaced file nor the pre-operation backup survives.
        assert_eq!(outcome.pre_operation_backup, None);
        assert!(
            !dir.path().join("backups").exists()
                || file_names(&dir.path().join("backups")).is_empty(),
            "the enable recovery snapshot is no longer needed after durable success"
        );
        assert!(
            !dir.path().join(super::super::SCRATCH_DIR_NAME).exists()
                || file_names(&dir.path().join(super::super::SCRATCH_DIR_NAME)).is_empty(),
            "the plaintext pre-operation backup must not linger in scratch either"
        );
    }

    #[test]
    fn startup_still_removes_legacy_plaintext_enable_scratch() {
        let dir = TempDir::new().unwrap();
        let access = seeded_database(&dir, None);
        let scratch = super::super::scratch_dir_beside(Path::new(access.path())).unwrap();
        let legacy = scratch.join("app.db.maintenance-legacy.pre");
        backup_database_to_file(&access, legacy.to_str().unwrap()).unwrap();
        super::super::purge_scratch_dir(Path::new(access.path()), dir.path());
        assert!(!legacy.exists());
    }

    #[test]
    fn disable_decrypts_and_retains_encrypted_pre_operation_backup() {
        let dir = TempDir::new().unwrap();
        let key = Arc::new(DbEncryptionKey::generate());
        let access = seeded_database(&dir, Some(Arc::clone(&key)));

        let outcome = run(
            dir.path().to_str().unwrap(),
            &access,
            MaintenanceRequest::Disable,
        )
        .expect("disable");

        assert!(!outcome.access.is_encrypted());
        assert_eq!(
            read_setting(&outcome.access, "base_currency").as_deref(),
            Some("CAD")
        );

        // The pre-operation backup inherited the encrypted source, and stays
        // openable precisely because the key is never deleted.
        let backup = outcome.pre_operation_backup.expect("retained backup");
        let backup_access = DbAccess::encrypted(&backup, key);
        let conn = backup_access.connect_rusqlite().unwrap();
        verify_key(&conn).expect("the encrypted pre-disable backup must still open");
    }

    #[test]
    fn enable_then_disable_round_trip_reuses_the_same_key() {
        let dir = TempDir::new().unwrap();
        let access = seeded_database(&dir, None);
        let key = Arc::new(DbEncryptionKey::generate());

        let encrypted = run(
            dir.path().to_str().unwrap(),
            &access,
            MaintenanceRequest::Enable {
                key: Arc::clone(&key),
            },
        )
        .unwrap()
        .access;
        let plaintext = run(
            dir.path().to_str().unwrap(),
            &encrypted,
            MaintenanceRequest::Disable,
        )
        .unwrap()
        .access;
        let re_enabled = run(
            dir.path().to_str().unwrap(),
            &plaintext,
            MaintenanceRequest::Enable {
                key: Arc::clone(&key),
            },
        )
        .unwrap()
        .access;

        assert_eq!(
            read_setting(&re_enabled, "base_currency").as_deref(),
            Some("CAD")
        );
    }

    #[test]
    fn restores_an_encrypted_backup_onto_a_device_that_has_since_disabled() {
        let dir = TempDir::new().unwrap();
        let key = Arc::new(DbEncryptionKey::generate());

        // Device was encrypted; an internal backup was taken then.
        let encrypted = seeded_database(&dir, Some(Arc::clone(&key)));
        let backup = dir.path().join("while-encrypted.db");
        backup_database_to_file(&encrypted, backup.to_str().unwrap()).unwrap();

        // The user then disables encryption. The key is retained in the keychain.
        let plaintext = run(
            dir.path().to_str().unwrap(),
            &encrypted,
            MaintenanceRequest::Disable,
        )
        .unwrap()
        .access;
        assert!(!plaintext.is_encrypted());

        // Restoring that encrypted backup must still work: the key is retained
        // precisely so backups taken before the disable stay openable.
        let outcome = run(
            dir.path().to_str().unwrap(),
            &plaintext,
            MaintenanceRequest::Restore {
                backup_path: backup,
                device_key: Some(key),
            },
        )
        .expect("an encrypted backup must restore onto a plaintext device");

        assert!(
            !outcome.access.is_encrypted(),
            "the restore lands on the device's policy, which is now plaintext"
        );
        assert_eq!(
            read_setting(&outcome.access, "base_currency").as_deref(),
            Some("CAD")
        );
    }

    #[test]
    fn restore_lands_on_the_device_policy_not_the_backups() {
        let dir = TempDir::new().unwrap();
        let key = Arc::new(DbEncryptionKey::generate());
        let access = seeded_database(&dir, Some(Arc::clone(&key)));

        // A plaintext (portable) backup carrying a different value and the
        // opposite encryption flag.
        let backup_dir = TempDir::new().unwrap();
        let backup_path = backup_dir.path().join("portable.db");
        let plaintext_source = seeded_database(&backup_dir, None);
        set_setting(&plaintext_source, "base_currency", "EUR");
        super::super::backup_database_to_file(&plaintext_source, backup_path.to_str().unwrap())
            .unwrap();
        let backup_bytes_before = fs::read(&backup_path).unwrap();

        let outcome = run(
            dir.path().to_str().unwrap(),
            &access,
            MaintenanceRequest::Restore {
                backup_path: backup_path.clone(),
                device_key: None,
            },
        )
        .expect("restore");

        assert!(
            outcome.access.is_encrypted(),
            "a plaintext backup must not flip an encrypted device to plaintext"
        );
        assert_eq!(
            read_setting(&outcome.access, "base_currency").as_deref(),
            Some("EUR")
        );
        assert_eq!(
            fs::read(&backup_path).unwrap(),
            backup_bytes_before,
            "the user's backup must never be modified or consumed"
        );
    }

    #[test]
    fn restore_reads_an_encrypted_internal_backup() {
        let dir = TempDir::new().unwrap();
        let key = Arc::new(DbEncryptionKey::generate());
        let access = seeded_database(&dir, Some(Arc::clone(&key)));

        let backup_path = dir.path().join("internal.db");
        backup_database_to_file(&access, backup_path.to_str().unwrap()).unwrap();
        set_setting(&access, "base_currency", "USD");

        let outcome = run(
            dir.path().to_str().unwrap(),
            &access,
            MaintenanceRequest::Restore {
                backup_path,
                device_key: None,
            },
        )
        .expect("restore");

        assert!(outcome.access.is_encrypted());
        assert_eq!(
            read_setting(&outcome.access, "base_currency").as_deref(),
            Some("CAD")
        );
    }

    #[test]
    fn maintenance_aborts_untouched_while_a_connection_is_open() {
        let dir = TempDir::new().unwrap();
        let access = seeded_database(&dir, None);
        let before = fs::read(access.path()).unwrap();

        let _held = access.connect_rusqlite().unwrap();
        // Force the held connection to actually take a shared lock.
        verify_key(&_held).unwrap();

        let result = run(
            dir.path().to_str().unwrap(),
            &access,
            MaintenanceRequest::Enable {
                key: Arc::new(DbEncryptionKey::generate()),
            },
        );

        assert!(result.is_err(), "maintenance must refuse to proceed");
        assert_eq!(
            fs::read(access.path()).unwrap(),
            before,
            "app.db must be byte-identical after an aborted operation"
        );
    }

    #[test]
    fn restore_keeps_transactions_that_live_only_in_the_backups_wal() {
        // Not every backup is self-contained. A plain file copy of a live
        // database — the `.pre-restore-*` artifacts older versions wrote, or a
        // user's own copy — keeps its newest transactions in `-wal`. Staging
        // the main file alone yields a database that opens and passes its
        // integrity check at the last checkpoint, so those transactions would
        // be dropped with nothing reporting it.
        let dir = TempDir::new().unwrap();
        let access = seeded_database(&dir, None);

        // An open read transaction pins the WAL at the pre-write snapshot, so
        // the checkpointer cannot fold the next write into the main file.
        let holder = access.connect_rusqlite().unwrap();
        holder
            .execute_batch("BEGIN; SELECT count(*) FROM app_settings;")
            .unwrap();
        set_setting(&access, "base_currency", "JPY");

        let backup = dir.path().join("copied-live.db");
        let backup_path = backup.to_str().unwrap().to_string();
        fs::copy(access.path(), &backup).unwrap();
        let source_wal = format!("{}-wal", access.path());
        assert!(
            Path::new(&source_wal).exists(),
            "the write must still be in the WAL for this test to mean anything"
        );
        fs::copy(&source_wal, format!("{backup_path}-wal")).unwrap();
        drop(holder);

        let outcome = run(
            dir.path().to_str().unwrap(),
            &access,
            MaintenanceRequest::Restore {
                backup_path: backup,
                device_key: None,
            },
        )
        .expect("restore");

        // The copied main file alone still says CAD; only the staged WAL has JPY.
        assert_eq!(
            read_setting(&outcome.access, "base_currency").as_deref(),
            Some("JPY"),
            "a restore must not silently drop the backup's WAL-resident writes"
        );
    }

    #[test]
    fn restore_rejects_a_corrupt_backup_before_touching_the_database() {
        let dir = TempDir::new().unwrap();
        let access = seeded_database(&dir, None);
        let before = fs::read(access.path()).unwrap();

        let backup_path = dir.path().join("corrupt.db");
        fs::write(&backup_path, b"SQLite format 3\0 not really a database").unwrap();

        let result = run(
            dir.path().to_str().unwrap(),
            &access,
            MaintenanceRequest::Restore {
                backup_path,
                device_key: None,
            },
        );

        assert!(result.is_err());
        assert_eq!(fs::read(access.path()).unwrap(), before);
    }

    #[test]
    fn cipher_integrity_check_treats_zero_rows_as_success() {
        // The inversion this guards against — asserting level 2's "one row
        // saying ok" — would report every healthy encrypted database as corrupt.
        let dir = TempDir::new().unwrap();
        let access = seeded_database(&dir, Some(Arc::new(DbEncryptionKey::generate())));
        let conn = access.connect_rusqlite().unwrap();

        assert!(
            pragma_rows(&conn, "PRAGMA cipher_integrity_check;")
                .unwrap()
                .is_empty(),
            "a healthy encrypted database returns no rows"
        );
        cipher_integrity_check(&conn).expect("zero rows is the pass condition");
    }

    #[test]
    fn integrity_check_requires_exactly_one_ok_row() {
        let dir = TempDir::new().unwrap();
        let access = seeded_database(&dir, None);
        let conn = access.connect_rusqlite().unwrap();

        assert_eq!(
            pragma_rows(&conn, "PRAGMA integrity_check;").unwrap(),
            vec!["ok".to_string()]
        );
        integrity_check(&conn).expect("one ok row is the pass condition");
    }

    #[test]
    fn rollback_reinstates_the_pre_operation_backup() {
        let dir = TempDir::new().unwrap();
        let access = seeded_database(&dir, None);
        let workspace = Workspace::new(Path::new(access.path())).unwrap();

        let backup = super::super::snapshots::new_path(
            dir.path().to_str().unwrap(),
            super::super::snapshots::SnapshotReason::BeforeRestore,
        )
        .unwrap()
        .to_string_lossy()
        .into_owned();
        backup_database_to_file(&access, &backup).unwrap();

        // Stand in for a half-installed database that fails verification.
        remove_database_files(access.path()).unwrap();
        fs::write(access.path(), b"not a database").unwrap();

        roll_back(&workspace, &DbAccess::plaintext(&backup), &access).expect("rollback");

        assert_eq!(
            read_setting(&access, "base_currency").as_deref(),
            Some("CAD")
        );
        assert!(
            !workspace.rollback.exists(),
            "staging file must be consumed"
        );
    }

    #[test]
    fn stale_candidates_are_swept_when_maintenance_begins() {
        let dir = TempDir::new().unwrap();
        let access = seeded_database(&dir, None);

        let stale = dir
            .path()
            .join(format!("app.db{CANDIDATE_MARKER}{}.new", Uuid::new_v4()));
        fs::write(&stale, b"leftover").unwrap();

        run(
            dir.path().to_str().unwrap(),
            &access,
            MaintenanceRequest::Enable {
                key: Arc::new(DbEncryptionKey::generate()),
            },
        )
        .unwrap();

        assert!(!stale.exists(), "stale candidates must be swept");
    }
}
