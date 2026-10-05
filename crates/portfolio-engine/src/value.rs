//! Stage 5: price the projected (or observed) states day by day and
//! finalize external flows — a pure port of the legacy valuation calculator
//! and the valuation service's flow assembly.
//!
//! Every calendar day from an account's first keyframe to `as_of` is valued
//! with the latest quote on or before the day (unbounded carry), minor-unit
//! normalization, provider-adjusted split factors, and acquisition-date FX
//! for book cost. Flows come from the ledger's events (cash amounts,
//! transfer-day market values, removed-lot basis, holdings transitions) and
//! fall back to net-contribution deltas.

use std::collections::{BTreeMap, BTreeSet};

use chrono::NaiveDate;
use rust_decimal::Decimal;

use crate::arith;
use crate::compile::CompiledLedger;
use crate::diagnostics::{Diagnostic, DiagnosticCode};
use crate::error::EngineError;
use crate::model::*;
use crate::project::{in_position_currency, lot_records, position_book_cost, QUANTITY_THRESHOLD};
use crate::resolve::{FxResolver, ResolvedSurfaces};

/// A quote or FX rate carried at least this many days is reported once per
/// account and asset or pair.
const CARRIED_INFO_DAYS: i64 = 7;

/// Facts after the pure stages that need no projection: canonical facts,
/// the compiled ledger and the resolved surfaces over `range`. Both the
/// projection write path and the stored-row read path start here.
#[derive(Clone, Copy)]
pub struct Resolved<'a> {
    pub facts: &'a CanonicalFacts,
    pub ledger: &'a CompiledLedger,
    pub surfaces: &'a ResolvedSurfaces,
    pub range: DateRange,
}

impl<'a> Resolved<'a> {
    pub fn fx(&self) -> FxResolver<'a> {
        FxResolver {
            surface: &self.surfaces.fx,
            policy: &self.facts.policy,
        }
    }
}

/// Inputs of the valuation write path: the projection to price.
pub struct ValueInputs<'a> {
    pub resolved: Resolved<'a>,
    pub bundle: &'a ProjectionBundle,
    /// The valued accounts' stored lots, when `bundle` carries none (a
    /// revalue from stored rows): a transfer's direction reads them.
    pub lots: Option<&'a [LotRecord]>,
}

/// A keyframe as valuation sees it: projected state or observed snapshot.
#[derive(Debug, Clone)]
struct ValuationKeyframe {
    date: NaiveDate,
    observed: bool,
    positions: BTreeMap<AssetId, PricedPosition>,
    cash: BTreeMap<Currency, Decimal>,
    net_contribution: Decimal,
    net_contribution_base: Decimal,
}

#[derive(Debug, Clone)]
struct PricedPosition {
    quantity: Decimal,
    total_cost_basis: Decimal,
    currency: Currency,
    alternative: bool,
    contract_multiplier: Decimal,
    cost_basis_account: Option<Decimal>,
    cost_basis_base: Option<Decimal>,
}

impl PricedPosition {
    /// Legacy `Position::basis_status` as production sees it: persisted
    /// keyframes carry no lots, so the status follows the position total.
    fn basis_status(&self) -> BasisStatus {
        if self.alternative || self.quantity.is_zero() {
            BasisStatus::NotApplicable
        } else if !self.total_cost_basis.is_zero() {
            BasisStatus::Complete
        } else {
            BasisStatus::Unknown
        }
    }
}

/// Dense daily valuations per account (transactions-mode from the projection,
/// holdings-mode from observed snapshots), each with finalized flows.
pub fn value(inputs: &ValueInputs<'_>) -> BTreeMap<AccountId, ValuationSeries> {
    value_series(inputs, None, None)
}

/// [`value`] for one window of a chunked run: `inputs.bundle` is the window's
/// projection and `resolved.range` the window. `seed` holds, for every
/// account with history before the window, its state on the day before (the
/// previous window's end state, or a stored keyframe). Rows start at the
/// window start; concatenated over windows they equal one [`value`] over the
/// whole range (P-WIN). `accounts` restricts the work to the accounts a run
/// rewrites (`None`: every account); the others are not valued.
pub fn value_window(
    inputs: &ValueInputs<'_>,
    seed: &BTreeMap<AccountId, AccountState>,
    accounts: Option<&BTreeSet<AccountId>>,
) -> BTreeMap<AccountId, ValuationSeries> {
    value_series(inputs, Some(seed), accounts)
}

fn value_series(
    inputs: &ValueInputs<'_>,
    seed: Option<&BTreeMap<AccountId, AccountState>>,
    only: Option<&BTreeSet<AccountId>>,
) -> BTreeMap<AccountId, ValuationSeries> {
    let resolved = &inputs.resolved;
    let rejected = inputs.bundle.rejected_activities();
    let projected;
    let lots = match inputs.lots {
        Some(lots) => lots,
        None => {
            projected = lot_records(inputs.bundle, resolved.facts, &resolved.fx());
            &projected
        }
    };
    let transfers = transfer_records(resolved.ledger, lots, &inputs.bundle.disposals);
    // Valuation reads only the flows of the accounts it values, inside the
    // range: pricing anything else would be thrown away.
    let (effects, mut pricing_diagnostics) = priced_events(
        resolved,
        &inputs.bundle.disposals,
        &transfers,
        &rejected,
        Some(EventSelection {
            range: resolved.range,
            accounts: only,
        }),
    );
    let mut series = BTreeMap::new();
    for (account_id, account) in resolved
        .facts
        .accounts
        .iter()
        .filter(|(id, _)| only.is_none_or(|only| only.contains(*id)))
    {
        if account.archived {
            continue;
        }
        let keyframes = keyframes_for(account_id, account, inputs, seed);
        let Some(first) = keyframes.first().map(|k| k.date) else {
            continue;
        };
        let mut valuer = Valuer::new(
            resolved,
            &inputs.bundle.disposals,
            account_id,
            &account.currency,
        );
        let end = resolved.range.end;
        // A window is valued from the day before it (holdings flows compare
        // consecutive days), not from its first keyframe: for a holdings
        // account that is the last snapshot before the window, however old.
        let from = match seed {
            Some(_) => resolved
                .range
                .start
                .pred_opt()
                .map_or(first, |day| day.max(first)),
            None => first,
        };
        let mut days = Vec::new();
        let mut active = 0usize;
        for day in from.iter_days().take_while(|day| *day <= end) {
            while active + 1 < keyframes.len() && keyframes[active + 1].date <= day {
                active += 1;
            }
            days.push(valuer.value_day(&keyframes[active], day));
        }

        // Flows: a holdings account's come only from its snapshots, which
        // already hold what it records (a deposit recorded between two
        // snapshots would count twice); any other's from its activity map,
        // then fallbacks.
        if account.tracking == TrackingMode::Holdings {
            if let Some(first) = days.first_mut() {
                first.flow = DailyFlow::default();
            }
        } else {
            let flows = scope_flows(
                &effects,
                std::slice::from_ref(account_id),
                Window::default(),
            );
            stamp_flows(&mut days, &flows);
        }
        valuer.infer_holdings_flows(&mut days, &keyframes);
        if seed.is_some() {
            // The seed day only carries the state into the window.
            days.retain(|day| day.date >= resolved.range.start);
            if days.is_empty() {
                continue;
            }
        }
        valuer.report_carries();
        let mut diagnostics = valuer.diagnostics;
        diagnostics.extend(pricing_diagnostics.remove(account_id).unwrap_or_default());

        series.insert(
            account_id.clone(),
            ValuationSeries {
                account: account_id.clone(),
                currency: account.currency.clone(),
                days,
                diagnostics,
            },
        );
    }
    series
}

