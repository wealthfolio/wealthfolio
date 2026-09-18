//! Password-protected, portable database copies. The installation key never
//! leaves the source; SQLCipher performs password derivation and page encryption.

use anyhow::{ensure, Context};
use rusqlite::{params, Connection, OpenFlags};
use serde::Serialize;
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};
use wealthfolio_core::quotes::{DATA_SOURCE_CUSTOM_SCRAPER, MARKET_DATA_PROVIDER_IDS};
use wealthfolio_market_data::ProviderOverrides;
use wealthfolio_spending::settings::{SETTING_KEY_ACCOUNT_IDS, SETTING_KEY_ENABLED};
use zeroize::Zeroizing;

use super::{copy_database, DbAccess, DbEncryptionKey};

// V1 pins SQLCipher 4 defaults explicitly. Unknown profiles are never guessed.
const HEADER: &[u8; 16] = b"WFOLIOBACKUP\0\0\0\x01";
pub const MAX_BACKUP_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const METADATA: &str = "wealthfolio_portable_backup";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    pub created_at: Option<String>,
    pub app_version: Option<String>,
    pub account_count: i64,
    pub activity_count: i64,
}

/// Keep this owner alive until the destination has finished consuming its file.
pub struct PreparedBackup {
    pub access: DbAccess,
    pub summary: BackupSummary,
    _workspace: tempfile::TempDir,
}

pub struct PortableExport {
    pub path: PathBuf,
    pub filename: String,
    _workspace: tempfile::TempDir,
}

pub fn validate_password(password: &str) -> anyhow::Result<()> {
    ensure!(
        (12..=1024).contains(&password.chars().count()) && password.len() <= 4096,
        "Use a backup password between 12 and 1024 characters (at most 4096 UTF-8 bytes)"
    );
    Ok(())
}

// A fixed prefix ensures SQLCipher never interprets a user-entered x'...' value
// as a raw key, bypassing password derivation. Preserve the user's bytes exactly.
fn password_key(password: &str) -> Zeroizing<String> {
    Zeroizing::new(format!("wealthfolio-portable-v1:{password}"))
}

fn password_connection(path: &Path, password: &str) -> anyhow::Result<Connection> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    let key = password_key(password);
    // SAFETY: conn owns a live SQLite handle, and key remains valid for this
    // synchronous call. SQLCipher copies the explicitly sized key material.
    // Do not interpolate passwords into PRAGMA SQL (including error messages).
    let result = unsafe {
        libsqlite3_sys::sqlite3_key(conn.handle(), key.as_ptr().cast(), key.len().try_into()?)
    };
    ensure!(result == libsqlite3_sys::SQLITE_OK, "Cannot unlock backup");
    conn.execute_batch(
        "PRAGMA cipher_compatibility = 4;
         PRAGMA kdf_iter = 256000;
         PRAGMA trusted_schema = OFF;
         PRAGMA temp_store = MEMORY;",
    )?;
    Ok(conn)
}

fn copy_with_key(source: &Connection, destination: &Path, key: &str) -> anyhow::Result<()> {
    // A read/write source opened without CREATE also prevents ATTACH from
    // creating files. Reserve the unique output explicitly and never overwrite.
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    source.execute(
        "ATTACH DATABASE ?1 AS portable KEY ?2",
        params![destination.to_str().context("Invalid backup path")?, key],
    )?;
    let copied = source.execute_batch(
        "PRAGMA portable.cipher_compatibility = 4;
         PRAGMA portable.kdf_iter = 256000;
         SELECT sqlcipher_export('portable');",
    );
    let detached = source.execute_batch("DETACH DATABASE portable;");
    copied?;
    detached?;
    Ok(())
}

fn workspace(root: &Path) -> anyhow::Result<tempfile::TempDir> {
    fs::create_dir_all(root)?;
    Ok(tempfile::Builder::new()
        .prefix("portable-")
        .tempdir_in(root)?)
}

fn encrypted_access(path: &Path) -> anyhow::Result<DbAccess> {
    Ok(DbAccess::encrypted(
        path.to_str().context("Invalid backup path")?,
        Arc::new(DbEncryptionKey::generate()),
    ))
}

