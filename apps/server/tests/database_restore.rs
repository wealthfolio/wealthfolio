use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::Path,
    process::{Command, Output, Stdio},
    sync::Arc,
};
use wealthfolio_server::{auth::derive_database_key, database_restore::run_database_restore};
use wealthfolio_storage_sqlite::db::{self, portable, DbAccess, DbEncryptionKey};

const SECRET: &str = "--------------------------------";
const PASSWORD: &str = "  offline 日本語 backup password  ";

fn hash(path: &Path) -> Vec<u8> {
    Sha256::digest(fs::read(path).unwrap()).to_vec()
}

fn theme(access: &DbAccess) -> String {
    access
        .connect_rusqlite()
        .unwrap()
        .query_row(
            "SELECT setting_value FROM app_settings WHERE setting_key='theme'",
            [],
            |row| row.get(0),
        )
        .unwrap()
}

fn restore_cli(path: &Path, options: &[&str], password: &[u8]) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_wealthfolio-server"))
        .arg("db")
        .arg("restore")
        .arg(path)
        .args(options)
        // These would prevent ordinary authenticated startup. Offline restore
        // must not initialize listener/auth configuration.
        .env("WF_AUTH_REQUIRED", "true")
        .env("WF_AUTH_PASSWORD_HASH", "invalid-for-server-startup")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    if !password.is_empty() {
        child.stdin.take().unwrap().write_all(password).unwrap();
    } else {
        drop(child.stdin.take());
    }
    child.wait_with_output().unwrap()
}