/// The scoped read performance consumes (legacy
/// `get_historical_valuations_for_accounts`): per-day sums in base currency
/// of the accounts' stored rows, flows included, less the legs of transfer
/// pairs whose accounts are both in scope.
pub fn aggregate_scope(
    effects: &Effects,
    series: &BTreeMap<AccountId, ValuationSeries>,
    scope: &[AccountId],
    window: Window,
) -> Result<ValuationSeries, EngineError> {
    let base = effects.base_currency.clone();
    if let Some(archived) = scope
        .iter()
        .find(|id| effects.account(id).is_some_and(|a| a.archived))
    {
        return Err(EngineError::ArchivedAccountInScope(
            archived.as_str().to_string(),
        ));
    }
    // Stored rows inside the window, as the persisted read returns them.
    let histories: Vec<ValuationSeries> = scope
        .iter()
        .filter_map(|id| series.get(id))
        .map(|history| ValuationSeries {
            account: history.account.clone(),
            currency: history.currency.clone(),
            days: history
                .days
                .iter()
                .filter(|day| window.contains(day.date))
                .map(DailyValuation::stored)
                .collect(),
            diagnostics: Vec::new(),
        })
        .collect();
    validate_completeness(scope, &histories)?;

    // Each account adds its own row's flows (its activities', a fallback, or
    // those inferred at its snapshots) less its legs of transfer pairs inside
    // the scope, so another account's flow on the same day never changes an
    // account's share.
    let adjustments = internal_adjustments(effects, scope, window);
    let scope_start = histories
        .iter()
        .filter_map(|history| history.days.first())
        .map(|day| day.date)
        .min();
    let mut by_date: BTreeMap<NaiveDate, DailyValuation> = BTreeMap::new();
    for history in &histories {
        let holdings = effects
            .account(&history.account)
            .is_some_and(|account| account.tracking == TrackingMode::Holdings);
        let inception = series
            .get(&history.account)
            .and_then(|own| own.days.first())
            .map(|day| day.date);
        for day in &history.days {
            let flow = if day.flow.source == FlowSource::NoFlow
                && Some(day.date) == inception
                && Some(day.date) != scope_start
            {
                opening_flow(effects, &history.account, day, holdings, window)
            } else {
                day.flow
            };
            let flow = match adjustments.get(&(&history.account, day.date)) {
                Some(legs) => net_internal(flow, *legs),
                None => flow,
            };
            let entry = by_date.entry(day.date).or_insert_with(|| DailyValuation {
                date: day.date,
                fx_rate_to_base: Decimal::ONE,
                cash_balance: Decimal::ZERO,
                investment_market_value: Decimal::ZERO,
                total_value: Decimal::ZERO,
                cost_basis: Decimal::ZERO,
                book_basis: Decimal::ZERO,
                net_contribution: Decimal::ZERO,
                cash_balance_base: Decimal::ZERO,
                investment_market_value_base: Decimal::ZERO,
                total_value_base: Decimal::ZERO,
                cost_basis_base: Decimal::ZERO,
                book_basis_base: Decimal::ZERO,
                net_contribution_base: Decimal::ZERO,
                performance_eligible_value_base: Decimal::ZERO,
                value_status: ValueStatus::Complete,
                basis_status: BasisStatus::NotApplicable,
                flow: DailyFlow::default(),
            });
            entry.cash_balance += day.cash_balance_base;
            entry.investment_market_value += day.investment_market_value_base;
            entry.total_value += day.total_value_base;
            entry.cost_basis += day.cost_basis_base;
            entry.book_basis += day.book_basis_base;
            entry.net_contribution += day.net_contribution_base;
            entry.cash_balance_base += day.cash_balance_base;
            entry.investment_market_value_base += day.investment_market_value_base;
            entry.total_value_base += day.total_value_base;
            entry.cost_basis_base += day.cost_basis_base;
            entry.book_basis_base += day.book_basis_base;
            entry.net_contribution_base += day.net_contribution_base;
            entry.flow.inflow_base += flow.inflow_base;
            entry.flow.outflow_base += flow.outflow_base;
            entry.flow.source = entry.flow.source.combine(flow.source);
            entry.performance_eligible_value_base += day.performance_eligible_value_base;
            entry.value_status = entry.value_status.combine(day.value_status);
            entry.basis_status = entry.basis_status.combine(day.basis_status);
        }
    }
    let mut days: Vec<DailyValuation> = by_date.into_values().collect();

    // The first day opens the scope and carries no flow.
    if let Some(first) = days.first_mut() {
        first.flow = DailyFlow::default();
    }

    Ok(ValuationSeries {
        account: AccountId::new(
            scope
                .iter()
                .map(|id| id.as_str())
                .collect::<Vec<_>>()
                .join(","),
        ),
        currency: base,
        days,
        diagnostics: Vec::new(),
    })
}

/// What an account's first day adds to a scope that already exists. Its row
/// has no flow (the money that opens an account is its starting value), but
/// at the scope that money arrives. A holdings account brings its first
/// snapshot's value, as a transition from nothing would (unknown when that
/// snapshot is not fully priced); a transactions account what its activities
/// brought in that day, else its net contribution.
fn opening_flow(
    effects: &Effects,
    account: &AccountId,
    day: &DailyValuation,
    holdings: bool,
    window: Window,
) -> DailyFlow {
    if holdings {
        if day.value_status != ValueStatus::Complete {
            return DailyFlow {
                inflow_base: Decimal::ZERO,
                outflow_base: Decimal::ZERO,
                source: FlowSource::UnpricedHoldingsTransition,
            };
        }
        if day.total_value_base.is_zero() {
            return DailyFlow::default();
        }
        let (inflow_base, outflow_base) = split_flow(day.total_value_base);
        return DailyFlow {
            inflow_base,
            outflow_base,
            source: FlowSource::QuoteDerivedMarketValue,
        };
    }
    if let Some(flow) = scope_flows(effects, std::slice::from_ref(account), window).get(&day.date) {
        return *flow;
    }
    if day.net_contribution_base.is_zero() {
        return DailyFlow::default();
    }
    let (inflow_base, outflow_base) = split_flow(day.net_contribution_base);
    DailyFlow {
        inflow_base,
        outflow_base,
        source: FlowSource::NetContributionFallback,
    }
}

/// An account's flow less its legs of transfer pairs inside the scope. Its
/// flows are its legs, each on its side, so each side loses its legs (at
/// most what it holds).
fn net_internal(flow: DailyFlow, (inflow, outflow): (Decimal, Decimal)) -> DailyFlow {
    // Netting removes scope-internal legs; it adds no differently valued
    // flow, so the day keeps the provenance of the flows that survive.
    DailyFlow {
        inflow_base: flow.inflow_base - flow.inflow_base.min(inflow),
        outflow_base: flow.outflow_base - flow.outflow_base.min(outflow),
        source: flow.source,
    }
}

/// An optional date window on a read (`None` bounds are open).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Window {
    pub start: Option<NaiveDate>,
    pub end: Option<NaiveDate>,
}

impl Window {
    pub fn contains(self, date: NaiveDate) -> bool {
        self.start.is_none_or(|start| date >= start) && self.end.is_none_or(|end| date <= end)
    }
}