fn validate_database(conn: &Connection, encrypted: bool, file_len: u64) -> anyhow::Result<()> {
    conn.execute_batch("PRAGMA trusted_schema = OFF; PRAGMA temp_store = MEMORY;")?;
    super::maintenance::integrity_check(conn)
        .map_err(|_| anyhow::anyhow!("The backup is damaged or the password is incorrect"))?;
    if encrypted {
        super::maintenance::cipher_integrity_check(conn)
            .map_err(|_| anyhow::anyhow!("The backup is damaged or the password is incorrect"))?;
    }
    let pages: u32 = conn.pragma_query_value(None, "page_count", |row| row.get(0))?;
    let size = conn.pragma_query_value(None, "page_size", |row| {
        row.get::<_, rusqlite::types::Value>(0)
    })?;
    let size: u32 = match size {
        rusqlite::types::Value::Integer(value) => value.try_into()?,
        rusqlite::types::Value::Text(value) => value.parse()?,
        _ => anyhow::bail!("Invalid database page size"),
    };
    ensure!(
        u64::from(pages).checked_mul(u64::from(size)) == Some(file_len),
        "The backup has an invalid length"
    );
    for table in ["accounts", "activities", "__diesel_schema_migrations"] {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
            [table],
            |r| r.get(0),
        )?;
        ensure!(exists, "This file is not a Wealthfolio database");
    }
    // Backups before the key/value settings migration must reach the staged
    // migrations. The complete current schema is verified afterward.
    let settings_exist: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('app_settings','settings'))",
        [],
        |r| r.get(0),
    )?;
    ensure!(settings_exist, "This file is not a Wealthfolio database");
    use diesel::migration::MigrationSource;
    let known = <diesel_migrations::EmbeddedMigrations as MigrationSource<
        diesel::sqlite::Sqlite,
    >>::migrations(&super::MIGRATIONS)
    .map_err(|_| anyhow::anyhow!("Cannot read supported database versions"))?
    .iter()
    .map(|m| m.name().version().to_string())
    .collect::<Vec<_>>();
    let mut stmt = conn.prepare("SELECT version FROM __diesel_schema_migrations")?;
    for version in stmt.query_map([], |row| row.get::<_, String>(0))? {
        ensure!(
            known.contains(&version?),
            "This backup needs a newer Wealthfolio version"
        );
    }
    Ok(())
}

/// Migrate only our private copy, then compare against the schema produced by
/// this build. Migration history alone is untrusted and can claim missing DDL
/// already ran. Reject differences before offering a destructive restore.
fn migrate_and_validate(access: &DbAccess, root: &Path) -> anyhow::Result<()> {
    access
        .run_migrations()
        .map_err(|_| anyhow::anyhow!("Unsupported backup schema"))?;
    let reference = encrypted_access(&root.join("reference.db"))?;
    reference.prepare()?;
    reference.run_migrations()?;
    fn schema(conn: &Connection) -> anyhow::Result<Vec<(String, String, String)>> {
        let mut stmt = conn.prepare(
            "SELECT type,name,sql FROM sqlite_master
             WHERE name NOT GLOB 'sqlite_*' AND name != 'wealthfolio_portable_backup'
             AND sql IS NOT NULL ORDER BY type,name",
        )?;
        let rows = stmt
            .query_map([], |r| {
                let sql: String = r.get(2)?;
                Ok((r.get(0)?, r.get(1)?, sql.replace("\r\n", "\n")))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
    ensure!(
        schema(&access.connect_rusqlite()?)? == schema(&reference.connect_rusqlite()?)?,
        "The backup schema does not match a supported Wealthfolio database"
    );
    Ok(())
}

fn validate_foreign_keys(conn: &Connection) -> anyhow::Result<()> {
    ensure!(
        !conn.prepare("PRAGMA foreign_key_check")?.exists([])?,
        "The backup contains invalid data relationships"
    );
    Ok(())
}

fn portable_asset_provider_config(raw: &str) -> Option<String> {
    let config: serde_json::Value = serde_json::from_str(raw).ok()?;
    let builtin =
        |id: &str| MARKET_DATA_PROVIDER_IDS.contains(&id) && id != DATA_SOURCE_CUSTOM_SCRAPER;
    let mut clean = serde_json::Map::new();
    if let Some(provider) = config.get("preferred_provider").and_then(|v| v.as_str()) {
        if builtin(provider) {
            clean.insert("preferred_provider".into(), provider.into());
        }
    }
    if let Some(overrides) = config.get("overrides").and_then(|v| v.as_object()) {
        let filtered = overrides
            .iter()
            .filter(|(id, _)| builtin(id))
            .map(|(id, value)| (id.clone(), value.clone()))
            .collect();
        // Deserialize and reserialize known instrument fields so arbitrary
        // nested credentials cannot travel inside an otherwise valid override.
        if let Ok(overrides) = ProviderOverrides::from_json(&serde_json::Value::Object(filtered)) {
            if !overrides.is_empty() {
                clean.insert("overrides".into(), serde_json::to_value(overrides).ok()?);
            }
        }
    }
    (!clean.is_empty()).then(|| serde_json::Value::Object(clean).to_string())
}

fn sanitize(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "PRAGMA secure_delete = ON; PRAGMA foreign_keys = OFF; PRAGMA temp_store = MEMORY;",
    )?;
    // Installation state must not replay requests, grant access, or associate
    // destination credentials with imported accounts. Financial rows remain.
    for table in [
        "personal_access_tokens",
        "mcp_audit_log",
        "addon_storage",
        "brokers_sync_state",
        "market_data_custom_providers",
        "sync_cursor",
        "sync_outbox",
        "sync_entity_metadata",
        "sync_device_config",
        "sync_engine_state",
        "sync_table_state",
        "sync_applied_events",
    ] {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
            [table],
            |r| r.get(0),
        )?;
        if exists {
            conn.execute(&format!("DELETE FROM \"{table}\""), [])?;
        }
    }
    let mut stmt =
        conn.prepare("SELECT id, provider_config FROM assets WHERE provider_config IS NOT NULL")?;
    let configs = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    for (id, config) in configs {
        conn.execute(
            "UPDATE assets SET provider_config=?1 WHERE id=?2",
            params![portable_asset_provider_config(&config), id],
        )?;
    }
    conn.execute(
        "DELETE FROM app_settings WHERE setting_key NOT IN (
            'theme','font','language','formatting_region','base_currency','timezone',
            'onboarding_completed','auto_update_check_enabled','menu_bar_visible','default_return_metric',?1,?2)",
        params![SETTING_KEY_ENABLED, SETTING_KEY_ACCOUNT_IDS],
    )?;
    conn.execute_batch(
        "UPDATE market_data_providers SET config=NULL, enabled=0, url=NULL,
            last_synced_at=NULL, last_sync_status=NULL, last_sync_error=NULL;
         INSERT INTO app_settings(setting_key, setting_value) VALUES ('sync_enabled','false')
            ON CONFLICT(setting_key) DO UPDATE SET setting_value='false';
         INSERT INTO app_settings(setting_key, setting_value) VALUES ('restore_reconnect_required','true')
            ON CONFLICT(setting_key) DO UPDATE SET setting_value='true';",
    )?;
    // Older plaintext backups can predate the broker columns.
    let mut stmt = conn.prepare("PRAGMA table_info(accounts)")?;
    let columns = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for column in ["provider", "provider_account_id"] {
        if columns.iter().any(|name| name == column) {
            conn.execute(&format!("UPDATE accounts SET {column}=NULL"), [])?;
        }
    }
    validate_foreign_keys(conn)?;
    Ok(())
}

