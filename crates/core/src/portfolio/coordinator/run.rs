//! One run over the pending markers: a plan per account, then one pass over
//! the windows. Each window is read, folded or revalued, and written before the
//! next is read, so memory holds one window plus the running state.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::ops::Bound;
use std::sync::Arc;

use chrono::NaiveDate;
use wealthfolio_portfolio_engine as engine;
use wealthfolio_portfolio_engine::model::{
    AccountId, AccountState, AssetId, DateRange, Keyframe, LotClosure,
    LotDisposal as KernelDisposal, ProjectionBundle, ProjectionState, TrackingMode,
};
use wealthfolio_portfolio_engine::{Diagnostic, DiagnosticCode, FactChange};

use super::persist::{self, Resolved, WindowCadence};
use super::{blocking, facts, AccountPlan, FactSources, RebuildPlan};
use crate::errors::Result;
use crate::lots::{LotDisposal, LotRepositoryTrait};
use crate::portfolio::projection::{
    ActivityIssue, ActivityIssueKind, LotBook, MarkerScope, ProjectionMarker, ProjectionStoreTrait,
    RunCompletion, WindowRows, GENESIS,
};
use crate::portfolio::snapshot::SnapshotSource;

/// First day each account's stored rows must be rewritten from.
#[derive(Debug, Default)]
pub(super) struct Plan {
    /// Facts changed: fold from the first activity, write from the day.
    pub refold: BTreeMap<String, NaiveDate>,
    /// Prices changed or the day moved: revalue stored keyframes (or
    /// observed snapshots) from the day.
    pub revalue: BTreeMap<String, NaiveDate>,
}

impl Plan {
    pub fn account_plans(&self) -> Vec<AccountPlan> {
        let refold = self.refold.iter().map(|(id, from)| AccountPlan {
            account_id: id.clone(),
            plan: RebuildPlan::Refold { from: *from },
        });
        let revalue = self.revalue.iter().map(|(id, from)| AccountPlan {
            account_id: id.clone(),
            plan: RebuildPlan::Revalue { from: *from },
        });
        refold.chain(revalue).collect()
    }
}

/// Asks the kernel which targets the markers make stale, each marker being
/// the change of facts it records. The day moving extends every account
/// valued before today from the next day; an account with facts but never
/// valued folds from genesis.
pub(super) fn plan(
    resolved: &Resolved,
    fx_pairs: &BTreeMap<String, (String, String)>,
    markers: &[ProjectionMarker],
    last_valued: &HashMap<String, NaiveDate>,
    today: NaiveDate,
    targets: &[String],
) -> Plan {
    let facts = &resolved.facts;
    let mut changes: Vec<FactChange> = markers
        .iter()
        .map(|marker| fact_change(marker, fx_pairs))
        .collect();
    let has_facts: BTreeSet<&str> = facts
        .activities()
        .iter()
        .map(|a| a.account.as_str())
        .chain(
            facts
                .observed_snapshots()
                .iter()
                .map(|s| s.account.as_str()),
        )
        .collect();
    for target in targets {
        let account = AccountId::new(target.as_str());
        match last_valued.get(target) {
            Some(last) if *last < today => {
                if let Some(from) = last.succ_opt() {
                    changes.push(FactChange::Extended { account, from });
                }
            }
            Some(_) => {}
            None if has_facts.contains(target.as_str()) => {
                changes.push(FactChange::Account {
                    account,
                    from: GENESIS,
                });
            }
            None => {}
        }
    }
    let impact = engine::impact(facts, &resolved.surfaces, &changes);
    let targets: BTreeSet<&str> = targets.iter().map(String::as_str).collect();
    let of_targets = |days: BTreeMap<AccountId, NaiveDate>| -> BTreeMap<String, NaiveDate> {
        days.into_iter()
            .filter(|(id, _)| targets.contains(id.as_str()))
            .map(|(id, day)| (id.as_str().to_string(), day))
            .collect()
    };
    Plan {
        refold: of_targets(impact.refold),
        revalue: of_targets(impact.revalue),
    }
}

/// The change of facts a marker records.
fn fact_change(
    marker: &ProjectionMarker,
    fx_pairs: &BTreeMap<String, (String, String)>,
) -> FactChange {
    let day = marker.dirty_from;
    match &marker.scope {
        MarkerScope::All => FactChange::Policy,
        MarkerScope::Account(id) => FactChange::Account {
            account: AccountId::new(id.as_str()),
            from: day,
        },
        MarkerScope::Asset(asset) => FactChange::Asset {
            asset: AssetId::new(asset.as_str()),
        },
        MarkerScope::Prices(asset) => FactChange::Prices {
            asset: AssetId::new(asset.as_str()),
            from: day,
        },
        // An FX asset's pair comes from its rates. One left with none (its
        // last rate deleted) may have moved any conversion.
        MarkerScope::Fx(asset) => match fx_pairs.get(asset) {
            Some((from, to)) => FactChange::FxRate {
                from: from.clone(),
                to: to.clone(),
                day,
            },
            None => FactChange::Policy,
        },
    }
}

