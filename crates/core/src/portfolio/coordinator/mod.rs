//! The portfolio coordinator: the one recalculation sequence both hosts run
//! (architecture §3.2). Market sync, FX init, per-account locking, the kernel run,
//! persistence and observer callbacks live here; hosts only translate the
//! callbacks into UI events.

mod facts;
mod fingerprint;
mod persist;
pub mod rows;

use chrono::{DateTime, NaiveDate, Utc};
use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex, RwLock};

use async_trait::async_trait;
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use tokio::sync::OwnedMutexGuard;
use wealthfolio_portfolio_engine as engine;
use wealthfolio_portfolio_engine::model::ProjectionState;

use crate::errors::{Error, Result};
use crate::fx::FxServiceTrait;
use crate::lots::LotRepositoryTrait;
use crate::portfolio::projection::ProjectionStoreTrait;
use crate::portfolio::snapshot::{
    reconcile_quote_sync_from_latest_account_snapshots, SnapshotServiceTrait,
};
use crate::quotes::{MarketSyncMode, SyncResult};
use crate::utils::time_utils::{parse_user_timezone_or_default, user_today};

pub use facts::{FactSources, LoadedFacts};
pub use fingerprint::AccountFingerprint;
pub use persist::{valuation_rows, CheckpointCadence};

/// One portfolio job: which accounts, whether to sync market data first,
/// and what the caller already knows about the change. Every account gets
/// the cheapest correct plan (architecture §3.3): a full fold from the first
/// activity, a resume from the last checkpoint before the earliest changed
/// fact, a revalue of stored keyframes when only market data or the day
/// moved, or nothing when it is fresh.
#[derive(Debug, Clone, Default)]
pub struct PortfolioJobRequest {
    /// `None` means every non-archived account.
    pub account_ids: Option<Vec<String>>,
    pub market_sync: MarketSyncMode,
    /// Fold from the first activity even when the account is fresh or
    /// resumable: the user asked for a recalculation.
    pub force_full: bool,
    /// Earliest instant a fact changed, when the caller knows it (an
    /// activity event). Lets a deletion, whose row is gone, still resume.
    pub earliest_change_at: Option<DateTime<Utc>>,
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
    /// Fold from the first activity; every row replaced.
    Full,
    /// Fold from the checkpoint before `since`; rows from `since` replaced.
    Resume { since: NaiveDate },
    /// Keyframes and lots stand; valuations recomputed under new surfaces.
    Revalue,
    /// Fresh: nothing to do.
    Skip,
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
    /// What ran for each account in scope.
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
    /// No projection recorded for the account.
    Unprojected,
    /// Activities, account, asset, snapshot or policy facts changed.
    FactsChanged,
    /// Only quote/FX observations changed.
    MarketDataChanged,
    /// Nothing changed but the projection ends before today.
    DayAdvanced,
}

/// Read-only freshness view for the health check.
#[async_trait]
pub trait ProjectionFreshnessTrait: Send + Sync {
    fn stale_accounts(&self) -> Result<Vec<StaleAccount>>;
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
    pub checkpoint_cadence: CheckpointCadence,
}

