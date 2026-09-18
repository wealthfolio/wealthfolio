use super::*;
use diesel::RunQueryDsl;
use tempfile::{tempdir, TempDir};

// Leave the two fixture migrations pending, independently of later migrations.
fn older_database(encrypted: bool) -> (TempDir, DbAccess, DatabaseOwner) {
    let root = tempdir().unwrap();
    let path = root.path().join("app.db");
    let access = DbAccess::new(
        path.to_str().unwrap(),
        encrypted.then(|| Arc::new(DbEncryptionKey::generate())),
    );
    let owner = DatabaseOwner::acquire(access.path()).unwrap();
    access.prepare().unwrap();
    access.run_migrations().unwrap();
    access.connect_rusqlite().unwrap().execute_batch(
        "DROP TABLE asset_logos;
         DELETE FROM __diesel_schema_migrations
         WHERE version IN ('20260814000001', '20260902000001');
         INSERT INTO app_settings(setting_key, setting_value) VALUES ('migration_test', 'original');",
    ).unwrap();
    assert_eq!(pending(&access), 2);
    (root, access, owner)
}

fn pending(access: &DbAccess) -> usize {
    access
        .connect()
        .unwrap()
        .pending_migrations(MIGRATIONS)
        .unwrap()
        .len()
}

fn listed(root: &TempDir, access: &DbAccess) -> Vec<snapshots::Snapshot> {
    snapshots::list(root.path().to_str().unwrap(), access.key().cloned()).unwrap()
}

fn snapshot_access(root: &TempDir, access: &DbAccess, name: &str) -> DbAccess {
    DbAccess::new(
        root.path().join("backups").join(name).to_str().unwrap(),
        access.key().cloned(),
    )
}

fn upgrade(root: &TempDir, access: &DbAccess, owner: &DatabaseOwner) -> Result<()> {
    access.run_migrations_with_backup(root.path().to_str().unwrap(), owner)
}

#[test]
fn fresh_current_and_scratch_databases_do_not_create_backups() {
    for encrypted in [false, true] {
        let root = tempdir().unwrap();
        let access = DbAccess::new(
            root.path().join("app.db").to_str().unwrap(),
            encrypted.then(|| Arc::new(DbEncryptionKey::generate())),
        );
        let owner = DatabaseOwner::acquire(access.path()).unwrap();
        access.prepare().unwrap();
        upgrade(&root, &access, &owner).unwrap();
        assert_eq!(pending(&access), 0);
        // Even zero free space must not block a current database.
        space::with_available(0, || upgrade(&root, &access, &owner)).unwrap();
        let scratch = DbAccess::plaintext(root.path().join("reference.db").to_str().unwrap());
        scratch.run_migrations().unwrap();
        assert!(!root.path().join("backups").exists());
    }
}

#[test]
fn one_verified_snapshot_preserves_original_schema_and_committed_wal_data() {
    for encrypted in [false, true] {
        let (root, access, owner) = older_database(encrypted);
        let writer = access.connect_rusqlite().unwrap();
        writer.execute_batch("PRAGMA wal_autocheckpoint=0;
            UPDATE app_settings SET setting_value='committed in WAL' WHERE setting_key='migration_test';").unwrap();
        assert!(
            fs::metadata(format!("{}-wal", access.path()))
                .unwrap()
                .len()
                > 32
        );
        let start = std::time::Instant::now();
        upgrade(&root, &access, &owner).unwrap();
        eprintln!(
            "two-migration upgrade + snapshot (encrypted={encrypted}): {:?}",
            start.elapsed()
        );
        assert_eq!(pending(&access), 0);
        let snapshots = listed(&root, &access);
        assert_eq!(snapshots.len(), 1);
        assert_eq!(
            snapshots[0].protection,
            if encrypted {
                "encrypted"
            } else {
                "unencrypted"
            }
        );
        assert!(matches!(
            snapshots[0].reason,
            snapshots::SnapshotReason::BeforeMigration
        ));
        assert!(is_valid_backup_filename(&snapshots[0].filename));
        let backup = snapshot_access(&root, &access, &snapshots[0].filename);
        assert_eq!(pending(&backup), 2);
        let conn = backup.connect_rusqlite().unwrap();
        maintenance::integrity_check(&conn).unwrap();
        if encrypted {
            maintenance::cipher_integrity_check(&conn).unwrap();
        }
        let value: String = conn
            .query_row(
                "SELECT setting_value FROM app_settings WHERE setting_key='migration_test'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(value, "committed in WAL");
        let logos: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='asset_logos')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!logos);
        drop(conn);
        drop(writer);
        upgrade(&root, &access, &owner).unwrap();
        assert_eq!(listed(&root, &access).len(), 1);
    }
}

