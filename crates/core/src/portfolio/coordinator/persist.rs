//! Kernel stages over loaded facts, and kernel outputs in the row shapes the
//! existing repositories and readers already understand.

use std::collections::{BTreeMap, HashMap};

use chrono::{DateTime, Datelike, NaiveDate, Utc};
use rust_decimal::Decimal;
use wealthfolio_portfolio_engine as engine;
use wealthfolio_portfolio_engine::model::{
    AccountId, AccountState, AssetId, BasisStatus as KernelBasisStatus, CanonicalFacts, Currency,
    DateRange, FlowSource, Keyframe, Lot, ProjectionBundle, ProjectionState, ValuationSeries,
    ValueStatus,
};

use super::LoadedFacts;
use crate::errors::{Error, Result};
use crate::lots::{LotDisposal, LotRecord};
use crate::portfolio::economic_events::BasisStatus;
use crate::portfolio::projection::{AccountProjection, ProjectionCheckpoint, ProjectionWatermark};
use crate::portfolio::snapshot::{AccountStateSnapshot, Position, SnapshotSource};
use crate::portfolio::valuation::{DailyAccountValuation, ExternalFlowSource, ValuationStatus};
use crate::utils::time_utils::parse_user_timezone_or_default;

pub const KERNEL_ENGINE: &str = "kernel";

pub struct Computed {
    pub facts: CanonicalFacts,
    pub ledger: engine::CompiledLedger,
    pub surfaces: engine::ResolvedSurfaces,
    pub bundle: ProjectionBundle,
    pub series: BTreeMap<AccountId, ValuationSeries>,
    /// `Some(day)`: the run resumed from a checkpoint and only rows dated on
    /// or after `day` are new; `None`: a run from the first activity.
    pub since: Option<NaiveDate>,
    /// Closure state at every chunk end, the last one at `as_of`.
    pub checkpoints: Vec<ProjectionState>,
}

/// Where the projection takes checkpoints (architecture §3.3 chunk watermarks).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CheckpointCadence {
    /// The last day of every calendar year.
    #[default]
    YearEnd,
    /// Every `n` days from the range start (tests).
    EveryDays(u32),
}

impl CheckpointCadence {
    /// Chunk end days strictly before `range.end` (the range end is always a
    /// chunk end and is not listed).
    fn boundaries(self, range: DateRange) -> Vec<NaiveDate> {
        let mut days = Vec::new();
        match self {
            Self::YearEnd => {
                let mut year = range.start.year();
                while let Some(end) = NaiveDate::from_ymd_opt(year, 12, 31) {
                    if end >= range.end {
                        break;
                    }
                    if end >= range.start {
                        days.push(end);
                    }
                    year += 1;
                }
            }
            Self::EveryDays(n) => {
                let step = i64::from(n.max(1));
                let mut day = range.start + chrono::Duration::days(step - 1);
                while day < range.end {
                    days.push(day);
                    day += chrono::Duration::days(step);
                }
            }
        }
        days
    }
}

/// Facts normalised, compiled and surfaced once per job.
pub struct Resolved {
    pub facts: CanonicalFacts,
    pub ledger: engine::CompiledLedger,
    pub surfaces: engine::ResolvedSurfaces,
    /// First activity or observed snapshot day, clamped to `as_of`.
    pub genesis: NaiveDate,
}

pub fn resolve(loaded: &LoadedFacts) -> Result<Resolved> {
    let normalized = engine::normalize(loaded.raw.clone())?;
    let facts = normalized.facts;
    let ledger = engine::compile(&facts);
    // Facts dated after today (a scheduled deposit) must not invert the
    // range: the projection starts no later than `as_of` and the kernel
    // leaves future events for a later run.
    let genesis = facts
        .activities
        .iter()
        .map(|a| a.date)
        .chain(facts.observed_snapshots.iter().map(|s| s.date))
        .min()
        .unwrap_or(loaded.as_of)
        .min(loaded.as_of);
    let surfaces = engine::resolve_surfaces(
        &facts,
        DateRange {
            start: genesis,
            end: loaded.as_of,
        },
    );
    Ok(Resolved {
        facts,
        ledger,
        surfaces,
        genesis,
    })
}

