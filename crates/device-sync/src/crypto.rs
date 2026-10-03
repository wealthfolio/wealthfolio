//! E2EE cryptographic operations for device sync.
//!
//! This module provides cryptographic primitives for:
//! - Root key generation and derivation
//! - X25519 ECDH key exchange
//! - XChaCha20-Poly1305 authenticated encryption
//! - Pairing code generation and verification

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};

/// Key sizes
const ROOT_KEY_SIZE: usize = 32;
const NONCE_SIZE: usize = 24; // XChaCha20 uses 24-byte nonce

/// HKDF info strings
const DEK_INFO: &[u8] = b"wealthfolio-dek";
const SESSION_INFO: &[u8] = b"wealthfolio-session";
const SAS_INFO: &[u8] = b"wealthfolio-sas";

/// Generate a cryptographically secure root key (32 bytes)
pub fn generate_root_key() -> String {
    let mut key = [0u8; ROOT_KEY_SIZE];
    OsRng.fill_bytes(&mut key);
    BASE64.encode(key)
}

/// Derive a Data Encryption Key from the root key using HKDF
pub fn derive_dek(root_key_b64: &str, version: u32) -> Result<String, String> {
    let root_key = BASE64
        .decode(root_key_b64)
        .map_err(|e| format!("Invalid root key: {}", e))?;

    if root_key.len() != ROOT_KEY_SIZE {
        return Err(format!(
            "Root key must be {} bytes, got {}",
            ROOT_KEY_SIZE,
            root_key.len()
        ));
    }

    // Include version in salt for key rotation
    let salt = format!("v{}", version);

    let hk = Hkdf::<Sha256>::new(Some(salt.as_bytes()), &root_key);
    let mut dek = [0u8; ROOT_KEY_SIZE];
    hk.expand(DEK_INFO, &mut dek)
        .map_err(|e| format!("HKDF expansion failed: {}", e))?;

    Ok(BASE64.encode(dek))
}

/// Ephemeral key pair for ECDH
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EphemeralKeyPair {
    pub public_key: String, // Base64-encoded public key
    pub secret_key: String, // Base64-encoded secret key (for storage)
}

/// Generate an ephemeral X25519 key pair for pairing
pub fn generate_ephemeral_keypair() -> EphemeralKeyPair {
    let secret = StaticSecret::random_from_rng(OsRng);
    let public = PublicKey::from(&secret);

    EphemeralKeyPair {
        public_key: BASE64.encode(public.as_bytes()),
        secret_key: BASE64.encode(secret.as_bytes()),
    }
}

/// Compute shared secret using X25519 ECDH
pub fn compute_shared_secret(
    our_secret_b64: &str,
    their_public_b64: &str,
) -> Result<String, String> {
    let our_secret_bytes: [u8; 32] = BASE64
        .decode(our_secret_b64)
        .map_err(|e| format!("Invalid secret key: {}", e))?
        .try_into()
        .map_err(|_| "Secret key must be 32 bytes")?;

    let their_public_bytes: [u8; 32] = BASE64
        .decode(their_public_b64)
        .map_err(|e| format!("Invalid public key: {}", e))?
        .try_into()
        .map_err(|_| "Public key must be 32 bytes")?;

    let our_secret = StaticSecret::from(our_secret_bytes);
    let their_public = PublicKey::from(their_public_bytes);

    let shared_secret = our_secret.diffie_hellman(&their_public);

    Ok(BASE64.encode(shared_secret.as_bytes()))
}

/// Derive a session key from shared secret using HKDF
pub fn derive_session_key(shared_secret_b64: &str, context: &str) -> Result<String, String> {
    let shared_secret = BASE64
        .decode(shared_secret_b64)
        .map_err(|e| format!("Invalid shared secret: {}", e))?;

    // Use context as additional info
    let info = format!("{}-{}", std::str::from_utf8(SESSION_INFO).unwrap(), context);

    let hk = Hkdf::<Sha256>::new(None, &shared_secret);
    let mut session_key = [0u8; ROOT_KEY_SIZE];
    hk.expand(info.as_bytes(), &mut session_key)
        .map_err(|e| format!("HKDF expansion failed: {}", e))?;

    Ok(BASE64.encode(session_key))
}

