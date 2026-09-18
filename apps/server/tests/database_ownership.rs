use std::{net::SocketAddr, time::Duration};
use tempfile::tempdir;
use wealthfolio_server::{build_state, config::Config};
use wealthfolio_storage_sqlite::db::DatabaseOwner;

fn test_config(db_path: String, addons_root: String) -> Config {
    Config {
        listen_addr: "127.0.0.1:0".parse::<SocketAddr>().unwrap(),
        db_path,
        cors_allow: vec!["*".to_string()],
        request_timeout: Duration::from_secs(30),
        static_dir: "dist".to_string(),
        addons_root,
        raw_secret_key: vec![7; 32],
        secrets_encryption_key: [7; 32],
        database_key: [9; 32],
        db_encryption_required: false,
        auth: None,
        oidc: None,
        mcp_enabled: false,
        mcp_audit_enabled: true,
        mcp_allowed_hosts: None,
    }
}

#[tokio::test]
async fn startup_rejects_an_owned_database_before_cleanup_or_creation() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("app.db");
    let config = test_config(
        db_path.to_str().unwrap().to_string(),
        dir.path().join("addons").to_str().unwrap().to_string(),
    );
    let scratch = dir.path().join("scratch");
    std::fs::create_dir(&scratch).unwrap();
    let snapshot = scratch.join("active-backup.db");
    std::fs::write(&snapshot, b"in progress").unwrap();
    let owner = DatabaseOwner::acquire(db_path.to_str().unwrap()).unwrap();
    let err = build_state(&config)
        .await
        .err()
        .expect("second owner must fail");
    assert!(err
        .to_string()
        .contains("Cannot acquire database ownership"));
    assert!(!db_path.exists(), "startup must not bootstrap a database");
    assert_eq!(std::fs::read(snapshot).unwrap(), b"in progress");
    drop(owner);
}

#[test]
fn cli_rejects_an_idle_owner_before_bootstrap_and_migration() {
    use wealthfolio_storage_sqlite::db::DbAccess;
    let dir = tempdir().unwrap();
    let path = dir.path().join("app.db");
    let access = DbAccess::plaintext(path.to_str().unwrap());
    access.prepare().unwrap();
    let owner = DatabaseOwner::acquire(access.path()).unwrap();
    // This raw connection has not queried anything, so SQLite's old probe
    // alone would miss it. The process ownership guard still excludes the CLI.
    let _idle_connection = access.connect_rusqlite().unwrap();
    let before = std::fs::read(&path).unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_wealthfolio-server"))
        .args(["db", "encrypt"])
        .env("WF_DB_PATH", &path)
        .env("WF_SECRET_KEY", "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!")
        .env_remove("WF_SECRET_KEY_FILE")
        .current_dir(dir.path())
        .output()
        .unwrap();
    assert!(!output.status.success());
    let message = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        message.contains("Cannot acquire database ownership"),
        "{message}"
    );
    assert_eq!(std::fs::read(&path).unwrap(), before);
    drop(owner);
}
