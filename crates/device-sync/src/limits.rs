//! Size and request-duration policy for Connect backups and sync snapshots.
//! Keep these values aligned with the cloud API's transfers/limits.ts.

/// Snapshots remain readable through the legacy cloud download route.
pub const MAX_ENCRYPTED_SNAPSHOT_BYTES: usize = 120 * 1024 * 1024;
/// Cloud backups use direct storage upload and download.
pub const MAX_ENCRYPTED_BACKUP_BYTES: usize = 256 * 1024 * 1024;
/// Plaintext SQLite image bound after decryption and decompression.
pub const MAX_DATABASE_IMAGE_BYTES: usize = 512 * 1024 * 1024;

pub const SNAPSHOT_TRANSFER_TIMEOUT_SECONDS: u64 = 900;
pub const BACKUP_TRANSFER_TIMEOUT_SECONDS: u64 = 900;
/// End-to-end manual capture includes export, encryption and transfer.
pub const BACKUP_CAPTURE_TIMEOUT_SECONDS: u64 = 1800;