/// Legacy `validate_scoped_history_completeness`.
fn validate_completeness(
    scope: &[AccountId],
    histories: &[ValuationSeries],
) -> Result<(), EngineError> {
    if histories.len() != scope.len() {
        return Err(EngineError::ScopeHistoryCount {
            expected: scope.len(),
            found: histories.len(),
        });
    }
    let union: BTreeSet<NaiveDate> = histories
        .iter()
        .flat_map(|h| h.days.iter().map(|d| d.date))
        .collect();
    let scope_last = union.iter().next_back().copied();
    for history in histories {
        let Some(first) = history.days.first().map(|d| d.date) else {
            continue;
        };
        let last = history.days.last().map(|d| d.date).unwrap_or(first);
        let dates: BTreeSet<NaiveDate> = history.days.iter().map(|d| d.date).collect();
        if let Some(missing) = union
            .iter()
            .find(|date| **date >= first && **date <= last && !dates.contains(date))
        {
            return Err(EngineError::ScopeHistoryGap {
                account: history.account.as_str().to_string(),
                missing: *missing,
            });
        }
        if let Some(scope_last) = scope_last {
            if last < scope_last
                && history
                    .days
                    .last()
                    .is_some_and(|d| !d.total_value_base.is_zero())
            {
                return Err(EngineError::ScopeHistoryEndsEarly {
                    account: history.account.as_str().to_string(),
                    last,
                    scope_last,
                });
            }
        }
    }
    Ok(())
}

fn keyframes_for(
    account_id: &AccountId,
    account: &AccountFacts,
    inputs: &ValueInputs<'_>,
    seed: Option<&BTreeMap<AccountId, AccountState>>,
) -> Vec<ValuationKeyframe> {
    let resolved = &inputs.resolved;
    let mut by_date: BTreeMap<NaiveDate, ValuationKeyframe> = BTreeMap::new();
    if account.tracking == TrackingMode::Holdings {
        // A window needs only the last observation before it, then its own.
        let floor = seed.and_then(|_| {
            resolved
                .facts
                .observed_snapshots
                .iter()
                .filter(|s| s.account == *account_id && s.date < resolved.range.start)
                .map(|s| s.date)
                .max()
        });
        for observed in resolved.facts.observed_snapshots.iter().filter(|s| {
            s.account == *account_id
                && s.date <= resolved.range.end
                && floor.is_none_or(|floor| s.date >= floor)
                && (seed.is_none() || floor.is_some() || s.date >= resolved.range.start)
        }) {
            let positions = observed
                .positions
                .iter()
                .map(|(asset, position)| {
                    let facts = resolved.facts.assets.get(asset);
                    (
                        asset.clone(),
                        PricedPosition {
                            quantity: position.quantity,
                            total_cost_basis: position.total_cost_basis,
                            currency: position
                                .currency
                                .clone()
                                .or_else(|| facts.and_then(|a| a.quote_currency.clone()))
                                .unwrap_or_else(|| account.currency.clone()),
                            alternative: facts.is_some_and(|a| a.alternative),
                            contract_multiplier: facts
                                .map(|a| a.contract_multiplier)
                                .unwrap_or(Decimal::ONE),
                            cost_basis_account: position.cost_basis_account,
                            cost_basis_base: position.cost_basis_base,
                        },
                    )
                })
                .collect();
            by_date.insert(
                observed.date,
                ValuationKeyframe {
                    date: observed.date,
                    observed: true,
                    positions,
                    cash: observed.cash.clone(),
                    net_contribution: observed.net_contribution,
                    net_contribution_base: observed.net_contribution_base,
                },
            );
        }
    } else {
        // A window starts from the account's state on the day before it.
        let seeded = seed
            .and_then(|seed| seed.get(account_id))
            .and_then(|state| {
                Some(Keyframe {
                    date: resolved.range.start.pred_opt()?,
                    state: state.without_lots(),
                })
            });
        let own = inputs
            .bundle
            .keyframes
            .get(account_id)
            .map(Vec::as_slice)
            .unwrap_or_default();
        // An account with no events has no keyframes: present its (empty)
        // final state on the range end, as one row (in a chunked run, only
        // the last window's end is the range end).
        let last_window = seed.is_none() || resolved.range.end == resolved.facts.policy.as_of;
        let synthetic = (own.is_empty() && seeded.is_none() && last_window)
            .then(|| inputs.bundle.final_state.accounts.get(account_id))
            .flatten()
            .map(|state| Keyframe {
                date: resolved.range.end,
                state: state.without_lots(),
            });
        let frames = seeded.iter().chain(own).chain(synthetic.iter());
        for frame in frames.filter(|f| f.date <= resolved.range.end) {
            let positions = frame
                .state
                .positions
                .iter()
                .map(|(asset, position)| {
                    (
                        asset.clone(),
                        PricedPosition {
                            quantity: position.quantity,
                            total_cost_basis: position.total_cost_basis,
                            currency: position.currency.clone(),
                            alternative: position.alternative,
                            contract_multiplier: position.contract_multiplier,
                            cost_basis_account: position.cost_basis_account,
                            cost_basis_base: position.cost_basis_base,
                        },
                    )
                })
                .collect();
            by_date.insert(
                frame.date,
                ValuationKeyframe {
                    date: frame.date,
                    observed: false,
                    positions,
                    cash: frame.state.cash.clone(),
                    net_contribution: frame.state.net_contribution,
                    net_contribution_base: frame.state.net_contribution_base,
                },
            );
        }
    }
    by_date.into_values().collect()
}

struct Valuer<'a> {
    resolved: &'a Resolved<'a>,
    /// Disposals of the projected range (removed-lot basis for outbound
    /// security transfers).
    disposals: &'a [LotDisposal],
    fx: FxResolver<'a>,
    account: AccountId,
    account_currency: String,
    diagnostics: Vec<Diagnostic>,
    reported: BTreeSet<String>,
    /// Longest carry seen per asset: (age in days, observation day, valued day).
    carried: BTreeMap<AssetId, (i64, NaiveDate, NaiveDate)>,
    /// Longest distance seen per FX pair: (days, valued day).
    carried_fx: BTreeMap<(String, String), (i64, NaiveDate)>,
    /// Cost in base of the lots each incoming transfer booked, when pricing
    /// flows (`TransferRecords::booked`).
    booked: Option<&'a BTreeMap<(AccountId, ActivityId), BookedCost>>,
}

impl<'a> Valuer<'a> {
    fn new(
        resolved: &'a Resolved<'a>,
        disposals: &'a [LotDisposal],
        account: &AccountId,
        account_currency: &Currency,
    ) -> Self {
        let policy = &resolved.facts.policy;
        Self {
            resolved,
            disposals,
            fx: FxResolver {
                surface: &resolved.surfaces.fx,
                policy,
            },
            account: account.clone(),
            account_currency: policy.major_currency(account_currency.as_str()).to_string(),
            diagnostics: Vec::new(),
            reported: BTreeSet::new(),
            carried: BTreeMap::new(),
            carried_fx: BTreeMap::new(),
            booked: None,
        }
    }

    /// FX through the surface, remembering how far the observation used was
    /// from the valued day so a long carry is reported (I10).
    fn fx_rate(&mut self, from: &str, to: &str, day: NaiveDate) -> Option<Decimal> {
        let (rate, age) = self.fx.rate_with_age(from, to, day)?;
        if age > 0 {
            let entry = self
                .carried_fx
                .entry((from.to_string(), to.to_string()))
                .or_insert((0, day));
            if age > entry.0 {
                *entry = (age, day);
            }
        }
        Some(rate)
    }

    fn base(&self) -> &str {
        self.resolved
            .facts
            .policy
            .major_currency(self.resolved.facts.policy.base_currency.as_str())
    }

    /// One informational diagnostic per asset whose quote, and per FX pair
    /// whose rate, was carried a week or more somewhere in the range:
    /// weekends and holidays stay silent, a stale series is visible (I10)
    /// without a row per day.
    fn report_carries(&mut self) {
        let carried_fx = std::mem::take(&mut self.carried_fx);
        for ((from, to), (age, valued)) in carried_fx {
            if age < CARRIED_INFO_DAYS {
                continue;
            }
            let key = format!("{}:{from}->{to}", self.account);
            if self.reported.insert(format!("CarriedFxRate:{key}")) {
                self.diagnostics.push(Diagnostic::info(
                    DiagnosticCode::CarriedFxRate,
                    key,
                    format!(
                        "{from}->{to} rate taken from an observation up to {age} days away (valued {valued})"
                    ),
                ));
            }
        }
        let carried = std::mem::take(&mut self.carried);
        for (asset, (age, observed, valued)) in carried {
            if age < CARRIED_INFO_DAYS {
                continue;
            }
            let key = format!("{}:{asset}", self.account);
            if self.reported.insert(format!("CarriedQuote:{key}")) {
                self.diagnostics.push(Diagnostic::info(
                    DiagnosticCode::CarriedQuote,
                    key,
                    format!(
                        "quote for {asset} carried up to {age} days (last observation {observed}, valued through {valued})"
                    ),
                ));
            }
        }
    }