/// Projects the loaded closure, from the first activity or from `resume`
/// (the closure state at the day before the new range), in chunks whose
/// end states become checkpoints, then values every day of the run.
pub fn compute(
    loaded: &LoadedFacts,
    resume: Option<ProjectionState>,
    cadence: CheckpointCadence,
) -> Result<Computed> {
    let Resolved {
        facts,
        ledger,
        surfaces,
        genesis,
    } = resolve(loaded)?;
    let fx = engine::FxResolver {
        surface: &surfaces.fx,
        policy: &facts.policy,
    };
    let since = resume
        .as_ref()
        .map(|state| state.date + chrono::Duration::days(1));
    let range = DateRange {
        start: since.unwrap_or(genesis),
        end: loaded.as_of,
    };

    // Chunked fold: every chunk end state is a checkpoint (I2 makes the
    // chunked run equal to one fold over the whole range).
    let mut state = resume.clone();
    let mut chunk_start = range.start;
    let mut keyframes: BTreeMap<AccountId, Vec<Keyframe>> = BTreeMap::new();
    let mut disposals = Vec::new();
    let mut closures = Vec::new();
    let mut diagnostics = Vec::new();
    let mut checkpoints = Vec::new();
    let mut ends = cadence.boundaries(range);
    ends.push(range.end);
    let mut final_state = None;
    for end in ends {
        if end < chunk_start {
            continue;
        }
        let chunk = DateRange {
            start: chunk_start,
            end,
        };
        let bundle = engine::project(&ledger, &facts, &fx, state.take(), chunk)?;
        for (account, frames) in bundle.keyframes {
            keyframes.entry(account).or_default().extend(frames);
        }
        disposals.extend(bundle.disposals);
        closures.extend(bundle.closures);
        diagnostics.extend(bundle.diagnostics);
        checkpoints.push(bundle.final_state.clone());
        state = Some(bundle.final_state.clone());
        final_state = Some(bundle.final_state);
        chunk_start = end + chrono::Duration::days(1);
    }
    let bundle = ProjectionBundle {
        keyframes,
        final_state: final_state.expect("at least one chunk"),
        disposals,
        closures,
        diagnostics,
    };

    // Valuation sees the resumed state as a keyframe on the day before the
    // new range, so the first new days carry the right positions; that
    // synthetic keyframe is never persisted.
    let mut value_bundle = bundle.clone();
    if let Some(resumed) = &resume {
        for (account, state) in &resumed.accounts {
            // An account that held nothing at the checkpoint has no history
            // to carry: its first valuation row must come from its first
            // event, exactly as in a fold from genesis. Seeding a keyframe
            // here would emit zero-valued rows before the account existed.
            if is_empty_state(state) {
                continue;
            }
            value_bundle
                .keyframes
                .entry(account.clone())
                .or_default()
                .insert(
                    0,
                    Keyframe {
                        date: resumed.date,
                        state: state.clone(),
                    },
                );
        }
    }
    let value_range = DateRange {
        start: resume.as_ref().map(|s| s.date).unwrap_or(genesis),
        end: loaded.as_of,
    };
    let series = engine::value(&engine::ValueInputs {
        resolved: engine::Resolved {
            facts: &facts,
            ledger: &ledger,
            surfaces: &surfaces,
            range: value_range,
        },
        bundle: &value_bundle,
    });
    Ok(Computed {
        facts,
        ledger,
        surfaces,
        bundle,
        series,
        since,
        checkpoints,
    })
}

/// Nothing held, owed or contributed yet: the account did not exist as far
/// as valuation is concerned.
fn is_empty_state(state: &AccountState) -> bool {
    state.positions.is_empty()
        && state.cash.values().all(|amount| amount.is_zero())
        && state.cost_basis.is_zero()
        && state.net_contribution.is_zero()
        && state.net_contribution_base.is_zero()
}

