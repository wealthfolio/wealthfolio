//! Kernel stages over loaded facts, and kernel outputs in the row shapes the
//! existing repositories and readers already understand.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use chrono::{DateTime, Datelike, NaiveDate, Utc};
use rust_decimal::Decimal;
use wealthfolio_portfolio_engine as engine;
use wealthfolio_portfolio_engine::model::{
    AccountId, AccountState, AssetId, BasisStatus as KernelBasisStatus, CanonicalFacts, Currency,
    DateRange, FlowSource, Keyframe, ValuationSeries, ValueStatus,
};

use super::LoadedFacts;
use crate::errors::Result;
use crate::lots::{LotDisposal, LotRecord};
use crate::portfolio::economic_events::BasisStatus;
use crate::portfolio::snapshot::{AccountStateSnapshot, Position, SnapshotSource};
use crate::portfolio::valuation::{DailyAccountValuation, ExternalFlowSource, ValuationStatus};

/// How a run cuts its range into windows: each window is folded, valued and
/// written before the next is read, so memory holds one window at a time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WindowCadence {
    /// Calendar years.
    #[default]
    Year,
    /// `n` days (tests).
    Days(u32),
}

impl WindowCadence {
    /// The windows covering `range`, in order.
    pub fn windows(self, range: DateRange) -> Vec<DateRange> {
        let mut windows = Vec::new();
        let mut start = range.start;
        while start <= range.end {
            let end = match self {
                Self::Year => NaiveDate::from_ymd_opt(start.year(), 12, 31).unwrap_or(range.end),
                Self::Days(n) => start + chrono::Duration::days(i64::from(n.max(1)) - 1),
            }
            .min(range.end);
            windows.push(DateRange { start, end });
            let Some(next) = end.succ_opt() else {
                break;
            };
            start = next;
        }
        windows
    }
}

/// Facts normalised and compiled once per job, with the FX surface and the
/// provider-adjusted splits of the whole range. Quotes are surfaced per
/// window.
pub struct Resolved {
    pub facts: CanonicalFacts,
    pub ledger: engine::CompiledLedger,
    pub surfaces: engine::ResolvedSurfaces,
    /// First activity or observed snapshot day, clamped to `as_of`.
    pub genesis: NaiveDate,
    /// Assets each account's activities and observed snapshots reference:
    /// the holders of an asset, and the prices valuing an account needs.
    pub assets_by_account: BTreeMap<String, BTreeSet<String>>,
}

impl Resolved {
    pub fn range(&self) -> DateRange {
        DateRange {
            start: self.genesis,
            end: self.facts.policy().as_of,
        }
    }

    /// The surfaces of one window: its quotes (each asset's last observation
    /// before the window included) over the whole-range FX and splits (a
    /// holdings window starts from a snapshot that may predate it).
    pub fn window_surfaces(
        &self,
        quotes: Vec<engine::model::RawQuote>,
    ) -> engine::ResolvedSurfaces {
        let mut diagnostics = Vec::new();
        let observations = engine::normalize_quotes(quotes, self.facts.assets(), &mut diagnostics);
        engine::ResolvedSurfaces {
            quotes: engine::QuoteSurface::from_observations(&observations),
            fx: self.surfaces.fx.clone(),
            splits: self.surfaces.splits.clone(),
            recorded_splits: self.surfaces.recorded_splits.clone(),
        }
    }
}

pub fn resolve(loaded: &LoadedFacts) -> Result<Resolved> {
    let normalized = engine::normalize(loaded.raw.clone())?;
    let facts = normalized.facts;
    let ledger = engine::compile(&facts);
    // Facts dated after today (a scheduled deposit) must not invert the
    // range: the projection starts no later than `as_of` and the kernel
    // leaves future events for a later run.
    let genesis = facts
        .activities()
        .iter()
        .map(|a| a.date)
        .chain(facts.observed_snapshots().iter().map(|s| s.date))
        .min()
        .unwrap_or(loaded.as_of)
        .min(loaded.as_of);
    // The loaded quotes are only those around split dates: enough to tell
    // which splits the provider already adjusted, over the whole range.
    let surfaces = engine::resolve_surfaces(
        &facts,
        DateRange {
            start: genesis,
            end: loaded.as_of,
        },
    );
    let mut assets_by_account: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for activity in facts.activities() {
        if let Some(asset) = &activity.asset {
            assets_by_account
                .entry(activity.account.as_str().to_string())
                .or_default()
                .insert(asset.as_str().to_string());
        }
    }
    for snapshot in facts.observed_snapshots() {
        for asset in snapshot.positions.keys() {
            assets_by_account
                .entry(snapshot.account.as_str().to_string())
                .or_default()
                .insert(asset.as_str().to_string());
        }
    }
    Ok(Resolved {
        facts,
        ledger,
        surfaces,
        genesis,
        assets_by_account,
    })
}

pub fn account_state_from_snapshot(
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

pub fn snapshot_rows(
    frames: &[&Keyframe],
    account_id: &str,
    currency: &engine::model::Currency,
) -> Vec<AccountStateSnapshot> {
    let now = crate::utils::clock::now();
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
}

pub fn lot_rows(
    resolved: &Resolved,
    records: Vec<engine::model::LotRecord>,
    account_id: &str,
) -> Vec<LotRecord> {
    let base = resolved.facts.policy().base_currency.as_str().to_string();
    let account_currency = resolved
        .facts
        .accounts()
        .get(&AccountId::new(account_id))
        .map(|a| a.currency.as_str().to_string());
    let now = stamp();
    records
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
                .and_then(|e| activity_of(resolved, e)),
            created_at: now.clone(),
            updated_at: now.clone(),
        })
        .collect()
}

pub fn disposal_rows(
    resolved: &Resolved,
    disposals: &[&engine::model::LotDisposal],
    account_id: &str,
) -> Vec<LotDisposal> {
    let base = resolved.facts.policy().base_currency.as_str().to_string();
    let now = stamp();
    let mut rows: Vec<&engine::model::LotDisposal> = disposals
        .iter()
        .copied()
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
            disposal_activity_id: activity_of(resolved, &d.event).unwrap_or_default(),
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
fn activity_of(resolved: &Resolved, event: &engine::model::EventId) -> Option<String> {
    resolved
        .ledger
        .source_of(event)
        .map(|a| a.as_str().to_string())
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
