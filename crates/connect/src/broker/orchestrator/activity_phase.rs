use log::{debug, error, info};

use super::super::models::BrokerSyncStatusDetail;
use super::super::progress::{SyncProgressPayload, SyncProgressReporter, SyncStatus};
use super::super::sync_readiness::{
    resolve_activity_readiness, should_advance_activity_cursor, ProviderReadiness,
};
use super::super::traits::BrokerApiClient;
use super::{
    AccountSyncJob, ActivityPhaseResult, ActivityQueryWindow, ActivitySyncOutcome, SyncOrchestrator,
};
use crate::broker_ingest::{ImportRunMode, ImportRunStatus, ImportRunSummary};

impl<P: SyncProgressReporter> SyncOrchestrator<P> {
    pub(super) async fn sync_activity_phase(
        &self,
        api_client: &dyn BrokerApiClient,
        job: &AccountSyncJob,
        provider_activity_status: Option<&BrokerSyncStatusDetail>,
    ) -> ActivityPhaseResult {
        let mut result = ActivityPhaseResult::continue_with(Default::default());

        if let Err(err) = self
            .sync_service
            .mark_activity_sync_attempt(job.account_id.clone())
            .await
            .map_err(|e| format!("Failed to mark activity sync attempt: {}", e))
        {
            error!(
                "Failed to mark activity sync attempt for '{}': {}",
                job.account_name, err
            );
            if job.is_holdings_mode() {
                let warning = err.to_string();
                self.progress_reporter.report_progress(
                    SyncProgressPayload::new(
                        &job.account_id,
                        &job.account_name,
                        SyncStatus::NeedsReview,
                    )
                    .with_message(format!(
                        "Activity reference sync setup failed; continuing holdings sync: {}",
                        warning
                    )),
                );
                result.summary.accounts_warned += 1;
                result.activity_warning = Some(warning);
                return result;
            }

            result.summary.accounts_failed += 1;
            result.continue_account = false;
            return result;
        }

        let local_activity_state = match self.sync_service.get_activity_sync_state(&job.account_id)
        {
            Ok(state) => state,
            Err(err) => {
                error!(
                    "Failed to read activity sync state for '{}': {}",
                    job.account_name, err
                );
                if job.is_holdings_mode() {
                    let warning = format!(
                        "Activity reference sync state failed; continuing holdings sync: {}",
                        err
                    );
                    if let Err(e) = self
                        .sync_service
                        .finalize_activity_sync_needs_review(
                            job.account_id.clone(),
                            warning.clone(),
                            None,
                        )
                        .await
                    {
                        error!(
                            "Failed to mark activity sync as needs review for '{}': {}",
                            job.account_name, e
                        );
                    }
                    self.progress_reporter.report_progress(
                        SyncProgressPayload::new(
                            &job.account_id,
                            &job.account_name,
                            SyncStatus::NeedsReview,
                        )
                        .with_message(warning.clone()),
                    );
                    result.summary.accounts_warned += 1;
                    result.activity_warning = Some(warning);
                    return result;
                }

                let failure = format!("Activity sync state failed: {}", err);
                let _ = self
                    .sync_service
                    .finalize_activity_sync_failure(job.account_id.clone(), failure.clone(), None)
                    .await;
                self.progress_reporter.report_progress(
                    SyncProgressPayload::new(
                        &job.account_id,
                        &job.account_name,
                        SyncStatus::Failed,
                    )
                    .with_message(failure),
                );
                result.summary.accounts_failed += 1;
                result.continue_account = false;
                return result;
            }
        };

        let local_cursor = local_activity_state
            .as_ref()
            .and_then(|state| state.last_successful_at.as_ref());

        let activity_waterline = match resolve_activity_readiness(provider_activity_status) {
            Ok(ProviderReadiness::Ready(date)) => {
                if let Some(cursor) = local_cursor.filter(|cursor| date < cursor.date_naive()) {
                    let message = format!(
                        "Activity sync skipped: provider transaction waterline {} is older than local cursor {}",
                        date,
                        cursor.date_naive()
                    );
                    if let Err(e) = self
                        .sync_service
                        .finalize_activity_sync_success(
                            job.account_id.clone(),
                            cursor.to_rfc3339(),
                            None,
                        )
                        .await
                    {
                        error!(
                            "Failed to restore activity sync state for '{}': {}",
                            job.account_name, e
                        );
                        result.summary.accounts_failed += 1;
                        if !job.is_holdings_mode() {
                            result.continue_account = false;
                            return result;
                        }
                        result.activity_warning = Some(format!(
                            "Activity sync skipped, but sync state cleanup failed: {}",
                            e
                        ));
                    } else {
                        self.progress_reporter.report_progress(
                            SyncProgressPayload::new(
                                &job.account_id,
                                &job.account_name,
                                SyncStatus::Complete,
                            )
                            .with_message(message),
                        );
                    }
                    return result;
                }
                date
            }
            Ok(ProviderReadiness::NotReady(reason)) => {
                let warning = format!("Activity sync deferred: {}", reason);
                if let Err(e) = self
                    .sync_service
                    .finalize_activity_sync_needs_review(
                        job.account_id.clone(),
                        warning.clone(),
                        None,
                    )
                    .await
                {
                    error!(
                        "Failed to mark deferred activity sync for '{}': {}",
                        job.account_name, e
                    );
                }
                self.progress_reporter.report_progress(
                    SyncProgressPayload::new(
                        &job.account_id,
                        &job.account_name,
                        SyncStatus::NeedsReview,
                    )
                    .with_message(warning.clone()),
                );
                result.summary.accounts_warned += 1;
                result.activity_warning = Some(warning);
                return result;
            }
            Err(err) => {
                error!(
                    "Failed to resolve provider activity sync status for '{}': {}",
                    job.account_name, err
                );
                if job.is_holdings_mode() {
                    let message = format!(
                        "Activity reference sync status failed; continuing holdings sync: {}",
                        err
                    );
                    if let Err(e) = self
                        .sync_service
                        .finalize_activity_sync_needs_review(
                            job.account_id.clone(),
                            message.clone(),
                            None,
                        )
                        .await
                    {
                        error!(
                            "Failed to mark activity sync as needs review for '{}': {}",
                            job.account_name, e
                        );
                    }
                    self.progress_reporter.report_progress(
                        SyncProgressPayload::new(
                            &job.account_id,
                            &job.account_name,
                            SyncStatus::NeedsReview,
                        )
                        .with_message(message.clone()),
                    );
                    result.summary.accounts_warned += 1;
                    result.activity_warning = Some(message);
                    return result;
                }

                let _ = self
                    .sync_service
                    .finalize_activity_sync_failure(job.account_id.clone(), err.clone(), None)
                    .await;
                self.progress_reporter.report_progress(
                    SyncProgressPayload::new(
                        &job.account_id,
                        &job.account_name,
                        SyncStatus::Failed,
                    )
                    .with_message(err.clone()),
                );
                result.summary.accounts_failed += 1;
                result.continue_account = false;
                return result;
            }
        };

        let query_window = match self
            .compute_activity_query_window(&job.account_id, activity_waterline)
        {
            Ok(window) => window,
            Err(err) => {
                error!(
                    "Failed to compute activity query window for '{}': {}",
                    job.account_name, err
                );
                if job.is_holdings_mode() {
                    let message = format!(
                        "Activity reference query window failed; continuing holdings sync: {}",
                        err
                    );
                    if let Err(e) = self
                        .sync_service
                        .finalize_activity_sync_needs_review(
                            job.account_id.clone(),
                            message.clone(),
                            None,
                        )
                        .await
                    {
                        error!(
                            "Failed to mark activity sync as needs review for '{}': {}",
                            job.account_name, e
                        );
                    }
                    self.progress_reporter.report_progress(
                        SyncProgressPayload::new(
                            &job.account_id,
                            &job.account_name,
                            SyncStatus::NeedsReview,
                        )
                        .with_message(message.clone()),
                    );
                    result.summary.accounts_warned += 1;
                    result.activity_warning = Some(message);
                    return result;
                }

                let failure = format!("Activity query window failed: {}", err);
                let _ = self
                    .sync_service
                    .finalize_activity_sync_failure(job.account_id.clone(), failure.clone(), None)
                    .await;
                self.progress_reporter.report_progress(
                    SyncProgressPayload::new(
                        &job.account_id,
                        &job.account_name,
                        SyncStatus::Failed,
                    )
                    .with_message(failure),
                );
                result.summary.accounts_failed += 1;
                result.continue_account = false;
                return result;
            }
        };

        let import_mode = if query_window.start_date.is_none() {
            ImportRunMode::Initial
        } else {
            ImportRunMode::Incremental
        };

        let import_run = match self
            .sync_service
            .create_import_run(&job.account_id, import_mode)
            .await
        {
            Ok(run) => {
                debug!(
                    "Created import run {} for account '{}'",
                    run.id, job.account_name
                );
                Some(run)
            }
            Err(e) => {
                error!(
                    "Failed to create import run for '{}': {}",
                    job.account_name, e
                );
                None
            }
        };
        result.activity_import_run_id = import_run.as_ref().map(|r| r.id.clone());

        let window_label = match &query_window.start_date {
            Some(s) => format!("{} -> {}", s, query_window.end_date),
            None => format!("ALL -> {}", query_window.end_date),
        };
        info!(
            "Syncing activities for account '{}' ({}): {}",
            job.account_name, job.broker_account_id, window_label
        );

        self.progress_reporter.report_progress(
            SyncProgressPayload::new(&job.account_id, &job.account_name, SyncStatus::Syncing)
                .with_message(format!("Starting sync: {}", window_label)),
        );

        match self
            .sync_account_activities(
                api_client,
                &job.account_id,
                &job.account_name,
                &job.broker_account_id,
                job.tracking_mode,
                &job.account_context,
                query_window.start_date.as_deref(),
                Some(query_window.end_date.as_str()),
                result.activity_import_run_id.clone(),
            )
            .await
        {
            Ok(outcome) => {
                self.handle_activity_sync_success(
                    job,
                    provider_activity_status,
                    &query_window,
                    outcome,
                    &mut result,
                )
                .await;
            }
            Err(err) => {
                self.handle_activity_sync_error(job, err, &mut result).await;
            }
        }

        result
    }