    fn report(&mut self, code: DiagnosticCode, key: String, message: String) {
        if self.reported.insert(format!("{code:?}:{key}")) {
            self.diagnostics
                .push(Diagnostic::warning(code, key, message));
        }
    }

    /// Legacy `calculate_valuation_with_price_factors`. A snapshot states
    /// quantities as of its own date: on a later day they are carried across
    /// every split in between (rules R1.5). A projected state's lots are
    /// already split.
    fn value_day(&mut self, keyframe: &ValuationKeyframe, day: NaiveDate) -> DailyValuation {
        let policy = &self.resolved.facts.policy;
        let account_currency = self.account_currency.clone();
        let base = self.base().to_string();
        let surfaces = self.resolved.surfaces;

        // Investments.
        let mut investment = Decimal::ZERO;
        let mut eligible = Decimal::ZERO;
        let mut priced = 0u32;
        let mut unpriced = 0u32;
        let mut basis_status = BasisStatus::NotApplicable;
        let mut unavailable = false;
        for (asset, position) in &keyframe.positions {
            if position.alternative || position.quantity.is_zero() {
                continue;
            }
            basis_status = basis_status.combine(position.basis_status());
            let Some(quote) = surfaces.quotes.latest_on_or_before(asset, day) else {
                unpriced += 1;
                self.report(
                    DiagnosticCode::MissingQuote,
                    format!("{}:{asset}", self.account),
                    format!("no quote on or before {day} for {asset}; position unpriced"),
                );
                continue;
            };
            let age = (day - quote.day).num_days();
            if age > 0 {
                let entry = self
                    .carried
                    .entry(asset.clone())
                    .or_insert((0, quote.day, day));
                if age > entry.0 {
                    *entry = (age, quote.day, day);
                }
            }
            let (quote_major, factor) = policy.normalize_currency(quote.currency.as_str());
            let rate = if quote_major == account_currency {
                Some(Decimal::ONE)
            } else {
                self.fx_rate(quote_major, &account_currency, day)
            };
            let Some(rate) = rate else {
                unpriced += 1;
                unavailable = true;
                self.report(
                    DiagnosticCode::FxUnavailable,
                    format!("{}:{quote_major}->{account_currency}", self.account),
                    format!("no {quote_major}->{account_currency} rate on {day}; {asset} unpriced"),
                );
                continue;
            };
            let quantity_factor = if keyframe.observed {
                surfaces.split_quantity_factor(asset, keyframe.date, day)
            } else {
                Some(Decimal::ONE)
            };
            let market_value = surfaces
                .split_price_factor(asset, day)
                .zip(quantity_factor)
                .and_then(|(split_factor, quantity_factor)| {
                    arith::product(&[
                        position.quantity,
                        quantity_factor,
                        quote.close,
                        factor,
                        split_factor,
                        position.contract_multiplier,
                        rate,
                    ])
                });
            let Some(market_value) = market_value else {
                unpriced += 1;
                unavailable = true;
                self.report(
                    DiagnosticCode::ValueOutOfRange,
                    format!("{}:value:{asset}", self.account),
                    format!("the value of {asset} on {day} is outside the kernel range; position unpriced"),
                );
                continue;
            };
            investment += market_value;
            priced += 1;
            if position.basis_status() == BasisStatus::Complete {
                eligible += market_value;
            }
        }

        // Cash.
        let mut cash = Decimal::ZERO;
        for (currency, amount) in &keyframe.cash {
            let (major, factor) = policy.normalize_currency(currency.as_str());
            let rate = if major == account_currency {
                Some(Decimal::ONE)
            } else {
                self.fx_rate(major, &account_currency, day)
            };
            match rate {
                Some(rate) => match arith::product(&[*amount, factor, rate]) {
                    Some(converted) => cash += converted,
                    None => {
                        unavailable = true;
                        self.report(
                            DiagnosticCode::ValueOutOfRange,
                            format!("{}:cash:{major}", self.account),
                            format!("cash {amount} {major} on {day} is outside the kernel range once converted; cash bucket excluded"),
                        );
                    }
                },
                None => {
                    unavailable = true;
                    self.report(
                        DiagnosticCode::FxUnavailable,
                        format!("{}:cash:{major}->{account_currency}", self.account),
                        format!(
                            "no {major}->{account_currency} rate on {day}; cash bucket excluded"
                        ),
                    );
                }
            }
        }

        let (cost_basis, converted) =
            self.cost_basis_in(keyframe, day, &account_currency, |p| p.cost_basis_account);
        if !converted {
            basis_status = basis_status.combine(BasisStatus::Unknown);
        }
        let fx_rate_to_base = if account_currency == base {
            Some(Decimal::ONE)
        } else {
            self.fx_rate(&account_currency, &base, day)
        };
        let base_values = fx_rate_to_base.map(|rate| {
            Some((
                rate,
                arith::mul(cash, rate)?,
                arith::mul(investment, rate)?,
                arith::mul(eligible + cash, rate)?,
            ))
        });
        let Some(Some((fx_rate_to_base, cash_base, investment_base, eligible_base))) = base_values
        else {
            if base_values.is_some() {
                self.report(
                    DiagnosticCode::ValueOutOfRange,
                    format!("{}:base", self.account),
                    format!("the {day} value in {base} is outside the kernel range; base values unavailable"),
                );
            } else {
                self.report(
                    DiagnosticCode::FxUnavailable,
                    format!("{}:{account_currency}->{base}", self.account),
                    format!("no {account_currency}->{base} rate on {day}; base values unavailable"),
                );
            }
            return DailyValuation {
                date: day,
                fx_rate_to_base: Decimal::ZERO,
                cash_balance: cash,
                investment_market_value: investment,
                total_value: investment + cash,
                cost_basis,
                book_basis: cost_basis + cash,
                net_contribution: keyframe.net_contribution,
                cash_balance_base: Decimal::ZERO,
                investment_market_value_base: Decimal::ZERO,
                total_value_base: Decimal::ZERO,
                cost_basis_base: Decimal::ZERO,
                book_basis_base: Decimal::ZERO,
                net_contribution_base: keyframe.net_contribution_base,
                performance_eligible_value_base: Decimal::ZERO,
                value_status: ValueStatus::Unavailable,
                basis_status,
                flow: DailyFlow::default(),
            };
        };
        let (cost_basis_base, converted) =
            self.cost_basis_in(keyframe, day, &base, |p| p.cost_basis_base);
        if !converted {
            basis_status = basis_status.combine(BasisStatus::Unknown);
        }
        let value_status = if unavailable {
            ValueStatus::Unavailable
        } else if unpriced == 0 {
            ValueStatus::Complete
        } else if priced == 0 && cash.is_zero() {
            ValueStatus::Unavailable
        } else {
            ValueStatus::PartialUnpriced
        };
        DailyValuation {
            date: day,
            fx_rate_to_base,
            cash_balance: cash,
            investment_market_value: investment,
            total_value: investment + cash,
            cost_basis,
            book_basis: cost_basis + cash,
            net_contribution: keyframe.net_contribution,
            cash_balance_base: cash_base,
            investment_market_value_base: investment_base,
            total_value_base: cash_base + investment_base,
            cost_basis_base,
            book_basis_base: cost_basis_base + cash_base,
            net_contribution_base: keyframe.net_contribution_base,
            performance_eligible_value_base: eligible_base,
            value_status,
            basis_status,
            flow: DailyFlow::default(),
        }
    }

