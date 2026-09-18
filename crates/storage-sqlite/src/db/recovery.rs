//! Recovery when the live database cannot be opened. Keep its original bytes
//! and sidecars before installing an independently validated portable candidate.
use super::{copy_database, maintenance, DatabaseOwner, DbAccess, DbEncryptionKey};
use anyhow::{ensure, Context, Result};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

pub struct RecoveryOutcome {
    pub access: DbAccess,
    pub preserved_directory: PathBuf,
}

fn sync_directory(_path: &Path) -> Result<()> {
    #[cfg(unix)]
    fs::File::open(_path)?.sync_all()?;
    Ok(())
}

/// Preserve an explicit encryption choice; an unreadable non-SQLite file is
/// conservatively treated as encrypted, including when its marker was lost.
pub fn requires_encryption(destination: &Path, previously_enabled: bool) -> bool {
    previously_enabled
        || (destination.exists()
            && !super::looks_like_plaintext_sqlite(&destination.to_string_lossy()))
}

/// Caller owns the unavailable runtime, has no database users, and has already
/// persisted/read back `key` if encryption is required. This never derives the
/// destination key from the backup password.
pub fn install_recovery(
    candidate: &DbAccess,
    destination: &Path,
    key: Option<Arc<DbEncryptionKey>>,
    owner: &DatabaseOwner,
) -> Result<RecoveryOutcome> {
    let destination_str = destination.to_str().context("Invalid database path")?;
    owner.check_path(destination_str)?;
    let metadata = fs::symlink_metadata(candidate.path())?;
    ensure!(
        metadata.is_file() && metadata.len() >= 16,
        "Validated recovery candidate is missing or invalid"
    );
    let root = destination.parent().context("Missing database directory")?;
    let staging = tempfile::Builder::new()
        .prefix("portable-recovery-")
        .tempdir_in(super::scratch_dir_beside(destination)?)?;
    let staged = staging.path().join("restored.db");
    let staged_path = staged.to_str().context("Invalid staging path")?;
    copy_database(candidate, staged_path, key.as_deref())?;
    let staged_access = DbAccess::new(staged_path, key.clone());
    {
        let conn = staged_access.connect_rusqlite()?;
        maintenance::integrity_check(&conn)?;
        if key.is_some() {
            maintenance::cipher_integrity_check(&conn)?;
        }
    }
    fs::OpenOptions::new()
        .write(true)
        .open(&staged)?
        .sync_all()?;

    let originals = [
        destination.to_path_buf(),
        PathBuf::from(format!("{destination_str}-wal")),
        PathBuf::from(format!("{destination_str}-shm")),
    ];
    let mut existing = Vec::new();
    let mut original_bytes = 0u64;
    for path in originals {
        match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                ensure!(
                    metadata.is_file(),
                    "Recovery refuses non-regular database files"
                );
                original_bytes = original_bytes.saturating_add(metadata.len());
                existing.push(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    // The replacement is staged and verified. Check space for the complete
    // original main/WAL/SHM archive before creating it or changing active names.
    super::space::require(root, original_bytes)?;
    let archive = root.join(format!(
        "recovery-original-{}",
        uuid::Uuid::new_v4().simple()
    ));
    fs::create_dir(&archive)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&archive, fs::Permissions::from_mode(0o700))?;
    }
    // Do not clean this directory on failure. Even a partial archive can contain
    // the only surviving copy after a subsequent filesystem/device failure.
    for original in &existing {
        let saved = archive.join(
            original
                .file_name()
                .context("Missing original database filename")?,
        );
        let mut input = fs::File::open(original)?;
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&saved)?;
        let size = input.metadata()?.len();
        ensure!(
            std::io::copy(&mut input, &mut output)? == size,
            "Original database changed during recovery"
        );
        output.sync_all()?;
    }
    sync_directory(&archive)?;
    sync_directory(root)?;
    // The complete original set is durable before touching the active names.
    for sidecar in existing.iter().filter(|path| path.as_path() != destination) {
        fs::remove_file(sidecar)?;
    }
    fs::rename(&staged, destination)?;
    sync_directory(root)?;
    Ok(RecoveryOutcome {
        access: DbAccess::new(destination_str, key),
        preserved_directory: archive,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn insufficient_archive_space_keeps_unreadable_originals_in_place() {
        let root = tempfile::tempdir().unwrap();
        let source = DbAccess::plaintext(root.path().join("backup.db").to_str().unwrap());
        source.prepare().unwrap();
        source.run_migrations().unwrap();
        let destination = root.path().join("app.db");
        for suffix in ["", "-wal", "-shm"] {
            fs::write(
                format!("{}{suffix}", destination.display()),
                format!("original{suffix}"),
            )
            .unwrap();
        }
        let owner = DatabaseOwner::acquire(destination.to_str().unwrap()).unwrap();
        let result = super::super::space::with_available(0, || {
            install_recovery(&source, &destination, None, &owner)
        });
        assert!(result
            .err()
            .unwrap()
            .to_string()
            .contains("Not enough free space"));
        for suffix in ["", "-wal", "-shm"] {
            assert_eq!(
                fs::read_to_string(format!("{}{suffix}", destination.display())).unwrap(),
                format!("original{suffix}")
            );
        }
        assert!(!fs::read_dir(root.path()).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("recovery-original-")));
    }
    #[test]
    fn recovery_preserves_unreadable_originals_and_uses_destination_key() {
        for encrypted in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let source = DbAccess::new(
                root.path().join("backup.db").to_str().unwrap(),
                Some(Arc::new(DbEncryptionKey::generate())),
            );
            source.prepare().unwrap();
            source.run_migrations().unwrap();
            let destination = root.path().join("app.db");
            for (suffix, bytes) in [
                ("", b"unreadable original".as_slice()),
                ("-wal", b"original wal"),
                ("-shm", b"original shm"),
            ] {
                fs::write(format!("{}{suffix}", destination.display()), bytes).unwrap();
            }
            let owner = DatabaseOwner::acquire(destination.to_str().unwrap()).unwrap();
            let key = encrypted.then(|| Arc::new(DbEncryptionKey::generate()));
            let recovered = install_recovery(&source, &destination, key.clone(), &owner).unwrap();
            assert_eq!(
                fs::read(recovered.preserved_directory.join("app.db")).unwrap(),
                b"unreadable original"
            );
            assert_eq!(
                fs::read(recovered.preserved_directory.join("app.db-wal")).unwrap(),
                b"original wal"
            );
            assert_eq!(
                fs::read(recovered.preserved_directory.join("app.db-shm")).unwrap(),
                b"original shm"
            );
            assert_eq!(recovered.access.is_encrypted(), encrypted);
            recovered
                .access
                .connect_rusqlite()
                .unwrap()
                .query_row("SELECT count(*) FROM accounts", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap();
        }
    }

    #[test]
    fn recovery_policy_keeps_encryption_when_marker_or_unreadable_file_requires_it() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("app.db");
        assert!(!requires_encryption(&path, false));
        assert!(requires_encryption(&path, true));
        fs::write(&path, b"unreadable encrypted bytes").unwrap();
        assert!(requires_encryption(&path, false));
        fs::write(&path, b"SQLite format 3\0rest of file").unwrap();
        assert!(!requires_encryption(&path, false));
        assert!(requires_encryption(&path, true));
    }

    #[cfg(unix)]
    #[test]
    fn recovery_rejects_symlink_sidecars_before_touching_originals() {
        let root = tempfile::tempdir().unwrap();
        let source = DbAccess::new(root.path().join("backup.db").to_str().unwrap(), None);
        source.prepare().unwrap();
        source.run_migrations().unwrap();
        let destination = root.path().join("app.db");
        fs::write(&destination, b"original").unwrap();
        let other = root.path().join("other");
        fs::write(&other, b"unrelated").unwrap();
        std::os::unix::fs::symlink(&other, root.path().join("app.db-wal")).unwrap();
        let owner = DatabaseOwner::acquire(destination.to_str().unwrap()).unwrap();
        assert!(install_recovery(&source, &destination, None, &owner).is_err());
        assert_eq!(fs::read(destination).unwrap(), b"original");
        assert_eq!(fs::read(other).unwrap(), b"unrelated");
    }

    #[test]
    fn recovery_with_missing_main_preserves_remaining_sidecars() {
        let root = tempfile::tempdir().unwrap();
        let source = DbAccess::new(root.path().join("backup.db").to_str().unwrap(), None);
        source.prepare().unwrap();
        source.run_migrations().unwrap();
        let destination = root.path().join("app.db");
        fs::write(root.path().join("app.db-wal"), b"remaining original WAL").unwrap();
        let owner = DatabaseOwner::acquire(destination.to_str().unwrap()).unwrap();
        let recovered = install_recovery(&source, &destination, None, &owner).unwrap();
        assert_eq!(
            fs::read(recovered.preserved_directory.join("app.db-wal")).unwrap(),
            b"remaining original WAL"
        );
        recovered.access.connect_rusqlite().unwrap();
    }

    #[test]
    fn invalid_candidate_never_changes_original_files() {
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join("app.db");
        fs::write(&destination, b"original").unwrap();
        let owner = DatabaseOwner::acquire(destination.to_str().unwrap()).unwrap();
        let invalid = DbAccess::new(root.path().join("missing.db").to_str().unwrap(), None);
        assert!(install_recovery(&invalid, &destination, None, &owner).is_err());
        assert_eq!(fs::read(destination).unwrap(), b"original");
    }
}
