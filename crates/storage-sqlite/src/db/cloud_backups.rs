//! Portable database boundary for personal cloud backup capture and staged import.
use super::{portable, DbAccess};
use std::{
    io::{Read, Write},
    path::Path,
};
use wealthfolio_core::secrets::SecretStore;
use wealthfolio_device_sync::backups::{self, MasterKey};
use wealthfolio_device_sync::limits::MAX_DATABASE_IMAGE_BYTES;

/// Own the private export until its reader is dropped, including failed/cancelled encoding.
pub struct PortableBackupReader {
    file: std::fs::File,
    _export: portable::PortableExport,
}
impl Read for PortableBackupReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.file.read(buffer)
    }
}
pub fn portable_reader(source: &DbAccess, root: &Path) -> anyhow::Result<PortableBackupReader> {
    let export = portable::export(source, root, None)?;
    anyhow::ensure!(
        std::fs::metadata(&export.path)?.len() <= MAX_DATABASE_IMAGE_BYTES as u64,
        backups::BackupError::SizeLimit
    );
    Ok(PortableBackupReader {
        file: std::fs::File::open(&export.path)?,
        _export: export,
    })
}

pub fn portable_image(
    source: &DbAccess,
    root: &Path,
) -> anyhow::Result<zeroize::Zeroizing<Vec<u8>>> {
    let export = portable::export(source, root, None)?;
    let size = std::fs::metadata(&export.path)?.len();
    anyhow::ensure!(
        size <= MAX_DATABASE_IMAGE_BYTES as u64,
        "Database exceeds cloud backup size limit"
    );
    // Export is an owned immutable private file; allocate its exact length once.
    let mut bytes = zeroize::Zeroizing::new(vec![0; size as usize]);
    std::fs::File::open(&export.path)?.read_exact(&mut bytes)?;
    Ok(bytes)
}
/// Consumer warning for pairing into a populated profile from an empty source.
#[allow(
    unsafe_code,
    reason = "Borrowed read-only SQLite deserialize avoids pre-consent plaintext files"
)]
pub fn snapshot_is_empty(image: &[u8]) -> anyhow::Result<bool> {
    anyhow::ensure!(
        image.len() <= MAX_DATABASE_IMAGE_BYTES,
        "Snapshot exceeds database size limit"
    );
    let connection = rusqlite::Connection::open_in_memory()?;
    // SAFETY: READONLY prevents SQLite from modifying the borrowed bytes. The
    // connection is destroyed inside this function, before the image borrow ends.
    // FREEONCLOSE and RESIZEABLE are deliberately absent: Rust owns the allocation.
    let result = unsafe {
        libsqlite3_sys::sqlite3_deserialize(
            connection.handle(),
            c"main".as_ptr(),
            image.as_ptr().cast_mut(),
            image.len().try_into()?,
            image.len().try_into()?,
            libsqlite3_sys::SQLITE_DESERIALIZE_READONLY,
        )
    };
    anyhow::ensure!(
        result == libsqlite3_sys::SQLITE_OK,
        "Cannot inspect snapshot"
    );
    connection.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY;")?;
    let has_accounts: bool =
        connection.query_row("SELECT EXISTS(SELECT 1 FROM accounts)", [], |r| r.get(0))?;
    Ok(!has_accounts)
}
/// Private temporary plaintext is consumed by the existing immutable prepared-import path.
pub fn decoded_package(
    input: impl Read,
    store: &dyn SecretStore,
    code: Option<&str>,
    root: &Path,
) -> anyhow::Result<tempfile::NamedTempFile> {
    let (header, encrypted) = backups::read_recovery_package(input)?;
    let master = if let Some(code) = code {
        backups::unwrap_recovery(
            &header.recovery,
            code,
            &header.context.user_id,
            &header.context.key_id,
        )?
    } else {
        MasterKey::load_for_key(store, &header.context.user_id, &header.context.key_id)?
            .ok_or_else(|| anyhow::anyhow!("BACKUP_RECOVERY_CODE_REQUIRED"))?
    };
    std::fs::create_dir_all(root)?;
    let mut file = tempfile::NamedTempFile::new_in(root)?;
    backups::decrypt_database_to_writer(&master, &header.context, &encrypted, &mut file)?;
    file.flush()?;
    Ok(file)
}

