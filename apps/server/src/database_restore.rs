//! Offline portable restore. No listener, authentication discovery or service workers.
use anyhow::{ensure, Context};
use std::{fs, io::Read, path::Path, sync::Arc};
use wealthfolio_storage_sqlite::db::{self, maintenance, portable, DbAccess, DbEncryptionKey};

pub fn run_database_restore(
    path: &Path,
    password: Option<&str>,
    confirmed: bool,
) -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    let secret = crate::config::load_secret_key(
        std::env::var_os("WF_SECRET_KEY"),
        std::env::var_os("WF_SECRET_KEY_FILE"),
    )?;
    let key = Arc::new(DbEncryptionKey::from_bytes(
        &crate::auth::derive_database_key(&secret),
    ));
    let database = std::env::var("WF_DB_PATH")
        .unwrap_or_else(|_| crate::main_lib::DEFAULT_DB_PATH.to_string());
    let required = std::env::var("WF_DB_REQUIRE_ENCRYPTION")
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "true" | "1" | "yes"
            )
        })
        .unwrap_or(false);
    let destination = Path::new(&database);
    ensure!(
        fs::symlink_metadata(destination).is_ok_and(|entry| entry.is_file() && entry.len() > 0),
        "Restore requires an existing, nonempty database at {database}. Check the mounted data directory; missing or unreadable database recovery is not supported by this command."
    );
    let owner = db::DatabaseOwner::acquire(&database)
        .context("Cannot restore while the server or another database operation is running")?;
    let mut header = [0; 16];
    fs::File::open(destination)?.read_exact(&mut header)?;
    ensure!(
        (header != *b"SQLite format 3\0") == required,
        "Existing database does not match WF_DB_REQUIRE_ENCRYPTION. Correct the configuration or use db encrypt/db decrypt first; restore does not change encryption policy."
    );
    let current = DbAccess::new(&database, required.then(|| key.clone()));
    maintenance::verify_for_reopen(&current).context(
        "Destination database cannot be read with the configured key and policy. Preserve it and correct the configuration before restoring",
    )?;
    maintenance::check_sqlite_locks(&current)?;
    let root = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let root = root.to_str().context("Invalid database directory")?;
    // Match the existing offline conversion path and the shared scratch helper.
    std::env::set_var("DATABASE_URL", &database);
    let prepared = portable::prepare_import(path, &db::scratch_dir(root)?, password, Some(key))
        .context("Backup validation failed; the destination database was not replaced")?;
    println!(
        "Validated backup: {} accounts, {} activities. Destination encryption: {}.",
        prepared.summary.account_count,
        prepared.summary.activity_count,
        if required { "enabled" } else { "disabled" },
    );
    ensure!(
        confirmed,
        "Validation only: the destination database was not replaced. Run again with --yes to replace the portfolio."
    );
    let outcome = maintenance::run(
        root,
        &current,
        maintenance::MaintenanceRequest::Restore {
            backup_path: prepared.access.path().into(),
            device_key: prepared.access.key().cloned(),
        },
        &owner,
    )?;
    println!("Restore completed. Reconnect Wealthfolio Connect, device sync and custom data providers after starting the server.");
    if let Some(backup) = outcome.pre_operation_backup {
        println!("Previous database snapshot: {backup}");
    }
    Ok(())
}
