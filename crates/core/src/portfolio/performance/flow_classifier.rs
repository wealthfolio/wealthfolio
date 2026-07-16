//! Flow classification for performance calculation.
//!
//! This module classifies activities as external or internal flows for TWR calculation.
//! Only external flows (money crossing the portfolio boundary) affect TWR.

use crate::activities::{
    Activity, ACTIVITY_SUBTYPE_BONUS, ACTIVITY_TYPE_CREDIT, ACTIVITY_TYPE_DEPOSIT,
    ACTIVITY_TYPE_TRANSFER_IN, ACTIVITY_TYPE_TRANSFER_OUT, ACTIVITY_TYPE_WITHDRAWAL,
};
use crate::portfolio::economic_events::TransferBoundary;
use chrono::NaiveDate;
use rust_decimal::Decimal;
use std::collections::HashSet;

fn transfer_match_tolerance() -> Decimal {
    Decimal::new(1, 6)
}

pub fn is_external_transfer(activity: &Activity) -> bool {
    activity
        .metadata
        .as_ref()
        .and_then(|m| m.get("flow"))
        .and_then(|flow| flow.get("is_external"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// Flow type for performance calculation
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlowType {
    /// External flow - money crossing portfolio boundary
    /// Affects TWR calculation, counts as contribution/withdrawal
    External,

    /// Internal flow - money moving within portfolio
    /// Does not affect TWR calculation
    Internal,
}

/// Boundary scope for flow classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PerformanceScope {
    /// Portfolio boundary (external means outside the portfolio)
    Portfolio,
    /// Account boundary (external means outside the account)
    Account,
}

/// Classify flow for performance by scope.
///
/// External flows:
/// - DEPOSIT, WITHDRAWAL (money entering/leaving portfolio)
/// - CREDIT with subtype BONUS (promotional credits = new money)
///
/// Internal flows:
/// - BUY, SELL, DIVIDEND, INTEREST, SPLIT (asset reallocation)
/// - TRANSFER_IN, TRANSFER_OUT (money moving between accounts)
/// - FEE, TAX (deductions from existing money)
/// - CREDIT with other subtypes (REBATE, REFUND = not new money)
pub fn classify_flow_for_scope(activity: &Activity, scope: PerformanceScope) -> FlowType {
    let effective_type = activity.effective_type();

    // External flows - money crossing portfolio boundary
    if effective_type == ACTIVITY_TYPE_DEPOSIT || effective_type == ACTIVITY_TYPE_WITHDRAWAL {
        return FlowType::External;
    }

    // CREDIT: depends on subtype
    if effective_type == ACTIVITY_TYPE_CREDIT {
        return match activity.subtype.as_deref() {
            // BONUS is external (new money entering portfolio)
            Some(subtype) if subtype.eq_ignore_ascii_case(ACTIVITY_SUBTYPE_BONUS) => {
                FlowType::External
            }
            // REBATE, REFUND, and other subtypes are internal
            // (corrections/refunds of existing transactions, not new money)
            _ => FlowType::Internal,
        };
    }

    // TRANSFER_*: can be external when explicitly marked as portfolio-boundary flow.
    if effective_type == ACTIVITY_TYPE_TRANSFER_IN || effective_type == ACTIVITY_TYPE_TRANSFER_OUT {
        return match scope {
            PerformanceScope::Portfolio => {
                if is_external_transfer(activity) {
                    FlowType::External
                } else {
                    FlowType::Internal
                }
            }
            PerformanceScope::Account => FlowType::External,
        };
    }

    // Everything else is internal
    // BUY, SELL, DIVIDEND, INTEREST, TRANSFER_*, FEE, TAX, SPLIT, ADJUSTMENT
    FlowType::Internal
}

pub fn classify_transfer_for_account_scope(
    activity: &Activity,
    scope_account_ids: &HashSet<String>,
    paired_account_id: Option<&str>,
) -> FlowType {
    match classify_transfer_boundary_for_account_scope(
        activity,
        scope_account_ids,
        paired_account_id,
    ) {
        TransferBoundary::Internal => FlowType::Internal,
        TransferBoundary::External | TransferBoundary::Unknown => FlowType::External,
    }
}

pub fn classify_transfer_boundary_for_account_scope(
    activity: &Activity,
    scope_account_ids: &HashSet<String>,
    paired_account_id: Option<&str>,
) -> TransferBoundary {
    let effective_type = activity.effective_type();
    if effective_type != ACTIVITY_TYPE_TRANSFER_IN && effective_type != ACTIVITY_TYPE_TRANSFER_OUT {
        return match classify_flow_for_scope(activity, PerformanceScope::Portfolio) {
            FlowType::External => TransferBoundary::External,
            FlowType::Internal => TransferBoundary::Internal,
        };
    }

    let current_inside = scope_account_ids.contains(&activity.account_id);
    if let Some(paired_account_id) = paired_account_id {
        let paired_inside = scope_account_ids.contains(paired_account_id);

        return match (current_inside, paired_inside) {
            (true, true) | (false, false) => TransferBoundary::Internal,
            (true, false) | (false, true) => TransferBoundary::External,
        };
    }

    if is_external_transfer(activity) {
        TransferBoundary::External
    } else {
        TransferBoundary::Unknown
    }
}

fn opposite_transfer_type(activity_type: &str) -> Option<&'static str> {
    match activity_type {
        ACTIVITY_TYPE_TRANSFER_IN => Some(ACTIVITY_TYPE_TRANSFER_OUT),
        ACTIVITY_TYPE_TRANSFER_OUT => Some(ACTIVITY_TYPE_TRANSFER_IN),
        _ => None,
    }
}

fn transfer_amount(activity: &Activity) -> Option<Decimal> {
    activity
        .amount
        .or_else(|| Some(activity.quantity? * activity.unit_price?))
        .map(|amount| amount.abs())
}

fn decimal_matches(left: Option<Decimal>, right: Option<Decimal>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => (left - right).abs() <= transfer_match_tolerance(),
        (None, None) => true,
        _ => false,
    }
}

