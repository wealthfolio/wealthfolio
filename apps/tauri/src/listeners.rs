use futures::FutureExt;
use log::error;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tauri::AppHandle;
use tokio::task::JoinSet;
use wealthfolio_core::portfolio::coordinator::PortfolioJobReport;
use wealthfolio_core::quotes::{AssetSkipReason, SyncResult};

use crate::context::ServiceContext;
use crate::events::{PortfolioRequestPayload, PORTFOLIO_UPDATE_ERROR};

const RESUME_REFRESH_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// Portfolio requests belong to one runtime, including their calculation phase.
pub struct PortfolioTasks(Mutex<PortfolioTaskState>);

struct PortfolioTaskState {
    tasks: Option<JoinSet<Option<SystemTime>>>,
    // Wall time includes time spent with the phone asleep; Instant may not.
    last_success: Option<SystemTime>,
}

impl PortfolioTaskState {
    fn collect_finished(&mut self) {
        // Discard a timestamp invalidated by a backwards wall-clock adjustment.
        if self
            .last_success
            .is_some_and(|last| SystemTime::now().duration_since(last).is_err())
        {
            self.last_success = None;
        }
        if let Some(tasks) = self.tasks.as_mut() {
            while let Some(result) = tasks.try_join_next() {
                if let Ok(Some(completed)) = result {
                    self.last_success = Some(
                        self.last_success
                            .map_or(completed, |last| last.max(completed)),
                    );
                }
            }
        }
    }
}

impl PortfolioTasks {
    pub fn new() -> Self {
        Self(Mutex::new(PortfolioTaskState {
            tasks: Some(JoinSet::new()),
            last_success: None,
        }))
    }

    // Completion timestamps come from the whole job, not from market-sync events.
    // Admission and spawning share the existing lock so simultaneous resumes coalesce.
    fn spawn(&self, automatic: bool, task: impl Future<Output = bool> + Send + 'static) -> bool {
        let mut state = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.collect_finished();
        let PortfolioTaskState {
            tasks,
            last_success,
        } = &mut *state;
        let Some(tasks) = tasks.as_mut() else {
            return false;
        };
        if automatic
            && (!tasks.is_empty()
                || last_success.is_some_and(|last| {
                    SystemTime::now()
                        .duration_since(last)
                        .is_ok_and(|elapsed| elapsed < RESUME_REFRESH_INTERVAL)
                }))
        {
            return false;
        }
        tasks.spawn_on(
            async move { task.await.then(SystemTime::now) },
            tauri::async_runtime::handle().inner(),
        );
        true
    }

    pub async fn stop(&self) {
        // Taking the set also rejects late requests from commands already in flight.
        let tasks = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .tasks
            .take();
        if let Some(mut tasks) = tasks {
            tasks.shutdown().await;
        }
    }
}

fn is_broad_market_update(payload: &PortfolioRequestPayload) -> bool {
    payload.account_ids.is_none()
        && payload.market_sync_mode.requires_sync()
        && payload.market_sync_mode.asset_ids().is_none()
        && !payload.force_full
}

fn market_sync_is_complete(result: &SyncResult) -> bool {
    result.is_success()
        && result.failures.is_empty()
        && result.errors.is_empty()
        && !result.skipped_reasons.iter().any(|(_, reason)| {
            matches!(
                reason,
                AssetSkipReason::TooManyErrors
                    | AssetSkipReason::SyncInProgress
                    | AssetSkipReason::NotFound
                    | AssetSkipReason::NoDataForRange
            )
        })
}

#[cfg(mobile)]
pub(crate) fn refresh_portfolio_on_resume(handle: AppHandle, context: Arc<ServiceContext>) {
    dispatch_portfolio_request(
        handle,
        context,
        PortfolioRequestPayload::builder()
            .market_sync_mode(wealthfolio_core::quotes::MarketSyncMode::Incremental {
                asset_ids: None,
            })
            .build(),
        false,
        true,
    );
}

/// Whether a finished job leaves the profile fresh for the resume cooldown:
/// a broad market update whose sync completed and whose accounts all
/// projected. Anything else stays retryable.
fn job_is_fresh(payload_is_broad: bool, report: Option<&PortfolioJobReport>) -> bool {
    payload_is_broad
        && report.is_some_and(|report| {
            report.failures.is_empty()
                && report
                    .market_sync
                    .as_ref()
                    .is_some_and(|sync| sync.as_ref().is_ok_and(market_sync_is_complete))
        })
}