    /// The positions' book cost in `target` (the fold's rule, see
    /// [`position_book_cost`]); whether every cost converted. Keyframes carry
    /// no lots, so a full run and a revalue from stored rows convert the same
    /// way.
    fn cost_basis_in(
        &mut self,
        keyframe: &ValuationKeyframe,
        day: NaiveDate,
        target: &str,
        at_acquisition: impl Fn(&PricedPosition) -> Option<Decimal>,
    ) -> (Decimal, bool) {
        let mut total = Decimal::ZERO;
        let mut converted = true;
        for (asset, position) in &keyframe.positions {
            match position_book_cost(
                &self.fx,
                position.alternative,
                position.currency.as_str(),
                position.total_cost_basis,
                at_acquisition(position),
                target,
                day,
            ) {
                Ok(cost) => total += cost,
                Err((code, reason)) => {
                    converted = false;
                    self.report(
                        code,
                        format!("{}:basis:{asset}", self.account),
                        format!("{reason}; book cost of {asset} unknown"),
                    );
                }
            }
        }
        (total, converted)
    }

    /// Whether the fold projects the event's account (not archived, not
    /// holdings-tracked).
    fn projected(&self, event: &EconomicEvent) -> bool {
        self.resolved
            .facts
            .accounts
            .get(&event.account)
            .is_some_and(|a| !a.archived && a.tracking != TrackingMode::Holdings)
    }

    /// The units a security transfer moves. An outgoing leg moves what its
    /// account held: units its history lacks (it starts after they were
    /// acquired) leave nothing. An incoming leg receives what its activity
    /// records.
    fn transfer_units(
        &self,
        event: &EconomicEvent,
        direction: Direction,
        recorded: Decimal,
    ) -> Decimal {
        if direction == Direction::Out && self.projected(event) {
            self.disposals
                .iter()
                .filter(|d| d.event == event.id && d.account == event.account)
                .map(|d| d.quantity.abs())
                .sum()
        } else {
            recorded
        }
    }

    /// Legacy transfer-flow ladder + removed-lot-basis substitution.
    fn price_flow(
        &mut self,
        event: &EconomicEvent,
        boundary: ScopeBoundary,
    ) -> (Decimal, FlowSource) {
        let policy = &self.resolved.facts.policy;
        let unknown = boundary == ScopeBoundary::Unknown;
        match &event.flow.value {
            FlowValue::None => (
                Decimal::ZERO,
                if unknown {
                    FlowSource::UnknownBoundaryTransfer
                } else {
                    FlowSource::Unknown
                },
            ),
            FlowValue::Cash(gross) => {
                if unknown {
                    return (Decimal::ZERO, FlowSource::UnknownBoundaryTransfer);
                }
                let source = if gross.is_zero() {
                    FlowSource::Unknown
                } else {
                    FlowSource::CashAmount
                };
                self.priced(*gross, event.currency.as_str(), event, source)
            }
            FlowValue::SecurityAtMarket {
                quantity,
                book_basis,
                legacy_amount,
            } => {
                let (asset, direction, unit_price) = match &event.action {
                    Action::SecurityTransfer {
                        asset,
                        direction,
                        unit_price,
                        ..
                    } => (asset, *direction, *unit_price),
                    _ => return (Decimal::ZERO, FlowSource::Unknown),
                };
                let multiplier = self
                    .resolved
                    .facts
                    .assets
                    .get(asset)
                    .map(|a| a.contract_multiplier)
                    .unwrap_or(Decimal::ONE);
                let quantity = self.transfer_units(event, direction, *quantity);
                if quantity.is_zero() && direction == Direction::Out && self.projected(event) {
                    return (
                        Decimal::ZERO,
                        if unknown {
                            FlowSource::UnknownBoundaryTransfer
                        } else {
                            FlowSource::NoFlow
                        },
                    );
                }
                if let Some(quote) = self
                    .resolved
                    .surfaces
                    .quotes
                    .latest_on_or_before(asset, event.date)
                {
                    let (quote_major, factor) = policy.normalize_currency(quote.currency.as_str());
                    // The transferred units are the units held on the day, so
                    // they are priced like the position (`value_day`): with
                    // the factor of every provider-adjusted split after it.
                    let market_value = self
                        .resolved
                        .surfaces
                        .split_price_factor(asset, event.date)
                        .and_then(|split_factor| {
                            arith::product(&[
                                quantity,
                                quote.close,
                                factor,
                                split_factor,
                                multiplier,
                            ])
                        });
                    let Some(market_value) = market_value else {
                        self.report(
                            DiagnosticCode::ValueOutOfRange,
                            format!("flow:{}", event.source),
                            format!(
                                "the market value of {} is outside the kernel range; flow unpriced",
                                event.source
                            ),
                        );
                        return (
                            Decimal::ZERO,
                            if unknown {
                                FlowSource::UnknownBoundaryTransfer
                            } else {
                                FlowSource::Unknown
                            },
                        );
                    };
                    if !market_value.is_zero() {
                        let source = if unknown {
                            FlowSource::UnknownBoundaryTransfer
                        } else {
                            FlowSource::QuoteDerivedMarketValue
                        };
                        return self.priced(market_value.abs(), quote_major, event, source);
                    }
                }
                if direction == Direction::Out {
                    // Deferred: the removed lots' basis (already in base).
                    let removed: Decimal = self
                        .disposals
                        .iter()
                        .filter(|d| d.event == event.id && !d.cost_basis_base.is_zero())
                        .map(|d| d.cost_basis_base.abs())
                        .sum();
                    return if !removed.is_zero() {
                        (
                            removed,
                            if unknown {
                                FlowSource::UnknownBoundaryTransfer
                            } else {
                                FlowSource::RemovedLotBasisFallback
                            },
                        )
                    } else {
                        (
                            Decimal::ZERO,
                            if unknown {
                                FlowSource::UnknownBoundaryTransfer
                            } else {
                                FlowSource::Unknown
                            },
                        )
                    };
                }
                let uses_legacy_amount = unit_price.is_zero() && legacy_amount.is_some();
                let source = if unknown {
                    FlowSource::UnknownBoundaryTransfer
                } else if uses_legacy_amount {
                    FlowSource::LegacyActivityAmountFallback
                } else {
                    FlowSource::CostBasisFallback
                };
                // A paired leg receives the sender's lots at their cost, not
                // at the activity's price: it flows the cost it booked (less
                // its own fee, when capitalised into lots it opened), as the
                // outgoing leg flows the cost it removed (rules R2.4).
                let paired = self
                    .resolved
                    .facts
                    .transfer_pairs
                    .pair_for(&event.source)
                    .is_some();
                let booked = self
                    .booked
                    .and_then(|b| b.get(&(event.account.clone(), event.source.clone())))
                    .cloned();
                if let (true, Some(booked)) = (paired, booked) {
                    // The fee comes off as it was capitalised: in the lots'
                    // currency, at their rates (rules R2.4).
                    let fee = match &booked.fee_rate {
                        Some((currency, rate)) if !event.charges.fee.is_zero() => {
                            let account_currency = self
                                .resolved
                                .facts
                                .accounts
                                .get(&event.account)
                                .map(|account| account.currency.as_str())
                                .unwrap_or_default();
                            in_position_currency(
                                &self.fx,
                                event,
                                [Decimal::ZERO, event.charges.fee, Decimal::ZERO],
                                currency.as_str(),
                                account_currency,
                            )
                            .ok()
                            .and_then(|(_, fee, _, _)| arith::mul(fee, *rate))
                        }
                        _ => Some(Decimal::ZERO),
                    };
                    if let Some(fee) = fee {
                        // A short's cost is negative; its direction is the
                        // leg's (`TransferRecords::short`).
                        return ((booked.cost - fee).abs(), source);
                    }
                }
                if let Some(basis) = book_basis {
                    return self.priced(basis.abs(), event.currency.as_str(), event, source);
                }
                if let Some(amount) = legacy_amount {
                    let source = if unknown {
                        FlowSource::UnknownBoundaryTransfer
                    } else {
                        FlowSource::LegacyActivityAmountFallback
                    };
                    return self.priced(amount.abs(), event.currency.as_str(), event, source);
                }
                (Decimal::ZERO, FlowSource::UnknownBoundaryTransfer)
            }
        }
    }