    async fn handle_activity_sync_success(
        &self,
        job: &AccountSyncJob,
        provider_activity_status: Option<&BrokerSyncStatusDetail>,
        query_window: &ActivityQueryWindow,
        outcome: ActivitySyncOutcome,
        result: &mut ActivityPhaseResult,
    ) {
        let mut import_status = if outcome.needs_review > 0 {
            ImportRunStatus::NeedsReview
        } else {
            ImportRunStatus::Applied
        };
        let summary = ImportRunSummary {
            fetched: outcome.fetched,
            inserted: outcome.inserted,
            updated: 0,
            skipped: 0,
            warnings: outcome.needs_review,
            errors: 0,
            removed: 0,
            assets_created: outcome.assets_created,
        };

        let should_advance_cursor = should_advance_activity_cursor(
            outcome.fetched as usize,
            query_window.has_local_cursor,
            outcome.inconsistent_empty_page,
            provider_activity_status,
        );

        if should_advance_cursor {
            let sync_state_failed = self
                .sync_service
                .finalize_activity_sync_success(
                    job.account_id.clone(),
                    query_window.end_date.clone(),
                    result.activity_import_run_id.clone(),
                )
                .await
                .is_err();

            if sync_state_failed {
                error!(
                    "Failed to update activity sync state for '{}', but activities were synced",
                    job.account_name
                );
            }
        } else {
            let warning = if outcome.inconsistent_empty_page {
                "Activity sync returned an empty page while provider pagination reported more data"
            } else {
                "Initial activity sync returned no rows even though provider reports transactions may exist"
            }
            .to_string();
            if let Err(e) = self
                .sync_service
                .finalize_activity_sync_needs_review(
                    job.account_id.clone(),
                    warning.clone(),
                    result.activity_import_run_id.clone(),
                )
                .await
            {
                error!(
                    "Failed to mark activity sync as needs review for '{}': {}",
                    job.account_name, e
                );
            }
            import_status = ImportRunStatus::NeedsReview;
            result.summary.accounts_warned += 1;
            result.activity_warning = Some(warning.clone());
            self.progress_reporter.report_progress(
                SyncProgressPayload::new(
                    &job.account_id,
                    &job.account_name,
                    SyncStatus::NeedsReview,
                )
                .with_activities_fetched(outcome.fetched as usize)
                .with_message(warning),
            );
        }

        if let Some(ref run_id) = result.activity_import_run_id {
            if outcome.needs_review > 0 {
                info!(
                    "Import run {} has {} activities needing review",
                    run_id, outcome.needs_review
                );
            }

            let _ = self
                .sync_service
                .finalize_import_run(run_id, summary, import_status, None)
                .await;
        }

        result.summary.activities_upserted += outcome.inserted as usize;
        result.summary.assets_inserted += outcome.assets_created as usize;
        result.summary.new_asset_ids.extend(outcome.new_asset_ids);

        if !should_advance_cursor {
            result.continue_account = job.is_holdings_mode();
            return;
        }

        let status = if outcome.needs_review > 0 {
            SyncStatus::NeedsReview
        } else {
            SyncStatus::Complete
        };
        self.progress_reporter.report_progress(
            SyncProgressPayload::new(&job.account_id, &job.account_name, status)
                .with_activities_fetched(outcome.fetched as usize)
                .with_message(format!(
                    "Synced {} activities ({} need review)",
                    outcome.inserted, outcome.needs_review
                )),
        );

        result.summary.accounts_synced += 1;
    }

