//! The portfolio coordinator: the one recalculation sequence both hosts run
//! (architecture §3.2). Market sync, FX init, the kernel runs, persistence
//! and observer callbacks live here; hosts only translate the callbacks into
//! UI events.
//!
//! What to recompute is recorded where facts change: triggers mark the stored
//! projection stale (`projection_state`). A job consumes those markers: it
//! refolds the accounts whose facts changed and revalues those whose prices
//! changed or whose day moved, one window at a time.

mod facts;
mod persist;
pub mod rows;
mod run;

use chrono::NaiveDate;
use std::collections::BTreeSet;
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use wealthfolio_portfolio_engine as engine;

use crate::errors::{Error, Result};
use crate::fx::FxServiceTrait;
use crate::lots::LotRepositoryTrait;
use crate::portfolio::projection::{
    ActivityIssue, ActivityIssueKind, MarkerScope, ProjectionStoreTrait, GENESIS,
};
use crate::portfolio::snapshot::{
    reconcile_quote_sync_from_latest_account_snapshots, SnapshotServiceTrait,
};
use crate::quotes::{MarketSyncMode, SyncResult};
use crate::utils::time_utils::{parse_user_timezone_or_default, user_today};

pub(crate) use facts::raw_activity;
pub use facts::{window_quotes, FactSources, LoadedFacts};
pub use persist::{valuation_rows, WindowCadence};

/// One portfolio job: whether to sync market data first and whether the user
/// asked for a recalculation. Everything the stored projection no longer
/// reflects is brought up to date, whoever asked.
#[derive(Debug, Clone, Default)]
pub struct PortfolioJobRequest {
    /// Accounts a forced rebuild covers; `None` means every account. Also
    /// adds explicitly named archived accounts to the job.
    pub account_ids: Option<Vec<String>>,
    pub market_sync: MarketSyncMode,
    /// Refold from the first activity even when nothing changed: the user
    /// asked for a recalculation.
    pub force_full: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AccountFailure {
    pub account_id: String,
    pub code: String,
    pub message: String,
}

/// How an account was brought up to date.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum RebuildPlan {
    /// Facts changed: folded from the first activity, rows rewritten from `from`.
    Refold { from: NaiveDate },
    /// Prices changed or the day moved: stored keyframes revalued from `from`.
    Revalue { from: NaiveDate },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountPlan {
    pub account_id: String,
    pub plan: RebuildPlan,
}

#[derive(Debug, Clone, Default)]
pub struct PortfolioJobReport {
    pub account_ids: Vec<String>,
    pub market_sync: Option<std::result::Result<SyncResult, String>>,
    pub failures: Vec<AccountFailure>,
    /// What ran for each account that needed it.
    pub plans: Vec<AccountPlan>,
}

/// Retry for in-process job failures (architecture §3.3): storage or engine errors
/// are retried with backoff; per-account validation failures are not.
#[derive(Debug, Clone)]
pub struct RetryPolicy {
    pub attempts: usize,
    pub backoff: Vec<std::time::Duration>,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            attempts: 3,
            backoff: vec![
                std::time::Duration::from_secs(2),
                std::time::Duration::from_secs(6),
            ],
        }
    }
}

impl RetryPolicy {
    /// No delay between attempts (tests).
    pub fn immediate(attempts: usize) -> Self {
        Self {
            attempts,
            backoff: Vec::new(),
        }
    }
}

const RETRYABLE_CODES: [&str; 3] = [
    "JOB_FAILED",
    "PROJECTION_FAILED",
    "PROJECTION_PERSIST_FAILED",
];

/// Host-side progress hooks (UI events). Every method has a no-op default.
pub trait JobObserver: Send + Sync {
    fn market_sync_started(&self) {}
    fn market_sync_completed(&self, _result: &SyncResult) {}
    fn market_sync_failed(&self, _message: &str) {}
    fn update_started(&self) {}
    fn update_failed(&self, _failure: &AccountFailure) {}
    fn update_completed(&self) {}
}

/// Observer that reports nothing.
pub struct SilentObserver;

impl JobObserver for SilentObserver {}

