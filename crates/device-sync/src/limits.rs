//! Size policy for encrypted Connect backups and sync snapshots.
//! Keep these values aligned with the cloud API's transfers/limits.ts.

/// Maximum compressed, encrypted object accepted by the transfer transport.
pub const MAX_ENCRYPTED_TRANSFER_BYTES: usize = 120 * 1024 * 1024;

/// Maximum plaintext SQLite image after decryption and decompression.
/// This separate bound prevents a small compressed object expanding without limit.
pub const MAX_DATABASE_IMAGE_BYTES: usize = 512 * 1024 * 1024;
