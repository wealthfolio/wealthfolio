//! Idempotency key computation for activity deduplication.
//!
//! Provider IDs are unreliable - they can change when providers reprocess history.
//! This module computes stable fingerprints based on the activity's semantic content.

use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use sha2::{Digest, Sha256};

/// Computes a stable idempotency key for an activity.
///
/// The key is a SHA-256 hash of the activity's semantic content:
/// - account_id
/// - normalized activity type
/// - activity date
/// - asset_id (if present)
/// - quantity
/// - unit_price
/// - amount
/// - non-zero fee
/// - currency
/// - provider_reference_id (if available - huge win for deduplication)
/// - description/notes
///
/// This allows reliable upsert/dedupe even when provider IDs change.
#[allow(clippy::too_many_arguments)]
pub fn compute_idempotency_key(
    account_id: &str,
    activity_type: &str,
    activity_date: &DateTime<Utc>,
    asset_id: Option<&str>,
    quantity: Option<Decimal>,
    unit_price: Option<Decimal>,
    amount: Option<Decimal>,
    fee: Option<Decimal>,
    currency: &str,
    provider_reference_id: Option<&str>,
    description: Option<&str>,
) -> String {
    let mut hasher = Sha256::new();

    // Core identity fields
    hasher.update(account_id.as_bytes());
    hasher.update(b"|");
    hasher.update(activity_type.as_bytes());
    hasher.update(b"|");

    // Date - normalize to date only (ignore time component for matching)
    let date_str = activity_date.format("%Y-%m-%d").to_string();
    hasher.update(date_str.as_bytes());
    hasher.update(b"|");

    // Asset
    if let Some(aid) = asset_id {
        hasher.update(aid.as_bytes());
    }
    hasher.update(b"|");

    // Quantities - normalize to string with fixed precision
    if let Some(qty) = quantity {
        hasher.update(normalize_decimal(qty).as_bytes());
    }
    hasher.update(b"|");

    if let Some(price) = unit_price {
        hasher.update(normalize_decimal(price).as_bytes());
    }
    hasher.update(b"|");

    if let Some(amt) = amount {
        hasher.update(normalize_decimal(amt).as_bytes());
    }
    hasher.update(b"|");

    hasher.update(currency.as_bytes());
    hasher.update(b"|");

    // Provider reference - if available, greatly improves matching
    if let Some(ref_id) = provider_reference_id {
        hasher.update(ref_id.as_bytes());
    }
    hasher.update(b"|");

    // Description - normalize whitespace
    if let Some(desc) = description {
        let normalized = normalize_description(desc);
        hasher.update(normalized.as_bytes());
    }

    if let Some(fee) = fee.filter(|value| !value.is_zero()) {
        hasher.update(b"\x1ffee\x1f");
        hasher.update(normalize_decimal(fee).as_bytes());
    }

    // Convert to hex string
    let result = hasher.finalize();
    hex::encode(result)
}

/// Normalize decimal to consistent string format
fn normalize_decimal(d: Decimal) -> String {
    // Remove trailing zeros for consistent hashing
    d.normalize().to_string()
}