/// A freshness verdict for one account (architecture §3.3 consistency check).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StaleAccount {
    pub account_id: String,
    pub reason: StaleReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StaleReason {
    /// Facts changed and the account has never been projected.
    Unprojected,
    /// Activities, account, snapshot or policy facts changed.
    FactsChanged,
    /// Nothing changed but the projection ends before today.
    DayAdvanced,
}

/// Read-only view of the projection for the health check: freshness, and
/// what the engine had to decide about ambiguous data.
#[async_trait]
pub trait ProjectionFreshnessTrait: Send + Sync {
    fn stale_accounts(&self) -> Result<Vec<StaleAccount>>;

    /// What the last folds decided about activities of the non-archived
    /// accounts (rejected, oversold, posted without an amount).
    fn activity_issues(&self) -> Result<Vec<ActivityIssue>>;

    /// FX pairs whose two directions disagree in the stored rates.
    fn fx_conflicts(&self) -> Result<Vec<engine::FxConflict>>;
}

pub struct CoordinatorDeps {
    pub base_currency: Arc<RwLock<String>>,
    pub timezone: Arc<RwLock<String>>,
    pub sources: FactSources,
    pub fx_service: Arc<dyn FxServiceTrait>,
    /// Latest-snapshot reads that feed quote-sync planning.
    pub snapshot_service: Arc<dyn SnapshotServiceTrait>,
    pub projections: Arc<dyn ProjectionStoreTrait>,
    /// Stored disposals price security-transfer flows on a revalue.
    pub lots: Arc<dyn LotRepositoryTrait>,
    pub window_cadence: WindowCadence,
}

pub struct PortfolioCoordinator {
    deps: CoordinatorDeps,
    /// One job at a time: a later job sees every marker an earlier one left.
    job: tokio::sync::Mutex<()>,
}

impl PortfolioCoordinator {
    pub fn new(deps: CoordinatorDeps) -> Self {
        Self {
            deps,
            job: tokio::sync::Mutex::new(()),
        }
    }

