//! Stage 3: fold economic events into daily account state — a pure port of
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

use crate::compile::CompiledLedger;
use crate::diagnostics::{Diagnostic, DiagnosticCode};
use crate::error::EngineError;
use crate::model::*;
use crate::resolve::FxResolver;

/// Positions below this effective quantity are treated as closed.
const QUANTITY_THRESHOLD: Decimal = Decimal::from_parts(1, 0, 0, false, 8);
/// Storage scale for disposal money fields (legacy `DECIMAL_PRECISION`).
const STORAGE_SCALE: u32 = 8;

pub fn project(
    ledger: &CompiledLedger,
    facts: &CanonicalFacts,
    fx: &FxResolver<'_>,
    start: Option<ProjectionState>,
    range: DateRange,
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
        explicit_rates: facts
            .activities
            .iter()
            .filter_map(|a| a.fx_rate.map(|rate| (a.id.as_str(), rate)))
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
    for (id, account) in &facts.accounts {
        if account.archived || account.tracking == TrackingMode::Holdings {
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
                .get(account_id)
                .expect("scoped account has state")
                .clone();
            let next = if events.is_empty() {
                account
            } else {
                projector.fold_day(account, events, day, &mut state.transfer_cache, &mut run)
            };
            keyframes
                .entry(account_id.clone())
                .or_default()
                .push(Keyframe {
                    date: day,
                    state: next.clone(),
                });
            state.accounts.insert(account_id.clone(), next);
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
    cache_inserts: Vec<(String, Vec<Lot>)>,
    cache_removals: Vec<String>,
}

#[derive(Default)]
struct RunLog {
    disposals: Vec<LotDisposal>,
    closures: Vec<LotClosure>,
    diagnostics: Vec<Diagnostic>,
}

struct Projector<'a> {
    facts: &'a CanonicalFacts,
    fx: &'a FxResolver<'a>,
    /// Activity → account rate supplied with the row, by activity id.
    explicit_rates: HashMap<&'a str, Decimal>,
}

struct Reduction {
    quantity_reduced: Decimal,
    cost_basis_removed: Decimal,
    removed_lots: Vec<Lot>,
    fully_consumed: Vec<Lot>,
}

impl Projector<'_> {
    fn base(&self) -> &str {
        self.facts.policy.base_currency.as_str()
    }

    fn asset_facts(&self, asset: &AssetId, currency: &Currency) -> AssetFacts {
        self.facts
            .assets
            .get(asset)
            .cloned()
            .unwrap_or_else(|| AssetFacts::fallback(asset.clone(), currency.clone()))
    }

    fn fold_day(
        &self,
        mut account: AccountState,
        events: &[&EconomicEvent],
        day: NaiveDate,
        cache: &mut BTreeMap<String, Vec<Lot>>,
        run: &mut RunLog,
    ) -> AccountState {
        for event in events {
            let mut scratch = account.clone();
            let mut effects = SideEffects::default();
            match self.apply(event, &mut scratch, cache, &mut effects, run) {
                Ok(()) => {
                    account = scratch;
                    run.disposals.extend(effects.disposals);
                    run.closures.extend(effects.closures);
                    for (group, lots) in effects.cache_inserts {
                        cache.insert(group, lots);
                    }
                    for group in effects.cache_removals {
                        cache.remove(&group);
                    }
                }
                Err(message) => run.diagnostics.push(Diagnostic::error(
                    DiagnosticCode::ActivityRejected,
                    event.id.as_str(),
                    message,
                )),
            }
        }

        // Book cost in account currency at acquisition FX, then the
        // precomputed per-position scalars, then cash totals (once per day).
        let account_currency = account.currency.clone();
        account.cost_basis = account
            .positions
            .values()
            .map(|position| {
                self.position_cost_basis_in_account_currency(position, &account_currency, day, run)
            })
            .sum();
        let base = self.base().to_string();
        for position in account.positions.values_mut() {
            position.cost_basis_account =
                self.precompute_cost_basis(position, account_currency.as_str());
            position.cost_basis_base = self.precompute_cost_basis(position, &base);
        }
        self.compute_cash_totals(&mut account, day, run);
        account
    }

    fn apply(
        &self,
        event: &EconomicEvent,
        state: &mut AccountState,
        cache: &BTreeMap<String, Vec<Lot>>,
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
                group,
            } => match direction {
                Direction::In => self.transfer_in(
                    event,
                    state,
                    asset,
                    *quantity,
                    *unit_price,
                    *legacy_amount,
                    group.as_deref(),
                    cache,
                    effects,
                    run,
                ),
                Direction::Out => self.transfer_out(
                    event,
                    state,
                    asset,
                    *quantity,
                    group.as_deref(),
                    effects,
                    run,
                ),
            },
            Action::Split { asset, ratio } => {
                self.split(event, state, asset, *ratio, run);
                Ok(())
            }
            Action::OptionExpiry { asset, quantity } => {
                self.option_expiry(event, state, asset, *quantity, effects, run);
                Ok(())
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
        self.book_cash(state, event, cash);
        if event.contribution == Contribution::CashGross {
            let gross = cash.gross.unwrap_or(Decimal::ZERO);
            let account_currency = state.currency.clone();
            let amount_account =
                self.to_account_currency(gross, event, account_currency.as_str(), run);
            let amount_base = self.gross_to_base(gross, event, run);
            state.net_contribution += amount_account;
            state.net_contribution_base += amount_base;
        }
        Ok(())
    }

    fn book_cash(&self, state: &mut AccountState, event: &EconomicEvent, cash: &CashEffect) {
        let (currency, amount) = match cash.booking {
            Booking::ActivityCurrency => (event.currency.clone(), cash.amount),
            Booking::AccountCurrency { rate } => (state.currency.clone(), cash.amount * rate),
        };
        *state.cash.entry(currency).or_insert(Decimal::ZERO) += amount;
    }

    /// Legacy `convert_to_account_currency`: explicit rate, else FX on the
    /// activity date, else the unconverted amount (diagnosed).
    fn to_account_currency(
        &self,
        amount: Decimal,
        event: &EconomicEvent,
        account_currency: &str,
        run: &mut RunLog,
    ) -> Decimal {
        let from = event.currency.as_str();
        if from == account_currency {
            return amount;
        }
        if let Some(rate) = self.explicit_rate(event) {
            return amount * rate;
        }
        match self.fx.convert(amount, from, account_currency, event.date) {
            Some(converted) => converted,
            None => {
                run.diagnostics.push(Diagnostic::warning(
                    DiagnosticCode::FxUnavailable,
                    event.source.as_str(),
                    format!(
                        "no {from}->{account_currency} rate on {}; amount carried unconverted",
                        event.date
                    ),
                ));
                amount
            }
        }
    }

    /// Net-contribution base leg: FX on the activity date, else zero (legacy).
    fn gross_to_base(&self, gross: Decimal, event: &EconomicEvent, run: &mut RunLog) -> Decimal {
        match self
            .fx
            .convert(gross, event.currency.as_str(), self.base(), event.date)
        {
            Some(converted) => converted,
            None => {
                run.diagnostics.push(Diagnostic::warning(
                    DiagnosticCode::FxUnavailable,
                    event.source.as_str(),
                    format!(
                        "no {}->{} rate on {}; base contribution not updated",
                        event.currency,
                        self.base(),
                        event.date
                    ),
                ));
                Decimal::ZERO
            }
        }
    }

    fn explicit_rate(&self, event: &EconomicEvent) -> Option<Decimal> {
        self.explicit_rates.get(event.source.as_str()).copied()
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
            effective_unit_price(quantity, gross_abs, unit_price, info.contract_multiplier);
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
            let short_quantity = negative_effective_abs(position);
            let close_quantity = quantity.min(short_quantity);
            let open_quantity = quantity - close_quantity;
            if info.requires_explicit_short_intent {
                cash_quantity = close_quantity;
            }
            if close_quantity > Decimal::ZERO {
                let close_fee = proportional(fee, close_quantity, quantity);
                let close_tax = proportional(tax, close_quantity, quantity);
                let close_cost = close_quantity * price + close_fee + close_tax;
                let reduction = reduce_negative_lots_fifo(position, close_quantity)?;
                self.record_reduction(
                    &account_id,
                    asset,
                    event,
                    &reduction,
                    close_cost,
                    &position_currency,
                    effects,
                    run,
                );
            }
            if open_quantity > Decimal::ZERO && !close_only {
                let open_fee = proportional(fee, open_quantity, quantity);
                let open_tax = proportional(tax, open_quantity, quantity);
                let lot_id = if close_quantity > Decimal::ZERO {
                    format!("{}:open", event.id)
                } else {
                    event.id.as_str().to_string()
                };
                open_lot_signed(
                    position,
                    lot_id,
                    open_quantity,
                    price,
                    open_fee,
                    open_tax,
                    event,
                    fx_used,
                    &book,
                    true,
                )?;
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
            );
        }

        if let Some(cash) = &event.cash {
            let amount = proportional(cash.amount, cash_quantity, quantity);
            let effect = CashEffect {
                amount,
                gross: cash.gross,
                booking: cash.booking,
            };
            self.book_cash(state, event, &effect);
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
            self.book_cash(state, event, cash);
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
                effective_unit_price(quantity, gross_abs, unit_price, info.contract_multiplier);
            let (price, fee, tax, fx_used) = self.to_position_currency(
                lot_unit_price,
                event.charges.fee,
                event.charges.tax,
                event,
                position_currency.as_str(),
                account_currency.as_str(),
            )?;
            let long_quantity = positive_effective(position);
            let close_quantity = quantity.min(long_quantity);
            let open_quantity = quantity - close_quantity;
            if close_quantity > Decimal::ZERO {
                let close_fee = proportional(fee, close_quantity, quantity);
                let close_tax = proportional(tax, close_quantity, quantity);
                let close_proceeds = close_quantity * price - close_fee - close_tax;
                let reduction = reduce_positive_lots_fifo(position, close_quantity)?;
                self.record_reduction(
                    &account_id,
                    asset,
                    event,
                    &reduction,
                    close_proceeds,
                    &position_currency,
                    effects,
                    run,
                );
            }
            if open_quantity > Decimal::ZERO && !close_only {
                let open_fee = proportional(fee, open_quantity, quantity);
                let open_tax = proportional(tax, open_quantity, quantity);
                let lot_id = if close_quantity > Decimal::ZERO {
                    format!("{}:open", event.id)
                } else {
                    event.id.as_str().to_string()
                };
                let book = self.lot_book_basis(
                    event,
                    position_currency.as_str(),
                    account_currency.as_str(),
                    run,
                );
                open_lot_signed(
                    position,
                    lot_id,
                    -open_quantity,
                    price,
                    open_fee,
                    open_tax,
                    event,
                    fx_used,
                    &book,
                    true,
                )?;
            }
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
            let reduction = reduce_positive_lots_fifo(position, quantity)?;
            self.record_reduction(
                &account_id,
                asset,
                event,
                &reduction,
                proceeds,
                &position_currency,
                effects,
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

    // ------------------------------------------------------------ transfers

    #[allow(clippy::too_many_arguments)]
    fn transfer_in(
        &self,
        event: &EconomicEvent,
        state: &mut AccountState,
        asset: &AssetId,
        quantity: Decimal,
        unit_price: Decimal,
        legacy_amount: Option<Decimal>,
        group: Option<&str>,
        cache: &BTreeMap<String, Vec<Lot>>,
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
        let cached = group.and_then(|g| cache.get(g).cloned());

        let (cost_basis_asset, added_lots, cover) = if let Some(lots) = cached {
            let incoming_negative = lots
                .iter()
                .find(|lot| !lot.quantity.is_zero())
                .map(|lot| lot.quantity.is_sign_negative())
                .unwrap_or(false);
            let incoming_abs: Decimal = lots.iter().map(|l| l.effective_quantity().abs()).sum();
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
                let (cover_lots, residual) = split_lots_by_cover(&lots, cover_abs);
                let cover_proceeds: Decimal = cover_lots
                    .iter()
                    .map(|l| l.cost_basis)
                    .sum::<Decimal>()
                    .abs();
                let reduction = if incoming_negative {
                    reduce_positive_lots_fifo(position, cover_abs)?
                } else {
                    reduce_negative_lots_fifo(position, cover_abs)?
                };
                (residual, Some((reduction, cover_proceeds)))
            } else {
                (lots.clone(), None)
            };
            let cost_basis = add_transferred_lots(
                position,
                event.id.as_str(),
                &to_add,
                info.allows_negative_lots,
            );
            let added: Vec<Lot> = position
                .lots
                .iter()
                .filter(|lot| lot.source_event.as_ref() == Some(&event.id))
                .cloned()
                .collect();
            if let Some(g) = group {
                if cover_abs > Decimal::ZERO || !added.is_empty() {
                    effects.cache_removals.push(g.to_string());
                } else {
                    run.diagnostics.push(Diagnostic::warning(
                        DiagnosticCode::ActivityRejected,
                        event.source.as_str(),
                        format!("TRANSFER_IN booked none of the cached lots for {asset} (negative lots not allowed); cache kept"),
                    ));
                }
            }
            (cost_basis, added, cover)
        } else {
            let compiled_basis = {
                let price_basis = quantity * unit_price * info.contract_multiplier;
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
                compiled_basis / quantity
            };
            let (price, fee, _tax, fx_used) = self.to_position_currency(
                lot_unit_price,
                event.charges.fee,
                Decimal::ZERO,
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
            let cost_basis = add_lot(
                position,
                event.id.as_str().to_string(),
                quantity,
                price,
                fee,
                Decimal::ZERO,
                event,
                fx_used,
                &book,
            );
            let added: Vec<Lot> = position
                .lots
                .iter()
                .filter(|lot| lot.source_event.as_ref() == Some(&event.id))
                .cloned()
                .collect();
            (cost_basis, added, None)
        };

        if let Some((reduction, cover_proceeds)) = cover {
            self.record_reduction(
                &account_id,
                asset,
                event,
                &reduction,
                cover_proceeds,
                &position_currency,
                effects,
                run,
            );
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
                        "no rate for the transferred basis to base; carried unconverted",
                    ));
                    cost_basis_asset
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
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn transfer_out(
        &self,
        event: &EconomicEvent,
        state: &mut AccountState,
        asset: &AssetId,
        quantity: Decimal,
        group: Option<&str>,
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
            reduce_negative_lots_fifo(position, quantity)?
        } else {
            reduce_positive_lots_fifo(position, quantity)?
        };
        let removed = reduction.cost_basis_removed;
        let proceeds = if short { removed.abs() } else { removed };
        self.record_reduction(
            &account_id,
            asset,
            event,
            &reduction,
            proceeds,
            &position_currency,
            effects,
            run,
        );
        if !position_currency.as_str().is_empty() && removed != Decimal::ZERO {
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
        if let Some(g) = group {
            if !reduction.removed_lots.is_empty() {
                effects
                    .cache_inserts
                    .push((g.to_string(), reduction.removed_lots));
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
        _run: &mut RunLog,
    ) {
        let Some(position) = state.positions.get_mut(asset) else {
            return;
        };
        let policy = &self.facts.policy;
        for lot in &mut position.lots {
            if lot.acquisition.with_timezone(&policy.timezone).date_naive() < event.date {
                lot.split_ratio *= ratio;
            }
        }
        let allows_negative = position.lots.iter().any(|lot| lot.quantity < Decimal::ZERO);
        recalculate_aggregates(position, allows_negative);
    }

    fn option_expiry(
        &self,
        event: &EconomicEvent,
        state: &mut AccountState,
        asset: &AssetId,
        quantity: Decimal,
        effects: &mut SideEffects,
        run: &mut RunLog,
    ) {
        let account_id = state.account.clone();
        let Some(position) = state.positions.get_mut(asset) else {
            run.diagnostics.push(Diagnostic::warning(
                DiagnosticCode::NoPositionToReduce,
                event.source.as_str(),
                format!("OPTION_EXPIRY: no position for {asset}; ignored"),
            ));
            return;
        };
        let position_currency = position.currency.clone();
        let reduction = if position.quantity < Decimal::ZERO {
            reduce_negative_lots_fifo(position, quantity)
        } else {
            reduce_positive_lots_fifo(position, quantity)
        };
        match reduction {
            Ok(reduction) => self.record_reduction(
                &account_id,
                asset,
                event,
                &reduction,
                Decimal::ZERO,
                &position_currency,
                effects,
                run,
            ),
            Err(message) => run.diagnostics.push(Diagnostic::error(
                DiagnosticCode::ActivityRejected,
                event.source.as_str(),
                message,
            )),
        }
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
        let activity_currency = event.currency.as_str();
        if position_currency.is_empty() || position_currency == activity_currency {
            return Ok((unit_price, fee, tax, None));
        }
        let can_use_rate =
            position_currency == account_currency || activity_currency == account_currency;
        if can_use_rate {
            if let Some(rate) = self.explicit_rate(event) {
                return Ok((unit_price * rate, fee * rate, tax * rate, Some(rate)));
            }
        }
        let convert = |amount: Decimal, what: &str| {
            self.fx
                .convert(amount, activity_currency, position_currency, event.date)
                .ok_or_else(|| format!("failed to convert {what} from {activity_currency} to {position_currency} on {}", event.date))
        };
        let price = convert(unit_price, "unit_price")?;
        let fee = convert(fee, "fee")?;
        let tax = convert(tax, "tax")?;
        let fx_used = (!unit_price.is_zero()).then(|| price / unit_price);
        Ok((price, fee, tax, fx_used))
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
                return Ok(amount * rate);
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
            if let Some(rate) = self.explicit_rate(event) {
                return amount * rate;
            }
        }
        match self
            .fx
            .convert(amount, position_currency, account_currency, event.date)
        {
            Some(converted) => converted,
            None => {
                run.diagnostics.push(Diagnostic::warning(
                    DiagnosticCode::FxUnavailable,
                    event.source.as_str(),
                    format!("no {position_currency}->{account_currency} rate on {}; amount carried unconverted", event.date),
                ));
                amount
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
                    .map(|account_to_base| explicit_rate * account_to_base)
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
            Some(Decimal::ONE / rate)
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
            run.diagnostics.push(Diagnostic::warning(
                DiagnosticCode::FxUnavailable,
                event.source.as_str(),
                format!("no {from}->{to} rate on {} for lot basis", event.date),
            ));
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
        if position_currency == target {
            return lot.cost_basis;
        }
        if let Some(rate) = lot.stored_fx_rate_to(target) {
            return lot.cost_basis * rate;
        }
        if let Some(converted) = self.fx.convert(
            lot.cost_basis,
            position_currency,
            target,
            lot.acquisition_date,
        ) {
            return converted;
        }
        if fallback_date == lot.acquisition_date {
            run.diagnostics.push(Diagnostic::warning(
                DiagnosticCode::FxUnavailable,
                event.source.as_str(),
                format!(
                    "no {position_currency}->{target} rate on {}; lot basis carried unconverted",
                    lot.acquisition_date
                ),
            ));
            return lot.cost_basis;
        }
        match self
            .fx
            .convert(lot.cost_basis, position_currency, target, fallback_date)
        {
            Some(converted) => converted,
            None => {
                run.diagnostics.push(Diagnostic::warning(DiagnosticCode::FxUnavailable, event.source.as_str(), format!("no {position_currency}->{target} rate on {} or {fallback_date}; lot basis carried unconverted", lot.acquisition_date)));
                lot.cost_basis
            }
        }
    }

    /// Legacy `position_cost_basis_in_account_currency`.
    fn position_cost_basis_in_account_currency(
        &self,
        position: &Position,
        account_currency: &Currency,
        day: NaiveDate,
        run: &mut RunLog,
    ) -> Decimal {
        let position_currency = position.currency.as_str();
        let target = account_currency.as_str();
        if position_currency.is_empty() {
            return Decimal::ZERO;
        }
        let soft_convert = |amount: Decimal, date: NaiveDate, run: &mut RunLog| {
            if position_currency == target {
                return amount;
            }
            match self.fx.convert(amount, position_currency, target, date) {
                Some(converted) => converted,
                None => {
                    run.diagnostics.push(Diagnostic::warning(DiagnosticCode::FxUnavailable, position.asset.as_str(), format!("no {position_currency}->{target} rate on {date}; book cost carried unconverted")));
                    amount
                }
            }
        };
        if position.lots.is_empty() {
            return soft_convert(position.total_cost_basis, day, run);
        }
        position
            .lots
            .iter()
            .filter(|lot| !lot.quantity.is_zero() && !lot.cost_basis.is_zero())
            .map(|lot| match lot.stored_fx_rate_to(target) {
                Some(rate) => lot.cost_basis * rate,
                None => soft_convert(lot.cost_basis, lot.acquisition_date, run),
            })
            .sum()
    }

    /// Legacy `compute_position_cost_basis_from_lots` (major-unit codes).
    fn precompute_cost_basis(&self, position: &Position, target: &str) -> Option<Decimal> {
        if position.lots.is_empty() {
            return None;
        }
        let policy = &self.facts.policy;
        let position_currency = policy.major_currency(position.currency.as_str());
        let target_major = policy.major_currency(target);
        let mut total = Decimal::ZERO;
        for lot in &position.lots {
            if lot.cost_basis.is_zero() {
                continue;
            }
            if let Some(rate) = lot.stored_fx_rate_to(target_major) {
                total += lot.cost_basis * rate;
                continue;
            }
            let rate = self
                .fx
                .rate(position_currency, target_major, lot.acquisition_date)?;
            total += lot.cost_basis * rate;
        }
        Some(total)
    }

    /// Cash totals in account and base currency, once per day; an
    /// unconvertible bucket is added unconverted (legacy) and diagnosed.
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
                        None => {
                            run.diagnostics.push(Diagnostic::warning(
                                DiagnosticCode::FxUnavailable,
                                format!("{}@{day}", state.account),
                                format!(
                                    "cash {amount} {code} added to the {target} total unconverted"
                                ),
                            ));
                            *total += *amount;
                        }
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
        proceeds: Decimal,
        position_currency: &Currency,
        effects: &mut SideEffects,
        run: &mut RunLog,
    ) {
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
        );
        for lot in &reduction.fully_consumed {
            effects
                .closures
                .push(self.closure(account, asset, lot, event, position_currency));
        }
    }

    fn closure(
        &self,
        account: &AccountId,
        asset: &AssetId,
        lot: &Lot,
        event: &EconomicEvent,
        position_currency: &Currency,
    ) -> LotClosure {
        let original_quantity = if lot.original_quantity.is_zero() {
            lot.quantity
        } else {
            lot.original_quantity
        };
        let fees = original_fees(lot);
        let taxes = original_taxes(lot);
        let original_cost_basis = lot.acquisition_price * original_quantity + fees + taxes;
        let fx_rate_to_base = self.lot_rate_to_base(lot, position_currency.as_str());
        LotClosure {
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
            original_cost_basis_base: original_cost_basis * fx_rate_to_base,
            fee_allocated: fees,
            fee_allocated_base: fees * fx_rate_to_base,
            tax_allocated: taxes,
            tax_allocated_base: taxes * fx_rate_to_base,
            currency: position_currency.clone(),
            fx_rate_to_base,
            split_ratio: lot.split_ratio,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn record_disposals(
        &self,
        account: &AccountId,
        asset: &AssetId,
        event: &EconomicEvent,
        removed: &[Lot],
        total_proceeds: Decimal,
        total_quantity: Decimal,
        position_currency: &Currency,
        effects: &mut SideEffects,
        run: &mut RunLog,
    ) {
        if removed.is_empty() || total_quantity.is_zero() {
            return;
        }
        let disposal_rate = self
            .fx
            .rate(position_currency.as_str(), self.base(), event.date)
            .unwrap_or(Decimal::ZERO);
        if disposal_rate.is_zero() {
            run.diagnostics.push(Diagnostic::warning(
                DiagnosticCode::FxUnavailable,
                event.source.as_str(),
                "disposal FX to base missing; base attribution recorded as zero",
            ));
        }
        for (index, lot) in removed.iter().enumerate() {
            let effective = lot.effective_quantity();
            let proceeds = total_proceeds * effective / total_quantity;
            let cost_basis = lot.cost_basis;
            let acquisition_rate = self.lot_rate_to_base(lot, position_currency.as_str());
            let base_available = !disposal_rate.is_zero() && !acquisition_rate.is_zero();
            let proceeds_base = if base_available {
                proceeds * disposal_rate
            } else {
                Decimal::ZERO
            };
            let cost_basis_base = if base_available {
                cost_basis * acquisition_rate
            } else {
                Decimal::ZERO
            };
            let stored_proceeds = proceeds.round_dp(STORAGE_SCALE);
            let stored_cost = cost_basis.round_dp(STORAGE_SCALE);
            let stored_proceeds_base = proceeds_base.round_dp(STORAGE_SCALE);
            let stored_cost_base = cost_basis_base.round_dp(STORAGE_SCALE);
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
                realized_pnl: (stored_proceeds - stored_cost).round_dp(STORAGE_SCALE),
                proceeds_base: stored_proceeds_base,
                cost_basis_base: stored_cost_base,
                realized_pnl_base: (stored_proceeds_base - stored_cost_base)
                    .round_dp(STORAGE_SCALE),
                currency: position_currency.clone(),
                fx_rate_to_base: disposal_rate,
            });
        }
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

fn proportional(amount: Decimal, part: Decimal, total: Decimal) -> Decimal {
    if amount.is_zero() || part.is_zero() || total.is_zero() {
        Decimal::ZERO
    } else {
        amount * part / total
    }
}

fn effective_unit_price(
    quantity: Decimal,
    gross_abs: Decimal,
    unit_price: Decimal,
    multiplier: Decimal,
) -> Decimal {
    if !quantity.is_zero() && !gross_abs.is_zero() {
        gross_abs / quantity
    } else {
        unit_price * multiplier
    }
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
fn recalculate_aggregates(position: &mut Position, allows_negative: bool) {
    let quantity: Decimal = position.lots.iter().map(Lot::effective_quantity).sum();
    let cost_basis: Decimal = position.lots.iter().map(|l| l.cost_basis).sum();
    position.quantity = quantity;
    position.total_cost_basis = cost_basis;
    if allows_negative && quantity.is_sign_negative() {
        if is_significant(quantity) {
            position.average_cost = cost_basis.abs() / quantity.abs();
        } else {
            position.quantity = Decimal::ZERO;
            position.average_cost = Decimal::ZERO;
        }
    } else if quantity.is_sign_positive() && is_significant(quantity) {
        position.average_cost = cost_basis / quantity;
    } else {
        position.quantity = Decimal::ZERO;
        position.total_cost_basis = Decimal::ZERO;
        position.average_cost = Decimal::ZERO;
    }
    if let Some(first) = position.lots.iter().map(|l| l.acquisition).min() {
        position.inception = first;
    }
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
) -> Lot {
    Lot {
        id,
        acquisition: event.timestamp,
        acquisition_date: book.acquisition_date,
        quantity,
        original_quantity: quantity,
        cost_basis: quantity * price + fee + tax,
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
    }
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
) -> Decimal {
    if !quantity.is_sign_positive() || quantity.is_zero() {
        return Decimal::ZERO;
    }
    let lot = new_lot(id, quantity, price, fee, tax, event, fx_used, book);
    let cost_basis = lot.cost_basis;
    position.lots.push(lot);
    sort_lots(position);
    recalculate_aggregates(position, false);
    cost_basis
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
    let lot = new_lot(id, signed_quantity, price, fee, tax, event, fx_used, book);
    let cost_basis = lot.cost_basis;
    position.lots.push(lot);
    sort_lots(position);
    recalculate_aggregates(position, allows_negative);
    Ok(cost_basis)
}

/// Legacy `add_transferred_lots` (no FX re-rating: same asset, same currency).
fn add_transferred_lots(
    position: &mut Position,
    prefix: &str,
    lots: &[Lot],
    allows_negative: bool,
) -> Decimal {
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
    recalculate_aggregates(position, allows_negative);
    total
}

/// Splits single-signed lots into (cover, residual) by effective units.
fn split_lots_by_cover(lots: &[Lot], cover_abs: Decimal) -> (Vec<Lot>, Vec<Lot>) {
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
            remaining / lot.split_ratio
        };
        let consumed_signed = if lot.quantity.is_sign_negative() {
            -consumed_acquired
        } else {
            consumed_acquired
        };
        let fraction = consumed_signed / lot.quantity;
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
    (cover, residual)
}

/// FIFO relief of long lots in effective units (legacy `reduce_lots_fifo`).
fn reduce_positive_lots_fifo(
    position: &mut Position,
    requested: Decimal,
) -> Result<Reduction, String> {
    reduce_fifo(position, requested, false)
}

fn reduce_negative_lots_fifo(
    position: &mut Position,
    requested: Decimal,
) -> Result<Reduction, String> {
    reduce_fifo(position, requested, true)
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
            consume / ratio
        };
        let share = acquired_abs / lot.quantity.abs();
        let basis_removed = lot.cost_basis * share;
        let fees_removed = lot.fees * share;
        let taxes_removed = lot.taxes * share;
        let removed_signed = if negative {
            -acquired_abs
        } else {
            acquired_abs
        };
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
    recalculate_aggregates(position, allows_negative);
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
/// The activity an event derives from (`None` for an unknown event id).
pub fn source_activity(ledger: &CompiledLedger, event: &EventId) -> Option<ActivityId> {
    ledger
        .events
        .iter()
        .find(|e| &e.id == event)
        .map(|e| e.source.clone())
}

pub fn lot_records(
    bundle: &ProjectionBundle,
    facts: &CanonicalFacts,
    fx: &FxResolver<'_>,
) -> Vec<LotRecord> {
    let base = facts.policy.base_currency.as_str();
    // Legacy parity: lots opened by composite legs (`{activity}:buy`) carry
    // no open activity; `source_activity` maps such ids for stores that need
    // a real activity id.
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
                let original_cost_basis = lot.acquisition_price * original_quantity + fees + taxes;
                let rate = lot
                    .stored_fx_rate_to(base)
                    .or_else(|| fx.rate(position.currency.as_str(), base, lot.acquisition_date))
                    .unwrap_or(Decimal::ZERO);
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
                        original_cost_basis_base: original_cost_basis * rate,
                        remaining_cost_basis_base: lot.cost_basis * rate,
                        fee_allocated: fees,
                        fee_allocated_base: fees * rate,
                        tax_allocated: taxes,
                        tax_allocated_base: taxes * rate,
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
