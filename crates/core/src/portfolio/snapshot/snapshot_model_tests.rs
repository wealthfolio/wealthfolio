//! Tests for snapshot domain models including SnapshotSource.

#[cfg(test)]
mod tests {
    use crate::portfolio::snapshot::SnapshotSource;

    // ==================== SnapshotSource Serialization Tests ====================

    #[test]
    fn test_snapshot_source_serialization() {
        assert_eq!(
            serde_json::to_string(&SnapshotSource::Calculated).unwrap(),
            "\"CALCULATED\""
        );
        assert_eq!(
            serde_json::to_string(&SnapshotSource::ManualEntry).unwrap(),
            "\"MANUAL_ENTRY\""
        );
        assert_eq!(
            serde_json::to_string(&SnapshotSource::BrokerImported).unwrap(),
            "\"BROKER_IMPORTED\""
        );
        assert_eq!(
            serde_json::to_string(&SnapshotSource::CsvImport).unwrap(),
            "\"CSV_IMPORT\""
        );
    }

    #[test]
    fn test_snapshot_source_deserialization() {
        assert_eq!(
            serde_json::from_str::<SnapshotSource>("\"CALCULATED\"").unwrap(),
            SnapshotSource::Calculated
        );
        assert_eq!(
            serde_json::from_str::<SnapshotSource>("\"MANUAL_ENTRY\"").unwrap(),
            SnapshotSource::ManualEntry
        );
        assert_eq!(
            serde_json::from_str::<SnapshotSource>("\"BROKER_IMPORTED\"").unwrap(),
            SnapshotSource::BrokerImported
        );
        assert_eq!(
            serde_json::from_str::<SnapshotSource>("\"CSV_IMPORT\"").unwrap(),
            SnapshotSource::CsvImport
        );
    }

    #[test]
    fn test_snapshot_source_default() {
        let source = SnapshotSource::default();
        assert_eq!(source, SnapshotSource::Calculated);
    }

    // ==================== AccountStateSnapshot Source Field Tests ====================

    #[test]
    fn test_account_state_snapshot_default_source() {
        use crate::portfolio::snapshot::AccountStateSnapshot;

        let snapshot = AccountStateSnapshot::default();
        assert_eq!(snapshot.source, SnapshotSource::Calculated);
    }

    #[test]
    fn test_account_state_snapshot_serialization_with_source() {
        use crate::portfolio::snapshot::AccountStateSnapshot;
        use chrono::{NaiveDate, Utc};

        let snapshot = AccountStateSnapshot {
            id: "test-id".to_string(),
            account_id: "account-1".to_string(),
            snapshot_date: NaiveDate::from_ymd_opt(2024, 1, 15).unwrap(),
            currency: "USD".to_string(),
            base_currency: None,
            source: SnapshotSource::ManualEntry,
            calculated_at: Utc::now().naive_utc(),
            ..Default::default()
        };

        let json = serde_json::to_string(&snapshot).unwrap();
        assert!(json.contains("\"source\":\"MANUAL_ENTRY\""));
    }

    #[test]
    fn test_account_state_snapshot_deserialization_with_source() {
        use crate::portfolio::snapshot::AccountStateSnapshot;

        let json = r#"{
            "id": "test-id",
            "accountId": "account-1",
            "snapshotDate": "2024-01-15",
            "currency": "USD",
            "positions": {},
            "cashBalances": {},
            "costBasis": "0",
            "netContribution": "0",
            "netContributionBase": "0",
            "cashTotalAccountCurrency": "0",
            "cashTotalBaseCurrency": "0",
            "calculatedAt": "2024-01-15T10:00:00",
            "source": "BROKER_IMPORTED"
        }"#;

