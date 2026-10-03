use std::{path::Path, process::Command, sync::Arc};

use wealthfolio_server::{config::Config, profiles::WebProfiles};
use wealthfolio_storage_sqlite::db::{DbAccess, DbEncryptionKey};

const KEY: &str = "--------------------------------";

fn worker(directory: &Path, mode: &str) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", "storage_worker", "--nocapture"])
        .current_dir(directory)
        .env_clear()
        .env("WF_STORAGE_TEST_MODE", mode)
        .env("WF_LISTEN_ADDR", "127.0.0.1:0")
        .env("WF_SECRET_KEY", KEY)
        .env("CONNECT_API_URL", "http://test.local");
    command
}

fn success(command: &mut Command) {
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn existing_installations_keep_profiles_databases_and_custom_vault() {
    for encrypted in ["false", "true"] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("installation");
        std::fs::create_dir(&root).unwrap();
        let database = root.join("custom-legacy.db");
        let vault = temp.path().join("vault/credentials.bin");
        // Seed through the old configuration, then opt into the explicit root.
        success(
            worker(temp.path(), "seed-legacy")
                .env("WF_DB_PATH", &database)
                .env("WF_SECRET_FILE", &vault)
                .env("WF_DB_REQUIRE_ENCRYPTION", encrypted),
        );
        let registry = std::fs::read(root.join("profiles.json")).unwrap();
        let secrets = std::fs::read(&vault).unwrap();
        for keep_database_setting in [true, false] {
            let mut command = worker(temp.path(), "verify");
            command
                .env("WF_DATA_DIR", &root)
                .env("WF_SECRET_FILE", &vault)
                .env("WF_DB_REQUIRE_ENCRYPTION", encrypted);
            if keep_database_setting {
                command.env("WF_DB_PATH", &database);
            }
            success(&mut command);
            assert_eq!(std::fs::read(root.join("profiles.json")).unwrap(), registry);
            assert_eq!(std::fs::read(&vault).unwrap(), secrets);
            assert!(database.exists());
            assert!(!root.join("app.db").exists());
            assert!(!root.join("secrets.json").exists());
        }
    }
}

#[test]
fn fresh_directory_uses_profile_databases_and_default_vault() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("new");
    success(worker(temp.path(), "seed").env("WF_DATA_DIR", &root));
    success(worker(temp.path(), "verify").env("WF_DATA_DIR", &root));
    assert!(root.join("profiles.json").exists());
    assert!(root.join("secrets.json").exists());
    assert!(!root.join("app.db").exists());
    assert!(!temp.path().join("db").exists());
}

#[test]
fn conflicting_paths_fail_in_startup_and_offline_commands_without_writes() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("new");
    let database = temp.path().join("other/app.db");
    let mut commands = vec![worker(temp.path(), "conflict")];
    for args in [
        vec!["db", "encrypt"],
        vec!["db", "decrypt"],
        vec!["db", "restore", "missing.wfbackup", "--yes"],
    ] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_wealthfolio-server"));
        command.args(args).current_dir(temp.path()).env_clear();
        commands.push(command);
    }
    for command in &mut commands {
        let output = command
            .env("WF_DATA_DIR", &root)
            .env("WF_DB_PATH", &database)
            .env("WF_SECRET_KEY", KEY)
            .output()
            .unwrap();
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(text.contains("must select the same directory"), "{text}");
        // The test worker asserts the startup error; CLI commands must exit unsuccessfully.
        if command.get_program() == env!("CARGO_BIN_EXE_wealthfolio-server") {
            assert!(!output.status.success());
        } else {
            assert!(output.status.success());
        }
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
    }
}

#[test]
fn empty_web_override_masks_desktop_dotenv() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(temp.path().join(".env"), "WF_DATA_DIR=desktop-data\n").unwrap();
    success(
        worker(temp.path(), "seed")
            .env("WF_DATA_DIR", "")
            .env("WF_DB_PATH", "web-data/app.db"),
    );
    assert!(temp.path().join("web-data/profiles.json").exists());
    assert!(!temp.path().join("desktop-data").exists());
}

#[tokio::test]
async fn storage_worker() {
    let Ok(mode) = std::env::var("WF_STORAGE_TEST_MODE") else {
        return;
    };
    if mode == "conflict" {
        let error = Config::from_env()
            .err()
            .expect("conflicting paths must fail");
        assert!(error.to_string().contains("must select the same directory"));
        println!("{error}");
        return;
    }
    let config = Config::from_env().unwrap();
    if mode == "seed-legacy" {
        let key = config
            .db_encryption_required
            .then(|| Arc::new(DbEncryptionKey::from_bytes(&config.database_key)));
        DbAccess::new(&config.db_path, key)
            .run_migrations()
            .unwrap();
    }
    let profiles = WebProfiles::open(&config).await.unwrap();
    if mode.starts_with("seed") {
        profiles.registry.create("Second", "default").unwrap();
    }
    let all = profiles.registry.list().unwrap();
    assert_eq!(all.len(), 2);
    for profile in all {
        let state = profiles.runtime(profile.id).await.unwrap();
        if mode.starts_with("seed") {
            state.db_access.connect_rusqlite().unwrap().execute(
                "INSERT INTO app_settings(setting_key,setting_value) VALUES('storage_probe',?1)",
                [profile.id.to_string()],
            ).unwrap();
            state
                .secret_store
                .set_secret("storage_probe", &profile.id.to_string())
                .unwrap();
        }
        let value: String = state
            .db_access
            .connect_rusqlite()
            .unwrap()
            .query_row(
                "SELECT setting_value FROM app_settings WHERE setting_key='storage_probe'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(value, profile.id.to_string());
        assert_eq!(
            state.secret_store.get_secret("storage_probe").unwrap(),
            Some(profile.id.to_string())
        );
    }
}
