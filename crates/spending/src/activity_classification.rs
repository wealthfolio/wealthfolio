use std::collections::{HashMap, HashSet};

use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use wealthfolio_core::accounts::account_types;
use wealthfolio_core::activities::Activity;
use wealthfolio_core::portfolio::economic_events::ActivityEconomicsResolver;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SpendingClassification {
    Income,
    Expense,
    ExpenseRefund,
    /// Money moved out to investing/savings — its own bucket, parallel to
    /// `Income`. Excluded from `spending_amount`; surfaced via `saving_amount`.
    Saving,
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

    /// Saving amount — mirrors `income_amount`. Non-zero only for `Saving`, so
    /// it never overlaps `spending_amount`/`income_amount`.
    pub(crate) fn saving_amount(self, amount: Decimal) -> Decimal {
        match self {
            Self::Saving => amount,
            _ => Decimal::ZERO,
        }
    }
}

/// Source-group ids whose transfer has BOTH legs inside the spending-account
/// context (count >= 2 among `acts`). These are internal moves between two
/// spending accounts — neutral, neither spending nor saving — so aggregation
/// skips them to avoid double-counting an outflow against a matching inflow.
///
/// Callers should pass the full configured spending-account context, not just
/// the report window, otherwise a transfer whose legs cross a date boundary can
/// be misread as a cross-boundary savings move.
pub(crate) fn within_spending_transfer_groups(acts: &[&Activity]) -> HashSet<String> {
    let mut counts: HashMap<&str, u32> = HashMap::new();
    for a in acts {
        if matches!(a.effective_type(), "TRANSFER_IN" | "TRANSFER_OUT") {
            if let Some(group) = a.source_group_id.as_deref() {
                *counts.entry(group).or_insert(0) += 1;
            }
        }
    }
    counts
        .into_iter()
        .filter(|(_, count)| *count >= 2)
        .map(|(group, _)| group.to_string())
        .collect()
}