/// The closure state at `date` rebuilt from the stored checkpoints of the
/// closure's accounts; `None` when an account that needs one has none.
pub fn resume_state(
    loaded: &LoadedFacts,
    checkpoints: &[ProjectionCheckpoint],
    date: NaiveDate,
) -> Option<ProjectionState> {
    let tz = parse_user_timezone_or_default(&loaded.timezone);
    let mut accounts = BTreeMap::new();
    let mut transfer_cache: BTreeMap<String, Vec<Lot>> = BTreeMap::new();
    for account in &loaded.raw.accounts {
        if account.is_archived || account.tracking_mode != "TRANSACTIONS" {
            continue;
        }
        let has_history = loaded.raw.activities.iter().any(|a| {
            a.account_id == account.id && a.timestamp.with_timezone(&tz).date_naive() <= date
        });
        let Some(row) = checkpoints
            .iter()
            .find(|c| c.account_id == account.id && c.date == date)
        else {
            if has_history {
                return None;
            }
            continue;
        };
        let state: AccountState = serde_json::from_str(&row.state).ok()?;
        let cache: BTreeMap<String, Vec<Lot>> = serde_json::from_str(&row.transfer_cache).ok()?;
        for (group, lots) in cache {
            transfer_cache.entry(group).or_insert(lots);
        }
        accounts.insert(AccountId::new(&account.id), state);
    }
    Some(ProjectionState {
        date,
        accounts,
        transfer_cache,
    })
}

/// Valuations of one account from its stored keyframes under the current
/// surfaces: the revalue-only path for a market-data change or a new day,
/// no projection and no lot rows. Holdings accounts value their observed
/// snapshots, which the loaded facts already carry.
pub fn revalue(
    loaded: &LoadedFacts,
    account_id: &str,
    snapshots: &[AccountStateSnapshot],
    disposals: &[LotDisposal],
) -> Result<Vec<DailyAccountValuation>> {
    let resolved = resolve(loaded)?;
    let kernel_id = AccountId::new(account_id);
    let account = resolved
        .facts
        .accounts
        .get(&kernel_id)
        .ok_or_else(|| Error::Unexpected(format!("account {account_id} missing from facts")))?;
    let mut keyframes: Vec<Keyframe> = snapshots
        .iter()
        .filter(|s| s.source == SnapshotSource::Calculated)
        .map(|s| Keyframe {
            date: s.snapshot_date,
            state: account_state_from_snapshot(&kernel_id, &account.currency, s),
        })
        .collect();
    keyframes.sort_by_key(|k| k.date);
    let final_state = ProjectionState {
        date: loaded.as_of,
        accounts: keyframes
            .last()
            .map(|k| BTreeMap::from([(kernel_id.clone(), k.state.clone())]))
            .unwrap_or_default(),
        transfer_cache: BTreeMap::new(),
    };
    let bundle = ProjectionBundle {
        keyframes: BTreeMap::from([(kernel_id.clone(), keyframes)]),
        final_state,
        disposals: super::rows::stored_disposals(disposals),
        closures: Vec::new(),
        diagnostics: Vec::new(),
    };
    let series = engine::value(&engine::ValueInputs {
        resolved: engine::Resolved {
            facts: &resolved.facts,
            ledger: &resolved.ledger,
            surfaces: &resolved.surfaces,
            range: DateRange {
                start: resolved.genesis,
                end: loaded.as_of,
            },
        },
        bundle: &bundle,
    });
    Ok(series
        .get(&kernel_id)
        .map(|series| valuation_rows(series, account_id, &loaded.base_currency))
        .unwrap_or_default())
}