fn summary(conn: &Connection) -> anyhow::Result<BackupSummary> {
    let metadata_exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [METADATA],
        |r| r.get(0),
    )?;
    let (created_at, app_version) = if metadata_exists {
        conn.query_row(
            "SELECT created_at, app_version FROM wealthfolio_portable_backup WHERE id=1",
            [],
            |r| Ok((Some(r.get(0)?), Some(r.get(1)?))),
        )?
    } else {
        (None, None)
    };
    Ok(BackupSummary {
        created_at,
        app_version,
        account_count: conn.query_row("SELECT count(*) FROM accounts", [], |r| r.get(0))?,
        activity_count: conn.query_row("SELECT count(*) FROM activities", [], |r| r.get(0))?,
    })
}

/// Creates a sanitized portable copy. All intermediate databases are encrypted,
/// including when the final output is explicitly requested as plaintext.
pub fn export(
    source: &DbAccess,
    root: &Path,
    password: Option<&str>,
) -> anyhow::Result<PortableExport> {
    if let Some(password) = password {
        validate_password(password)?;
    }
    let work = workspace(root)?;
    let clean = encrypted_access(&work.path().join("clean.db"))?;
    copy_database(source, clean.path(), clean.key().map(Arc::as_ref))?;
    validate_database(
        &clean.connect_rusqlite()?,
        true,
        fs::metadata(clean.path())?.len(),
    )?;
    migrate_and_validate(&clean, work.path())?;
    let conn = clean.connect_rusqlite()?;
    sanitize(&conn)?;
    conn.execute_batch("DROP TABLE IF EXISTS wealthfolio_portable_backup;
        CREATE TABLE wealthfolio_portable_backup(id INTEGER PRIMARY KEY CHECK(id=1), profile INTEGER NOT NULL, created_at TEXT NOT NULL, app_version TEXT NOT NULL);")?;
    conn.execute(
        "INSERT INTO wealthfolio_portable_backup VALUES (1,1,?1,?2)",
        params![chrono::Utc::now().to_rfc3339(), env!("CARGO_PKG_VERSION")],
    )?;
    let filename = format!(
        "wealthfolio-{}.{}",
        chrono::Utc::now().format("%Y%m%d-%H%M%S"),
        if password.is_some() { "wfbackup" } else { "db" }
    );
    let output = work.path().join(&filename);
    if let Some(password) = password {
        let payload = work.path().join("payload.db");
        copy_with_key(&conn, &payload, &password_key(password))?;
        check_export_size(fs::metadata(&payload)?.len(), HEADER.len() as u64)?;
        let verified = password_connection(&payload, password)?;
        validate_database(&verified, true, fs::metadata(&payload)?.len())?;
        drop(verified);
        let mut out = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output)?;
        out.write_all(HEADER)?;
        std::io::copy(&mut fs::File::open(&payload)?, &mut out)?;
        out.sync_all()?;
    } else {
        copy_with_key(&conn, &output, "")?;
        check_export_size(fs::metadata(&output)?.len(), 0)?;
    }
    Ok(PortableExport {
        path: output,
        filename,
        _workspace: work,
    })
}

