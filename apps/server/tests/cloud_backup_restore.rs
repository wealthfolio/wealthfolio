//! Exercise the released offline CLI boundary with synthetic SQLCipher databases.
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use std::{
    fs,
    io::Write,
    process::{Command, Stdio},
    sync::Arc,
};
use wealthfolio_device_sync::backups::{self, BackupContext, MasterKey, RecoveryPackageHeader};
use wealthfolio_storage_sqlite::db::{self, DbAccess, DbEncryptionKey};

/// env_clear() drops SYSTEMROOT on Windows; SQLCipher needs it to seed OpenSSL's RNG.
trait KeepSystemRoot {
    fn keep_systemroot(&mut self) -> &mut Self;
}

impl KeepSystemRoot for std::process::Command {
    fn keep_systemroot(&mut self) -> &mut Self {
        if let Some(root) = std::env::var_os("SYSTEMROOT") {
            self.env("SYSTEMROOT", root);
        }
        self
    }
}

#[test]
fn offline_recovery_requires_consent_and_preserves_destination_on_failure() {
    let root = tempfile::tempdir().unwrap();
    let source = DbAccess::encrypted(
        root.path().join("source.db").to_str().unwrap(),
        Arc::new(DbEncryptionKey::generate()),
    );
    source.prepare().unwrap();
    source.run_migrations().unwrap();
    source
        .connect_rusqlite()
        .unwrap()
        .execute(
            "INSERT INTO app_settings(setting_key,setting_value) VALUES ('theme','dark') ON CONFLICT(setting_key) DO UPDATE SET setting_value='dark'",
            [],
        )
        .unwrap();
    let image = db::cloud_backups::portable_image(&source, root.path()).unwrap();
    let master = MasterKey::generate();
    let code = backups::generate_recovery_code();
    let context = BackupContext {
        format: 1,
        user_id: uuid::Uuid::new_v4().to_string(),
        key_id: uuid::Uuid::new_v4().to_string(),
        backup_id: uuid::Uuid::new_v4().to_string(),
    };
    let encrypted = backups::encrypt_database(&master, &context, &image).unwrap();
    let header = RecoveryPackageHeader {
        format: 1,
        recovery: backups::wrap_recovery(&master, &code, &context.user_id, &context.key_id)
            .unwrap(),
        context,
        size_bytes: encrypted.len(),
        checksum: wealthfolio_device_sync::crypto::sha256_checksum(&encrypted),
    };
    let package = root.path().join("synthetic.wfrec");
    backups::write_recovery_package(fs::File::create(&package).unwrap(), &header, &encrypted)
        .unwrap();
    let instance_secret = [7u8; 32];
    let key = Arc::new(DbEncryptionKey::from_bytes(
        &wealthfolio_server::auth::derive_database_key(&instance_secret),
    ));
    let destination = root.path().join("app.db");
    let target = DbAccess::encrypted(destination.to_str().unwrap(), key.clone());
    target.prepare().unwrap();
    target.run_migrations().unwrap();
    target
        .connect_rusqlite()
        .unwrap()
        .execute(
            "INSERT INTO app_settings(setting_key,setting_value) VALUES ('theme','light') ON CONFLICT(setting_key) DO UPDATE SET setting_value='light'",
            [],
        )
        .unwrap();
    drop(target);
    let run = |recovery: &str, confirmed: bool| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_wealthfolio-server"));
        command
            .current_dir(root.path())
            .env_clear()
            .keep_systemroot()
            .env("WF_DB_PATH", &destination)
            .env("WF_SECRET_KEY", BASE64.encode(instance_secret))
            .env("WF_DB_REQUIRE_ENCRYPTION", "true")
            .args([
                "db",
                "restore",
                package.to_str().unwrap(),
                "--recovery-code-stdin",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if confirmed {
            command.arg("--yes");
        }
        let mut child = command.spawn().unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(recovery.as_bytes())
            .unwrap();
        child.wait_with_output().unwrap()
    };
    let before = fs::read(&destination).unwrap();
    assert!(!run(&backups::generate_recovery_code(), true)
        .status
        .success());
    assert_eq!(fs::read(&destination).unwrap(), before);
    assert!(!run(&code, false).status.success());
    assert_eq!(fs::read(&destination).unwrap(), before);
    let result = run(&code, true);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let restored = DbAccess::encrypted(destination.to_str().unwrap(), key);
    let connection = restored.connect_rusqlite().unwrap();
    for (setting, expected) in [("theme", "dark"), ("restore_reconnect_required", "true")] {
        let value: String = connection
            .query_row(
                "SELECT setting_value FROM app_settings WHERE setting_key=?1",
                [setting],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(value, expected);
    }
    assert_ne!(&fs::read(&destination).unwrap()[..16], b"SQLite format 3\0");
    assert!(
        fs::read_dir(root.path().join("backups"))
            .unwrap()
            .next()
            .is_some(),
        "Keep a pre-operation backup"
    );
}