fn transfer_match(activity: &Activity, candidate: &Activity) -> bool {
    if activity.id == candidate.id {
        return false;
    }

    let effective_type = activity.effective_type();
    let candidate_type = candidate.effective_type();
    if Some(candidate_type) != opposite_transfer_type(effective_type) {
        return false;
    }

    let activity_asset_id = activity.asset_id.as_deref().unwrap_or("").trim();
    let candidate_asset_id = candidate.asset_id.as_deref().unwrap_or("").trim();
    let has_asset = !activity_asset_id.is_empty() || !candidate_asset_id.is_empty();

    if has_asset {
        activity_asset_id == candidate_asset_id
            && decimal_matches(activity.quantity, candidate.quantity)
            && decimal_matches(transfer_amount(activity), transfer_amount(candidate))
    } else {
        activity.currency == candidate.currency
            && decimal_matches(transfer_amount(activity), transfer_amount(candidate))
    }
}

pub fn infer_paired_transfer_account_id<F>(
    activity: &Activity,
    candidates: &[Activity],
    mut activity_local_date: F,
) -> Option<String>
where
    F: FnMut(&Activity) -> NaiveDate,
{
    let effective_type = activity.effective_type();
    let opposite_type = opposite_transfer_type(effective_type)?;

    if let Some(group_id) = activity.source_group_id.as_deref() {
        let mut grouped_matches = candidates.iter().filter(|candidate| {
            candidate.id != activity.id
                && candidate.source_group_id.as_deref() == Some(group_id)
                && candidate.effective_type() == opposite_type
        });
        let first = grouped_matches.next()?;
        if grouped_matches.next().is_none() {
            return Some(first.account_id.clone());
        }
    }

    let activity_date = activity_local_date(activity);
    let mut matches = candidates.iter().filter(|candidate| {
        activity_local_date(candidate) == activity_date && transfer_match(activity, candidate)
    });
    if let Some(first) = matches.next() {
        return if matches.next().is_none() {
            Some(first.account_id.clone())
        } else {
            None
        };
    }

    None
}

/// Classify flow for portfolio-level performance.
pub fn classify_flow(activity: &Activity) -> FlowType {
    classify_flow_for_scope(activity, PerformanceScope::Portfolio)
}

/// Check if an activity is an external flow for portfolio-level calculation
pub fn is_external_flow(activity: &Activity) -> bool {
    classify_flow(activity) == FlowType::External
}

/// Check if an activity is an external flow for a given scope
pub fn is_external_flow_for_scope(activity: &Activity, scope: PerformanceScope) -> bool {
    classify_flow_for_scope(activity, scope) == FlowType::External
}

