//! Versioned, personal database backup encryption. Independent of sync enrollment.
//! No recovery code or wrapping key is persisted by this module.
use crate::limits::{MAX_DATABASE_IMAGE_BYTES, MAX_ENCRYPTED_BACKUP_BYTES};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chacha20poly1305::{
    aead::{Aead, AeadInPlace, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use hkdf::Hkdf;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use wealthfolio_core::secrets::SecretStore;

pub mod client;
pub mod scheduler;

// Demo measurements: ~13% fewer bytes than level 1 without level 6/9's CPU cost.
// Standard gzip remains readable by every existing backup reader.
pub const BACKUP_COMPRESSION_LEVEL: u32 = 3;
const MAGIC: &[u8; 8] = b"WFBACK\x00\x01";
const PACKAGE_MAGIC: &[u8; 8] = b"WFRECV\x00\x01";
const MAX_HEADER_BYTES: usize = 16 * 1024;
pub use wealthfolio_core::secrets::{
    CLOUD_BACKUP_MASTER_KEY_PREFIX as MASTER_KEY_PREFIX,
    CLOUD_BACKUP_PENDING_MASTER_PREFIX as PENDING_MASTER_PREFIX,
    CLOUD_BACKUP_SOURCE_ID_PREFIX as SOURCE_ID_PREFIX,
};

#[derive(thiserror::Error, Debug)]
pub enum BackupError {
    #[error(
        "BACKUP_KEY_CONFLICT: Backup key does not match; use the recovery code for these backups"
    )]
    KeyConflict,
    #[error("Backup format requires a newer application")]
    UnsupportedVersion,
    #[error("Backup exceeds the supported size")]
    SizeLimit,
    #[error("Invalid backup or recovery code")]
    Invalid,
    #[error("Backup authentication failed; check your recovery code")]
    Authentication,
    #[error("Backup I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("Backup key storage failed")]
    SecretStore,
}
type Result<T> = std::result::Result<T, BackupError>;

// Deliberately no Debug or Serialize: accidental logging must not expose key material.
pub struct MasterKey([u8; 32]);
impl Drop for MasterKey {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.0.zeroize();
    }
}
impl MasterKey {
    pub fn generate() -> Self {
        let mut bytes = [0; 32];
        OsRng.fill_bytes(&mut bytes);
        Self(bytes)
    }
    pub fn load(store: &dyn SecretStore, user_id: &str) -> Result<Option<Self>> {
        store
            .get_secret(&format!("{MASTER_KEY_PREFIX}{user_id}"))
            .map_err(|_| BackupError::SecretStore)?
            .map(|s| decode_key(s.split_once(':').map_or(s.as_str(), |(_, key)| key)).map(Self))
            .transpose()
    }
    /// Old unbound keys remain readable. New writes bind the key ID in the same
    /// protected secret value, so a changed cloud record cannot relabel local bytes.
    pub fn load_for_key(store: &dyn SecretStore, user: &str, key_id: &str) -> Result<Option<Self>> {
        let Some(value) = store
            .get_secret(&format!("{MASTER_KEY_PREFIX}{user}"))
            .map_err(|_| BackupError::SecretStore)?
        else {
            return Ok(None);
        };
        let value = zeroize::Zeroizing::new(value);
        let key = if let Some((id, key)) = value.split_once(':') {
            if id != key_id {
                return Err(BackupError::KeyConflict);
            }
            key
        } else {
            value.as_str()
        };
        Ok(Some(Self(decode_key(key)?)))
    }
    pub fn save_for_key(&self, store: &dyn SecretStore, user: &str, key_id: &str) -> Result<()> {
        uuid::Uuid::parse_str(key_id).map_err(|_| BackupError::Invalid)?;
        let value = zeroize::Zeroizing::new(format!("{key_id}:{}", BASE64.encode(self.0)));
        store
            .set_secret(&format!("{MASTER_KEY_PREFIX}{user}"), &value)
            .map_err(|_| BackupError::SecretStore)
    }
    /// Call only after create-if-absent succeeds or the server's existing envelope is unwrapped.
    pub fn save(&self, store: &dyn SecretStore, user_id: &str) -> Result<()> {
        store
            .set_secret(
                &format!("{MASTER_KEY_PREFIX}{user_id}"),
                &BASE64.encode(self.0),
            )
            .map_err(|_| BackupError::SecretStore)
    }
}

