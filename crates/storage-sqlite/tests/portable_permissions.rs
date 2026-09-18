//! Real pre-write permission denial, distinct from a mid-write disk-full failure.
#![cfg(unix)]

use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::Arc,
};
use wealthfolio_storage_sqlite::db::{
    self, maintenance, portable, snapshots, DbAccess, DbEncryptionKey,
};

struct ReadOnlyDirectory(PathBuf);
impl ReadOnlyDirectory {
    fn new(path: &Path) -> Self {
        fs::set_permissions(path, fs::Permissions::from_mode(0o500)).unwrap();
        Self(path.to_path_buf())
    }
}
impl Drop for ReadOnlyDirectory {
    fn drop(&mut self) {
        fs::set_permissions(&self.0, fs::Permissions::from_mode(0o700)).unwrap();
    }
}

fn hash(path: &Path) -> Vec<u8> {
    Sha256::digest(fs::read(path).unwrap()).to_vec()
}

#[test]
fn read_only_output_preserves_inputs_and_saved_snapshots() {
    for encrypted in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let staging = tempfile::tempdir_in(root.path()).unwrap();
        let denied = tempfile::tempdir_in(root.path()).unwrap();
        let path = root.path().join("app.db");
        fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/portable-v1/plaintext.db"),
            &path,
        )
        .unwrap();
        let mut access = DbAccess::plaintext(path.to_str().unwrap());
        let owner = db::DatabaseOwner::acquire(access.path()).unwrap();
        if encrypted {
            access = maintenance::run(
                root.path().to_str().unwrap(),
                &access,
                maintenance::MaintenanceRequest::Enable {
                    key: Arc::new(DbEncryptionKey::generate()),
                },
                &owner,
            )
            .unwrap()
            .access;
        }
        let password = "read-only backup test password";
        let plain = portable::export(&access, staging.path(), None).unwrap();
        let protected = portable::export(&access, staging.path(), Some(password)).unwrap();
        let saved = snapshots::create(
            &access,
            root.path().to_str().unwrap(),
            snapshots::SnapshotReason::Manual,
        )
        .unwrap();
        let inputs = [&path, &plain.path, &protected.path, &saved];
        let hashes = inputs.map(|path| hash(path));
        let backup_dir = root.path().join("backups");
        let _staging_permissions = ReadOnlyDirectory::new(denied.path());
        let _backup_permissions = ReadOnlyDirectory::new(&backup_dir);
        // A privileged runner can bypass mode bits; never report that as proof
        // of permission-denial behavior. CI must run this under a normal user.
        let probe = denied.path().join("permission-probe");
        match fs::File::create(&probe) {
            Err(error) => assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied),
            Ok(_) => {
                fs::remove_file(probe).unwrap();
                panic!("Permission denial is bypassed; rerun this test as an unprivileged user");
            }
        }
        for (input, password) in [(&plain.path, None), (&protected.path, Some(password))] {
            assert!(portable::export(&access, denied.path(), password).is_err());
            assert!(portable::prepare_import(input, denied.path(), password, None).is_err());
        }
        assert!(snapshots::create(
            &access,
            root.path().to_str().unwrap(),
            snapshots::SnapshotReason::Manual
        )
        .is_err());
        assert_eq!(fs::read_dir(denied.path()).unwrap().count(), 0);
        let listed: Vec<_> = fs::read_dir(&backup_dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(listed.as_slice(), std::slice::from_ref(&saved));
        assert_eq!(inputs.map(|path| hash(path)), hashes);
        let saved_access = DbAccess::new(saved.to_str().unwrap(), access.key().cloned());
        let count: i64 = saved_access
            .connect_rusqlite()
            .unwrap()
            .query_row("SELECT count(*) FROM activities", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }
}
