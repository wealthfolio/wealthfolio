//! Per-account facts fingerprint (architecture §3.3): every fact source the kernel
//! reads, so a mismatch against the recorded watermark means "recalculate".
//!
//! Market data is fingerprinted by content (day and value), not by row
//! timestamps: a provider sync that re-upserts identical closes must not
//! make every account stale on every launch.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct AccountFingerprint {
    /// Row count catches hard deletes; the latest `updated_at` catches edits.
    pub activity_count: usize,
    pub activities_updated_at: Option<DateTime<Utc>>,
    /// Counterparty legs of the account's transfer groups: the kernel books
    /// lots and flows from them, so their edits and deletions count too.
    pub partner_activity_count: usize,
    pub partner_activities_updated_at: Option<DateTime<Utc>>,
    /// `currency|type|tracking|archived|cost_basis_method|profile|pooling`.
    pub account: String,
    /// `id|kind|instrument|quote_ccy|multiplier` per referenced asset, sorted.
    pub assets: Vec<String>,
    pub observed_snapshot_count: usize,
    /// Content hash of the observed (non-calculated) snapshots.
    pub observed_snapshots_hash: u64,
    /// `base_currency|timezone`.
    pub policy: String,
    /// Quote/FX watermark: a backfilled or corrected quote changes
    /// valuations without touching activities (REG-1178).
    pub quote_count: usize,
    pub quotes_hash: u64,
    pub fx_count: usize,
    pub fx_hash: u64,
}

impl AccountFingerprint {
    /// Equal on everything but the market-data watermark.
    pub fn facts_equal(&self, other: &Self) -> bool {
        self.activity_count == other.activity_count
            && self.activities_updated_at == other.activities_updated_at
            && self.partner_activity_count == other.partner_activity_count
            && self.partner_activities_updated_at == other.partner_activities_updated_at
            && self.account == other.account
            && self.assets == other.assets
            && self.observed_snapshot_count == other.observed_snapshot_count
            && self.observed_snapshots_hash == other.observed_snapshots_hash
            && self.policy == other.policy
    }
}

/// Order-independent 64-bit FNV-1a fold over string items: stable across
/// runs and toolchains (unlike `DefaultHasher`).
pub fn content_hash<'a>(items: impl IntoIterator<Item = &'a str>) -> u64 {
    let mut keys: Vec<&str> = items.into_iter().collect();
    keys.sort_unstable();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for key in keys {
        for byte in key.bytes().chain(std::iter::once(0)) {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    hash
}