pub(super) struct RunContext {
    pub sources: FactSources,
    pub projections: Arc<dyn ProjectionStoreTrait>,
    pub lots: Arc<dyn LotRepositoryTrait>,
    pub resolved: Arc<Resolved>,
    pub cadence: WindowCadence,
}

/// One pass over the windows. The fold runs in memory from genesis when an
/// account refolds; from the first day an account rewrites, each window loads
/// once the prices of the assets its accounts reference, values the refolded
/// accounts from the fold and the revalued ones from their stored keyframes,
/// and writes their rows together. Returns what the run commits last (the
/// caller adds the consumed markers).
pub(super) async fn execute(context: &RunContext, plan: &Plan) -> Result<RunCompletion> {
    let resolved = Arc::clone(&context.resolved);
    let starts: BTreeSet<NaiveDate> = plan
        .refold
        .values()
        .chain(plan.revalue.values())
        .copied()
        .collect();
    let Some(earliest) = starts.first().copied() else {
        return Ok(RunCompletion::default());
    };
    let folds = !plan.refold.is_empty();
    // Only the refolded accounts fold (the kernel adds their transfer closure).
    let folded_accounts: Arc<BTreeSet<AccountId>> = Arc::new(
        plan.refold
            .keys()
            .map(|id| AccountId::new(id.as_str()))
            .collect(),
    );
    let as_of = resolved.facts.policy().as_of;
    let range = if folds {
        resolved.range()
    } else {
        DateRange {
            start: earliest.max(resolved.genesis).min(as_of),
            end: as_of,
        }
    };
    let stored = Arc::new(stored_inputs(context, &plan.revalue).await?);

    let owner: HashMap<String, String> = resolved
        .facts
        .activities()
        .iter()
        .map(|a| (a.id.as_str().to_string(), a.account.as_str().to_string()))
        .collect();
    let mut activity_issues: BTreeMap<String, Vec<ActivityIssue>> = plan
        .refold
        .keys()
        .map(|account| (account.clone(), Vec::new()))
        .collect();
    let mut record = |diagnostic: &Diagnostic| {
        let Some(kind) = issue_kind(diagnostic.code) else {
            return;
        };
        let Some(account) = owner.get(&diagnostic.source) else {
            return;
        };
        if let Some(list) = activity_issues.get_mut(account) {
            list.push(ActivityIssue {
                activity_id: diagnostic.source.clone(),
                kind,
                message: diagnostic.message.clone(),
            });
        }
    };
    // Compiling decides the cash of rows without a final amount.
    for diagnostic in &resolved.ledger.diagnostics {
        record(diagnostic);
    }
    let mut disposals: BTreeMap<String, Vec<KernelDisposal>> = BTreeMap::new();
    let mut closures: Vec<LotClosure> = Vec::new();
    let mut state: Option<ProjectionState> = None;
    let mut started: BTreeSet<AccountId> = BTreeSet::new();
    let mut written: BTreeSet<String> = BTreeSet::new();

    for window in windows(context.cadence, range, &starts) {
        let refold = writers(&plan.refold, window, &mut written);
        let revalue = writers(&plan.revalue, window, &mut written);
        let step = folds.then(|| {
            let seed = if refold.is_empty() {
                BTreeMap::new()
            } else {
                state
                    .as_ref()
                    .map(|s| {
                        s.accounts
                            .iter()
                            .filter(|(id, _)| started.contains(*id))
                            .map(|(id, account)| (id.clone(), account.clone()))
                            .collect()
                    })
                    .unwrap_or_default()
            };
            FoldStep {
                accounts: Arc::clone(&folded_accounts),
                state: state.take(),
                seed,
                active: refold,
            }
        });
        let job_resolved = Arc::clone(&resolved);
        let sources = context.sources.clone();
        let stored = Arc::clone(&stored);
        let output =
            blocking(move || run_window(&job_resolved, &sources, window, step, &revalue, &stored))
                .await?;
        if !output.rows.is_empty() {
            context.projections.write_window(output.rows).await?;
        }
        let Some(folded) = output.folded else {
            continue;
        };
        for diagnostic in &folded.issues {
            record(diagnostic);
        }
        for disposal in folded.disposals {
            if plan
                .refold
                .get(disposal.account.as_str())
                .is_some_and(|from| disposal.date >= *from)
            {
                disposals
                    .entry(disposal.account.as_str().to_string())
                    .or_default()
                    .push(disposal);
            }
        }
        closures.extend(
            folded
                .closures
                .into_iter()
                .filter(|closure| closure.close_date >= earliest),
        );
        started.extend(folded.keyframed);
        state = Some(folded.final_state);
    }

    let mut completion = RunCompletion::default();
    let Some(final_state) = state else {
        return Ok(completion);
    };
    let fx = engine::FxResolver {
        surface: &resolved.surfaces.fx,
        policy: resolved.facts.policy(),
    };
    let records = engine::lot_records(
        &ProjectionBundle {
            keyframes: BTreeMap::new(),
            final_state,
            disposals: Vec::new(),
            closures,
            diagnostics: Vec::new(),
        },
        &resolved.facts,
        &fx,
    );
    for (account, from) in &plan.refold {
        let lots = persist::lot_rows(&resolved, records.clone(), account)
            .into_iter()
            .filter(|lot| {
                lot.close_date
                    .as_deref()
                    .and_then(|d| d.parse::<NaiveDate>().ok())
                    .is_none_or(|closed| closed >= *from)
            })
            .collect();
        let own: Vec<&KernelDisposal> = disposals
            .get(account)
            .map(|rows| rows.iter().collect())
            .unwrap_or_default();
        completion.lot_books.push(LotBook {
            account_id: account.clone(),
            since: *from,
            lots,
            disposals: persist::disposal_rows(&resolved, &own, account),
        });
    }
    completion.activity_issues = activity_issues.into_iter().collect();
    Ok(completion)
}