pub fn is_recovery_package(path: &Path) -> anyhow::Result<bool> {
    let mut header = [0; 8];
    std::fs::File::open(path)?.read_exact(&mut header)?;
    Ok(header.starts_with(b"WFRECV"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{copy_database, DbEncryptionKey};
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };
    use wealthfolio_device_sync::backups::{BackupContext, RecoveryPackageHeader};
    #[test]
    fn portable_reader_keeps_private_export_alive_until_consumed() {
        let root = tempfile::tempdir().unwrap();
        let scratch = tempfile::tempdir().unwrap();
        let source = DbAccess::encrypted(
            root.path().join("source.db").to_str().unwrap(),
            Arc::new(DbEncryptionKey::generate()),
        );
        source.prepare().unwrap();
        source.run_migrations().unwrap();
        let mut reader = portable_reader(&source, scratch.path()).unwrap();
        assert_eq!(std::fs::read_dir(scratch.path()).unwrap().count(), 1);
        let mut header = [0; 16];
        reader.read_exact(&mut header).unwrap();
        assert_eq!(&header, b"SQLite format 3\0");
        drop(reader);
        assert_eq!(std::fs::read_dir(scratch.path()).unwrap().count(), 0);
    }
    #[derive(Default)]
    struct Store(Mutex<HashMap<String, String>>);
    impl SecretStore for Store {
        fn get_secret(&self, name: &str) -> wealthfolio_core::Result<Option<String>> {
            Ok(self.0.lock().unwrap().get(name).cloned())
        }
        fn set_secret(&self, name: &str, value: &str) -> wealthfolio_core::Result<()> {
            self.0.lock().unwrap().insert(name.into(), value.into());
            Ok(())
        }
        fn delete_secret(&self, name: &str) -> wealthfolio_core::Result<()> {
            self.0.lock().unwrap().remove(name);
            Ok(())
        }
    }
    #[test]
    fn snapshot_empty_warning_inspects_accounts_without_plaintext_scratch() {
        let root = tempfile::tempdir().unwrap();
        let scratch = tempfile::tempdir().unwrap();
        let path = root.path().join("snapshot.db");
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection
            .execute_batch("CREATE TABLE accounts(id TEXT PRIMARY KEY)")
            .unwrap();
        assert!(snapshot_is_empty(&std::fs::read(&path).unwrap()).unwrap());
        connection
            .execute("INSERT INTO accounts VALUES ('synthetic')", [])
            .unwrap();
        assert!(!snapshot_is_empty(&std::fs::read(&path).unwrap()).unwrap());
        assert!(std::fs::read_dir(scratch.path()).unwrap().next().is_none());
    }

    #[test]
    fn cloud_package_restores_full_configuration_without_source_device_or_credentials() {
        let root = tempfile::tempdir().unwrap();
        let source = DbAccess::encrypted(
            root.path().join("source.db").to_str().unwrap(),
            Arc::new(DbEncryptionKey::generate()),
        );
        source.prepare().unwrap();
        source.run_migrations().unwrap();
        source.connect_rusqlite().unwrap().execute_batch(r#"
          INSERT INTO app_settings(setting_key,setting_value) VALUES ('theme','dark') ON CONFLICT(setting_key) DO UPDATE SET setting_value='dark';
          INSERT INTO app_settings(setting_key,setting_value) VALUES ('future.preference','full-profile');
          INSERT INTO addon_storage(addon_id,key,value) VALUES ('synthetic','preferences','{"saved":true}');
          UPDATE sync_cursor SET cursor=123;
          INSERT INTO sync_outbox(event_id,entity,entity_id,op,client_timestamp,payload,payload_key_version,created_at)
            VALUES ('event','account','account','upsert','now','{}',1,'now');
        "#).unwrap();
        let image = portable_image(&source, root.path()).unwrap();
        let ctx = BackupContext {
            format: 1,
            user_id: uuid::Uuid::new_v4().to_string(),
            key_id: uuid::Uuid::new_v4().to_string(),
            backup_id: uuid::Uuid::new_v4().to_string(),
        };
        let master = MasterKey::generate();
        let code = backups::generate_recovery_code();
        let encrypted = backups::encrypt_database(&master, &ctx, &image).unwrap();
        let header = RecoveryPackageHeader {
            format: 1,
            recovery: backups::wrap_recovery(&master, &code, &ctx.user_id, &ctx.key_id).unwrap(),
            context: ctx.clone(),
            checksum: wealthfolio_device_sync::crypto::sha256_checksum(&encrypted),
            size_bytes: encrypted.len(),
        };
        let mut package = Vec::new();
        backups::write_recovery_package(&mut package, &header, &encrypted).unwrap();
        drop(source);
        drop(master);
        drop(image);
        let fresh = Store::default();
        assert!(decoded_package(package.as_slice(), &fresh, None, root.path()).is_err());
        let file = decoded_package(package.as_slice(), &fresh, Some(&code), root.path()).unwrap();
        let destination_key = Arc::new(DbEncryptionKey::generate());
        let prepared = portable::prepare_import(
            file.path(),
            root.path(),
            None,
            Some(destination_key.clone()),
        )
        .unwrap();
        let destination = root.path().join("destination.db");
        copy_database(
            &prepared.access,
            destination.to_str().unwrap(),
            Some(&destination_key),
        )
        .unwrap();
        let restored = DbAccess::encrypted(destination.to_str().unwrap(), destination_key);
        let conn = restored.connect_rusqlite().unwrap();
        for (key, value) in [
            ("theme", "dark"),
            ("future.preference", "full-profile"),
            ("restore_reconnect_required", "true"),
        ] {
            assert_eq!(
                conn.query_row(
                    "SELECT setting_value FROM app_settings WHERE setting_key=?1",
                    [key],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
                value
            );
        }
        assert_eq!(
            conn.query_row(
                "SELECT value FROM addon_storage WHERE addon_id='synthetic'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "{\"saved\":true}"
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM sync_outbox", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(
            fresh.0.lock().unwrap().is_empty(),
            "Offline recovery must not silently install credentials"
        );
        let before = std::fs::read(&destination).unwrap();
        assert!(decoded_package(
            package.as_slice(),
            &fresh,
            Some(&backups::generate_recovery_code()),
            root.path()
        )
        .is_err());
        let end = package.len() - 1;
        package[end] ^= 1;
        assert!(decoded_package(package.as_slice(), &fresh, Some(&code), root.path()).is_err());
        assert_eq!(std::fs::read(&destination).unwrap(), before);
    }
}