    /// A flow amount in base with its provenance. A real flow that cannot be
    /// converted is Unknown, so it gates returns instead of vanishing as a
    /// zero cash amount (I10).
    fn priced(
        &mut self,
        amount: Decimal,
        currency: &str,
        event: &EconomicEvent,
        source: FlowSource,
    ) -> (Decimal, FlowSource) {
        match self.flow_to_base(amount, currency, event) {
            Some(converted) => (converted, source),
            None if source == FlowSource::UnknownBoundaryTransfer => (Decimal::ZERO, source),
            None => (Decimal::ZERO, FlowSource::Unknown),
        }
    }

    fn flow_to_base(
        &mut self,
        amount: Decimal,
        currency: &str,
        event: &EconomicEvent,
    ) -> Option<Decimal> {
        if amount.is_zero() {
            return Some(Decimal::ZERO);
        }
        let policy = &self.resolved.facts.policy;
        let from = policy.major_currency(currency).to_string();
        let base = self.base().to_string();
        // From the currency as recorded: pence convert through their
        // factor, as cash and net contribution do.
        match self.fx.convert(amount, currency, &base, event.date) {
            Some(converted) => Some(converted),
            None => {
                self.report(
                    DiagnosticCode::FxUnavailable,
                    format!("flow:{}", event.source),
                    format!(
                        "no {from}->{base} rate on {} for the external flow of {}; flow unpriced",
                        event.date, event.source
                    ),
                );
                None
            }
        }
    }

    /// Legacy `apply_inferred_holdings_external_flows`.
    fn infer_holdings_flows(
        &mut self,
        days: &mut [DailyValuation],
        keyframes: &[ValuationKeyframe],
    ) {
        if days.len() < 2 {
            return;
        }
        let keyframe_at = |date: NaiveDate| -> Option<&ValuationKeyframe> {
            let index = keyframes.partition_point(|k| k.date <= date);
            (index > 0).then(|| &keyframes[index - 1])
        };
        for index in 1..days.len() {
            let prev_date = days[index - 1].date;
            let curr_date = days[index].date;
            let (Some(prev), Some(curr)) = (keyframe_at(prev_date), keyframe_at(curr_date)) else {
                continue;
            };
            if prev.date == curr.date || !prev.observed || !curr.observed {
                continue;
            }
            let prev_at_curr = self.value_day(prev, curr_date);
            if prev_at_curr.value_status != ValueStatus::Complete
                || days[index].value_status != ValueStatus::Complete
            {
                days[index].flow = DailyFlow {
                    inflow_base: Decimal::ZERO,
                    outflow_base: Decimal::ZERO,
                    source: FlowSource::UnpricedHoldingsTransition,
                };
                continue;
            }
            let flow = days[index].total_value_base - prev_at_curr.total_value_base;
            if flow.is_zero() {
                continue;
            }
            let (inflow, outflow) = split_flow(flow);
            days[index].flow = DailyFlow {
                inflow_base: inflow,
                outflow_base: outflow,
                source: FlowSource::QuoteDerivedMarketValue,
            };
        }
    }
}

/// Every event priced once for scope aggregation and `measure`: its flow in
/// base (as an external flow, or as one of unknown boundary), its attribution
/// and trade charges in base, the resolved pairs and each account's profile.
/// `disposals` supply the removed-lot basis of unquoted outbound transfers;
/// `rejected` activities contributed nothing to the projection and are left
/// out.
pub fn effects(
    resolved: &Resolved<'_>,
    disposals: &[LotDisposal],
    lots: &[LotRecord],
    rejected: &BTreeSet<ActivityId>,
) -> Effects {
    let transfers = transfer_records(resolved.ledger, lots, disposals);
    priced_events(resolved, disposals, &transfers, rejected, None).0
}

/// What each security transfer leg's own account recorded, so no path needs
/// the partner's records (a window, a revalue and a read each have only
/// their own accounts').
struct TransferRecords {
    /// Transfers that moved a short position. A short is a liability:
    /// sending it out is an inflow, receiving it an outflow. An outgoing leg
    /// that disposed only short lots, an incoming leg that opened short lots
    /// or, opening none, covered long ones.
    short: BTreeSet<ActivityId>,
    /// What each incoming leg delivered to its account.
    booked: BTreeMap<(AccountId, ActivityId), BookedCost>,
}

#[derive(Clone)]
struct BookedCost {
    /// Cost in base of the lots the leg opened and the opposite position it
    /// covered.
    cost: Decimal,
    /// The opened lots' currency and their rate to the base weighted by
    /// units, as the fee capitalised into them is shared; `None` when the
    /// leg opened none, so its cost carries no fee.
    fee_rate: FeeRate,
}

type FeeRate = Option<(Currency, Decimal)>;

/// What an incoming leg opened in its account.
struct Opened {
    units: Decimal,
    /// `None` when a lot has no rate to the base, or its weight leaves the
    /// kernel range.
    cost: Option<Decimal>,
    currency: Currency,
    /// Σ units × rate to the base, and Σ units, of its lots.
    rated: Decimal,
    weight: Decimal,
}

fn transfer_records(
    ledger: &CompiledLedger,
    lots: &[LotRecord],
    disposals: &[LotDisposal],
) -> TransferRecords {
    let mut opened: BTreeMap<(AccountId, ActivityId), Opened> = BTreeMap::new();
    for lot in lots {
        if let Some(activity) = &lot.open_activity {
            let entry = opened
                .entry((lot.account.clone(), activity.clone()))
                .or_insert_with(|| Opened {
                    units: Decimal::ZERO,
                    cost: Some(Decimal::ZERO),
                    currency: lot.currency.clone(),
                    rated: Decimal::ZERO,
                    weight: Decimal::ZERO,
                });
            entry.units += lot.original_quantity;
            let known = !lot.fx_rate_to_base.is_zero() || lot.original_cost_basis.is_zero();
            // The fee is shared by the units each lot held when it opened.
            let weighted = arith::mul(lot.original_quantity, lot.split_ratio).and_then(|weight| {
                let weight = weight.abs();
                Some((weight, arith::mul(weight, lot.fx_rate_to_base)?))
            });
            entry.cost = entry
                .cost
                .filter(|_| known && weighted.is_some())
                .map(|cost| cost + lot.original_cost_basis_base);
            if let Some((weight, rated)) = weighted {
                entry.weight += weight;
                entry.rated += rated;
            }
        }
    }
    let mut short = BTreeSet::new();
    let mut covered: BTreeMap<(AccountId, ActivityId), Option<Decimal>> = BTreeMap::new();
    for event in &ledger.events {
        let Action::SecurityTransfer { direction, .. } = event.action else {
            continue;
        };
        let own: Vec<&LotDisposal> = disposals
            .iter()
            .filter(|d| d.event == event.id && d.account == event.account && !d.quantity.is_zero())
            .collect();
        let disposed: Vec<Decimal> = own.iter().map(|d| d.quantity).collect();
        if matches!(direction, Direction::In) && !own.is_empty() {
            // Units an incoming leg used to cover an opposite position were
            // delivered too, at the cost the cover's proceeds record, signed
            // like the units delivered (against the lots they closed).
            let cost = covered
                .entry((event.account.clone(), event.source.clone()))
                .or_insert(Some(Decimal::ZERO));
            for disposal in &own {
                // Base proceeds are zero only when unknown (`record_disposals`).
                let known = !disposal.proceeds_base.is_zero() || disposal.proceeds.is_zero();
                let delivered = if disposal.quantity.is_sign_negative() {
                    disposal.proceeds_base.abs()
                } else {
                    -disposal.proceeds_base.abs()
                };
                *cost = cost.filter(|_| known).map(|cost| cost + delivered);
            }
        }
        let moved_short = match direction {
            Direction::Out => !disposed.is_empty() && disposed.iter().all(|q| q.is_sign_negative()),
            Direction::In => match opened.get(&(event.account.clone(), event.source.clone())) {
                Some(opened) if !opened.units.is_zero() => opened.units.is_sign_negative(),
                _ => !disposed.is_empty() && disposed.iter().all(|q| q.is_sign_positive()),
            },
        };
        if moved_short {
            short.insert(event.source.clone());
        }
    }
    let mut booked: BTreeMap<(AccountId, ActivityId), (Option<Decimal>, FeeRate)> = opened
        .into_iter()
        .map(|(key, opened)| {
            let fee_rate =
                arith::div(opened.rated, opened.weight).map(|rate| (opened.currency, rate));
            (key, (opened.cost, fee_rate))
        })
        .collect();
    for (key, cost) in covered {
        let total = booked.entry(key).or_insert((Some(Decimal::ZERO), None));
        total.0 = total.0.zip(cost).map(|(opened, covered)| opened + covered);
    }
    TransferRecords {
        short,
        booked: booked
            .into_iter()
            .filter_map(|(key, (cost, fee_rate))| {
                cost.map(|cost| (key, BookedCost { cost, fee_rate }))
            })
            .collect(),
    }
}

