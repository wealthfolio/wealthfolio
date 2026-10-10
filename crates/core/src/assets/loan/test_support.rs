//! Builders shared by the loan tests.
use crate::activities::{Activity, ActivityStatus, ACTIVITY_TYPE_WITHDRAWAL};
use rust_decimal::Decimal;
use serde_json::Value;

/// A posted withdrawal of 130.00 CAD from "chequing" on 2026-03-01.
pub(super) fn withdrawal(metadata: Option<Value>) -> Activity {
    let now = chrono::Utc::now();
    Activity {
        destination_amount: None,
        destination_currency: None,
        id: "act".into(),
        account_id: "chequing".into(),
        asset_id: None,
        activity_type: ACTIVITY_TYPE_WITHDRAWAL.into(),
        activity_type_override: None,
        source_type: None,
        subtype: None,
        status: ActivityStatus::Posted,
        activity_date: "2026-03-01T15:00:00Z".parse().unwrap(),
        settlement_date: None,
        quantity: None,
        unit_price: None,
        amount: Some(Decimal::new(1_300, 1)),
        fee: None,
        tax: None,
        currency: "CAD".into(),
        fx_rate: None,
        notes: None,
        metadata,
        source_system: None,
        source_record_id: None,
        source_group_id: None,
        idempotency_key: None,
        import_run_id: None,
        is_user_modified: false,
        needs_review: false,
        created_at: now,
        updated_at: now,
    }
}
