//! Frozen version-one files must remain readable independently of today's exporter.
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::PathBuf, sync::Arc};
use wealthfolio_storage_sqlite::db::{self, portable, DbAccess, DbEncryptionKey};

const PASSWORD: &str = "  fixture 日本語 cafe\u{301} password  ";

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/portable-v1")
}

#[test]
fn frozen_v1_exports_restore_without_the_source_installation_key() {
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(fixtures().join("manifest.json")).unwrap()).unwrap();
    for (filename, password) in [
        ("protected.wfbackup", Some(PASSWORD)),
        ("plaintext.db", None),
    ] {
        let path = fixtures().join(filename);
        let bytes = fs::read(&path).unwrap();
        assert_eq!(
            hex::encode(Sha256::digest(&bytes)),
            manifest["sha256"][filename].as_str().unwrap(),
            "frozen fixture changed: {filename}"
        );
        if password.is_none() {
            for sentinel in [
                "SYNTHETIC_TOKEN_MUST_NOT_TRAVEL",
                "SYNTHETIC_PROVIDER_MUST_NOT_TRAVEL",
                "SYNTHETIC_REMOTE_ACCOUNT",
                "SYNTHETIC_SOURCE_INSTALLATION",
            ] {
                assert!(
                    !bytes
                        .windows(sentinel.len())
                        .any(|part| part == sentinel.as_bytes()),
                    "unsanitized plaintext fixture: {sentinel}"
                );
            }
        }
        let root = tempfile::tempdir().unwrap();
        let prepared = portable::prepare_import(&path, root.path(), password, None)
            .unwrap_or_else(|error| panic!("Cannot prepare frozen fixture {filename}: {error}"));
        assert_eq!(prepared.summary.account_count, 1);
        assert_eq!(prepared.summary.activity_count, 1);
        assert_eq!(
            prepared.summary.app_version.as_deref(),
            manifest["appVersion"].as_str()
        );
        for encrypted in [false, true] {
            let key = encrypted.then(|| Arc::new(DbEncryptionKey::generate()));
            let destination = root.path().join(format!("destination-{encrypted}.db"));
            let access = DbAccess::new(destination.to_str().unwrap(), key);
            let owner = db::DatabaseOwner::acquire(access.path()).unwrap();
            access.prepare().unwrap();
            access.run_migrations().unwrap();
            db::maintenance::run(
                root.path().to_str().unwrap(),
                &access,
                db::maintenance::MaintenanceRequest::Restore {
                    backup_path: prepared.access.path().into(),
                    device_key: prepared.access.key().cloned(),
                },
                &owner,
            )
            .unwrap();
            let conn = access.connect_rusqlite().unwrap();
            let name: String = conn
                .query_row(
                    "SELECT name FROM accounts WHERE id='fixture-account'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(name, "Synthetic 日本語 portfolio");
            let amount: String = conn
                .query_row(
                    "SELECT amount FROM activities WHERE id='fixture-deposit'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(amount, "1234.567890123456789");
            for table in [
                "personal_access_tokens",
                "market_data_custom_providers",
                "sync_device_config",
            ] {
                assert_eq!(
                    conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                        .get::<_, i64>(0))
                        .unwrap(),
                    0
                );
            }
            let provider: Option<String> = conn
                .query_row(
                    "SELECT provider_account_id FROM accounts WHERE id='fixture-account'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert!(provider.is_none());
            let reconnect: String = conn.query_row("SELECT setting_value FROM app_settings WHERE setting_key='restore_reconnect_required'", [], |r| r.get(0)).unwrap();
            assert_eq!(reconnect, "true");
            let sync: String = conn
                .query_row(
                    "SELECT setting_value FROM app_settings WHERE setting_key='sync_enabled'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(sync, "false");
            let identity: String = conn
                .query_row(
                    "SELECT setting_value FROM app_settings WHERE setting_key='instance_id'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_ne!(identity, "SYNTHETIC_SOURCE_INSTALLATION");
            assert_eq!(identity.len(), 32);
        }
    }
}

#[test]
fn frozen_v1_corruption_and_password_byte_changes_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    let path = fixtures().join("protected.wfbackup");
    for password in [
        None,
        Some(PASSWORD.trim()),
        Some("  fixture 日本語 café password  "),
    ] {
        assert!(portable::prepare_import(&path, root.path(), password, None).is_err());
    }
    let original = fs::read(path).unwrap();
    for mutation in ["version", "salt", "page", "truncated", "appended"] {
        let mut bytes = original.clone();
        match mutation {
            "version" => bytes[15] = 2,
            "salt" => bytes[16] ^= 1,
            "page" => bytes[4096 + 32] ^= 1,
            "truncated" => {
                bytes.pop();
            }
            "appended" => bytes.extend_from_slice(&[0; 4096]),
            _ => unreachable!(),
        }
        let damaged = root.path().join("damaged.wfbackup");
        fs::write(&damaged, bytes).unwrap();
        assert!(
            portable::prepare_import(&damaged, root.path(), Some(PASSWORD), None).is_err(),
            "{mutation}"
        );
    }
}

/// Intentional authoring tool: existing golden bytes must never be regenerated in tests.
#[test]
#[ignore = "Run explicitly only to author a new fixture version; refuses existing files"]
fn generate_portable_v1_fixtures() {
    for filename in ["protected.wfbackup", "plaintext.db", "manifest.json"] {
        assert!(
            !fixtures().join(filename).exists(),
            "Do not replace frozen fixtures"
        );
    }
    let root = tempfile::tempdir().unwrap();
    let source = DbAccess::new(
        root.path().join("source.db").to_str().unwrap(),
        Some(Arc::new(DbEncryptionKey::generate())),
    );
    source.prepare().unwrap();
    source.run_migrations().unwrap();
    let conn = source.connect_rusqlite().unwrap();
    conn.execute_batch(
        "INSERT INTO accounts(id,name,currency,provider,provider_account_id) VALUES('fixture-account','Synthetic 日本語 portfolio','USD','fixture-provider','SYNTHETIC_REMOTE_ACCOUNT');
         INSERT INTO activities(id,account_id,activity_type,activity_date,amount,currency,created_at,updated_at) VALUES('fixture-deposit','fixture-account','DEPOSIT','2026-01-02T12:00:00Z','1234.567890123456789','USD','2026-01-02T12:00:00Z','2026-01-02T12:00:00Z');
         INSERT INTO personal_access_tokens(id,name,token_prefix,token_hash) VALUES('fixture-token','Synthetic token','wf','SYNTHETIC_TOKEN_MUST_NOT_TRAVEL');
         INSERT INTO market_data_custom_providers(id,code,name,config,created_at,updated_at) VALUES('fixture-custom','fixture-custom','Synthetic provider','{\"secret\":\"SYNTHETIC_PROVIDER_MUST_NOT_TRAVEL\"}','2026-01-02','2026-01-02');
         UPDATE app_settings SET setting_value='SYNTHETIC_SOURCE_INSTALLATION' WHERE setting_key='instance_id';"
    ).unwrap();
    let cipher: String = conn
        .query_row("PRAGMA cipher_version", [], |r| r.get(0))
        .unwrap();
    drop(conn);
    let mut hashes = serde_json::Map::new();
    for (filename, password) in [
        ("protected.wfbackup", Some(PASSWORD)),
        ("plaintext.db", None),
    ] {
        let output = portable::export(&source, root.path(), password).unwrap();
        let bytes = fs::read(output.path).unwrap();
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(fixtures().join(filename))
            .unwrap();
        file.write_all(&bytes).unwrap();
        hashes.insert(filename.into(), hex::encode(Sha256::digest(&bytes)).into());
    }
    let manifest = serde_json::json!({
        "appVersion": env!("CARGO_PKG_VERSION"),
        "sqlcipherVersion": cipher,
        "producerOs": std::env::consts::OS,
        "producerArch": std::env::consts::ARCH,
        "sha256": hashes,
    });
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(fixtures().join("manifest.json"))
        .unwrap()
        .write_all(serde_json::to_string_pretty(&manifest).unwrap().as_bytes())
        .unwrap();
}
