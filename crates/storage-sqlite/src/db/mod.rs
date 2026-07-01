use chrono::Local;
use log::{error, info, warn};
use rusqlite::Connection as RusqliteConnection;
use std::fs;
use std::io;
use std::path::Path;
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

pub type DbPool = r2d2::Pool<ConnectionManager<SqliteConnection>>;
pub type DbConnection = PooledConnection<ConnectionManager<SqliteConnection>>;

pub mod write_actor;
pub use write_actor::WriteHandle;

pub fn init(app_data_dir: &str) -> Result<String> {
    let db_path = get_db_path(app_data_dir);

    // 1. Ensure directory exists
    let db_dir = Path::new(&db_path).parent().unwrap();
    if !db_dir.exists() {
        fs::create_dir_all(db_dir)?;
    }

    {
        let mut conn = SqliteConnection::establish(&db_path).map_err(StorageError::from)?;
        conn.batch_execute(
            "\n            PRAGMA journal_mode = WAL;\n            PRAGMA foreign_keys = ON;\n            PRAGMA busy_timeout = 30000;\n            PRAGMA synchronous  = NORMAL;\n        ",
        ).map_err(StorageError::from)?;
    }

    Ok(db_path)
}

pub fn create_pool(db_path: &str) -> Result<Arc<DbPool>> {
    let manager = ConnectionManager::<SqliteConnection>::new(db_path);
    let pool = r2d2::Pool::builder()
        .max_size(8)
        .min_idle(Some(1)) // Keep at least one connection ready
        .connection_timeout(std::time::Duration::from_secs(30))
        .connection_customizer(Box::new(ConnectionCustomizer {}))
        .build(manager)
        .map_err(|e| DatabaseError::PoolCreationFailed(e.to_string()))?;
    Ok(Arc::new(pool))
}

pub fn run_migrations(db_path: &str) -> Result<()> {
    info!("Running database migrations");
    let mut connection = SqliteConnection::establish(db_path).map_err(StorageError::from)?;

    connection
        .batch_execute(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA busy_timeout = 5000;
            PRAGMA foreign_keys = OFF;
            PRAGMA synchronous = OFF;
            PRAGMA cache_size = -64000;
            PRAGMA temp_store = MEMORY;
        ",
        )
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

pub fn get_db_path(input: &str) -> String {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        // On mobile (iOS/Android), always keep the database inside the app's sandbox
        // to avoid permission issues. Ignore DATABASE_URL entirely.
        return Path::new(input)
            .join("app.db")
            .to_str()
            .unwrap()
            .to_string();
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
            .to_str()
            .unwrap()
            .to_string()
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
    fn migrated_activities_cascade_when_account_is_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("cascade.db").to_string_lossy().to_string();
        run_migrations(&db_path).unwrap();

        let mut conn = SqliteConnection::establish(&db_path).unwrap();
        conn.batch_execute(
            "
            PRAGMA foreign_keys = ON;

            INSERT INTO accounts (
                id, name, account_type, `group`, currency, is_default, is_active,
                created_at, updated_at, platform_id, account_number, meta, provider,
                provider_account_id, is_archived, tracking_mode
            ) VALUES (
                'account-to-delete', 'Test', 'REGULAR', NULL, 'USD', 0, 1,
                '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL, NULL, NULL,
                NULL, NULL, 0, 'TRANSACTIONS'
            );

            INSERT INTO assets (
                id, kind, name, display_code, is_active, quote_mode, quote_ccy,
                created_at, updated_at
            ) VALUES (
                'asset-with-activity', 'INVESTMENT', 'Asset', 'ASSET', 1, 'MANUAL', 'USD',
                '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
            );

            INSERT INTO activities (
                id, account_id, asset_id, activity_type, status, activity_date,
                quantity, unit_price, amount, fee, currency, is_user_modified,
                needs_review, created_at, updated_at
            ) VALUES (
                'activity-to-cascade', 'account-to-delete', 'asset-with-activity', 'BUY',
                'POSTED', '2026-01-01T00:00:00Z', '1', '10', '10', '0', 'USD',
                0, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
            );

            DELETE FROM accounts WHERE id = 'account-to-delete';
            ",
        )
        .unwrap();

        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM activities WHERE id = 'activity-to-cascade'"
            ),
            0
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
}

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

    if filename.len() != EXPECTED_LEN
        || !filename.starts_with(BACKUP_FILENAME_PREFIX)
        || !filename.ends_with(BACKUP_FILENAME_SUFFIX)
    {
        return false;
    }

    let timestamp =
        &filename[BACKUP_FILENAME_PREFIX.len()..filename.len() - BACKUP_FILENAME_SUFFIX.len()];
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
    let backup_dir = Path::new(app_data_dir).join("backups");
    fs::create_dir_all(&backup_dir).map_err(|e| {
        error!("Failed to create backup directory: {}", e);
        Error::Database(DatabaseError::BackupFailed(e.to_string()))
    })?;

    let backup_file = create_backup_filename(Local::now());
    let backup_path = backup_dir.join(backup_file);

    Ok(backup_path.to_str().unwrap().to_string())
}

