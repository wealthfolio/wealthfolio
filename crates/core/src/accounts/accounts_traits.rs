//! Account repository and service traits.
//!
//! These traits define the contract for account operations without any
//! database-specific types, allowing for different storage implementations.

use async_trait::async_trait;

use super::accounts_model::{Account, AccountUpdate, NewAccount};
use crate::errors::Result;

/// Trait defining the contract for Account repository operations.
///
/// Implementations of this trait handle the persistence of account data.
/// The trait is database-agnostic - storage-specific details are handled
/// by concrete implementations.
#[async_trait]
pub trait AccountRepositoryTrait: Send + Sync {
    /// Creates a new account.
    ///
    /// The implementation handles transaction management internally.
    async fn create(&self, new_account: NewAccount) -> Result<Account>;

    /// Updates an existing account.
    async fn update(&self, account_update: AccountUpdate) -> Result<Account>;

    /// Deletes an account by its ID.
    ///
    /// Returns the number of deleted records.
    async fn delete(&self, account_id: &str) -> Result<usize>;

    /// Retrieves an account by its ID.
    fn get_by_id(&self, account_id: &str) -> Result<Account>;

    /// Lists accounts with optional filters.
    ///
    /// # Arguments
    /// * `is_active_filter` - If Some, filter by active status
    /// * `is_archived_filter` - If Some, filter by archived status
    /// * `account_ids` - If Some, filter to only these account IDs
    fn list(
        &self,
        is_active_filter: Option<bool>,
        is_archived_filter: Option<bool>,
        account_ids: Option<&[String]>,
    ) -> Result<Vec<Account>>;
}

/// Trait defining the contract for Account service operations.
///
/// The service layer handles business logic and coordinates between
/// repositories and other services.
#[async_trait]
pub trait AccountServiceTrait: Send + Sync {
    /// Creates a new account with business validation.
    async fn create_account(&self, new_account: NewAccount) -> Result<Account>;

    /// Updates an existing account with business validation.
    async fn update_account(&self, account_update: AccountUpdate) -> Result<Account>;

    /// Deletes an account and handles related cleanup.
    async fn delete_account(&self, account_id: &str) -> Result<()>;

    /// Retrieves an account by ID.
    fn get_account(&self, account_id: &str) -> Result<Account>;

    /// Lists accounts with optional filters.
    fn list_accounts(
        &self,
        is_active_filter: Option<bool>,
        is_archived_filter: Option<bool>,
        account_ids: Option<&[String]>,
    ) -> Result<Vec<Account>>;

    /// Gets all accounts regardless of status.
    fn get_all_accounts(&self) -> Result<Vec<Account>>;

    /// Gets only active accounts.
    fn get_active_accounts(&self) -> Result<Vec<Account>>;

    /// Gets accounts by a list of IDs.
    fn get_accounts_by_ids(&self, account_ids: &[String]) -> Result<Vec<Account>>;

    /// Returns all non-archived accounts (for aggregates/history)
    fn get_non_archived_accounts(&self) -> Result<Vec<Account>>;

    /// Returns active, non-archived accounts (for UI selectors)
    fn get_active_non_archived_accounts(&self) -> Result<Vec<Account>>;

    /// Returns the configured base currency if available.
    fn get_base_currency(&self) -> Option<String>;
}
