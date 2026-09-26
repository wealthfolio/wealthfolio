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
    std::env::set_var("WF_DATA_DIR", "");
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
        let destination_instance: String = current
            .connect_rusqlite()
            .unwrap()
            .query_row(
                "SELECT setting_value FROM app_settings WHERE setting_key='instance_id'",
                [],
                |row| row.get(0),
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
            assert_eq!(
                conn.query_row(
                    "SELECT setting_value FROM app_settings WHERE setting_key='instance_id'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
                destination_instance
            );
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

    // Restoring an encrypted backup into B must not alter A or either profile's secrets.
    let installation = tempfile::tempdir().unwrap();
    let a_path = installation.path().join("custom-legacy.db");
    let a_access = DbAccess::plaintext(a_path.to_str().unwrap());
    a_access.prepare().unwrap();
    a_access.run_migrations().unwrap();
    std::env::set_var("WF_DB_PATH", &a_path);
    std::env::set_var("WF_DB_REQUIRE_ENCRYPTION", "false");
    std::env::set_var("WF_AUTH_REQUIRED", "false");
    std::env::set_var("WF_SECRET_FILE", installation.path().join("secrets.json"));
    let mut config = wealthfolio_server::config::Config::from_env().unwrap();
    config.auth = None;
    config.oidc = None;
    config.addons_root = installation.path().to_string_lossy().into_owned();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let profiles = runtime
        .block_on(wealthfolio_server::profiles::WebProfiles::open(&config))
        .unwrap();
    let a = profiles
        .registry
        .profile(profiles.registry.default_id().unwrap())
        .unwrap();
    let b = profiles
        .registry
        .create(
            "Restore destination",
            wealthfolio_core::profiles::PROFILE_AVATARS[0],
        )
        .unwrap();
    let b = profiles.registry.profile(b.id).unwrap();
    for (profile, value) in [(&a, "account-a"), (&b, "account-b")] {
        profiles
            .registry
            .secret_store(profile)
            .set_secret(wealthfolio_core::secrets::CLOUD_REFRESH_TOKEN_KEY, value)
            .unwrap();
    }
    let b_path = profiles.registry.paths(&b).database;
    let b_access = DbAccess::plaintext(b_path.to_str().unwrap());
    b_access.prepare().unwrap();
    b_access.run_migrations().unwrap();
    let b_id = b.id.to_string();
    drop(profiles);
    drop(runtime);
    // Switch the same installation to directory-only configuration. Every offline
    // operation must still select the registered profile and the shared vault.
    std::env::set_var("WF_DATA_DIR", installation.path());
    std::env::remove_var("WF_DB_PATH");
    let a_before = hash(&a_path);
    let secrets_before = hash(&installation.path().join("secrets.json"));
    let registry_before = hash(&installation.path().join("profiles.json"));
    let encrypted = Command::new(env!("CARGO_BIN_EXE_wealthfolio-server"))
        .args(["db", "encrypt", "--profile", &b_id])
        .output()
        .unwrap();
    assert!(
        encrypted.status.success(),
        "{}",
        String::from_utf8_lossy(&encrypted.stderr)
    );
    std::env::set_var("WF_DB_REQUIRE_ENCRYPTION", "true");
    let restored = restore_cli(
        &protected.path,
        &["--profile", &b_id, "--password-stdin", "--yes"],
        PASSWORD.as_bytes(),
    );
    assert!(
        restored.status.success(),
        "{}",
        String::from_utf8_lossy(&restored.stderr)
    );
    assert!(!fs::read(&b_path).unwrap().starts_with(b"SQLite format 3\0"));
    assert_eq!(hash(&a_path), a_before);
    assert_eq!(
        hash(&installation.path().join("secrets.json")),
        secrets_before
    );
    assert_eq!(
        hash(&installation.path().join("profiles.json")),
        registry_before
    );
    // Successful profile-specific decryption verifies B still uses its original derived key.
    let decrypted = Command::new(env!("CARGO_BIN_EXE_wealthfolio-server"))
        .args(["db", "decrypt", "--profile", &b_id])
        .output()
        .unwrap();
    assert!(
        decrypted.status.success(),
        "{}",
        String::from_utf8_lossy(&decrypted.stderr)
    );
    assert_eq!(theme(&b_access), "dark");
    assert_eq!(hash(&a_path), a_before);
}