    fn base_currency(&self) -> String {
        self.deps
            .base_currency
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    fn timezone(&self) -> String {
        self.deps
            .timezone
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    fn today(&self) -> chrono::NaiveDate {
        user_today(parse_user_timezone_or_default(&self.timezone()))
    }

    fn non_archived_account_ids(&self) -> Result<Vec<String>> {
        Ok(self
            .deps
            .sources
            .accounts
            .list(None, Some(false), None)?
            .into_iter()
            .map(|account| account.id)
            .collect())
    }

    /// Runs one job end to end; jobs run one after another.
    pub async fn run_job(
        &self,
        request: PortfolioJobRequest,
        observer: &dyn JobObserver,
    ) -> Result<PortfolioJobReport> {
        let _job = self.job.lock().await;
        self.run_locked(&request, observer).await
    }

    /// `run_job` with retry and backoff for in-process failures (storage or
    /// engine errors); per-account validation failures are final.
    pub async fn run_job_with_retry(
        &self,
        request: PortfolioJobRequest,
        observer: &dyn JobObserver,
        policy: RetryPolicy,
    ) -> Result<PortfolioJobReport> {
        let mut attempt = 0;
        loop {
            attempt += 1;
            let outcome = self.run_job(request.clone(), observer).await;
            let retryable = match &outcome {
                Err(_) => true,
                Ok(report) => report
                    .failures
                    .iter()
                    .any(|f| RETRYABLE_CODES.contains(&f.code.as_str())),
            };
            if !retryable || attempt >= policy.attempts.max(1) {
                return outcome;
            }
            let delay = policy.backoff.get(attempt - 1).copied().unwrap_or_default();
            warn!(
                "Portfolio job attempt {attempt} failed; retrying in {}s",
                delay.as_secs()
            );
            tokio::time::sleep(delay).await;
        }
    }

    async fn run_locked(
        &self,
        request: &PortfolioJobRequest,
        observer: &dyn JobObserver,
    ) -> Result<PortfolioJobReport> {
        if request.force_full {
            match &request.account_ids {
                Some(ids) => {
                    for id in ids {
                        self.deps
                            .projections
                            .invalidate(MarkerScope::Account(id.clone()), GENESIS)
                            .await?;
                    }
                }
                None => {
                    self.deps
                        .projections
                        .invalidate(MarkerScope::All, GENESIS)
                        .await?
                }
            }
        }
        let mut report = PortfolioJobReport::default();
        if request.market_sync.requires_sync() {
            report.market_sync = Some(self.market_sync(&request.market_sync, observer).await);
        }
        observer.update_started();
        match self.execute(request).await {
            Ok((account_ids, plans, failures)) => {
                report.account_ids = account_ids;
                report.plans = plans;
                report.failures = failures;
            }
            Err(error) => {
                report.failures = vec![AccountFailure {
                    account_id: String::new(),
                    code: "JOB_FAILED".to_string(),
                    message: error.to_string(),
                }];
            }
        }
        self.report_failures(&report.failures, observer);
        observer.update_completed();
        // Position status from the fresh holdings feeds quote-sync planning.
        self.reconcile_quote_sync().await;
        Ok(report)
    }

    fn report_failures(&self, failures: &[AccountFailure], observer: &dyn JobObserver) {
        for failure in failures {
            warn!(
                "Portfolio recalculation failed for [{}] ({}): {}",
                failure.account_id, failure.code, failure.message
            );
            observer.update_failed(failure);
        }
    }

    async fn reconcile_quote_sync(&self) {
        let all_accounts = self.non_archived_account_ids().unwrap_or_default();
        if let Err(error) = reconcile_quote_sync_from_latest_account_snapshots(
            self.deps.snapshot_service.as_ref(),
            self.deps.sources.quotes.as_ref(),
            &all_accounts,
        )
        .await
        {
            warn!("Failed to reconcile quote sync state from latest holdings: {error}");
        }
    }

    async fn market_sync(
        &self,
        mode: &MarketSyncMode,
        observer: &dyn JobObserver,
    ) -> std::result::Result<SyncResult, String> {
        // Position status from the latest holdings feeds quote sync planning.
        self.reconcile_quote_sync().await;
        observer.market_sync_started();
        let asset_ids = mode.asset_ids().cloned();
        let result = match mode.to_sync_mode() {
            Some(sync_mode) => self.deps.sources.quotes.sync(sync_mode, asset_ids).await,
            None => Ok(SyncResult::default()),
        };
        // Whatever the provider did, the FX converter sees the latest rates.
        if let Err(error) = self.deps.fx_service.initialize() {
            warn!("Failed to initialize FX service after market sync: {error}");
        }
        match result {
            Ok(result) => {
                observer.market_sync_completed(&result);
                Ok(result)
            }
            Err(error) => {
                let message = error.to_string();
                warn!("Market data sync failed: {message}. Recalculating with cached quotes.");
                observer.market_sync_failed(&message);
                Err(message)
            }
        }
    }

    /// Plans every account the markers or the day make stale, refolds and
    /// revalues them window by window, then commits the lot books and clears
    /// the markers it consumed. Nothing is loaded when nothing is stale.
    async fn execute(
        &self,
        request: &PortfolioJobRequest,
    ) -> Result<(Vec<String>, Vec<AccountPlan>, Vec<AccountFailure>)> {
        let markers = self.deps.projections.pending_markers()?;
        let last_valued = self.deps.projections.last_valued_days()?;
        let today = self.today();
        let mut scope = self.non_archived_account_ids()?;
        if let Some(requested) = &request.account_ids {
            scope.extend(requested.iter().cloned());
        }
        scope.sort();
        scope.dedup();
        let day_moved = scope
            .iter()
            .any(|id| last_valued.get(id).is_some_and(|day| *day < today));
        if markers.is_empty() && !day_moved {
            return Ok((Vec::new(), Vec::new(), Vec::new()));
        }

        // Loading every activity, then normalising and compiling it, grows
        // with history: keep both off the async workers, like the folds below.
        let sources = self.deps.sources.clone();
        let base_currency = self.base_currency();
        let timezone = self.timezone();
        let (loaded, resolved) = blocking(move || {
            let loaded = facts::load(&sources, &scope, &base_currency, &timezone, today)?;
            let resolved = persist::resolve(&loaded)?;
            Ok((loaded, resolved))
        })
        .await?;
        let resolved = Arc::new(resolved);
        let mut failures = Vec::new();
        let mut excluded = BTreeSet::new();
        for (account_id, date) in &loaded.invalid_snapshot_dates {
            excluded.insert(account_id.clone());
            failures.push(AccountFailure {
                account_id: account_id.clone(),
                code: "INVALID_SNAPSHOT_DATE".to_string(),
                message: format!(
                    "Snapshot dated {date} is outside the supported date range; review it in the health center."
                ),
            });
        }
        for (account_id, message) in &loaded.unsupported_accounts {
            excluded.insert(account_id.clone());
            failures.push(AccountFailure {
                account_id: account_id.clone(),
                code: "UNSUPPORTED_COST_BASIS".to_string(),
                message: message.clone(),
            });
        }
        let targets: Vec<String> = loaded
            .scope
            .iter()
            .filter(|id| !excluded.contains(*id))
            .cloned()
            .collect();

        let plan = run::plan(
            &resolved,
            &loaded.fx_pairs,
            &markers,
            &last_valued,
            today,
            &targets,
        );
        let plans = plan.account_plans();
        let accounts: Vec<String> = plans.iter().map(|p| p.account_id.clone()).collect();

        let context = run::RunContext {
            sources: self.deps.sources.clone(),
            projections: Arc::clone(&self.deps.projections),
            lots: Arc::clone(&self.deps.lots),
            resolved,
            cadence: self.deps.window_cadence,
        };
        match run::execute(&context, &plan).await {
            Ok(completion) => {
                for (account, issues) in &completion.activity_issues {
                    for issue in issues
                        .iter()
                        .filter(|i| i.kind == ActivityIssueKind::Rejected)
                    {
                        warn!(
                            "Portfolio engine rejected activity {} of account {account}",
                            issue.activity_id
                        );
                    }
                }
                // An excluded account was not projected: its own markers stay,
                // and it is marked from the beginning, so whatever this run
                // consumes (shared price, FX, asset or policy markers, a
                // transfer partner's) reaches it once it projects again,
                // however its failure gets fixed. Every other marker is
                // consumed, so one failing account costs the others nothing.
                for account in &excluded {
                    self.deps
                        .projections
                        .invalidate(MarkerScope::Account(account.clone()), GENESIS)
                        .await?;
                }
                let consumed = markers
                    .into_iter()
                    .filter(|marker| {
                        !matches!(&marker.scope, MarkerScope::Account(id) if excluded.contains(id))
                    })
                    .collect();
                self.deps
                    .projections
                    .complete_run(crate::portfolio::projection::RunCompletion {
                        consumed,
                        ..completion
                    })
                    .await
                    .map_err(|error| {
                        Error::Unexpected(format!("could not commit the portfolio run: {error}"))
                    })?;
            }
            Err(error) => {
                let message = error.to_string();
                failures.extend(failures_for(&accounts, "PROJECTION_FAILED", &message));
            }
        }
        info!(
            "Portfolio job: {}",
            plans
                .iter()
                .map(|p| format!("{}={:?}", p.account_id, p.plan))
                .collect::<Vec<_>>()
                .join(", ")
        );
        Ok((accounts, plans, failures))
    }

    /// Accounts whose stored projection is stale: a pending fact marker for
    /// the account (or for everything), or valuations ending before today.
    /// Price markers are left to the next job, which they trigger anyway.
    pub fn stale_accounts(&self) -> Result<Vec<StaleAccount>> {
        let markers = self.deps.projections.pending_markers()?;
        let last_valued = self.deps.projections.last_valued_days()?;
        let today = self.today();
        let all = markers.iter().any(|m| m.scope == MarkerScope::All);
        let marked: BTreeSet<String> = markers
            .iter()
            .filter_map(|m| match &m.scope {
                MarkerScope::Account(id) => Some(id.clone()),
                _ => None,
            })
            .collect();
        let mut stale = Vec::new();
        for account_id in self.non_archived_account_ids()? {
            let valued = last_valued.get(&account_id);
            let reason = if marked.contains(&account_id) || (all && valued.is_some()) {
                Some(if valued.is_none() {
                    StaleReason::Unprojected
                } else {
                    StaleReason::FactsChanged
                })
            } else if valued.is_some_and(|day| *day < today) {
                Some(StaleReason::DayAdvanced)
            } else {
                None
            };
            if let Some(reason) = reason {
                stale.push(StaleAccount { account_id, reason });
            }
        }
        Ok(stale)
    }

    /// [`Self::update_all`], returning the failure of the job itself.
    async fn try_update_all(
        &self,
        market_sync: MarketSyncMode,
        observer: &dyn JobObserver,
    ) -> Result<PortfolioJobReport> {
        self.run_job(
            PortfolioJobRequest {
                account_ids: None,
                market_sync,
                force_full: false,
            },
            observer,
        )
        .await
    }
}

/// Work that grows with history (kernel runs, full-history reads) on the
/// blocking pool, so it never holds an async worker. A panic's payload is not
/// surfaced (it may carry figures).
pub(crate) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(work).await.unwrap_or_else(|_| {
        Err(Error::Unexpected(
            "Portfolio calculation stopped unexpectedly".to_string(),
        ))
    })
}

impl PortfolioCoordinator {
    /// Portfolio update (architecture §3.3), run at start-up, on resume and
    /// by the periodic market sync: sync if asked, then bring every stale
    /// account up to date; nothing stale costs two small reads. A failure of
    /// the job itself reaches the observer as a `JOB_FAILED` failure instead
    /// of only a log line, so hosts get a report either way.
    pub async fn update_all(
        &self,
        market_sync: MarketSyncMode,
        observer: &dyn JobObserver,
    ) -> PortfolioJobReport {
        match self.try_update_all(market_sync, observer).await {
            Ok(report) => report,
            Err(err) => {
                error!("Portfolio update failed: {err}");
                let failure = AccountFailure {
                    account_id: String::new(),
                    code: "JOB_FAILED".to_string(),
                    message: err.to_string(),
                };
                observer.update_failed(&failure);
                PortfolioJobReport {
                    failures: vec![failure],
                    ..PortfolioJobReport::default()
                }
            }
        }
    }
}

/// The app's periodic market sync, shared by both hosts: after
/// `initial_delay`, every `interval` the quotes are synced incrementally and
/// the portfolio is updated (new quotes, a new day). Never panics.
pub async fn run_periodic_update(
    coordinator: Arc<PortfolioCoordinator>,
    observer: Arc<dyn JobObserver>,
    initial_delay: std::time::Duration,
    interval: std::time::Duration,
) {
    tokio::time::sleep(initial_delay).await;
    info!(
        "Periodic portfolio update started (interval: {}h)",
        interval.as_secs() / 3600
    );
    loop {
        let report = coordinator
            .update_all(
                MarketSyncMode::Incremental { asset_ids: None },
                observer.as_ref(),
            )
            .await;
        info!(
            "Periodic portfolio update: {} account(s) rebuilt, {} failure(s)",
            report.account_ids.len(),
            report.failures.len()
        );
        tokio::time::sleep(interval).await;
    }
}

fn failures_for(account_ids: &[String], code: &str, message: &str) -> Vec<AccountFailure> {
    account_ids
        .iter()
        .map(|account_id| AccountFailure {
            account_id: account_id.clone(),
            code: code.to_string(),
            message: message.to_string(),
        })
        .collect()
}

#[async_trait]
impl ProjectionFreshnessTrait for PortfolioCoordinator {
    fn stale_accounts(&self) -> Result<Vec<StaleAccount>> {
        PortfolioCoordinator::stale_accounts(self)
    }

    fn activity_issues(&self) -> Result<Vec<ActivityIssue>> {
        self.deps
            .projections
            .activity_issues(&self.non_archived_account_ids()?)
    }

    fn fx_conflicts(&self) -> Result<Vec<engine::FxConflict>> {
        self.deps.sources.fx_conflicts()
    }
}

impl From<engine::EngineError> for Error {
    fn from(error: engine::EngineError) -> Self {
        Error::Unexpected(format!("portfolio engine: {error}"))
    }
}

#[cfg(test)]
mod tests;