/// Check if an activity affects net contribution
pub fn affects_net_contribution(activity: &Activity) -> bool {
    is_external_flow(activity)
}

/// Check if an activity affects net contribution for a given scope
pub fn affects_net_contribution_for_scope(activity: &Activity, scope: PerformanceScope) -> bool {
    is_external_flow_for_scope(activity, scope)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activities::ActivityStatus;
    use chrono::{TimeZone, Utc};
    use serde_json::json;

    fn create_test_activity(activity_type: &str) -> Activity {
        Activity {
            id: "test-1".to_string(),
            account_id: "account-1".to_string(),
            asset_id: None,
            activity_type: activity_type.to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: None,
            status: ActivityStatus::Posted,
            activity_date: Utc::now(),
            settlement_date: None,
            quantity: None,
            unit_price: None,
            amount: Some(rust_decimal::Decimal::from(100)),
            fee: None,
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

    fn account_scope(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    fn local_date(activity: &Activity) -> NaiveDate {
        activity.activity_date.date_naive()
    }

    // External flow tests
    #[test]
    fn test_deposit_is_external() {
        let activity = create_test_activity("DEPOSIT");
        assert_eq!(classify_flow(&activity), FlowType::External);
    }

    #[test]
    fn test_withdrawal_is_external() {
        let activity = create_test_activity("WITHDRAWAL");
        assert_eq!(classify_flow(&activity), FlowType::External);
    }

    #[test]
    fn test_credit_bonus_is_external() {
        let mut activity = create_test_activity("CREDIT");
        activity.subtype = Some("BONUS".to_string());
        assert_eq!(classify_flow(&activity), FlowType::External);
    }

    #[test]
    fn test_credit_bonus_subtype_is_case_insensitive() {
        let mut activity = create_test_activity("CREDIT");
        activity.subtype = Some("bonus".to_string());
        assert_eq!(classify_flow(&activity), FlowType::External);
    }

    // Internal flow tests
    #[test]
    fn test_buy_is_internal() {
        let activity = create_test_activity("BUY");
        assert_eq!(classify_flow(&activity), FlowType::Internal);
    }

    #[test]
    fn test_sell_is_internal() {
        let activity = create_test_activity("SELL");
        assert_eq!(classify_flow(&activity), FlowType::Internal);
    }

    #[test]
    fn test_dividend_is_internal() {
        let activity = create_test_activity("DIVIDEND");
        assert_eq!(classify_flow(&activity), FlowType::Internal);
    }

    #[test]
    fn test_interest_is_internal() {
        let activity = create_test_activity("INTEREST");
        assert_eq!(classify_flow(&activity), FlowType::Internal);
    }

    #[test]
    fn test_transfer_in_is_internal_for_portfolio() {
        let activity = create_test_activity("TRANSFER_IN");
        assert_eq!(classify_flow(&activity), FlowType::Internal);
    }

    #[test]
    fn test_transfer_out_is_internal_for_portfolio() {
        let activity = create_test_activity("TRANSFER_OUT");
        assert_eq!(classify_flow(&activity), FlowType::Internal);
    }

    #[test]
    fn test_transfer_in_is_external_for_account_scope() {
        let activity = create_test_activity("TRANSFER_IN");
        assert_eq!(
            classify_flow_for_scope(&activity, PerformanceScope::Account),
            FlowType::External
        );
    }

    #[test]
    fn test_transfer_out_is_external_for_account_scope() {
        let activity = create_test_activity("TRANSFER_OUT");
        assert_eq!(
            classify_flow_for_scope(&activity, PerformanceScope::Account),
            FlowType::External
        );
    }

    #[test]
    fn cash_transfer_inside_account_scope_is_internal() {
        let activity = create_test_activity("TRANSFER_OUT");
        let scope = account_scope(&["account-1", "account-2"]);
        assert_eq!(
            classify_transfer_for_account_scope(&activity, &scope, Some("account-2")),
            FlowType::Internal
        );
    }

    #[test]
    fn security_transfer_inside_account_scope_is_internal() {
        let mut activity = create_test_activity("TRANSFER_IN");
        activity.asset_id = Some("SEC:AAPL".to_string());
        activity.quantity = Some(rust_decimal::Decimal::ONE);
        let scope = account_scope(&["account-1", "account-2"]);
        assert_eq!(
            classify_transfer_for_account_scope(&activity, &scope, Some("account-2")),
            FlowType::Internal
        );
    }

    #[test]
    fn transfer_crossing_account_scope_boundary_is_external() {
        let activity = create_test_activity("TRANSFER_IN");
        let scope = account_scope(&["account-1"]);
        assert_eq!(
            classify_transfer_for_account_scope(&activity, &scope, Some("account-2")),
            FlowType::External
        );
    }

    #[test]
    fn unpaired_transfer_inside_scope_defaults_external() {
        let activity = create_test_activity("TRANSFER_IN");
        let scope = account_scope(&["account-1"]);
        assert_eq!(
            classify_transfer_for_account_scope(&activity, &scope, None),
            FlowType::External
        );
    }

    #[test]
    fn unpaired_transfer_without_external_metadata_has_unknown_boundary() {
        let activity = create_test_activity("TRANSFER_IN");
        let scope = account_scope(&["account-1"]);
        assert_eq!(
            classify_transfer_boundary_for_account_scope(&activity, &scope, None),
            TransferBoundary::Unknown
        );
    }

    #[test]
    fn paired_transfer_overrides_stale_external_metadata() {
        let mut activity = create_test_activity("TRANSFER_OUT");
        activity.metadata = Some(json!({ "flow": { "is_external": true } }));
        let scope = account_scope(&["account-1", "account-2"]);
        assert_eq!(
            classify_transfer_for_account_scope(&activity, &scope, Some("account-2")),
            FlowType::Internal
        );
    }

    #[test]
    fn unpaired_external_metadata_marks_transfer_external() {
        let mut activity = create_test_activity("TRANSFER_OUT");
        activity.metadata = Some(json!({ "flow": { "is_external": true } }));
        let scope = account_scope(&["account-1", "account-2"]);
        assert_eq!(
            classify_transfer_for_account_scope(&activity, &scope, None),
            FlowType::External
        );
    }

    #[test]
    fn paired_transfer_account_is_inferred_from_source_group() {
        let mut transfer_out = create_test_activity("TRANSFER_OUT");
        transfer_out.id = "out".to_string();
        transfer_out.source_group_id = Some("group-1".to_string());

        let mut transfer_in = create_test_activity("TRANSFER_IN");
        transfer_in.id = "in".to_string();
        transfer_in.account_id = "account-2".to_string();
        transfer_in.source_group_id = Some("group-1".to_string());

        let candidates = vec![transfer_out.clone(), transfer_in];

        assert_eq!(
            infer_paired_transfer_account_id(&transfer_out, &candidates, local_date),
            Some("account-2".to_string())
        );
    }

    #[test]
    fn unique_unlinked_transfer_pair_is_inferred_by_date_currency_and_amount() {
        let mut transfer_out = create_test_activity("TRANSFER_OUT");
        transfer_out.id = "out".to_string();
        transfer_out.activity_date = Utc.with_ymd_and_hms(2026, 5, 2, 12, 0, 0).unwrap();
        transfer_out.amount = Some(rust_decimal::Decimal::from(250));

        let mut transfer_in = create_test_activity("TRANSFER_IN");
        transfer_in.id = "in".to_string();
        transfer_in.account_id = "account-2".to_string();
        transfer_in.activity_date = transfer_out.activity_date;
        transfer_in.amount = transfer_out.amount;

        let candidates = vec![transfer_out.clone(), transfer_in];

        assert_eq!(
            infer_paired_transfer_account_id(&transfer_out, &candidates, local_date),
            Some("account-2".to_string())
        );
    }

    #[test]
    fn unlinked_multi_currency_transfer_pair_is_not_inferred_without_reliable_match() {
        let mut transfer_out = create_test_activity("TRANSFER_OUT");
        transfer_out.id = "out".to_string();
        transfer_out.activity_date = Utc.with_ymd_and_hms(2026, 5, 2, 12, 0, 0).unwrap();
        transfer_out.currency = "CAD".to_string();
        transfer_out.amount = Some(rust_decimal::Decimal::from(140));

        let mut transfer_in = create_test_activity("TRANSFER_IN");
        transfer_in.id = "in".to_string();
        transfer_in.account_id = "account-2".to_string();
        transfer_in.activity_date = transfer_out.activity_date;
        transfer_in.currency = "USD".to_string();
        transfer_in.amount = Some(rust_decimal::Decimal::from(100));

        let candidates = vec![transfer_out.clone(), transfer_in];

        assert_eq!(
            infer_paired_transfer_account_id(&transfer_out, &candidates, local_date),
            None
        );
    }

    #[test]
    fn ambiguous_unlinked_transfer_pair_is_not_inferred() {
        let transfer_out = create_test_activity("TRANSFER_OUT");
        let mut transfer_in_a = create_test_activity("TRANSFER_IN");
        transfer_in_a.id = "in-a".to_string();
        transfer_in_a.account_id = "account-2".to_string();
        let mut transfer_in_b = transfer_in_a.clone();
        transfer_in_b.id = "in-b".to_string();
        transfer_in_b.account_id = "account-3".to_string();

        let candidates = vec![transfer_out.clone(), transfer_in_a, transfer_in_b];

        assert_eq!(
            infer_paired_transfer_account_id(&transfer_out, &candidates, local_date),
            None
        );
    }

    #[test]
    fn test_external_transfer_in_is_external_for_portfolio() {
        let mut activity = create_test_activity("TRANSFER_IN");
        activity.metadata = Some(serde_json::json!({
            "flow": { "is_external": true }
        }));
        assert_eq!(classify_flow(&activity), FlowType::External);
    }

    #[test]
    fn test_external_transfer_out_is_external_for_portfolio() {
        let mut activity = create_test_activity("TRANSFER_OUT");
        activity.metadata = Some(serde_json::json!({
            "flow": { "is_external": true }
        }));
        assert_eq!(classify_flow(&activity), FlowType::External);
    }

    #[test]
    fn test_fee_is_internal() {
        let activity = create_test_activity("FEE");
        assert_eq!(classify_flow(&activity), FlowType::Internal);
    }

    #[test]
    fn test_tax_is_internal() {
        let activity = create_test_activity("TAX");
        assert_eq!(classify_flow(&activity), FlowType::Internal);
    }

    // CREDIT subtype tests
    #[test]
    fn test_credit_fee_refund_is_internal() {
        let mut activity = create_test_activity("CREDIT");
        activity.subtype = Some("FEE_REFUND".to_string());
        assert_eq!(classify_flow(&activity), FlowType::Internal);
    }

    #[test]
    fn test_credit_tax_refund_is_internal() {
        let mut activity = create_test_activity("CREDIT");
        activity.subtype = Some("TAX_REFUND".to_string());
        assert_eq!(classify_flow(&activity), FlowType::Internal);
    }

    #[test]
    fn test_credit_rebate_is_internal() {
        let mut activity = create_test_activity("CREDIT");
        activity.subtype = Some("REBATE".to_string());
        assert_eq!(classify_flow(&activity), FlowType::Internal);
    }

    #[test]
    fn test_credit_adjustment_is_internal() {
        let mut activity = create_test_activity("CREDIT");
        activity.subtype = Some("ADJUSTMENT".to_string());
        assert_eq!(classify_flow(&activity), FlowType::Internal);
    }

    #[test]
    fn test_credit_no_subtype_is_internal() {
        let activity = create_test_activity("CREDIT");
        assert_eq!(classify_flow(&activity), FlowType::Internal);
    }

    // Override test
    #[test]
    fn test_respects_activity_type_override() {
        let mut activity = create_test_activity("UNKNOWN");
        activity.activity_type_override = Some("DEPOSIT".to_string());
        assert_eq!(classify_flow(&activity), FlowType::External);
    }

    // Helper function tests
    #[test]
    fn test_is_external_flow() {
        let deposit = create_test_activity("DEPOSIT");
        let buy = create_test_activity("BUY");

        assert!(is_external_flow(&deposit));
        assert!(!is_external_flow(&buy));
    }

    #[test]
    fn test_is_external_flow_for_scope() {
        let transfer_in = create_test_activity("TRANSFER_IN");
        assert!(!is_external_flow_for_scope(
            &transfer_in,
            PerformanceScope::Portfolio
        ));
        assert!(is_external_flow_for_scope(
            &transfer_in,
            PerformanceScope::Account
        ));
    }

    #[test]
    fn test_affects_net_contribution() {
        let deposit = create_test_activity("DEPOSIT");
        let dividend = create_test_activity("DIVIDEND");

        assert!(affects_net_contribution(&deposit));
        assert!(!affects_net_contribution(&dividend));
    }
}
