//! Tests for account domain models including TrackingMode.

#[cfg(test)]
mod tests {
    use crate::accounts::{Account, NewAccount, TrackingMode};
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

    #[test]
    fn cash_allocation_category_id_parses_meta() {
        let account = Account {
            meta: Some(r#"{"allocation":{"cashCategoryId":"FIXED_INCOME"}}"#.to_string()),
            ..Account::default()
        };
        assert_eq!(
            account.cash_allocation_category_id(),
            Some("FIXED_INCOME".to_string())
        );
    }

    #[test]
    fn cash_allocation_category_id_none_when_missing() {
        let account = Account {
            meta: Some(r#"{"accountingSettings":{}}"#.to_string()),
            ..Account::default()
        };
        assert_eq!(account.cash_allocation_category_id(), None);
    }

    #[test]
    fn cash_allocation_category_id_none_when_no_meta() {
        let account = Account::default();
        assert_eq!(account.cash_allocation_category_id(), None);
    }

    #[test]
    fn cash_allocation_category_id_with_existing_accounting_meta() {
        let account = Account {
            meta: Some(
                r#"{"accountingSettings":{"costBasisMethod":"fifo"},"allocation":{"cashCategoryId":"EQUITY"}}"#
                    .to_string(),
            ),
            ..Account::default()
        };
        assert_eq!(
            account.cash_allocation_category_id(),
            Some("EQUITY".to_string())
        );
    }

    #[test]
    fn test_credit_card_rejects_holdings_tracking_mode() {
        let account = NewAccount {
            id: None,
            name: "Card".to_string(),
            account_type: "CREDIT_CARD".to_string(),
            group: None,
            currency: "USD".to_string(),
            is_default: false,
            is_active: true,
            platform_id: None,
            account_number: None,
            meta: None,
            provider: None,
            provider_account_id: None,
            is_archived: false,
            tracking_mode: TrackingMode::Holdings,
        };

        let err = account
            .validate()
            .expect_err("credit cards should not support holdings mode");
        assert!(err
            .to_string()
            .contains("Credit card accounts cannot use HOLDINGS tracking mode"));
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
        }
    }
}