/// A candidate remains separate from the active master until the cloud confirms its key ID.
/// It survives a lost setup response, but never includes a recovery code or wrapping key.
fn stage_master(
    store: &dyn SecretStore,
    user: &str,
    key_id: &str,
    master: &MasterKey,
) -> Result<()> {
    let value = zeroize::Zeroizing::new(format!("{key_id}:{}", BASE64.encode(master.0)));
    store
        .set_secret(&format!("{PENDING_MASTER_PREFIX}{user}"), &value)
        .map_err(|_| BackupError::SecretStore)?;
    let Some((saved_id, saved)) = pending_master(store, user)? else {
        return Err(BackupError::SecretStore);
    };
    if saved_id != key_id || saved.0 != master.0 {
        return Err(BackupError::SecretStore);
    }
    Ok(())
}
fn pending_master(store: &dyn SecretStore, user: &str) -> Result<Option<(String, MasterKey)>> {
    let Some(value) = store
        .get_secret(&format!("{PENDING_MASTER_PREFIX}{user}"))
        .map_err(|_| BackupError::SecretStore)?
    else {
        return Ok(None);
    };
    let value = zeroize::Zeroizing::new(value);
    let (id, key) = value.split_once(':').ok_or(BackupError::Invalid)?;
    uuid::Uuid::parse_str(id).map_err(|_| BackupError::Invalid)?;
    Ok(Some((id.to_owned(), MasterKey(decode_key(key)?))))
}
fn resolve_pending_master(store: &dyn SecretStore, user: &str, cloud_key_id: &str) -> Result<bool> {
    let Some((id, master)) = pending_master(store, user)? else {
        return Ok(false);
    };
    let matches = id == cloud_key_id;
    if matches {
        master.save_for_key(store, user, cloud_key_id)?;
    }
    store
        .delete_secret(&format!("{PENDING_MASTER_PREFIX}{user}"))
        .map_err(|_| BackupError::SecretStore)?;
    Ok(matches)
}

/// Stable across database imports, but isolated by the caller's profile-scoped store.
pub fn source_id(store: &dyn SecretStore, user_id: &str) -> Result<String> {
    let key = format!("{SOURCE_ID_PREFIX}{user_id}");
    if let Some(id) = store
        .get_secret(&key)
        .map_err(|_| BackupError::SecretStore)?
    {
        uuid::Uuid::parse_str(&id).map_err(|_| BackupError::Invalid)?;
        return Ok(id);
    }
    let id = uuid::Uuid::new_v4().to_string();
    store
        .set_secret(&key, &id)
        .map_err(|_| BackupError::SecretStore)?;
    Ok(id)
}

fn decode_key(value: &str) -> Result<[u8; 32]> {
    BASE64
        .decode(value)
        .map_err(|_| BackupError::Invalid)?
        .try_into()
        .map_err(|_| BackupError::Invalid)
}
fn context(parts: &[&str]) -> Vec<u8> {
    serde_json::to_vec(parts).expect("string context")
}
fn derive(key: &[u8], context: &[u8]) -> [u8; 32] {
    let mut output = [0; 32];
    Hkdf::<Sha256>::new(Some(b"wealthfolio-cloud-backups-v1"), key)
        .expand(context, &mut output)
        .expect("valid HKDF length");
    output
}
fn seal(key: &[u8; 32], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
    let mut nonce = [0; 24];
    OsRng.fill_bytes(&mut nonce);
    let cipher = XChaCha20Poly1305::new(key.into());
    let mut out = nonce.to_vec();
    out.extend(
        cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: plaintext,
                    aad,
                },
            )
            .map_err(|_| BackupError::Authentication)?,
    );
    Ok(out)
}
fn open(key: &[u8; 32], ciphertext: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
    if ciphertext.len() < 40 {
        return Err(BackupError::Invalid);
    }
    XChaCha20Poly1305::new(key.into())
        .decrypt(
            XNonce::from_slice(&ciphertext[..24]),
            Payload {
                msg: &ciphertext[24..],
                aad,
            },
        )
        .map_err(|_| BackupError::Authentication)
}