/// The cadence windows over `range`, each also cut at every day an account
/// starts rewriting, so a window only values accounts that write all of it.
fn windows(
    cadence: WindowCadence,
    range: DateRange,
    starts: &BTreeSet<NaiveDate>,
) -> Vec<DateRange> {
    let mut windows = Vec::new();
    for window in cadence.windows(range) {
        let mut start = window.start;
        for cut in starts.range((Bound::Excluded(window.start), Bound::Included(window.end))) {
            let Some(end) = cut.pred_opt() else {
                continue;
            };
            windows.push(DateRange { start, end });
            start = *cut;
        }
        windows.push(DateRange {
            start,
            end: window.end,
        });
    }
    windows
}

/// Where an account's rows start in a window: it writes rows from
/// `max(from, window start)`, and clears stored rows from the window start,
/// or from `from` in its first written window (which also clears rows before
/// a history that now starts later).
#[derive(Clone)]
struct Writer {
    account: String,
    from: NaiveDate,
    clear_from: NaiveDate,
}

fn writers(
    accounts: &BTreeMap<String, NaiveDate>,
    window: DateRange,
    written: &mut BTreeSet<String>,
) -> Vec<Writer> {
    accounts
        .iter()
        .filter(|(_, from)| **from <= window.end)
        .map(|(account, from)| Writer {
            account: account.clone(),
            from: *from,
            clear_from: if written.insert(account.clone()) {
                *from
            } else {
                window.start
            },
        })
        .collect()
}

/// The accounts a window values: only those it writes.
fn valued(active: &[Writer]) -> BTreeSet<AccountId> {
    active
        .iter()
        .map(|writer| AccountId::new(writer.account.as_str()))
        .collect()
}

/// Rows `[start, end]` or, for the window that ends today, `[start, ∞)`.
fn row_end(resolved: &Resolved, window: DateRange) -> Option<NaiveDate> {
    (window.end < resolved.facts.policy().as_of).then_some(window.end)
}

/// A window of the fold: the accounts folded, the state carried in, the seeds
/// of the accounts the window writes, and those writers.
struct FoldStep {
    accounts: Arc<BTreeSet<AccountId>>,
    state: Option<ProjectionState>,
    seed: BTreeMap<AccountId, AccountState>,
    active: Vec<Writer>,
}

/// What revaluing reads from the last run: stored disposals price unquoted
/// outbound transfers, stored lots and disposals tell which way a transfer
/// moved, stored rejections keep the activities the last fold rejected out of
/// the flows.
struct StoredInputs {
    disposals: Vec<KernelDisposal>,
    lots: Vec<engine::model::LotRecord>,
    rejected: Vec<Diagnostic>,
}

