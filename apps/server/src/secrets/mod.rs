use std::{collections::HashMap, fmt, fs, path::PathBuf, sync::Mutex};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Nonce,
};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};

use wealthfolio_core::{
    errors::Error,
    secrets::{format_service_id, SecretStore},
    Result,
};

const CURRENT_VERSION: u32 = 1;

pub struct FileSecretStore {
    path: PathBuf,
    encryption_key: Option<[u8; 32]>,
    lock: Mutex<()>,
}

impl fmt::Debug for FileSecretStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FileSecretStore")
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

#[derive(Serialize, Deserialize, Default)]
struct PlainSecrets {
    version: u32,
    secrets: HashMap<String, String>,
}

#[derive(Serialize, Deserialize)]
struct EncryptedSecrets {
    version: u32,
    nonce: String,
    ciphertext: String,
}

impl FileSecretStore {
    #[cfg(test)]
    pub fn new(path: PathBuf, encryption_key: Option<&str>) -> Result<Self> {
        let key = match encryption_key {
            Some(value) if !value.trim().is_empty() => Some(decode_encryption_key(value)?),
            _ => None,
        };

        Ok(Self {
            path,
            encryption_key: key,
            lock: Mutex::new(()),
        })
    }

    pub fn new_from_bytes(path: PathBuf, encryption_key: Option<[u8; 32]>) -> Result<Self> {
        Ok(Self {
            path,
            encryption_key,
            lock: Mutex::new(()),
        })
    }

    /// Re-encrypt and persist a set of secrets (used during key migration).
    pub fn persist_migrated(&self, secrets: &HashMap<String, String>) -> Result<()> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| Error::Secret("Secret store lock poisoned".into()))?;
        self.persist_store_locked(secrets)
    }

    fn with_store<F>(&self, mut op: F) -> Result<()>
    where
        F: FnMut(&mut HashMap<String, String>) -> Result<()>,
    {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| Error::Secret("Secret store lock poisoned".into()))?;
        let mut store = self.load_store_locked()?;
        op(&mut store)?;
        self.persist_store_locked(&store)
    }

    fn read_store(&self) -> Result<HashMap<String, String>> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| Error::Secret("Secret store lock poisoned".into()))?;
        self.load_store_locked()
    }

    fn load_store_locked(&self) -> Result<HashMap<String, String>> {
        if !self.path.exists() {
            return Ok(HashMap::new());
        }

        let raw = fs::read(&self.path)?;
        if raw.is_empty() {
            return Ok(HashMap::new());
        }

        let value: serde_json::Value = serde_json::from_slice(&raw)?;

        if value.get("ciphertext").is_some() {
            let key = self.encryption_key.ok_or_else(|| {
                Error::Secret("WF_SECRET_KEY must be set to decrypt the secrets file".into())
            })?;
            let enc: EncryptedSecrets = serde_json::from_value(value)?;
            let nonce_bytes: [u8; 12] = BASE64
                .decode(enc.nonce)
                .map_err(|e| Error::Secret(format!("Failed to decode nonce: {e}")))?
                .try_into()
                .map_err(|_| Error::Secret("Invalid nonce length in secrets file".into()))?;
            let cipher_bytes = BASE64
                .decode(enc.ciphertext)
                .map_err(|e| Error::Secret(format!("Failed to decode ciphertext: {e}")))?;

            let cipher = ChaCha20Poly1305::new((&key).into());
            let nonce = Nonce::from(nonce_bytes);
            let plaintext = cipher
                .decrypt(&nonce, cipher_bytes.as_ref())
                .map_err(|_| Error::Secret("Failed to decrypt secrets file".into()))?;
            let plain: PlainSecrets = serde_json::from_slice(&plaintext)?;
            Ok(plain.secrets)
        } else {
            let plain: PlainSecrets = serde_json::from_value(value)?;
            Ok(plain.secrets)
        }
    }

    fn persist_store_locked(&self, store: &HashMap<String, String>) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }

        let plain = PlainSecrets {
            version: CURRENT_VERSION,
            secrets: store.clone(),
        };

        if let Some(key) = self.encryption_key {
            let serialized = serde_json::to_vec(&plain)?;
            let mut nonce_bytes = [0u8; 12];
            OsRng.fill_bytes(&mut nonce_bytes);
            let cipher = ChaCha20Poly1305::new((&key).into());
            let nonce = Nonce::from(nonce_bytes);
            let ciphertext = cipher
                .encrypt(&nonce, serialized.as_ref())
                .map_err(|_| Error::Secret("Failed to encrypt secrets".into()))?;
            let enc = EncryptedSecrets {
                version: CURRENT_VERSION,
                nonce: BASE64.encode(nonce_bytes),
                ciphertext: BASE64.encode(ciphertext),
            };
            let json = serde_json::to_string_pretty(&enc)?;
            fs::write(&self.path, json)?;
        } else {
            let json = serde_json::to_string_pretty(&plain)?;
            fs::write(&self.path, json)?;
        }
        Ok(())
    }
}

