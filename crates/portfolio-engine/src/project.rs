//! Stage 4: fold economic events into daily account state — a pure port of
//! the legacy holdings calculator (positions, FIFO lots, shorts, transfers
//! with lot carry-over, splits, net contribution, cash totals).
//!
//! Incremental = the same fold with a prior `ProjectionState` as input.
//! Accounts are folded together so same-day transfer pairs run source before
//! destination and share the transfer cache. Every event is applied on a
//! scratch copy of the account state; a rejected event contributes a
//! diagnostic and no mutation.

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

use chrono::NaiveDate;
use rust_decimal::Decimal;

use crate::arith;
use crate::compile::CompiledLedger;
use crate::diagnostics::{Diagnostic, DiagnosticCode};
use crate::error::EngineError;
use crate::model::*;
use crate::resolve::FxResolver;
use crate::scope::transfer_closure;

/// Positions below this effective quantity are treated as closed.
pub(crate) const QUANTITY_THRESHOLD: Decimal = Decimal::from_parts(1, 0, 0, false, 8);

/// A value outside the kernel range rejects the event (architecture §4.3):
/// the fold keeps the scratch state from before it and reports why.
fn checked(value: Option<Decimal>, what: &str) -> Result<Decimal, String> {
    value.ok_or_else(|| format!("{what} is outside the kernel range"))
}

pub fn project(
    ledger: &CompiledLedger,
    facts: &CanonicalFacts,
    fx: &FxResolver<'_>,
    start: Option<ProjectionState>,
    range: DateRange,
) -> Result<ProjectionBundle, EngineError> {
    project_accounts(ledger, facts, fx, start, range, None)
}

/// [`project`] of `accounts` and every account they share a transfer pair
/// with, transitively (a pair's lots and flows need both legs); `None` folds
/// every account. A later window must be folded with the same accounts.
pub fn project_accounts(
    ledger: &CompiledLedger,
    facts: &CanonicalFacts,
    fx: &FxResolver<'_>,
    start: Option<ProjectionState>,
    range: DateRange,
    accounts: Option<&BTreeSet<AccountId>>,
) -> Result<ProjectionBundle, EngineError> {
    if range.start > range.end {
        return Err(EngineError::InvertedRange {
            start: range.start,
            end: range.end,
        });
    }
    if let Some(state) = &start {
        let expected = range.start.pred_opt().unwrap_or(range.start);
        if state.date != expected {
            return Err(EngineError::StateRangeMismatch {
                state: state.date,
                start: range.start,
            });
        }
    }

    let projector = Projector {
        facts,
        fx,
        event_dates: ledger
            .events
            .iter()
            .map(|e| (e.source.as_str(), e.date))
            .collect(),
    };
    let mut state = start.unwrap_or_else(|| ProjectionState {
        date: range.start,
        accounts: BTreeMap::new(),
        transfer_cache: BTreeMap::new(),
    });
    let mut run = RunLog::default();

    // Events by account and local date, restricted to the range.
    let mut by_account_day: BTreeMap<&AccountId, BTreeMap<NaiveDate, Vec<&EconomicEvent>>> =
        BTreeMap::new();
    for event in &ledger.events {
        if event.date < range.start || event.date > range.end {
            continue;
        }
        by_account_day
            .entry(&event.account)
            .or_default()
            .entry(event.date)
            .or_default()
            .push(event);
    }

    // Accounts in scope: transactions-mode, not archived. An account already
    // in the checkpoint continues from the range start without a resume-day
    // keyframe; a fresh account starts on its first event day (a keyframe is
    // emitted there). An account with no events in the range gets no
    // keyframe: chunking must not move or duplicate keyframes (I2).
    let mut eligible_from: BTreeMap<&AccountId, NaiveDate> = BTreeMap::new();
    let mut fresh_first_day: BTreeMap<&AccountId, NaiveDate> = BTreeMap::new();
    let scope = accounts.map(|requested| transfer_closure(facts, requested.iter().cloned()));
    for (id, account) in &facts.accounts {
        if account.archived || account.tracking == TrackingMode::Holdings {
            continue;
        }
        if scope.as_ref().is_some_and(|scope| !scope.contains(id)) {
            continue;
        }
        if state.accounts.contains_key(id) {
            eligible_from.insert(id, range.start);
        } else if let Some(first) = by_account_day
            .get(id)
            .and_then(|days| days.keys().next().copied())
        {
            eligible_from.insert(id, first);
            fresh_first_day.insert(id, first);
        }
        state
            .accounts
            .entry(id.clone())
            .or_insert_with(|| AccountState::empty(id.clone(), account.currency.clone()));
    }

    let mut keyframes: BTreeMap<AccountId, Vec<Keyframe>> = BTreeMap::new();
    for day in range.days() {
        let eligible: Vec<&AccountId> = eligible_from
            .iter()
            .filter(|(_, start)| **start <= day)
            .map(|(id, _)| *id)
            .collect();
        // Each account folding today, with how far its activities got. The
        // account is taken out and put back once its day is closed: a day's
        // fold reads only its own account, so there is no need to copy it.
        let mut folds: Vec<(&AccountId, &[&EconomicEvent], usize, Option<AccountState>)> =
            Vec::new();
        for account_id in
            order_by_transfer_dependencies(&eligible, &by_account_day, &facts.transfer_pairs, day)
        {
            let is_first_day = fresh_first_day.get(account_id) == Some(&day);
            let events = by_account_day
                .get(account_id)
                .and_then(|days| days.get(&day))
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            if !is_first_day && events.is_empty() {
                continue;
            }
            let account = state
                .accounts
                .remove(account_id)
                .expect("scoped account has state");
            folds.push((account_id, events, 0, Some(account)));
        }
        // Accounts fold in that order, except that one waits at an incoming
        // security transfer whose outgoing leg another account folds later
        // today: transfers both ways on one day make the order a cycle, and
        // lots must leave before they arrive. When every account waits (legs
        // dated against each other), the first goes on regardless.
        let today: BTreeSet<&ActivityId> = folds
            .iter()
            .flat_map(|(_, events, _, _)| events.iter().map(|e| &e.source))
            .collect();
        let mut applied: BTreeSet<&ActivityId> = BTreeSet::new();
        let mut force = false;
        while folds.iter().any(|(_, _, _, account)| account.is_some()) {
            let mut moved = false;
            for (account_id, events, next, slot) in folds.iter_mut() {
                let Some(mut account) = slot.take() else {
                    continue;
                };
                let events: &[&EconomicEvent] = events;
                let end = if std::mem::take(&mut force) {
                    let source = &events[*next].source;
                    *next
                        + events[*next..]
                            .iter()
                            .take_while(|e| e.source == *source)
                            .count()
                } else {
                    events[*next..]
                        .iter()
                        .position(|e| projector.awaits_outgoing_leg(e, &today, &applied))
                        .map_or(events.len(), |offset| *next + offset)
                };
                if end > *next {
                    account = projector.apply_activities(
                        account,
                        &events[*next..end],
                        &mut state.transfer_cache,
                        &mut run,
                    );
                    applied.extend(events[*next..end].iter().map(|e| &e.source));
                    *next = end;
                    moved = true;
                }
                if *next < events.len() {
                    *slot = Some(account);
                    continue;
                }
                moved = true;
                let closed = if events.is_empty() {
                    account
                } else {
                    projector.close_day(account, events, day, &mut run)
                };
                keyframes
                    .entry((*account_id).clone())
                    .or_default()
                    .push(Keyframe {
                        date: day,
                        state: closed.without_lots(),
                    });
                state.accounts.insert((*account_id).clone(), closed);
            }
            force = !moved;
        }
    }
    state.date = range.end;

    Ok(ProjectionBundle {
        keyframes,
        final_state: state,
        disposals: run.disposals,
        closures: run.closures,
        diagnostics: run.diagnostics,
    })
}

/// Kahn topological order: transfer sources before their paired destinations
/// on the same day (edges from the pair table, so overrides and cash
/// transfers count); otherwise account id order.
fn order_by_transfer_dependencies<'a>(
    eligible: &[&'a AccountId],
    by_account_day: &BTreeMap<&AccountId, BTreeMap<NaiveDate, Vec<&EconomicEvent>>>,
    pairs: &TransferPairs,
    day: NaiveDate,
) -> Vec<&'a AccountId> {
    if eligible.len() <= 1 {
        return eligible.to_vec();
    }
    let index: BTreeMap<&AccountId, usize> = eligible
        .iter()
        .enumerate()
        .map(|(i, id)| (*id, i))
        .collect();
    let n = eligible.len();
    let mut successors = vec![Vec::new(); n];
    let mut in_degree = vec![0usize; n];
    let mut has_edges = false;
    let mut seen_groups: BTreeSet<&str> = BTreeSet::new();
    for account in eligible {
        let Some(events) = by_account_day.get(account).and_then(|d| d.get(&day)) else {
            continue;
        };
        for event in events {
            let Some(pair) = pairs.pair_for(&event.source) else {
                continue;
            };
            if !seen_groups.insert(pair.group_id.as_str()) {
                continue;
            }
            let (Some(&out_idx), Some(&in_idx)) =
                (index.get(&pair.out_account), index.get(&pair.in_account))
            else {
                continue;
            };
            if out_idx != in_idx {
                successors[out_idx].push(in_idx);
                in_degree[in_idx] += 1;
                has_edges = true;
            }
        }
    }
    if !has_edges {
        return eligible.to_vec();
    }
    let mut queue: VecDeque<usize> = (0..n).filter(|i| in_degree[*i] == 0).collect();
    let mut order = Vec::with_capacity(n);
    let mut seen = vec![false; n];
    while let Some(i) = queue.pop_front() {
        order.push(eligible[i]);
        seen[i] = true;
        for &successor in &successors[i] {
            in_degree[successor] -= 1;
            if in_degree[successor] == 0 {
                queue.push_back(successor);
            }
        }
    }
    for (i, id) in eligible.iter().enumerate() {
        if !seen[i] {
            order.push(id);
        }
    }
    order
}

/// Side effects staged while applying one event; committed only on success.
#[derive(Default)]
struct SideEffects {
    disposals: Vec<LotDisposal>,
    closures: Vec<LotClosure>,
    cache_inserts: Vec<(String, StagedLots)>,
    cache_removals: Vec<String>,
}

#[derive(Default)]
struct RunLog {
    disposals: Vec<LotDisposal>,
    closures: Vec<LotClosure>,
    diagnostics: Vec<Diagnostic>,
}

impl RunLog {
    /// A conversion the fold went without: "no FROM->TO rate on DAY", then
    /// what the missing rate cost.
    fn no_rate(
        &mut self,
        source: impl Into<String>,
        from: &str,
        to: &str,
        on: impl std::fmt::Display,
        then: &str,
    ) {
        self.diagnostics.push(Diagnostic::warning(
            DiagnosticCode::FxUnavailable,
            source,
            format!("no {from}->{to} rate on {on}{then}"),
        ));
    }
}

struct Projector<'a> {
    facts: &'a CanonicalFacts,
    fx: &'a FxResolver<'a>,
    /// Business date of every event's source activity (transfer staging).
    event_dates: HashMap<&'a str, NaiveDate>,
}

struct Reduction {
    quantity_reduced: Decimal,
    cost_basis_removed: Decimal,
    removed_lots: Vec<Lot>,
    fully_consumed: Vec<Lot>,
}