/// The events a valuation prices: those inside `range`, of `accounts` when
/// given.
struct EventSelection<'a> {
    range: DateRange,
    accounts: Option<&'a BTreeSet<AccountId>>,
}

/// [`effects`] plus the pricing diagnostics, by the account of the event.
fn priced_events(
    resolved: &Resolved<'_>,
    disposals: &[LotDisposal],
    transfers: &TransferRecords,
    rejected: &BTreeSet<ActivityId>,
    selection: Option<EventSelection<'_>>,
) -> (Effects, BTreeMap<AccountId, Vec<Diagnostic>>) {
    let facts = resolved.facts;
    let base = facts.policy.base_currency.clone();
    let range = resolved.range;
    let fx = resolved.fx();
    let convert = |amount: Decimal, currency: &Currency, date: NaiveDate| {
        if amount.is_zero() || currency.as_str().eq_ignore_ascii_case(base.as_str()) {
            return Some(amount);
        }
        fx.convert(amount, currency.as_str(), base.as_str(), date)
    };
    let marked_external: BTreeSet<&str> = facts
        .activities
        .iter()
        .filter(|a| a.external_transfer == Some(true))
        .map(|a| a.id.as_str())
        .collect();
    let mut valuer = Valuer::new(resolved, disposals, &AccountId::new("effects"), &base);
    valuer.booked = Some(&transfers.booked);
    let mut diagnostics: BTreeMap<AccountId, Vec<Diagnostic>> = BTreeMap::new();
    let mut events = Vec::with_capacity(resolved.ledger.events.len());
    for event in resolved.ledger.events.iter().filter(|event| {
        !rejected.contains(&event.source)
            && selection.as_ref().is_none_or(|selected| {
                event.date >= selected.range.start
                    && event.date <= selected.range.end
                    && selected
                        .accounts
                        .is_none_or(|accounts| accounts.contains(&event.account))
            })
    }) {
        let in_range = event.date >= range.start && event.date <= range.end;
        let flow = match &event.flow.boundary {
            Boundary::None => None,
            _ if !in_range => None,
            boundary => {
                let priced_as = if *boundary == Boundary::Unknown {
                    ScopeBoundary::Unknown
                } else {
                    ScopeBoundary::External
                };
                let reported = valuer.diagnostics.len();
                let (amount, source) = valuer.price_flow(event, priced_as);
                diagnostics
                    .entry(event.account.clone())
                    .or_default()
                    .extend(valuer.diagnostics.drain(reported..));
                let negative_cash = event
                    .cash
                    .as_ref()
                    .is_some_and(|c| c.amount < Decimal::ZERO);
                let security_outflow = match &event.action {
                    Action::SecurityTransfer { direction, .. } => Some(
                        (*direction == Direction::Out) != transfers.short.contains(&event.source),
                    ),
                    _ => None,
                };
                let units = match &event.action {
                    Action::SecurityTransfer {
                        direction,
                        quantity,
                        ..
                    } => valuer.transfer_units(event, *direction, *quantity),
                    _ => Decimal::ZERO,
                };
                Some(PricedFlow {
                    amount,
                    source,
                    outflow: match security_outflow {
                        Some(outflow) => outflow,
                        None => {
                            negative_cash
                                && matches!(event.flow.value, FlowValue::Cash(_))
                                && event.contribution == Contribution::CashGross
                                && !matches!(event.action, Action::Trade { .. })
                        }
                    },
                    // A security transfer's direction decides the leg; its
                    // cash leg is only the fee, so the sign must not.
                    leg_outflow: security_outflow.unwrap_or(negative_cash),
                    units,
                })
            }
        };
        let attributed = event.attribution;
        let trade_row = matches!(event.kind, ActivityKind::Buy | ActivityKind::Sell)
            && event.id.as_str() == event.source.as_str();
        let raw_charge = event.charges.fee + event.charges.tax;
        let trade_charge = (trade_row && !raw_charge.is_zero())
            .then(|| convert(raw_charge, &event.currency, event.date))
            .flatten()
            .map(|charge| TradeCharge {
                charge,
                quantity: match &event.action {
                    Action::Trade { quantity, .. } => quantity.abs(),
                    _ => Decimal::ZERO,
                },
                buy: event.kind == ActivityKind::Buy,
            });
        events.push(EventEffect {
            id: event.id.clone(),
            source: event.source.clone(),
            account: event.account.clone(),
            date: event.date,
            currency: event.currency.clone(),
            boundary: event.flow.boundary.clone(),
            flow,
            income: convert(attributed.income, &event.currency, event.date),
            fee: convert(attributed.fee, &event.currency, event.date),
            tax: convert(attributed.tax, &event.currency, event.date),
            trade: matches!(event.action, Action::Trade { .. }),
            trade_charge,
            marked_external: marked_external.contains(event.source.as_str()),
        });
    }
    let effects = Effects {
        base_currency: base.clone(),
        range,
        accounts: facts
            .accounts
            .iter()
            .map(|(id, account)| {
                (
                    id.clone(),
                    AccountProfile {
                        currency: account.currency.clone(),
                        tracking: account.tracking,
                        kind: account.kind,
                        archived: account.archived,
                        cost_basis_method: account.cost_basis_method,
                    },
                )
            })
            .collect(),
        events,
        pairs: facts
            .transfer_pairs
            .iter()
            .filter(|pair| {
                !rejected.contains(&pair.transfer_in) && !rejected.contains(&pair.transfer_out)
            })
            .map(|pair| PairEffect {
                group: pair.group_id.clone(),
                transfer_in: pair.transfer_in.clone(),
                transfer_out: pair.transfer_out.clone(),
                in_account: pair.in_account.clone(),
                out_account: pair.out_account.clone(),
                security: pair.security,
            })
            .collect(),
    };
    (effects, diagnostics)
}