async fn stored_inputs(
    context: &RunContext,
    accounts: &BTreeMap<String, NaiveDate>,
) -> Result<StoredInputs> {
    if accounts.is_empty() {
        return Ok(StoredInputs {
            disposals: Vec::new(),
            lots: Vec::new(),
            rejected: Vec::new(),
        });
    }
    let mut stored_disposals: Vec<LotDisposal> = Vec::new();
    let mut stored_lots = Vec::new();
    for account in accounts.keys() {
        stored_disposals.extend(context.lots.get_lot_disposals_for_account(account).await?);
        stored_lots.extend(context.lots.get_all_lots_for_account(account).await?);
    }
    let ids: Vec<String> = accounts.keys().cloned().collect();
    Ok(StoredInputs {
        disposals: super::rows::stored_disposals(&stored_disposals),
        lots: super::rows::stored_lots(&stored_lots),
        rejected: context
            .projections
            .activity_issues(&ids)?
            .into_iter()
            .filter(|issue| issue.kind == ActivityIssueKind::Rejected)
            .map(|r| Diagnostic::error(DiagnosticCode::ActivityRejected, r.activity_id, r.message))
            .collect(),
    })
}

struct WindowOutput {
    rows: Vec<WindowRows>,
    folded: Option<Folded>,
}

struct Folded {
    final_state: ProjectionState,
    keyframed: Vec<AccountId>,
    disposals: Vec<KernelDisposal>,
    closures: Vec<LotClosure>,
    /// The fold's diagnostics about activities (see [`issue_kind`]).
    issues: Vec<Diagnostic>,
}

/// The activity issue a kernel diagnostic records, if it is one.
fn issue_kind(code: DiagnosticCode) -> Option<ActivityIssueKind> {
    match code {
        DiagnosticCode::ActivityRejected => Some(ActivityIssueKind::Rejected),
        DiagnosticCode::InsufficientQuantity | DiagnosticCode::NoPositionToReduce => {
            Some(ActivityIssueKind::Oversold)
        }
        DiagnosticCode::MissingFinalCash => Some(ActivityIssueKind::MissingAmount),
        _ => None,
    }
}

impl Folded {
    fn from_bundle(bundle: ProjectionBundle) -> Self {
        Folded {
            keyframed: bundle
                .keyframes
                .iter()
                .filter(|(_, frames)| !frames.is_empty())
                .map(|(id, _)| id.clone())
                .collect(),
            issues: bundle
                .diagnostics
                .iter()
                .filter(|d| issue_kind(d.code).is_some())
                .cloned()
                .collect(),
            final_state: bundle.final_state,
            disposals: bundle.disposals,
            closures: bundle.closures,
        }
    }
}

/// Folds the window (when the run refolds), then loads its prices once for
/// every account it writes and values both kinds against them.
fn run_window(
    resolved: &Resolved,
    sources: &FactSources,
    window: DateRange,
    fold: Option<FoldStep>,
    revalue: &[Writer],
    stored: &StoredInputs,
) -> Result<WindowOutput> {
    let fx = engine::FxResolver {
        surface: &resolved.surfaces.fx,
        policy: resolved.facts.policy(),
    };
    let fold = match fold {
        Some(step) => {
            let bundle = engine::project_accounts(
                &resolved.ledger,
                &resolved.facts,
                &fx,
                step.state,
                window,
                Some(&step.accounts),
            )?;
            Some((bundle, step.seed, step.active))
        }
        None => None,
    };
    let refold: &[Writer] = fold.as_ref().map_or(&[], |(_, _, active)| active);
    let mut rows = Vec::new();
    if !refold.is_empty() || !revalue.is_empty() {
        let assets: BTreeSet<&String> = refold
            .iter()
            .chain(revalue)
            .filter_map(|writer| resolved.assets_by_account.get(&writer.account))
            .flatten()
            .collect();
        let assets: Vec<String> = assets.into_iter().cloned().collect();
        let quotes = facts::window_quotes(sources, &assets, window.start, window.end)?;
        let surfaces = resolved.window_surfaces(quotes);
        if let Some((bundle, seed, active)) = &fold {
            rows.extend(refold_rows(
                resolved, &surfaces, window, bundle, seed, active,
            ));
        }
        if !revalue.is_empty() {
            rows.extend(revalue_rows(
                resolved, sources, &surfaces, window, revalue, stored,
            )?);
        }
    }
    Ok(WindowOutput {
        rows,
        folded: fold.map(|(bundle, _, _)| Folded::from_bundle(bundle)),
    })
}