/// Normalize description by trimming and collapsing whitespace
fn normalize_description(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Compute idempotency key from an Activity struct
pub fn compute_activity_idempotency_key(activity: &crate::activities::Activity) -> String {
    compute_idempotency_key(
        &activity.account_id,
        activity.effective_type(),
        &activity.activity_date,
        activity.asset_id.as_deref(),
        activity.quantity,
        activity.unit_price,
        activity.amount,
        activity.fee,
        &activity.currency,
        activity.source_record_id.as_deref(),
        activity.notes.as_deref(),
    )
}

/// Generate idempotency key for manual activities
/// Uses a UUID-based approach since manual activities don't have provider references
pub fn generate_manual_idempotency_key() -> String {
    let uuid = uuid::Uuid::new_v4();
    format!("manual:{}", uuid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use rust_decimal::prelude::FromStr;

    #[test]
    fn test_compute_idempotency_key_basic() {
        let date = Utc.with_ymd_and_hms(2025, 1, 15, 10, 30, 0).unwrap();

        let key = compute_idempotency_key(
            "account-1",
            "BUY",
            &date,
            Some("AAPL"),
            Some(Decimal::from(100)),
            Some(Decimal::from(150)),
            Some(Decimal::from(15000)),
            None,
            "USD",
            None,
            None,
        );

        assert!(!key.is_empty());
        assert_eq!(key.len(), 64); // SHA-256 hex is 64 chars
    }

    #[test]
    fn test_same_inputs_same_key() {
        let date = Utc.with_ymd_and_hms(2025, 1, 15, 10, 30, 0).unwrap();

        let key1 = compute_idempotency_key(
            "account-1",
            "BUY",
            &date,
            Some("AAPL"),
            Some(Decimal::from(100)),
            Some(Decimal::from(150)),
            Some(Decimal::from(15000)),
            None,
            "USD",
            None,
            None,
        );

        let key2 = compute_idempotency_key(
            "account-1",
            "BUY",
            &date,
            Some("AAPL"),
            Some(Decimal::from(100)),
            Some(Decimal::from(150)),
            Some(Decimal::from(15000)),
            None,
            "USD",
            None,
            None,
        );

        assert_eq!(key1, key2);
    }

    #[test]
    fn test_different_time_same_date_same_key() {
        // Time component should be ignored
        let date1 = Utc.with_ymd_and_hms(2025, 1, 15, 10, 30, 0).unwrap();
        let date2 = Utc.with_ymd_and_hms(2025, 1, 15, 23, 59, 59).unwrap();

        let key1 = compute_idempotency_key(
            "account-1",
            "BUY",
            &date1,
            Some("AAPL"),
            Some(Decimal::from(100)),
            None,
            None,
            None,
            "USD",
            None,
            None,
        );

        let key2 = compute_idempotency_key(
            "account-1",
            "BUY",
            &date2,
            Some("AAPL"),
            Some(Decimal::from(100)),
            None,
            None,
            None,
            "USD",
            None,
            None,
        );

        assert_eq!(key1, key2);
    }

    #[test]
    fn test_different_account_different_key() {
        let date = Utc.with_ymd_and_hms(2025, 1, 15, 10, 30, 0).unwrap();

        let key1 = compute_idempotency_key(
            "account-1",
            "BUY",
            &date,
            Some("AAPL"),
            Some(Decimal::from(100)),
            None,
            None,
            None,
            "USD",
            None,
            None,
        );

        let key2 = compute_idempotency_key(
            "account-2",
            "BUY",
            &date,
            Some("AAPL"),
            Some(Decimal::from(100)),
            None,
            None,
            None,
            "USD",
            None,
            None,
        );

        assert_ne!(key1, key2);
    }

    #[test]
    fn test_provider_reference_included() {
        let date = Utc.with_ymd_and_hms(2025, 1, 15, 10, 30, 0).unwrap();

        let key1 = compute_idempotency_key(
            "account-1",
            "BUY",
            &date,
            Some("AAPL"),
            Some(Decimal::from(100)),
            None,
            None,
            None,
            "USD",
            Some("ref-123"),
            None,
        );

        let key2 = compute_idempotency_key(
            "account-1",
            "BUY",
            &date,
            Some("AAPL"),
            Some(Decimal::from(100)),
            None,
            None,
            None,
            "USD",
            Some("ref-456"),
            None,
        );

        assert_ne!(key1, key2);
    }

    #[test]
    fn test_fee_included() {
        let date = Utc.with_ymd_and_hms(2025, 1, 15, 10, 30, 0).unwrap();

        let key1 = compute_idempotency_key(
            "account-1",
            "BUY",
            &date,
            Some("AAPL"),
            Some(Decimal::from(100)),
            Some(Decimal::from(150)),
            None,
            Some(Decimal::from(1)),
            "USD",
            None,
            None,
        );

        let key2 = compute_idempotency_key(
            "account-1",
            "BUY",
            &date,
            Some("AAPL"),
            Some(Decimal::from(100)),
            Some(Decimal::from(150)),
            None,
            Some(Decimal::from(2)),
            "USD",
            None,
            None,
        );

        assert_ne!(key1, key2);
    }

    #[test]
    fn test_zero_fee_matches_absent_fee() {
        let date = Utc.with_ymd_and_hms(2025, 1, 15, 10, 30, 0).unwrap();

        let key_without_fee = compute_idempotency_key(
            "account-1",
            "BUY",
            &date,
            Some("AAPL"),
            Some(Decimal::from(100)),
            Some(Decimal::from(150)),
            None,
            None,
            "USD",
            None,
            None,
        );

        let key_with_zero_fee = compute_idempotency_key(
            "account-1",
            "BUY",
            &date,
            Some("AAPL"),
            Some(Decimal::from(100)),
            Some(Decimal::from(150)),
            None,
            Some(Decimal::ZERO),
            "USD",
            None,
            None,
        );

        assert_eq!(key_without_fee, key_with_zero_fee);
    }

    #[test]
    fn test_normalize_decimal() {
        // 100.00 and 100 should produce same string
        let d1 = Decimal::from_str("100.00").unwrap();
        let d2 = Decimal::from(100);

        assert_eq!(normalize_decimal(d1), normalize_decimal(d2));
    }

    #[test]
    fn test_normalize_description() {
        let desc1 = "  Buy  AAPL   stock  ";
        let desc2 = "Buy AAPL stock";

        assert_eq!(normalize_description(desc1), desc2);
    }

    #[test]
    fn test_generate_manual_idempotency_key() {
        let key1 = generate_manual_idempotency_key();
        let key2 = generate_manual_idempotency_key();

        assert!(key1.starts_with("manual:"));
        assert!(key2.starts_with("manual:"));
        assert_ne!(key1, key2); // Should be unique
    }
}