impl SecretStore for FileSecretStore {
    fn set_secret(&self, service: &str, secret: &str) -> Result<()> {
        let key = format_service_id(service);
        self.with_store(|store| {
            store.insert(key.clone(), secret.to_string());
            Ok(())
        })
    }

    fn get_secret(&self, service: &str) -> Result<Option<String>> {
        let key = format_service_id(service);
        let store = self.read_store()?;
        Ok(store.get(&key).cloned())
    }

    fn delete_secret(&self, service: &str) -> Result<()> {
        let key = format_service_id(service);
        self.with_store(|store| {
            store.remove(&key);
            Ok(())
        })
    }
}

/// Build a secret store with a derived encryption key, migrating from the old raw key if needed.
pub fn build_secret_store(
    path: PathBuf,
    derived_key: Option<[u8; 32]>,
    raw_key_for_migration: Option<&[u8]>,
) -> Result<FileSecretStore> {
    if let (Some(new_key), Some(old_raw)) = (derived_key, raw_key_for_migration) {
        // Try loading with the new derived key first
        let store = FileSecretStore::new_from_bytes(path.clone(), Some(new_key))?;
        if path.exists() {
            match store.read_store() {
                Ok(_) => return Ok(store),
                Err(_) => {
                    // Derived key failed — try the old raw key to migrate
                    let mut old_key = [0u8; 32];
                    if old_raw.len() == 32 {
                        old_key.copy_from_slice(old_raw);
                    } else {
                        // Can't migrate, just return the new store (will fail on decrypt)
                        return Ok(store);
                    }
                    let old_store = FileSecretStore::new_from_bytes(path.clone(), Some(old_key))?;
                    match old_store.read_store() {
                        Ok(secrets) => {
                            // Re-encrypt with derived key
                            tracing::info!("Migrating secrets file to derived encryption key");
                            let new_store = FileSecretStore::new_from_bytes(path, Some(new_key))?;
                            new_store.persist_migrated(&secrets)?;
                            return Ok(new_store);
                        }
                        Err(_) => {
                            // Neither key works — return the new store
                            return Ok(store);
                        }
                    }
                }
            }
        }
        Ok(store)
    } else {
        FileSecretStore::new_from_bytes(path, derived_key)
    }
}

#[cfg(test)]
fn decode_encryption_key(raw: &str) -> Result<[u8; 32]> {
    let trimmed = raw.trim();
    let decoded = match BASE64.decode(trimmed) {
        Ok(bytes) => bytes,
        Err(_) if trimmed.len() == 32 => trimmed.as_bytes().to_vec(),
        Err(_) => {
            return Err(Error::Secret(
                "WF_SECRET_KEY must be a base64 string or 32-byte ascii value".into(),
            ))
        }
    };

    if decoded.len() != 32 {
        return Err(Error::Secret(
            "WF_SECRET_KEY must decode to exactly 32 bytes".into(),
        ));
    }

    let mut key = [0u8; 32];
    key.copy_from_slice(&decoded);
    Ok(key)
}

#[cfg(test)]
mod tests;