// One test keeps process-global environment setup serial. All paths and data are synthetic.
#[test]
fn offline_restore_validates_before_replacement_and_preserves_destination_policy() {
    std::env::set_var("WF_SECRET_KEY", SECRET);
    std::env::set_var("WF_SECRET_KEY_FILE", "");
    let source_root = tempfile::tempdir().unwrap();
    let source = DbAccess::plaintext(source_root.path().join("source.db").to_str().unwrap());
    source.prepare().unwrap();
    source.run_migrations().unwrap();
    source
        .connect_rusqlite()
        .unwrap()
        .execute(
            "INSERT OR REPLACE INTO app_settings(setting_key,setting_value) VALUES('theme','dark')",
            [],
        )
        .unwrap();
    source.connect_rusqlite().unwrap().execute_batch(
        "INSERT INTO accounts(id,name,currency) VALUES('test-account','Synthetic portfolio','USD');
         INSERT INTO activities(id,account_id,activity_type,activity_date,amount,currency,created_at,updated_at)
         VALUES('test-deposit','test-account','DEPOSIT','2026-01-01T00:00:00Z','123.456789','USD','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');"
    ).unwrap();
    let protected = portable::export(&source, source_root.path(), Some(PASSWORD)).unwrap();
    let plaintext = portable::export(&source, source_root.path(), None).unwrap();
    let cli_password = format!("{PASSWORD}\r\n");
    let cli_backup = portable::export(&source, source_root.path(), Some(&cli_password)).unwrap();
    let protected_hash = hash(&protected.path);
    let plaintext_hash = hash(&plaintext.path);
    let key = Arc::new(DbEncryptionKey::from_bytes(&derive_database_key(
        SECRET.as_bytes(),
    )));

    for encrypted in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("app.db");
        std::env::set_var("WF_DB_PATH", &path);
        std::env::set_var(
            "WF_DB_REQUIRE_ENCRYPTION",
            if encrypted { "1" } else { "0" },
        );
        let current = DbAccess::new(path.to_str().unwrap(), encrypted.then(|| key.clone()));
        current.prepare().unwrap();
        current.run_migrations().unwrap();
        current
            .connect_rusqlite()
            .unwrap()
            .execute(
                "INSERT OR REPLACE INTO app_settings(setting_key,setting_value) VALUES('theme','light')",
                [],
            )
            .unwrap();
        let before = hash(&path);

        let owner = db::DatabaseOwner::acquire(current.path()).unwrap();
        let error = run_database_restore(&protected.path, Some(PASSWORD), true).unwrap_err();
        assert!(error.to_string().contains("another database operation"));
        assert_eq!(hash(&path), before);
        drop(owner);

        assert!(
            run_database_restore(&protected.path, Some("wrong backup password"), true).is_err()
        );
        assert_eq!(hash(&path), before);
        let error = run_database_restore(&protected.path, Some(PASSWORD), false).unwrap_err();
        assert!(error.to_string().contains("--yes"));
        assert_eq!(hash(&path), before);
        assert!(!root.path().join("backups").exists());

        std::env::set_var(
            "WF_DB_REQUIRE_ENCRYPTION",
            if encrypted { "0" } else { "1" },
        );
        assert!(run_database_restore(&protected.path, Some(PASSWORD), true)
            .unwrap_err()
            .to_string()
            .contains("does not match"));
        assert_eq!(hash(&path), before);
        std::env::set_var(
            "WF_DB_REQUIRE_ENCRYPTION",
            if encrypted { "1" } else { "0" },
        );

        for (backup, password) in [(&protected.path, Some(PASSWORD)), (&plaintext.path, None)] {
            current.connect_rusqlite().unwrap().execute(
                "INSERT OR REPLACE INTO app_settings(setting_key,setting_value) VALUES('theme','light')", [],
            ).unwrap();
            run_database_restore(backup, password, true).unwrap();
            assert_eq!(theme(&current), "dark");
            assert_eq!(
                !fs::read(&path).unwrap().starts_with(b"SQLite format 3\0"),
                encrypted
            );
            let conn = current.connect_rusqlite().unwrap();
            let amount: String = conn
                .query_row(
                    "SELECT amount FROM activities WHERE id='test-deposit'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(amount, "123.456789");
            let reconnect: String = conn.query_row(
                "SELECT setting_value FROM app_settings WHERE setting_key='restore_reconnect_required'", [], |row| row.get(0),
            ).unwrap();
            assert_eq!(reconnect, "true");
        }
        let snapshots =
            db::snapshots::list(root.path().to_str().unwrap(), Some(key.clone())).unwrap();
        assert_eq!(snapshots.len(), 2);
        assert!(snapshots.iter().all(|snapshot| matches!(
            snapshot.reason,
            db::snapshots::SnapshotReason::BeforeRestore
        )));
        for snapshot in snapshots {
            let access = DbAccess::new(
                root.path()
                    .join("backups")
                    .join(snapshot.filename)
                    .to_str()
                    .unwrap(),
                encrypted.then(|| key.clone()),
            );
            assert_eq!(theme(&access), "light");
        }
        assert_eq!(hash(&protected.path), protected_hash);
        assert_eq!(hash(&plaintext.path), plaintext_hash);
        assert_eq!(
            fs::read_dir(root.path().join("scratch")).unwrap().count(),
            0
        );

        current.connect_rusqlite().unwrap().execute(
            "INSERT OR REPLACE INTO app_settings(setting_key,setting_value) VALUES('theme','light')", [],
        ).unwrap();
        let before_cli = hash(&path);
        for options in [
            ["--yes", "--unknown"],
            ["--yes", "--yes"],
            ["--password-stdin", "--password-stdin"],
        ] {
            let output = restore_cli(&cli_backup.path, &options, b"");
            assert!(!output.status.success());
            assert!(String::from_utf8_lossy(&output.stderr)
                .contains("Unknown or repeated restore option"));
            assert_eq!(hash(&path), before_cli);
        }
        let output = restore_cli(
            &cli_backup.path,
            &["--password-stdin", "--yes"],
            b"incorrect backup password",
        );
        assert!(!output.status.success());
        assert_eq!(hash(&path), before_cli);
        let input_before = hash(&cli_backup.path);
        let output = restore_cli(
            &cli_backup.path,
            &["--password-stdin", "--yes"],
            cli_password.as_bytes(),
        );
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("Restore completed"));
        assert_eq!(theme(&current), "dark");
        assert_eq!(
            !fs::read(&path).unwrap().starts_with(b"SQLite format 3\0"),
            encrypted
        );
        assert_eq!(hash(&cli_backup.path), input_before);
    }

    let root = tempfile::tempdir().unwrap();
    let missing = root.path().join("missing.db");
    std::env::set_var("WF_DB_PATH", &missing);
    assert!(run_database_restore(&protected.path, Some(PASSWORD), true)
        .unwrap_err()
        .to_string()
        .contains("existing, nonempty"));
    assert!(!missing.exists());
    fs::write(&missing, b"unreadable original database bytes").unwrap();
    let before = hash(&missing);
    assert!(run_database_restore(&protected.path, Some(PASSWORD), true).is_err());
    assert_eq!(hash(&missing), before);
    assert!(!root.path().join("backups").exists());
}
