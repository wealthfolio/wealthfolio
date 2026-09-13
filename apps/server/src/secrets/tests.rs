use super::*;
use tempfile::tempdir;

const KEY: [u8; 32] = [7; 32];

// Construct legacy-format input independently of the production serializer/writer.
fn encrypted_fixture(key: &[u8; 32], payload: &[u8]) -> Vec<u8> {
    let ciphertext = ChaCha20Poly1305::new(key.into())
        .encrypt(&Nonce::from([3; 12]), payload)
        .unwrap();
    serde_json::to_vec(&serde_json::json!({
        "version": 1, "nonce": BASE64.encode([3; 12]), "ciphertext": BASE64.encode(ciphertext)
    }))
    .unwrap()
}

fn legacy_payload() -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "version": 1, "secrets": { format_service_id("fixture"): "fixture-token" }
    }))
    .unwrap()
}

#[test]
fn encrypted_crud_survives_reopen_and_uses_fresh_nonces() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("secrets.json");
    let store = build_secret_store(path.clone(), Some(KEY), None).unwrap();
    assert!(!path.exists());
    assert_eq!(store.get_secret("absent").unwrap(), None);
    store.set_secret("alpha", "秘密 🔑").unwrap();
    let first: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    store.set_secret("alpha", "秘密 🔑").unwrap();
    let second: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_ne!(first["nonce"], second["nonce"]);
    assert!(!fs::read_to_string(&path).unwrap().contains("秘密"));
    drop(store);
    let store = build_secret_store(path, Some(KEY), None).unwrap();
    assert_eq!(
        store.get_secret("alpha").unwrap().as_deref(),
        Some("秘密 🔑")
    );
    store.set_secret("other", "preserved").unwrap();
    store.set_secret("alpha", "updated").unwrap();
    assert_eq!(
        store.get_secret("alpha").unwrap().as_deref(),
        Some("updated")
    );
    store.delete_secret("alpha").unwrap();
    store.delete_secret("alpha").unwrap();
    assert_eq!(store.get_secret("alpha").unwrap(), None);
    assert_eq!(
        store.get_secret("other").unwrap().as_deref(),
        Some("preserved")
    );
}

#[test]
fn current_encrypted_v1_loads_without_rewriting() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("secrets.json");
    let fixture = encrypted_fixture(&KEY, &legacy_payload());
    fs::write(&path, &fixture).unwrap();
    let store = build_secret_store(path.clone(), Some(KEY), Some(&[8; 32])).unwrap();
    assert_eq!(
        store.get_secret("fixture").unwrap().as_deref(),
        Some("fixture-token")
    );
    assert_eq!(fs::read(path).unwrap(), fixture);
}

#[test]
fn legacy_raw_key_and_plaintext_migrate_once_without_losing_entries() {
    for raw in [
        encrypted_fixture(&[8; 32], &legacy_payload()),
        legacy_payload(),
    ] {
        let dir = tempdir().unwrap();
        let path = dir.path().join("secrets.json");
        fs::write(&path, raw).unwrap();
        let store = build_secret_store(path.clone(), Some(KEY), Some(&[8; 32])).unwrap();
        assert_eq!(
            store.get_secret("fixture").unwrap().as_deref(),
            Some("fixture-token")
        );
        // Plaintext remains readable without requiring startup write access.
        // Its next successful update encrypts it, matching existing deployments.
        store.set_secret("fixture", "fixture-token").unwrap();
        let migrated = fs::read(&path).unwrap();
        assert!(FileSecretStore::new_from_bytes(path.clone(), Some(KEY))
            .unwrap()
            .get_secret("fixture")
            .is_ok());
        assert!(FileSecretStore::new_from_bytes(path.clone(), Some([8; 32]))
            .unwrap()
            .get_secret("fixture")
            .is_err());
        drop(store);
        let store = build_secret_store(path.clone(), Some(KEY), None).unwrap();
        assert_eq!(fs::read(&path).unwrap(), migrated);
        store.set_secret("new", "value").unwrap();
        store.delete_secret("new").unwrap();
        assert_eq!(
            store.get_secret("fixture").unwrap().as_deref(),
            Some("fixture-token")
        );
    }
}

