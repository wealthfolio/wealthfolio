//! Stage 4b: price the projected (or observed) states day by day and
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

use crate::compile::CompiledLedger;
use crate::diagnostics::{Diagnostic, DiagnosticCode};
use crate::model::*;
use crate::resolve::{FxResolver, ResolvedSurfaces};

/// Decimal places legacy storage keeps; flow fallbacks diff at this scale.
/// A quote carried at least this many days is reported once per asset.
const CARRIED_QUOTE_INFO_DAYS: i64 = 7;

const STORAGE_PRECISION: u32 = 8;

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
    lots: Vec<Lot>,
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
    let resolved = &inputs.resolved;
    let mut series = BTreeMap::new();
    for (account_id, account) in &resolved.facts.accounts {
        if account.archived {
            continue;
        }
        let keyframes = keyframes_for(account_id, account, inputs);
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
        let mut days = Vec::new();
        let mut active = 0usize;
        for day in first.iter_days().take_while(|day| *day <= end) {
            while active + 1 < keyframes.len() && keyframes[active + 1].date <= day {
                active += 1;
            }
            days.push(valuer.value_day(&keyframes[active], day, None));
        }
        valuer.report_carried_quotes();

        // Flows: activity map for this account's scope, then fallbacks, then
        // holdings-transition inference (authoritative on observed rows).
        let flows = valuer.activity_flows(std::slice::from_ref(account_id), Window::default());
        stamp_flows(&mut days, &flows, false);
        valuer.infer_holdings_flows(&mut days, &keyframes);

        series.insert(
            account_id.clone(),
            ValuationSeries {
                account: account_id.clone(),
                currency: account.currency.clone(),
                days,
                diagnostics: valuer.diagnostics,
            },
        );
    }
    series
}

/// The scoped read performance consumes (legacy
/// `get_historical_valuations_for_accounts`): per-day sums in base currency,
/// scope-aware activity flows, then internal-transfer netting for pairs whose
/// accounts are both in scope.
pub fn aggregate_scope(
    resolved: &Resolved<'_>,
    disposals: &[LotDisposal],
    series: &BTreeMap<AccountId, ValuationSeries>,
    scope: &[AccountId],
    window: Window,
) -> Result<ValuationSeries, String> {
    let base = resolved.facts.policy.base_currency.clone();
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

    let mut by_date: BTreeMap<NaiveDate, DailyValuation> = BTreeMap::new();
    for history in &histories {
        for day in &history.days {
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
            entry.flow.inflow_base += day.flow.inflow_base;
            entry.flow.outflow_base += day.flow.outflow_base;
            entry.flow.source = entry.flow.source.combine(day.flow.source);
            entry.performance_eligible_value_base += day.performance_eligible_value_base;
            entry.value_status = entry.value_status.combine(day.value_status);
            entry.basis_status = entry.basis_status.combine(day.basis_status);
        }
    }
    let mut days: Vec<DailyValuation> = by_date.into_values().collect();

    let mut valuer = Valuer::new(resolved, disposals, &AccountId::new("scope"), &base);
    let flows = valuer.activity_flows(scope, window);
    let authoritative: BTreeSet<NaiveDate> = flows.keys().copied().collect();
    stamp_flows(&mut days, &flows, true);
    let adjustments = valuer.internal_adjustments(scope, window);
    for day in &mut days {
        if authoritative.contains(&day.date) {
            continue;
        }
        let Some((inflow, outflow)) = adjustments.get(&day.date) else {
            continue;
        };
        day.flow.inflow_base = (day.flow.inflow_base - inflow).max(Decimal::ZERO);
        day.flow.outflow_base = (day.flow.outflow_base - outflow).max(Decimal::ZERO);
        day.flow.source = day.flow.source.combine(FlowSource::CashAmount);
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
        diagnostics: valuer.diagnostics,
    })
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

/// Base-currency value of one event's external flow (scope boundary
/// External), as the transfer-pair FX attribution prices legs.
pub(crate) fn external_flow_base(
    resolved: &Resolved<'_>,
    disposals: &[LotDisposal],
    event: &EconomicEvent,
) -> Decimal {
    let base = resolved.facts.policy.base_currency.clone();
    let mut valuer = Valuer::new(resolved, disposals, &event.account, &base);
    valuer.price_flow(event, ScopeBoundary::External).0
}