/// Encrypt data using XChaCha20-Poly1305
pub fn encrypt(key_b64: &str, plaintext: &str) -> Result<String, String> {
    encrypt_bytes(key_b64, plaintext.as_bytes()).map(|bytes| BASE64.encode(bytes))
}

/// Encrypt binary data, returning the nonce followed by authenticated ciphertext.
pub fn encrypt_bytes(key_b64: &str, plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let key_bytes: [u8; 32] = BASE64
        .decode(key_b64)
        .map_err(|e| format!("Invalid key: {}", e))?
        .try_into()
        .map_err(|_| "Key must be 32 bytes")?;

    let cipher = XChaCha20Poly1305::new_from_slice(&key_bytes)
        .map_err(|e| format!("Failed to create cipher: {}", e))?;

    // Generate random nonce
    let mut nonce_bytes = [0u8; NONCE_SIZE];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = XNonce::from_slice(&nonce_bytes);

    // Encrypt
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| format!("Encryption failed: {}", e))?;

    // Prepend nonce to ciphertext
    let mut result = Vec::with_capacity(NONCE_SIZE + ciphertext.len());
    result.extend_from_slice(&nonce_bytes);
    result.extend_from_slice(&ciphertext);

    Ok(result)
}

/// Decrypt data using XChaCha20-Poly1305
pub fn decrypt(key_b64: &str, ciphertext_b64: &str) -> Result<String, String> {
    let data = BASE64
        .decode(ciphertext_b64)
        .map_err(|e| format!("Invalid ciphertext: {}", e))?;
    let plaintext = decrypt_bytes(key_b64, &data)?;
    String::from_utf8(plaintext).map_err(|e| format!("Invalid UTF-8 in plaintext: {}", e))
}

/// Decrypt a binary nonce and authenticated ciphertext.
pub fn decrypt_bytes(key_b64: &str, data: &[u8]) -> Result<Vec<u8>, String> {
    let key_bytes: [u8; 32] = BASE64
        .decode(key_b64)
        .map_err(|e| format!("Invalid key: {}", e))?
        .try_into()
        .map_err(|_| "Key must be 32 bytes")?;

    if data.len() < NONCE_SIZE {
        return Err("Ciphertext too short".to_string());
    }

    // Extract nonce and ciphertext
    let (nonce_bytes, ciphertext) = data.split_at(NONCE_SIZE);
    let nonce = XNonce::from_slice(nonce_bytes);

    let cipher = XChaCha20Poly1305::new_from_slice(&key_bytes)
        .map_err(|e| format!("Failed to create cipher: {}", e))?;

    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| "Decryption failed - invalid key or corrupted data")?;

    Ok(plaintext)
}

/// Generate a 6-character alphanumeric pairing code
pub fn generate_pairing_code() -> String {
    const CHARSET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // Removed ambiguous chars
    let mut code = String::with_capacity(6);
    let mut rng = OsRng;

    for _ in 0..6 {
        let idx = (rng.next_u32() as usize) % CHARSET.len();
        code.push(CHARSET[idx] as char);
    }

    code
}

/// Hash a pairing code using SHA-256
/// Returns hex-encoded hash (64 characters) to match server expectations
/// Normalizes code to uppercase alphanumeric before hashing
pub fn hash_pairing_code(code: &str) -> String {
    // Normalize: uppercase and alphanumeric only (matches server behavior for pairing codes)
    let normalized: String = code
        .to_uppercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();

    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    let result = hasher.finalize();

    // Return hex-encoded (64 chars) instead of base64 (44 chars)
    result.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Hash arbitrary data using SHA-256 (without normalization)
/// Returns hex-encoded hash (64 characters)
/// Use this for challenge responses and other data that shouldn't be normalized
pub fn hash_sha256(data: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data.as_bytes());
    let result = hasher.finalize();
    result.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Compute HMAC-SHA256 over `data` using a base64-encoded `key`.
/// Returns hex-encoded MAC (64 characters).
pub fn hmac_sha256(key_b64: &str, data: &str) -> Result<String, String> {
    let key_bytes = BASE64
        .decode(key_b64)
        .map_err(|e| format!("Invalid HMAC key: {}", e))?;

    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&key_bytes)
        .map_err(|e| format!("HMAC key error: {}", e))?;
    mac.update(data.as_bytes());
    let result = mac.finalize().into_bytes();
    Ok(result.iter().map(|b| format!("{:02x}", b)).collect())
}

