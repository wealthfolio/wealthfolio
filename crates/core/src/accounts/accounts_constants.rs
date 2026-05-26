/// Default account type for new accounts
pub const DEFAULT_ACCOUNT_TYPE: &str = "SECURITIES";

/// Account type constants
pub mod account_types {
    pub const SECURITIES: &str = "SECURITIES";
    pub const CASH: &str = "CASH";
    pub const CREDIT_CARD: &str = "CREDIT_CARD";
    pub const CRYPTOCURRENCY: &str = "CRYPTOCURRENCY";
}

/// Product surfaces that decide account eligibility.
///
/// Keep account-type membership centralized here so adding a new account class
/// does not require updating every report and picker independently.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountPurpose {
    Spending,
    Performance,
    Holdings,
    Income,
    GoalFunding,
    ContributionLimits,
    NetWorth,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AccountCapabilities {
    pub spending: bool,
    pub performance: bool,
    pub holdings: bool,
    pub income: bool,
    pub goal_funding: bool,
    pub contribution_limits: bool,
    pub net_worth: bool,
    pub liability: bool,
}

/// Returns the default group name for a given account type.
///
/// # Arguments
/// * `account_type` - The account type string (e.g., "SECURITIES", "CASH")
///
/// # Returns
/// The default group name for the account type
pub fn default_group_for_account_type(account_type: &str) -> &'static str {
    match account_type {
        account_types::SECURITIES => "Investments",
        account_types::CASH => "Cash",
        account_types::CREDIT_CARD => "Credit Cards",
        account_types::CRYPTOCURRENCY => "Crypto",
        _ => "Investments",
    }
}

pub fn account_supports_purpose(account_type: &str, purpose: AccountPurpose) -> bool {
    match purpose {
        AccountPurpose::Spending => {
            matches!(
                account_type,
                account_types::CASH | account_types::CREDIT_CARD
            )
        }
        AccountPurpose::Performance
        | AccountPurpose::Holdings
        | AccountPurpose::Income
        | AccountPurpose::GoalFunding
        | AccountPurpose::ContributionLimits => {
            matches!(
                account_type,
                account_types::SECURITIES | account_types::CASH | account_types::CRYPTOCURRENCY
            )
        }
        AccountPurpose::NetWorth => {
            matches!(
                account_type,
                account_types::SECURITIES
                    | account_types::CASH
                    | account_types::CREDIT_CARD
                    | account_types::CRYPTOCURRENCY
            )
        }
    }
}

pub fn account_capabilities(account_type: &str) -> AccountCapabilities {
    AccountCapabilities {
        spending: account_supports_purpose(account_type, AccountPurpose::Spending),
        performance: account_supports_purpose(account_type, AccountPurpose::Performance),
        holdings: account_supports_purpose(account_type, AccountPurpose::Holdings),
        income: account_supports_purpose(account_type, AccountPurpose::Income),
        goal_funding: account_supports_purpose(account_type, AccountPurpose::GoalFunding),
        contribution_limits: account_supports_purpose(
            account_type,
            AccountPurpose::ContributionLimits,
        ),
        net_worth: account_supports_purpose(account_type, AccountPurpose::NetWorth),
        liability: is_liability_account_type(account_type),
    }
}

pub fn is_liability_account_type(account_type: &str) -> bool {
    matches!(account_type, account_types::CREDIT_CARD)
}

pub fn is_spending_account_type(account_type: &str) -> bool {
    account_supports_purpose(account_type, AccountPurpose::Spending)
}

pub fn is_report_account_type(account_type: &str) -> bool {
    account_supports_purpose(account_type, AccountPurpose::Performance)
}

pub fn is_retirement_eligible_account_type(account_type: &str) -> bool {
    account_supports_purpose(account_type, AccountPurpose::GoalFunding)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credit_card_account_semantics_are_distinct_from_cash() {
        assert_eq!(
            default_group_for_account_type(account_types::CREDIT_CARD),
            "Credit Cards"
        );
        assert!(is_spending_account_type(account_types::CREDIT_CARD));
        assert!(is_liability_account_type(account_types::CREDIT_CARD));
        assert!(!is_report_account_type(account_types::CREDIT_CARD));
        assert!(!is_retirement_eligible_account_type(
            account_types::CREDIT_CARD
        ));
    }

    #[test]
    fn account_purpose_policy_keeps_credit_cards_out_of_investment_reports() {
        assert!(account_supports_purpose(
            account_types::CREDIT_CARD,
            AccountPurpose::Spending
        ));
        assert!(account_supports_purpose(
            account_types::CREDIT_CARD,
            AccountPurpose::NetWorth
        ));
        assert!(!account_supports_purpose(
            account_types::CREDIT_CARD,
            AccountPurpose::Performance
        ));
        assert!(!account_supports_purpose(
            account_types::CREDIT_CARD,
            AccountPurpose::Holdings
        ));
        assert!(!account_supports_purpose(
            account_types::CREDIT_CARD,
            AccountPurpose::Income
        ));
        assert!(!account_supports_purpose(
            account_types::CREDIT_CARD,
            AccountPurpose::GoalFunding
        ));
        assert!(!account_supports_purpose(
            account_types::CREDIT_CARD,
            AccountPurpose::ContributionLimits
        ));

        let capabilities = account_capabilities(account_types::CREDIT_CARD);
        assert!(capabilities.spending);
        assert!(capabilities.net_worth);
        assert!(capabilities.liability);
        assert!(!capabilities.performance);
        assert!(!capabilities.holdings);
        assert!(!capabilities.income);
        assert!(!capabilities.goal_funding);
        assert!(!capabilities.contribution_limits);
    }

    #[test]
    fn report_account_types_support_investment_purposes() {
        for account_type in [
            account_types::SECURITIES,
            account_types::CASH,
            account_types::CRYPTOCURRENCY,
        ] {
            assert!(account_supports_purpose(
                account_type,
                AccountPurpose::Performance
            ));
            assert!(account_supports_purpose(
                account_type,
                AccountPurpose::Holdings
            ));
            assert!(account_supports_purpose(
                account_type,
                AccountPurpose::Income
            ));
            assert!(account_supports_purpose(
                account_type,
                AccountPurpose::GoalFunding
            ));
            assert!(account_supports_purpose(
                account_type,
                AccountPurpose::ContributionLimits
            ));
            assert!(account_supports_purpose(
                account_type,
                AccountPurpose::NetWorth
            ));
        }
    }
}
