//! Account service implementation.

use log::{debug, info, warn};
use std::sync::{Arc, RwLock};

use super::accounts_model::{Account, AccountUpdate, NewAccount};
use super::accounts_traits::{AccountRepositoryTrait, AccountServiceTrait};
use crate::assets::AssetRepositoryTrait;
use crate::errors::Result;
use crate::events::{CurrencyChange, DomainEvent, DomainEventSink};
use crate::fx::FxServiceTrait;
use crate::portfolio::snapshot::SnapshotRepositoryTrait;
use crate::portfolio::valuation::ValuationRepositoryTrait;
use crate::quotes::sync_state::SyncStateStore;

/// Service for managing accounts.
pub struct AccountService {
    repository: Arc<dyn AccountRepositoryTrait>,
    fx_service: Arc<dyn FxServiceTrait>,
    base_currency: Arc<RwLock<String>>,
    event_sink: Arc<dyn DomainEventSink>,
    asset_repository: Arc<dyn AssetRepositoryTrait>,
    sync_state_store: Arc<dyn SyncStateStore>,
    snapshot_repository: Arc<dyn SnapshotRepositoryTrait>,
    valuation_repository: Arc<dyn ValuationRepositoryTrait>,
}

impl AccountService {
    /// Creates a new AccountService instance.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        repository: Arc<dyn AccountRepositoryTrait>,
        fx_service: Arc<dyn FxServiceTrait>,
        base_currency: Arc<RwLock<String>>,
        event_sink: Arc<dyn DomainEventSink>,
        asset_repository: Arc<dyn AssetRepositoryTrait>,
        sync_state_store: Arc<dyn SyncStateStore>,
        snapshot_repository: Arc<dyn SnapshotRepositoryTrait>,
        valuation_repository: Arc<dyn ValuationRepositoryTrait>,
    ) -> Self {
        Self {
            repository,
            fx_service,
            base_currency,
            event_sink,
            asset_repository,
            sync_state_store,
            snapshot_repository,
            valuation_repository,
        }
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

        // Clean up snapshots and valuations (no FK CASCADE on these tables)
        if let Err(e) = self
            .snapshot_repository
            .delete_snapshots_by_account_ids(&[account_id.to_string()])
            .await
        {
            warn!(
                "Failed to delete snapshots for account {}: {}",
                account_id, e
            );
        }
        if let Err(e) = self
            .valuation_repository
            .delete_valuations_for_account(account_id, None)
            .await
        {
            warn!(
                "Failed to delete valuations for account {}: {}",
                account_id, e
            );
        }

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