pub fn backup_database_to_file(app_data_dir: &str, backup_path: &str) -> Result<()> {
    let db_path = get_db_path(app_data_dir);

    info!(
        "Creating database backup from {} to {}",
        db_path, backup_path
    );

    if let Some(parent) = Path::new(backup_path).parent() {
        fs::create_dir_all(parent).map_err(|e| {
            error!("Failed to create backup directory: {}", e);
            Error::Database(DatabaseError::BackupFailed(e.to_string()))
        })?;
    }

    if Path::new(backup_path).exists() {
        fs::remove_file(backup_path).map_err(|e| {
            error!("Failed to remove existing backup file: {}", e);
            Error::Database(DatabaseError::BackupFailed(e.to_string()))
        })?;
    }

    let source_conn = RusqliteConnection::open(&db_path).map_err(|e| {
        error!("Failed to open source database for backup: {}", e);
        Error::Database(DatabaseError::BackupFailed(e.to_string()))
    })?;

    source_conn
        .busy_timeout(Duration::from_secs(30))
        .map_err(|e| Error::Database(DatabaseError::BackupFailed(e.to_string())))?;

    source_conn
        .execute_batch("PRAGMA wal_checkpoint(FULL);")
        .unwrap_or_else(|e| warn!("WAL checkpoint before backup failed: {}", e));

    let escaped_backup_path = backup_path.replace('\'', "''");
    let vacuum_sql = format!("VACUUM INTO '{}';", escaped_backup_path);

    source_conn.execute_batch(&vacuum_sql).map_err(|e| {
        error!(
            "Failed to create self-contained backup via VACUUM INTO: {}",
            e
        );
        Error::Database(DatabaseError::BackupFailed(e.to_string()))
    })?;

    info!("Database backup created successfully (self-contained .db)");
    Ok(())
}

pub fn backup_database(app_data_dir: &str) -> Result<String> {
    let backup_path = create_backup_path(app_data_dir)?;

    backup_database_to_file(app_data_dir, &backup_path)?;
    Ok(backup_path)
}

