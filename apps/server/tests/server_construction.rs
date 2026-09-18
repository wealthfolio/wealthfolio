use wealthfolio_server::{build_state, config::Config};
use wealthfolio_storage_sqlite::db;

#[tokio::test]
async fn late_startup_failure_releases_database_users() {
    std::env::set_var("WF_AUTH_REQUIRED", "false");
    std::env::set_var(
        "WF_SECRET_KEY",
        "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
    );
    let root = tempfile::tempdir().unwrap();
    std::env::set_var("WF_SECRET_FILE", root.path().join("secrets.json"));
    let mut config = Config::from_env().unwrap();
    config.db_path = root.path().join("app.db").to_string_lossy().into_owned();
    config.addons_root = root.path().to_string_lossy().into_owned();
    config.db_encryption_required = false;
    config.oidc = None;
    config.auth = Some(wealthfolio_server::auth::AuthConfig {
        password_hash: Some("invalid-password-hash".into()),
        jwt_secret: vec![13; 32],
        access_token_ttl: std::time::Duration::from_secs(3600),
        cookie_secure: wealthfolio_server::auth::CookieSecurePolicy::Never,
    });
    let access = db::DbAccess::plaintext(&config.db_path);
    access.run_migrations().unwrap();
    access
        .connect_rusqlite()
        .unwrap()
        .execute_batch(
            "DROP TABLE asset_logos;
         DELETE FROM __diesel_schema_migrations WHERE version='20260902000001';",
        )
        .unwrap();

    let error = match build_state(&config).await {
        Ok(_) => panic!("invalid authentication configuration must fail startup"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("WF_AUTH_PASSWORD_HASH"));
    assert_exclusive_access(&config.db_path);
    let backups = db::snapshots::list(root.path().to_str().unwrap(), None).unwrap();
    assert_eq!(
        backups.len(),
        1,
        "startup backs up before initializing services"
    );
    access
        .connect_rusqlite()
        .unwrap()
        .prepare("SELECT * FROM asset_logos")
        .unwrap();
    assert!(build_state(&config).await.is_err());
    assert_eq!(
        db::snapshots::list(root.path().to_str().unwrap(), None)
            .unwrap()
            .len(),
        1,
        "a later service failure must not repeat the completed upgrade"
    );
    assert_exclusive_access(&config.db_path);
}

fn assert_exclusive_access(path: &str) {
    let _owner = db::DatabaseOwner::acquire(path).unwrap();
    // WAL exclusive locking requires every previous connection to be gone,
    // including idle pooled connections held by a detached event worker.
    let connection = db::DbAccess::plaintext(path).connect_rusqlite().unwrap();
    let journal: String = connection
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .unwrap();
    assert_eq!(journal, "wal", "exclusive-access proof requires WAL mode");
    connection.busy_timeout(std::time::Duration::ZERO).unwrap();
    connection.execute_batch(
        "PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; SELECT count(*) FROM sqlite_master; COMMIT;"
    ).expect("shutdown must release all SQLite users before returning");
}
