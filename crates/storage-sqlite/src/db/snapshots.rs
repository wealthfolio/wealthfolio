//! Managed local snapshots. File names are the catalogue; no metadata database.

use super::{DbAccess, DbEncryptionKey};
use anyhow::{ensure, Context};
use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};
use wealthfolio_core::errors::{DatabaseError, Error};

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SnapshotReason {
    Manual,
    BeforeRestore,
    BeforeMaintenance,
    BeforeMigration,
    Legacy,
}

impl SnapshotReason {
    fn label(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::BeforeRestore => "before-restore",
            Self::BeforeMaintenance => "before-maintenance",
            Self::BeforeMigration => "before-migration",
            Self::Legacy => "legacy",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub filename: String,
    pub size_bytes: u64,
    pub modified_at: String,
    pub protection: &'static str,
    pub reason: SnapshotReason,
}

pub(super) fn is_current_filename(name: &str) -> bool {
    let Some(body) = name
        .strip_prefix("wealthfolio_backup_")
        .and_then(|s| s.strip_suffix(".db"))
    else {
        return false;
    };
    let parts: Vec<_> = body.split('_').collect();
    parts.len() == 4
        && parts[0].len() == 8
        && parts[1].len() == 6
        && matches!(
            parts[2],
            "manual" | "before-restore" | "before-maintenance" | "before-migration"
        )
        && parts[3].len() == 32
        && parts[3].bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn new_path(root: &str, reason: SnapshotReason) -> anyhow::Result<PathBuf> {
    let directory = Path::new(root).join("backups");
    fs::create_dir_all(&directory)?;
    #[cfg(unix)]
    fs::File::open(root)?.sync_all()?;
    Ok(directory.join(format!(
        "wealthfolio_backup_{}_{}_{}.db",
        chrono::Local::now().format("%Y%m%d_%H%M%S"),
        reason.label(),
        uuid::Uuid::new_v4().simple()
    )))
}

// Leases are owned values, so blocking jobs and streaming response bodies can
// retain them even if their caller disconnects. No mutex guard crosses an await.
static ACTIVE: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
pub struct SnapshotLease {
    pub path: PathBuf,
    active: &'static Mutex<HashSet<PathBuf>>,
}
impl SnapshotLease {
    pub fn access(&self, key: Option<Arc<DbEncryptionKey>>) -> anyhow::Result<DbAccess> {
        super::probe(self.path.to_str().context("Invalid backup path")?, key).map_err(|_| {
            anyhow::anyhow!("This snapshot needs its original installation key or is damaged")
        })
    }
}
impl Drop for SnapshotLease {
    fn drop(&mut self) {
        // A poisoned registry stays closed to new leases. Removing this lease
        // is bookkeeping only; it neither reads database state nor clears poison.
        let mut active = match self.active.lock() {
            Ok(active) => active,
            Err(poisoned) => poisoned.into_inner(),
        };
        active.remove(&self.path);
    }
}

pub fn acquire(root: &str, filename: &str) -> anyhow::Result<SnapshotLease> {
    ensure!(
        super::is_valid_backup_filename(filename),
        "Invalid backup filename"
    );
    let directory = fs::canonicalize(Path::new(root).join("backups"))?;
    let path = directory.join(filename);
    let registry = ACTIVE.get_or_init(Default::default);
    let mut active = registry.lock().map_err(|_| {
        Error::Database(DatabaseError::Internal(
            "Backup snapshot state is unavailable. Restart the application before trying again."
                .into(),
        ))
    })?;
    ensure!(
        !active.contains(&path),
        "This backup is in use; try again when the operation finishes"
    );
    let metadata = fs::symlink_metadata(&path)?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "Backup must be a regular file"
    );
    active.insert(path.clone());
    Ok(SnapshotLease {
        path,
        active: registry,
    })
}

pub fn delete(root: &str, filename: &str) -> anyhow::Result<()> {
    let lease = acquire(root, filename)?;
    fs::remove_file(&lease.path)?;
    Ok(())
}

pub fn create(access: &DbAccess, root: &str, reason: SnapshotReason) -> anyhow::Result<PathBuf> {
    let destination = new_path(root, reason)?;
    let directory = destination.parent().context("Missing backup directory")?;
    // Partial copies are private and never match a listed filename. Publishing
    // with persist_noclobber cannot overwrite an earlier backup.
    let work = tempfile::Builder::new()
        .prefix(".snapshot-")
        .tempdir_in(directory)?;
    let candidate = work.path().join("candidate.db");
    let candidate_path = candidate.to_str().context("Invalid backup path")?;
    super::backup_database_to_file(access, candidate_path)?;
    #[cfg(test)]
    if CORRUPT_CANDIDATE.with(|value| value.replace(false)) {
        fs::write(&candidate, b"damaged snapshot")?;
    }
    let backup = DbAccess::new(candidate_path, access.key().cloned());
    let conn = backup.connect_rusqlite()?;
    super::maintenance::integrity_check(&conn)?;
    if backup.is_encrypted() {
        super::maintenance::cipher_integrity_check(&conn)?;
    }
    drop(conn);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&candidate, fs::Permissions::from_mode(0o600))?;
    }
    fs::OpenOptions::new()
        .write(true)
        .open(&candidate)?
        .sync_all()?;
    tempfile::TempPath::try_from_path(candidate)?.persist_noclobber(&destination)?;
    #[cfg(unix)]
    fs::File::open(directory)?.sync_all()?;
    Ok(destination)
}

