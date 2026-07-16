//! Storage for durable per-addon key-value data.
//!
//! Reads go through the pool, writes are serialized on the `WriteHandle` like
//! the other repositories. Writes also emit device-sync outbox events keyed by
//! [`addon_storage_id`], so a key replicates across paired devices (uninstall
//! cleanup stays local-only).

pub mod storage;

pub use storage::{AddonStorageDB, AddonStorageRepository};

use crate::utils::stable_id;

/// Deterministic device-sync `entity_id` for an addon storage row. The
/// `(addon_id, key)` composite key must resolve to the same id on every device
/// for last-writer-wins to converge, so it is derived — never a random UUID.
pub(crate) fn addon_storage_id(addon_id: &str, key: &str) -> String {
    stable_id("addon_storage", &[addon_id, key])
}
