//! Snapshot wire format. Incremental events retain their existing JSON/text codec.

use std::io::{Read, Write};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use flate2::{read::GzDecoder, write::GzEncoder, Compression};

use crate::crypto;

// The first byte cannot occur in legacy Base64 ciphertext.
const MAGIC: &[u8] = b"\x89WFSNAP\x01";
const SQLITE_HEADER: &[u8] = b"SQLite format 3\0";
// Bound expansion before allocating an image from an external snapshot.
const MAX_IMAGE_BYTES: u64 = 512 * 1024 * 1024;

fn snapshot_key(root_key: &str, key_version: i32) -> Result<String, String> {
    if key_version <= 0 {
        return Err("Invalid snapshot key version".to_string());
    }
    crypto::derive_dek(root_key, key_version as u32)
}

/// Compress SQLite before encryption, then upload binary ciphertext directly.
pub fn encode(image: &[u8], root_key: &str, key_version: i32) -> Result<Vec<u8>, String> {
    validate_image(image)?;
    let dek = snapshot_key(root_key, key_version)?;
    let mut compressor = GzEncoder::new(Vec::new(), Compression::fast());
    compressor.write_all(image).map_err(|e| e.to_string())?;
    let compressed = compressor.finish().map_err(|e| e.to_string())?;
    let encrypted = crypto::encrypt_bytes(&dek, &compressed)?;
    let mut payload = Vec::with_capacity(MAGIC.len() + encrypted.len());
    payload.extend_from_slice(MAGIC);
    payload.extend_from_slice(&encrypted);
    Ok(payload)
}

/// Read new binary snapshots and the legacy double-Base64 format.
pub fn decode(blob: &[u8], root_key: &str, key_version: i32) -> Result<Vec<u8>, String> {
    let dek = snapshot_key(root_key, key_version)?;
    let image = if let Some(ciphertext) = blob.strip_prefix(MAGIC) {
        // Authenticate before attempting decompression.
        let compressed = crypto::decrypt_bytes(&dek, ciphertext)?;
        decompress(&compressed, MAX_IMAGE_BYTES)?
    } else {
        let ciphertext =
            std::str::from_utf8(blob).map_err(|_| "Unknown snapshot format".to_string())?;
        let plaintext = crypto::decrypt(&dek, ciphertext.trim())?;
        BASE64.decode(plaintext.trim()).map_err(|e| e.to_string())?
    };
    validate_image(&image)?;
    Ok(image)
}

fn decompress(compressed: &[u8], limit: u64) -> Result<Vec<u8>, String> {
    let mut image = Vec::new();
    GzDecoder::new(compressed)
        .take(limit + 1)
        .read_to_end(&mut image)
        .map_err(|e| format!("Invalid compressed snapshot: {e}"))?;
    if image.len() as u64 > limit {
        return Err("Snapshot exceeds the uncompressed size limit".to_string());
    }
    Ok(image)
}

fn validate_image(image: &[u8]) -> Result<(), String> {
    if image.len() as u64 > MAX_IMAGE_BYTES {
        return Err("Snapshot exceeds the uncompressed size limit".to_string());
    }
    if !image.starts_with(SQLITE_HEADER) {
        return Err("Decrypted snapshot is not a valid SQLite image".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image() -> Vec<u8> {
        let mut image = SQLITE_HEADER.to_vec();
        image.extend_from_slice(&[0; 65536]);
        image.extend_from_slice(&[0xff, 0x80, 0x00]);
        image
    }

    #[test]
    fn binary_snapshot_round_trip_compresses_and_authenticates() {
        let root_key = crypto::generate_root_key();
        let image = image();
        let blob = encode(&image, &root_key, 2).unwrap();
        assert!(blob.len() < image.len() / 10);
        assert_eq!(decode(&blob, &root_key, 2).unwrap(), image);
        assert!(decode(&blob, &root_key, 1).is_err());
        let mut corrupted = blob.clone();
        *corrupted.last_mut().unwrap() ^= 1;
        assert!(decode(&corrupted, &root_key, 2).is_err());
        assert!(decode(&blob[..blob.len() - 1], &root_key, 2).is_err());
    }

    #[test]
    fn legacy_snapshot_remains_readable() {
        let root_key = crypto::generate_root_key();
        let dek = crypto::derive_dek(&root_key, 1).unwrap();
        let blob = crypto::encrypt(&dek, &BASE64.encode(image())).unwrap();
        assert_eq!(decode(blob.as_bytes(), &root_key, 1).unwrap(), image());
    }

    #[test]
    fn invalid_images_formats_and_compression_are_rejected() {
        let root_key = crypto::generate_root_key();
        assert!(encode(b"not sqlite", &root_key, 1).is_err());
        assert!(encode(&image(), &root_key, 0).is_err());
        let mut blob = encode(&image(), &root_key, 1).unwrap();
        blob[MAGIC.len() - 1] = 2;
        assert!(decode(&blob, &root_key, 1).is_err());
        let dek = crypto::derive_dek(&root_key, 1).unwrap();
        let mut blob = MAGIC.to_vec();
        blob.extend(crypto::encrypt_bytes(&dek, b"not gzip").unwrap());
        assert!(decode(&blob, &root_key, 1).is_err());
        let mut compressor = GzEncoder::new(Vec::new(), Compression::fast());
        compressor.write_all(&image()).unwrap();
        assert!(decompress(&compressor.finish().unwrap(), 1024).is_err());
    }
}
