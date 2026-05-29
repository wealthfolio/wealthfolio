//! Account service implementation.

use log::{debug, info, warn};
use std::sync::{Arc, RwLock};

use super::accounts_constants::account_types;
use super::accounts_model::{Account, AccountUpdate, NewAccount, TrackingMode};
use super::accounts_traits::{AccountRepositoryTrait, AccountServiceTrait};
use crate::assets::AssetRepositoryTrait;
use crate::errors::Result;
use crate::events::{CurrencyChange, DomainEvent, DomainEventSink};
use crate::fx::FxServiceTrait;
use crate::quotes::sync_state::SyncStateStore;

/// Service for managing accounts.
pub struct AccountService {
    repository: Arc<dyn AccountRepositoryTrait>,
    fx_service: Arc<dyn FxServiceTrait>,
    base_currency: Arc<RwLock<String>>,
    event_sink: Arc<dyn DomainEventSink>,
    asset_repository: Arc<dyn AssetRepositoryTrait>,
    sync_state_store: Arc<dyn SyncStateStore>,
}

impl AccountService {
    /// Creates a new AccountService instance.
    pub fn new(
        repository: Arc<dyn AccountRepositoryTrait>,
        fx_service: Arc<dyn FxServiceTrait>,
        base_currency: Arc<RwLock<String>>,
        event_sink: Arc<dyn DomainEventSink>,
        asset_repository: Arc<dyn AssetRepositoryTrait>,
        sync_state_store: Arc<dyn SyncStateStore>,
    ) -> Self {
        Self {
            repository,
            fx_service,
            base_currency,
            event_sink,
            asset_repository,
            sync_state_store,
        }
    }

    fn validate_credit_card_tracking_mode(
        account_type: &str,
        requested_tracking_mode: Option<TrackingMode>,
        existing_tracking_mode: TrackingMode,
    ) -> Result<()> {
        let effective_tracking_mode = requested_tracking_mode.unwrap_or(existing_tracking_mode);
        if account_type == account_types::CREDIT_CARD
            && effective_tracking_mode == TrackingMode::Holdings
        {
            return Err(crate::Error::Validation(
                crate::errors::ValidationError::InvalidInput(
                    "Credit card accounts cannot use HOLDINGS tracking mode".to_string(),
                ),
            ));
        }
        Ok(())
    }
}

#[async_trait::async_trait]
impl AccountServiceTrait for AccountService {
    /// Creates a new account with currency exchange support.
    async fn create_account(&self, new_account: NewAccount) -> Result<Account> {
        let base_currency = self.base_currency.read().unwrap().clone();
        debug!(
            "Creating account..., base_currency: {}, new_account.currency: {}",
            base_currency, new_account.currency
        );

        // Perform async currency pair registration if needed
        if new_account.currency != base_currency {
            self.fx_service
                .register_currency_pair(new_account.currency.as_str(), base_currency.as_str())
                .await?;
        }

        // Repository handles transaction internally
        let result = self.repository.create(new_account).await?;

        // Emit AccountsChanged event with currency info for FX sync planning
        let currency_changes = vec![CurrencyChange {
            account_id: result.id.clone(),
            old_currency: None,
            new_currency: result.currency.clone(),
        }];
        self.event_sink.emit(DomainEvent::accounts_changed(
            vec![result.id.clone()],
            currency_changes,
        ));

        Ok(result)
    }

    /// Updates an existing account.
    async fn update_account(&self, account_update: AccountUpdate) -> Result<Account> {
        // Get existing account to detect changes
        let account_id = account_update.id.as_ref().ok_or_else(|| {
            crate::Error::Validation(crate::errors::ValidationError::InvalidInput(
                "Account ID is required".to_string(),
            ))
        })?;
        let existing = self.repository.get_by_id(account_id)?;
        Self::validate_credit_card_tracking_mode(
            &account_update.account_type,
            account_update.tracking_mode,
            existing.tracking_mode,
        )?;

        let result = self.repository.update(account_update).await?;

        // Detect currency changes and register FX pair if needed
        let currency_changes = if existing.currency != result.currency {
            let base_currency = self.base_currency.read().unwrap().clone();
            if result.currency != base_currency {
                self.fx_service
                    .register_currency_pair(result.currency.as_str(), base_currency.as_str())
                    .await?;
            }
            vec![CurrencyChange {
                account_id: result.id.clone(),
                old_currency: Some(existing.currency.clone()),
                new_currency: result.currency.clone(),
            }]
        } else {
            vec![]
        };

        // Emit AccountsChanged event
        self.event_sink.emit(DomainEvent::accounts_changed(
            vec![result.id.clone()],
            currency_changes,
        ));

        // Detect tracking mode changes
        if existing.tracking_mode != result.tracking_mode {
            let is_connected = result.provider_account_id.is_some();
            self.event_sink.emit(DomainEvent::tracking_mode_changed(
                result.id.clone(),
                existing.tracking_mode,
                result.tracking_mode,
                is_connected,
            ));
        }

        Ok(result)
    }