fn check_export_size(payload: u64, header: u64) -> anyhow::Result<()> {
    ensure!(
        payload
            .checked_add(header)
            .is_some_and(|size| size <= MAX_BACKUP_BYTES),
        "Backup exceeds the supported 2 GiB limit"
    );
    Ok(())
}

pub fn needs_password(path: &Path) -> anyhow::Result<bool> {
    let mut header = [0; 16];
    fs::File::open(path)?
        .read_exact(&mut header)
        .context("The backup file is too short")?;
    if header.starts_with(b"WFOLIOBACKUP") {
        ensure!(&header == HEADER, "Unsupported portable backup version");
        return Ok(true);
    }
    Ok(false)
}

/// Validate and privately stage an input before asking the user to replace data.
/// The returned file uses a fresh random key; the password need not be retained.
/// Callers must separately quiesce the runtime and disconnect installation sync
/// credentials before starting services over this candidate. Database settings
/// alone do not prevent a retained device-sync session from starting.
pub fn prepare_import(
    path: &Path,
    root: &Path,
    password: Option<&str>,
    legacy_key: Option<Arc<DbEncryptionKey>>,
) -> anyhow::Result<PreparedBackup> {
    let size = fs::metadata(path)?.len();
    ensure!(
        (16..=MAX_BACKUP_BYTES).contains(&size),
        "Backup must be at most 2 GiB"
    );
    let protected = needs_password(path)?;
    if !protected {
        // A selected .db is a standalone backup, not a live database directory.
        // Silently omitting committed WAL transactions would lose user data.
        let mut wal = path.as_os_str().to_os_string();
        wal.push("-wal");
        match fs::metadata(Path::new(&wal)) {
            Ok(metadata) => ensure!(metadata.len() == 0,
                "This database has pending WAL data. Close the source app and create a complete backup first"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(error) => return Err(error.into()),
        }
    }
    let work = workspace(root)?;
    let staged = work.path().join("input.db");
    let mut input = fs::File::open(path)?;
    let password = if protected {
        Some(password.context("A backup password is required")?)
    } else {
        None
    };
    if let Some(password) = password {
        validate_password(password)?;
        let mut header = [0; 16];
        input.read_exact(&mut header)?;
        ensure!(&header == HEADER, "Backup changed during import");
    }
    let mut out = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&staged)?;
    let copied = std::io::copy(&mut input.take(MAX_BACKUP_BYTES + 1), &mut out)?;
    ensure!(
        copied == size - if protected { 16 } else { 0 },
        "Backup changed during import"
    );
    out.sync_all()?;
    drop(out);
    let conn = if let Some(password) = password {
        password_connection(&staged, password)?
    } else {
        super::probe(staged.to_str().context("Invalid backup path")?, legacy_key)
            .map_err(|_| {
                anyhow::anyhow!("This encrypted snapshot needs its original installation key")
            })?
            .connect_rusqlite()?
    };
    let mut database_header = [0; 16];
    fs::File::open(&staged)?.read_exact(&mut database_header)?;
    let encrypted = protected || &database_header != super::SQLITE_MAGIC;
    validate_database(&conn, encrypted, copied).map_err(|_| {
        anyhow::anyhow!(
            "The backup is invalid, damaged, from a newer version, or the password is incorrect"
        )
    })?;
    if protected {
        let profile: i64 = conn.query_row(
            "SELECT profile FROM wealthfolio_portable_backup WHERE id=1",
            [],
            |r| r.get(0),
        )?;
        ensure!(profile == 1, "Invalid backup profile");
    }
    let details = summary(&conn)?;
    let clean = encrypted_access(&work.path().join("clean.db"))?;
    let raw_key = Zeroizing::new(format!(
        "x'{}'",
        clean
            .key()
            .expect("encrypted_access should supply a key")
            .as_hex()
    ));
    copy_with_key(&conn, Path::new(clean.path()), &raw_key)?;
    drop(conn);
    migrate_and_validate(&clean, work.path())?;
    let conn = clean.connect_rusqlite()?;
    sanitize(&conn)?;
    // The migration that originally created this local identity is already
    // recorded. Restored services need a fresh identity, never the source's.
    conn.execute_batch("INSERT INTO app_settings(setting_key, setting_value) VALUES ('instance_id', hex(randomblob(16)));")?;
    conn.execute_batch("DROP TABLE IF EXISTS wealthfolio_portable_backup;")?;
    drop(conn);
    // Re-export into a fresh file so deleted authorization data cannot survive
    // in freelist pages, including if the destination will be plaintext.
    let access = encrypted_access(&work.path().join("restore.db"))?;
    copy_database(&clean, access.path(), access.key().map(Arc::as_ref))?;
    Ok(PreparedBackup {
        access,
        summary: details,
        _workspace: work,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{DbAccess, DbEncryptionKey};
    use rusqlite::OptionalExtension;
    use std::sync::Arc;

    fn seeded(dir: &Path, encrypted: bool) -> DbAccess {
        let access = DbAccess::new(
            dir.join("source.db").to_str().unwrap(),
            encrypted.then(|| Arc::new(DbEncryptionKey::generate())),
        );
        access.prepare().unwrap();
        access.run_migrations().unwrap();
        let conn = access.connect_rusqlite().unwrap();
        conn.execute_batch("INSERT INTO app_settings(setting_key,setting_value) VALUES ('theme','dark') ON CONFLICT(setting_key) DO UPDATE SET setting_value='dark';
            INSERT INTO personal_access_tokens(id,name,token_prefix,token_hash) VALUES ('test','Synthetic token','wf','DO_NOT_EXPORT_TOKEN_HASH');").unwrap();
        access
    }

    #[test]
    fn portable_roundtrips_preserve_data_and_remove_authorization() {
        for encrypted in [false, true] {
            for password in [None, Some("a portable 日本語 password")] {
                let dir = tempfile::tempdir().unwrap();
                let source = seeded(dir.path(), encrypted);
                let output = export(&source, dir.path(), password).unwrap();
                assert_eq!(needs_password(&output.path).unwrap(), password.is_some());
                let prepared = prepare_import(&output.path, dir.path(), password, None).unwrap();
                let conn = prepared.access.connect_rusqlite().unwrap();
                let source_id: String = source
                    .connect_rusqlite()
                    .unwrap()
                    .query_row(
                        "SELECT setting_value FROM app_settings WHERE setting_key='instance_id'",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                let restored_id: String = conn
                    .query_row(
                        "SELECT setting_value FROM app_settings WHERE setting_key='instance_id'",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(restored_id.len(), 32);
                assert_ne!(source_id, restored_id);
                assert_eq!(conn.query_row(
                    "SELECT setting_value FROM app_settings WHERE setting_key='restore_reconnect_required'", [],
                    |r| r.get::<_, String>(0)).unwrap(), "true");
                assert_eq!(
                    conn.query_row(
                        "SELECT setting_value FROM app_settings WHERE setting_key='theme'",
                        [],
                        |r| r.get::<_, String>(0)
                    )
                    .unwrap(),
                    "dark"
                );
                assert_eq!(
                    conn.query_row("SELECT count(*) FROM personal_access_tokens", [], |r| r
                        .get::<_, i64>(0))
                        .unwrap(),
                    0
                );
                assert_eq!(
                    conn.query_row(
                        "SELECT setting_value FROM app_settings WHERE setting_key='sync_enabled'",
                        [],
                        |r| r.get::<_, String>(0)
                    )
                    .unwrap(),
                    "false"
                );
                assert_eq!(
                    source
                        .connect_rusqlite()
                        .unwrap()
                        .query_row("SELECT count(*) FROM personal_access_tokens", [], |r| r
                            .get::<_, i64>(0))
                        .unwrap(),
                    1
                );
                // Both destination policies use their own raw key, not the password.
                for key in [None, Some(Arc::new(DbEncryptionKey::generate()))] {
                    let destination = dir.path().join(format!("destination-{}.db", key.is_some()));
                    copy_database(
                        &prepared.access,
                        destination.to_str().unwrap(),
                        key.as_deref(),
                    )
                    .unwrap();
                    let restored = DbAccess::new(destination.to_str().unwrap(), key);
                    assert_eq!(
                        restored
                            .connect_rusqlite()
                            .unwrap()
                            .query_row(
                                "SELECT setting_value FROM app_settings WHERE setting_key='theme'",
                                [],
                                |r| r.get::<_, String>(0)
                            )
                            .unwrap(),
                        "dark"
                    );
                }
            }
        }
    }

    #[test]
    fn wrong_password_corruption_and_unsupported_headers_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let source = seeded(dir.path(), true);
        let password = "correct backup password";
        let output = export(&source, dir.path(), Some(password)).unwrap();
        assert!(prepare_import(
            &output.path,
            dir.path(),
            Some("wrong backup password"),
            None
        )
        .is_err());
        assert!(prepare_import(&output.path, dir.path(), None, None).is_err());
        let original = fs::read(&output.path).unwrap();
        for mode in ["header", "payload", "truncated", "appended"] {
            let mut changed = original.clone();
            match mode {
                "header" => changed[15] = 2,
                "payload" => changed[1024] ^= 1,
                "truncated" => {
                    changed.truncate(changed.len() - 1);
                }
                "appended" => changed.extend_from_slice(&[0; 4096]),
                _ => unreachable!(),
            }
            let damaged = dir.path().join("damaged.wfbackup");
            fs::write(&damaged, changed).unwrap();
            assert!(
                prepare_import(&damaged, dir.path(), Some(password), None).is_err(),
                "{mode}"
            );
        }
    }

    #[test]
    fn raw_key_looking_passwords_still_use_password_derivation() {
        let dir = tempfile::tempdir().unwrap();
        let source = seeded(dir.path(), true);
        let password = format!("x'{}'", "a".repeat(64));
        let output = export(&source, dir.path(), Some(&password)).unwrap();
        assert!(prepare_import(&output.path, dir.path(), Some(&password), None).is_ok());
        assert!(prepare_import(&output.path, dir.path(), Some(&"a".repeat(64)), None).is_err());
    }

    #[test]
    fn password_errors_never_include_password_material() {
        let dir = tempfile::tempdir().unwrap();
        let source = seeded(dir.path(), true);
        let password = "sentinel-secret\0with-nul";
        let output = export(&source, dir.path(), Some(password)).unwrap();
        assert!(prepare_import(&output.path, dir.path(), Some(password), None).is_ok());
        // Explicit byte lengths must also distinguish suffixes after NUL.
        assert!(prepare_import(
            &output.path,
            dir.path(),
            Some("sentinel-secret\0other"),
            None
        )
        .is_err());
        let error = prepare_import(
            &output.path,
            dir.path(),
            Some("sentinel-secret\0incorrect"),
            None,
        )
        .err()
        .unwrap();
        assert!(!format!("{error:?}").contains("sentinel-secret"));
    }

    #[test]
    fn portable_import_accepts_lf_and_crlf_schema_definitions() {
        for line_ending in ["\n", "\r\n"] {
            let dir = tempfile::tempdir().unwrap();
            let source = seeded(dir.path(), false);
            {
                let conn = source.connect_rusqlite().unwrap();
                // Simulate SQLite preserving migration text from either checkout
                // style. Reopen afterward so SQLite reloads the changed schema.
                conn.execute_batch("PRAGMA writable_schema = ON;").unwrap();
                conn.execute(
                    "UPDATE sqlite_master SET sql = replace(replace(sql, char(13) || char(10), char(10)), char(10), ?1) WHERE sql IS NOT NULL",
                    [line_ending],
                ).unwrap();
                conn.execute_batch("PRAGMA writable_schema = OFF;").unwrap();
            }
            let prepared = prepare_import(Path::new(source.path()), dir.path(), None, None)
                .expect("Platform line endings must not change schema compatibility");
            assert_eq!(prepared.summary.account_count, 0);
        }
    }

    #[test]
    fn known_migration_history_cannot_hide_a_broken_schema() {
        for mutation in [
            "DROP TABLE goals",
            "ALTER TABLE app_settings RENAME TO settings",
            "ALTER TABLE accounts ADD COLUMN unexpected TEXT",
            "DELETE FROM __diesel_schema_migrations",
            "CREATE TABLE sqliteXprivate(secret TEXT)",
            "CREATE VIEW unexpected AS SELECT id FROM accounts",
            "CREATE TRIGGER unexpected AFTER INSERT ON accounts BEGIN SELECT 1; END",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let source = seeded(dir.path(), false);
            source
                .connect_rusqlite()
                .unwrap()
                .execute_batch(mutation)
                .unwrap();
            assert!(
                prepare_import(Path::new(source.path()), dir.path(), None, None).is_err(),
                "{mutation}"
            );
        }
    }

    #[test]
    fn provider_secrets_and_references_are_removed_from_export() {
        let dir = tempfile::tempdir().unwrap();
        let source = seeded(dir.path(), false);
        source.connect_rusqlite().unwrap().execute_batch(
            "INSERT INTO market_data_custom_providers(id,code,name,config,created_at,updated_at)
                VALUES('custom','custom','Private source','{\"headers\":{\"Authorization\":\"SENTINEL_CUSTOM_SECRET\"}}','now','now');
             UPDATE market_data_providers SET config='{\"secret\":\"__SECRET__SENTINEL_VAULT_REF\"}', url='https://example.com/SENTINEL_URL_SECRET';"
        ).unwrap();
        let output = export(&source, dir.path(), None).unwrap();
        let bytes = fs::read(&output.path).unwrap();
        for sentinel in [
            "SENTINEL_CUSTOM_SECRET",
            "SENTINEL_VAULT_REF",
            "SENTINEL_URL_SECRET",
            "DO_NOT_EXPORT_TOKEN_HASH",
        ] {
            assert!(
                !bytes
                    .windows(sentinel.len())
                    .any(|part| part == sentinel.as_bytes()),
                "{sentinel}"
            );
        }
        let prepared = prepare_import(&output.path, dir.path(), None, None).unwrap();
        let conn = prepared.access.connect_rusqlite().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM market_data_custom_providers",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM market_data_providers WHERE config IS NOT NULL OR enabled=1",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }

    #[test]
    fn export_size_includes_format_header() {
        assert!(check_export_size(MAX_BACKUP_BYTES - 16, 16).is_ok());
        assert!(check_export_size(MAX_BACKUP_BYTES - 15, 16).is_err());
        assert!(check_export_size(MAX_BACKUP_BYTES, 0).is_ok());
        assert!(check_export_size(u64::MAX, 16).is_err());
    }

    #[test]
    fn invalid_foreign_keys_are_rejected_before_restore() {
        let dir = tempfile::tempdir().unwrap();
        let source = seeded(dir.path(), false);
        source.connect_rusqlite().unwrap().execute_batch(
            "PRAGMA foreign_keys=OFF;
             INSERT INTO import_runs(id,account_id,source_system,run_type,mode,status,started_at,review_mode)
             VALUES ('orphan','nonexistent','test','test','test','test','now','test');"
        ).unwrap();
        assert!(prepare_import(Path::new(source.path()), dir.path(), None, None).is_err());
    }

    #[test]
    fn legacy_encrypted_snapshot_requires_original_key() {
        let dir = tempfile::tempdir().unwrap();
        let source = seeded(dir.path(), true);
        assert!(prepare_import(
            Path::new(source.path()),
            dir.path(),
            None,
            source.key().cloned()
        )
        .is_ok());
        assert!(prepare_import(
            Path::new(source.path()),
            dir.path(),
            None,
            Some(Arc::new(DbEncryptionKey::generate()))
        )
        .is_err());
    }

    #[test]
    fn never_silently_omit_legacy_wal_data() {
        let dir = tempfile::tempdir().unwrap();
        let source = seeded(dir.path(), false);
        let conn = source.connect_rusqlite().unwrap();
        conn.execute_batch("PRAGMA wal_autocheckpoint=0; UPDATE app_settings SET setting_value='light' WHERE setting_key='theme'").unwrap();
        let error = prepare_import(Path::new(source.path()), dir.path(), None, None)
            .err()
            .unwrap();
        assert!(error.to_string().contains("WAL"));
    }

    #[test]
    fn portable_spending_settings_survive_roundtrip() {
        use wealthfolio_spending::settings::{SETTING_KEY_ACCOUNT_IDS, SETTING_KEY_ENABLED};
        for password in [None, Some("synthetic backup password")] {
            let dir = tempfile::tempdir().unwrap();
            let source = seeded(dir.path(), false);
            let settings = [
                (SETTING_KEY_ENABLED, "true"),
                (SETTING_KEY_ACCOUNT_IDS, r#"["spending-account"]"#),
            ];
            {
                let conn = source.connect_rusqlite().unwrap();
                conn.execute_batch("INSERT INTO accounts(id,name,currency) VALUES('spending-account','Spending','USD'),('other-account','Other','USD');").unwrap();
                for (key, value) in settings {
                    conn.execute(
                        "INSERT INTO app_settings(setting_key,setting_value) VALUES (?1,?2) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value",
                        params![key, value],
                    )
                    .unwrap();
                }
            }
            let output = export(&source, dir.path(), password).unwrap();
            let restored = prepare_import(&output.path, dir.path(), password, None).unwrap();
            let conn = restored.access.connect_rusqlite().unwrap();
            assert_eq!(restored.summary.account_count, 2);
            for (key, value) in settings {
                let actual: Option<String> = conn
                    .query_row(
                        "SELECT setting_value FROM app_settings WHERE setting_key=?1",
                        [key],
                        |r| r.get(0),
                    )
                    .optional()
                    .unwrap();
                assert_eq!(actual.as_deref(), Some(value), "Lost {key}");
            }
        }
    }

    #[test]
    fn portable_builtin_quote_overrides_survive_roundtrip() {
        for password in [None, Some("synthetic backup password")] {
            let dir = tempfile::tempdir().unwrap();
            let source = seeded(dir.path(), false);
            let config = serde_json::json!({
                "preferred_provider": "YAHOO",
                "overrides": {
                    "YAHOO": {"type":"equity_symbol", "symbol":"SHOP.TO", "secret":"SYNTHETIC_NESTED_SECRET"},
                    "CUSTOM:private": {"type":"equity_symbol", "symbol":"SYNTHETIC_CUSTOM_SYMBOL"}
                },
                "custom_provider_code":"SYNTHETIC_CUSTOM_REFERENCE",
                "headers":{"Authorization":"SYNTHETIC_AUTHORIZATION"}
            });
            {
                let conn = source.connect_rusqlite().unwrap();
                conn.execute("INSERT INTO assets(id,kind,quote_mode,quote_ccy,instrument_type,instrument_symbol,provider_config) VALUES('quote-asset','INVESTMENT','MARKET','CAD','EQUITY','SHOP',?1)", [config.to_string()]).unwrap();
            }
            let output = export(&source, dir.path(), password).unwrap();
            let restored = prepare_import(&output.path, dir.path(), password, None).unwrap();
            let conn = restored.access.connect_rusqlite().unwrap();
            let actual: Option<String> = conn
                .query_row(
                    "SELECT provider_config FROM assets WHERE id='quote-asset'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            let actual: serde_json::Value =
                serde_json::from_str(&actual.expect("Built-in overrides must survive")).unwrap();
            assert_eq!(
                actual,
                serde_json::json!({"preferred_provider":"YAHOO", "overrides":{"YAHOO":{"type":"equity_symbol","symbol":"SHOP.TO"}}})
            );
            if password.is_none() {
                let bytes = fs::read(output.path).unwrap();
                for sentinel in [
                    "SYNTHETIC_NESTED_SECRET",
                    "SYNTHETIC_CUSTOM_SYMBOL",
                    "SYNTHETIC_CUSTOM_REFERENCE",
                    "SYNTHETIC_AUTHORIZATION",
                ] {
                    assert!(
                        !bytes
                            .windows(sentinel.len())
                            .any(|part| part == sentinel.as_bytes()),
                        "Leaked {sentinel}"
                    );
                }
            }
        }
    }

    #[test]
    fn portable_legacy_settings_table_reaches_staged_migrations() {
        use diesel::migration::{MigrationConnection, MigrationSource};
        use diesel_migrations::MigrationHarness;
        let dir = tempfile::tempdir().unwrap();
        let source = DbAccess::plaintext(dir.path().join("legacy.db").to_str().unwrap());
        source.prepare().unwrap();
        {
            let mut conn = source.connect().unwrap();
            conn.setup().unwrap();
            let mut migrations = <diesel_migrations::EmbeddedMigrations as MigrationSource<
                diesel::sqlite::Sqlite,
            >>::migrations(&super::super::MIGRATIONS)
            .unwrap();
            migrations.sort_by(|a, b| a.name().version().cmp(&b.name().version()));
            conn.run_migrations(&migrations[..2]).unwrap();
        }
        {
            let conn = source.connect_rusqlite().unwrap();
            conn.execute_batch("INSERT INTO settings(theme,font,base_currency) VALUES('dark','font-mono','USD'); INSERT INTO accounts(id,name,currency) VALUES('legacy-account','Legacy','USD');").unwrap();
        }
        let original = fs::read(source.path()).unwrap();
        let restored = prepare_import(Path::new(source.path()), dir.path(), None, None).unwrap();
        let conn = restored.access.connect_rusqlite().unwrap();
        assert_eq!(restored.summary.account_count, 1);
        assert_eq!(
            conn.query_row(
                "SELECT setting_value FROM app_settings WHERE setting_key='theme'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "dark"
        );
        assert_eq!(fs::read(source.path()).unwrap(), original);
    }

    #[test]
    fn older_schema_is_migrated_only_in_private_candidate() {
        use diesel_migrations::MigrationHarness;
        let dir = tempfile::tempdir().unwrap();
        let source = seeded(dir.path(), false);
        source
            .connect()
            .unwrap()
            .revert_last_migration(super::super::MIGRATIONS)
            .unwrap();
        let original = fs::read(source.path()).unwrap();
        assert!(prepare_import(Path::new(source.path()), dir.path(), None, None).is_ok());
        assert_eq!(fs::read(source.path()).unwrap(), original);
    }

    #[test]
    fn sqlcipher_password_export_is_independent_of_installation_keys() {
        let dir = tempfile::tempdir().unwrap();
        let source = DbAccess::encrypted(
            dir.path().join("source.db").to_str().unwrap(),
            Arc::new(DbEncryptionKey::generate()),
        );
        source.prepare().unwrap();
        let conn = source.connect_rusqlite().unwrap();
        conn.execute_batch(
            "CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ('preserved');",
        )
        .unwrap();
        let exported = dir.path().join("password.db");
        let password = "  user's long 日本語 passphrase  ";
        copy_with_key(&conn, &exported, &password_key(password)).unwrap();
        assert!(!std::fs::read(&exported)
            .unwrap()
            .starts_with(b"SQLite format 3\0"));
        let imported = password_connection(&exported, password).unwrap();
        let value: String = imported
            .query_row("SELECT value FROM proof", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, "preserved");
        let wrong = password_connection(&exported, password.trim()).unwrap();
        assert!(wrong
            .query_row("SELECT value FROM proof", [], |row| row.get::<_, String>(0))
            .is_err());

        let other_key = DbEncryptionKey::generate();
        let restored = dir.path().join("destination.db");
        let raw_key = zeroize::Zeroizing::new(format!("x'{}'", other_key.as_hex()));
        // SQLCipher recognizes bound raw-key literals too; the destination can
        // retain its own key without storing the backup password.
        copy_with_key(&imported, &restored, &raw_key).unwrap();
        let destination = DbAccess::encrypted(restored.to_str().unwrap(), Arc::new(other_key));
        let value: String = destination
            .connect_rusqlite()
            .unwrap()
            .query_row("SELECT value FROM proof", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, "preserved");
    }
}
