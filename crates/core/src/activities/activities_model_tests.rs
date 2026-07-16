//! Tests for Activity domain models.

#[cfg(test)]
mod tests {
    use crate::activities::activities_model::*;
    use chrono::{TimeZone, Utc};
    use rust_decimal::Decimal;
    use rust_decimal_macros::dec;
    use serde_json::json;

    // ============================================================================
    // ActivityStatus Tests
    // ============================================================================

    #[test]
    fn test_activity_status_default() {
        let status = ActivityStatus::default();
        assert_eq!(status, ActivityStatus::Posted);
    }

    #[test]
    fn test_activity_status_serialization_posted() {
        let status = ActivityStatus::Posted;
        let json = serde_json::to_string(&status).unwrap();
        assert_eq!(json, r#""POSTED""#);
    }

    #[test]
    fn test_activity_status_serialization_pending() {
        let status = ActivityStatus::Pending;
        let json = serde_json::to_string(&status).unwrap();
        assert_eq!(json, r#""PENDING""#);
    }

    #[test]
    fn test_activity_status_serialization_draft() {
        let status = ActivityStatus::Draft;
        let json = serde_json::to_string(&status).unwrap();
        assert_eq!(json, r#""DRAFT""#);
    }

    #[test]
    fn test_activity_status_serialization_void() {
        let status = ActivityStatus::Void;
        let json = serde_json::to_string(&status).unwrap();
        assert_eq!(json, r#""VOID""#);
    }

    #[test]
    fn test_activity_status_deserialization() {
        let posted: ActivityStatus = serde_json::from_str(r#""POSTED""#).unwrap();
        assert_eq!(posted, ActivityStatus::Posted);

        let pending: ActivityStatus = serde_json::from_str(r#""PENDING""#).unwrap();
        assert_eq!(pending, ActivityStatus::Pending);

        let draft: ActivityStatus = serde_json::from_str(r#""DRAFT""#).unwrap();
        assert_eq!(draft, ActivityStatus::Draft);

        let void: ActivityStatus = serde_json::from_str(r#""VOID""#).unwrap();
        assert_eq!(void, ActivityStatus::Void);
    }

    // ============================================================================
    // Activity Helper Method Tests
    // ============================================================================

    fn create_test_activity() -> Activity {
        Activity {
            id: "test-id".to_string(),
            account_id: "account-1".to_string(),
            asset_id: Some("AAPL".to_string()),
            activity_type: "BUY".to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: None,
            status: ActivityStatus::Posted,
            activity_date: Utc.with_ymd_and_hms(2024, 1, 15, 10, 30, 0).unwrap(),
            settlement_date: None,
            quantity: Some(dec!(10)),
            unit_price: Some(dec!(150.50)),
            amount: Some(dec!(1505)),
            fee: Some(dec!(5.99)),
            tax: None,
            currency: "USD".to_string(),
            fx_rate: None,
            notes: None,
            metadata: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
            import_run_id: None,
            is_user_modified: false,
            needs_review: false,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    #[test]
    fn test_effective_type_no_override() {
        let activity = create_test_activity();
        assert_eq!(activity.effective_type(), "BUY");
    }

    #[test]
    fn test_effective_type_with_override() {
        let mut activity = create_test_activity();
        activity.activity_type_override = Some("DIVIDEND".to_string());
        assert_eq!(activity.effective_type(), "DIVIDEND");
    }

    #[test]
    fn test_effective_date() {
        let activity = create_test_activity();
        let date = activity.effective_date();
        assert_eq!(date.to_string(), "2024-01-15");
    }

    #[test]
    fn test_is_posted_true() {
        let activity = create_test_activity();
        assert!(activity.is_posted());
    }

    #[test]
    fn test_is_posted_false_for_draft() {
        let mut activity = create_test_activity();
        activity.status = ActivityStatus::Draft;
        assert!(!activity.is_posted());
    }

    #[test]
    fn test_is_posted_false_for_pending() {
        let mut activity = create_test_activity();
        activity.status = ActivityStatus::Pending;
        assert!(!activity.is_posted());
    }

    #[test]
    fn test_is_posted_false_for_void() {
        let mut activity = create_test_activity();
        activity.status = ActivityStatus::Void;
        assert!(!activity.is_posted());
    }

    #[test]
    fn test_has_override_false() {
        let activity = create_test_activity();
        assert!(!activity.has_override());
    }

    #[test]
    fn test_has_override_true() {
        let mut activity = create_test_activity();
        activity.activity_type_override = Some("DIVIDEND".to_string());
        assert!(activity.has_override());
    }

    #[test]
    fn test_qty_with_value() {
        let activity = create_test_activity();
        assert_eq!(activity.qty(), dec!(10));
    }

    #[test]
    fn test_qty_without_value() {
        let mut activity = create_test_activity();
        activity.quantity = None;
        assert_eq!(activity.qty(), Decimal::ZERO);
    }

    #[test]
    fn test_price_with_value() {
        let activity = create_test_activity();
        assert_eq!(activity.price(), dec!(150.50));
    }

    #[test]
    fn test_price_without_value() {
        let mut activity = create_test_activity();
        activity.unit_price = None;
        assert_eq!(activity.price(), Decimal::ZERO);
    }

    #[test]
    fn test_amt_with_value() {
        let activity = create_test_activity();
        assert_eq!(activity.amt(), dec!(1505));
    }

    #[test]
    fn test_amt_without_value() {
        let mut activity = create_test_activity();
        activity.amount = None;
        assert_eq!(activity.amt(), Decimal::ZERO);
    }

    #[test]
    fn test_fee_amt_with_value() {
        let activity = create_test_activity();
        assert_eq!(activity.fee_amt(), dec!(5.99));
    }

    #[test]
    fn test_fee_amt_without_value() {
        let mut activity = create_test_activity();
        activity.fee = None;
        assert_eq!(activity.fee_amt(), Decimal::ZERO);
    }

    #[test]
    fn test_get_meta_with_value() {
        let mut activity = create_test_activity();
        activity.metadata = Some(json!({
            "drip_reinvested": true,
            "shares_added": 5.5,
            "description": "Dividend reinvestment"
        }));

        let drip: Option<bool> = activity.get_meta("drip_reinvested");
        assert_eq!(drip, Some(true));

        let shares: Option<f64> = activity.get_meta("shares_added");
        assert_eq!(shares, Some(5.5));

        let desc: Option<String> = activity.get_meta("description");
        assert_eq!(desc, Some("Dividend reinvestment".to_string()));
    }

    #[test]
    fn test_get_meta_missing_key() {
        let activity = create_test_activity();
        let value: Option<String> = activity.get_meta("nonexistent");
        assert!(value.is_none());
    }

    #[test]
    fn test_get_meta_no_metadata() {
        let activity = create_test_activity();
        let value: Option<bool> = activity.get_meta("any_key");
        assert!(value.is_none());
    }

    // ============================================================================
    // Activity with null asset_id (pure cash movements)
    // ============================================================================

    #[test]
    fn test_activity_with_null_asset_id() {
        let mut activity = create_test_activity();
        activity.asset_id = None;
        activity.activity_type = "DEPOSIT".to_string();

        // Should work fine with None asset_id
        assert!(activity.asset_id.is_none());
        assert_eq!(activity.activity_type, "DEPOSIT");
    }

    // ============================================================================
    // NewActivity Validation Tests
    // ============================================================================

    fn create_test_new_activity() -> NewActivity {
        NewActivity {
            id: None,
            account_id: "account-1".to_string(),
            asset: Some(AssetResolutionInput {
                id: Some("AAPL".to_string()),
                ..Default::default()
            }),
            activity_type: "BUY".to_string(),
            subtype: None,
            activity_date: "2024-01-15".to_string(),
            quantity: Some(dec!(10)),
            unit_price: Some(dec!(150)),
            currency: "USD".to_string(),
            fee: Some(dec!(5)),
            tax: None,
            amount: Some(dec!(1505)),
            status: None,
            notes: None,
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
            import_run_id: None,
        }
    }

    #[test]
    fn test_new_activity_validation_success() {
        let activity = create_test_new_activity();
        let result = activity.validate();
        assert!(result.is_ok());
    }

    #[test]
    fn test_new_activity_validation_empty_account() {
        let mut activity = create_test_new_activity();
        activity.account_id = "".to_string();

        let result = activity.validate();
        assert!(result.is_err());

        let err = result.unwrap_err();
        assert!(err.to_string().contains("Account ID"));
    }

    #[test]
    fn test_new_activity_validation_whitespace_account() {
        let mut activity = create_test_new_activity();
        activity.account_id = "   ".to_string();

        let result = activity.validate();
        assert!(result.is_err());
    }

    #[test]
    fn test_new_activity_validation_empty_activity_type() {
        let mut activity = create_test_new_activity();
        activity.activity_type = "".to_string();

        let result = activity.validate();
        assert!(result.is_err());

        let err = result.unwrap_err();
        assert!(err.to_string().contains("Activity type"));
    }

    #[test]
    fn test_new_activity_validation_invalid_date_format() {
        let mut activity = create_test_new_activity();
        activity.activity_date = "invalid-date".to_string();

        let result = activity.validate();
        assert!(result.is_err());

        let err = result.unwrap_err();
        assert!(err.to_string().contains("date format"));
    }

    #[test]
    fn test_new_activity_validation_rfc3339_date() {
        let mut activity = create_test_new_activity();
        activity.activity_date = "2024-01-15T10:30:00Z".to_string();

        let result = activity.validate();
        assert!(result.is_ok());
    }

    #[test]
    fn test_new_activity_validation_yyyy_mm_dd_date() {
        let activity = create_test_new_activity();
        // Default is already YYYY-MM-DD
        let result = activity.validate();
        assert!(result.is_ok());
    }

    #[test]
    fn test_new_activity_allows_null_asset_id() {
        let mut activity = create_test_new_activity();
        activity.asset = None;
        activity.activity_type = "DEPOSIT".to_string();

        let result = activity.validate();
        assert!(result.is_ok());
    }

    #[test]
    fn test_new_activity_validates_staking_reward_quantity() {
        let mut activity = create_test_new_activity();
        activity.activity_type = "INTEREST".to_string();
        activity.subtype = Some("STAKING_REWARD".to_string());
        activity.quantity = None;
        activity.unit_price = Some(dec!(2000));
        activity.amount = Some(dec!(20));

        let result = activity.validate();

        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("positive quantity"));
    }

    #[test]
    fn test_new_activity_validates_dividend_in_kind_value_source() {
        let mut activity = create_test_new_activity();
        activity.activity_type = "DIVIDEND".to_string();
        activity.subtype = Some("DIVIDEND_IN_KIND".to_string());
        activity.quantity = Some(dec!(2));
        activity.unit_price = None;
        activity.amount = None;

        let result = activity.validate();

        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("FMV per unit"));
    }

    #[test]
    fn test_new_activity_allows_mismatched_subtype_as_metadata() {
        let mut activity = create_test_new_activity();
        activity.activity_type = "DIVIDEND".to_string();
        activity.subtype = Some("STAKING_REWARD".to_string());
        activity.quantity = Some(dec!(1));
        activity.unit_price = Some(dec!(100));
        activity.amount = Some(dec!(100));

        let result = activity.validate();

        assert!(result.is_ok());
    }

    #[test]
    fn test_new_activity_allows_unknown_provider_subtype_label() {
        let mut activity = create_test_new_activity();
        activity.activity_type = "BUY".to_string();
        activity.subtype = Some("BUY_TO_OPEN".to_string());

        let result = activity.validate();

        assert!(result.is_ok());
    }

    #[test]
    fn test_position_intent_aliases_are_canonicalized_by_activity_type() {
        assert_eq!(
            NewActivity::canonicalize_subtype_for_activity("BUY", Some("BUY_TO_OPEN")).as_deref(),
            Some("POSITION_OPEN")
        );
        assert_eq!(
            NewActivity::canonicalize_subtype_for_activity("SELL", Some("STO")).as_deref(),
            Some("POSITION_OPEN")
        );
        assert_eq!(
            NewActivity::canonicalize_subtype_for_activity("BUY", Some("BUY_TO_CLOSE")).as_deref(),
            Some("POSITION_CLOSE")
        );
        assert_eq!(
            NewActivity::canonicalize_subtype_for_activity("SELL", Some("STC")).as_deref(),
            Some("POSITION_CLOSE")
        );
        assert_eq!(
            NewActivity::canonicalize_subtype_for_activity("DIVIDEND", Some("BUY_TO_OPEN"))
                .as_deref(),
            Some("BUY_TO_OPEN")
        );
        assert_eq!(
            NewActivity::canonicalize_subtype_for_activity("SELL", Some("SELL_SHORT")).as_deref(),
            Some("POSITION_OPEN")
        );
        assert_eq!(
            NewActivity::canonicalize_subtype_for_activity("BUY", Some("BUY_TO_COVER")).as_deref(),
            Some("POSITION_CLOSE")
        );
    }

    #[test]
    fn test_new_activity_treats_zero_income_value_source_as_missing() {
        let mut activity = create_test_new_activity();
        activity.activity_type = "INTEREST".to_string();
        activity.subtype = Some("STAKING_REWARD".to_string());
        activity.quantity = Some(dec!(0.01));
        activity.unit_price = Some(dec!(0));
        activity.amount = Some(dec!(0));

        let result = activity.validate();

        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("FMV per unit"));
    }

    #[test]
    fn test_new_activity_allows_zero_amount_with_positive_unit_price() {
        let mut activity = create_test_new_activity();
        activity.activity_type = "INTEREST".to_string();
        activity.subtype = Some("STAKING_REWARD".to_string());
        activity.quantity = Some(dec!(0.01));
        activity.unit_price = Some(dec!(200));
        activity.amount = Some(dec!(0));

        let result = activity.validate();

        assert!(result.is_ok());
    }

    #[test]
    fn test_new_activity_allows_asset_income_amount_without_unit_price() {
        let mut activity = create_test_new_activity();
        activity.activity_type = "INTEREST".to_string();
        activity.subtype = Some("STAKING_REWARD".to_string());
        activity.quantity = Some(dec!(0.01));
        activity.unit_price = None;
        activity.amount = Some(dec!(20));

        let result = activity.validate();

        assert!(result.is_ok());
    }

    // ============================================================================
    // ActivityUpdate Validation Tests
    // ============================================================================

    fn create_test_activity_update() -> ActivityUpdate {
        ActivityUpdate {
            id: "activity-1".to_string(),
            account_id: "account-1".to_string(),
            asset: Some(AssetResolutionInput {
                id: Some("AAPL".to_string()),
                ..Default::default()
            }),
            activity_type: "BUY".to_string(),
            subtype: None,
            activity_date: "2024-01-15".to_string(),
            quantity: Some(Some(dec!(10))),
            unit_price: Some(Some(dec!(150))),
            currency: "USD".to_string(),
            fee: Some(Some(dec!(5))),
            tax: None,
            amount: Some(Some(dec!(1505))),
            status: None,
            notes: None,
            fx_rate: None,
            metadata: None,
        }
    }

    #[test]
    fn test_activity_update_validation_success() {
        let update = create_test_activity_update();
        let result = update.validate();
        assert!(result.is_ok());
    }

    #[test]
    fn test_activity_update_validation_empty_id() {
        let mut update = create_test_activity_update();
        update.id = "".to_string();

        let result = update.validate();
        assert!(result.is_err());

        let err = result.unwrap_err();
        assert!(err.to_string().contains("Activity ID"));
    }

    #[test]
    fn test_activity_update_validation_empty_account() {
        let mut update = create_test_activity_update();
        update.account_id = "".to_string();

        let result = update.validate();
        assert!(result.is_err());
    }

    #[test]
    fn test_activity_update_validation_empty_activity_type() {
        let mut update = create_test_activity_update();
        update.activity_type = "".to_string();

        let result = update.validate();
        assert!(result.is_err());
    }

    #[test]
    fn test_activity_update_allows_null_asset_id() {
        let mut update = create_test_activity_update();
        update.asset = None;
        update.activity_type = "DEPOSIT".to_string();

        let result = update.validate();
        assert!(result.is_ok());
    }

    #[test]
    fn test_activity_update_deserializes_scientific_and_nulls() {
        let input = json!({
            "id": "activity-1",
            "accountId": "account-1",
            "activityType": "BUY",
            "activityDate": "2024-01-15",
            "currency": "USD",
            "quantity": "1e-7",
            "unitPrice": 2.5e3,
            "subtype": null,
            "fee": null
        });

        let parsed: ActivityUpdate = serde_json::from_value(input).unwrap();

        assert_eq!(
            parsed.quantity,
            Some(Some(Decimal::from_scientific("1e-7").unwrap()))
        );
        assert_eq!(
            parsed.unit_price,
            Some(Some(Decimal::from_scientific("2.5e3").unwrap()))
        );
        assert_eq!(parsed.subtype, Some(String::new()));
        assert_eq!(parsed.fee, Some(None));
        assert_eq!(parsed.amount, None);
    }

    #[test]
    fn test_activity_inputs_accept_asset_and_legacy_symbol_fields() {
        let create_with_asset = json!({
            "accountId": "account-1",
            "asset": { "id": "asset-1", "symbol": "AAPL", "exchangeMic": "XNAS" },
            "activityType": "BUY",
            "activityDate": "2024-01-15",
            "currency": "USD"
        });
        let parsed_create: NewActivity = serde_json::from_value(create_with_asset).unwrap();
        assert_eq!(
            parsed_create
                .asset
                .as_ref()
                .and_then(|asset| asset.id.as_deref()),
            Some("asset-1")
        );
        assert_eq!(parsed_create.get_symbol_code(), Some("AAPL"));
        assert_eq!(parsed_create.get_exchange_mic(), Some("XNAS"));

        let update_with_legacy_symbol = json!({
            "id": "activity-1",
            "accountId": "account-1",
            "symbol": { "id": "asset-2", "symbol": "MSFT", "exchangeMic": "XNAS" },
            "activityType": "BUY",
            "activityDate": "2024-01-15",
            "currency": "USD"
        });
        let parsed_update: ActivityUpdate =
            serde_json::from_value(update_with_legacy_symbol).unwrap();
        assert_eq!(
            parsed_update
                .asset
                .as_ref()
                .and_then(|asset| asset.id.as_deref()),
            Some("asset-2")
        );
        assert_eq!(parsed_update.get_symbol_code(), Some("MSFT"));
        assert_eq!(parsed_update.get_exchange_mic(), Some("XNAS"));
    }

    #[test]
    fn test_new_activity_deserializes_scientific_and_empty() {
        let input = json!({
            "accountId": "account-1",
            "activityType": "DEPOSIT",
            "activityDate": "2024-01-15",
            "currency": "USD",
            "amount": "9.7e-7",
            "fee": ""
        });

        let parsed: NewActivity = serde_json::from_value(input).unwrap();
        assert_eq!(
            parsed.amount,
            Some(Decimal::from_scientific("9.7e-7").unwrap())
        );
        assert_eq!(parsed.fee, None);
    }

    // ============================================================================
    // ActivityType Enum Tests
    // ============================================================================

    #[test]
    fn test_activity_type_credit_as_str() {
        use crate::activities::activities_constants::ACTIVITY_TYPE_CREDIT;
        let activity_type = ActivityType::Credit;
        assert_eq!(activity_type.as_str(), ACTIVITY_TYPE_CREDIT);
    }

    #[test]
    fn test_activity_type_unknown_as_str() {
        use crate::activities::activities_constants::ACTIVITY_TYPE_UNKNOWN;
        let activity_type = ActivityType::Unknown;
        assert_eq!(activity_type.as_str(), ACTIVITY_TYPE_UNKNOWN);
    }

    #[test]
    fn test_activity_type_from_str_credit() {
        use std::str::FromStr;
        let activity_type = ActivityType::from_str("CREDIT").unwrap();
        assert_eq!(activity_type, ActivityType::Credit);
    }

    #[test]
    fn test_activity_type_from_str_unknown() {
        use std::str::FromStr;
        let activity_type = ActivityType::from_str("UNKNOWN").unwrap();
        assert_eq!(activity_type, ActivityType::Unknown);
    }

    #[test]
    fn test_activity_type_from_str_invalid() {
        use std::str::FromStr;
        let result = ActivityType::from_str("INVALID_TYPE");
        assert!(result.is_err());
    }

    // ============================================================================
    // Activity Serialization Tests
    // ============================================================================

    #[test]
    fn test_activity_serialization_camel_case() {
        let activity = create_test_activity();
        let json = serde_json::to_string(&activity).unwrap();

        // Check that field names are camelCase
        assert!(json.contains("accountId"));
        assert!(json.contains("assetId"));
        assert!(json.contains("activityType"));
        assert!(json.contains("activityDate"));
        assert!(json.contains("unitPrice"));
        assert!(json.contains("fxRate"));
        assert!(json.contains("createdAt"));
        assert!(json.contains("updatedAt"));
        assert!(json.contains("sourceSystem"));
        assert!(json.contains("sourceRecordId"));
        assert!(json.contains("isUserModified"));
        assert!(json.contains("needsReview"));
    }

    #[test]
    fn test_activity_deserialization() {
        let json = r#"{
            "id": "test-123",
            "accountId": "acc-1",
            "assetId": "AAPL",
            "activityType": "BUY",
            "activityTypeOverride": null,
            "sourceType": null,
            "subtype": null,
            "status": "POSTED",
            "activityDate": "2024-01-15T10:30:00Z",
            "settlementDate": null,
            "quantity": "10",
            "unitPrice": "150.50",
            "amount": "1505",
            "fee": "5.99",
            "currency": "USD",
            "fxRate": null,
            "notes": null,
            "metadata": null,
            "sourceSystem": "MANUAL",
            "sourceRecordId": null,
            "sourceGroupId": null,
            "idempotencyKey": null,
            "importRunId": null,
            "isUserModified": false,
            "needsReview": false,
            "createdAt": "2024-01-15T10:30:00Z",
            "updatedAt": "2024-01-15T10:30:00Z"
        }"#;

        let activity: Activity = serde_json::from_str(json).unwrap();
        assert_eq!(activity.id, "test-123");
        assert_eq!(activity.account_id, "acc-1");
        assert_eq!(activity.asset_id, Some("AAPL".to_string()));
        assert_eq!(activity.activity_type, "BUY");
        assert_eq!(activity.status, ActivityStatus::Posted);
        assert_eq!(activity.source_system, Some("MANUAL".to_string()));
        assert!(!activity.is_user_modified);
        assert!(!activity.needs_review);
    }

    #[test]
    fn test_activity_deserialization_with_null_asset_id() {
        let json = r#"{
            "id": "test-123",
            "accountId": "acc-1",
            "assetId": null,
            "activityType": "DEPOSIT",
            "status": "POSTED",
            "activityDate": "2024-01-15T10:30:00Z",
            "quantity": null,
            "unitPrice": null,
            "amount": "1000",
            "fee": null,
            "currency": "USD",
            "isUserModified": false,
            "needsReview": false,
            "createdAt": "2024-01-15T10:30:00Z",
            "updatedAt": "2024-01-15T10:30:00Z"
        }"#;

        let activity: Activity = serde_json::from_str(json).unwrap();
        assert!(activity.asset_id.is_none());
        assert_eq!(activity.activity_type, "DEPOSIT");
    }

    #[test]
    fn test_new_activity_symbol_helpers() {
        let activity = NewActivity {
            id: Some("a1".to_string()),
            account_id: "acc-1".to_string(),
            asset: Some(AssetResolutionInput {
                symbol: Some("AZN".to_string()),
                exchange_mic: Some("XLON".to_string()),
                quote_ccy: Some("GBp".to_string()),
                instrument_type: Some("EQUITY".to_string()),
                ..Default::default()
            }),
            activity_type: "BUY".to_string(),
            subtype: None,
            activity_date: "2024-01-15".to_string(),
            quantity: Some(dec!(1)),
            unit_price: Some(dec!(1)),
            currency: "GBP".to_string(),
            fee: Some(dec!(0)),
            tax: None,
            amount: Some(dec!(1)),
            status: None,
            notes: None,
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
            import_run_id: None,
        };

        assert_eq!(activity.get_quote_ccy(), Some("GBp"));
        assert_eq!(activity.get_instrument_type(), Some("EQUITY"));
    }

    #[test]
    fn test_activity_import_to_new_activity_preserves_asset_resolution_inputs() {
        let import = ActivityImport {
            id: Some("imp-1".to_string()),
            date: "2024-01-15".to_string(),
            symbol: "AZN".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(10)),
            unit_price: Some(dec!(120)),
            currency: "GBP".to_string(),
            fee: Some(dec!(0)),
            tax: None,
            amount: Some(dec!(1200)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: Some("AstraZeneca PLC".to_string()),
            exchange_mic: Some("XLON".to_string()),
            quote_ccy: Some("GBp".to_string()),
            instrument_type: Some("EQUITY".to_string()),
            quote_mode: Some("MANUAL".to_string()),
            provider_id: Some("YAHOO".to_string()),
            provider_symbol: Some("AZN.L".to_string()),
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: None,
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: None,
        };

        let converted = NewActivity::from(import);
        let asset = converted.asset.expect("asset should be present");
        assert_eq!(asset.quote_ccy.as_deref(), Some("GBp"));
        assert_eq!(asset.instrument_type.as_deref(), Some("EQUITY"));
        assert_eq!(asset.exchange_mic.as_deref(), Some("XLON"));
        assert_eq!(asset.quote_mode.as_deref(), Some("MANUAL"));
        assert_eq!(asset.provider_id.as_deref(), Some("YAHOO"));
        assert_eq!(asset.provider_symbol.as_deref(), Some("AZN.L"));
    }

    #[test]
    fn test_activity_import_to_new_activity_persists_external_flow_metadata() {
        // Regression: issue #927 — external transfer from CSV import was losing the
        // `is_external` flag because `From<ActivityImport>` hard-coded `metadata: None`.
        let import = ActivityImport {
            id: None,
            date: "2024-01-15".to_string(),
            symbol: "AAPL".to_string(),
            activity_type: "TRANSFER_IN".to_string(),
            quantity: Some(dec!(10)),
            unit_price: Some(dec!(150)),
            currency: "USD".to_string(),
            fee: None,
            tax: None,
            amount: None,
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: None,
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: Some(true),
        };

        let converted = NewActivity::from(import);
        let metadata = converted.metadata.expect("metadata should be set");
        let parsed: serde_json::Value = serde_json::from_str(&metadata).unwrap();
        assert_eq!(parsed["flow"]["is_external"], serde_json::Value::Bool(true));
    }

    #[test]
    fn test_activity_import_to_new_activity_omits_metadata_when_not_external() {
        let import = ActivityImport {
            id: None,
            date: "2024-01-15".to_string(),
            symbol: "AAPL".to_string(),
            activity_type: "TRANSFER_IN".to_string(),
            quantity: Some(dec!(10)),
            unit_price: Some(dec!(150)),
            currency: "USD".to_string(),
            fee: None,
            tax: None,
            amount: None,
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: None,
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: Some(false),
        };

        assert!(NewActivity::from(import).metadata.is_none());
    }

    #[test]
    fn test_activity_import_to_new_activity_ignores_external_flag_for_non_transfers() {
        let import = ActivityImport {
            id: None,
            date: "2024-01-15".to_string(),
            symbol: "AAPL".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(10)),
            unit_price: Some(dec!(150)),
            currency: "USD".to_string(),
            fee: None,
            tax: None,
            amount: None,
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: None,
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: Some(true),
        };

        assert!(NewActivity::from(import).metadata.is_none());
    }
}