#[test]
fn failure_and_retry_retain_each_attempt_without_overwriting_the_original() {
    let (root, access, owner) = older_database(false);
    access
        .connect_rusqlite()
        .unwrap()
        .execute_batch("CREATE TABLE asset_logos(conflict TEXT);")
        .unwrap();
    let error = upgrade(&root, &access, &owner).unwrap_err().to_string();
    assert_eq!(pending(&access), 1, "the first migration committed");
    let first = listed(&root, &access).remove(0);
    let original = snapshot_access(&root, &access, &first.filename);
    assert!(error.contains(original.path()), "{error}");
    let original_bytes = fs::read(original.path()).unwrap();
    assert_eq!(pending(&original), 2);
    assert!(upgrade(&root, &access, &owner).is_err());
    let all = listed(&root, &access);
    assert_eq!(all.len(), 2);
    let retry = all
        .iter()
        .find(|entry| entry.filename != first.filename)
        .unwrap();
    assert_eq!(
        pending(&snapshot_access(&root, &access, &retry.filename)),
        1
    );
    assert_eq!(fs::read(original.path()).unwrap(), original_bytes);
}

#[test]
fn backup_preflight_copy_and_verification_failures_prevent_migrations() {
    let (root, access, owner) = older_database(false);
    let error = space::with_available(0, || upgrade(&root, &access, &owner))
        .unwrap_err()
        .to_string();
    assert!(error.contains("Not enough free space"), "{error}");
    assert_eq!(pending(&access), 2);
    assert!(listed(&root, &access).is_empty());

    fs::remove_dir(root.path().join("backups")).unwrap();
    fs::write(root.path().join("backups"), b"cannot write a snapshot here").unwrap();
    assert!(upgrade(&root, &access, &owner).is_err());
    assert_eq!(pending(&access), 2);
    fs::remove_file(root.path().join("backups")).unwrap();

    snapshots::CORRUPT_CANDIDATE.with(|value| value.set(true));
    assert!(upgrade(&root, &access, &owner).is_err());
    assert_eq!(pending(&access), 2);
    assert!(listed(&root, &access).is_empty());
    assert_eq!(
        fs::read_dir(root.path().join("backups")).unwrap().count(),
        0
    );
}