fn refold_rows(
    resolved: &Resolved,
    surfaces: &engine::ResolvedSurfaces,
    window: DateRange,
    bundle: &ProjectionBundle,
    seed: &BTreeMap<AccountId, AccountState>,
    active: &[Writer],
) -> Vec<WindowRows> {
    if active.is_empty() {
        return Vec::new();
    }
    let series = engine::value_window(
        &engine::ValueInputs {
            resolved: engine::Resolved {
                facts: &resolved.facts,
                ledger: &resolved.ledger,
                surfaces,
                range: window,
            },
            bundle,
            lots: None,
        },
        seed,
        Some(&valued(active)),
    );
    let base = resolved.facts.policy().base_currency.as_str();
    let mut rows = Vec::with_capacity(active.len());
    for writer in active {
        let id = AccountId::new(writer.account.as_str());
        let Some(account) = resolved.facts.accounts().get(&id) else {
            // No facts left (the account was emptied): clear its rows.
            rows.push(WindowRows {
                account_id: writer.account.clone(),
                start: writer.clear_from,
                end: row_end(resolved, window),
                snapshots: Some(Vec::new()),
                valuations: Vec::new(),
            });
            continue;
        };
        let first_day = writer.from.max(window.start);
        let frames: Vec<&Keyframe> = bundle
            .keyframes
            .get(&id)
            .map(|frames| frames.iter().filter(|f| f.date >= first_day).collect())
            .unwrap_or_default();
        rows.push(WindowRows {
            account_id: writer.account.clone(),
            start: writer.clear_from,
            end: row_end(resolved, window),
            snapshots: Some(persist::snapshot_rows(
                &frames,
                &writer.account,
                &account.currency,
            )),
            valuations: series
                .get(&id)
                .map(|s| persist::valuation_rows(s, &writer.account, base))
                .unwrap_or_default()
                .into_iter()
                .filter(|row| row.valuation_date >= first_day)
                .collect(),
        });
    }
    rows
}

fn revalue_rows(
    resolved: &Resolved,
    sources: &FactSources,
    surfaces: &engine::ResolvedSurfaces,
    window: DateRange,
    active: &[Writer],
    stored: &StoredInputs,
) -> Result<Vec<WindowRows>> {
    let mut keyframes: BTreeMap<AccountId, Vec<Keyframe>> = BTreeMap::new();
    let mut seed: BTreeMap<AccountId, AccountState> = BTreeMap::new();
    for writer in active {
        let id = AccountId::new(writer.account.as_str());
        let Some(account) = resolved.facts.accounts().get(&id) else {
            continue;
        };
        if account.tracking == TrackingMode::Holdings {
            continue;
        }
        if let Some(before) = window.start.pred_opt() {
            if let Some(snapshot) = sources
                .snapshots
                .get_latest_calculated_snapshot_on_or_before(&writer.account, before)?
            {
                seed.insert(
                    id.clone(),
                    persist::account_state_from_snapshot(&id, &account.currency, &snapshot),
                );
            }
        }
        let mut frames: Vec<Keyframe> = sources
            .snapshots
            .get_snapshots_by_account(&writer.account, Some(window.start), Some(window.end))?
            .iter()
            .filter(|s| s.source == SnapshotSource::Calculated)
            .map(|s| Keyframe {
                date: s.snapshot_date,
                state: persist::account_state_from_snapshot(&id, &account.currency, s),
            })
            .collect();
        frames.sort_by_key(|f| f.date);
        keyframes.insert(id, frames);
    }
    let bundle = ProjectionBundle {
        keyframes,
        final_state: ProjectionState {
            date: window.end,
            accounts: BTreeMap::new(),
            transfer_cache: BTreeMap::new(),
        },
        disposals: stored.disposals.clone(),
        closures: Vec::new(),
        diagnostics: stored.rejected.clone(),
    };
    let series = engine::value_window(
        &engine::ValueInputs {
            resolved: engine::Resolved {
                facts: &resolved.facts,
                ledger: &resolved.ledger,
                surfaces,
                range: window,
            },
            bundle: &bundle,
            lots: Some(&stored.lots),
        },
        &seed,
        Some(&valued(active)),
    );
    let base = resolved.facts.policy().base_currency.as_str();
    Ok(active
        .iter()
        .map(|writer| {
            let first_day = writer.from.max(window.start);
            WindowRows {
                account_id: writer.account.clone(),
                start: writer.clear_from,
                end: row_end(resolved, window),
                snapshots: None,
                valuations: series
                    .get(&AccountId::new(writer.account.as_str()))
                    .map(|s| persist::valuation_rows(s, &writer.account, base))
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|row| row.valuation_date >= first_day)
                    .collect(),
            }
        })
        .collect())
}
