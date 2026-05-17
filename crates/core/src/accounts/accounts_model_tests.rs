//! Tests for account domain models including TrackingMode.

#[cfg(test)]
mod tests {
    use crate::accounts::{Account, TaxTreatment, TrackingMode};
    use chrono::NaiveDateTime;

    // ==================== TrackingMode Serialization Tests ====================

    #[test]
    fn test_tracking_mode_serialization() {
        assert_eq!(
            serde_json::to_string(&TrackingMode::Transactions).unwrap(),
            "\"TRANSACTIONS\""
        );
        assert_eq!(
            serde_json::to_string(&TrackingMode::Holdings).unwrap(),
            "\"HOLDINGS\""
        );
        assert_eq!(
            serde_json::to_string(&TrackingMode::NotSet).unwrap(),
            "\"NOT_SET\""
        );
    }

    #[test]
    fn test_tracking_mode_deserialization() {
        assert_eq!(
            serde_json::from_str::<TrackingMode>("\"TRANSACTIONS\"").unwrap(),
            TrackingMode::Transactions
        );
        assert_eq!(
            serde_json::from_str::<TrackingMode>("\"HOLDINGS\"").unwrap(),
            TrackingMode::Holdings
        );
        assert_eq!(
            serde_json::from_str::<TrackingMode>("\"NOT_SET\"").unwrap(),
            TrackingMode::NotSet
        );
    }

    #[test]
    fn test_tracking_mode_default() {
        let mode = TrackingMode::default();
        assert_eq!(mode, TrackingMode::NotSet);
    }

    // ==================== Account tracking_mode Field Tests ====================

    #[test]
    fn test_account_tracking_mode_default() {
        let account = Account::default();
        assert_eq!(account.tracking_mode, TrackingMode::NotSet);
    }

    #[test]
    fn test_account_tracking_mode_transactions() {
        let account = create_test_account(TrackingMode::Transactions);
        assert_eq!(account.tracking_mode, TrackingMode::Transactions);
    }

    #[test]
    fn test_account_tracking_mode_holdings() {
        let account = create_test_account(TrackingMode::Holdings);
        assert_eq!(account.tracking_mode, TrackingMode::Holdings);
    }

    #[test]
    fn test_account_is_archived_default() {
        let account = Account::default();
        assert!(!account.is_archived);
    }

    // ==================== Helper Functions ====================

    fn create_test_account(tracking_mode: TrackingMode) -> Account {
        Account {
            id: "test-account-id".to_string(),
            name: "Test Account".to_string(),
            account_type: "SECURITIES".to_string(),
            group: None,
            currency: "USD".to_string(),
            is_default: false,
            is_active: true,
            created_at: NaiveDateTime::default(),
            updated_at: NaiveDateTime::default(),
            platform_id: None,
            account_number: None,
            meta: None,
            provider: None,
            provider_account_id: None,
            is_archived: false,
            tracking_mode,
            tax_treatment: TaxTreatment::Taxable,
        }
    }
}