#[test]
fn malformed_or_wrong_key_files_fail_without_panics_or_replacement() {
    let valid = encrypted_fixture(&KEY, &legacy_payload());
    let mut cases = vec![
        b"{".to_vec(),
        b"null".to_vec(),
        b"{}".to_vec(),
        encrypted_fixture(&[99; 32], &legacy_payload()),
        encrypted_fixture(&KEY, b"not json"),
    ];
    for size in [0, 1, 11, 13, 32] {
        let mut value: serde_json::Value = serde_json::from_slice(&valid).unwrap();
        value["nonce"] = BASE64.encode(vec![0; size]).into();
        cases.push(serde_json::to_vec(&value).unwrap());
    }
    for (field, value) in [
        ("nonce", serde_json::json!("!invalid!")),
        ("ciphertext", serde_json::json!("!invalid!")),
        ("ciphertext", serde_json::json!("")),
    ] {
        let mut envelope: serde_json::Value = serde_json::from_slice(&valid).unwrap();
        envelope[field] = value;
        cases.push(serde_json::to_vec(&envelope).unwrap());
    }
    // A malformed envelope cannot downgrade to the plaintext migration path.
    cases.push(br#"{"version":1,"secrets":{},"ciphertext":"invalid"}"#.to_vec());
    for raw in cases {
        let dir = tempdir().unwrap();
        let path = dir.path().join("secrets.json");
        fs::write(&path, &raw).unwrap();
        assert!(build_secret_store(path.clone(), Some(KEY), Some(&[8; 32])).is_ok());
        let store = FileSecretStore::new_from_bytes(path.clone(), Some(KEY)).unwrap();
        assert!(store.get_secret("fixture").is_err());
        assert!(store.set_secret("new", "value").is_err());
        assert!(store.delete_secret("fixture").is_err());
        assert_eq!(fs::read(path).unwrap(), raw);
    }
}

#[test]
fn unreadable_path_is_not_a_new_vault() {
    let dir = tempdir().unwrap();
    let store = build_secret_store(dir.path().to_path_buf(), Some(KEY), None).unwrap();
    assert!(store.get_secret("fixture").is_err());
}

#[test]
fn concurrent_calls_on_one_store_do_not_lose_updates() {
    let dir = tempdir().unwrap();
    let store = std::sync::Arc::new(
        FileSecretStore::new_from_bytes(dir.path().join("vault"), Some(KEY)).unwrap(),
    );
    let threads: Vec<_> = (0..12)
        .map(|i| {
            let store = store.clone();
            std::thread::spawn(move || store.set_secret(&format!("entry-{i}"), "fixture").unwrap())
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    for i in 0..12 {
        assert_eq!(
            store.get_secret(&format!("entry-{i}")).unwrap().as_deref(),
            Some("fixture")
        );
    }
}

#[test]
fn debug_does_not_include_key() {
    let store = FileSecretStore::new_from_bytes(PathBuf::from("vault"), Some(KEY)).unwrap();
    let output = format!("{store:?}");
    assert!(!output.contains("encryption_key"));
    assert!(!output.contains(&format!("{KEY:?}")));
}

#[cfg(unix)]
#[test]
fn failed_write_preserves_existing_vault() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempdir().unwrap();
    let path = dir.path().join("vault");
    let store = FileSecretStore::new_from_bytes(path.clone(), Some(KEY)).unwrap();
    store.set_secret("original", "fixture").unwrap();
    let original = fs::read(&path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o500)).unwrap();
    let result = store.set_secret("new", "fixture");
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
    assert!(
        result.is_err(),
        "Run permission tests as an unprivileged user"
    );
    assert_eq!(fs::read(&path).unwrap(), original);
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    assert_eq!(
        store.get_secret("original").unwrap().as_deref(),
        Some("fixture")
    );
}

#[test]
fn subprocess_fixture_worker() {
    let Ok(path) = std::env::var("WF_VAULT_TEST_CHILD_PATH") else {
        return;
    };
    let store = build_secret_store(PathBuf::from(path), Some(KEY), None).unwrap();
    match std::env::var("WF_VAULT_TEST_CHILD_ACTION")
        .unwrap()
        .as_str()
    {
        "write" => store.set_secret("restart", "fixture-token").unwrap(),
        "read" => assert_eq!(
            store.get_secret("restart").unwrap().as_deref(),
            Some("fixture-token")
        ),
        _ => panic!("Invalid fixture action"),
    }
}

#[test]
fn encrypted_credentials_survive_process_restart() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("vault");
    for action in ["write", "read"] {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "secrets::tests::subprocess_fixture_worker"])
            .env("WF_VAULT_TEST_CHILD_PATH", &path)
            .env("WF_VAULT_TEST_CHILD_ACTION", action)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "Fixture process failed: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn empty_existing_vault_and_extended_format_remain_compatible() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("vault");
    fs::write(&path, []).unwrap();
    let store = build_secret_store(path.clone(), Some(KEY), None).unwrap();
    assert_eq!(store.get_secret("fixture").unwrap(), None);
    store.set_secret("fixture", "value").unwrap();
    let mut envelope: serde_json::Value =
        serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    envelope["extension"] = true.into();
    fs::write(&path, serde_json::to_vec(&envelope).unwrap()).unwrap();
    assert_eq!(
        store.get_secret("fixture").unwrap().as_deref(),
        Some("value")
    );
}

#[test]
fn existing_file_updates_preserve_hard_links() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("vault");
    let alias = dir.path().join("alias");
    let store = build_secret_store(path.clone(), Some(KEY), None).unwrap();
    store.set_secret("fixture", "long original value").unwrap();
    fs::hard_link(&path, &alias).unwrap();
    store.set_secret("fixture", "short").unwrap();
    let linked = build_secret_store(alias, Some(KEY), None).unwrap();
    assert_eq!(
        linked.get_secret("fixture").unwrap().as_deref(),
        Some("short")
    );
    linked.delete_secret("fixture").unwrap();
    assert_eq!(store.get_secret("fixture").unwrap(), None);
}

