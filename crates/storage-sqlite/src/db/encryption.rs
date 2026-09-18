//! SQLCipher key material, and the platform hook that supplies it.
//!
//! One key per database. No wrapping, no derivation chain, no stored metadata:
//! the 32 raw bytes are handed to `PRAGMA key` as a 64-character hex string,
//! which SQLCipher uses directly as the encryption key and skips its KDF. That
//! is correct here because the input is already a random (desktop/iOS) or
//! HKDF-derived (server) key rather than a passphrase. SQLCipher generates and
//! stores the salt itself, in the first 16 bytes of the database.

use diesel::connection::SimpleConnection;
use diesel::sqlite::SqliteConnection;
use rusqlite::Connection as RusqliteConnection;
use wealthfolio_core::errors::{DatabaseError, Error, Result};
use zeroize::Zeroizing;

use crate::errors::StorageError;

/// Length of a raw SQLCipher key in bytes.
pub const DB_ENCRYPTION_KEY_BYTES: usize = 32;

/// A raw SQLCipher key, carried as the hex string the pragma consumes.
///
/// The hex form is zeroized on drop. It is never logged or `Debug`-printed.
#[derive(Clone)]
pub struct DbEncryptionKey(Zeroizing<String>);

impl DbEncryptionKey {
    /// Mints a fresh key from the OS CSPRNG. Only the explicit enable path and
    /// first-boot-under-an-encrypted-policy ever reach this.
    pub fn generate() -> Self {
        use rand::RngCore;

        let mut bytes = Zeroizing::new([0u8; DB_ENCRYPTION_KEY_BYTES]);
        rand::rngs::OsRng.fill_bytes(bytes.as_mut());
        Self::from_bytes(&bytes)
    }

    pub fn from_bytes(bytes: &[u8; DB_ENCRYPTION_KEY_BYTES]) -> Self {
        Self(Zeroizing::new(hex::encode(bytes)))
    }

    /// Parses a stored key. Rejects anything that is not exactly 64 hex
    /// characters, which also keeps the value safe to interpolate into the
    /// pragma below.
    pub fn from_hex(value: &str) -> Result<Self> {
        let value = value.trim();
        if value.len() != DB_ENCRYPTION_KEY_BYTES * 2
            || !value.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(Error::Database(DatabaseError::Encryption(format!(
                "Database key must be {} hex characters",
                DB_ENCRYPTION_KEY_BYTES * 2
            ))));
        }
        Ok(Self(Zeroizing::new(value.to_ascii_lowercase())))
    }

    pub fn as_hex(&self) -> &str {
        self.0.as_str()
    }

    /// The key literal accepted by `PRAGMA key` and by `ATTACH ... KEY`.
    fn sql_literal(&self) -> Zeroizing<String> {
        Zeroizing::new(format!("\"x'{}'\"", self.0.as_str()))
    }
}

impl std::fmt::Debug for DbEncryptionKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DbEncryptionKey(<redacted>)")
    }
}

/// The `KEY` clause for an `ATTACH DATABASE` statement.
///
/// SQLCipher's default for an attached database is to reuse the main database's
/// key, so a plaintext target must say `KEY ''` explicitly — the default
/// silently changes meaning the moment the main database is keyed.
pub(crate) fn attach_key_clause(key: Option<&DbEncryptionKey>) -> Zeroizing<String> {
    match key {
        Some(key) => Zeroizing::new(format!("KEY {}", key.sql_literal().as_str())),
        None => Zeroizing::new("KEY ''".to_string()),
    }
}

fn key_pragma(key: &DbEncryptionKey) -> Zeroizing<String> {
    Zeroizing::new(format!("PRAGMA key = {};", key.sql_literal().as_str()))
}

/// Applies `PRAGMA key` as the *first* statement on a Diesel connection.
///
/// A `None` key is a deliberate no-op: SQLCipher with no key applied behaves as
/// plain SQLite, which is how existing plaintext databases keep opening.
pub(crate) fn apply_key(conn: &mut SqliteConnection, key: Option<&DbEncryptionKey>) -> Result<()> {
    let Some(key) = key else { return Ok(()) };
    conn.batch_execute(key_pragma(key).as_str())
        .map_err(StorageError::from)?;
    Ok(())
}

/// Applies `PRAGMA key` as the *first* statement on a rusqlite connection.
pub(crate) fn apply_key_rusqlite(
    conn: &RusqliteConnection,
    key: Option<&DbEncryptionKey>,
) -> Result<()> {
    let Some(key) = key else { return Ok(()) };
    conn.execute_batch(key_pragma(key).as_str()).map_err(|e| {
        Error::Database(DatabaseError::Encryption(format!(
            "Failed to apply database key: {e}"
        )))
    })
}

/// Supplies this platform's database key.
///
/// The two methods are kept deliberately distinct. Detection and normal startup
/// call only [`KeyProvider::existing`], so a device that never opted in can
/// never have a key minted underneath it — a get-or-create provider consulted
/// during detection would mint one, and a keyed open of a *missing* file would
/// then create a brand-new encrypted database and succeed.
pub trait KeyProvider: Send + Sync {
    /// The key that already exists for this device, or `None`. Never creates one.
    ///
    /// A `Some` result says nothing about the database file: after encryption is
    /// disabled the key is retained, so a retained key beside a plaintext
    /// database is a normal state. Only probing the file determines its state.
    fn existing(&self) -> Result<Option<DbEncryptionKey>>;

    /// Creates and persists a key. Reached only from the explicit enable path.
    fn create(&self) -> Result<DbEncryptionKey>;
}

/// A provider for builds and tests that never encrypt.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoKeyProvider;

impl KeyProvider for NoKeyProvider {
    fn existing(&self) -> Result<Option<DbEncryptionKey>> {
        Ok(None)
    }

    fn create(&self) -> Result<DbEncryptionKey> {
        Err(Error::Database(DatabaseError::Encryption(
            "Database encryption is not available on this platform".to_string(),
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_keys_that_are_not_64_hex_characters() {
        assert!(DbEncryptionKey::from_hex(&"a".repeat(63)).is_err());
        assert!(DbEncryptionKey::from_hex(&"a".repeat(65)).is_err());
        assert!(DbEncryptionKey::from_hex(&"z".repeat(64)).is_err());
        assert!(DbEncryptionKey::from_hex(&"a".repeat(64)).is_ok());
    }

    #[test]
    fn generated_keys_are_64_hex_characters_and_distinct() {
        let first = DbEncryptionKey::generate();
        let second = DbEncryptionKey::generate();

        assert_eq!(first.as_hex().len(), DB_ENCRYPTION_KEY_BYTES * 2);
        assert!(first.as_hex().bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(first.as_hex(), second.as_hex());
    }

    #[test]
    fn key_is_rendered_as_a_raw_hex_literal() {
        let key = DbEncryptionKey::from_bytes(&[0xab; DB_ENCRYPTION_KEY_BYTES]);
        assert_eq!(
            key_pragma(&key).as_str(),
            format!(
                "PRAGMA key = \"x'{}'\";",
                "ab".repeat(DB_ENCRYPTION_KEY_BYTES)
            )
        );
    }

    #[test]
    fn plaintext_attachments_pass_an_explicit_empty_key() {
        assert_eq!(attach_key_clause(None).as_str(), "KEY ''");
    }

    #[test]
    fn debug_never_reveals_the_key() {
        let key = DbEncryptionKey::from_bytes(&[0x11; DB_ENCRYPTION_KEY_BYTES]);
        let rendered = format!("{key:?}");
        assert!(!rendered.contains("11"), "{rendered}");
    }
}