        let snapshot: AccountStateSnapshot = serde_json::from_str(json).unwrap();
        assert_eq!(snapshot.source, SnapshotSource::BrokerImported);
    }

    #[test]
    fn test_account_state_snapshot_deserialization_missing_source() {
        use crate::portfolio::snapshot::AccountStateSnapshot;

        // Test that missing source field defaults to Calculated
        let json = r#"{
            "id": "test-id",
            "accountId": "account-1",
            "snapshotDate": "2024-01-15",
            "currency": "USD",
            "positions": {},
            "cashBalances": {},
            "costBasis": "0",
            "netContribution": "0",
            "netContributionBase": "0",
            "cashTotalAccountCurrency": "0",
            "cashTotalBaseCurrency": "0",
            "calculatedAt": "2024-01-15T10:00:00"
        }"#;

        let snapshot: AccountStateSnapshot = serde_json::from_str(json).unwrap();
        assert_eq!(snapshot.source, SnapshotSource::Calculated);
    }

    #[test]
    fn test_snapshot_stable_id_is_deterministic_uuid() {
        use crate::portfolio::snapshot::AccountStateSnapshot;
        use chrono::NaiveDate;

        let day = NaiveDate::from_ymd_opt(2026, 2, 18).unwrap();
        let id1 = AccountStateSnapshot::stable_id("acc-123", day);
        let id2 = AccountStateSnapshot::stable_id("acc-123", day);
        let id3 = AccountStateSnapshot::stable_id("acc-123", day.succ_opt().unwrap());

        assert_eq!(id1, id2, "stable id must be deterministic");
        assert_ne!(id1, id3, "snapshot date should affect stable id");
        assert!(
            uuid::Uuid::parse_str(&id1).is_ok(),
            "stable id must be valid UUID"
        );
    }

    // ==================== is_content_equal Tests ====================

    #[test]
    fn test_is_content_equal_identical_empty_snapshots() {
        use crate::portfolio::snapshot::AccountStateSnapshot;

        let snapshot1 = AccountStateSnapshot::default();
        let snapshot2 = AccountStateSnapshot::default();

        assert!(snapshot1.is_content_equal(&snapshot2));
    }

    #[test]
    fn test_is_content_equal_different_metadata_same_content() {
        use crate::portfolio::snapshot::AccountStateSnapshot;
        use chrono::{NaiveDate, Utc};

        let snapshot1 = AccountStateSnapshot {
            id: "snapshot-1".to_string(),
            account_id: "account-1".to_string(),
            snapshot_date: NaiveDate::from_ymd_opt(2024, 1, 15).unwrap(),
            base_currency: None,
            source: SnapshotSource::BrokerImported,
            calculated_at: Utc::now().naive_utc(),
            ..Default::default()
        };

        let snapshot2 = AccountStateSnapshot {
            id: "snapshot-2".to_string(), // Different ID
            account_id: "account-1".to_string(),
            snapshot_date: NaiveDate::from_ymd_opt(2024, 2, 20).unwrap(), // Different date
            base_currency: None,
            source: SnapshotSource::ManualEntry, // Different source
            calculated_at: Utc::now().naive_utc(),
            ..Default::default()
        };

        // Should be equal because positions and cash_balances are the same (empty)
        assert!(snapshot1.is_content_equal(&snapshot2));
    }

    #[test]
    fn test_is_content_equal_different_cash_balances() {
        use crate::portfolio::snapshot::AccountStateSnapshot;
        use rust_decimal::Decimal;
        use std::collections::HashMap;

        let mut snapshot1 = AccountStateSnapshot::default();
        let mut cash1 = HashMap::new();
        cash1.insert("USD".to_string(), Decimal::from(1000));
        snapshot1.cash_balances = cash1;

        let mut snapshot2 = AccountStateSnapshot::default();
        let mut cash2 = HashMap::new();
        cash2.insert("USD".to_string(), Decimal::from(2000)); // Different amount
        snapshot2.cash_balances = cash2;

        assert!(!snapshot1.is_content_equal(&snapshot2));
    }

    #[test]
    fn test_is_content_equal_different_positions() {
        use crate::portfolio::snapshot::{AccountStateSnapshot, Position};
        use chrono::Utc;
        use rust_decimal::Decimal;
        use std::collections::HashMap;

        let now = Utc::now();

        let mut snapshot1 = AccountStateSnapshot::default();
        let mut positions1 = HashMap::new();
        positions1.insert(
            "AAPL".to_string(),
            Position {
                id: "pos-1".to_string(),
                account_id: "account-1".to_string(),
                asset_id: "AAPL".to_string(),
                quantity: Decimal::from(100),
                average_cost: Decimal::from(150),
                total_cost_basis: Decimal::from(15000),
                currency: "USD".to_string(),
                inception_date: now,
                lots: Default::default(),
                created_at: now,
                last_updated: now,
                is_alternative: false,
                contract_multiplier: Decimal::ONE,
                cost_basis_account: None,
                cost_basis_base: None,
            },
        );
        snapshot1.positions = positions1;

        let mut snapshot2 = AccountStateSnapshot::default();
        let mut positions2 = HashMap::new();
        positions2.insert(
            "AAPL".to_string(),
            Position {
                id: "pos-2".to_string(), // Different ID (should be ignored)
                account_id: "account-1".to_string(),
                asset_id: "AAPL".to_string(),
                quantity: Decimal::from(200), // Different quantity
                average_cost: Decimal::from(150),
                total_cost_basis: Decimal::from(30000), // Different cost basis
                currency: "USD".to_string(),
                inception_date: now,
                lots: Default::default(),
                created_at: now,
                last_updated: now,
                is_alternative: false,
                contract_multiplier: Decimal::ONE,
                cost_basis_account: None,
                cost_basis_base: None,
            },
        );
        snapshot2.positions = positions2;

        assert!(!snapshot1.is_content_equal(&snapshot2));
    }

    #[test]
    fn test_is_content_equal_same_positions_different_metadata() {
        use crate::portfolio::snapshot::{AccountStateSnapshot, Position};
        use chrono::Utc;
        use rust_decimal::Decimal;
        use std::collections::HashMap;

        let now = Utc::now();

        let mut snapshot1 = AccountStateSnapshot::default();
        let mut positions1 = HashMap::new();
        positions1.insert(
            "AAPL".to_string(),
            Position {
                id: "pos-1".to_string(),
                account_id: "account-1".to_string(),
                asset_id: "AAPL".to_string(),
                quantity: Decimal::from(100),
                average_cost: Decimal::from(150),
                total_cost_basis: Decimal::from(15000),
                currency: "USD".to_string(),
                inception_date: now,
                lots: Default::default(),
                created_at: now,
                last_updated: now,
                is_alternative: false,
                contract_multiplier: Decimal::ONE,
                cost_basis_account: None,
                cost_basis_base: None,
            },
        );
        snapshot1.positions = positions1;

        let mut snapshot2 = AccountStateSnapshot::default();
        let mut positions2 = HashMap::new();
        positions2.insert(
            "AAPL".to_string(),
            Position {
                id: "pos-2".to_string(), // Different ID (should be ignored)
                account_id: "account-1".to_string(),
                asset_id: "AAPL".to_string(),
                quantity: Decimal::from(100),           // Same quantity
                average_cost: Decimal::from(150),       // Same avg cost
                total_cost_basis: Decimal::from(15000), // Same cost basis
                currency: "USD".to_string(),
                inception_date: Utc::now(), // Different timestamp (should be ignored)
                lots: Default::default(),
                created_at: Utc::now(), // Different timestamp (should be ignored)
                last_updated: Utc::now(), // Different timestamp (should be ignored)
                is_alternative: false,
                contract_multiplier: Decimal::ONE,
                cost_basis_account: None,
                cost_basis_base: None,
            },
        );
        snapshot2.positions = positions2;

        // Should be equal because core financial fields match
        assert!(snapshot1.is_content_equal(&snapshot2));
    }

    #[test]
    fn test_is_content_equal_detects_contract_multiplier_change() {
        use crate::portfolio::snapshot::{AccountStateSnapshot, Position};
        use chrono::Utc;
        use rust_decimal::Decimal;
        use std::collections::HashMap;

        let now = Utc::now();
        let position = Position {
            id: "pos-1".to_string(),
            account_id: "account-1".to_string(),
            asset_id: "contract-1".to_string(),
            quantity: Decimal::from(2),
            average_cost: Decimal::from(500),
            total_cost_basis: Decimal::from(1000),
            currency: "USD".to_string(),
            inception_date: now,
            lots: Default::default(),
            created_at: now,
            last_updated: now,
            is_alternative: false,
            contract_multiplier: Decimal::ONE,
            cost_basis_account: None,
            cost_basis_base: None,
        };

        let mut first = AccountStateSnapshot::default();
        first
            .positions
            .insert(position.asset_id.clone(), position.clone());

        let mut second_position = position;
        second_position.contract_multiplier = Decimal::from(50);
        let second = AccountStateSnapshot {
            positions: HashMap::from([(second_position.asset_id.clone(), second_position)]),
            ..Default::default()
        };

        assert!(!first.is_content_equal(&second));
    }

    #[test]
    fn test_is_content_equal_different_position_count() {
        use crate::portfolio::snapshot::{AccountStateSnapshot, Position};
        use chrono::Utc;
        use rust_decimal::Decimal;
        use std::collections::HashMap;

        let now = Utc::now();

        let mut snapshot1 = AccountStateSnapshot::default();
        let mut positions1 = HashMap::new();
        positions1.insert(
            "AAPL".to_string(),
            Position {
                id: "pos-1".to_string(),
                account_id: "account-1".to_string(),
                asset_id: "AAPL".to_string(),
                quantity: Decimal::from(100),
                average_cost: Decimal::from(150),
                total_cost_basis: Decimal::from(15000),
                currency: "USD".to_string(),
                inception_date: now,
                lots: Default::default(),
                created_at: now,
                last_updated: now,
                is_alternative: false,
                contract_multiplier: Decimal::ONE,
                cost_basis_account: None,
                cost_basis_base: None,
            },
        );
        snapshot1.positions = positions1;

        // snapshot2 has no positions
        let snapshot2 = AccountStateSnapshot::default();

        assert!(!snapshot1.is_content_equal(&snapshot2));
    }
}
