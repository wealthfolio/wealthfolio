//! Accounts module - domain models, services, and traits.

mod accounts_constants;
mod accounts_model;
mod accounts_service;
mod accounts_traits;

// Re-export the public interface
pub use accounts_constants::*;
pub use accounts_model::{
    Account, AccountAccountingSettings, AccountUpdate, CostBasisMethod, CostBasisProfile,
    LotSelectionStrategy, NewAccount, PoolingScope, TrackingMode,
};
pub use accounts_service::AccountService;
pub use accounts_traits::{AccountRepositoryTrait, AccountServiceTrait};

/// Returns true when an account belongs in portfolio totals/history.
pub fn account_in_portfolio_scope(account: &Account) -> bool {
    !account.is_archived
}

/// Returns true when an account belongs in a portfolio reporting scope for a purpose.
pub fn account_supports_portfolio_scope(account: &Account, purpose: AccountPurpose) -> bool {
    account_in_portfolio_scope(account) && account_supports_purpose(&account.account_type, purpose)
}

#[cfg(test)]
mod accounts_model_tests;