fn account_state_from_snapshot(
    account: &AccountId,
    currency: &Currency,
    snapshot: &AccountStateSnapshot,
) -> AccountState {
    let positions = snapshot
        .positions
        .values()
        .map(|p| {
            (
                AssetId::new(&p.asset_id),
                engine::model::Position {
                    asset: AssetId::new(&p.asset_id),
                    currency: Currency::parse(&p.currency).unwrap_or_else(|| currency.clone()),
                    quantity: p.quantity,
                    average_cost: p.average_cost,
                    total_cost_basis: p.total_cost_basis,
                    lots: Vec::new(),
                    alternative: p.is_alternative,
                    contract_multiplier: p.contract_multiplier,
                    inception: p.inception_date,
                    cost_basis_account: p.cost_basis_account,
                    cost_basis_base: p.cost_basis_base,
                },
            )
        })
        .collect();
    AccountState {
        account: account.clone(),
        currency: currency.clone(),
        positions,
        cash: snapshot
            .cash_balances
            .iter()
            .filter_map(|(c, amount)| Currency::parse(c).map(|c| (c, *amount)))
            .collect(),
        cost_basis: snapshot.cost_basis,
        net_contribution: snapshot.net_contribution,
        net_contribution_base: snapshot.net_contribution_base,
        cash_total_account: snapshot.cash_total_account_currency,
        cash_total_base: snapshot.cash_total_base_currency,
    }
}