/// Classify for spending TOTALS, with knowledge of which transfer groups are
/// fully within the spending set. A linked transfer that *crosses out* of the
/// spending world (counterpart is a non-spending/investing account → only one
/// leg in the full spending context) classifies its CASH `TRANSFER_OUT` leg as
/// `Saving` — its own bucket, like income. The inbound leg and all
/// within-spending transfers stay neutral. Unlinked transfer-outs fall through
/// to the plain classifier and can still be Spending.
pub(crate) fn classify_activity_for_aggregation(
    activity: &Activity,
    account_type: &str,
    within_spending_groups: &HashSet<String>,
) -> SpendingClassification {
    let activity_type = activity.effective_type();
    if matches!(activity_type, "TRANSFER_IN" | "TRANSFER_OUT") {
        if let Some(group) = activity.source_group_id.as_deref() {
            if within_spending_groups.contains(group) {
                return SpendingClassification::InternalTransfer;
            }
            return match (account_type, activity_type) {
                (account_types::CASH, "TRANSFER_OUT") => SpendingClassification::Saving,
                _ => SpendingClassification::InternalTransfer,
            };
        }
    }
    classify_activity(activity, account_type)
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
            "CREDIT"
                if matches!(
                    activity.subtype.as_deref(),
                    Some("REFUND") | Some("REBATE") | Some("REIMBURSEMENT")
                ) =>
            {
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

/// Signed cash movement for one row, in its own currency. Positive is money
/// entering the account, negative money leaving.
///
/// Delegates to the resolver the holdings engine uses to build account cash
/// balances, rather than mapping activity types to signs a second time here:
/// that keeps this list in agreement with the account page by construction, and
/// picks up the cases a hand-rolled table gets wrong — credit-card interest is a
/// charge rather than income, and a row that is not posted has not moved money
/// at all.
pub(crate) fn net_amount(activity: &Activity, account_types: &HashMap<String, String>) -> Decimal {
    if !activity.is_posted() {
        return Decimal::ZERO;
    }
    let is_credit_card = account_types
        .get(&activity.account_id)
        .is_some_and(|account_type| account_type == account_types::CREDIT_CARD);
    ActivityEconomicsResolver::resolve_cash_with_account_context(
        activity,
        Decimal::ONE,
        is_credit_card,
    )
    .signed_cash_effect
    .unwrap_or(Decimal::ZERO)
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use proptest::prelude::*;
    use rust_decimal::Decimal;
    use serde::Deserialize;
    use serde_json::Value;
    use std::str::FromStr;
    use wealthfolio_core::activities::{Activity, ActivityStatus};

    use super::*;

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct AccountingContract {
        cases: Vec<AccountingContractCase>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct AccountingContractCase {
        name: String,
        account_type: String,
        activity_type: String,
        subtype: Option<String>,
        amount: String,
        expected: AccountingContractExpected,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct AccountingContractExpected {
        spending_delta: Option<String>,
        income_delta: Option<String>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct LedgerContract {
        scenarios: Vec<LedgerScenario>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct LedgerScenario {
        name: String,
        account_type: String,
        activities: Vec<LedgerActivity>,
        expected: LedgerExpected,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct LedgerActivity {
        activity_type: String,
        subtype: Option<String>,
        amount: String,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct LedgerExpected {
        net_spending: String,
        income: String,
    }

    fn accounting_contract() -> AccountingContract {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/fixtures/accounting/activity_semantics.json"
        )))
        .expect("accounting activity contract should be valid JSON")
    }

    fn ledger_contract() -> LedgerContract {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/fixtures/accounting/ledger_scenarios.json"
        )))
        .expect("accounting ledger contract should be valid JSON")
    }

    fn decimal(value: &str) -> Decimal {
        Decimal::from_str(value).expect("accounting contract decimal should be valid")
    }

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
            tax: None,
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
    fn accounting_contract_reconciles_spending_and_income_semantics() {
        for case in accounting_contract().cases {
            let (Some(expected_spending), Some(expected_income)) = (
                case.expected.spending_delta.as_deref(),
                case.expected.income_delta.as_deref(),
            ) else {
                continue;
            };
            let amount = decimal(&case.amount);
            let activity =
                activity_with_subtype(&case.activity_type, case.subtype.as_deref(), None);
            let classification = classify_activity(&activity, &case.account_type);

            assert_eq!(
                classification.spending_amount(amount),
                decimal(expected_spending),
                "accounting contract spending case: {}",
                case.name
            );
            assert_eq!(
                classification.income_amount(amount),
                decimal(expected_income),
                "accounting contract income case: {}",
                case.name
            );
        }
    }

    #[test]
    fn ledger_contract_reconciles_spending_and_income_totals() {
        for scenario in ledger_contract().scenarios {
            let mut spending = Decimal::ZERO;
            let mut income = Decimal::ZERO;

            for entry in scenario.activities {
                let amount = decimal(&entry.amount);
                let activity =
                    activity_with_subtype(&entry.activity_type, entry.subtype.as_deref(), None);
                let classification = classify_activity(&activity, &scenario.account_type);
                spending += classification.spending_amount(amount);
                income += classification.income_amount(amount);
            }

            assert_eq!(
                spending,
                decimal(&scenario.expected.net_spending),
                "accounting ledger spending scenario: {}",
                scenario.name
            );
            assert_eq!(
                income,
                decimal(&scenario.expected.income),
                "accounting ledger income scenario: {}",
                scenario.name
            );
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]

        #[test]
        fn purchase_refunds_reduce_spending_by_exactly_the_refunded_amount(
            purchase_minor in 1i64..10_000_000,
            refund_seed in 0i64..10_000_000,
        ) {
            let refund_minor = refund_seed % (purchase_minor + 1);
            let purchase = Decimal::new(purchase_minor, 2);
            let refund = Decimal::new(refund_minor, 2);
            let withdrawal = classify_activity(
                &activity("WITHDRAWAL", None),
                account_types::CASH,
            );
            let refund_credit = classify_activity(
                &activity_with_subtype("CREDIT", Some("REFUND"), None),
                account_types::CASH,
            );

            prop_assert_eq!(
                withdrawal.spending_amount(purchase)
                    + refund_credit.spending_amount(refund),
                purchase - refund
            );
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
                &activity_with_subtype("CREDIT", Some("REIMBURSEMENT"), None),
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
    fn cross_boundary_transfer_out_is_saving_not_spending() {
        // Spending → investing: only the OUT leg is in the spending set (1 leg),
        // so it classifies as Saving (its own bucket, like income) — and crucially
        // contributes ZERO to spending_amount so it never inflates "spent".
        let out = activity("TRANSFER_OUT", Some("pair-x"));
        let within = within_spending_transfer_groups(&[&out]);
        assert!(
            within.is_empty(),
            "single leg is not a within-spending group"
        );
        let c = classify_activity_for_aggregation(&out, account_types::CASH, &within);
        assert_eq!(c, SpendingClassification::Saving);
        assert_eq!(c.saving_amount(Decimal::new(100, 0)), Decimal::new(100, 0));
        assert_eq!(c.spending_amount(Decimal::new(100, 0)), Decimal::ZERO);
        assert_eq!(c.income_amount(Decimal::new(100, 0)), Decimal::ZERO);
        // The inbound leg of a cross-boundary transfer stays neutral.
        let inn = activity("TRANSFER_IN", Some("pair-y"));
        let within_in = within_spending_transfer_groups(&[&inn]);
        assert_eq!(
            classify_activity_for_aggregation(&inn, account_types::CASH, &within_in),
            SpendingClassification::InternalTransfer
        );
    }

    #[test]
    fn unlinked_cash_transfer_out_counts_as_spending() {
        let c = classify_activity(&activity("TRANSFER_OUT", None), account_types::CASH);
        assert_eq!(c, SpendingClassification::Expense);
        assert_eq!(
            c.spending_amount(Decimal::new(100, 0)),
            Decimal::new(100, 0)
        );
    }

    #[test]
    fn full_context_keeps_window_split_spending_transfer_neutral() {
        let out = activity("TRANSFER_OUT", Some("pair-window"));
        let inn = activity("TRANSFER_IN", Some("pair-window"));
        let full_context = within_spending_transfer_groups(&[&out, &inn]);
        assert!(full_context.contains("pair-window"));

        let c = classify_activity_for_aggregation(&out, account_types::CASH, &full_context);
        assert_eq!(c, SpendingClassification::InternalTransfer);
        assert_eq!(c.saving_amount(Decimal::new(100, 0)), Decimal::ZERO);
        assert_eq!(c.spending_amount(Decimal::new(100, 0)), Decimal::ZERO);
    }

    #[test]
    fn credit_card_transfer_out_is_never_spending() {
        // A card's TRANSFER_OUT is money moved, not bought: a balance transfer,
        // a cash advance, a wallet top-up. Unlinked it is Ignored, like a
        // card's payment in; linked out of the spending set it is still not a
        // CASH saving (#1227).
        assert_eq!(
            classify_activity(&activity("TRANSFER_OUT", None), account_types::CREDIT_CARD),
            SpendingClassification::Ignored
        );
        let out = activity("TRANSFER_OUT", Some("pair-card"));
        let within = within_spending_transfer_groups(&[&out]);
        assert_eq!(
            classify_activity_for_aggregation(&out, account_types::CREDIT_CARD, &within),
            SpendingClassification::InternalTransfer
        );
    }

    #[test]
    fn within_spending_transfers_stay_neutral() {
        // Both legs on spending accounts (same group, 2 legs) → neutral.
        let out = activity("TRANSFER_OUT", Some("pair-z"));
        let inn = activity("TRANSFER_IN", Some("pair-z"));
        let within = within_spending_transfer_groups(&[&out, &inn]);
        assert!(within.contains("pair-z"));
        let c = classify_activity_for_aggregation(&out, account_types::CASH, &within);
        assert_eq!(c, SpendingClassification::InternalTransfer);
        assert_eq!(c.saving_amount(Decimal::new(100, 0)), Decimal::ZERO);
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
