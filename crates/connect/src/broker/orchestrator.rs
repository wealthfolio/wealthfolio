//! Centralized broker sync orchestrator.
//!
//! This module provides a unified sync implementation that can be used
//! by both Tauri (desktop) and Axum (web) platforms.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

mod activity_pagination;
mod activity_phase;
mod holdings_phase;

use log::{debug, info};

use super::models::{
    BrokerSyncStatusDetail, NewAccountInfo, SyncActivitiesResponse, SyncHoldingsResponse,
    SyncResult,
};
use super::progress::SyncProgressReporter;
use super::traits::{BrokerApiClient, BrokerSyncServiceTrait, BrokerTrackingMode};
use wealthfolio_core::accounts::{Account, TrackingMode};

/// Configuration for sync operations.
#[derive(Debug, Clone)]
pub struct SyncConfig {
    /// Number of activities to fetch per page.
    pub page_limit: i64,
    /// Maximum number of pages to fetch per account (safety limit).
    pub max_pages: usize,
}

impl Default for SyncConfig {
    fn default() -> Self {
        Self {
            page_limit: 1000,
            max_pages: 10_000,
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct AccountSyncJob {
    account_id: String,
    account_name: String,
    broker_account_id: String,
    tracking_mode: BrokerTrackingMode,
    account_context: super::traits::BrokerAccountContext,
}

impl AccountSyncJob {
    fn from_account(account: Account) -> Option<Self> {
        let tracking_mode = match account.tracking_mode {
            TrackingMode::Holdings => BrokerTrackingMode::Holdings,
            TrackingMode::Transactions => BrokerTrackingMode::Transactions,
            TrackingMode::NotSet => {
                info!(
                    "Skipping sync for account '{}' (trackingMode=NOT_SET)",
                    account.name
                );
                return None;
            }
        };
        Some(Self {
            account_context: super::traits::BrokerAccountContext::from_account(&account),
            account_id: account.id,
            account_name: account.name,
            broker_account_id: account.provider_account_id?,
            tracking_mode,
        })
    }

    fn is_holdings_mode(&self) -> bool {
        self.tracking_mode == BrokerTrackingMode::Holdings
    }
}

#[derive(Debug, Clone)]
pub(super) struct ActivityQueryWindow {
    start_date: Option<String>,
    end_date: String,
    has_local_cursor: bool,
}

#[derive(Debug, Clone, Default)]
pub(super) struct ActivitySyncOutcome {
    fetched: u32,
    inserted: u32,
    assets_created: u32,
    needs_review: u32,
    new_asset_ids: Vec<String>,
    inconsistent_empty_page: bool,
}

#[derive(Debug, Clone, Default)]
pub(super) struct ActivityPhaseResult {
    summary: SyncActivitiesResponse,
    activity_warning: Option<String>,
    activity_import_run_id: Option<String>,
    continue_account: bool,
}

impl ActivityPhaseResult {
    fn continue_with(summary: SyncActivitiesResponse) -> Self {
        Self {
            summary,
            continue_account: true,
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, Default)]
pub(super) struct HoldingsPhaseContext {
    activity_warning: Option<String>,
    activity_import_run_id: Option<String>,
}

/// Orchestrates broker data synchronization.
///
/// This struct encapsulates the sync logic previously duplicated in
/// Tauri commands and Axum handlers. It handles:
/// - Connection syncing
/// - Account syncing (with sync_enabled filtering)
/// - Activity syncing with full pagination support
/// - Progress reporting via a pluggable reporter trait
///
/// # Example
///
/// ```ignore
/// let reporter = Arc::new(TauriProgressReporter::new(app_handle));
/// let orchestrator = SyncOrchestrator::new(sync_service, reporter, SyncConfig::default());
/// let result = orchestrator.sync_all(&api_client).await?;
/// ```
pub struct SyncOrchestrator<P: SyncProgressReporter> {
    sync_service: Arc<dyn BrokerSyncServiceTrait>,
    progress_reporter: Arc<P>,
    config: SyncConfig,
}

impl<P: SyncProgressReporter> SyncOrchestrator<P> {
    /// Create a new sync orchestrator.
    pub fn new(
        sync_service: Arc<dyn BrokerSyncServiceTrait>,
        progress_reporter: Arc<P>,
        config: SyncConfig,
    ) -> Self {
        Self {
            sync_service,
            progress_reporter,
            config,
        }
    }

    /// Perform a full sync: connections -> accounts -> activities.
    ///
    /// This is the main entry point for broker synchronization.
    /// Always emits sync-start and sync-complete/error events.
    pub async fn sync_all(&self, api_client: &dyn BrokerApiClient) -> Result<SyncResult, String> {
        info!("Starting broker data sync...");
        self.progress_reporter.report_sync_start();

        // Run the sync and ensure we always emit completion event
        let result = self.sync_all_internal(api_client).await;

        match &result {
            Ok(sync_result) => {
                self.progress_reporter.report_sync_complete(sync_result);
            }
            Err(err) => {
                // Create a failed result to emit the error event
                let failed_result = SyncResult {
                    success: false,
                    message: err.clone(),
                    connections_synced: None,
                    accounts_synced: None,
                    activities_synced: None,
                    holdings_synced: None,
                    new_accounts: None,
                };
                self.progress_reporter.report_sync_complete(&failed_result);
            }
        }

        result
    }

    /// Internal sync logic that may fail at any step.
    async fn sync_all_internal(
        &self,
        api_client: &dyn BrokerApiClient,
    ) -> Result<SyncResult, String> {
        // Step 1: Sync connections (platforms)
        let connections = api_client
            .list_connections()
            .await
            .map_err(|e| e.to_string())?;

        let connections_result = self
            .sync_service
            .sync_connections(connections.clone())
            .await
            .map_err(|e| format!("Failed to sync connections: {}", e))?;

        debug!(
            "Connections synced: {} created, {} updated",
            connections_result.platforms_created, connections_result.platforms_updated
        );

        // Step 2: Sync accounts (filter by sync_enabled)
        let authorization_ids: Vec<String> = connections.iter().map(|c| c.id.clone()).collect();
        let all_accounts = api_client
            .list_accounts(if authorization_ids.is_empty() {
                None
            } else {
                Some(authorization_ids)
            })
            .await
            .map_err(|e| e.to_string())?;

        let provider_transaction_statuses: HashMap<String, BrokerSyncStatusDetail> = all_accounts
            .iter()
            .filter_map(|account| {
                Some((
                    account.id.clone()?,
                    account.sync_status.as_ref()?.transactions.clone()?,
                ))
            })
            .collect();
        let provider_holdings_statuses: HashMap<String, BrokerSyncStatusDetail> = all_accounts
            .iter()
            .filter_map(|account| {
                Some((
                    account.id.clone()?,
                    account.sync_status.as_ref()?.holdings.clone()?,
                ))
            })
            .collect();

        // Track sync-enabled broker IDs for data sync
        let sync_enabled_broker_ids: HashSet<String> = all_accounts
            .iter()
            .filter(|a| a.sync_enabled)
            .filter_map(|a| a.id.clone())
            .collect();

        // Only create/update local accounts for sync-enabled broker accounts
        let accounts: Vec<_> = all_accounts
            .into_iter()
            .filter(|a| a.sync_enabled)
            .collect();

        let accounts_result = self
            .sync_service
            .sync_accounts(accounts)
            .await
            .map_err(|e| format!("Failed to sync accounts: {}", e))?;

        info!(
            "Accounts synced: {} created, {} updated, {} skipped",
            accounts_result.created, accounts_result.updated, accounts_result.skipped
        );

        // Step 3: Sync data for all synced accounts based on their tracking mode
        // - TRANSACTIONS mode: sync activities
        // - HOLDINGS mode: sync holdings (positions)
        // - NOT_SET mode: skip (needs user configuration first)
        let (activities_result, holdings_result) = self
            .sync_account_data(
                api_client,
                &sync_enabled_broker_ids,
                &provider_transaction_statuses,
                &provider_holdings_statuses,
            )
            .await?;

        // Build the accounts_needing_setup list - sync-enabled accounts with trackingMode=NOT_SET
        // This ensures the "review" toast appears on every sync until user configures all accounts
        let accounts_needing_setup: Vec<NewAccountInfo> = self
            .sync_service
            .get_synced_accounts()
            .map_err(|e| format!("Failed to get synced accounts: {}", e))?
            .into_iter()
            .filter(|acc| {
                acc.tracking_mode == TrackingMode::NotSet
                    && acc
                        .provider_account_id
                        .as_ref()
                        .is_some_and(|id| sync_enabled_broker_ids.contains(id))
            })
            .map(|acc| NewAccountInfo {
                local_account_id: acc.id.clone(),
                provider_account_id: acc.provider_account_id.unwrap_or_default(),
                default_name: acc.name.clone(),
                currency: acc.currency.clone(),
                institution_name: acc.platform_id.clone(),
            })
            .collect();

        let new_accounts: Option<Vec<NewAccountInfo>> = if accounts_needing_setup.is_empty() {
            None
        } else {
            Some(accounts_needing_setup)
        };

        let total_failed = activities_result.accounts_failed + holdings_result.accounts_failed;
        let total_warnings = activities_result.accounts_warned + holdings_result.accounts_warned;
        let result = SyncResult {
            success: total_failed == 0,
            message: format!(
                "Sync completed. {} accounts created, {} activities synced, {} holdings synced{}{}",
                accounts_result.created,
                activities_result.activities_upserted,
                holdings_result.positions_upserted,
                if total_failed == 0 {
                    ".".to_string()
                } else {
                    format!(" ({} failed).", total_failed)
                },
                if total_warnings == 0 {
                    "".to_string()
                } else {
                    format!(
                        " ({} warning{}).",
                        total_warnings,
                        if total_warnings == 1 { "" } else { "s" }
                    )
                }
            ),
            connections_synced: Some(connections_result),
            accounts_synced: Some(accounts_result),
            activities_synced: Some(activities_result),
            holdings_synced: Some(holdings_result),
            new_accounts,
        };

        Ok(result)
    }

    /// Sync activities for existing transaction-tracked accounts only.
    /// This is used by legacy activities-only API endpoints that should not sync
    /// connections, accounts, or holdings.
    pub async fn sync_activities_only(
        &self,
        api_client: &dyn BrokerApiClient,
    ) -> Result<SyncActivitiesResponse, String> {
        let provider_transaction_statuses: HashMap<String, BrokerSyncStatusDetail> = api_client
            .list_accounts(None)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter_map(|account| {
                Some((
                    account.id?,
                    account.sync_status.as_ref()?.transactions.clone()?,
                ))
            })
            .collect();
        let synced_accounts = self
            .sync_service
            .get_synced_accounts()
            .map_err(|e| format!("Failed to get synced accounts: {}", e))?;
        let mut activities_summary = SyncActivitiesResponse::default();

        for account in synced_accounts {
            let Some(job) = AccountSyncJob::from_account(account) else {
                continue;
            };

            if job.tracking_mode != BrokerTrackingMode::Transactions {
                continue;
            }

            let activity_result = self
                .sync_activity_phase(
                    api_client,
                    &job,
                    provider_transaction_statuses.get(&job.broker_account_id),
                )
                .await;
            Self::merge_activities_summary(&mut activities_summary, activity_result.summary);
        }

        Ok(activities_summary)
    }

    /// Sync account data for all synced accounts based on their tracking mode.
    /// - TRANSACTIONS mode: sync activities
    /// - HOLDINGS mode: sync holdings (positions)
    /// - NOT_SET mode: skip (needs user configuration first)
    async fn sync_account_data(
        &self,
        api_client: &dyn BrokerApiClient,
        sync_enabled_broker_ids: &HashSet<String>,
        provider_transaction_statuses: &HashMap<String, BrokerSyncStatusDetail>,
        provider_holdings_statuses: &HashMap<String, BrokerSyncStatusDetail>,
    ) -> Result<(SyncActivitiesResponse, SyncHoldingsResponse), String> {
        let synced_accounts = self
            .sync_service
            .get_synced_accounts()
            .map_err(|e| format!("Failed to get synced accounts: {}", e))?;

        let mut activities_summary = SyncActivitiesResponse::default();
        let mut holdings_summary = SyncHoldingsResponse::default();

        for account in synced_accounts {
            let Some(job) = AccountSyncJob::from_account(account) else {
                continue;
            };

            if !sync_enabled_broker_ids.contains(&job.broker_account_id) {
                info!(
                    "Skipping sync for account '{}' (sync disabled)",
                    job.account_name
                );
                continue;
            }

            let activity_result = self
                .sync_activity_phase(
                    api_client,
                    &job,
                    provider_transaction_statuses.get(&job.broker_account_id),
                )
                .await;
            let ActivityPhaseResult {
                summary,
                activity_warning,
                activity_import_run_id,
                continue_account,
            } = activity_result;
            Self::merge_activities_summary(&mut activities_summary, summary);

            if !continue_account || !job.is_holdings_mode() {
                continue;
            }

            let holdings_result = self
                .sync_holdings_phase(
                    api_client,
                    &job,
                    provider_holdings_statuses.get(&job.broker_account_id),
                    HoldingsPhaseContext {
                        activity_warning,
                        activity_import_run_id,
                    },
                )
                .await;
            Self::merge_holdings_summary(&mut holdings_summary, holdings_result);
        }

        Ok((activities_summary, holdings_summary))
    }

    fn merge_activities_summary(total: &mut SyncActivitiesResponse, delta: SyncActivitiesResponse) {
        total.accounts_synced += delta.accounts_synced;
        total.activities_upserted += delta.activities_upserted;
        total.assets_inserted += delta.assets_inserted;
        total.accounts_failed += delta.accounts_failed;
        total.accounts_warned += delta.accounts_warned;
        total.new_asset_ids.extend(delta.new_asset_ids);
    }

    fn merge_holdings_summary(total: &mut SyncHoldingsResponse, delta: SyncHoldingsResponse) {
        total.accounts_synced += delta.accounts_synced;
        total.snapshots_upserted += delta.snapshots_upserted;
        total.positions_upserted += delta.positions_upserted;
        total.assets_inserted += delta.assets_inserted;
        total.accounts_failed += delta.accounts_failed;
        total.accounts_warned += delta.accounts_warned;
        total.new_asset_ids.extend(delta.new_asset_ids);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use chrono::{DateTime, Utc};
    use std::sync::Mutex;

    #[test]
    fn test_sync_config_default() {
        let config = SyncConfig::default();
        assert_eq!(config.page_limit, 1000);
        assert_eq!(config.max_pages, 10_000);
    }

    use super::super::models::{
        AccountUniversalActivity, BrokerAccount, BrokerAccountSyncStatus, BrokerBrokerage,
        BrokerConnection, BrokerHoldingsResponse, HoldingsBalance, HoldingsDiff,
        HoldingsOptionPosition, HoldingsPosition, PaginatedUniversalActivity, PaginationDetails,
        SyncAccountsResponse, SyncConnectionsResponse,
    };
    use super::super::progress::NoOpProgressReporter;
    use super::super::traits::BrokerSyncServiceTrait;
    use crate::broker_ingest::{
        BrokerSyncState, ImportRun, ImportRunMode, ImportRunStatus, ImportRunSummary,
        ImportRunType, ReviewMode,
    };
    use wealthfolio_core::accounts::Account;
    use wealthfolio_core::Result;

    #[derive(Default)]
    struct MockBrokerApiClient {
        broker_accounts: Vec<BrokerAccount>,
        activity_pages: Mutex<Vec<PaginatedUniversalActivity>>,
        activity_calls: Mutex<Vec<BrokerTrackingMode>>,
        activity_contexts: Mutex<Vec<super::super::traits::BrokerAccountContext>>,
        holdings_calls: Mutex<Vec<BrokerTrackingMode>>,
    }

    #[async_trait]
    impl BrokerApiClient for MockBrokerApiClient {
        async fn list_connections(&self) -> Result<Vec<BrokerConnection>> {
            Ok(Vec::new())
        }

        async fn list_accounts(
            &self,
            _authorization_ids: Option<Vec<String>>,
        ) -> Result<Vec<BrokerAccount>> {
            Ok(self.broker_accounts.clone())
        }

        async fn list_brokerages(&self) -> Result<Vec<BrokerBrokerage>> {
            Ok(Vec::new())
        }

        async fn get_account_activities(
            &self,
            _account_id: &str,
            tracking_mode: BrokerTrackingMode,
            _start_date: Option<&str>,
            _end_date: Option<&str>,
            _offset: Option<i64>,
            _limit: Option<i64>,
        ) -> Result<PaginatedUniversalActivity> {
            self.activity_calls.lock().unwrap().push(tracking_mode);
            let mut pages = self.activity_pages.lock().unwrap();
            if pages.is_empty() {
                return Ok(PaginatedUniversalActivity::default());
            }
            Ok(pages.remove(0))
        }

        #[allow(clippy::too_many_arguments)]
        async fn get_account_activities_with_context(
            &self,
            account_id: &str,
            mode: BrokerTrackingMode,
            context: &super::super::traits::BrokerAccountContext,
            start: Option<&str>,
            end: Option<&str>,
            offset: Option<i64>,
            limit: Option<i64>,
        ) -> Result<PaginatedUniversalActivity> {
            self.activity_contexts.lock().unwrap().push(context.clone());
            self.get_account_activities(account_id, mode, start, end, offset, limit)
                .await
        }

        async fn get_account_holdings(
            &self,
            _account_id: &str,
            tracking_mode: BrokerTrackingMode,
        ) -> Result<BrokerHoldingsResponse> {
            self.holdings_calls.lock().unwrap().push(tracking_mode);
            Ok(BrokerHoldingsResponse::default())
        }
    }

    #[derive(Default)]
    struct MockSyncService {
        accounts: Vec<Account>,
        activity_state: Option<BrokerSyncState>,
        upsert_result: (usize, usize, Vec<String>, usize),
        holdings_result: (HoldingsDiff, usize, Vec<String>),
        calls: Mutex<MockSyncServiceCalls>,
    }

    #[derive(Default)]
    struct MockSyncServiceCalls {
        activity_successes: Vec<(String, String, Option<String>)>,
        activity_failures: Vec<(String, String, Option<String>)>,
        activity_needs_review: Vec<(String, String, Option<String>)>,
        finalized_import_runs: Vec<(String, ImportRunSummary, ImportRunStatus, Option<String>)>,
        save_holdings_calls: usize,
    }

    #[async_trait]
    impl BrokerSyncServiceTrait for MockSyncService {
        async fn sync_connections(
            &self,
            _connections: Vec<BrokerConnection>,
        ) -> Result<SyncConnectionsResponse> {
            Ok(SyncConnectionsResponse {
                synced: 0,
                platforms_created: 0,
                platforms_updated: 0,
            })
        }

        async fn sync_accounts(
            &self,
            _broker_accounts: Vec<BrokerAccount>,
        ) -> Result<SyncAccountsResponse> {
            Ok(SyncAccountsResponse {
                synced: 0,
                created: 0,
                updated: 0,
                skipped: 0,
                created_accounts: Vec::new(),
                new_accounts_info: Vec::new(),
            })
        }

        fn get_synced_accounts(&self) -> Result<Vec<Account>> {
            Ok(self.accounts.clone())
        }

        fn has_broker_imported_holdings_snapshot(&self, _account_id: &str) -> Result<bool> {
            Ok(false)
        }

        fn get_platforms(&self) -> Result<Vec<crate::platform::Platform>> {
            Ok(Vec::new())
        }

        fn get_activity_sync_state(&self, _account_id: &str) -> Result<Option<BrokerSyncState>> {
            Ok(self.activity_state.clone())
        }

        async fn mark_activity_sync_attempt(&self, _account_id: String) -> Result<()> {
            Ok(())
        }

        async fn upsert_account_activities(
            &self,
            _account_id: String,
            _import_run_id: Option<String>,
            _activities: Vec<AccountUniversalActivity>,
        ) -> Result<(usize, usize, Vec<String>, usize)> {
            Ok(self.upsert_result.clone())
        }

        async fn finalize_activity_sync_success(
            &self,
            account_id: String,
            last_synced_date: String,
            import_run_id: Option<String>,
        ) -> Result<()> {
            self.calls.lock().unwrap().activity_successes.push((
                account_id,
                last_synced_date,
                import_run_id,
            ));
            Ok(())
        }

        async fn finalize_activity_sync_failure(
            &self,
            account_id: String,
            error: String,
            import_run_id: Option<String>,
        ) -> Result<()> {
            self.calls
                .lock()
                .unwrap()
                .activity_failures
                .push((account_id, error, import_run_id));
            Ok(())
        }

        async fn finalize_activity_sync_needs_review(
            &self,
            account_id: String,
            warning: String,
            import_run_id: Option<String>,
        ) -> Result<()> {
            self.calls.lock().unwrap().activity_needs_review.push((
                account_id,
                warning,
                import_run_id,
            ));
            Ok(())
        }

        fn get_all_sync_states(&self) -> Result<Vec<BrokerSyncState>> {
            Ok(Vec::new())
        }

        fn get_import_runs(
            &self,
            _run_type: Option<&str>,
            _limit: i64,
            _offset: i64,
        ) -> Result<Vec<ImportRun>> {
            Ok(Vec::new())
        }

        async fn create_import_run(
            &self,
            account_id: &str,
            mode: ImportRunMode,
        ) -> Result<ImportRun> {
            Ok(ImportRun::new(
                account_id.to_string(),
                "TEST".to_string(),
                ImportRunType::Sync,
                mode,
                ReviewMode::Never,
            ))
        }

        async fn finalize_import_run(
            &self,
            run_id: &str,
            summary: ImportRunSummary,
            status: ImportRunStatus,
            error: Option<String>,
        ) -> Result<()> {
            self.calls.lock().unwrap().finalized_import_runs.push((
                run_id.to_string(),
                summary,
                status,
                error,
            ));
            Ok(())
        }

        async fn save_broker_holdings(
            &self,
            _account_id: String,
            _balances: Vec<HoldingsBalance>,
            _positions: Vec<HoldingsPosition>,
            _option_positions: Vec<HoldingsOptionPosition>,
        ) -> Result<(HoldingsDiff, usize, Vec<String>)> {
            self.calls.lock().unwrap().save_holdings_calls += 1;
            Ok(self.holdings_result.clone())
        }
    }

    fn synced_account(
        account_id: &str,
        broker_account_id: &str,
        tracking_mode: TrackingMode,
    ) -> Account {
        Account {
            id: account_id.to_string(),
            name: "Brokerage".to_string(),
            currency: "USD".to_string(),
            provider_account_id: Some(broker_account_id.to_string()),
            tracking_mode,
            ..Account::default()
        }
    }

    fn ready_status(
        waterline: &str,
        first_transaction_date: Option<&str>,
    ) -> BrokerSyncStatusDetail {
        BrokerSyncStatusDetail {
            initial_sync_completed: Some(true),
            last_successful_sync: Some(waterline.to_string()),
            first_transaction_date: first_transaction_date.map(str::to_string),
        }
    }

    fn broker_account(
        broker_account_id: &str,
        transactions: Option<BrokerSyncStatusDetail>,
        holdings: Option<BrokerSyncStatusDetail>,
    ) -> BrokerAccount {
        BrokerAccount {
            id: Some(broker_account_id.to_string()),
            sync_status: Some(BrokerAccountSyncStatus {
                transactions,
                holdings,
            }),
            ..BrokerAccount::default()
        }
    }

    fn sync_state(account_id: &str, last_successful_at: &str) -> BrokerSyncState {
        let mut state = BrokerSyncState::new(account_id.to_string(), "TEST".to_string());
        state.last_successful_at = Some(
            DateTime::parse_from_rfc3339(last_successful_at)
                .unwrap()
                .with_timezone(&Utc),
        );
        state
    }

    fn orchestrator(service: Arc<MockSyncService>) -> SyncOrchestrator<NoOpProgressReporter> {
        SyncOrchestrator::new(
            service,
            Arc::new(NoOpProgressReporter),
            SyncConfig::default(),
        )
    }

    #[tokio::test]
    async fn cursor_blocked_activity_sync_reports_upserts_without_advancing_cursor() {
        let service = Arc::new(MockSyncService {
            accounts: vec![synced_account(
                "account-1",
                "broker-1",
                TrackingMode::Transactions,
            )],
            upsert_result: (1, 1, vec!["asset-1".to_string()], 0),
            ..MockSyncService::default()
        });
        let api_client = MockBrokerApiClient {
            activity_pages: Mutex::new(vec![
                PaginatedUniversalActivity {
                    data: vec![AccountUniversalActivity {
                        id: Some("activity-1".to_string()),
                        ..AccountUniversalActivity::default()
                    }],
                    pagination: Some(PaginationDetails {
                        has_more: Some(true),
                        total: Some(2),
                        ..PaginationDetails::default()
                    }),
                },
                PaginatedUniversalActivity {
                    data: Vec::new(),
                    pagination: Some(PaginationDetails {
                        has_more: Some(true),
                        total: Some(2),
                        ..PaginationDetails::default()
                    }),
                },
            ]),
            ..MockBrokerApiClient::default()
        };
        let mut provider_statuses = HashMap::new();
        provider_statuses.insert("broker-1".to_string(), ready_status("2026-05-22", None));

        let (activities, holdings) = orchestrator(service.clone())
            .sync_account_data(
                &api_client,
                &HashSet::from(["broker-1".to_string()]),
                &provider_statuses,
                &HashMap::new(),
            )
            .await
            .unwrap();

        assert_eq!(activities.activities_upserted, 1);
        assert_eq!(activities.assets_inserted, 1);
        assert_eq!(activities.new_asset_ids, vec!["asset-1"]);
        assert_eq!(activities.accounts_warned, 1);
        assert_eq!(activities.accounts_synced, 0);
        assert_eq!(holdings.accounts_synced, 0);
        let calls = service.calls.lock().unwrap();
        assert_eq!(calls.activity_successes.len(), 0);
        assert_eq!(calls.activity_needs_review.len(), 1);
    }

    #[tokio::test]
    async fn every_activity_page_receives_the_accounts_original_context() {
        let context = super::super::traits::BrokerAccountContext {
            account_type: Some("SECURITIES".into()),
            raw_type: Some("TFSA".into()),
        };
        let account = Account {
            account_type: "SECURITIES".into(),
            meta: Some(r#"{"broker_raw_type":"TFSA","raw_type":"RRSP"}"#.into()),
            ..synced_account("account-1", "broker-1", TrackingMode::Transactions)
        };
        let service = Arc::new(MockSyncService {
            accounts: vec![account],
            ..MockSyncService::default()
        });
        let api = MockBrokerApiClient {
            activity_pages: Mutex::new(vec![
                PaginatedUniversalActivity {
                    data: vec![AccountUniversalActivity {
                        id: Some("activity-1".into()),
                        ..AccountUniversalActivity::default()
                    }],
                    pagination: Some(PaginationDetails {
                        has_more: Some(true),
                        total: Some(2),
                        ..PaginationDetails::default()
                    }),
                },
                PaginatedUniversalActivity {
                    data: vec![AccountUniversalActivity {
                        id: Some("activity-2".into()),
                        ..AccountUniversalActivity::default()
                    }],
                    pagination: Some(PaginationDetails {
                        has_more: Some(false),
                        total: Some(2),
                        ..PaginationDetails::default()
                    }),
                },
            ]),
            ..MockBrokerApiClient::default()
        };
        orchestrator(service)
            .sync_account_data(
                &api,
                &HashSet::from(["broker-1".into()]),
                &HashMap::from([("broker-1".into(), ready_status("2026-05-22", None))]),
                &HashMap::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            *api.activity_contexts.lock().unwrap(),
            vec![context.clone(), context]
        );
    }

    #[tokio::test]
    async fn holdings_mode_continues_holdings_after_activity_warning() {
        let service = Arc::new(MockSyncService {
            accounts: vec![synced_account(
                "account-1",
                "broker-1",
                TrackingMode::Holdings,
            )],
            holdings_result: (
                HoldingsDiff {
                    total_positions: 1,
                    added_positions: 1,
                    snapshot_saved: true,
                    ..HoldingsDiff::default()
                },
                1,
                vec!["asset-1".to_string()],
            ),
            ..MockSyncService::default()
        });
        let mut provider_transaction_statuses = HashMap::new();
        provider_transaction_statuses.insert(
            "broker-1".to_string(),
            BrokerSyncStatusDetail {
                initial_sync_completed: Some(false),
                last_successful_sync: None,
                first_transaction_date: None,
            },
        );
        let mut provider_holdings_statuses = HashMap::new();
        provider_holdings_statuses.insert("broker-1".to_string(), ready_status("2026-05-22", None));

        let api_client = MockBrokerApiClient::default();
        let (activities, holdings) = orchestrator(service.clone())
            .sync_account_data(
                &api_client,
                &HashSet::from(["broker-1".to_string()]),
                &provider_transaction_statuses,
                &provider_holdings_statuses,
            )
            .await
            .unwrap();

        assert_eq!(activities.accounts_warned, 1);
        assert_eq!(holdings.accounts_synced, 1);
        assert_eq!(holdings.positions_upserted, 1);
        assert_eq!(holdings.snapshots_upserted, 1);
        assert_eq!(holdings.assets_inserted, 1);
        let calls = service.calls.lock().unwrap();
        assert_eq!(calls.save_holdings_calls, 1);
        assert!(calls
            .activity_needs_review
            .iter()
            .any(|(_, warning, _)| warning.contains("Holdings synced")));
        assert_eq!(
            *api_client.holdings_calls.lock().unwrap(),
            vec![BrokerTrackingMode::Holdings]
        );
    }

    #[tokio::test]
    async fn holdings_account_uses_holdings_mode_for_reference_activities_and_holdings() {
        let service = Arc::new(MockSyncService {
            accounts: vec![synced_account(
                "account-1",
                "broker-1",
                TrackingMode::Holdings,
            )],
            ..MockSyncService::default()
        });
        let api_client = MockBrokerApiClient {
            activity_pages: Mutex::new(vec![PaginatedUniversalActivity::default()]),
            ..MockBrokerApiClient::default()
        };
        let provider_statuses =
            HashMap::from([("broker-1".to_string(), ready_status("2026-05-22", None))]);

        orchestrator(service)
            .sync_account_data(
                &api_client,
                &HashSet::from(["broker-1".to_string()]),
                &provider_statuses,
                &provider_statuses,
            )
            .await
            .unwrap();

        assert_eq!(
            *api_client.activity_calls.lock().unwrap(),
            vec![BrokerTrackingMode::Holdings]
        );
        assert_eq!(
            *api_client.holdings_calls.lock().unwrap(),
            vec![BrokerTrackingMode::Holdings]
        );
    }

    #[tokio::test]
    async fn stale_provider_waterline_restores_cursor_without_counting_synced_account() {
        let service = Arc::new(MockSyncService {
            accounts: vec![synced_account(
                "account-1",
                "broker-1",
                TrackingMode::Transactions,
            )],
            activity_state: Some(sync_state("account-1", "2026-05-22T00:00:00Z")),
            ..MockSyncService::default()
        });
        let api_client = MockBrokerApiClient::default();
        let mut provider_statuses = HashMap::new();
        provider_statuses.insert("broker-1".to_string(), ready_status("2026-05-21", None));

        let (activities, _holdings) = orchestrator(service.clone())
            .sync_account_data(
                &api_client,
                &HashSet::from(["broker-1".to_string()]),
                &provider_statuses,
                &HashMap::new(),
            )
            .await
            .unwrap();

        assert_eq!(activities.accounts_synced, 0);
        assert!(api_client.activity_calls.lock().unwrap().is_empty());
        let calls = service.calls.lock().unwrap();
        assert_eq!(calls.activity_successes.len(), 1);
        assert_eq!(calls.activity_successes[0].1, "2026-05-22T00:00:00+00:00");
    }

    #[tokio::test]
    async fn activities_only_sync_uses_shared_activity_phase_for_transaction_accounts() {
        let service = Arc::new(MockSyncService {
            accounts: vec![
                synced_account("account-1", "broker-1", TrackingMode::Transactions),
                synced_account("account-2", "broker-2", TrackingMode::Holdings),
            ],
            upsert_result: (1, 0, Vec::new(), 0),
            ..MockSyncService::default()
        });
        let api_client = MockBrokerApiClient {
            broker_accounts: vec![
                broker_account("broker-1", Some(ready_status("2026-05-22", None)), None),
                broker_account("broker-2", Some(ready_status("2026-05-22", None)), None),
            ],
            activity_pages: Mutex::new(vec![PaginatedUniversalActivity {
                data: vec![AccountUniversalActivity {
                    id: Some("activity-1".to_string()),
                    ..AccountUniversalActivity::default()
                }],
                pagination: Some(PaginationDetails {
                    has_more: Some(false),
                    total: Some(1),
                    ..PaginationDetails::default()
                }),
            }]),
            ..MockBrokerApiClient::default()
        };

        let activities = orchestrator(service.clone())
            .sync_activities_only(&api_client)
            .await
            .unwrap();

        assert_eq!(activities.accounts_synced, 1);
        assert_eq!(activities.activities_upserted, 1);
        assert_eq!(
            *api_client.activity_calls.lock().unwrap(),
            vec![BrokerTrackingMode::Transactions]
        );
        assert_eq!(service.calls.lock().unwrap().save_holdings_calls, 0);
    }
}