pub fn restore_database(app_data_dir: &str, backup_file_path: &str) -> Result<()> {
    let db_path = get_db_path(app_data_dir);

    info!(
        "Restoring database from {} to {}",
        backup_file_path, db_path
    );

    // Verify backup file exists
    if !Path::new(backup_file_path).exists() {
        return Err(Error::Database(DatabaseError::BackupFailed(
            "Backup file not found".to_string(),
        )));
    }

    // Create backup of current database before restore
    let restore_backup_path = format!(
        "{}.pre-restore-{}",
        db_path,
        Local::now().format("%Y%m%d_%H%M%S")
    );

    if Path::new(&db_path).exists() {
        // Copy main database file
        fs::copy(&db_path, &restore_backup_path).map_err(|e| {
            error!("Failed to create pre-restore backup: {}", e);
            Error::Database(DatabaseError::BackupFailed(e.to_string()))
        })?;

        // Copy WAL file if it exists
        let current_wal_path = format!("{}-wal", db_path);
        let backup_wal_path = format!("{}-wal", restore_backup_path);
        if Path::new(&current_wal_path).exists() {
            fs::copy(&current_wal_path, &backup_wal_path).map_err(|e| {
                error!("Failed to copy WAL file during pre-restore backup: {}", e);
                Error::Database(DatabaseError::BackupFailed(e.to_string()))
            })?;
        }

        // Copy SHM file if it exists
        let current_shm_path = format!("{}-shm", db_path);
        let backup_shm_path = format!("{}-shm", restore_backup_path);
        if Path::new(&current_shm_path).exists() {
            fs::copy(&current_shm_path, &backup_shm_path).map_err(|e| {
                error!("Failed to copy SHM file during pre-restore backup: {}", e);
                Error::Database(DatabaseError::BackupFailed(e.to_string()))
            })?;
        }

        info!(
            "Created pre-restore backup at: {} (including WAL/SHM files if present)",
            restore_backup_path
        );
    }

    // Remove existing WAL and SHM files to ensure clean state.
    // On Windows, these files might be locked by active connections; tolerate sharing violations.
    let wal_path = format!("{}-wal", db_path);
    let shm_path = format!("{}-shm", db_path);

    if Path::new(&wal_path).exists() {
        if let Err(e) = try_remove_file_best_effort(&wal_path, "WAL") {
            return Err(Error::Database(DatabaseError::BackupFailed(e.to_string())));
        }
    }

    if Path::new(&shm_path).exists() {
        if let Err(e) = try_remove_file_best_effort(&shm_path, "SHM") {
            return Err(Error::Database(DatabaseError::BackupFailed(e.to_string())));
        }
    }

    // Copy the main backup file
    copy_with_retries(
        backup_file_path,
        &db_path,
        5,
        std::time::Duration::from_millis(200),
    )?;

    // Copy WAL file if it exists in backup
    let backup_wal_path = format!("{}-wal", backup_file_path);
    if Path::new(&backup_wal_path).exists() {
        if let Err(e) = copy_with_retries(
            &backup_wal_path,
            &wal_path,
            3,
            std::time::Duration::from_millis(200),
        ) {
            // WAL copy failure is non-fatal; DB will recreate WAL on next write.
            warn!("Failed to restore WAL file (non-fatal): {}", e);
        }
    }

    // Copy SHM file if it exists in backup
    let backup_shm_path = format!("{}-shm", backup_file_path);
    if Path::new(&backup_shm_path).exists() {
        if let Err(e) = copy_with_retries(
            &backup_shm_path,
            &shm_path,
            3,
            std::time::Duration::from_millis(200),
        ) {
            // SHM copy failure is non-fatal; it'll be recreated as needed.
            warn!("Failed to restore SHM file (non-fatal): {}", e);
        }
    }

    // Ensure desired journal mode; recreate WAL after restore for consistency
    if let Ok(mut conn) = SqliteConnection::establish(&db_path) {
        let _ = conn.batch_execute("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    }

    info!("Database restored successfully");
    Ok(())
}

/// Function to safely restore database with connection management
/// This is the main function that should be called from Tauri commands
pub fn restore_database_safe(app_data_dir: &str, backup_file_path: &str) -> Result<()> {
    // First, execute a checkpoint to force WAL content to be written to the main database file
    // This helps reduce the chance of WAL files being locked on Windows
    let db_path = get_db_path(app_data_dir);

    // Try to checkpoint the database before restore
    if let Ok(mut conn) = SqliteConnection::establish(&db_path) {
        use diesel::RunQueryDsl;
        let _ = diesel::sql_query("PRAGMA wal_checkpoint(TRUNCATE)").execute(&mut conn);
        // Try to temporarily switch to DELETE journal mode to minimize WAL interactions
        let _ = diesel::sql_query("PRAGMA journal_mode = DELETE").execute(&mut conn);
        info!("Executed WAL checkpoint before restore");
    }

    // Small delay to allow any pending operations to complete
    std::thread::sleep(std::time::Duration::from_millis(150));

    // Now perform the actual restore
    restore_database(app_data_dir, backup_file_path)
}

/// Gets a connection from the pool
pub fn get_connection(pool: &Pool<ConnectionManager<SqliteConnection>>) -> Result<DbConnection> {
    Ok(pool.get().map_err(StorageError::from)?)
}

#[derive(Debug)]
struct ConnectionCustomizer;

impl r2d2::CustomizeConnection<SqliteConnection, diesel::r2d2::Error> for ConnectionCustomizer {
    fn on_acquire(
        &self,
        conn: &mut SqliteConnection,
    ) -> std::result::Result<(), diesel::r2d2::Error> {
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

/// Determine if an IO error on Windows is a sharing/lock violation.
#[inline]
#[allow(unused_variables)]
fn is_sharing_violation(e: &io::Error) -> bool {
    #[cfg(target_os = "windows")]
    {
        matches!(e.raw_os_error(), Some(32) | Some(33))
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// Try to remove a file; on Windows, tolerate sharing violations and continue.
fn try_remove_file_best_effort(path: &str, label: &str) -> std::result::Result<(), io::Error> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) => {
            if is_sharing_violation(&e) {
                warn!(
                    "{} file appears to be in use ({}). Proceeding with restore anyway.",
                    label, e
                );
                Ok(())
            } else if e.kind() == io::ErrorKind::NotFound {
                Ok(())
            } else {
                error!("Failed to remove existing {} file '{}': {}", label, path, e);
                Err(e)
            }
        }
    }
}

/// Copy a file with retry/backoff; maps errors into existing Result type on failure.
fn copy_with_retries(
    src: &str,
    dst: &str,
    attempts: usize,
    backoff: std::time::Duration,
) -> Result<()> {
    let mut last_err: Option<io::Error> = None;
    for i in 0..attempts {
        match fs::copy(src, dst) {
            Ok(_) => return Ok(()),
            Err(e) => {
                last_err = Some(e);
                // On Windows, if destination is locked, wait and retry
                if let Some(ref err) = last_err {
                    if is_sharing_violation(err) {
                        warn!(
                            "Attempt {}/{}: destination appears locked when copying to '{}'. Retrying in {:?}...",
                            i + 1,
                            attempts,
                            dst,
                            backoff
                        );
                        std::thread::sleep(backoff);
                        continue;
                    }
                }
                // For other errors, retry a couple times anyway
                warn!(
                    "Attempt {}/{}: failed to copy '{}' -> '{}': {}. Retrying in {:?}...",
                    i + 1,
                    attempts,
                    src,
                    dst,
                    last_err.as_ref().unwrap(),
                    backoff
                );
                std::thread::sleep(backoff);
            }
        }
    }
    let e = last_err.unwrap_or_else(|| io::Error::other("unknown copy error"));
    error!("Failed to copy '{}' -> '{}': {}", src, dst, e);
    Err(Error::Database(DatabaseError::BackupFailed(e.to_string())))
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