/// Everything one activity may change: the cash balances, the account totals
/// and the positions of its legs' assets (every handler writes only its
/// event's own position). Debug builds check the footprint on every activity.
struct Savepoint {
    cash: BTreeMap<Currency, Decimal>,
    totals: [Decimal; 5],
    positions: Vec<(AssetId, Option<Position>)>,
}

/// The book-cost rule, one for the fold's account totals and valuation: a
/// position's cost at acquisition FX when it has one (`at_acquisition`),
/// else its total at `day`'s rate. Alternative assets and positions without a
/// cost carry none. When it does not convert, the diagnostic code and why:
/// no rate, or a converted total outside the kernel range.
pub(crate) fn position_book_cost(
    fx: &FxResolver<'_>,
    alternative: bool,
    currency: &str,
    total_cost_basis: Decimal,
    at_acquisition: Option<Decimal>,
    target: &str,
    day: NaiveDate,
) -> Result<Decimal, (DiagnosticCode, String)> {
    if alternative || total_cost_basis.is_zero() {
        return Ok(Decimal::ZERO);
    }
    if let Some(cost) = at_acquisition {
        return Ok(cost);
    }
    let rate = fx.rate(currency, target, day).ok_or_else(|| {
        (
            DiagnosticCode::FxUnavailable,
            format!("no {currency}->{target} rate on {day}"),
        )
    })?;
    arith::mul(total_cost_basis, rate).ok_or_else(|| {
        (
            DiagnosticCode::ValueOutOfRange,
            format!("the book cost in {target} on {day} is outside the kernel range"),
        )
    })
}

/// The position an event may change besides cash and the account totals
/// (checked in debug builds): the asset its action names.
fn footprint(event: &EconomicEvent) -> Option<&AssetId> {
    match &event.action {
        Action::None => None,
        Action::Trade { asset, .. }
        | Action::SecurityTransfer { asset, .. }
        | Action::Split { asset, .. }
        | Action::OptionExpiry { asset, .. } => Some(asset),
    }
}

impl Savepoint {
    fn take<'e>(account: &AccountState, legs: impl Iterator<Item = &'e EconomicEvent>) -> Self {
        // Exhaustive, so a new field has to be placed in or out of the savepoint.
        let AccountState {
            account: _,
            currency: _,
            positions,
            cash,
            cost_basis,
            net_contribution,
            net_contribution_base,
            cash_total_account,
            cash_total_base,
        } = account;
        let mut assets: Vec<&AssetId> = legs.filter_map(footprint).collect();
        assets.sort();
        assets.dedup();
        Self {
            cash: cash.clone(),
            totals: [
                *cost_basis,
                *net_contribution,
                *net_contribution_base,
                *cash_total_account,
                *cash_total_base,
            ],
            positions: assets
                .into_iter()
                .map(|asset| (asset.clone(), positions.get(asset).cloned()))
                .collect(),
        }
    }

    fn restore(self, account: &mut AccountState) {
        account.cash = self.cash;
        [
            account.cost_basis,
            account.net_contribution,
            account.net_contribution_base,
            account.cash_total_account,
            account.cash_total_base,
        ] = self.totals;
        for (asset, position) in self.positions {
            match position {
                Some(position) => account.positions.insert(asset, position),
                None => account.positions.remove(&asset),
            };
        }
    }

    /// Every other position is untouched, whether the activity applied or not.
    #[cfg(debug_assertions)]
    fn check_footprint(&self, before: &AccountState, after: &AccountState) {
        let own: Vec<&AssetId> = self.positions.iter().map(|(asset, _)| asset).collect();
        let others = |state: &AccountState| {
            state
                .positions
                .iter()
                .filter(|(asset, _)| !own.contains(asset))
                .map(|(asset, position)| (asset.clone(), position.clone()))
                .collect::<Vec<_>>()
        };
        debug_assert_eq!(before.account, after.account);
        debug_assert_eq!(before.currency, after.currency);
        debug_assert_eq!(
            others(before),
            others(after),
            "an activity changed another position"
        );
    }
}