fn stamp() -> String {
    crate::utils::clock::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/// One account's rows plus its watermark.
pub fn account_projection(
    loaded: &LoadedFacts,
    computed: &Computed,
    account_id: &str,
) -> Result<AccountProjection> {
    let kernel_id = AccountId::new(account_id);
    let account = computed
        .facts
        .accounts
        .get(&kernel_id)
        .ok_or_else(|| Error::Unexpected(format!("account {account_id} missing from facts")))?;
    let holdings = account.tracking == engine::model::TrackingMode::Holdings;
    let fingerprint = loaded
        .fingerprints
        .get(account_id)
        .map(|f| serde_json::to_string(f).unwrap_or_default())
        .unwrap_or_default();

    let (snapshots, lots, disposals) = if holdings {
        (None, None, None)
    } else {
        (
            Some(snapshot_rows(computed, account_id, &account.currency)),
            Some(lot_rows(computed, account_id)),
            Some(disposal_rows(computed, account_id)),
        )
    };
    let valuations: Vec<DailyAccountValuation> = computed
        .series
        .get(&kernel_id)
        .map(|series| valuation_rows(series, account_id, &loaded.base_currency))
        .unwrap_or_default()
        .into_iter()
        .filter(|row| {
            computed
                .since
                .is_none_or(|since| row.valuation_date >= since)
        })
        .collect();
    let checkpoints = if holdings {
        None
    } else {
        Some(
            computed
                .checkpoints
                .iter()
                .filter_map(|state| {
                    let account_state = state.accounts.get(&kernel_id)?;
                    Some(ProjectionCheckpoint {
                        account_id: account_id.to_string(),
                        date: state.date,
                        state: serde_json::to_string(account_state).ok()?,
                        transfer_cache: serde_json::to_string(&state.transfer_cache).ok()?,
                    })
                })
                .collect(),
        )
    };

    Ok(AccountProjection {
        account_id: account_id.to_string(),
        snapshots,
        lots,
        disposals,
        valuations,
        watermark: ProjectionWatermark {
            account_id: account_id.to_string(),
            engine: KERNEL_ENGINE.to_string(),
            fingerprint,
            as_of: loaded.as_of,
            computed_at: crate::utils::clock::now(),
        },
        since: computed.since,
        checkpoints,
    })
}

pub fn snapshot_rows(
    computed: &Computed,
    account_id: &str,
    currency: &engine::model::Currency,
) -> Vec<AccountStateSnapshot> {
    let kernel_id = AccountId::new(account_id);
    let now = crate::utils::clock::now();
    computed
        .bundle
        .keyframes
        .get(&kernel_id)
        .map(|frames| {
            frames
                .iter()
                .map(|frame| {
                    let state = &frame.state;
                    let positions: HashMap<String, Position> = state
                        .positions
                        .iter()
                        .map(|(asset, p)| {
                            (
                                asset.as_str().to_string(),
                                Position {
                                    id: format!("{}-{}", account_id, asset),
                                    account_id: account_id.to_string(),
                                    asset_id: asset.as_str().to_string(),
                                    quantity: p.quantity,
                                    average_cost: p.average_cost,
                                    total_cost_basis: p.total_cost_basis,
                                    currency: p.currency.as_str().to_string(),
                                    inception_date: p.inception,
                                    lots: Default::default(),
                                    created_at: p.inception,
                                    last_updated: now,
                                    is_alternative: p.alternative,
                                    contract_multiplier: p.contract_multiplier,
                                    cost_basis_account: p.cost_basis_account,
                                    cost_basis_base: p.cost_basis_base,
                                },
                            )
                        })
                        .collect();
                    AccountStateSnapshot {
                        id: AccountStateSnapshot::stable_id(account_id, frame.date),
                        account_id: account_id.to_string(),
                        snapshot_date: frame.date,
                        currency: currency.as_str().to_string(),
                        positions,
                        cash_balances: state
                            .cash
                            .iter()
                            .map(|(c, a)| (c.as_str().to_string(), *a))
                            .collect(),
                        cost_basis: state.cost_basis,
                        net_contribution: state.net_contribution,
                        net_contribution_base: state.net_contribution_base,
                        cash_total_account_currency: state.cash_total_account,
                        cash_total_base_currency: state.cash_total_base,
                        calculated_at: now.naive_utc(),
                        source: SnapshotSource::Calculated,
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn lot_rows(computed: &Computed, account_id: &str) -> Vec<LotRecord> {
    let fx = engine::FxResolver {
        surface: &computed.surfaces.fx,
        policy: &computed.facts.policy,
    };
    let base = computed.facts.policy.base_currency.as_str().to_string();
    let account_currency = computed
        .facts
        .accounts
        .get(&AccountId::new(account_id))
        .map(|a| a.currency.as_str().to_string());
    let now = stamp();
    engine::lot_records(&computed.bundle, &computed.facts, &fx)
        .into_iter()
        .filter(|lot| lot.account.as_str() == account_id)
        .map(|lot| LotRecord {
            id: lot.id,
            account_id: account_id.to_string(),
            asset_id: lot.asset.as_str().to_string(),
            open_date: lot.open_date.to_string(),
            open_activity_id: lot.open_activity.map(|a| a.as_str().to_string()),
            original_quantity: lot.original_quantity.to_string(),
            remaining_quantity: lot.remaining_quantity.to_string(),
            cost_per_unit: lot.cost_per_unit.to_string(),
            original_cost_basis: lot.original_cost_basis.to_string(),
            remaining_cost_basis: lot.remaining_cost_basis.to_string(),
            original_cost_basis_base: lot.original_cost_basis_base.to_string(),
            remaining_cost_basis_base: lot.remaining_cost_basis_base.to_string(),
            fee_allocated: lot.fee_allocated.to_string(),
            fee_allocated_base: lot.fee_allocated_base.to_string(),
            tax_allocated: lot.tax_allocated.to_string(),
            tax_allocated_base: lot.tax_allocated_base.to_string(),
            currency: lot.currency.as_str().to_string(),
            base_currency: base.clone(),
            fx_rate_to_base: lot.fx_rate_to_base.to_string(),
            fx_rate_to_account: lot.fx_rate_to_account.map(|r| r.to_string()),
            account_currency: lot.fx_rate_to_account.and(account_currency.clone()),
            cost_basis_method: "FIFO".to_string(),
            split_ratio: lot.split_ratio.to_string(),
            is_closed: lot.close_date.is_some(),
            close_date: lot.close_date.map(|d| d.to_string()),
            close_activity_id: lot
                .close_event
                .as_ref()
                .and_then(|e| activity_of(computed, e)),
            created_at: now.clone(),
            updated_at: now.clone(),
        })
        .collect()
}

pub fn disposal_rows(computed: &Computed, account_id: &str) -> Vec<LotDisposal> {
    let base = computed.facts.policy.base_currency.as_str().to_string();
    let now = stamp();
    let mut rows: Vec<&engine::model::LotDisposal> = computed
        .bundle
        .disposals
        .iter()
        .filter(|d| d.account.as_str() == account_id)
        .collect();
    rows.sort_by(|a, b| {
        a.date
            .cmp(&b.date)
            .then_with(|| a.event.cmp(&b.event))
            .then_with(|| a.id.cmp(&b.id))
    });
    rows.into_iter()
        .map(|d| LotDisposal {
            id: d.id.clone(),
            lot_id: d.lot_id.clone(),
            account_id: account_id.to_string(),
            asset_id: d.asset.as_str().to_string(),
            // Composite legs (`{activity}:buy`) reference their activity:
            // `lot_disposals.disposal_activity_id` is a NOT NULL foreign key.
            disposal_activity_id: activity_of(computed, &d.event).unwrap_or_default(),
            disposal_date: d.date.to_string(),
            quantity: d.quantity.to_string(),
            proceeds: d.proceeds.to_string(),
            cost_basis: d.cost_basis.to_string(),
            realized_pnl: d.realized_pnl.to_string(),
            proceeds_base: d.proceeds_base.to_string(),
            cost_basis_base: d.cost_basis_base.to_string(),
            realized_pnl_base: d.realized_pnl_base.to_string(),
            currency: d.currency.as_str().to_string(),
            base_currency: base.clone(),
            fx_rate_to_base: d.fx_rate_to_base.to_string(),
            cost_basis_method: "FIFO".to_string(),
            created_at: now.clone(),
        })
        .collect()
}

/// The stored activity an event derives from (composite legs map to their
/// parent activity).
fn activity_of(computed: &Computed, event: &engine::model::EventId) -> Option<String> {
    engine::project::source_activity(&computed.ledger, event).map(|a| a.as_str().to_string())
}

fn flow_source(source: FlowSource) -> ExternalFlowSource {
    let code = serde_json::to_value(source)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default();
    ExternalFlowSource::from_code(&code)
}

fn value_status(status: ValueStatus) -> ValuationStatus {
    match status {
        ValueStatus::Complete => ValuationStatus::Complete,
        ValueStatus::PartialUnpriced => ValuationStatus::PartialUnpriced,
        ValueStatus::Unavailable => ValuationStatus::Unavailable,
    }
}

fn basis_status(status: KernelBasisStatus) -> BasisStatus {
    match status {
        KernelBasisStatus::Complete => BasisStatus::Complete,
        KernelBasisStatus::PartialUnknown => BasisStatus::PartialUnknown,
        KernelBasisStatus::Unknown => BasisStatus::Unknown,
        KernelBasisStatus::NotApplicable => BasisStatus::NotApplicable,
    }
}

pub fn valuation_rows(
    series: &ValuationSeries,
    account_id: &str,
    base_currency: &str,
) -> Vec<DailyAccountValuation> {
    let now: DateTime<Utc> = crate::utils::clock::now();
    let r = |v: Decimal| v.round_dp(crate::constants::DECIMAL_PRECISION);
    series
        .days
        .iter()
        .map(|day| DailyAccountValuation {
            id: format!("{}_{}", account_id, day.date),
            account_id: account_id.to_string(),
            valuation_date: day.date,
            account_currency: series.currency.as_str().to_string(),
            base_currency: base_currency.to_string(),
            fx_rate_to_base: r(day.fx_rate_to_base),
            cash_balance: r(day.cash_balance),
            investment_market_value: r(day.investment_market_value),
            total_value: r(day.total_value),
            cost_basis: r(day.cost_basis),
            book_basis: r(day.book_basis),
            net_contribution: r(day.net_contribution),
            cash_balance_base: r(day.cash_balance_base),
            investment_market_value_base: r(day.investment_market_value_base),
            total_value_base: r(day.total_value_base),
            cost_basis_base: r(day.cost_basis_base),
            book_basis_base: r(day.book_basis_base),
            net_contribution_base: r(day.net_contribution_base),
            external_inflow_base: r(day.flow.inflow_base),
            external_outflow_base: r(day.flow.outflow_base),
            external_flow_source: flow_source(day.flow.source),
            performance_eligible_value_base: r(day.performance_eligible_value_base),
            value_status: value_status(day.value_status),
            basis_status: basis_status(day.basis_status),
            calculated_at: now,
        })
        .collect()
}