/// Legacy `validate_scoped_history_completeness`.
fn validate_completeness(scope: &[AccountId], histories: &[ValuationSeries]) -> Result<(), String> {
    if histories.len() != scope.len() {
        return Err(format!(
            "scoped valuation history count mismatch: expected {} histories, got {}",
            scope.len(),
            histories.len()
        ));
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
            return Err(format!(
                "incomplete scoped valuation history for account '{}': missing {missing}",
                history.account
            ));
        }
        if let Some(scope_last) = scope_last {
            if last < scope_last
                && history
                    .days
                    .last()
                    .is_some_and(|d| !d.total_value_base.is_zero())
            {
                return Err(format!(
                    "incomplete scoped valuation history for account '{}': latest valuation is {last}, scope continues through {scope_last}",
                    history.account
                ));
            }
        }
    }
    Ok(())
}

fn keyframes_for(
    account_id: &AccountId,
    account: &AccountFacts,
    inputs: &ValueInputs<'_>,
) -> Vec<ValuationKeyframe> {
    let resolved = &inputs.resolved;
    let mut by_date: BTreeMap<NaiveDate, ValuationKeyframe> = BTreeMap::new();
    if account.tracking == TrackingMode::Holdings {
        for observed in resolved
            .facts
            .observed_snapshots
            .iter()
            .filter(|s| s.account == *account_id && s.date <= resolved.range.end)
        {
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
                            lots: Vec::new(),
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
        // An account with no events has no keyframes: present its (empty)
        // final state on the range end, as one row.
        let synthetic;
        let frames: &[Keyframe] = match inputs.bundle.keyframes.get(account_id) {
            Some(frames) if !frames.is_empty() => frames,
            _ => match inputs.bundle.final_state.accounts.get(account_id) {
                Some(state) => {
                    synthetic = [Keyframe {
                        date: resolved.range.end,
                        state: state.clone(),
                    }];
                    &synthetic
                }
                None => &[],
            },
        };
        for frame in frames.iter().filter(|f| f.date <= resolved.range.end) {
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
                            lots: position.lots.clone(),
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
        }
    }

    fn base(&self) -> &str {
        self.resolved
            .facts
            .policy
            .major_currency(self.resolved.facts.policy.base_currency.as_str())
    }

    /// One informational diagnostic per asset whose quote was carried for
    /// more than a week somewhere in the range: weekends and holidays stay
    /// silent, a stale series is visible (I10) without a row per day.
    fn report_carried_quotes(&mut self) {
        let carried = std::mem::take(&mut self.carried);
        for (asset, (age, observed, valued)) in carried {
            if age < CARRIED_QUOTE_INFO_DAYS {
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

    /// Legacy `calculate_valuation_with_price_factors`. `factor_date`
    /// overrides the split-factor anchor (holdings-transition inference).
    fn value_day(
        &mut self,
        keyframe: &ValuationKeyframe,
        day: NaiveDate,
        factor_date: Option<NaiveDate>,
    ) -> DailyValuation {
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
            let price = quote.close * factor;
            let rate = if quote_major == account_currency {
                Some(Decimal::ONE)
            } else {
                self.fx.rate(quote_major, &account_currency, day)
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
            let split_factor = surfaces.split_price_factor(asset, factor_date.unwrap_or(day));
            let market_value =
                position.quantity * price * split_factor * position.contract_multiplier * rate;
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
            let normalized = *amount * factor;
            let rate = if major == account_currency {
                Some(Decimal::ONE)
            } else {
                self.fx.rate(major, &account_currency, day)
            };
            match rate {
                Some(rate) => cash += normalized * rate,
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

        let cost_basis =
            self.cost_basis_in(keyframe, day, &account_currency, |p| p.cost_basis_account);
        let fx_rate_to_base = if account_currency == base {
            Some(Decimal::ONE)
        } else {
            self.fx.rate(&account_currency, &base, day)
        };
        let Some(fx_rate_to_base) = fx_rate_to_base else {
            self.report(
                DiagnosticCode::FxUnavailable,
                format!("{}:{account_currency}->{base}", self.account),
                format!("no {account_currency}->{base} rate on {day}; base values unavailable"),
            );
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
        let cost_basis_base = self.cost_basis_in(keyframe, day, &base, |p| p.cost_basis_base);
        let cash_base = cash * fx_rate_to_base;
        let investment_base = investment * fx_rate_to_base;
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
            performance_eligible_value_base: (eligible + cash) * fx_rate_to_base,
            value_status,
            basis_status,
            flow: DailyFlow::default(),
        }
    }

    /// Legacy `calculate_cost_basis_in_currency`: precomputed acquisition-FX
    /// scalar first, else lot walk at acquisition-date FX, else today's FX.
    fn cost_basis_in(
        &mut self,
        keyframe: &ValuationKeyframe,
        day: NaiveDate,
        target: &str,
        precomputed: impl Fn(&PricedPosition) -> Option<Decimal>,
    ) -> Decimal {
        let policy = &self.resolved.facts.policy;
        let mut total = Decimal::ZERO;
        for (asset, position) in &keyframe.positions {
            if position.alternative || position.total_cost_basis.is_zero() {
                continue;
            }
            if let Some(scalar) = precomputed(position) {
                total += scalar;
                continue;
            }
            let position_currency = policy
                .major_currency(position.currency.as_str())
                .to_string();
            if position.lots.is_empty() {
                match self.fx.rate(&position_currency, target, day) {
                    Some(rate) => total += position.total_cost_basis * rate,
                    None => self.report(
                        DiagnosticCode::FxUnavailable,
                        format!("{}:basis:{asset}", self.account),
                        format!("no {position_currency}->{target} rate on {day}; book cost of {asset} omitted from the converted basis"),
                    ),
                }
                continue;
            }
            for lot in &position.lots {
                if lot.cost_basis.is_zero() {
                    continue;
                }
                if let Some(rate) = lot.stored_fx_rate_to(target) {
                    total += lot.cost_basis * rate;
                    continue;
                }
                match self.fx.rate(&position_currency, target, lot.acquisition_date) {
                    Some(rate) => total += lot.cost_basis * rate,
                    None => self.report(
                        DiagnosticCode::FxUnavailable,
                        format!("{}:basis:{asset}:{}", self.account, lot.id),
                        format!("no {position_currency}->{target} rate on {}; lot basis omitted from the converted basis", lot.acquisition_date),
                    ),
                }
            }
        }
        total
    }

    /// Legacy `external_flows_from_scoped_inputs` for `scope`.
    fn activity_flows(
        &mut self,
        scope: &[AccountId],
        window: Window,
    ) -> BTreeMap<NaiveDate, DailyFlow> {
        let mut flows: BTreeMap<NaiveDate, DailyFlow> = BTreeMap::new();
        let range = self.resolved.range;
        let events: Vec<&EconomicEvent> = self
            .resolved
            .ledger
            .events
            .iter()
            .filter(|event| scope.contains(&event.account))
            .filter(|event| event.date >= range.start && event.date <= range.end)
            .filter(|event| window.contains(event.date))
            .collect();
        for event in events {
            let boundary = match &event.flow.boundary {
                Boundary::None => continue,
                Boundary::External => ScopeBoundary::External,
                Boundary::Unknown => ScopeBoundary::Unknown,
                Boundary::Internal { counterparty } => {
                    let inside = scope.contains(&event.account);
                    let pair_inside = scope.contains(counterparty);
                    if inside == pair_inside {
                        continue;
                    }
                    ScopeBoundary::External
                }
            };
            let is_outflow = match &event.action {
                Action::SecurityTransfer {
                    direction: Direction::Out,
                    ..
                } => true,
                _ => {
                    event
                        .cash
                        .as_ref()
                        .is_some_and(|c| c.amount < Decimal::ZERO)
                        && matches!(event.flow.value, FlowValue::Cash(_))
                        && event.contribution == Contribution::CashGross
                        && !matches!(event.action, Action::Trade { .. })
                }
            };
            let (amount, source) = self.price_flow(event, boundary);
            add_flow(&mut flows, event.date, amount, is_outflow, source);
        }
        flows
    }

    /// Legacy transfer-flow ladder + removed-lot-basis substitution.
    fn price_flow(
        &mut self,
        event: &EconomicEvent,
        boundary: ScopeBoundary,
    ) -> (Decimal, FlowSource) {
        let policy = &self.resolved.facts.policy;
        let base = self.base().to_string();
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
                (
                    self.flow_to_base(*gross, event.currency.as_str(), event),
                    source,
                )
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
                if let Some(quote) = self
                    .resolved
                    .surfaces
                    .quotes
                    .latest_on_or_before(asset, event.date)
                {
                    let (quote_major, factor) = policy.normalize_currency(quote.currency.as_str());
                    let market_value = *quantity * quote.close * factor * multiplier;
                    if !market_value.is_zero() {
                        let source = if unknown {
                            FlowSource::UnknownBoundaryTransfer
                        } else {
                            FlowSource::QuoteDerivedMarketValue
                        };
                        return (
                            self.flow_to_base(market_value.abs(), quote_major, event),
                            source,
                        );
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
                if let Some(basis) = book_basis {
                    let uses_legacy_amount = unit_price.is_zero() && legacy_amount.is_some();
                    let source = if unknown {
                        FlowSource::UnknownBoundaryTransfer
                    } else if uses_legacy_amount {
                        FlowSource::LegacyActivityAmountFallback
                    } else {
                        FlowSource::CostBasisFallback
                    };
                    return (
                        self.flow_to_base(basis.abs(), event.currency.as_str(), event),
                        source,
                    );
                }
                if let Some(amount) = legacy_amount {
                    let source = if unknown {
                        FlowSource::UnknownBoundaryTransfer
                    } else {
                        FlowSource::LegacyActivityAmountFallback
                    };
                    return (
                        self.flow_to_base(amount.abs(), event.currency.as_str(), event),
                        source,
                    );
                }
                let _ = base;
                (Decimal::ZERO, FlowSource::UnknownBoundaryTransfer)
            }
        }
    }

    fn flow_to_base(&mut self, amount: Decimal, currency: &str, event: &EconomicEvent) -> Decimal {
        if amount.is_zero() {
            return Decimal::ZERO;
        }
        let policy = &self.resolved.facts.policy;
        let from = policy.major_currency(currency).to_string();
        let base = self.base().to_string();
        if from == base {
            return amount;
        }
        match self.fx.convert(amount, &from, &base, event.date) {
            Some(converted) => converted,
            None => {
                self.report(
                    DiagnosticCode::FxUnavailable,
                    format!("flow:{}", event.source),
                    format!(
                        "no {from}->{base} rate on {} for the external flow of {}; flow unpriced",
                        event.date, event.source
                    ),
                );
                Decimal::ZERO
            }
        }
    }

    /// Legacy `internal_transfer_adjustments_from_scoped_inputs`: both legs of
    /// pairs fully inside the scope, priced as external flows.
    fn internal_adjustments(
        &mut self,
        scope: &[AccountId],
        window: Window,
    ) -> BTreeMap<NaiveDate, (Decimal, Decimal)> {
        let mut adjustments: BTreeMap<NaiveDate, (Decimal, Decimal)> = BTreeMap::new();
        let pairs: Vec<&TransferPair> = self
            .resolved
            .facts
            .transfer_pairs
            .by_group
            .values()
            .filter(|pair| scope.contains(&pair.in_account) && scope.contains(&pair.out_account))
            .collect();
        for pair in pairs {
            for leg in [&pair.transfer_in, &pair.transfer_out] {
                let Some(event) = self
                    .resolved
                    .ledger
                    .events
                    .iter()
                    .find(|e| e.id.as_str() == leg.as_str())
                else {
                    continue;
                };
                if event.date < self.resolved.range.start
                    || event.date > self.resolved.range.end
                    || !window.contains(event.date)
                {
                    continue;
                }
                let (amount, _) = self.price_flow(event, ScopeBoundary::External);
                if amount.is_zero() {
                    continue;
                }
                let entry = adjustments
                    .entry(event.date)
                    .or_insert((Decimal::ZERO, Decimal::ZERO));
                // A security transfer's direction decides the leg; its cash
                // leg is only the fee, so the cash sign must not classify it.
                let outflow = match &event.action {
                    Action::SecurityTransfer { direction, .. } => *direction == Direction::Out,
                    _ => event
                        .cash
                        .as_ref()
                        .is_some_and(|c| c.amount < Decimal::ZERO),
                };
                if outflow {
                    entry.1 += amount;
                } else {
                    entry.0 += amount;
                }
            }
        }
        adjustments
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
            let prev_at_curr = self.value_day(prev, curr_date, Some(prev.date));
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
fn stamp_flows(
    days: &mut [DailyValuation],
    flows: &BTreeMap<NaiveDate, DailyFlow>,
    preserve_unavailable: bool,
) {
    let Some(first) = days.first_mut() else {
        return;
    };
    first.flow = DailyFlow::default();
    for index in 1..days.len() {
        // Legacy diffs persisted (8dp) values; dust below storage precision is
        // not a flow.
        let delta = (days[index].net_contribution_base - days[index - 1].net_contribution_base)
            .round_dp(STORAGE_PRECISION);
        if let Some(flow) = flows.get(&days[index].date) {
            days[index].flow = *flow;
            continue;
        }
        let current = days[index].flow;
        if preserve_unavailable && current.source == FlowSource::UnpricedHoldingsTransition {
            continue;
        }
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