pub fn list(root: &str, key: Option<Arc<DbEncryptionKey>>) -> anyhow::Result<Vec<Snapshot>> {
    let entries = match fs::read_dir(Path::new(root).join("backups")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(error) => return Err(error.into()),
    };
    let mut snapshots = vec![];
    for entry in entries {
        let entry = entry?;
        let filename = entry.file_name().to_string_lossy().into_owned();
        if !super::is_valid_backup_filename(&filename) || !entry.file_type()?.is_file() {
            continue;
        }
        // Listing never follows a symlink or mislabels unknown ciphertext as
        // recoverable. A busy file stays visible but unavailable for this read.
        let protection = match acquire(root, &filename) {
            Ok(lease) => match super::probe(
                lease.path.to_str().context("Invalid backup path")?,
                key.clone(),
            ) {
                Ok(access) => {
                    if access.is_encrypted() {
                        "encrypted"
                    } else {
                        "unencrypted"
                    }
                }
                Err(_) => "unavailable",
            },
            Err(_) => "unavailable",
        };
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        let reason = if filename.contains("_before-restore_") {
            SnapshotReason::BeforeRestore
        } else if filename.contains("_before-maintenance_") {
            SnapshotReason::BeforeMaintenance
        } else if filename.contains("_before-migration_") {
            SnapshotReason::BeforeMigration
        } else if filename.contains("_manual_") {
            SnapshotReason::Manual
        } else {
            SnapshotReason::Legacy
        };
        snapshots.push(Snapshot {
            filename,
            size_bytes: metadata.len(),
            modified_at: chrono::DateTime::<chrono::Utc>::from(metadata.modified()?).to_rfc3339(),
            protection,
            reason,
        });
    }
    snapshots.sort_by(|a, b| {
        b.modified_at
            .cmp(&a.modified_at)
            .then_with(|| b.filename.cmp(&a.filename))
    });
    Ok(snapshots)
}

#[cfg(test)]
thread_local! {
    pub(super) static CORRUPT_CANDIDATE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn poisoned_lease_cleanup_during_unwinding_does_not_panic() {
        // An isolated registry avoids poisoning the process-wide test registry.
        let active: &'static Mutex<HashSet<PathBuf>> =
            Box::leak(Box::new(Mutex::new(HashSet::new())));
        let path = PathBuf::from("snapshot.db");
        active.lock().unwrap().insert(path.clone());
        let _ = std::panic::catch_unwind(|| {
            let _guard = active.lock().unwrap();
            panic!("interrupted registry operation");
        });
        let unwound = std::panic::catch_unwind(|| {
            let _lease = SnapshotLease { path, active };
            panic!("operation failed while retaining a lease");
        });
        assert!(unwound.is_err());
        assert!(active.is_poisoned());
        assert!(active.lock().unwrap_err().into_inner().is_empty());
    }

    #[test]
    fn snapshot_names_are_unique_and_legacy_names_still_work() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().to_str().unwrap();
        let first = new_path(root, SnapshotReason::Manual).unwrap();
        let second = new_path(root, SnapshotReason::Manual).unwrap();
        assert_ne!(first, second);
        assert!(super::super::is_valid_backup_filename(
            first.file_name().unwrap().to_str().unwrap()
        ));
        assert!(super::super::is_valid_backup_filename(
            "wealthfolio_backup_20260514_150409.db"
        ));
        for invalid in [
            "../wealthfolio_backup_20260514_150409.db",
            "wealthfolio_backup_20261314_150409.db",
            "wealthfolio_backup_a_b_manual_11111111111111111111111111111111.db",
        ] {
            assert!(!super::super::is_valid_backup_filename(invalid));
        }
        for separator in ["/../../", "\\..\\..\\"] {
            let invalid = format!(
                "wealthfolio_backup_20260913_120000{separator}outside_manual_{}.db",
                "a".repeat(32)
            );
            assert!(!super::super::is_valid_backup_filename(&invalid));
            assert!(acquire(root, &invalid).is_err());
        }
    }

    #[test]
    fn list_reports_actual_historical_protection_and_delete_respects_lease() {
        let root = tempfile::tempdir().unwrap();
        let key = Arc::new(DbEncryptionKey::generate());
        let access = DbAccess::encrypted(root.path().join("app.db").to_str().unwrap(), key.clone());
        access.prepare().unwrap();
        access
            .connect_rusqlite()
            .unwrap()
            .execute_batch("CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES('saved')")
            .unwrap();
        let root = root.path().to_str().unwrap();
        let path = create(&access, root, SnapshotReason::Manual).unwrap();
        let name = path.file_name().unwrap().to_str().unwrap();
        assert_eq!(list(root, Some(key)).unwrap()[0].protection, "encrypted");
        assert_eq!(list(root, None).unwrap()[0].protection, "unavailable");
        let lease = acquire(root, name).unwrap();
        assert!(delete(root, name).is_err());
        drop(lease);
        delete(root, name).unwrap();
        assert!(list(root, None).unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_snapshots_are_neither_listed_nor_deleted() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("outside.db");
        fs::write(&target, b"preserve").unwrap();
        let path = new_path(root.path().to_str().unwrap(), SnapshotReason::Manual).unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();
        let root = root.path().to_str().unwrap();
        assert!(list(root, None).unwrap().is_empty());
        assert!(delete(root, path.file_name().unwrap().to_str().unwrap()).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"preserve");
    }

    #[test]
    fn partial_and_corrupt_snapshots_are_not_published() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("app.db");
        fs::write(&path, b"invalid database").unwrap();
        let access = DbAccess::plaintext(path.to_str().unwrap());
        let root = root.path().to_str().unwrap();
        assert!(create(&access, root, SnapshotReason::Manual).is_err());
        assert!(list(root, None).unwrap().is_empty());
    }
}