/// Compute Short Authentication String (SAS) from shared secret
/// Returns a 6-digit numeric string for human verification
pub fn compute_sas(shared_secret_b64: &str) -> Result<String, String> {
    let shared_secret = BASE64
        .decode(shared_secret_b64)
        .map_err(|e| format!("Invalid shared secret: {}", e))?;

    let hk = Hkdf::<Sha256>::new(None, &shared_secret);
    let mut sas_bytes = [0u8; 4]; // 4 bytes = 32 bits
    hk.expand(SAS_INFO, &mut sas_bytes)
        .map_err(|e| format!("HKDF expansion failed: {}", e))?;

    // Convert to number and take modulo to get 6 digits
    let num = u32::from_be_bytes(sas_bytes) % 1_000_000;
    Ok(format!("{:06}", num))
}

/// Compute SHA-256 checksum of data, returned as `sha256:<hex>`.
pub fn sha256_checksum(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    format!("sha256:{:x}", digest)
}

/// Generate a UUID v4 device ID
pub fn generate_device_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_root_key_generation() {
        let key = generate_root_key();
        let decoded = BASE64.decode(&key).unwrap();
        assert_eq!(decoded.len(), 32);
    }

    #[test]
    fn test_dek_derivation() {
        let root_key = generate_root_key();
        let dek1 = derive_dek(&root_key, 1).unwrap();
        let dek2 = derive_dek(&root_key, 2).unwrap();

        // Different versions should produce different keys
        assert_ne!(dek1, dek2);

        // Same version should produce same key
        let dek1_again = derive_dek(&root_key, 1).unwrap();
        assert_eq!(dek1, dek1_again);
    }

    #[test]
    fn test_ecdh_key_exchange() {
        let alice = generate_ephemeral_keypair();
        let bob = generate_ephemeral_keypair();

        let alice_shared = compute_shared_secret(&alice.secret_key, &bob.public_key).unwrap();
        let bob_shared = compute_shared_secret(&bob.secret_key, &alice.public_key).unwrap();

        // Both parties should derive the same shared secret
        assert_eq!(alice_shared, bob_shared);
    }

    #[test]
    fn test_encrypt_decrypt() {
        let key = generate_root_key();
        let plaintext = "Hello, World!";

        let ciphertext = encrypt(&key, plaintext).unwrap();
        let decrypted = decrypt(&key, &ciphertext).unwrap();

        assert_eq!(plaintext, decrypted);
    }

    #[test]
    fn test_pairing_code() {
        let code = generate_pairing_code();
        assert_eq!(code.len(), 6);
        assert!(code.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn test_sas_computation() {
        let alice = generate_ephemeral_keypair();
        let bob = generate_ephemeral_keypair();

        let shared = compute_shared_secret(&alice.secret_key, &bob.public_key).unwrap();
        let sas = compute_sas(&shared).unwrap();

        assert_eq!(sas.len(), 6);
        assert!(sas.chars().all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn test_hmac_sha256() {
        let key = generate_root_key();
        let mac1 = hmac_sha256(&key, "hello").unwrap();
        let mac2 = hmac_sha256(&key, "hello").unwrap();
        let mac3 = hmac_sha256(&key, "world").unwrap();

        // Deterministic
        assert_eq!(mac1, mac2);
        // Different data → different MAC
        assert_ne!(mac1, mac3);
        // 64 hex characters
        assert_eq!(mac1.len(), 64);
        assert!(mac1.chars().all(|c| c.is_ascii_hexdigit()));

        // Different key → different MAC
        let key2 = generate_root_key();
        let mac4 = hmac_sha256(&key2, "hello").unwrap();
        assert_ne!(mac1, mac4);
    }

    #[test]
    fn test_hash_pairing_code() {
        let code = "ABC123";
        let hash = hash_pairing_code(code);

        // Should be 64 hex characters (SHA-256 = 32 bytes = 64 hex chars)
        assert_eq!(hash.len(), 64);
        assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));

        // Normalization: lowercase and mixed case should produce same hash
        let hash_lower = hash_pairing_code("abc123");
        let hash_mixed = hash_pairing_code("AbC 1-2-3");
        assert_eq!(hash, hash_lower);
        assert_eq!(hash, hash_mixed);
    }
}