/// Legacy `external_flows_from_scoped_inputs` for `scope`: each event's
/// priced flow where it crosses the scope's boundary.
fn scope_flows(
    effects: &Effects,
    scope: &[AccountId],
    window: Window,
) -> BTreeMap<NaiveDate, DailyFlow> {
    let mut by_account: BTreeMap<&AccountId, BTreeMap<NaiveDate, DailyFlow>> = BTreeMap::new();
    for event in effects
        .events
        .iter()
        .filter(|event| scope.contains(&event.account) && window.contains(event.date))
    {
        let Some(flow) = event.flow else {
            continue;
        };
        if let Boundary::Internal { counterparty } = &event.boundary {
            if scope.contains(counterparty) {
                continue;
            }
        }
        add_flow(
            by_account.entry(&event.account).or_default(),
            event.date,
            flow.amount,
            flow.outflow,
            flow.source,
        );
    }
    // Each account's day at storage precision, as its stored row holds it,
    // so a scope adds up exactly the rows it aggregates.
    let mut flows: BTreeMap<NaiveDate, DailyFlow> = BTreeMap::new();
    for (date, flow) in by_account.into_values().flatten() {
        let stored = flows.entry(date).or_insert(DailyFlow {
            inflow_base: Decimal::ZERO,
            outflow_base: Decimal::ZERO,
            source: flow.source,
        });
        stored.inflow_base += flow.inflow_base.round_dp(STORED_PRECISION);
        stored.outflow_base += flow.outflow_base.round_dp(STORED_PRECISION);
        stored.source = stored.source.combine(flow.source);
    }
    flows
}

/// Legacy `internal_transfer_adjustments_from_scoped_inputs`: both legs of
/// pairs fully inside the scope, priced as external flows. A same-account
/// pair (a cash FX conversion) is internal at every scope, so its legs never
/// reached any account's flows and there is nothing to net: netting them
/// would erase an unrelated flow on the same day. Per account and day, at
/// storage precision, as the rows they net.
fn internal_adjustments<'a>(
    effects: &'a Effects,
    scope: &[AccountId],
    window: Window,
) -> BTreeMap<(&'a AccountId, NaiveDate), (Decimal, Decimal)> {
    let by_source: BTreeMap<&str, &EventEffect> = effects
        .events
        .iter()
        .map(|event| (event.source.as_str(), event))
        .collect();
    // A holdings account's flows come from its snapshots, not its legs: a
    // transfer with one is not netted as a pair, its side shows up in that
    // account's next snapshot (the same day, or in transit until then).
    let holdings = |id: &AccountId| {
        effects
            .account(id)
            .is_some_and(|account| account.tracking == TrackingMode::Holdings)
    };
    let mut by_account: BTreeMap<(&AccountId, NaiveDate), (Decimal, Decimal)> = BTreeMap::new();
    for pair in effects.pairs.iter().filter(|pair| {
        pair.in_account != pair.out_account
            && scope.contains(&pair.in_account)
            && scope.contains(&pair.out_account)
            && !holdings(&pair.in_account)
            && !holdings(&pair.out_account)
    }) {
        // Both legs, wherever the window cuts: the share depends on the pair,
        // and only the legs inside the window are netted.
        let leg = |source: &ActivityId| {
            by_source
                .get(source.as_str())
                .and_then(|event| event.flow.map(|flow| (*event, flow)))
        };
        let (incoming, outgoing) = (leg(&pair.transfer_in), leg(&pair.transfer_out));
        // A security pair whose sender held less than it sent books the
        // difference in the receiver (a history that starts after those
        // units were acquired): only what the sender gave is internal, and
        // the rest of the incoming leg entered the scope (rules R2.1). Priced
        // at a quote, the leg nets in the share of units the sender gave,
        // each leg at its own day's price, so a price move between them
        // stays a return; valued at cost, it nets the cost the sender
        // removed. A cash pair nets whole: a rate difference between its
        // legs is a gain, not a flow (#1655). A shortfall below the fold's
        // dust is none, as the receiver books it: the sender's units are the
        // sum of the slices it relieved, which can fall short of what it sent
        // by a rounding.
        let incoming_netted = match (incoming, outgoing) {
            (Some((_, inflow)), Some((_, outflow)))
                if pair.security && inflow.units - outflow.units >= QUANTITY_THRESHOLD =>
            {
                if inflow.source == FlowSource::QuoteDerivedMarketValue {
                    arith::div(outflow.units, inflow.units)
                        .and_then(|share| arith::mul(inflow.amount, share))
                } else {
                    Some(outflow.amount.min(inflow.amount))
                }
            }
            _ => incoming.map(|(_, inflow)| inflow.amount),
        };
        for (event, flow, amount) in [
            incoming
                .zip(incoming_netted)
                .map(|((event, flow), amount)| (event, flow, amount)),
            outgoing.map(|(event, flow)| (event, flow, flow.amount)),
        ]
        .into_iter()
        .flatten()
        .filter(|(event, ..)| window.contains(event.date))
        {
            if amount.is_zero() {
                continue;
            }
            let entry = by_account
                .entry((&event.account, event.date))
                .or_insert((Decimal::ZERO, Decimal::ZERO));
            if flow.leg_outflow {
                entry.1 += amount;
            } else {
                entry.0 += amount;
            }
        }
    }
    by_account
        .into_iter()
        .map(|(key, (inflow, outflow))| {
            (
                key,
                (
                    inflow.round_dp(STORED_PRECISION),
                    outflow.round_dp(STORED_PRECISION),
                ),
            )
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScopeBoundary {
    External,
    Unknown,
}

fn split_flow(delta: Decimal) -> (Decimal, Decimal) {
    if delta.is_sign_negative() {
        (Decimal::ZERO, -delta)
    } else {
        (delta, Decimal::ZERO)
    }
}

/// Legacy `add_external_flow_amount`: zero amounts only survive with a
/// degraded source.
fn add_flow(
    flows: &mut BTreeMap<NaiveDate, DailyFlow>,
    date: NaiveDate,
    amount: Decimal,
    is_outflow: bool,
    source: FlowSource,
) {
    if amount.is_zero()
        && !matches!(
            source,
            FlowSource::Unknown
                | FlowSource::UnknownBoundaryTransfer
                | FlowSource::RemovedLotBasisFallback
        )
    {
        return;
    }
    let entry = flows.entry(date).or_insert(DailyFlow {
        inflow_base: Decimal::ZERO,
        outflow_base: Decimal::ZERO,
        source,
    });
    if is_outflow {
        entry.outflow_base += amount;
    } else {
        entry.inflow_base += amount;
    }
    entry.source = entry.source.combine(source);
}

/// Legacy `set_external_flows_from_activity_map_or_net_contribution_base`.
fn stamp_flows(days: &mut [DailyValuation], flows: &BTreeMap<NaiveDate, DailyFlow>) {
    let Some(first) = days.first_mut() else {
        return;
    };
    first.flow = DailyFlow::default();
    for index in 1..days.len() {
        // Legacy diffs persisted (8dp) values; dust below storage precision is
        // not a flow.
        let delta = (days[index].net_contribution_base - days[index - 1].net_contribution_base)
            .round_dp(STORED_PRECISION);
        if let Some(flow) = flows.get(&days[index].date) {
            days[index].flow = *flow;
            continue;
        }
        let current = days[index].flow;
        let stored = !current.inflow_base.is_zero()
            || !current.outflow_base.is_zero()
            || (current.source.is_explicit_gross() && delta.is_zero());
        if stored {
            continue;
        }
        if delta.is_zero() {
            days[index].flow = DailyFlow::default();
            continue;
        }
        let (inflow, outflow) = split_flow(delta);
        days[index].flow = DailyFlow {
            inflow_base: inflow,
            outflow_base: outflow,
            source: FlowSource::NetContributionFallback,
        };
    }
}