/// 256 random bits, grouped for transcription, with a version and checksum.
pub fn generate_recovery_code() -> String {
    let mut bytes = [0; 32];
    OsRng.fill_bytes(&mut bytes);
    let encoded = hex(&bytes);
    let checksum = hex(&Sha256::digest(bytes));
    let groups: Vec<_> = encoded
        .as_bytes()
        .chunks(8)
        .map(|s| std::str::from_utf8(s).expect("hex"))
        .collect();
    format!("WFREC1-{}-{}", groups.join("-"), &checksum[..12])
}
fn recovery_key(code: &str) -> Result<[u8; 32]> {
    let mut parts = code.trim().split('-');
    if parts.next() != Some("WFREC1") {
        return Err(BackupError::Invalid);
    }
    let parts: Vec<_> = parts.collect();
    if !code.is_ascii()
        || parts.len() != 9
        || parts[..8].iter().any(|s| s.len() != 8)
        || parts[8].len() != 12
    {
        return Err(BackupError::Invalid);
    }
    let joined = parts[..8].join("").to_ascii_lowercase();
    let mut bytes = [0; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&joined[index * 2..index * 2 + 2], 16)
            .map_err(|_| BackupError::Invalid)?;
    }
    if !hex(&Sha256::digest(bytes)).starts_with(&parts[8].to_ascii_lowercase()) {
        return Err(BackupError::Invalid);
    }
    Ok(bytes)
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RecoveryEnvelope {
    pub format: u32,
    pub recovery_id: String,
    pub ciphertext: String,
}
pub fn wrap_recovery(
    master: &MasterKey,
    code: &str,
    user: &str,
    key_id: &str,
) -> Result<RecoveryEnvelope> {
    let recovery_id = uuid::Uuid::new_v4().to_string();
    let aad = context(&["recovery", "1", user, key_id, &recovery_id]);
    let key = derive(&recovery_key(code)?, &aad);
    Ok(RecoveryEnvelope {
        format: 1,
        recovery_id,
        ciphertext: BASE64.encode(seal(&key, &master.0, &aad)?),
    })
}
pub fn unwrap_recovery(
    envelope: &RecoveryEnvelope,
    code: &str,
    user: &str,
    key_id: &str,
) -> Result<MasterKey> {
    if envelope.format != 1 {
        return Err(BackupError::UnsupportedVersion);
    }
    if envelope.ciphertext.len() > 128 {
        return Err(BackupError::Invalid);
    }
    let aad = context(&["recovery", "1", user, key_id, &envelope.recovery_id]);
    let plaintext = open(
        &derive(&recovery_key(code)?, &aad),
        &BASE64
            .decode(&envelope.ciphertext)
            .map_err(|_| BackupError::Invalid)?,
        &aad,
    )?;
    Ok(MasterKey(
        plaintext.try_into().map_err(|_| BackupError::Invalid)?,
    ))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrustedEnvelope {
    pub format: u32,
    pub team_id: String,
    pub sync_key_version: u32,
    pub ciphertext: String,
}
pub fn wrap_trusted(
    master: &MasterKey,
    root: &str,
    user: &str,
    key_id: &str,
    team: &str,
    version: u32,
) -> Result<TrustedEnvelope> {
    let aad = context(&["trusted", "1", user, team, &version.to_string(), key_id]);
    Ok(TrustedEnvelope {
        format: 1,
        team_id: team.into(),
        sync_key_version: version,
        ciphertext: BASE64.encode(seal(&derive(&decode_key(root)?, &aad), &master.0, &aad)?),
    })
}
pub fn unwrap_trusted(
    envelope: &TrustedEnvelope,
    root: &str,
    user: &str,
    key_id: &str,
    team: &str,
    version: u32,
) -> Result<MasterKey> {
    if envelope.format != 1 {
        return Err(BackupError::UnsupportedVersion);
    }
    if envelope.team_id != team
        || envelope.sync_key_version != version
        || envelope.ciphertext.len() > 128
    {
        return Err(BackupError::Invalid);
    }
    let aad = context(&["trusted", "1", user, team, &version.to_string(), key_id]);
    Ok(MasterKey(
        open(
            &derive(&decode_key(root)?, &aad),
            &BASE64
                .decode(&envelope.ciphertext)
                .map_err(|_| BackupError::Invalid)?,
            &aad,
        )?
        .try_into()
        .map_err(|_| BackupError::Invalid)?,
    ))
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BackupContext {
    pub format: u32,
    pub user_id: String,
    pub key_id: String,
    pub backup_id: String,
}
fn backup_aad(context: &BackupContext) -> Result<Vec<u8>> {
    if context.format != 1 {
        return Err(BackupError::UnsupportedVersion);
    }
    if [&context.user_id, &context.key_id, &context.backup_id]
        .iter()
        .any(|s| uuid::Uuid::parse_str(s).is_err())
    {
        return Err(BackupError::Invalid);
    }
    Ok(serde_json::to_vec(&("database", context)).expect("backup context"))
}
// Abort before compressed ciphertext can exceed the object cap. Reserve room for nonce/tag/magic.
struct BoundedCompression(zeroize::Zeroizing<Vec<u8>>);
impl Write for BoundedCompression {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > MAX_ENCRYPTED_BACKUP_BYTES - MAGIC.len() - 40
        {
            return Err(std::io::Error::other("Backup exceeds the supported size"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
/// Input is the plaintext portable database image, never the installation's encrypted SQLite file.
pub fn encrypt_database(
    master: &MasterKey,
    ctx: &BackupContext,
    database: &[u8],
) -> Result<Vec<u8>> {
    if database.len() > MAX_DATABASE_IMAGE_BYTES {
        return Err(BackupError::SizeLimit);
    }
    encrypt_database_reader(master, ctx, std::io::Cursor::new(database))
}
/// Compress an immutable private export in chunks; keep only compressed bytes in memory.
/// The wire format is unchanged: magic, nonce, authenticated gzip ciphertext, tag.
pub fn encrypt_database_reader(
    master: &MasterKey,
    ctx: &BackupContext,
    mut database: impl Read,
) -> Result<Vec<u8>> {
    let aad = backup_aad(ctx)?;
    let mut header = [0; 16];
    database.read_exact(&mut header)?;
    if &header != b"SQLite format 3\0" {
        return Err(BackupError::Invalid);
    }
    let mut gzip = GzEncoder::new(
        BoundedCompression(zeroize::Zeroizing::new(Vec::new())),
        Compression::new(BACKUP_COMPRESSION_LEVEL),
    );
    gzip.write_all(&header)?;
    let mut count = header.len();
    let mut chunk = zeroize::Zeroizing::new([0; 64 * 1024]);
    loop {
        let size = database.read(chunk.as_mut())?;
        if size == 0 {
            break;
        }
        count = count.checked_add(size).ok_or(BackupError::SizeLimit)?;
        if count > MAX_DATABASE_IMAGE_BYTES {
            return Err(BackupError::SizeLimit);
        }
        gzip.write_all(&chunk[..size])?;
    }
    drop(database);
    let mut output = gzip.finish()?.0;
    let mut nonce = [0; 24];
    OsRng.fill_bytes(&mut nonce);
    let prefix = MAGIC.len() + nonce.len();
    let compressed_len = output.len();
    // Reserve once and shift in the same allocation instead of copying full-size buffers.
    output.reserve_exact(prefix + 16);
    output.resize(compressed_len + prefix, 0);
    output.copy_within(0..compressed_len, prefix);
    output[..MAGIC.len()].copy_from_slice(MAGIC);
    output[MAGIC.len()..prefix].copy_from_slice(&nonce);
    let tag = XChaCha20Poly1305::new((&derive(&master.0, &aad)).into())
        .encrypt_in_place_detached(XNonce::from_slice(&nonce), &aad, &mut output[prefix..])
        .map_err(|_| BackupError::Authentication)?;
    output.extend_from_slice(&tag);
    if output.len() > MAX_ENCRYPTED_BACKUP_BYTES {
        return Err(BackupError::SizeLimit);
    }
    Ok(std::mem::take(&mut *output))
}
pub fn decrypt_database(
    master: &MasterKey,
    ctx: &BackupContext,
    encrypted: &[u8],
) -> Result<Vec<u8>> {
    let mut output = Vec::new();
    decrypt_database_to_writer(master, ctx, encrypted, &mut output)?;
    Ok(output)
}
/// Authentication finishes before plaintext is emitted. Decompression writes bounded chunks,
/// so runtime restoration never allocates a decoded 512 MiB image in memory.
pub fn decrypt_database_to_writer(
    master: &MasterKey,
    ctx: &BackupContext,
    encrypted: &[u8],
    mut output: impl Write,
) -> Result<()> {
    if encrypted.len() > MAX_ENCRYPTED_BACKUP_BYTES {
        return Err(BackupError::SizeLimit);
    }
    if !encrypted.starts_with(MAGIC) {
        return Err(BackupError::UnsupportedVersion);
    }
    let aad = backup_aad(ctx)?;
    let compressed = zeroize::Zeroizing::new(open(
        &derive(&master.0, &aad),
        &encrypted[MAGIC.len()..],
        &aad,
    )?);
    let mut decoder = GzDecoder::new(compressed.as_slice());
    let mut header = [0; 16];
    decoder.read_exact(&mut header)?;
    if &header != b"SQLite format 3\0" {
        return Err(BackupError::Invalid);
    }
    output.write_all(&header)?;
    let mut count = header.len();
    let mut chunk = zeroize::Zeroizing::new([0; 64 * 1024]);
    loop {
        let size = decoder.read(chunk.as_mut())?;
        if size == 0 {
            break;
        }
        count = count.checked_add(size).ok_or(BackupError::SizeLimit)?;
        if count > MAX_DATABASE_IMAGE_BYTES {
            return Err(BackupError::SizeLimit);
        }
        output.write_all(&chunk[..size])?;
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecoveryPackageHeader {
    pub format: u32,
    pub context: BackupContext,
    pub recovery: RecoveryEnvelope,
    pub checksum: String,
    pub size_bytes: usize,
}
/// One bounded binary file: magic, little-endian header length, JSON, ciphertext. No archive extraction.
pub fn write_recovery_package(
    mut output: impl Write,
    header: &RecoveryPackageHeader,
    encrypted: &[u8],
) -> Result<()> {
    validate_package(header, encrypted)?;
    let json = serde_json::to_vec(header).map_err(|_| BackupError::Invalid)?;
    if json.len() > MAX_HEADER_BYTES {
        return Err(BackupError::SizeLimit);
    }
    output.write_all(PACKAGE_MAGIC)?;
    output.write_all(&(json.len() as u32).to_le_bytes())?;
    output.write_all(&json)?;
    output.write_all(encrypted)?;
    Ok(())
}
pub fn read_recovery_package(mut input: impl Read) -> Result<(RecoveryPackageHeader, Vec<u8>)> {
    let mut magic = [0; 8];
    input.read_exact(&mut magic)?;
    if &magic != PACKAGE_MAGIC {
        return Err(BackupError::UnsupportedVersion);
    }
    let mut length = [0; 4];
    input.read_exact(&mut length)?;
    let length = u32::from_le_bytes(length) as usize;
    if length > MAX_HEADER_BYTES {
        return Err(BackupError::SizeLimit);
    }
    let mut json = vec![0; length];
    input.read_exact(&mut json)?;
    let header: RecoveryPackageHeader =
        serde_json::from_slice(&json).map_err(|_| BackupError::Invalid)?;
    let mut encrypted = Vec::new();
    input
        .take((MAX_ENCRYPTED_BACKUP_BYTES + 1) as u64)
        .read_to_end(&mut encrypted)?;
    validate_package(&header, &encrypted)?;
    Ok((header, encrypted))
}
fn validate_package(header: &RecoveryPackageHeader, encrypted: &[u8]) -> Result<()> {
    if header.format != 1 || header.recovery.format != 1 {
        return Err(BackupError::UnsupportedVersion);
    }
    backup_aad(&header.context)?;
    if encrypted.len() > MAX_ENCRYPTED_BACKUP_BYTES {
        return Err(BackupError::SizeLimit);
    }
    if header.size_bytes != encrypted.len()
        || header.checksum != crate::crypto::sha256_checksum(encrypted)
    {
        return Err(BackupError::Invalid);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ctx() -> BackupContext {
        BackupContext {
            format: 1,
            user_id: uuid::Uuid::new_v4().to_string(),
            key_id: uuid::Uuid::new_v4().to_string(),
            backup_id: uuid::Uuid::new_v4().to_string(),
        }
    }
    fn database() -> Vec<u8> {
        let mut db = b"SQLite format 3\0".to_vec();
        db.extend(vec![0; 4096]);
        db
    }
    #[test]
    fn fresh_device_recovery_package_and_reissue() {
        let master = MasterKey::generate();
        let ctx = ctx();
        let code = generate_recovery_code();
        let envelope = wrap_recovery(&master, &code, &ctx.user_id, &ctx.key_id).unwrap();
        let encrypted = encrypt_database(&master, &ctx, &database()).unwrap();
        let header = RecoveryPackageHeader {
            format: 1,
            context: ctx.clone(),
            recovery: envelope,
            checksum: crate::crypto::sha256_checksum(&encrypted),
            size_bytes: encrypted.len(),
        };
        let mut package = Vec::new();
        write_recovery_package(&mut package, &header, &encrypted).unwrap();
        let (header, encrypted) = read_recovery_package(package.as_slice()).unwrap();
        let recovered =
            unwrap_recovery(&header.recovery, &code, &ctx.user_id, &ctx.key_id).unwrap();
        assert_eq!(
            decrypt_database(&recovered, &ctx, &encrypted).unwrap(),
            database()
        );
        let new_code = generate_recovery_code();
        let replacement = wrap_recovery(&recovered, &new_code, &ctx.user_id, &ctx.key_id).unwrap();
        assert!(unwrap_recovery(&replacement, &code, &ctx.user_id, &ctx.key_id).is_err());
        let recovered =
            unwrap_recovery(&replacement, &new_code, &ctx.user_id, &ctx.key_id).unwrap();
        assert_eq!(
            decrypt_database(&recovered, &ctx, &encrypted).unwrap(),
            database()
        );
    }
    #[test]
    fn authentication_binds_person_object_key_and_sync_epoch() {
        let master = MasterKey::generate();
        let ctx = ctx();
        let encrypted = encrypt_database(&master, &ctx, &database()).unwrap();
        let mut wrong = ctx.clone();
        wrong.backup_id = uuid::Uuid::new_v4().to_string();
        assert!(decrypt_database(&master, &wrong, &encrypted).is_err());
        wrong = ctx.clone();
        wrong.user_id = uuid::Uuid::new_v4().to_string();
        assert!(decrypt_database(&master, &wrong, &encrypted).is_err());
        wrong = ctx.clone();
        wrong.key_id = uuid::Uuid::new_v4().to_string();
        assert!(decrypt_database(&master, &wrong, &encrypted).is_err());
        let root = crate::crypto::generate_root_key();
        let envelope = wrap_trusted(&master, &root, &ctx.user_id, &ctx.key_id, "team", 2).unwrap();
        assert!(unwrap_trusted(&envelope, &root, &ctx.user_id, &ctx.key_id, "other", 2).is_err());
        assert!(unwrap_trusted(&envelope, &root, &ctx.user_id, &ctx.key_id, "team", 3).is_err());
        let recovered =
            unwrap_trusted(&envelope, &root, &ctx.user_id, &ctx.key_id, "team", 2).unwrap();
        assert_eq!(
            decrypt_database(&recovered, &ctx, &encrypted).unwrap(),
            database()
        );
        let mut corrupt = encrypted;
        *corrupt.last_mut().unwrap() ^= 1;
        assert!(decrypt_database(&master, &ctx, &corrupt).is_err());
    }
    #[test]
    fn unsupported_versions_and_bounded_package_input() {
        let mut ctx = ctx();
        ctx.format = 2;
        assert!(matches!(
            encrypt_database(&MasterKey::generate(), &ctx, &database()),
            Err(BackupError::UnsupportedVersion)
        ));
        let mut file = PACKAGE_MAGIC.to_vec();
        file.extend(u32::MAX.to_le_bytes());
        assert!(matches!(
            read_recovery_package(file.as_slice()),
            Err(BackupError::SizeLimit)
        ));
        let code = generate_recovery_code();
        assert!(recovery_key(&code).is_ok());
        assert!(recovery_key(&code.replace("WFREC1", "WFREC2")).is_err());
    }
    #[test]
    fn no_plaintext_is_emitted_before_authentication() {
        let master = MasterKey::generate();
        let ctx = ctx();
        let mut encrypted = encrypt_database(&master, &ctx, &database()).unwrap();
        *encrypted.last_mut().unwrap() ^= 1;
        let mut output = Vec::new();
        assert!(decrypt_database_to_writer(&master, &ctx, &encrypted, &mut output).is_err());
        assert!(output.is_empty());
    }
    #[test]
    fn compression_writer_stops_before_object_limit() {
        let mut writer = BoundedCompression(zeroize::Zeroizing::new(vec![
            0;
            MAX_ENCRYPTED_BACKUP_BYTES - MAGIC.len()
                - 40
        ]));
        assert!(writer.write(&[1]).is_err());
        assert_eq!(
            writer.0.len(),
            MAX_ENCRYPTED_BACKUP_BYTES - MAGIC.len() - 40
        );
    }
    #[test]
    #[ignore = "local compression benchmark; needs CONNECT_BACKUP_BENCHMARK_EXPORT"]
    fn demo_compression_benchmark() {
        let input = std::env::var("CONNECT_BACKUP_BENCHMARK_EXPORT").unwrap();
        let database = zeroize::Zeroizing::new(std::fs::read(input).unwrap());
        assert!(database.starts_with(b"SQLite format 3\0"));
        let master = MasterKey::generate();
        let ctx = ctx();
        let aad = backup_aad(&ctx).unwrap();
        for level in [1, BACKUP_COMPRESSION_LEVEL, 6, 9] {
            for run in 0..3 {
                let start = std::time::Instant::now();
                let mut gzip = GzEncoder::new(
                    BoundedCompression(zeroize::Zeroizing::new(Vec::new())),
                    Compression::new(level),
                );
                gzip.write_all(&database).unwrap();
                let compressed = gzip.finish().unwrap().0;
                let compress = start.elapsed();
                let start = std::time::Instant::now();
                let mut encrypted = MAGIC.to_vec();
                encrypted.extend(seal(&derive(&master.0, &aad), &compressed, &aad).unwrap());
                let encrypt = start.elapsed();
                let start = std::time::Instant::now();
                let _digest = crate::crypto::sha256_checksum(&encrypted);
                let hash = start.elapsed();
                let start = std::time::Instant::now();
                decrypt_database_to_writer(&master, &ctx, &encrypted, std::io::sink()).unwrap();
                eprintln!("compression_benchmark level={level} run={run} decoded_bytes={} encrypted_bytes={} compress_ms={} encrypt_ms={} sha256_ms={} restore_ms={}",database.len(),encrypted.len(),compress.as_millis(),encrypt.as_millis(),hash.as_millis(),start.elapsed().as_millis());
            }
        }
    }

    #[test]
    #[ignore = "synthetic resource measurement; run explicitly with --ignored --nocapture"]
    fn synthetic_capture_resource_probe() {
        let master = MasterKey::generate();
        let ctx = ctx();
        for mib in [5, 20, 50, 100, 512] {
            let mut image = vec![0; mib * 1024 * 1024];
            image[..16].copy_from_slice(b"SQLite format 3\0");
            // Synthetic compressible database-sized image; real database ratios vary.
            let start = std::time::Instant::now();
            let encrypted = encrypt_database(&master, &ctx, &image).unwrap();
            let elapsed = start.elapsed();
            let start = std::time::Instant::now();
            decrypt_database_to_writer(&master, &ctx, &encrypted, std::io::sink()).unwrap();
            eprintln!(
                "synthetic decoded_mib={mib} encrypted_bytes={} capture_ms={} restore_ms={}",
                encrypted.len(),
                elapsed.as_millis(),
                start.elapsed().as_millis()
            );
        }
    }
    #[test]
    #[ignore = "large incompressible resource measurement; run explicitly with --ignored --nocapture"]
    fn large_streamed_capture_resource_probe() {
        use rand::{rngs::StdRng, SeedableRng};
        struct RandomReader {
            remaining: usize,
            rng: StdRng,
        }
        impl Read for RandomReader {
            fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
                let size = output.len().min(self.remaining);
                self.rng.fill_bytes(&mut output[..size]);
                self.remaining -= size;
                Ok(size)
            }
        }
        struct HashedReader<R> {
            input: R,
            hash: Sha256,
        }
        impl<R: Read> Read for HashedReader<R> {
            fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
                let size = self.input.read(output)?;
                self.hash.update(&output[..size]);
                Ok(size)
            }
        }
        struct HashWriter {
            hash: Sha256,
            bytes: usize,
        }
        impl Write for HashWriter {
            fn write(&mut self, input: &[u8]) -> std::io::Result<usize> {
                self.hash.update(input);
                self.bytes += input.len();
                Ok(input.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let bytes = 255 * 1024 * 1024;
        let mut input = HashedReader {
            input: std::io::Cursor::new(b"SQLite format 3\0").chain(RandomReader {
                remaining: bytes - 16,
                rng: StdRng::seed_from_u64(42),
            }),
            hash: Sha256::new(),
        };
        let master = MasterKey::generate();
        let context = ctx();
        let start = std::time::Instant::now();
        let encrypted = encrypt_database_reader(&master, &context, &mut input).unwrap();
        let encode_ms = start.elapsed().as_millis();
        assert!(encrypted.len() > crate::limits::MAX_ENCRYPTED_SNAPSHOT_BYTES);
        assert!(encrypted.len() <= MAX_ENCRYPTED_BACKUP_BYTES);
        if std::env::var_os("CONNECT_BACKUP_RESOURCE_CAPTURE_ONLY").is_some() {
            eprintln!("large_streamed_backup_capture decoded_bytes={bytes} encrypted_bytes={} encode_ms={encode_ms}", encrypted.len());
            return;
        }
        let mut output = HashWriter {
            hash: Sha256::new(),
            bytes: 0,
        };
        let start = std::time::Instant::now();
        decrypt_database_to_writer(&master, &context, &encrypted, &mut output).unwrap();
        assert_eq!(output.bytes, bytes);
        assert_eq!(output.hash.finalize(), input.hash.finalize());
        eprintln!("large_streamed_backup decoded_bytes={bytes} encrypted_bytes={} encode_ms={encode_ms} restore_ms={}", encrypted.len(), start.elapsed().as_millis());
    }
    #[test]
    fn oversized_decoded_database_is_rejected_before_exceeding_limit() {
        let master = MasterKey::generate();
        let ctx = ctx();
        let aad = backup_aad(&ctx).unwrap();
        let mut gzip = GzEncoder::new(Vec::new(), Compression::fast());
        gzip.write_all(b"SQLite format 3\0").unwrap();
        let zeros = [0; 64 * 1024];
        for _ in 0..MAX_DATABASE_IMAGE_BYTES / zeros.len() {
            gzip.write_all(&zeros).unwrap();
        }
        let compressed = gzip.finish().unwrap();
        let mut encrypted = MAGIC.to_vec();
        encrypted.extend(seal(&derive(&master.0, &aad), &compressed, &aad).unwrap());
        struct Counter(usize);
        impl Write for Counter {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0 += bytes.len();
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut output = Counter(0);
        assert!(matches!(
            decrypt_database_to_writer(&master, &ctx, &encrypted, &mut output),
            Err(BackupError::SizeLimit)
        ));
        assert!(output.0 <= MAX_DATABASE_IMAGE_BYTES);
    }
    #[derive(Default)]
    struct Store(std::sync::Mutex<std::collections::HashMap<String, String>>);
    impl SecretStore for Store {
        fn get_secret(&self, key: &str) -> wealthfolio_core::Result<Option<String>> {
            Ok(self.0.lock().unwrap().get(key).cloned())
        }
        fn set_secret(&self, key: &str, value: &str) -> wealthfolio_core::Result<()> {
            self.0.lock().unwrap().insert(key.into(), value.into());
            Ok(())
        }
        fn delete_secret(&self, key: &str) -> wealthfolio_core::Result<()> {
            self.0.lock().unwrap().remove(key);
            Ok(())
        }
    }
    #[tokio::test]
    async fn automatic_source_policy_makes_no_request_before_local_opt_in() {
        let client = client::BackupClient::new("http://127.0.0.1:1").unwrap();
        let store = Store::default();
        assert!(matches!(
            client
                .source_policy("synthetic-token", &store)
                .await
                .unwrap(),
            client::BackupSource::Inactive
        ));
    }
    #[test]
    fn backup_timer_uses_cloud_due_time_and_one_day_after_publication() {
        let now = chrono::Utc::now();
        let mut policy: client::BackupPolicy = serde_json::from_value(serde_json::json!({
            "userId": "test", "enabled": true, "sourceId": "test", "revision": 1,
            "teamId": null, "nextDueAt": (now + chrono::Duration::hours(1)).to_rfc3339(),
            "lastBackupAt": null, "uploadEntitled": true
        }))
        .unwrap();
        let delay = policy.delay_until_due().unwrap();
        assert!(delay.as_secs() >= 3599 && delay.as_secs() <= 3600);
        policy.next_due_at = Some((now - chrono::Duration::hours(1)).to_rfc3339());
        assert_eq!(policy.delay_until_due().unwrap(), std::time::Duration::ZERO);
        policy.next_due_at = Some("invalid".into());
        assert!(policy.delay_until_due().is_err());
        let mut point: client::BackupPoint = serde_json::from_value(serde_json::json!({
            "backupId": "test", "keyId": "test", "userId": "test", "sourceId": "test",
            "sizeBytes": 1, "checksum": "test", "format": 1,
            "publishedAt": (now - chrono::Duration::hours(23)).to_rfc3339(),
            "encryptedMetadata": "test"
        }))
        .unwrap();
        let delay = point.delay_until_next().unwrap();
        assert!(delay.as_secs() >= 3599 && delay.as_secs() <= 3600);
        point.published_at = (now - chrono::Duration::hours(23))
            .format("%Y-%m-%d %H:%M:%S%.f+00")
            .to_string();
        let delay = point.delay_until_next().unwrap();
        assert!((3599..=3600).contains(&delay.as_secs()));
    }
    #[tokio::test]
    async fn status_distinguishes_selected_source_from_local_consent_after_restore() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let store = Store::default();
        let user = uuid::Uuid::new_v4().to_string();
        let source = source_id(&store, &user).unwrap();
        let master = MasterKey::generate();
        master.save(&store, &user).unwrap();
        let key_id = uuid::Uuid::new_v4().to_string();
        let key = client::KeyRecord {
            key_id: key_id.clone(),
            recovery_envelope: wrap_recovery(&master, &generate_recovery_code(), &user, &key_id)
                .unwrap(),
            recovery_revision: 1,
            trusted_revision: 0,
            created: false,
        };
        let team = uuid::Uuid::new_v4().to_string();
        store
            .set_secret(
                wealthfolio_core::secrets::SYNC_IDENTITY_KEY,
                &serde_json::to_string(&crate::SyncIdentity {
                    device_nonce: Some(uuid::Uuid::new_v4().to_string()),
                    device_id: Some(uuid::Uuid::new_v4().to_string()),
                    root_key: Some(crate::crypto::generate_root_key()),
                    key_version: Some(1),
                    ..Default::default()
                })
                .unwrap(),
            )
            .unwrap();
        let policy = serde_json::json!({
            "userId": user, "enabled": true, "sourceId": source, "revision": 1,
            "teamId": team, "nextDueAt": null, "lastBackupAt": null,
            "uploadEntitled": true,
        })
        .to_string();
        let point_id = uuid::Uuid::new_v4().to_string();
        let aad = context(&["metadata", "1", &user, &key_id, &point_id]);
        let labels = serde_json::json!({"device_name":"Laptop", "profile_name":"Personal", "app_version":"3.9.2"}).to_string();
        let encrypted_labels =
            BASE64.encode(seal(&derive(&master.0, &aad), labels.as_bytes(), &aad).unwrap());
        let mut point = serde_json::json!({"backupId":point_id,"userId":user,"keyId":key_id,"sourceId":source,"sizeBytes":1,"checksum":"test","format":1,"publishedAt":"2026-10-01T00:00:00Z","encryptedMetadata":encrypted_labels});
        let good = point.clone();
        point["encryptedMetadata"] =
            serde_json::json!(BASE64.encode(seal(&derive(&master.0, &aad), b"{}", &aad).unwrap()));
        let legacy = point.clone();
        point["backupId"] = serde_json::json!(uuid::Uuid::new_v4().to_string());
        let history = serde_json::json!([good, legacy, point]).to_string();
        let key = serde_json::to_string(&key).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for _ in 0..12 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                loop {
                    let mut chunk = [0; 1024];
                    let size = socket.read(&mut chunk).await.unwrap();
                    assert!(size > 0);
                    request.extend_from_slice(&chunk[..size]);
                    if request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                        break;
                    }
                }
                let request = String::from_utf8(request).unwrap();
                let body = if request.starts_with("GET /api/v1/backups/policy ") {
                    &policy
                } else if request.starts_with("GET /api/v1/backups/key ") {
                    &key
                } else {
                    assert!(request.starts_with("GET /api/v1/backups/history "));
                    &history
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(), body
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let client = client::BackupClient::new(&url).unwrap();
        for consent in [None, Some("different-user"), Some(user.as_str()), None] {
            if let Some(value) = consent {
                store
                    .set_secret(wealthfolio_core::secrets::CLOUD_BACKUP_CONSENT_KEY, value)
                    .unwrap();
            } else {
                store
                    .delete_secret(wealthfolio_core::secrets::CLOUD_BACKUP_CONSENT_KEY)
                    .unwrap();
            }
            let status = client
                .management("synthetic-token", &store, &client::BackupOperation::Status)
                .await
                .unwrap();
            assert_eq!(status["history"][0]["metadata"]["device_name"], "Laptop");
            assert_eq!(status["history"][0]["metadata"]["profile_name"], "Personal");
            assert_eq!(status["history"][1]["metadata"], serde_json::json!({}));
            assert_eq!(
                status["history"][2]["metadata"],
                serde_json::Value::Null,
                "labels cannot be moved to another point"
            );
            assert_eq!(status["isSource"], true);
            assert_eq!(status["keyReady"], true);
            assert_eq!(status["sourceConsented"], consent == Some(user.as_str()));
        }
        server.await.unwrap();
    }
    #[test]
    fn lost_setup_response_recovers_only_the_confirmed_candidate() {
        let store = Store::default();
        let master = MasterKey::generate();
        let ctx = ctx();
        stage_master(&store, &ctx.user_id, &ctx.key_id, &master).unwrap();
        assert!(MasterKey::load(&store, &ctx.user_id).unwrap().is_none());
        assert!(resolve_pending_master(&store, &ctx.user_id, &ctx.key_id).unwrap());
        let recovered = MasterKey::load(&store, &ctx.user_id).unwrap().unwrap();
        assert_eq!(recovered.0, master.0);
        assert!(pending_master(&store, &ctx.user_id).unwrap().is_none());
    }
    #[test]
    fn losing_setup_never_installs_its_candidate() {
        let store = Store::default();
        let ctx = ctx();
        stage_master(&store, &ctx.user_id, &ctx.key_id, &MasterKey::generate()).unwrap();
        assert!(
            !resolve_pending_master(&store, &ctx.user_id, &uuid::Uuid::new_v4().to_string())
                .unwrap()
        );
        assert!(MasterKey::load(&store, &ctx.user_id).unwrap().is_none());
        assert!(pending_master(&store, &ctx.user_id).unwrap().is_none());
    }
    #[test]
    fn frozen_v1_recovery_package_remains_readable() {
        // Fixed, synthetic data: changing the writer must not silently change compatibility.
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/cloud-backup-v1.json")).unwrap();
        assert_eq!(fixture["synthetic_only"], true);
        let package = BASE64
            .decode(fixture["package_base64"].as_str().unwrap())
            .unwrap();
        let expected = BASE64
            .decode(fixture["database_base64"].as_str().unwrap())
            .unwrap();
        let (header, encrypted) = read_recovery_package(package.as_slice()).unwrap();
        let master = unwrap_recovery(
            &header.recovery,
            fixture["recovery_code"].as_str().unwrap(),
            &header.context.user_id,
            &header.context.key_id,
        )
        .unwrap();
        assert_eq!(
            decrypt_database(&master, &header.context, &encrypted).unwrap(),
            expected
        );
    }
}