impl Projector<'_> {
    fn base(&self) -> &str {
        self.facts.policy.base_currency.as_str()
    }

    /// The account's cost basis method (rules §7).
    fn method(&self, account: &AccountId) -> CostBasisMethod {
        self.facts
            .accounts
            .get(account)
            .map(|facts| facts.cost_basis_method)
            .unwrap_or_default()
    }

    fn asset_facts(&self, asset: &AssetId, currency: &Currency) -> AssetFacts {
        self.facts
            .assets
            .get(asset)
            .cloned()
            .unwrap_or_else(|| AssetFacts::fallback(asset.clone(), currency.clone()))
    }

    /// Whether `event` is an incoming security transfer whose outgoing leg
    /// another account folds today and has not folded yet.
    fn awaits_outgoing_leg(
        &self,
        event: &EconomicEvent,
        today: &BTreeSet<&ActivityId>,
        applied: &BTreeSet<&ActivityId>,
    ) -> bool {
        matches!(
            event.action,
            Action::SecurityTransfer {
                direction: Direction::In,
                ..
            }
        ) && self.pair(event).is_some_and(|pair| {
            pair.security
                && pair.out_account != event.account
                && today.contains(&pair.transfer_out)
                && !applied.contains(&pair.transfer_out)
        })
    }

    /// Applies the day's activities in order (see [`Self::close_day`]).
    fn apply_activities(
        &self,
        mut account: AccountState,
        events: &[&EconomicEvent],
        cache: &mut BTreeMap<String, StagedLots>,
        run: &mut RunLog,
    ) -> AccountState {
        // An activity applies whole or not at all: a composite's legs (DRIP:
        // income then buy) are consecutive events of one source, and a rejected
        // leg rejects the activity. Save only what its legs can change instead
        // of copying every position's lots.
        for legs in events.chunk_by(|a, b| a.source == b.source) {
            let savepoint = Savepoint::take(&account, legs.iter().copied());
            let reported = run.diagnostics.len();
            #[cfg(debug_assertions)]
            let before = account.clone();
            let mut effects = SideEffects::default();
            let applied = legs
                .iter()
                .try_for_each(|leg| self.apply(leg, &mut account, cache, &mut effects, run));
            #[cfg(debug_assertions)]
            savepoint.check_footprint(&before, &account);
            match applied {
                Ok(()) => {
                    run.disposals.extend(effects.disposals);
                    run.closures.extend(effects.closures);
                    for (group, lots) in effects.cache_inserts {
                        cache.insert(group, lots);
                    }
                    for group in effects.cache_removals {
                        cache.remove(&group);
                    }
                }
                Err(message) => {
                    // Nothing the attempt did stays, its warnings included:
                    // only the rejection is reported.
                    savepoint.restore(&mut account);
                    run.diagnostics.truncate(reported);
                    let activity = &legs[0].source;
                    #[cfg(debug_assertions)]
                    debug_assert_eq!(account, before, "rejected {activity} left a trace");
                    run.diagnostics.push(Diagnostic::error(
                        DiagnosticCode::ActivityRejected,
                        activity.as_str(),
                        message,
                    ));
                }
            }
        }
        account
    }

    /// Closes the day once all its activities are applied.
    fn close_day(
        &self,
        mut account: AccountState,
        events: &[&EconomicEvent],
        day: NaiveDate,
        run: &mut RunLog,
    ) -> AccountState {
        // Book costs at acquisition FX of the positions the day's events
        // touched (the others keep theirs: acquisition FX does not move with
        // the day), then the account's total by the same rule as valuation,
        // then cash totals (once per day).
        let touched: BTreeSet<&AssetId> = events.iter().filter_map(|e| footprint(e)).collect();
        let account_currency = account.currency.as_str().to_string();
        let base = self.base().to_string();
        for (asset, position) in account.positions.iter_mut() {
            if !touched.contains(asset) {
                continue;
            }
            position.cost_basis_account = self.book_cost(position, &account_currency);
            position.cost_basis_base = self.book_cost(position, &base);
        }
        let mut cost_basis = Decimal::ZERO;
        for (asset, position) in &account.positions {
            match position_book_cost(
                self.fx,
                position.alternative,
                position.currency.as_str(),
                position.total_cost_basis,
                position.cost_basis_account,
                &account_currency,
                day,
            ) {
                Ok(cost) => cost_basis += cost,
                Err((code, reason)) => run.diagnostics.push(Diagnostic::warning(
                    code,
                    asset.as_str(),
                    format!("{reason}; book cost excluded"),
                )),
            }
        }
        account.cost_basis = cost_basis;
        self.compute_cash_totals(&mut account, day, run);
        account
    }

    fn apply(
        &self,
        event: &EconomicEvent,
        state: &mut AccountState,
        cache: &BTreeMap<String, StagedLots>,
        effects: &mut SideEffects,
        run: &mut RunLog,
    ) -> Result<(), String> {
        match &event.action {
            Action::None => self.apply_cash_only(event, state, run),
            Action::Trade {
                asset,
                side,
                quantity,
                unit_price,
                intent,
            } => match side {
                Side::Buy => self.buy(
                    event,
                    state,
                    asset,
                    *quantity,
                    *unit_price,
                    *intent,
                    effects,
                    run,
                ),
                Side::Sell => self.sell(
                    event,
                    state,
                    asset,
                    *quantity,
                    *unit_price,
                    *intent,
                    effects,
                    run,
                ),
            },
            Action::SecurityTransfer {
                asset,
                direction,
                quantity,
                unit_price,
                legacy_amount,
                ..
            } => match direction {
                Direction::In => self.transfer_in(
                    event,
                    state,
                    asset,
                    *quantity,
                    *unit_price,
                    *legacy_amount,
                    cache,
                    effects,
                    run,
                ),
                Direction::Out => self.transfer_out(event, state, asset, *quantity, effects, run),
            },
            Action::Split { asset, ratio } => self.split(event, state, asset, *ratio),
            Action::OptionExpiry { asset, quantity } => {
                self.option_expiry(event, state, asset, *quantity, effects, run)
            }
        }
    }

    // ----------------------------------------------------------------- cash

    /// DEPOSIT / WITHDRAWAL / income / charges / cash transfers.
    fn apply_cash_only(
        &self,
        event: &EconomicEvent,
        state: &mut AccountState,
        run: &mut RunLog,
    ) -> Result<(), String> {
        let Some(cash) = &event.cash else {
            return Ok(());
        };
        if cash.amount.is_zero() && event.contribution == Contribution::None {
            // Charges of zero: no cash change (legacy warns and returns).
            return Ok(());
        }
        self.book_cash(state, event, cash)?;
        if event.contribution == Contribution::CashGross {
            let gross = cash.gross.unwrap_or(Decimal::ZERO);
            let account_currency = state.currency.clone();
            let amount_account =
                self.to_account_currency(gross, event, account_currency.as_str(), run)?;
            let amount_base = self.gross_to_base(gross, event, run);
            state.net_contribution += amount_account;
            state.net_contribution_base += amount_base;
        }
        Ok(())
    }

    fn book_cash(
        &self,
        state: &mut AccountState,
        event: &EconomicEvent,
        cash: &CashEffect,
    ) -> Result<(), String> {
        let (currency, amount) = match cash.booking {
            Booking::ActivityCurrency => (event.currency.clone(), cash.amount),
            Booking::AccountCurrency { rate } => (
                state.currency.clone(),
                checked(arith::mul(cash.amount, rate), "cash at the supplied rate")?,
            ),
        };
        *state.cash.entry(currency).or_insert(Decimal::ZERO) += amount;
        Ok(())
    }

    /// Legacy `convert_to_account_currency`: explicit rate, else FX on the
    /// activity date, else nothing: an amount in another currency is never
    /// added as if it were the account's (architecture §4.3), only diagnosed.
    fn to_account_currency(
        &self,
        amount: Decimal,
        event: &EconomicEvent,
        account_currency: &str,
        run: &mut RunLog,
    ) -> Result<Decimal, String> {
        let from = event.currency.as_str();
        if from == account_currency {
            return Ok(amount);
        }
        if let Some(rate) = self.explicit_rate(event) {
            return checked(arith::mul(amount, rate), "amount at the supplied rate");
        }
        Ok(
            match self.fx.convert(amount, from, account_currency, event.date) {
                Some(converted) => converted,
                None => {
                    run.no_rate(
                        event.source.as_str(),
                        from,
                        account_currency,
                        event.date,
                        "; net contribution not updated",
                    );
                    Decimal::ZERO
                }
            },
        )
    }

    /// Net-contribution base leg: FX on the activity date, else zero (legacy).
    fn gross_to_base(&self, gross: Decimal, event: &EconomicEvent, run: &mut RunLog) -> Decimal {
        match self
            .fx
            .convert(gross, event.currency.as_str(), self.base(), event.date)
        {
            Some(converted) => converted,
            None => {
                run.no_rate(
                    event.source.as_str(),
                    event.currency.as_str(),
                    self.base(),
                    event.date,
                    "; base contribution not updated",
                );
                Decimal::ZERO
            }
        }
    }

    fn explicit_rate(&self, event: &EconomicEvent) -> Option<Decimal> {
        event.fx_rate
    }

    /// The resolved pair of a transfer leg: only a valid pair moves lots.
    fn pair(&self, event: &EconomicEvent) -> Option<&TransferPair> {
        self.facts.transfer_pairs.pair_for(&event.source)
    }

    /// Whether the fold will still apply the pair's incoming leg, so lots
    /// staged for it are consumed rather than left in every later checkpoint:
    /// its account is projected and it is not dated before the outgoing leg.
    fn incoming_leg_pending(&self, pair: &TransferPair, out_date: NaiveDate) -> bool {
        let projected = self
            .facts
            .accounts
            .get(&pair.in_account)
            .is_some_and(|a| !a.archived && a.tracking != TrackingMode::Holdings);
        projected
            && self
                .event_dates
                .get(pair.transfer_in.as_str())
                .is_some_and(|date| *date >= out_date)
    }

    /// Staged lots in the receiving position's currency. An asset without a
    /// quote currency takes its opening activity's, so the two positions of
    /// a transfer can differ: amounts then convert at each lot's acquisition
    /// rate, and its stored rates scale so its account and base cost stay
    /// the same. No rate rejects the transfer, as it does a trade.
    fn staged_lots_in(&self, staged: &StagedLots, currency: &str) -> Result<Vec<Lot>, String> {
        let from = staged.currency.as_str();
        if from == currency || from.is_empty() || currency.is_empty() {
            return Ok(staged.lots.clone());
        }
        staged
            .lots
            .iter()
            .map(|lot| {
                let rate = self
                    .fx
                    .rate(from, currency, lot.acquisition_date)
                    .ok_or_else(|| {
                        format!(
                            "failed to convert the transferred lots from {from} to {currency} on {}",
                            lot.acquisition_date
                        )
                    })?;
                let convert = |amount: Decimal| checked(arith::mul(amount, rate), "transferred lot");
                Ok(Lot {
                    cost_basis: convert(lot.cost_basis)?,
                    acquisition_price: convert(lot.acquisition_price)?,
                    fees: convert(lot.fees)?,
                    original_fees: convert(lot.original_fees)?,
                    taxes: convert(lot.taxes)?,
                    original_taxes: convert(lot.original_taxes)?,
                    fx_rate_to_position: lot
                        .fx_rate_to_position
                        .and_then(|r| arith::mul(r, rate)),
                    fx_rate_to_account: lot.fx_rate_to_account.and_then(|r| arith::div(r, rate)),
                    fx_rate_to_base: lot.fx_rate_to_base.and_then(|r| arith::div(r, rate)),
                    ..lot.clone()
                })
            })
            .collect()
    }

    // --------------------------------------------------------------- trades

    #[allow(clippy::too_many_arguments)]
    fn buy(
        &self,
        event: &EconomicEvent,
        state: &mut AccountState,
        asset: &AssetId,
        quantity: Decimal,
        unit_price: Decimal,
        intent: Option<Intent>,
        effects: &mut SideEffects,
        run: &mut RunLog,
    ) -> Result<(), String> {
        let info = self.asset_facts(asset, &event.currency);
        let close_only = intent == Some(Intent::Close);
        let short_quantity = state
            .positions
            .get(asset)
            .map(negative_effective_abs)
            .unwrap_or(Decimal::ZERO);

        if info.allows_negative_lots && close_only {
            if short_quantity.is_zero() {
                return Err(format!(
                    "BUY {} is marked POSITION_CLOSE for {asset} but no short position exists",
                    event.source
                ));
            }
            if quantity > short_quantity {
                return Err(format!("BUY {} is marked POSITION_CLOSE for {quantity} units of {asset} but only {short_quantity} are short", event.source));
            }
        }
        if info.requires_explicit_short_intent {
            if close_only && short_quantity.is_zero() {
                return Err(format!(
                    "BUY {} is marked POSITION_CLOSE for {asset} but no short position exists",
                    event.source
                ));
            }
            if !close_only && short_quantity > Decimal::ZERO {
                return Err(format!(
                    "BUY {} would reduce short {asset} without Buy to Cover intent",
                    event.source
                ));
            }
        }

        let account_currency = state.currency.clone();
        let account_id = state.account.clone();
        let position = self.position_mut(state, asset, &info, event);
        let position_currency = position.currency.clone();
        let gross_abs = event
            .cash
            .as_ref()
            .and_then(|c| c.gross)
            .map(|g| g.abs())
            .unwrap_or(Decimal::ZERO);
        let lot_unit_price =
            effective_unit_price(quantity, gross_abs, unit_price, info.contract_multiplier)?;
        let (price, fee, tax, fx_used) = self.to_position_currency(
            lot_unit_price,
            event.charges.fee,
            event.charges.tax,
            event,
            position_currency.as_str(),
            account_currency.as_str(),
        )?;
        let book = self.lot_book_basis(
            event,
            position_currency.as_str(),
            account_currency.as_str(),
            run,
        );
        let mut cash_quantity = quantity;

        if info.allows_negative_lots && (!info.requires_explicit_short_intent || close_only) {
            let closed = self.close_then_open(
                Side::Buy,
                event,
                &account_id,
                asset,
                position,
                quantity,
                (price, fee, tax, fx_used),
                !close_only,
                Some(&book),
                account_currency.as_str(),
                effects,
                run,
            )?;
            if info.requires_explicit_short_intent {
                cash_quantity = closed;
            }
        } else {
            add_lot(
                position,
                event.id.as_str().to_string(),
                quantity,
                price,
                fee,
                tax,
                event,
                fx_used,
                &book,
            )?;
        }

        if let Some(cash) = &event.cash {
            let amount = proportional(cash.amount, cash_quantity, quantity)?;
            let effect = CashEffect {
                amount,
                gross: cash.gross,
                booking: cash.booking,
            };
            self.book_cash(state, event, &effect)?;
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn sell(
        &self,
        event: &EconomicEvent,
        state: &mut AccountState,
        asset: &AssetId,
        quantity: Decimal,
        unit_price: Decimal,
        intent: Option<Intent>,
        effects: &mut SideEffects,
        run: &mut RunLog,
    ) -> Result<(), String> {
        let info = self.asset_facts(asset, &event.currency);
        let close_only = intent == Some(Intent::Close);
        let open_short = intent == Some(Intent::Open);
        if info.allows_negative_lots && close_only {
            let long_quantity = state
                .positions
                .get(asset)
                .map(positive_effective)
                .unwrap_or(Decimal::ZERO);
            if long_quantity.is_zero() {
                return Err(format!(
                    "SELL {} is marked POSITION_CLOSE for {asset} but no long position exists",
                    event.source
                ));
            }
            if quantity > long_quantity {
                return Err(format!("SELL {} is marked POSITION_CLOSE for {quantity} units of {asset} but only {long_quantity} are long", event.source));
            }
        }
        if info.requires_explicit_short_intent {
            let existing = state
                .positions
                .get(asset)
                .map(|p| p.quantity)
                .unwrap_or(Decimal::ZERO);
            if open_short && existing > Decimal::ZERO {
                return Err(format!(
                    "SELL {} is marked POSITION_OPEN for {asset} while a long position exists",
                    event.source
                ));
            }
            if !open_short && existing < Decimal::ZERO {
                return Err(format!(
                    "SELL {} would increase short {asset} without Sell Short intent",
                    event.source
                ));
            }
        }

        let account_currency = state.currency.clone();
        let account_id = state.account.clone();
        if let Some(cash) = &event.cash {
            self.book_cash(state, event, cash)?;
        }
        let total_proceeds = event
            .cash
            .as_ref()
            .map(|c| c.amount)
            .unwrap_or(Decimal::ZERO);

        if info.allows_negative_lots && (!info.requires_explicit_short_intent || open_short) {
            let position = self.position_mut(state, asset, &info, event);
            let position_currency = position.currency.clone();
            let gross_abs = event
                .cash
                .as_ref()
                .and_then(|c| c.gross)
                .map(|g| g.abs())
                .unwrap_or(Decimal::ZERO);
            let lot_unit_price =
                effective_unit_price(quantity, gross_abs, unit_price, info.contract_multiplier)?;
            let priced = self.to_position_currency(
                lot_unit_price,
                event.charges.fee,
                event.charges.tax,
                event,
                position_currency.as_str(),
                account_currency.as_str(),
            )?;
            self.close_then_open(
                Side::Sell,
                event,
                &account_id,
                asset,
                position,
                quantity,
                priced,
                !close_only,
                None,
                account_currency.as_str(),
                effects,
                run,
            )?;
            return Ok(());
        }

        if let Some(position) = state.positions.get_mut(asset) {
            let position_currency = position.currency.clone();
            let proceeds = self.activity_amount_to_position_currency(
                total_proceeds,
                event,
                position_currency.as_str(),
                account_currency.as_str(),
            )?;
            let reduction = relieve_long_lots(position, quantity, self.method(&account_id))?;
            // The proceeds belong to every unit sold: units beyond the
            // position have no lot, so only their share of the proceeds is
            // realised against the lots that were held.
            let proceeds = proportional(proceeds, reduction.quantity_reduced, quantity)?;
            self.record_reduction(
                &account_id,
                asset,
                event,
                &reduction,
                Proceeds::sale(proceeds),
                &position_currency,
                effects,
                run,
            )?;
            report_shortfall(
                event,
                "SELL",
                asset,
                quantity,
                reduction.quantity_reduced,
                run,
            );
        } else {
            run.diagnostics.push(Diagnostic::warning(
                DiagnosticCode::NoPositionToReduce,
                event.source.as_str(),
                format!("SELL of non-existent position {asset}; cash effect only"),
            ));
        }
        Ok(())
    }

    /// The part of a trade that closes the other side, then the part that
    /// opens its own: a BUY covers shorts then opens long, a SELL closes
    /// longs then opens short, the charges split between the two by
    /// quantity. `book` is the lot basis when the caller has it; otherwise it
    /// is worked out only if a lot opens. Returns the quantity closed.
    #[allow(clippy::too_many_arguments)]
    fn close_then_open(
        &self,
        side: Side,
        event: &EconomicEvent,
        account_id: &AccountId,
        asset: &AssetId,
        position: &mut Position,
        quantity: Decimal,
        (price, fee, tax, fx_used): (Decimal, Decimal, Decimal, Option<Decimal>),
        open: bool,
        book: Option<&BookBasis>,
        account_currency: &str,
        effects: &mut SideEffects,
        run: &mut RunLog,
    ) -> Result<Decimal, String> {
        let position_currency = position.currency.clone();
        let other_side = match side {
            Side::Buy => negative_effective_abs(position),
            Side::Sell => positive_effective(position),
        };
        let close_quantity = quantity.min(other_side);
        let open_quantity = quantity - close_quantity;
        if close_quantity > Decimal::ZERO {
            let close_fee = proportional(fee, close_quantity, quantity)?;
            let close_tax = proportional(tax, close_quantity, quantity)?;
            // Covering costs the price plus charges; selling brings it in
            // less them.
            let (amount, reduction) = match side {
                Side::Buy => (
                    checked(arith::mul(close_quantity, price), "cover cost")?
                        + close_fee
                        + close_tax,
                    relieve_short_lots(position, close_quantity, self.method(account_id))?,
                ),
                Side::Sell => (
                    checked(arith::mul(close_quantity, price), "sale proceeds")?
                        - close_fee
                        - close_tax,
                    relieve_long_lots(position, close_quantity, self.method(account_id))?,
                ),
            };
            self.record_reduction(
                account_id,
                asset,
                event,
                &reduction,
                Proceeds::sale(amount),
                &position_currency,
                effects,
                run,
            )?;
        }
        if open_quantity > Decimal::ZERO && open {
            let open_fee = proportional(fee, open_quantity, quantity)?;
            let open_tax = proportional(tax, open_quantity, quantity)?;
            let lot_id = if close_quantity > Decimal::ZERO {
                format!("{}:open", event.id)
            } else {
                event.id.as_str().to_string()
            };
            let computed;
            let book = match book {
                Some(book) => book,
                None => {
                    computed = self.lot_book_basis(
                        event,
                        position_currency.as_str(),
                        account_currency,
                        run,
                    );
                    &computed
                }
            };
            let signed = match side {
                Side::Buy => open_quantity,
                Side::Sell => -open_quantity,
            };
            open_lot_signed(
                position, lot_id, signed, price, open_fee, open_tax, event, fx_used, book, true,
            )?;
        }
        Ok(close_quantity)
    }

    // ------------------------------------------------------------ transfers

    /// A lot of `units` at the transfer's own price (`quantity` x
    /// `unit_price` x the multiplier, else its legacy amount, per unit): what
    /// the receiver books for units nothing staged. `fee` is the charge the
    /// lot carries.
    #[allow(clippy::too_many_arguments)]
    fn transfer_lot(
        &self,
        event: &EconomicEvent,
        info: &AssetFacts,
        units: Decimal,
        quantity: Decimal,
        unit_price: Decimal,
        legacy_amount: Option<Decimal>,
        position_currency: &str,
        account_currency: &str,
        run: &mut RunLog,
    ) -> Result<Lot, String> {
        let compiled_basis = {
            let price_basis = checked(
                arith::product(&[quantity, unit_price, info.contract_multiplier]),
                "transferred basis",
            )?;
            if !price_basis.is_zero() {
                price_basis
            } else if !quantity.is_zero() {
                legacy_amount.unwrap_or(Decimal::ZERO).abs()
            } else {
                Decimal::ZERO
            }
        };
        let lot_unit_price = if quantity.is_zero() {
            Decimal::ZERO
        } else {
            checked(
                arith::div(compiled_basis, quantity),
                "transferred unit price",
            )?
        };
        let (price, _fee, _tax, fx_used) = self.to_position_currency(
            lot_unit_price,
            Decimal::ZERO,
            Decimal::ZERO,
            event,
            position_currency,
            account_currency,
        )?;
        let book = self.lot_book_basis(event, position_currency, account_currency, run);
        new_lot(
            event.id.as_str().to_string(),
            units,
            price,
            Decimal::ZERO,
            Decimal::ZERO,
            event,
            fx_used,
            &book,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn transfer_in(
        &self,
        event: &EconomicEvent,
        state: &mut AccountState,
        asset: &AssetId,
        quantity: Decimal,
        unit_price: Decimal,
        legacy_amount: Option<Decimal>,
        cache: &BTreeMap<String, StagedLots>,
        effects: &mut SideEffects,
        run: &mut RunLog,
    ) -> Result<(), String> {
        if let Some(cash) = &event.cash {
            if !cash.amount.is_zero() {
                *state
                    .cash
                    .entry(event.currency.clone())
                    .or_insert(Decimal::ZERO) += cash.amount;
            }
        }
        let info = self.asset_facts(asset, &event.currency);
        let account_currency = state.currency.clone();
        let account_id = state.account.clone();
        let base = self.base().to_string();
        let position = self.position_mut(state, asset, &info, event);
        let position_currency = position.currency.clone();
        let paired_group = self.pair(event).map(|pair| pair.group_id.clone());
        let cached = match paired_group.as_deref().and_then(|g| cache.get(g)) {
            Some(staged) => Some(self.staged_lots_in(staged, position_currency.as_str())?),
            None => None,
        };
        let paired = cached.is_some();

        // The receiver books what its own activity says arrived: the lots
        // the sender staged and, at the transfer's own price, the units the
        // sender did not hold (its history starts after it acquired them) or,
        // with nothing staged, all of them.
        let mut lots = cached.unwrap_or_default();
        let incoming_negative = lots
            .iter()
            .find(|lot| !lot.quantity.is_zero())
            .map(|lot| lot.quantity.is_sign_negative())
            .unwrap_or(false);
        let staged_abs: Decimal = lots.iter().map(|l| l.effective_quantity().abs()).sum();
        // A shortfall below the fold's dust (a split's rounding) is none. A
        // short arrives in full too, the lacked units as a short (rules R2.5).
        let missing = if !is_significant(quantity - staged_abs) {
            Decimal::ZERO
        } else {
            (quantity - staged_abs).max(Decimal::ZERO)
        };
        if missing > Decimal::ZERO {
            lots.push(self.transfer_lot(
                event,
                &info,
                if incoming_negative { -missing } else { missing },
                quantity,
                unit_price,
                legacy_amount,
                position_currency.as_str(),
                account_currency.as_str(),
                run,
            )?);
        }
        let incoming_abs = staged_abs + missing;

        // Units arriving into the opposite position cover it first
        // (NOM-TXF-04); only the rest opens lots.
        let resident_opposite = if incoming_negative {
            positive_effective(position)
        } else {
            negative_effective_abs(position)
        };
        let cover_abs = if info.allows_negative_lots {
            incoming_abs.min(resident_opposite)
        } else {
            Decimal::ZERO
        };
        let (to_add, cover) = if cover_abs > Decimal::ZERO {
            let (cover_lots, residual) =
                split_for_cover(&lots, cover_abs, self.method(&account_id))?;
            // A rest below the fold's dust (a split's rounding: the covered
            // position held 0.999…9 units) opens nothing, as a shortfall
            // below it is none: a lot that small could never be closed, and
            // the position would hold both signs (I5).
            let rest: Decimal = residual.iter().map(|l| l.effective_quantity().abs()).sum();
            let residual = if is_significant(rest) {
                residual
            } else {
                Vec::new()
            };
            let cover_proceeds: Decimal = cover_lots
                .iter()
                .map(|l| l.cost_basis)
                .sum::<Decimal>()
                .abs();
            // Delivered units carry their own cost in base, at the rates they
            // were acquired at, as the lots they open do (rules R2.4).
            let cover_proceeds_base = self
                .historical_base_cost(&cover_lots, position_currency.as_str())
                .map(|total| total.abs());
            let reduction = if incoming_negative {
                relieve_long_lots(position, cover_abs, self.method(&account_id))?
            } else {
                relieve_short_lots(position, cover_abs, self.method(&account_id))?
            };
            (
                residual,
                Some((reduction, cover_proceeds, cover_proceeds_base)),
            )
        } else {
            (lots, None)
        };
        let cost_basis_asset = add_transferred_lots(
            position,
            event.id.as_str(),
            &to_add,
            info.allows_negative_lots,
        )?;
        // The leg's whole fee, paid from cash, goes into the lots it opens,
        // after any cover; a leg that opens none capitalises nothing (rules
        // R2.4). An unpaired leg's net contribution includes it, as its
        // units' cost; a paired leg's moves by the carried basis alone, so
        // the pair still nets to zero at portfolio scope (I7).
        let fee = if event.charges.fee.is_zero() {
            Decimal::ZERO
        } else {
            self.to_position_currency(
                Decimal::ZERO,
                event.charges.fee,
                Decimal::ZERO,
                event,
                position_currency.as_str(),
                account_currency.as_str(),
            )?
            .1
        };
        if !paired && !fee.is_zero() {
            capitalize_fee(position, &event.id, fee, info.allows_negative_lots)?;
        }
        let added_lots: Vec<Lot> = position
            .lots
            .iter()
            .filter(|lot| lot.source_event.as_ref() == Some(&event.id))
            .cloned()
            .collect();
        if let (true, Some(g)) = (paired, paired_group.as_deref()) {
            if cover_abs.is_zero() && added_lots.is_empty() {
                // Rejected whole, so the fee is not paid either; the lots
                // stay cached.
                return Err(format!("TRANSFER_IN booked none of the cached lots for {asset} (negative lots not allowed); cache kept"));
            }
            effects.cache_removals.push(g.to_string());
        }

        if let Some((reduction, cover_proceeds, cover_proceeds_base)) = cover {
            self.record_reduction(
                &account_id,
                asset,
                event,
                &reduction,
                Proceeds::Shared {
                    local: cover_proceeds,
                    base: cover_proceeds_base,
                },
                &position_currency,
                effects,
                run,
            )?;
            if !position_currency.as_str().is_empty()
                && reduction.cost_basis_removed != Decimal::ZERO
            {
                let removed_account = self.lots_cost_basis_in(
                    &reduction.removed_lots,
                    position_currency.as_str(),
                    account_currency.as_str(),
                    event.date,
                    event,
                    run,
                );
                let removed_base = self.lots_cost_basis_in(
                    &reduction.removed_lots,
                    position_currency.as_str(),
                    &base,
                    event.date,
                    event,
                    run,
                );
                state.net_contribution -= removed_account;
                state.net_contribution_base -= removed_base;
            }
        }

        let cost_basis_account = if added_lots.is_empty() {
            self.position_amount_to_account_currency(
                cost_basis_asset,
                position_currency.as_str(),
                event,
                account_currency.as_str(),
                run,
            )
        } else {
            self.lots_cost_basis_in(
                &added_lots,
                position_currency.as_str(),
                account_currency.as_str(),
                event.date,
                event,
                run,
            )
        };
        let cost_basis_base = if added_lots.is_empty() {
            match self.fx.convert(
                cost_basis_asset,
                position_currency.as_str(),
                &base,
                event.date,
            ) {
                Some(converted) => converted,
                None => {
                    run.diagnostics.push(Diagnostic::warning(
                        DiagnosticCode::FxUnavailable,
                        event.source.as_str(),
                        "no rate for the transferred basis to base; base contribution not updated",
                    ));
                    Decimal::ZERO
                }
            }
        } else {
            self.lots_cost_basis_in(
                &added_lots,
                position_currency.as_str(),
                &base,
                event.date,
                event,
                run,
            )
        };
        state.net_contribution += cost_basis_account;
        state.net_contribution_base += cost_basis_base;

        if paired && !fee.is_zero() {
            if let Some(position) = state.positions.get_mut(asset) {
                capitalize_fee(position, &event.id, fee, info.allows_negative_lots)?;
            }
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn transfer_out(
        &self,
        event: &EconomicEvent,
        state: &mut AccountState,
        asset: &AssetId,
        quantity: Decimal,
        effects: &mut SideEffects,
        run: &mut RunLog,
    ) -> Result<(), String> {
        if let Some(cash) = &event.cash {
            if !cash.amount.is_zero() {
                *state
                    .cash
                    .entry(event.currency.clone())
                    .or_insert(Decimal::ZERO) += cash.amount;
            }
        }
        let account_currency = state.currency.clone();
        let account_id = state.account.clone();
        let base = self.base().to_string();
        let Some(position) = state.positions.get_mut(asset) else {
            run.diagnostics.push(Diagnostic::warning(
                DiagnosticCode::NoPositionToReduce,
                event.source.as_str(),
                format!("TRANSFER_OUT of non-existent position {asset}; fee applied only"),
            ));
            return Ok(());
        };
        let position_currency = position.currency.clone();
        let short = position.quantity.is_sign_negative();
        let reduction = if short {
            relieve_short_lots(position, quantity, self.method(&account_id))?
        } else {
            relieve_long_lots(position, quantity, self.method(&account_id))?
        };
        self.record_reduction(
            &account_id,
            asset,
            event,
            &reduction,
            Proceeds::AtCost,
            &position_currency,
            effects,
            run,
        )?;
        report_shortfall(
            event,
            "TRANSFER_OUT",
            asset,
            quantity,
            reduction.quantity_reduced,
            run,
        );
        if !position_currency.as_str().is_empty() && reduction.cost_basis_removed != Decimal::ZERO {
            let removed_account = self.lots_cost_basis_in(
                &reduction.removed_lots,
                position_currency.as_str(),
                account_currency.as_str(),
                event.date,
                event,
                run,
            );
            let removed_base = self.lots_cost_basis_in(
                &reduction.removed_lots,
                position_currency.as_str(),
                &base,
                event.date,
                event,
                run,
            );
            state.net_contribution -= removed_account;
            state.net_contribution_base -= removed_base;
        }
        if let Some(pair) = self.pair(event) {
            if !reduction.removed_lots.is_empty() && self.incoming_leg_pending(pair, event.date) {
                effects.cache_inserts.push((
                    pair.group_id.clone(),
                    StagedLots {
                        currency: position_currency.clone(),
                        lots: reduction.removed_lots,
                    },
                ));
            }
        }
        Ok(())
    }

    // ----------------------------------------------------- corporate actions

    fn split(
        &self,
        event: &EconomicEvent,
        state: &mut AccountState,
        asset: &AssetId,
        ratio: Decimal,
    ) -> Result<(), String> {
        let Some(position) = state.positions.get_mut(asset) else {
            return Ok(());
        };
        let policy = &self.facts.policy;
        for lot in &mut position.lots {
            if lot.acquisition.with_timezone(&policy.timezone).date_naive() < event.date {
                let split_ratio = checked(arith::mul(lot.split_ratio, ratio), "split ratio")?;
                // Keeps `Lot::effective_quantity` in range for every later read.
                checked(
                    arith::mul(lot.quantity, split_ratio),
                    "split-adjusted quantity",
                )?;
                lot.split_ratio = split_ratio;
            }
        }
        let allows_negative = position.lots.iter().any(|lot| lot.quantity < Decimal::ZERO);
        recalculate_aggregates(position, allows_negative)
    }

    fn option_expiry(
        &self,
        event: &EconomicEvent,
        state: &mut AccountState,
        asset: &AssetId,
        quantity: Decimal,
        effects: &mut SideEffects,
        run: &mut RunLog,
    ) -> Result<(), String> {
        let account_id = state.account.clone();
        let Some(position) = state.positions.get_mut(asset) else {
            run.diagnostics.push(Diagnostic::warning(
                DiagnosticCode::NoPositionToReduce,
                event.source.as_str(),
                format!("OPTION_EXPIRY: no position for {asset}; ignored"),
            ));
            return Ok(());
        };
        let position_currency = position.currency.clone();
        let reduction = if position.quantity < Decimal::ZERO {
            relieve_short_lots(position, quantity, self.method(&account_id))?
        } else {
            relieve_long_lots(position, quantity, self.method(&account_id))?
        };
        self.record_reduction(
            &account_id,
            asset,
            event,
            &reduction,
            Proceeds::sale(Decimal::ZERO),
            &position_currency,
            effects,
            run,
        )?;
        report_shortfall(
            event,
            "OPTION_EXPIRY",
            asset,
            quantity,
            reduction.quantity_reduced,
            run,
        );
        Ok(())
    }

    // ------------------------------------------------------------- helpers

    fn position_mut<'s>(
        &self,
        state: &'s mut AccountState,
        asset: &AssetId,
        info: &AssetFacts,
        opened_by: &EconomicEvent,
    ) -> &'s mut Position {
        let when = opened_by.timestamp;
        state
            .positions
            .entry(asset.clone())
            .or_insert_with(|| Position {
                asset: asset.clone(),
                // An asset without a quote currency is priced in the currency
                // of the activity that opens the position.
                currency: info
                    .quote_currency
                    .clone()
                    .unwrap_or_else(|| opened_by.currency.clone()),
                quantity: Decimal::ZERO,
                average_cost: Decimal::ZERO,
                total_cost_basis: Decimal::ZERO,
                lots: Vec::new(),
                alternative: info.alternative,
                contract_multiplier: info.contract_multiplier,
                inception: when,
                cost_basis_account: None,
                cost_basis_base: None,
            })
    }

    /// Legacy `convert_to_position_currency`.
    fn to_position_currency(
        &self,
        unit_price: Decimal,
        fee: Decimal,
        tax: Decimal,
        event: &EconomicEvent,
        position_currency: &str,
        account_currency: &str,
    ) -> Result<(Decimal, Decimal, Decimal, Option<Decimal>), String> {
        in_position_currency(
            self.fx,
            event,
            [unit_price, fee, tax],
            position_currency,
            account_currency,
        )
    }

    /// Legacy `convert_activity_amount_to_position_currency` (hard failure).
    fn activity_amount_to_position_currency(
        &self,
        amount: Decimal,
        event: &EconomicEvent,
        position_currency: &str,
        account_currency: &str,
    ) -> Result<Decimal, String> {
        let activity_currency = event.currency.as_str();
        if position_currency.is_empty() || position_currency == activity_currency {
            return Ok(amount);
        }
        let can_use_rate =
            position_currency == account_currency || activity_currency == account_currency;
        if can_use_rate {
            if let Some(rate) = self.explicit_rate(event) {
                return checked(arith::mul(amount, rate), "proceeds at the supplied rate");
            }
        }
        self.fx
            .convert(amount, activity_currency, position_currency, event.date)
            .ok_or_else(|| format!("failed to convert sell proceeds from {activity_currency} to {position_currency} on {}", event.date))
    }

    /// Legacy `convert_position_amount_to_account_currency` (soft failure).
    fn position_amount_to_account_currency(
        &self,
        amount: Decimal,
        position_currency: &str,
        event: &EconomicEvent,
        account_currency: &str,
        run: &mut RunLog,
    ) -> Decimal {
        if position_currency == account_currency {
            return amount;
        }
        if event.currency.as_str() == position_currency {
            if let Some(converted) = self
                .explicit_rate(event)
                .and_then(|rate| arith::mul(amount, rate))
            {
                return converted;
            }
        }
        match self
            .fx
            .convert(amount, position_currency, account_currency, event.date)
        {
            Some(converted) => converted,
            None => {
                run.no_rate(
                    event.source.as_str(),
                    position_currency,
                    account_currency,
                    event.date,
                    "; net contribution not updated",
                );
                Decimal::ZERO
            }
        }
    }

    /// Legacy `lot_book_basis_for_activity`.
    fn lot_book_basis(
        &self,
        event: &EconomicEvent,
        position_currency: &str,
        account_currency: &str,
        run: &mut RunLog,
    ) -> BookBasis {
        let base = self.base();
        let explicit =
            self.explicit_position_to_account_rate(event, position_currency, account_currency);
        let fx_rate_to_account = if position_currency == account_currency {
            Some(Decimal::ONE)
        } else {
            explicit
                .or_else(|| self.rate_for_basis(position_currency, account_currency, event, run))
        };
        let fx_rate_to_base = if position_currency == base {
            Some(Decimal::ONE)
        } else if let Some(explicit_rate) = explicit {
            if account_currency == base {
                Some(explicit_rate)
            } else {
                self.rate_for_basis(account_currency, base, event, run)
                    .and_then(|account_to_base| arith::mul(explicit_rate, account_to_base))
            }
        } else {
            self.rate_for_basis(position_currency, base, event, run)
        };
        BookBasis {
            acquisition_date: event.date,
            fx_rate_to_account,
            account_currency: Currency::parse(account_currency),
            fx_rate_to_base,
            base_currency: Currency::parse(base),
        }
    }

    fn explicit_position_to_account_rate(
        &self,
        event: &EconomicEvent,
        position_currency: &str,
        account_currency: &str,
    ) -> Option<Decimal> {
        if position_currency == account_currency {
            return Some(Decimal::ONE);
        }
        let rate = self.explicit_rate(event)?;
        let activity_currency = event.currency.as_str();
        if activity_currency == position_currency {
            Some(rate)
        } else if activity_currency == account_currency {
            arith::div(Decimal::ONE, rate)
        } else {
            None
        }
    }

    fn rate_for_basis(
        &self,
        from: &str,
        to: &str,
        event: &EconomicEvent,
        run: &mut RunLog,
    ) -> Option<Decimal> {
        let rate = self.fx.rate(from, to, event.date);
        if rate.is_none() {
            run.no_rate(
                event.source.as_str(),
                from,
                to,
                event.date,
                " for lot basis",
            );
        }
        rate
    }

    fn lots_cost_basis_in(
        &self,
        lots: &[Lot],
        position_currency: &str,
        target: &str,
        fallback_date: NaiveDate,
        event: &EconomicEvent,
        run: &mut RunLog,
    ) -> Decimal {
        lots.iter()
            .filter(|lot| !lot.quantity.is_zero() && !lot.cost_basis.is_zero())
            .map(|lot| {
                self.lot_cost_basis_in(lot, position_currency, target, fallback_date, event, run)
            })
            .sum()
    }

    fn lot_cost_basis_in(
        &self,
        lot: &Lot,
        position_currency: &str,
        target: &str,
        fallback_date: NaiveDate,
        event: &EconomicEvent,
        run: &mut RunLog,
    ) -> Decimal {
        if let Some(converted) = self.lot_book_cost(lot, position_currency, target) {
            return converted;
        }
        if fallback_date == lot.acquisition_date {
            run.no_rate(
                event.source.as_str(),
                position_currency,
                target,
                lot.acquisition_date,
                "; lot basis excluded",
            );
            return Decimal::ZERO;
        }
        match self
            .fx
            .convert(lot.cost_basis, position_currency, target, fallback_date)
        {
            Some(converted) => converted,
            None => {
                run.no_rate(
                    event.source.as_str(),
                    position_currency,
                    target,
                    format!("{} or {fallback_date}", lot.acquisition_date),
                    "; lot basis excluded",
                );
                Decimal::ZERO
            }
        }
    }

    /// A lot's book cost in `target`: its cost at the lot's stored rate to
    /// `target`, else at its acquisition date's rate (the resolver applies
    /// minor units). `None` when no rate converts it.
    fn lot_book_cost(&self, lot: &Lot, position_currency: &str, target: &str) -> Option<Decimal> {
        if position_currency == target {
            return Some(lot.cost_basis);
        }
        lot.stored_fx_rate_to(target)
            .and_then(|rate| arith::mul(lot.cost_basis, rate))
            .or_else(|| {
                self.fx.convert(
                    lot.cost_basis,
                    position_currency,
                    target,
                    lot.acquisition_date,
                )
            })
    }

    /// A position's book cost in `target` at acquisition FX: the sum of its
    /// lots'. `None` without lots, or when a lot does not convert (the day's
    /// rate then applies, see [`position_book_cost`]).
    fn book_cost(&self, position: &Position, target: &str) -> Option<Decimal> {
        if position.lots.is_empty() {
            return None;
        }
        position
            .lots
            .iter()
            .filter(|lot| !lot.quantity.is_zero() && !lot.cost_basis.is_zero())
            .map(|lot| self.lot_book_cost(lot, position.currency.as_str(), target))
            .sum()
    }

    /// Cash totals in account and base currency, once per day; an
    /// unconvertible bucket is excluded and diagnosed, as valuation does.
    fn compute_cash_totals(&self, state: &mut AccountState, day: NaiveDate, run: &mut RunLog) {
        let account_currency = state.currency.as_str().to_string();
        let base = self.base().to_string();
        let mut total_account = Decimal::ZERO;
        let mut total_base = Decimal::ZERO;
        for (currency, amount) in &state.cash {
            let code = currency.as_str();
            for (target, total) in [
                (&account_currency, &mut total_account),
                (&base, &mut total_base),
            ] {
                if code == target {
                    *total += *amount;
                } else {
                    match self.fx.convert(*amount, code, target, day) {
                        Some(converted) => *total += converted,
                        None => run.no_rate(
                            format!("{}@{day}", state.account),
                            code,
                            target,
                            day,
                            &format!("; cash {amount} {code} excluded from the {target} total"),
                        ),
                    }
                }
            }
        }
        state.cash_total_account = total_account;
        state.cash_total_base = total_base;
    }

    #[allow(clippy::too_many_arguments)]
    fn record_reduction(
        &self,
        account: &AccountId,
        asset: &AssetId,
        event: &EconomicEvent,
        reduction: &Reduction,
        proceeds: Proceeds,
        position_currency: &Currency,
        effects: &mut SideEffects,
        run: &mut RunLog,
    ) -> Result<(), String> {
        self.record_disposals(
            account,
            asset,
            event,
            &reduction.removed_lots,
            proceeds,
            reduction.quantity_reduced,
            position_currency,
            effects,
            run,
        )?;
        for lot in &reduction.fully_consumed {
            effects
                .closures
                .push(self.closure(account, asset, lot, event, position_currency)?);
        }
        Ok(())
    }

    fn closure(
        &self,
        account: &AccountId,
        asset: &AssetId,
        lot: &Lot,
        event: &EconomicEvent,
        position_currency: &Currency,
    ) -> Result<LotClosure, String> {
        let original_quantity = if lot.original_quantity.is_zero() {
            lot.quantity
        } else {
            lot.original_quantity
        };
        let fees = original_fees(lot);
        let taxes = original_taxes(lot);
        let original_cost_basis = checked(
            arith::mul(lot.acquisition_price, original_quantity),
            "closed lot cost",
        )? + fees
            + taxes;
        let fx_rate_to_base = self.lot_rate_to_base(lot, position_currency.as_str());
        let base =
            |value: Decimal| checked(arith::mul(value, fx_rate_to_base), "closed lot base cost");
        Ok(LotClosure {
            lot_id: lot.id.clone(),
            account: account.clone(),
            asset: asset.clone(),
            close_date: event.date,
            close_event: event.id.clone(),
            open_event: lot.source_event.clone(),
            open_date: lot.acquisition_date,
            original_quantity,
            cost_per_unit: lot.acquisition_price,
            original_cost_basis,
            original_cost_basis_base: base(original_cost_basis)?,
            fee_allocated: fees,
            fee_allocated_base: base(fees)?,
            tax_allocated: taxes,
            tax_allocated_base: base(taxes)?,
            currency: position_currency.clone(),
            fx_rate_to_base,
            split_ratio: lot.split_ratio,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn record_disposals(
        &self,
        account: &AccountId,
        asset: &AssetId,
        event: &EconomicEvent,
        removed: &[Lot],
        proceeds: Proceeds,
        total_quantity: Decimal,
        position_currency: &Currency,
        effects: &mut SideEffects,
        run: &mut RunLog,
    ) -> Result<(), String> {
        if removed.is_empty() || total_quantity.is_zero() {
            return Ok(());
        }
        let disposal_rate = self
            .fx
            .rate(position_currency.as_str(), self.base(), event.date)
            .unwrap_or(Decimal::ZERO);
        // Only proceeds without a base value of their own need the day's
        // rate; a transfer leg's do not (rules R2.4).
        if matches!(proceeds, Proceeds::Shared { base: None, .. }) && disposal_rate.is_zero() {
            run.diagnostics.push(Diagnostic::warning(
                DiagnosticCode::FxUnavailable,
                event.source.as_str(),
                "disposal FX to base missing; base attribution recorded as zero",
            ));
        }
        for (index, lot) in removed.iter().enumerate() {
            let effective = lot.effective_quantity();
            let cost_basis = lot.cost_basis;
            let acquisition_rate = self.lot_rate_to_base(lot, position_currency.as_str());
            let at_acquisition_rate = |amount: Decimal| {
                (!acquisition_rate.is_zero())
                    .then(|| checked(arith::mul(amount, acquisition_rate), "disposal base cost"))
                    .transpose()
            };
            let share = |total: Decimal, what: &str| {
                checked(arith::proportional(total, effective, total_quantity), what)
            };
            // Each side in base is recorded when its rate is known, whatever
            // the other's; realized P&L in base needs both (rules R3.4).
            let (proceeds, proceeds_base) = match proceeds {
                Proceeds::Shared { local, base } => {
                    let proceeds = share(local, "disposal proceeds")?;
                    let proceeds_base = match base {
                        Some(total) => Some(share(total, "disposal base proceeds")?),
                        None if !disposal_rate.is_zero() => Some(checked(
                            arith::mul(proceeds, disposal_rate),
                            "disposal base proceeds",
                        )?),
                        None => None,
                    };
                    (proceeds, proceeds_base)
                }
                Proceeds::AtCost => (cost_basis, at_acquisition_rate(cost_basis)?),
            };
            let cost_basis_base = at_acquisition_rate(cost_basis)?;
            let stored_proceeds = proceeds.round_dp(STORED_PRECISION);
            let stored_cost = cost_basis.round_dp(STORED_PRECISION);
            let stored_proceeds_base = proceeds_base.unwrap_or_default().round_dp(STORED_PRECISION);
            let stored_cost_base = cost_basis_base
                .unwrap_or_default()
                .round_dp(STORED_PRECISION);
            let realized_pnl_base = match (proceeds_base, cost_basis_base) {
                (Some(_), Some(_)) => {
                    (stored_proceeds_base - stored_cost_base).round_dp(STORED_PRECISION)
                }
                _ => Decimal::ZERO,
            };
            effects.disposals.push(LotDisposal {
                id: format!("{}:{}:{index}", event.id, lot.id),
                lot_id: lot.id.clone(),
                account: account.clone(),
                asset: asset.clone(),
                event: event.id.clone(),
                date: event.date,
                quantity: effective,
                proceeds: stored_proceeds,
                cost_basis: stored_cost,
                realized_pnl: (stored_proceeds - stored_cost).round_dp(STORED_PRECISION),
                proceeds_base: stored_proceeds_base,
                cost_basis_base: stored_cost_base,
                realized_pnl_base,
                currency: position_currency.clone(),
                fx_rate_to_base: disposal_rate,
            });
        }
        Ok(())
    }

    /// The lots' cost in base at the rates they were acquired at; `None`
    /// when one has no rate.
    fn historical_base_cost(&self, lots: &[Lot], position_currency: &str) -> Option<Decimal> {
        lots.iter()
            .map(|lot| {
                let rate = self.lot_rate_to_base(lot, position_currency);
                (!rate.is_zero())
                    .then(|| arith::mul(lot.cost_basis, rate))
                    .flatten()
            })
            .sum()
    }

    fn lot_rate_to_base(&self, lot: &Lot, position_currency: &str) -> Decimal {
        lot.stored_fx_rate_to(self.base())
            .or_else(|| {
                self.fx
                    .rate(position_currency, self.base(), lot.acquisition_date)
            })
            .unwrap_or(Decimal::ZERO)
    }
}

/// An activity's unit price, fee and tax in its position's currency, and
/// the rate used: as recorded when the currencies agree, at the activity's
/// own rate when one side is the account's currency, else at the day's rate.
/// Projection and valuation convert alike.
pub(crate) fn in_position_currency(
    fx: &FxResolver<'_>,
    event: &EconomicEvent,
    [unit_price, fee, tax]: [Decimal; 3],
    position_currency: &str,
    account_currency: &str,
) -> Result<(Decimal, Decimal, Decimal, Option<Decimal>), String> {
    let activity_currency = event.currency.as_str();
    if position_currency.is_empty() || position_currency == activity_currency {
        return Ok((unit_price, fee, tax, None));
    }
    let can_use_rate =
        position_currency == account_currency || activity_currency == account_currency;
    if can_use_rate {
        if let Some(rate) = event.fx_rate {
            let at_rate =
                |amount: Decimal| checked(arith::mul(amount, rate), "amount at the supplied rate");
            return Ok((
                at_rate(unit_price)?,
                at_rate(fee)?,
                at_rate(tax)?,
                Some(rate),
            ));
        }
    }
    let convert = |amount: Decimal, what: &str| {
        fx.convert(amount, activity_currency, position_currency, event.date)
            .ok_or_else(|| {
                format!(
                    "failed to convert {what} from {activity_currency} to {position_currency} on {}",
                    event.date
                )
            })
    };
    let price = convert(unit_price, "unit_price")?;
    let fee = convert(fee, "fee")?;
    let tax = convert(tax, "tax")?;
    let fx_used = arith::div(price, unit_price);
    Ok((price, fee, tax, fx_used))
}

/// What the units a reduction removes receive.
#[derive(Clone, Copy)]
enum Proceeds {
    /// A total in the position's currency, shared by the units removed: a
    /// sale's proceeds, or the cost of the units a transfer delivered to
    /// cover the position, with its base value when known (rules R2.4).
    /// Without one, it converts at the disposal day's rate.
    Shared {
        local: Decimal,
        base: Option<Decimal>,
    },
    /// Each lot its own cost, in base at its acquisition rate: a transfer
    /// leg gives what it removed and realizes nothing (rules R2.4).
    AtCost,
}

impl Proceeds {
    fn sale(local: Decimal) -> Self {
        Self::Shared { local, base: None }
    }
}

struct BookBasis {
    acquisition_date: NaiveDate,
    fx_rate_to_account: Option<Decimal>,
    account_currency: Option<Currency>,
    fx_rate_to_base: Option<Decimal>,
    base_currency: Option<Currency>,
}

// ------------------------------------------------------------ lot algebra

fn is_significant(quantity: Decimal) -> bool {
    quantity.abs() >= QUANTITY_THRESHOLD
}

fn proportional(amount: Decimal, part: Decimal, total: Decimal) -> Result<Decimal, String> {
    if amount.is_zero() || part.is_zero() || total.is_zero() {
        Ok(Decimal::ZERO)
    } else {
        checked(arith::proportional(amount, part, total), "pro-rated amount")
    }
}

fn effective_unit_price(
    quantity: Decimal,
    gross_abs: Decimal,
    unit_price: Decimal,
    multiplier: Decimal,
) -> Result<Decimal, String> {
    if !quantity.is_zero() && !gross_abs.is_zero() {
        checked(arith::div(gross_abs, quantity), "unit price")
    } else {
        checked(arith::mul(unit_price, multiplier), "unit price")
    }
}

/// Reports a reduction that found fewer units than requested (I10): none at
/// all, or a shortfall beyond the quantity threshold.
fn report_shortfall(
    event: &EconomicEvent,
    verb: &str,
    asset: &AssetId,
    requested: Decimal,
    reduced: Decimal,
    run: &mut RunLog,
) {
    if reduced.is_zero() {
        run.diagnostics.push(Diagnostic::warning(
            DiagnosticCode::NoPositionToReduce,
            event.source.as_str(),
            format!("{verb} of {asset} with no units held; nothing disposed"),
        ));
    } else if is_significant(requested - reduced) {
        run.diagnostics.push(Diagnostic::warning(
            DiagnosticCode::InsufficientQuantity,
            event.source.as_str(),
            format!(
                "{verb} of {requested} {asset} with only {reduced} held; the {} units beyond the position have no lot",
                requested - reduced
            ),
        ));
    }
}

/// Spreads a fee over the lots an event delivered, by effective units, so
/// it is part of their basis the way a trade fee is part of its lot's.
fn capitalize_fee(
    position: &mut Position,
    event: &EventId,
    fee: Decimal,
    allows_negative: bool,
) -> Result<(), String> {
    let delivered: Vec<usize> = (0..position.lots.len())
        .filter(|i| position.lots[*i].source_event.as_ref() == Some(event))
        .collect();
    let Some((&last, rest)) = delivered.split_last() else {
        return Ok(());
    };
    let total: Decimal = delivered
        .iter()
        .map(|i| position.lots[*i].effective_quantity().abs())
        .sum();
    let mut remaining = fee;
    for &index in rest {
        let lot = &mut position.lots[index];
        let share = proportional(fee, lot.effective_quantity().abs(), total)?;
        add_fee(lot, share);
        remaining -= share;
    }
    add_fee(&mut position.lots[last], remaining);
    recalculate_aggregates(position, allows_negative)
}

fn add_fee(lot: &mut Lot, fee: Decimal) {
    lot.cost_basis += fee;
    lot.fees += fee;
    lot.original_fees += fee;
}

fn positive_effective(position: &Position) -> Decimal {
    position
        .lots
        .iter()
        .filter(|l| l.quantity > Decimal::ZERO)
        .map(Lot::effective_quantity)
        .sum()
}

fn negative_effective_abs(position: &Position) -> Decimal {
    position
        .lots
        .iter()
        .filter(|l| l.quantity < Decimal::ZERO)
        .map(|l| l.effective_quantity().abs())
        .sum()
}

fn original_fees(lot: &Lot) -> Decimal {
    if lot.original_fees.is_zero() && !lot.fees.is_zero() {
        lot.fees
    } else {
        lot.original_fees
    }
}

fn original_taxes(lot: &Lot) -> Decimal {
    if lot.original_taxes.is_zero() && !lot.taxes.is_zero() {
        lot.taxes
    } else {
        lot.original_taxes
    }
}

fn sort_lots(position: &mut Position) {
    position.lots.sort_by_key(|lot| lot.acquisition);
}

/// Legacy `recalculate_aggregates_with_policy`.
fn recalculate_aggregates(position: &mut Position, allows_negative: bool) -> Result<(), String> {
    let quantity: Decimal = position.lots.iter().map(Lot::effective_quantity).sum();
    let cost_basis: Decimal = position.lots.iter().map(|l| l.cost_basis).sum();
    position.quantity = quantity;
    position.total_cost_basis = cost_basis;
    if allows_negative && quantity.is_sign_negative() {
        if is_significant(quantity) {
            position.average_cost =
                checked(arith::div(cost_basis.abs(), quantity.abs()), "average cost")?;
        } else {
            position.quantity = Decimal::ZERO;
            position.average_cost = Decimal::ZERO;
        }
    } else if quantity.is_sign_positive() && is_significant(quantity) {
        position.average_cost = checked(arith::div(cost_basis, quantity), "average cost")?;
    } else {
        position.quantity = Decimal::ZERO;
        position.total_cost_basis = Decimal::ZERO;
        position.average_cost = Decimal::ZERO;
    }
    if let Some(first) = position.lots.iter().map(|l| l.acquisition).min() {
        position.inception = first;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn new_lot(
    id: String,
    quantity: Decimal,
    price: Decimal,
    fee: Decimal,
    tax: Decimal,
    event: &EconomicEvent,
    fx_used: Option<Decimal>,
    book: &BookBasis,
) -> Result<Lot, String> {
    Ok(Lot {
        id,
        acquisition: event.timestamp,
        acquisition_date: book.acquisition_date,
        quantity,
        original_quantity: quantity,
        cost_basis: checked(arith::mul(quantity, price), "lot cost")? + fee + tax,
        acquisition_price: price,
        fees: fee,
        original_fees: fee,
        taxes: tax,
        original_taxes: tax,
        fx_rate_to_position: fx_used,
        fx_rate_to_account: book.fx_rate_to_account,
        account_currency: book.account_currency.clone(),
        fx_rate_to_base: book.fx_rate_to_base,
        base_currency: book.base_currency.clone(),
        source_event: Some(event.id.clone()),
        split_ratio: Decimal::ONE,
    })
}

#[allow(clippy::too_many_arguments)]
fn add_lot(
    position: &mut Position,
    id: String,
    quantity: Decimal,
    price: Decimal,
    fee: Decimal,
    tax: Decimal,
    event: &EconomicEvent,
    fx_used: Option<Decimal>,
    book: &BookBasis,
) -> Result<Decimal, String> {
    if !quantity.is_sign_positive() || quantity.is_zero() {
        return Ok(Decimal::ZERO);
    }
    let lot = new_lot(id, quantity, price, fee, tax, event, fx_used, book)?;
    let cost_basis = lot.cost_basis;
    position.lots.push(lot);
    sort_lots(position);
    recalculate_aggregates(position, false)?;
    Ok(cost_basis)
}

#[allow(clippy::too_many_arguments)]
fn open_lot_signed(
    position: &mut Position,
    id: String,
    signed_quantity: Decimal,
    price: Decimal,
    fee: Decimal,
    tax: Decimal,
    event: &EconomicEvent,
    fx_used: Option<Decimal>,
    book: &BookBasis,
    allows_negative: bool,
) -> Result<Decimal, String> {
    if signed_quantity.is_zero() {
        return Ok(Decimal::ZERO);
    }
    if signed_quantity.is_sign_negative() && !allows_negative {
        return Err(format!(
            "negative lots are not allowed for {}",
            position.asset
        ));
    }
    let lot = new_lot(id, signed_quantity, price, fee, tax, event, fx_used, book)?;
    let cost_basis = lot.cost_basis;
    position.lots.push(lot);
    sort_lots(position);
    recalculate_aggregates(position, allows_negative)?;
    Ok(cost_basis)
}

/// Legacy `add_transferred_lots` (no FX re-rating: same asset, same currency).
fn add_transferred_lots(
    position: &mut Position,
    prefix: &str,
    lots: &[Lot],
    allows_negative: bool,
) -> Result<Decimal, String> {
    let mut total = Decimal::ZERO;
    for (i, source) in lots.iter().enumerate() {
        if source.quantity.is_zero() || (source.quantity.is_sign_negative() && !allows_negative) {
            continue;
        }
        let lot = Lot {
            id: if lots.len() == 1 {
                prefix.to_string()
            } else {
                format!("{prefix}_lot{i}")
            },
            acquisition: source.acquisition,
            acquisition_date: source.acquisition_date,
            quantity: source.quantity,
            original_quantity: source.quantity,
            cost_basis: source.cost_basis,
            acquisition_price: source.acquisition_price,
            fees: source.fees,
            original_fees: source.fees,
            taxes: source.taxes,
            original_taxes: source.taxes,
            fx_rate_to_position: source.fx_rate_to_position,
            fx_rate_to_account: source.fx_rate_to_account,
            account_currency: source.account_currency.clone(),
            fx_rate_to_base: source.fx_rate_to_base,
            base_currency: source.base_currency.clone(),
            source_event: Some(EventId::new(prefix)),
            split_ratio: source.split_ratio,
        };
        total += lot.cost_basis;
        position.lots.push(lot);
    }
    sort_lots(position);
    recalculate_aggregates(position, allows_negative)?;
    Ok(total)
}

/// Splits single-signed lots into (cover, residual) by effective units.
fn split_lots_by_cover(lots: &[Lot], cover_abs: Decimal) -> Result<(Vec<Lot>, Vec<Lot>), String> {
    let mut cover = Vec::new();
    let mut residual = Vec::new();
    let mut remaining = cover_abs;
    for lot in lots {
        let effective_abs = lot.effective_quantity().abs();
        if remaining <= Decimal::ZERO || effective_abs.is_zero() {
            residual.push(lot.clone());
            continue;
        }
        if effective_abs <= remaining {
            remaining -= effective_abs;
            cover.push(lot.clone());
            continue;
        }
        let consumed_acquired = if lot.split_ratio.is_zero() {
            remaining
        } else {
            checked(arith::div(remaining, lot.split_ratio), "covered quantity")?
        };
        let consumed_signed = if lot.quantity.is_sign_negative() {
            -consumed_acquired
        } else {
            consumed_acquired
        };
        let fraction = checked(arith::div(consumed_signed, lot.quantity), "covered share")?;
        let mut cover_lot = lot.clone();
        cover_lot.quantity = consumed_signed;
        cover_lot.original_quantity = consumed_signed;
        cover_lot.cost_basis = lot.cost_basis * fraction;
        cover_lot.fees = lot.fees * fraction;
        cover_lot.original_fees = cover_lot.fees;
        cover_lot.taxes = lot.taxes * fraction;
        cover_lot.original_taxes = cover_lot.taxes;
        let mut residual_lot = lot.clone();
        residual_lot.quantity = lot.quantity - consumed_signed;
        residual_lot.original_quantity = residual_lot.quantity;
        residual_lot.cost_basis = lot.cost_basis - cover_lot.cost_basis;
        residual_lot.fees = lot.fees - cover_lot.fees;
        residual_lot.original_fees = residual_lot.fees;
        residual_lot.taxes = lot.taxes - cover_lot.taxes;
        residual_lot.original_taxes = residual_lot.taxes;
        cover.push(cover_lot);
        residual.push(residual_lot);
        remaining = Decimal::ZERO;
    }
    Ok((cover, residual))
}

/// Relieves long lots in effective units (`relieve`).
fn relieve_long_lots(
    position: &mut Position,
    requested: Decimal,
    method: CostBasisMethod,
) -> Result<Reduction, String> {
    relieve(position, requested, false, method)
}

fn relieve_short_lots(
    position: &mut Position,
    requested: Decimal,
    method: CostBasisMethod,
) -> Result<Reduction, String> {
    relieve(position, requested, true, method)
}

/// Relieves `requested` units from a position's long (or `negative`) lots
/// as the account's cost basis method chooses them (rules §7): every sale,
/// cover, transfer out and expiry goes through here. A method decides which
/// lots and how much of each, and returns what it removed; it never changes
/// units held, cash or prices. The cost removed is what a transfer carries.
fn relieve(
    position: &mut Position,
    requested: Decimal,
    negative: bool,
    method: CostBasisMethod,
) -> Result<Reduction, String> {
    match method {
        CostBasisMethod::Fifo => reduce_fifo(position, requested, negative),
    }
}

/// Splits the lots a transfer delivers into those that cover `cover_abs`
/// units of an opposite position and the rest, as the receiving account's
/// cost basis method chooses them (rules §7).
fn split_for_cover(
    lots: &[Lot],
    cover_abs: Decimal,
    method: CostBasisMethod,
) -> Result<(Vec<Lot>, Vec<Lot>), String> {
    match method {
        CostBasisMethod::Fifo => split_lots_by_cover(lots, cover_abs),
    }
}

fn reduce_fifo(
    position: &mut Position,
    requested: Decimal,
    negative: bool,
) -> Result<Reduction, String> {
    if !requested.is_sign_positive() || requested.is_zero() {
        return Err("quantity to reduce must be positive".to_string());
    }
    let side_ok = |lot: &Lot| {
        if negative {
            lot.quantity < Decimal::ZERO
        } else {
            lot.quantity > Decimal::ZERO
        }
    };
    let available: Decimal = position
        .lots
        .iter()
        .filter(|l| side_ok(l))
        .map(|l| l.effective_quantity().abs())
        .sum();
    let empty = Reduction {
        quantity_reduced: Decimal::ZERO,
        cost_basis_removed: Decimal::ZERO,
        removed_lots: Vec::new(),
        fully_consumed: Vec::new(),
    };
    if !is_significant(available) || available <= Decimal::ZERO {
        return Ok(empty);
    }
    let mut to_reduce = requested.min(available);
    sort_lots(position);

    let mut removed_lots = Vec::new();
    let mut fully_consumed = Vec::new();
    let mut quantity_reduced = Decimal::ZERO;
    let mut cost_removed = Decimal::ZERO;
    let mut keep: Vec<Lot> = Vec::with_capacity(position.lots.len());
    for mut lot in position.lots.drain(..) {
        if to_reduce <= Decimal::ZERO || !side_ok(&lot) {
            keep.push(lot);
            continue;
        }
        let ratio = lot.split_ratio;
        let effective_abs = lot.effective_quantity().abs();
        if effective_abs <= Decimal::ZERO {
            keep.push(lot);
            continue;
        }
        let consume = effective_abs.min(to_reduce);
        let acquired_abs = if ratio.is_zero() {
            consume
        } else {
            checked(arith::div(consume, ratio), "reduced quantity")?
        };
        let share = checked(
            arith::div(acquired_abs, lot.quantity.abs()),
            "reduced share",
        )?;
        let basis_removed = lot.cost_basis * share;
        let fees_removed = lot.fees * share;
        let taxes_removed = lot.taxes * share;
        let removed_signed = if negative {
            -acquired_abs
        } else {
            acquired_abs
        };
        // What a split's rounding leaves of a request (a third of a unit
        // split 3:1 holds 0.999…9) can be too small to take any of this
        // lot's as-acquired units: that slice removes nothing, so no
        // disposal records it.
        if !acquired_abs.is_zero() {
            removed_lots.push(Lot {
                id: lot.id.clone(),
                acquisition: lot.acquisition,
                acquisition_date: lot.acquisition_date,
                quantity: removed_signed,
                original_quantity: removed_signed,
                cost_basis: basis_removed,
                acquisition_price: lot.acquisition_price,
                fees: fees_removed,
                original_fees: fees_removed,
                taxes: taxes_removed,
                original_taxes: taxes_removed,
                fx_rate_to_position: lot.fx_rate_to_position,
                fx_rate_to_account: lot.fx_rate_to_account,
                account_currency: lot.account_currency.clone(),
                fx_rate_to_base: lot.fx_rate_to_base,
                base_currency: lot.base_currency.clone(),
                source_event: lot.source_event.clone(),
                split_ratio: ratio,
            });
        }
        quantity_reduced += consume;
        cost_removed += basis_removed;
        to_reduce -= consume;
        let remaining = lot.quantity - removed_signed;
        let consumed = if negative {
            remaining >= Decimal::ZERO
        } else {
            remaining <= Decimal::ZERO
        } || !is_significant(remaining);
        if consumed {
            fully_consumed.push(lot);
        } else {
            lot.quantity = remaining;
            lot.cost_basis -= basis_removed;
            lot.fees -= fees_removed;
            lot.taxes -= taxes_removed;
            keep.push(lot);
        }
    }
    position.lots = keep;
    let allows_negative = negative || position.lots.iter().any(|l| l.quantity < Decimal::ZERO);
    recalculate_aggregates(position, allows_negative)?;
    Ok(Reduction {
        quantity_reduced,
        cost_basis_removed: cost_removed,
        removed_lots,
        fully_consumed,
    })
}

/// Lots in storage shape: open lots from the final state plus closed lots,
/// a closure replacing the open row with the same id. Base amounts use the
/// lot's stored rate, else the acquisition-date rate.
pub fn lot_records(
    bundle: &ProjectionBundle,
    facts: &CanonicalFacts,
    fx: &FxResolver<'_>,
) -> Vec<LotRecord> {
    let base = facts.policy.base_currency.as_str();
    // Legacy parity: lots opened by composite legs (`{activity}:buy`) carry
    // no open activity; `CompiledLedger::source_of` maps such ids for stores
    // that need a real activity id.
    let activity_ids: BTreeSet<&str> = facts.activities.iter().map(|a| a.id.as_str()).collect();
    let open_activity = |event: Option<&EventId>| -> Option<ActivityId> {
        event
            .filter(|id| activity_ids.contains(id.as_str()))
            .map(|id| ActivityId::new(id.as_str()))
    };

    let mut records: BTreeMap<(AccountId, String), LotRecord> = BTreeMap::new();
    for (account_id, state) in &bundle.final_state.accounts {
        for position in state.positions.values() {
            for lot in &position.lots {
                let original_quantity = if lot.original_quantity.is_zero() {
                    lot.quantity
                } else {
                    lot.original_quantity
                };
                let fees = if lot.original_fees.is_zero() && !lot.fees.is_zero() {
                    lot.fees
                } else {
                    lot.original_fees
                };
                let taxes = if lot.original_taxes.is_zero() && !lot.taxes.is_zero() {
                    lot.taxes
                } else {
                    lot.original_taxes
                };
                // In range: the fold checked this product when the lot opened.
                let original_cost_basis = lot.acquisition_price * original_quantity + fees + taxes;
                let rate = lot
                    .stored_fx_rate_to(base)
                    .or_else(|| fx.rate(position.currency.as_str(), base, lot.acquisition_date))
                    .unwrap_or(Decimal::ZERO);
                // A base amount outside the range reads like an unavailable rate.
                let at_rate = |value: Decimal| arith::mul(value, rate).unwrap_or(Decimal::ZERO);
                records.insert(
                    (account_id.clone(), lot.id.clone()),
                    LotRecord {
                        id: lot.id.clone(),
                        account: account_id.clone(),
                        asset: position.asset.clone(),
                        open_date: lot.acquisition_date,
                        open_activity: open_activity(lot.source_event.as_ref()),
                        original_quantity,
                        remaining_quantity: lot.quantity,
                        cost_per_unit: lot.acquisition_price,
                        original_cost_basis,
                        remaining_cost_basis: lot.cost_basis,
                        original_cost_basis_base: at_rate(original_cost_basis),
                        remaining_cost_basis_base: at_rate(lot.cost_basis),
                        fee_allocated: fees,
                        fee_allocated_base: at_rate(fees),
                        tax_allocated: taxes,
                        tax_allocated_base: at_rate(taxes),
                        currency: position.currency.clone(),
                        fx_rate_to_base: rate,
                        fx_rate_to_account: lot.fx_rate_to_account,
                        split_ratio: lot.split_ratio,
                        close_date: None,
                        close_event: None,
                    },
                );
            }
        }
    }
    for closure in &bundle.closures {
        records.insert(
            (closure.account.clone(), closure.lot_id.clone()),
            LotRecord {
                id: closure.lot_id.clone(),
                account: closure.account.clone(),
                asset: closure.asset.clone(),
                open_date: closure.open_date,
                open_activity: open_activity(closure.open_event.as_ref()),
                original_quantity: closure.original_quantity,
                remaining_quantity: Decimal::ZERO,
                cost_per_unit: closure.cost_per_unit,
                original_cost_basis: closure.original_cost_basis,
                remaining_cost_basis: Decimal::ZERO,
                original_cost_basis_base: closure.original_cost_basis_base,
                remaining_cost_basis_base: Decimal::ZERO,
                fee_allocated: closure.fee_allocated,
                fee_allocated_base: closure.fee_allocated_base,
                tax_allocated: closure.tax_allocated,
                tax_allocated_base: closure.tax_allocated_base,
                currency: closure.currency.clone(),
                fx_rate_to_base: closure.fx_rate_to_base,
                // Legacy dropped the account rate when a lot closed.
                fx_rate_to_account: None,
                split_ratio: closure.split_ratio,
                close_date: Some(closure.close_date),
                close_event: Some(closure.close_event.clone()),
            },
        );
    }
    let mut records: Vec<LotRecord> = records.into_values().collect();
    records.sort_by(|a, b| {
        a.account
            .cmp(&b.account)
            .then_with(|| a.open_date.cmp(&b.open_date))
            .then_with(|| a.id.cmp(&b.id))
    });
    records
}