    /// Retrieves an account by its ID.
    fn get_account(&self, account_id: &str) -> Result<Account> {
        self.repository.get_by_id(account_id)
    }

    /// Lists all accounts with optional filtering by active status, archived status, and account IDs.
    fn list_accounts(
        &self,
        is_active_filter: Option<bool>,
        is_archived_filter: Option<bool>,
        account_ids: Option<&[String]>,
    ) -> Result<Vec<Account>> {
        self.repository
            .list(is_active_filter, is_archived_filter, account_ids)
    }

    /// Lists all accounts.
    fn get_all_accounts(&self) -> Result<Vec<Account>> {
        self.repository.list(None, None, None)
    }

    /// Lists only active accounts.
    fn get_active_accounts(&self) -> Result<Vec<Account>> {
        self.list_accounts(Some(true), None, None)
    }

    /// Retrieves multiple accounts by their IDs.
    fn get_accounts_by_ids(&self, account_ids: &[String]) -> Result<Vec<Account>> {
        self.list_accounts(None, None, Some(account_ids))
    }

    /// Returns all non-archived accounts (for aggregates/history)
    fn get_non_archived_accounts(&self) -> Result<Vec<Account>> {
        self.repository.list(None, Some(false), None)
    }

    /// Returns active, non-archived accounts (for UI selectors)
    fn get_active_non_archived_accounts(&self) -> Result<Vec<Account>> {
        self.repository.list(Some(true), Some(false), None)
    }

    fn get_base_currency(&self) -> Option<String> {
        let base_currency = self.base_currency.read().unwrap().clone();
        if base_currency.trim().is_empty() {
            None
        } else {
            Some(base_currency)
        }
    }

    /// Deletes an account by its ID.
    async fn delete_account(&self, account_id: &str) -> Result<()> {
        self.repository.delete(account_id).await?;

        // Clean up orphaned assets (activities are already CASCADE-deleted)
        match self
            .asset_repository
            .deactivate_orphaned_investments()
            .await
        {
            Ok(deactivated_ids) => {
                if !deactivated_ids.is_empty() {
                    info!(
                        "Deactivated {} orphaned investment assets after account deletion",
                        deactivated_ids.len()
                    );
                    for id in &deactivated_ids {
                        if let Err(e) = self.sync_state_store.delete(id).await {
                            warn!(
                                "Failed to delete sync state for orphaned asset {}: {}",
                                id, e
                            );
                        }
                    }
                }
            }
            Err(e) => {
                warn!(
                    "Failed to deactivate orphaned assets after account deletion: {}",
                    e
                );
            }
        }

        // Emit AccountsChanged event (no currency changes on delete)
        self.event_sink.emit(DomainEvent::accounts_changed(
            vec![account_id.to_string()],
            vec![],
        ));

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credit_card_update_rejects_existing_holdings_mode_when_tracking_mode_is_omitted() {
        let result = AccountService::validate_credit_card_tracking_mode(
            account_types::CREDIT_CARD,
            None,
            TrackingMode::Holdings,
        );

        assert!(result.is_err());
    }

    #[test]
    fn credit_card_update_allows_existing_transaction_mode_when_tracking_mode_is_omitted() {
        let result = AccountService::validate_credit_card_tracking_mode(
            account_types::CREDIT_CARD,
            None,
            TrackingMode::Transactions,
        );

        assert!(result.is_ok());
    }
}