#[test]
fn missing_or_unreadable_history_is_not_treated_as_a_fresh_database() {
    for history in [
        "",
        "CREATE TABLE __diesel_schema_migrations (invalid TEXT);",
    ] {
        let root = tempdir().unwrap();
        let access = DbAccess::plaintext(root.path().join("app.db").to_str().unwrap());
        let owner = DatabaseOwner::acquire(access.path()).unwrap();
        let conn = access.connect_rusqlite().unwrap();
        conn.execute_batch("CREATE TABLE user_data (id INTEGER);")
            .unwrap();
        conn.execute_batch(history).unwrap();
        let before: i64 = conn
            .query_row("PRAGMA schema_version", [], |row| row.get(0))
            .unwrap();
        let error = upgrade(&root, &access, &owner).unwrap_err().to_string();
        assert!(error.contains("Cannot read migration history"), "{error}");
        let after: i64 = conn
            .query_row("PRAGMA schema_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(before, after, "Diesel must not create missing history");
        assert!(!root.path().join("backups").exists());
    }
}

#[test]
fn ownership_is_checked_before_opening_the_database() {
    let root = tempdir().unwrap();
    let access = DbAccess::plaintext(root.path().join("app.db").to_str().unwrap());
    let owner = DatabaseOwner::acquire(root.path().join("other.db").to_str().unwrap()).unwrap();
    assert!(upgrade(&root, &access, &owner).is_err());
    assert!(!Path::new(access.path()).exists());
}

#[test]
fn migrations_use_full_and_pooled_connections_use_normal() {
    let (root, access, owner) = older_database(false);
    access
        .connect_rusqlite()
        .unwrap()
        .execute_batch(
            "CREATE TABLE observed_sync(value INTEGER);
         CREATE TRIGGER migration_sync AFTER INSERT ON __diesel_schema_migrations BEGIN
             INSERT INTO observed_sync SELECT synchronous FROM pragma_synchronous;
         END;",
        )
        .unwrap();
    upgrade(&root, &access, &owner).unwrap();
    let conn = access.connect_rusqlite().unwrap();
    let observed: Vec<i64> = conn
        .prepare("SELECT value FROM observed_sync")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<std::result::Result<_, _>>()
        .unwrap();
    assert_eq!(observed, [2, 2]);
    #[derive(diesel::QueryableByName)]
    struct Sync {
        #[diesel(sql_type = diesel::sql_types::Integer)]
        synchronous: i32,
    }
    let pool = access.create_pool_with_owner(Arc::new(owner)).unwrap();
    let value: Sync = diesel::sql_query("PRAGMA synchronous")
        .get_result(&mut pool.get().unwrap())
        .unwrap();
    assert_eq!(value.synchronous, 1);
}

#[test]
fn migration_temp_storage_preserves_encryption_and_mobile_policy() {
    for encrypted in [false, true] {
        let (root, access, owner) = older_database(encrypted);
        access
            .connect_rusqlite()
            .unwrap()
            .execute_batch(
                "CREATE TABLE observed_temp_store(value INTEGER);
                 CREATE TRIGGER migration_temp_store AFTER INSERT ON __diesel_schema_migrations BEGIN
                     INSERT INTO observed_temp_store SELECT temp_store FROM pragma_temp_store;
                 END;",
            )
            .unwrap();
        upgrade(&root, &access, &owner).unwrap();
        let conn = access.connect_rusqlite().unwrap();
        let observed: Vec<i64> = conn
            .prepare("SELECT value FROM observed_temp_store")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<std::result::Result<_, _>>()
            .unwrap();

        // Observe the real Diesel migration connection, not a freshly opened
        // connection whose default PRAGMAs could hide a policy regression.
        if encrypted {
            assert_eq!(observed, [2, 2], "encrypted migrations must keep MEMORY");
        } else {
            #[cfg(any(target_os = "android", target_os = "ios"))]
            assert_eq!(observed, [2, 2], "mobile migrations must keep MEMORY");
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            assert_eq!(
                observed,
                [1, 1],
                "plaintext desktop/server migrations use FILE"
            );
        }
    }
}

#[test]
fn overridden_database_path_uses_and_cleans_the_explicit_backup_root() {
    let (database_root, access, owner) = older_database(false);
    let app_data = tempdir().unwrap();
    let staging = app_data.path().join("backups/.snapshot-abandoned");
    fs::create_dir_all(&staging).unwrap();
    fs::write(staging.join("candidate.db"), b"incomplete").unwrap();
    upgrade(&app_data, &access, &owner).unwrap();
    let before = listed(&app_data, &access).remove(0).filename;
    purge_scratch_dir(Path::new(access.path()), app_data.path());
    assert!(!staging.exists());
    assert_eq!(listed(&app_data, &access).remove(0).filename, before);
    assert!(!database_root.path().join("backups").exists());
}
