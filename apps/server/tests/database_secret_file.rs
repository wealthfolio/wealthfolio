use std::path::Path;
use std::process::{Command, Output};
use std::sync::Arc;
use tempfile::tempdir;
use wealthfolio_storage_sqlite::db::{DbAccess, DbEncryptionKey};

const KEY: &str = "--------------------------------";

fn cli(dir: &Path, operation: &str) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_wealthfolio-server"));
    command
        .args(["db", operation])
        .current_dir(dir)
        .env_clear()
        .env("WF_DB_PATH", dir.join("app.db"));
    command
}

fn output_text(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

#[test]
fn file_key_encrypts_and_decrypts_with_the_startup_derived_key() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("app.db");
    let access = DbAccess::plaintext(path.to_str().unwrap());
    access.prepare().unwrap();
    access.run_migrations().unwrap();
    access.connect_rusqlite().unwrap().execute(
        "INSERT INTO app_settings (setting_key, setting_value) VALUES ('cli_test', 'preserved')", [],
    ).unwrap();
    let key_path = dir.path().join("master key é.txt");
    std::fs::write(&key_path, format!("{KEY}\r\n")).unwrap();

    let output = cli(dir.path(), "encrypt")
        .env("WF_SECRET_KEY", "") // Compose can pass an empty optional input.
        .env("WF_SECRET_KEY_FILE", &key_path)
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", output_text(&output));
    assert_ne!(&std::fs::read(&path).unwrap()[..16], b"SQLite format 3\0");
    let key = wealthfolio_server::auth::derive_database_key(KEY.as_bytes());
    let encrypted = DbAccess::encrypted(
        path.to_str().unwrap(),
        Arc::new(DbEncryptionKey::from_bytes(&key)),
    );
    let value: String = encrypted
        .connect_rusqlite()
        .unwrap()
        .query_row(
            "SELECT setting_value FROM app_settings WHERE setting_key = 'cli_test'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(value, "preserved");

    let output = cli(dir.path(), "decrypt")
        .env("WF_SECRET_KEY_FILE", &key_path)
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", output_text(&output));
    let value: String = access
        .connect_rusqlite()
        .unwrap()
        .query_row(
            "SELECT setting_value FROM app_settings WHERE setting_key = 'cli_test'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(value, "preserved");
}

#[test]
fn encrypt_with_pending_migrations_retains_and_reports_plaintext_backup_at_relative_root() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("app.db");
    let access = DbAccess::plaintext(path.to_str().unwrap());
    access.prepare().unwrap();
    access.run_migrations().unwrap();
    access.connect_rusqlite().unwrap().execute_batch(
        "DROP TABLE asset_logos;
         DELETE FROM __diesel_schema_migrations
         WHERE version IN ('20260814000001', '20260902000001');
         INSERT INTO app_settings(setting_key, setting_value) VALUES ('cli_test', 'before upgrade');",
    ).unwrap();
    let output = cli(dir.path(), "encrypt")
        .env("WF_DB_PATH", "app.db")
        .env("WF_SECRET_KEY", KEY)
        .output()
        .unwrap();
    let text = output_text(&output);
    assert!(output.status.success(), "{text}");
    let backups =
        wealthfolio_storage_sqlite::db::snapshots::list(dir.path().to_str().unwrap(), None)
            .unwrap();
    assert_eq!(backups.len(), 1);
    assert_eq!(backups[0].protection, "unencrypted");
    assert!(text.contains(&backups[0].filename), "{text}");
    assert!(text.contains("protection: unencrypted"), "{text}");
    let snapshot = DbAccess::plaintext(
        dir.path()
            .join("backups")
            .join(&backups[0].filename)
            .to_str()
            .unwrap(),
    );
    let conn = snapshot.connect_rusqlite().unwrap();
    assert!(conn.prepare("SELECT * FROM asset_logos").is_err());
    let value: String = conn
        .query_row(
            "SELECT setting_value FROM app_settings WHERE setting_key='cli_test'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(value, "before upgrade");
    assert_ne!(&std::fs::read(path).unwrap()[..16], b"SQLite format 3\0");
}

#[test]
fn bad_secret_inputs_fail_before_modifying_the_database() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("app.db");
    DbAccess::plaintext(path.to_str().unwrap())
        .prepare()
        .unwrap();
    let before = std::fs::read(&path).unwrap();
    let key_path = dir.path().join("key.txt");
    for case in ["missing", "unreadable", "invalid", "conflicting"] {
        let mut command = cli(dir.path(), "encrypt");
        match case {
            "missing" => {}
            "unreadable" => {
                command.env("WF_SECRET_KEY_FILE", dir.path().join("missing.txt"));
            }
            "invalid" => {
                std::fs::write(&key_path, "not-a-valid-secret").unwrap();
                command.env("WF_SECRET_KEY_FILE", &key_path);
            }
            "conflicting" => {
                std::fs::write(&key_path, KEY).unwrap();
                command
                    .env("WF_SECRET_KEY", KEY)
                    .env("WF_SECRET_KEY_FILE", &key_path);
            }
            _ => unreachable!(),
        }
        let output = command.output().unwrap();
        let text = output_text(&output);
        assert!(!output.status.success(), "{case}: {text}");
        assert!(text.contains("WF_SECRET_KEY"), "{case}: {text}");
        assert!(!text.contains(KEY) && !text.contains("not-a-valid-secret"));
        assert_eq!(std::fs::read(&path).unwrap(), before, "{case}");
        assert!(
            !dir.path().join("app.db.lock").exists(),
            "must fail before database ownership: {case}"
        );
    }
}