// Keep an unwinding panic inside the job so the background task still emits a
// terminal event and the next refresh is admitted. Never expose the payload.
async fn run_guarded<T>(operation: impl Future<Output = T>) -> Result<T, &'static str> {
    AssertUnwindSafe(operation)
        .catch_unwind()
        .await
        .map_err(|_| "Portfolio update stopped unexpectedly")
}

/// Handles the common logic for both portfolio update and recalculation requests.
pub(crate) fn handle_portfolio_request(
    handle: AppHandle,
    context: Arc<ServiceContext>,
    payload: PortfolioRequestPayload,
    force_recalc: bool,
) {
    dispatch_portfolio_request(handle, context, payload, force_recalc, false);
}

fn dispatch_portfolio_request(
    handle: AppHandle,
    context: Arc<ServiceContext>,
    payload: PortfolioRequestPayload,
    force_recalc: bool,
    automatic: bool,
) {
    if !context.is_active() {
        return;
    }
    let handle_clone = handle.clone(); // Clone handle for async block

    let task_context = Arc::clone(&context);
    context.portfolio_tasks.spawn(automatic, async move {
        let context = task_context;
        let broad = is_broad_market_update(&payload);
        let mut payload = payload;
        // A recalculation request rebuilds from the first activity.
        payload.force_full |= force_recalc;
        let job = crate::portfolio_jobs::run_portfolio_request(&handle_clone, &context, payload);
        match run_guarded(job).await {
            Ok(report) => job_is_fresh(broad, report.as_ref()),
            Err(message) => {
                error!("{}", message);
                if let Err(e) = crate::events::emit_for_profile(
                    &handle_clone,
                    &context,
                    PORTFOLIO_UPDATE_ERROR,
                    &message.to_string(),
                ) {
                    error!("Failed to emit {} event: {}", PORTFOLIO_UPDATE_ERROR, e);
                }
                false
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn finish_tasks(tasks: &PortfolioTasks) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                {
                    let mut state = tasks.0.lock().unwrap();
                    state.collect_finished();
                    if state.tasks.as_ref().unwrap().is_empty() {
                        return;
                    }
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn resume_waits_for_whole_job_and_success_cooldown_but_manual_bypasses_it() {
        let tasks = PortfolioTasks::new();
        let (complete, completion) = tokio::sync::oneshot::channel();
        assert!(tasks.spawn(false, async move {
            completion.await.unwrap();
            true
        }));
        assert!(!tasks.spawn(true, async { true }));
        complete.send(()).unwrap();
        finish_tasks(&tasks).await;
        assert!(!tasks.spawn(true, async { true }));
        assert!(tasks.spawn(false, async { false }));
        finish_tasks(&tasks).await;
        assert!(!tasks.spawn(true, async { true }));
        tasks.0.lock().unwrap().last_success = Some(SystemTime::now() - RESUME_REFRESH_INTERVAL);
        assert!(tasks.spawn(true, async { true }));
        finish_tasks(&tasks).await;
        // Wall clock changes must not leave a profile indefinitely fresh.
        tasks.0.lock().unwrap().last_success = Some(SystemTime::now() + RESUME_REFRESH_INTERVAL);
        assert!(tasks.spawn(true, async { true }));
        finish_tasks(&tasks).await;
        assert!(!tasks.spawn(true, async { true }));
        tasks.stop().await;
    }

    #[tokio::test]
    async fn failed_and_panicked_jobs_remain_retryable_and_profiles_are_isolated() {
        let tasks = PortfolioTasks::new();
        assert!(tasks.spawn(true, async { false }));
        finish_tasks(&tasks).await;
        assert!(tasks.spawn(true, async { panic!("task failure") }));
        finish_tasks(&tasks).await;
        assert!(tasks.spawn(true, async { true }));
        finish_tasks(&tasks).await;
        assert!(!tasks.spawn(true, async { true }));
        let other_profile = PortfolioTasks::new();
        assert!(other_profile.spawn(true, async { true }));
        tasks.stop().await;
        other_profile.stop().await;
    }

    #[tokio::test]
    async fn simultaneous_resumes_admit_only_one_job() {
        let tasks = Arc::new(PortfolioTasks::new());
        let callers: Vec<_> = (0..8)
            .map(|_| {
                let tasks = tasks.clone();
                std::thread::spawn(move || tasks.spawn(true, std::future::pending()))
            })
            .collect();
        let admitted = callers
            .into_iter()
            .map(|caller| caller.join().unwrap())
            .filter(|admitted| *admitted)
            .count();
        assert_eq!(admitted, 1);
        tasks.stop().await;
        assert!(tasks.0.lock().unwrap().last_success.is_none());
        assert!(!tasks.spawn(true, async { true }));
        assert!(!tasks.spawn(false, async { true }));
    }

    #[test]
    fn only_complete_broad_market_updates_qualify_for_freshness() {
        use wealthfolio_core::quotes::MarketSyncMode;
        let mut payload = PortfolioRequestPayload::default();
        assert!(!is_broad_market_update(&payload));
        payload.market_sync_mode = MarketSyncMode::Incremental { asset_ids: None };
        assert!(is_broad_market_update(&payload));
        payload.account_ids = Some(vec!["account".into()]);
        assert!(!is_broad_market_update(&payload));
        payload.account_ids = None;
        payload.market_sync_mode = MarketSyncMode::Incremental {
            asset_ids: Some(vec!["asset".into()]),
        };
        assert!(!is_broad_market_update(&payload));

        assert!(market_sync_is_complete(&SyncResult::default()));
        assert!(!market_sync_is_complete(&SyncResult {
            failed: 1,
            ..Default::default()
        }));
        for reason in [
            AssetSkipReason::TooManyErrors,
            AssetSkipReason::SyncInProgress,
            AssetSkipReason::NoDataForRange,
            AssetSkipReason::NotFound,
        ] {
            assert!(!market_sync_is_complete(&SyncResult {
                skipped_reasons: vec![("asset".into(), reason)],
                ..Default::default()
            }));
        }
        assert!(market_sync_is_complete(&SyncResult {
            skipped_reasons: vec![("asset".into(), AssetSkipReason::ManualPricing)],
            ..Default::default()
        }));
    }

    #[test]
    fn portfolio_requests_can_start_outside_a_tokio_thread() {
        let tasks = PortfolioTasks::new();
        let (started, receiver) = std::sync::mpsc::channel();
        tasks.spawn(false, async move {
            started.send(()).unwrap();
            false
        });
        receiver
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        tauri::async_runtime::block_on(tasks.stop());
    }

    #[tokio::test]
    async fn locking_joins_portfolio_work_before_the_writer_closes() {
        let tasks = PortfolioTasks::new();
        let runtime_owner = Arc::new(());
        let task_owner = runtime_owner.clone();
        let (started, started_rx) = tokio::sync::oneshot::channel();
        tasks.spawn(false, async move {
            let _owner = task_owner;
            started.send(()).unwrap();
            // A refresh waiting on a provider must not retain the profile at lock.
            std::future::pending::<()>().await;
            false
        });
        started_rx.await.unwrap();
        assert_eq!(Arc::strong_count(&runtime_owner), 2);
        tasks.stop().await;
        // This is the ownership condition teardown needs before closing the writer.
        assert_eq!(Arc::strong_count(&runtime_owner), 1);

        // An already-admitted command cannot launch new work after shutdown.
        let late_owner = runtime_owner.clone();
        tasks.spawn(false, async move {
            let _owner = late_owner;
            std::future::pending::<()>().await;
            false
        });
        assert_eq!(Arc::strong_count(&runtime_owner), 1);
        tasks.stop().await;
    }

    #[tokio::test]
    async fn a_panicking_job_becomes_a_safe_error_and_allows_next_refresh() {
        let result = run_guarded(async {
            tokio::task::yield_now().await;
            panic!("provider internal detail that must not reach the UI");
        })
        .await;
        assert_eq!(result, Err("Portfolio update stopped unexpectedly"));
        assert_eq!(run_guarded(async { 7 }).await, Ok(7));
    }

    #[test]
    fn only_a_complete_broad_job_leaves_the_profile_fresh() {
        let report = |market_sync, failures| PortfolioJobReport {
            account_ids: Vec::new(),
            market_sync,
            failures,
            plans: Vec::new(),
        };
        let complete = report(Some(Ok(SyncResult::default())), Vec::new());
        assert!(job_is_fresh(true, Some(&complete)));
        assert!(!job_is_fresh(false, Some(&complete)));
        assert!(!job_is_fresh(true, None));
        assert!(!job_is_fresh(
            true,
            Some(&report(Some(Err("offline".into())), Vec::new()))
        ));
        assert!(!job_is_fresh(true, Some(&report(None, Vec::new()))));
    }
}