/// Per-account mutual exclusion: two jobs never fold or persist the same
/// account at once, and a job takes its locks in sorted order.
#[derive(Default)]
struct AccountLocks {
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl AccountLocks {
    async fn acquire(&self, account_ids: &[String]) -> Vec<OwnedMutexGuard<()>> {
        let handles: Vec<Arc<tokio::sync::Mutex<()>>> = {
            let mut locks = self.locks.lock().unwrap_or_else(|p| p.into_inner());
            account_ids
                .iter()
                .map(|id| locks.entry(id.clone()).or_default().clone())
                .collect()
        };
        let mut guards = Vec::with_capacity(handles.len());
        for handle in handles {
            guards.push(handle.lock_owned().await);
        }
        guards
    }
}

pub struct PortfolioCoordinator {
    deps: CoordinatorDeps,
    locks: AccountLocks,
}

impl PortfolioCoordinator {
    pub fn new(deps: CoordinatorDeps) -> Self {
        Self {
            deps,
            locks: AccountLocks::default(),
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

    fn all_account_ids(&self) -> Result<BTreeSet<String>> {
        Ok(self
            .deps
            .sources
            .accounts
            .list(None, None, None)?
            .into_iter()
            .map(|account| account.id)
            .collect())
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

    fn resolve_scope(&self, requested: Option<&Vec<String>>) -> Result<Vec<String>> {
        let mut ids = match requested {
            Some(ids) => ids.clone(),
            None => self.non_archived_account_ids()?,
        };
        ids.sort();
        ids.dedup();
        Ok(ids)
    }

    /// Runs one job end to end. Jobs touching the same accounts run one
    /// after another (a later request always sees the facts it was raised
    /// for; nothing is skipped), and the locks release on every exit path.
    pub async fn run_job(
        &self,
        request: PortfolioJobRequest,
        observer: &dyn JobObserver,
    ) -> Result<PortfolioJobReport> {
        let mut account_ids = self.resolve_scope(request.account_ids.as_ref())?;
        // A request naming an account that no longer exists (deleted) has
        // nothing to rebuild itself; its transfer partners have, and the
        // consistency check finds them through their fingerprints.
        if let Some(requested) = &request.account_ids {
            let existing = self.all_account_ids()?;
            if requested.iter().any(|id| !existing.contains(id)) {
                account_ids = self.non_archived_account_ids()?;
            }
        }
        let guards = self.locks.acquire(&account_ids).await;
        let outcome = self.run_locked(&request, account_ids, observer).await;
        drop(guards);
        outcome
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
        account_ids: Vec<String>,
        observer: &dyn JobObserver,
    ) -> Result<PortfolioJobReport> {
        let mut report = PortfolioJobReport {
            account_ids: account_ids.clone(),
            ..PortfolioJobReport::default()
        };
        if request.market_sync.requires_sync() {
            report.market_sync = Some(self.market_sync(&request.market_sync, observer).await);
        }
        observer.update_started();
        match self.load_facts(&account_ids) {
            Ok(loaded) => {
                let (plans, failures) = self.execute(&loaded, &account_ids, request).await;
                report.plans = plans;
                report.failures = failures;
            }
            Err(error) => {
                report.failures = failures_for(&account_ids, "JOB_FAILED", &error.to_string());
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

    /// Plans every requested account, runs at most one kernel fold for the
    /// closure (from the first activity, or resumed from the latest usable
    /// checkpoint), revalues the accounts whose facts stand, and persists
    /// each account in one transaction. Every failure names its account.
    async fn execute(
        &self,
        loaded: &LoadedFacts,
        account_ids: &[String],
        request: &PortfolioJobRequest,
    ) -> (Vec<AccountPlan>, Vec<AccountFailure>) {
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
        let targets: Vec<String> = account_ids
            .iter()
            .filter(|id| loaded.scope.contains(id) && !excluded.contains(*id))
            .cloned()
            .collect();

        let (mut plans, resume) = match self.plan(loaded, &targets, request) {
            Ok(planned) => planned,
            Err(error) => {
                failures.extend(failures_for(&targets, "JOB_FAILED", &error.to_string()));
                return (Vec::new(), failures);
            }
        };

        let needs_projection = plans
            .iter()
            .any(|p| matches!(p.plan, RebuildPlan::Full | RebuildPlan::Resume { .. }));
        let computed = if needs_projection {
            match persist::compute(loaded, resume, self.deps.checkpoint_cadence) {
                Ok(computed) => Some(computed),
                Err(error) => {
                    let message = error.to_string();
                    for plan in plans.iter_mut() {
                        if matches!(plan.plan, RebuildPlan::Full | RebuildPlan::Resume { .. }) {
                            failures.push(AccountFailure {
                                account_id: plan.account_id.clone(),
                                code: "PROJECTION_FAILED".to_string(),
                                message: message.clone(),
                            });
                        }
                    }
                    None
                }
            }
        } else {
            None
        };

        for plan in &plans {
            let account_id = &plan.account_id;
            let projection = match plan.plan {
                RebuildPlan::Skip => continue,
                RebuildPlan::Revalue => self.revalue_projection(loaded, account_id).await,
                RebuildPlan::Full | RebuildPlan::Resume { .. } => {
                    let Some(computed) = &computed else {
                        continue;
                    };
                    persist::account_projection(loaded, computed, account_id)
                }
            };
            let projection = match projection {
                Ok(projection) => projection,
                Err(error) => {
                    failures.push(AccountFailure {
                        account_id: account_id.clone(),
                        code: "PROJECTION_FAILED".to_string(),
                        message: error.to_string(),
                    });
                    continue;
                }
            };
            if let Err(error) = self
                .deps
                .projections
                .persist_account_projection(projection)
                .await
            {
                failures.push(AccountFailure {
                    account_id: account_id.clone(),
                    code: "PROJECTION_PERSIST_FAILED".to_string(),
                    message: error.to_string(),
                });
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
        (plans, failures)
    }

    /// The plan of every target account plus the closure state to resume
    /// from when at least one account resumes and none needs a full fold.
    fn plan(
        &self,
        loaded: &LoadedFacts,
        targets: &[String],
        request: &PortfolioJobRequest,
    ) -> Result<(Vec<AccountPlan>, Option<ProjectionState>)> {
        let watermarks = self.deps.projections.get_watermarks(targets)?;
        let tz = parse_user_timezone_or_default(&loaded.timezone);
        let hint = request
            .earliest_change_at
            .map(|at| at.with_timezone(&tz).date_naive());
        let holdings: BTreeSet<&str> = loaded
            .raw
            .accounts
            .iter()
            .filter(|a| a.tracking_mode == "HOLDINGS")
            .map(|a| a.id.as_str())
            .collect();

        let mut plans = Vec::with_capacity(targets.len());
        let mut earliest_change: Option<NaiveDate> = None;
        let mut any_full = false;
        for account_id in targets {
            let Some(current) = loaded.fingerprints.get(account_id) else {
                continue;
            };
            let recorded = watermarks.iter().find(|w| w.account_id == *account_id);
            let is_holdings = holdings.contains(account_id.as_str());
            let plan = if request.force_full {
                if is_holdings {
                    RebuildPlan::Revalue
                } else {
                    RebuildPlan::Full
                }
            } else {
                match recorded {
                    None if is_holdings => RebuildPlan::Revalue,
                    None => RebuildPlan::Full,
                    Some(watermark) => {
                        match serde_json::from_str::<AccountFingerprint>(&watermark.fingerprint) {
                            Ok(fingerprint) if fingerprint == *current => {
                                if watermark.as_of < loaded.as_of {
                                    RebuildPlan::Revalue
                                } else {
                                    RebuildPlan::Skip
                                }
                            }
                            Ok(fingerprint) if fingerprint.facts_equal(current) => {
                                RebuildPlan::Revalue
                            }
                            Ok(_) if is_holdings => RebuildPlan::Revalue,
                            Ok(fingerprint) => {
                                match earliest_changed_day(
                                    loaded,
                                    account_id,
                                    &fingerprint,
                                    current,
                                    hint,
                                    tz,
                                ) {
                                    Some(day) => {
                                        earliest_change =
                                            Some(earliest_change.map_or(day, |d| d.min(day)));
                                        // Provisional: resolved to a checkpoint below.
                                        RebuildPlan::Resume { since: day }
                                    }
                                    None => RebuildPlan::Full,
                                }
                            }
                            Err(_) => RebuildPlan::Full,
                        }
                    }
                }
            };
            any_full |= plan == RebuildPlan::Full;
            plans.push(AccountPlan {
                account_id: account_id.clone(),
                plan,
            });
        }

        // One fold per job: a full fold covers every resume candidate, and a
        // resume needs one closure state before the earliest changed day.
        let mut resume = None;
        if !any_full {
            if let Some(changed) = earliest_change {
                let closure_ids: Vec<String> =
                    loaded.raw.accounts.iter().map(|a| a.id.clone()).collect();
                let checkpoints = self.deps.projections.get_checkpoints(&closure_ids)?;
                let mut dates: Vec<NaiveDate> = checkpoints
                    .iter()
                    .map(|c| c.date)
                    .filter(|d| *d < changed)
                    .collect();
                dates.sort_unstable();
                dates.dedup();
                for date in dates.into_iter().rev() {
                    if let Some(state) = persist::resume_state(loaded, &checkpoints, date) {
                        resume = Some(state);
                        break;
                    }
                }
            }
        }
        let since = resume.as_ref().map(|s| s.date + chrono::Duration::days(1));
        for plan in plans.iter_mut() {
            if let RebuildPlan::Resume { .. } = plan.plan {
                plan.plan = match since {
                    Some(since) if !any_full => RebuildPlan::Resume { since },
                    _ => RebuildPlan::Full,
                };
            }
        }
        if plans.iter().any(|p| p.plan == RebuildPlan::Full) {
            resume = None;
        }
        Ok((plans, resume))
    }

    /// Revalue-only projection: the stored keyframes (or observed snapshots)
    /// under the current surfaces, no lot or keyframe rows.
    async fn revalue_projection(
        &self,
        loaded: &LoadedFacts,
        account_id: &str,
    ) -> Result<crate::portfolio::projection::AccountProjection> {
        let snapshots = self
            .deps
            .sources
            .snapshots
            .get_snapshots_by_account(account_id, None, None)?;
        let disposals = self
            .deps
            .lots
            .get_lot_disposals_for_account(account_id)
            .await?;
        let valuations = persist::revalue(loaded, account_id, &snapshots, &disposals)?;
        let fingerprint = loaded
            .fingerprints
            .get(account_id)
            .map(|f| serde_json::to_string(f).unwrap_or_default())
            .unwrap_or_default();
        Ok(crate::portfolio::projection::AccountProjection {
            account_id: account_id.to_string(),
            snapshots: None,
            lots: None,
            disposals: None,
            valuations,
            watermark: crate::portfolio::projection::ProjectionWatermark {
                account_id: account_id.to_string(),
                engine: persist::KERNEL_ENGINE.to_string(),
                fingerprint,
                as_of: loaded.as_of,
                computed_at: crate::utils::clock::now(),
            },
            since: None,
            checkpoints: None,
        })
    }

    fn load_facts(&self, account_ids: &[String]) -> Result<LoadedFacts> {
        facts::load(
            &self.deps.sources,
            account_ids,
            &self.base_currency(),
            &self.timezone(),
            self.today(),
        )
    }

    /// Accounts whose recorded projection no longer matches their facts, or
    /// ends before today.
    pub fn stale_accounts(&self) -> Result<Vec<StaleAccount>> {
        let account_ids = self.non_archived_account_ids()?;
        if account_ids.is_empty() {
            return Ok(Vec::new());
        }
        let loaded = self.load_facts(&account_ids)?;
        self.stale_from(&loaded, &account_ids)
    }

    fn stale_from(
        &self,
        loaded: &LoadedFacts,
        account_ids: &[String],
    ) -> Result<Vec<StaleAccount>> {
        let watermarks = self.deps.projections.get_watermarks(account_ids)?;
        let mut stale = Vec::new();
        for account_id in account_ids {
            let Some(current) = loaded.fingerprints.get(account_id) else {
                continue;
            };
            let recorded = watermarks.iter().find(|w| w.account_id == *account_id);
            let reason = match recorded {
                None => Some(StaleReason::Unprojected),
                Some(watermark) => {
                    match serde_json::from_str::<AccountFingerprint>(&watermark.fingerprint) {
                        Ok(fingerprint) if fingerprint == *current => {
                            day_advanced(watermark.as_of, loaded.as_of)
                        }
                        Ok(fingerprint) if fingerprint.facts_equal(current) => {
                            Some(StaleReason::MarketDataChanged)
                        }
                        Ok(_) | Err(_) => Some(StaleReason::FactsChanged),
                    }
                }
            };
            if let Some(reason) = reason {
                stale.push(StaleAccount {
                    account_id: account_id.clone(),
                    reason,
                });
            }
        }
        Ok(stale)
    }

    /// Consistency pass (architecture §3.3), run at start-up, on resume and after
    /// every periodic market sync: sync if asked, then bring every account
    /// up to date with its cheapest plan. A fresh account costs one
    /// fingerprint comparison.
    pub async fn ensure_consistent(
        &self,
        market_sync: MarketSyncMode,
        observer: &dyn JobObserver,
    ) -> Result<PortfolioJobReport> {
        self.run_job(
            PortfolioJobRequest {
                account_ids: None,
                market_sync,
                force_full: false,
                earliest_change_at: None,
            },
            observer,
        )
        .await
    }
}

/// The first local day a fact of the closure changed since the recorded
/// fingerprint: the caller's hint (an event's earliest activity) or the
/// earliest date of an activity edited after the last run. `None` when the
/// change cannot be dated (a deletion without a hint, a settings change),
/// which means a full fold.
fn earliest_changed_day(
    loaded: &LoadedFacts,
    account_id: &str,
    recorded: &AccountFingerprint,
    current: &AccountFingerprint,
    hint: Option<NaiveDate>,
    tz: chrono_tz::Tz,
) -> Option<NaiveDate> {
    let rows_removed = current.activity_count < recorded.activity_count
        || current.partner_activity_count < recorded.partner_activity_count;
    if rows_removed && hint.is_none() {
        return None;
    }
    let last_seen = recorded
        .activities_updated_at
        .max(recorded.partner_activities_updated_at);
    // Only this account's own rows and its transfer counterparties count: an
    // unrelated account's freshly touched old row must not drag this
    // account's resume point back to the start of its history.
    let own_groups: BTreeSet<&str> = loaded
        .raw
        .activities
        .iter()
        .filter(|a| a.account_id == account_id)
        .filter_map(|a| a.source_group_id.as_deref())
        .collect();
    let edited = loaded
        .raw
        .activities
        .iter()
        .filter(|a| {
            a.account_id == account_id
                || a.source_group_id
                    .as_deref()
                    .is_some_and(|g| own_groups.contains(g))
        })
        .filter(|a| last_seen.is_none_or(|seen| a.updated_at > seen))
        .map(|a| a.timestamp.with_timezone(&tz).date_naive())
        .min();
    match (hint, edited) {
        (Some(h), Some(e)) => Some(h.min(e)),
        (Some(h), None) => Some(h),
        (None, Some(e)) => Some(e),
        (None, None) => None,
    }
}

impl PortfolioCoordinator {
    /// `ensure_consistent` for hosts: a failure of the pass itself reaches
    /// the observer as a `JOB_FAILED` failure instead of only a log line.
    pub async fn ensure_consistent_or_report(
        &self,
        market_sync: MarketSyncMode,
        observer: &dyn JobObserver,
    ) -> PortfolioJobReport {
        match self.ensure_consistent(market_sync, observer).await {
            Ok(report) => report,
            Err(err) => {
                error!("Portfolio consistency pass failed: {err}");
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

/// Periodic market sync plus consistency pass, shared by both hosts: after
/// `initial_delay`, every `interval` the quotes are synced incrementally and
/// whatever became stale (new quotes, a new day) is rebuilt. Never panics.
pub async fn run_periodic_consistency(
    coordinator: Arc<PortfolioCoordinator>,
    observer: Arc<dyn JobObserver>,
    initial_delay: std::time::Duration,
    interval: std::time::Duration,
) {
    tokio::time::sleep(initial_delay).await;
    info!(
        "Periodic portfolio consistency pass started (interval: {}h)",
        interval.as_secs() / 3600
    );
    loop {
        let report = coordinator
            .ensure_consistent_or_report(
                MarketSyncMode::Incremental { asset_ids: None },
                observer.as_ref(),
            )
            .await;
        info!(
            "Periodic consistency pass: {} account(s) rebuilt, {} failure(s)",
            report.account_ids.len(),
            report.failures.len()
        );
        tokio::time::sleep(interval).await;
    }
}

fn day_advanced(projected_through: NaiveDate, today: NaiveDate) -> Option<StaleReason> {
    (projected_through < today).then_some(StaleReason::DayAdvanced)
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
}

impl From<engine::EngineError> for Error {
    fn from(error: engine::EngineError) -> Self {
        Error::Unexpected(format!("portfolio engine: {error}"))
    }
}

#[cfg(test)]
mod tests;