#[cfg(unix)]
#[test]
fn symlinks_preserve_targets_for_updates_and_migration() {
    use std::os::unix::fs::symlink;
    for raw in [
        encrypted_fixture(&KEY, &legacy_payload()),
        encrypted_fixture(&[8; 32], &legacy_payload()),
        legacy_payload(),
        vec![],
    ] {
        let dir = tempdir().unwrap();
        let target = dir.path().join("target");
        let link = dir.path().join("vault");
        fs::write(&target, raw).unwrap();
        symlink("target", &link).unwrap();
        let store = build_secret_store(link.clone(), Some(KEY), Some(&[8; 32])).unwrap();
        store.set_secret("fixture", "updated").unwrap();
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        let target_store = build_secret_store(target, Some(KEY), None).unwrap();
        assert_eq!(
            target_store.get_secret("fixture").unwrap().as_deref(),
            Some("updated")
        );
        store.delete_secret("fixture").unwrap();
        assert_eq!(target_store.get_secret("fixture").unwrap(), None);
    }
    let dir = tempdir().unwrap();
    let link = dir.path().join("dangling");
    symlink("new-target", &link).unwrap();
    let store = build_secret_store(link.clone(), Some(KEY), None).unwrap();
    store.set_secret("fixture", "value").unwrap();
    assert!(fs::symlink_metadata(link).unwrap().file_type().is_symlink());
    assert!(dir.path().join("new-target").exists());
}

#[cfg(unix)]
#[test]
fn writable_vault_in_unwritable_parent_remains_supported() {
    use std::os::unix::fs::PermissionsExt;
    for raw in [
        encrypted_fixture(&KEY, &legacy_payload()),
        encrypted_fixture(&[8; 32], &legacy_payload()),
        legacy_payload(),
    ] {
        let dir = tempdir().unwrap();
        let path = dir.path().join("vault");
        fs::write(&path, raw).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o660)).unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o500)).unwrap();
        let store = build_secret_store(path.clone(), Some(KEY), Some(&[8; 32])).unwrap();
        store.set_secret("fixture", "updated").unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o660
        );
        store.delete_secret("fixture").unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
    }
}

// Native Linux CI supplies a root-owned writable file and a file bind mount.
#[cfg(unix)]
#[test]
fn deployment_file_fixture() {
    use std::os::unix::fs::MetadataExt;
    let Some(path) = std::env::var_os("WF_VAULT_DEPLOYMENT_FIXTURE") else {
        return;
    };
    let path = PathBuf::from(path);
    let before = fs::metadata(&path).unwrap();
    for raw in [
        encrypted_fixture(&KEY, &legacy_payload()),
        encrypted_fixture(&[8; 32], &legacy_payload()),
        legacy_payload(),
    ] {
        fs::write(&path, raw).unwrap();
        let store = build_secret_store(path.clone(), Some(KEY), Some(&[8; 32])).unwrap();
        store.set_secret("fixture", "updated").unwrap();
        assert_eq!(
            store.get_secret("fixture").unwrap().as_deref(),
            Some("updated")
        );
        store.delete_secret("fixture").unwrap();
        let after = fs::metadata(&path).unwrap();
        assert_eq!(
            (before.ino(), before.uid(), before.gid(), before.mode()),
            (after.ino(), after.uid(), after.gid(), after.mode())
        );
    }
}

#[test]
fn read_only_vaults_start_without_permission_changes() {
    for raw in [encrypted_fixture(&KEY, &legacy_payload()), legacy_payload()] {
        let dir = tempdir().unwrap();
        let path = dir.path().join("vault");
        fs::write(&path, &raw).unwrap();
        let original_permissions = fs::metadata(&path).unwrap().permissions();
        let mut read_only = original_permissions.clone();
        read_only.set_readonly(true);
        fs::set_permissions(&path, read_only).unwrap();
        let store = build_secret_store(path.clone(), Some(KEY), Some(&[8; 32])).unwrap();
        assert_eq!(
            store.get_secret("fixture").unwrap().as_deref(),
            Some("fixture-token")
        );
        assert_eq!(fs::read(&path).unwrap(), raw);
        assert!(fs::metadata(&path).unwrap().permissions().readonly());
        fs::set_permissions(&path, original_permissions).unwrap();
    }
}

#[test]
fn existing_optional_key_api_remains_compatible() {
    let dir = tempdir().unwrap();
    for key in [None, Some(BASE64.encode(KEY))] {
        let path = dir
            .path()
            .join(if key.is_some() { "encrypted" } else { "plain" });
        let store = FileSecretStore::new(path, key.as_deref()).unwrap();
        store.set_secret("fixture", "value").unwrap();
        assert_eq!(
            store.get_secret("fixture").unwrap().as_deref(),
            Some("value")
        );
    }
}