    async fn handle_activity_sync_error(
        &self,
        job: &AccountSyncJob,
        err: String,
        result: &mut ActivityPhaseResult,
    ) {
        error!(
            "Failed to sync activities for '{}': {}",
            job.account_name, err
        );

        let _ = self
            .sync_service
            .finalize_activity_sync_failure(
                job.account_id.clone(),
                err.clone(),
                result.activity_import_run_id.clone(),
            )
            .await;

        if let Some(ref run_id) = result.activity_import_run_id {
            let summary = ImportRunSummary::default();
            let _ = self
                .sync_service
                .finalize_import_run(run_id, summary, ImportRunStatus::Failed, Some(err.clone()))
                .await;
        }

        if job.is_holdings_mode() {
            self.progress_reporter.report_progress(
                SyncProgressPayload::new(
                    &job.account_id,
                    &job.account_name,
                    SyncStatus::NeedsReview,
                )
                .with_message(format!(
                    "Activity reference sync failed; continuing holdings sync: {}",
                    err
                )),
            );
            result.summary.accounts_warned += 1;
            result.activity_warning = Some(err);
        } else {
            self.progress_reporter.report_progress(
                SyncProgressPayload::new(&job.account_id, &job.account_name, SyncStatus::Failed)
                    .with_message(err.clone()),
            );
            result.summary.accounts_failed += 1;
            result.continue_account = false;
        }
    }
}
