use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use wealthfolio_core::accounts::account_types;
use wealthfolio_core::activities::Activity;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SpendingClassification {
    Income,
    Expense,
    ExpenseRefund,
    InternalTransfer,
    Ignored,
}

impl SpendingClassification {
    pub(crate) fn income_amount(self, amount: Decimal) -> Decimal {
        match self {
            Self::Income => amount,
            _ => Decimal::ZERO,
        }
    }

    pub(crate) fn spending_amount(self, amount: Decimal) -> Decimal {
        match self {
            Self::Expense => amount,
            Self::ExpenseRefund => -amount,
            _ => Decimal::ZERO,
        }
    }
}

pub(crate) fn classify_activity(activity: &Activity, account_type: &str) -> SpendingClassification {
    let activity_type = activity.effective_type();

    if matches!(activity_type, "TRANSFER_IN" | "TRANSFER_OUT") && activity.source_group_id.is_some()
    {
        return SpendingClassification::InternalTransfer;
    }

    match account_type {
        account_types::CASH => match activity_type {
            "DEPOSIT" | "TRANSFER_IN" | "INTEREST" => SpendingClassification::Income,
            "WITHDRAWAL" | "TRANSFER_OUT" | "FEE" | "TAX" => SpendingClassification::Expense,
            "CREDIT" if activity.subtype.as_deref() == Some("BONUS") => {
                SpendingClassification::Income
            }
            "CREDIT" if matches!(activity.subtype.as_deref(), Some("REFUND") | Some("REBATE")) => {
                SpendingClassification::ExpenseRefund
            }
            "CREDIT" => SpendingClassification::Ignored,
            _ => SpendingClassification::Ignored,
        },
        account_types::CREDIT_CARD => match activity_type {
            "WITHDRAWAL" | "FEE" | "INTEREST" => SpendingClassification::Expense,
            "CREDIT" => SpendingClassification::ExpenseRefund,
            _ => SpendingClassification::Ignored,
        },
        _ => SpendingClassification::Ignored,
    }
}

pub(crate) fn activity_abs_amount(activity: &Activity) -> Decimal {
    activity.amount.map(|d| d.abs()).unwrap_or(Decimal::ZERO)
}

pub(crate) fn decimal_to_f64(amount: Decimal) -> f64 {
    amount.to_f64().unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use rust_decimal::Decimal;
    use serde_json::Value;
    use wealthfolio_core::activities::{Activity, ActivityStatus};

    use super::*;

    fn activity(activity_type: &str, source_group_id: Option<&str>) -> Activity {
        activity_with_subtype(activity_type, None, source_group_id)
    }

    fn activity_with_subtype(
        activity_type: &str,
        subtype: Option<&str>,
        source_group_id: Option<&str>,
    ) -> Activity {
        Activity {
            id: "activity-1".to_string(),
            account_id: "account-1".to_string(),
            asset_id: None,
            activity_type: activity_type.to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: subtype.map(str::to_string),
            status: ActivityStatus::Posted,
            activity_date: Utc::now(),
            settlement_date: None,
            quantity: None,
            unit_price: None,
            amount: Some(Decimal::new(100, 0)),
            fee: None,
            currency: "USD".to_string(),
            fx_rate: None,
            notes: None,
            metadata: None::<Value>,
            source_system: None,
            source_record_id: None,
            source_group_id: source_group_id.map(str::to_string),
            idempotency_key: None,
            import_run_id: None,
            is_user_modified: false,
            needs_review: false,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    #[test]
    fn credit_card_charges_count_as_expenses_and_payments_are_ignored() {
        assert_eq!(
            classify_activity(&activity("WITHDRAWAL", None), account_types::CREDIT_CARD),
            SpendingClassification::Expense
        );
        assert_eq!(
            classify_activity(&activity("FEE", None), account_types::CREDIT_CARD),
            SpendingClassification::Expense
        );
        assert_eq!(
            classify_activity(&activity("INTEREST", None), account_types::CREDIT_CARD),
            SpendingClassification::Expense
        );
        assert_eq!(
            classify_activity(&activity("TRANSFER_IN", None), account_types::CREDIT_CARD),
            SpendingClassification::Ignored
        );
    }

    #[test]
    fn credit_card_credit_reduces_spending() {
        let card_refund = classify_activity(&activity("CREDIT", None), account_types::CREDIT_CARD);

        assert_eq!(
            card_refund.spending_amount(Decimal::new(100, 0)),
            Decimal::new(-100, 0)
        );
    }

    #[test]
    fn cash_credit_uses_subtype_for_spending_semantics() {
        assert_eq!(
            classify_activity(&activity("CREDIT", None), account_types::CASH),
            SpendingClassification::Ignored
        );
        assert_eq!(
            classify_activity(
                &activity_with_subtype("CREDIT", Some("REFUND"), None),
                account_types::CASH
            )
            .spending_amount(Decimal::new(100, 0)),
            Decimal::new(-100, 0)
        );
        assert_eq!(
            classify_activity(
                &activity_with_subtype("CREDIT", Some("REBATE"), None),
                account_types::CASH
            )
            .spending_amount(Decimal::new(100, 0)),
            Decimal::new(-100, 0)
        );
        assert_eq!(
            classify_activity(
                &activity_with_subtype("CREDIT", Some("BONUS"), None),
                account_types::CASH
            )
            .income_amount(Decimal::new(100, 0)),
            Decimal::new(100, 0)
        );
    }

    #[test]
    fn cash_tax_counts_as_expense() {
        assert_eq!(
            classify_activity(&activity("TAX", None), account_types::CASH),
            SpendingClassification::Expense
        );
    }

    #[test]
    fn linked_transfers_are_internal_not_spending_or_income() {
        assert_eq!(
            classify_activity(
                &activity("TRANSFER_OUT", Some("pair-1")),
                account_types::CASH
            ),
            SpendingClassification::InternalTransfer
        );
        assert_eq!(
            classify_activity(
                &activity("TRANSFER_IN", Some("pair-1")),
                account_types::CREDIT_CARD
            ),
            SpendingClassification::InternalTransfer
        );
    }
}
