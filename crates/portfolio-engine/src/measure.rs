//! Stage 6: performance over stored valuation rows — a port of the legacy
//! performance service (time-weighted and money-weighted returns, value
//! return, attribution, risk, holdings-mode and mixed-scope handling).
//!
//! Rows are read as storage keeps them (8 decimal places); windows select
//! rows by date, and dated attribution counts events strictly after the
//! window start.

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::NaiveDate;
use rust_decimal::prelude::{FromPrimitive, ToPrimitive};
use rust_decimal::{Decimal, MathematicalOps};
use rust_decimal_macros::dec;

use crate::arith;
use crate::error::EngineError;
use crate::model::*;
use crate::value::{aggregate_scope, Window};

const DAYS_PER_YEAR: Decimal = dec!(365.25);
const MIN_ANNUALIZATION_DAYS: i64 = 30;
const MIN_RETURN_BASE: Decimal = Decimal::ONE;
const RESIDUAL_TOLERANCE_RATE: Decimal = dec!(0.002);

/// Inputs of the read path, all plain data: the priced events
/// (`value::effects`) plus valuation series, lots and disposals, computed or
/// stored. Measuring reads no raw facts and resolves no rates.
pub struct MeasureInputs<'a> {
    pub effects: Effects,
    pub series: &'a BTreeMap<AccountId, ValuationSeries>,
    pub lots: &'a [LotRecord],
    pub disposals: &'a [LotDisposal],
}

impl MeasureInputs<'_> {
    fn base(&self) -> &Currency {
        &self.effects.base_currency
    }

    /// Stored rows of one account inside `window`.
    fn history(&self, account: &AccountId, window: Window) -> Vec<DailyValuation> {
        self.series
            .get(account)
            .map(|series| {
                series
                    .days
                    .iter()
                    .filter(|day| window.contains(day.date))
                    .map(DailyValuation::stored)
                    .collect()
            })
            .unwrap_or_default()
    }

    fn account_is_base(&self, account: &AccountId) -> bool {
        self.series.get(account).is_some_and(|s| {
            s.currency
                .as_str()
                .eq_ignore_ascii_case(self.base().as_str())
        })
    }

    fn tracking(&self, account: &AccountId) -> TrackingMode {
        self.effects
            .account(account)
            .map(|a| a.tracking)
            .unwrap_or(TrackingMode::Transactions)
    }

    fn is_cash_account(&self, account: &AccountId) -> bool {
        self.effects
            .account(account)
            .is_some_and(|a| a.kind == AccountKind::Cash)
    }
}

/// What the caller will render (architecture §4.3).
/// `Summary` skips IRR, annualisation and risk; `Dashboard`
/// additionally reports the exact value change net of flows as the headline
/// amount and skips attribution, as the legacy dashboard cards did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MeasureProfile {
    #[default]
    Full,
    Summary,
    Dashboard,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Baseline {
    PeriodStart,
    Inception,
}

#[derive(Debug, Clone, Copy)]
struct PeriodFlow {
    date: NaiveDate,
    inflow: Decimal,
    outflow: Decimal,
    source: FlowSource,
}

impl PeriodFlow {
    fn net(self) -> Decimal {
        self.inflow - self.outflow
    }
}

#[derive(Debug, Clone, Copy)]
struct ReturnSample {
    twr: Decimal,
    cumulative: Decimal,
    excluded: bool,
}

#[derive(Debug, Clone, Copy)]
struct RiskSample {
    date: NaiveDate,
    simple_return: Decimal,
    /// Calendar days this return covers, from the observation before it.
    /// Carried per sample because the series is not evenly spaced: an
    /// excluded day leaves a gap without lengthening the next return, and a
    /// quote series only has trading days.
    period_days: i64,
}

struct TwrComputation {
    cumulative: Option<Decimal>,
    samples: Vec<(NaiveDate, ReturnSample)>,
    warnings: Vec<QualityNote>,
    reasons: Vec<QualityNote>,
}

struct IrrComputation {
    annualized: Option<Decimal>,
    warnings: Vec<QualityNote>,
    reasons: Vec<QualityNote>,
}

#[derive(Debug, Clone, Default)]
struct Effect {
    external_flow: Decimal,
    realized_pnl: Decimal,
    unrealized: Decimal,
    income: Decimal,
    fee: Decimal,
    tax: Decimal,
    fx_effect: Decimal,
}

struct EffectSet {
    effects: Vec<Effect>,
    warnings: Vec<QualityNote>,
    complete: bool,
}

impl Default for EffectSet {
    fn default() -> Self {
        Self {
            effects: Vec::new(),
            warnings: Vec::new(),
            complete: true,
        }
    }
}

struct Seed {
    include_base_market_movement: bool,
    effects: Vec<Effect>,
    warnings: Vec<QualityNote>,
}

impl Default for Seed {
    fn default() -> Self {
        Self {
            include_base_market_movement: true,
            effects: Vec::new(),
            warnings: Vec::new(),
        }
    }
}

fn check_window(window: Window) -> Result<(), EngineError> {
    match (window.start, window.end) {
        (Some(start), Some(end)) if start > end => Err(EngineError::InvertedRange { start, end }),
        _ => Ok(()),
    }
}

/// Archived accounts are neither projected nor valued (architecture §4.5),
/// so a scope naming one has no complete answer: refused, not guessed.
fn check_not_archived(inputs: &MeasureInputs<'_>, scope: &[AccountId]) -> Result<(), EngineError> {
    match scope.iter().find(|id| {
        inputs
            .effects
            .account(id)
            .is_some_and(|account| account.archived)
    }) {
        Some(archived) => Err(EngineError::ArchivedAccountInScope(
            archived.as_str().to_string(),
        )),
        None => Ok(()),
    }
}

/// Performance of one account (legacy `calculate_account_performance`).
/// `include_series` adds the daily return series (history responses only).
pub fn measure_account(
    inputs: &MeasureInputs<'_>,
    account: &AccountId,
    window: Window,
    profile: MeasureProfile,
    include_series: bool,
) -> Result<PerformanceResult, EngineError> {
    check_window(window)?;
    check_not_archived(inputs, std::slice::from_ref(account))?;
    let history = inputs.history(account, window);
    if history.len() < 2 {
        return Ok(empty_response(
            account.as_str(),
            inputs.base(),
            history.first().map(|d| d.date).or(window.start),
            history.last().map(|d| d.date).or(window.end),
            QualityNote::TwoValuationPointsRequired,
        ));
    }
    let holdings = inputs.tracking(account) == TrackingMode::Holdings;
    let mut result = performance_core(
        &history,
        holdings,
        window.start,
        include_series,
        profile,
        inputs.is_cash_account(account),
        inputs.account_is_base(account),
        inputs.base(),
    );
    result.scope = account.as_str().to_string();
    if profile == MeasureProfile::Dashboard {
        apply_dashboard_amount(&mut result, &history, holdings);
        return Ok(result);
    }
    let baseline = attribution_baseline(holdings, window.start);
    finalize_attribution(
        inputs,
        &mut result,
        std::slice::from_ref(account),
        &history,
        baseline,
        Seed::default(),
    );
    Ok(result)
}

/// Performance of an account scope (legacy `calculate_scoped_performance`);
/// `include_series` as in [`measure_account`].
pub fn measure_scope(
    inputs: &MeasureInputs<'_>,
    scope_id: &str,
    scope: &[AccountId],
    window: Window,
    profile: MeasureProfile,
    include_series: bool,
) -> Result<PerformanceResult, EngineError> {
    check_window(window)?;
    check_not_archived(inputs, scope)?;
    let base = inputs.base();
    if scope.is_empty() {
        return Ok(empty_response(
            scope_id,
            base,
            window.start,
            window.end,
            QualityNote::NoAccountsSelected,
        ));
    }
    let has_holdings = scope
        .iter()
        .any(|a| inputs.tracking(a) == TrackingMode::Holdings);
    let has_transactions = scope
        .iter()
        .any(|a| inputs.tracking(a) != TrackingMode::Holdings);

    if has_holdings && has_transactions {
        let mut result = mixed_scope_performance(inputs, scope, window, profile, include_series);
        result.scope = scope_id.to_string();
        return Ok(result);
    }

    let history = match aggregate_scope(&inputs.effects, inputs.series, scope, window) {
        Ok(scoped) => scoped
            .days
            .iter()
            .map(DailyValuation::stored)
            .collect::<Vec<_>>(),
        Err(error) => {
            return Ok(partial_response(
                scope_id,
                base,
                window.start,
                window.end,
                QualityNote::ScopeHistoryIncomplete {
                    detail: error.to_string(),
                },
            ));
        }
    };
    if history.len() < 2 {
        return Ok(empty_response(
            scope_id,
            base,
            history.first().map(|d| d.date).or(window.start),
            history.last().map(|d| d.date).or(window.end),
            QualityNote::TwoValuationPointsRequired,
        ));
    }

    let all_cash = scope.iter().all(|a| inputs.is_cash_account(a));
    let mut result = performance_core(
        &history,
        has_holdings,
        window.start,
        include_series,
        profile,
        all_cash,
        true,
        base,
    );
    result.scope = scope_id.to_string();
    if profile == MeasureProfile::Dashboard {
        apply_dashboard_amount(&mut result, &history, has_holdings);
        return Ok(result);
    }

    // Transaction-only all-time scopes use inception attribution; holdings
    // scopes stay period-based (snapshots carry no cash-flow history).
    let baseline = if has_transactions && window.start.is_none() {
        Baseline::Inception
    } else {
        Baseline::PeriodStart
    };
    let unrealized = scoped_unrealized_effects(inputs, &result, scope, baseline);
    let transfers = transfer_pair_effects(inputs, &result, scope, baseline);
    let mut seed = Seed::default();
    if unrealized.complete {
        seed.include_base_market_movement = false;
        seed.effects.extend(unrealized.effects);
    }
    seed.warnings.extend(unrealized.warnings);
    if transfers.complete {
        seed.effects.extend(transfers.effects);
    }
    seed.warnings.extend(transfers.warnings);
    finalize_attribution(inputs, &mut result, scope, &history, baseline, seed);
    Ok(result)
}

// ------------------------------------------------------------ core math

/// Legacy `compute_account_performance_with_flow_basis` (base currency).
#[allow(clippy::too_many_arguments)]
fn performance_core(
    history: &[DailyValuation],
    holdings: bool,
    start_opt: Option<NaiveDate>,
    include_series: bool,
    profile: MeasureProfile,
    cash_fx_attribution: bool,
    account_is_base: bool,
    currency: &Currency,
) -> PerformanceResult {
    debug_assert!(history.len() >= 2);
    let start_point = &history[0];
    let end_point = &history[history.len() - 1];
    let actual_start = start_point.date;
    let actual_end = end_point.date;
    let baseline = attribution_baseline(holdings, start_opt);
    let full = profile == MeasureProfile::Full;

    let end_value = end_point.total_value_base;
    let flows = period_flows(history);
    // A gain needs both endpoints valued: an UNAVAILABLE endpoint carries a
    // partial (or zero) base value, so IRR, value return and the headline
    // amount are unavailable rather than silently zero (legacy had no row).
    let coverage_unavailable = start_point.value_status.is_unavailable_for_returns()
        || end_point.value_status.is_unavailable_for_returns();
    let holdings_flows_unavailable = holdings
        && start_opt.is_some()
        && flows.iter().any(|f| f.source.is_unavailable_for_returns());

    let twr = if holdings {
        TwrComputation {
            cumulative: None,
            samples: Vec::new(),
            warnings: Vec::new(),
            reasons: vec![QualityNote::HoldingsTwrNotApplicable],
        }
    } else {
        time_weighted_returns(history, &flows)
    };
    let irr = if holdings && full {
        IrrComputation {
            annualized: None,
            warnings: Vec::new(),
            reasons: vec![QualityNote::HoldingsIrrNotApplicable],
        }
    } else if coverage_unavailable {
        IrrComputation {
            annualized: None,
            warnings: Vec::new(),
            reasons: vec![QualityNote::CoverageUnavailable {
                metric: Metric::Irr,
            }],
        }
    } else if full {
        xirr(history, &flows)
    } else {
        IrrComputation {
            annualized: None,
            warnings: Vec::new(),
            reasons: Vec::new(),
        }
    };

    let mut risk_samples = Vec::new();
    let mut series = Vec::new();
    if include_series {
        series.push(SeriesPoint {
            date: actual_start,
            value: Decimal::ZERO,
        });
    }

    let mut holdings_chained: Option<Decimal> = None;
    let mut holdings_out_of_range = false;
    if holdings && !holdings_flows_unavailable {
        let mut factor = Decimal::ONE;
        let mut has_base = false;
        for (index, pair) in history.windows(2).enumerate() {
            let prev_value = pair[0].total_value_base;
            let curr_value = pair[1].total_value_base;
            let flow = flows[index];
            let (inflow, outflow) = if flow.source.has_known_amount() {
                (flow.inflow, flow.outflow)
            } else {
                (Decimal::ZERO, Decimal::ZERO)
            };
            let day_gain = curr_value + outflow - prev_value - inflow;
            if prev_value > Decimal::ZERO {
                has_base = true;
                let step = arith::div(day_gain, prev_value).and_then(|daily_return| {
                    arith::mul(factor, Decimal::ONE + daily_return).map(|next| (daily_return, next))
                });
                let Some((daily_return, next)) = step else {
                    holdings_out_of_range = true;
                    break;
                };
                factor = next;
                if full {
                    risk_samples.push(RiskSample {
                        date: pair[1].date,
                        simple_return: daily_return,
                        period_days: (pair[1].date - pair[0].date).num_days(),
                    });
                }
                if include_series {
                    series.push(SeriesPoint {
                        date: pair[1].date,
                        value: (factor - Decimal::ONE).round_dp(STORED_PRECISION),
                    });
                }
            } else if include_series {
                series.push(SeriesPoint {
                    date: pair[1].date,
                    value: (factor - Decimal::ONE).round_dp(STORED_PRECISION),
                });
            }
        }
        if has_base && !holdings_out_of_range {
            holdings_chained = Some(factor - Decimal::ONE);
        }
    } else if !holdings {
        // Each sample covers one window step: the previous sample's date (or
        // the first row's) opens its period.
        let mut period_start = actual_start;
        for (date, sample) in &twr.samples {
            if full && !sample.excluded {
                risk_samples.push(RiskSample {
                    date: *date,
                    simple_return: sample.twr,
                    period_days: (*date - period_start).num_days(),
                });
            }
            period_start = *date;
            if include_series {
                series.push(SeriesPoint {
                    date: *date,
                    value: sample.cumulative.round_dp(STORED_PRECISION),
                });
            }
        }
    }

    let risk = if full {
        risk_from_samples(&risk_samples, Some(actual_start))
    } else {
        Risk::default()
    };

    let holdings_value_return = if holdings {
        Some(if holdings_flows_unavailable {
            (None, None)
        } else {
            holdings_return(start_point, end_point, &flows, start_opt.is_none())
        })
    } else {
        None
    };

    let (method, value_return, value_return_reason) = if holdings {
        let (_, all_time_return) = holdings_value_return.unwrap();
        let ret = if start_opt.is_none() {
            all_time_return
        } else {
            holdings_chained
        };
        let reason = ret.is_none().then(|| {
            if holdings_out_of_range && start_opt.is_some() {
                QualityNote::HoldingsReturnOutOfRange
            } else if holdings_flows_unavailable {
                QualityNote::FlowsNotInferred {
                    metric: Metric::ValueReturn,
                    subject: Subject::HoldingsScope,
                }
            } else if start_opt.is_none() {
                holdings_all_time_unavailable_reason(
                    end_point,
                    Metric::ValueReturn,
                    Subject::HoldingsScope,
                )
                .unwrap_or(QualityNote::HoldingsValueReturnUnavailable)
            } else {
                QualityNote::HoldingsNonPositiveStart
            }
        });
        (ReturnMethod::ValueReturn, ret, reason)
    } else if coverage_unavailable {
        (
            ReturnMethod::TimeWeighted,
            None,
            Some(QualityNote::CoverageUnavailable {
                metric: Metric::ValueReturn,
            }),
        )
    } else {
        let value_return = simple_value_return(history, &flows);
        let reason = value_return
            .is_none()
            .then_some(QualityNote::TransactionNonPositiveStart);
        (ReturnMethod::TimeWeighted, value_return, reason)
    };
    let holdings_pnl_reason = holdings_value_return.and_then(|(amount, _)| {
        if amount.is_none() && start_opt.is_none() {
            holdings_all_time_unavailable_reason(end_point, Metric::Pnl, Subject::HoldingsScope)
        } else if amount.is_none() && holdings_flows_unavailable {
            Some(QualityNote::FlowsNotInferred {
                metric: Metric::Pnl,
                subject: Subject::HoldingsScope,
            })
        } else {
            None
        }
    });

    let (contributions, distributions, unrealized_change, fx_effect) =
        if let Some((holdings_amount, _)) = holdings_value_return {
            (
                Decimal::ZERO,
                Decimal::ZERO,
                holdings_amount
                    .unwrap_or(Decimal::ZERO)
                    .round_dp(STORED_PRECISION),
                Decimal::ZERO,
            )
        } else {
            let (contributions, distributions) =
                flows_for_attribution(&flows, start_point, baseline);
            let (unrealized_change, investment_fx) =
                unrealized_components(start_point, end_point, baseline, account_is_base);
            let fx_effect = (investment_fx + cash_only_fx_effect(history, cash_fx_attribution))
                .round_dp(STORED_PRECISION);
            (contributions, distributions, unrealized_change, fx_effect)
        };
    let delta_total_value = total_value_delta(start_point, end_point, baseline);
    let attribution = Attribution {
        contributions,
        distributions,
        unrealized_pnl_change: unrealized_change,
        fx_effect,
        ..Attribution::default()
    };

    let mut warnings = flow_quality_warnings(&flows);
    if holdings && start_opt.is_some() && has_estimated_holdings_flows(&flows) {
        warnings.push(QualityNote::HoldingsFlowsEstimated);
    }
    warnings.extend(twr.warnings);
    warnings.extend(irr.warnings);
    let mut reasons = twr.reasons;
    reasons.extend(irr.reasons);
    reasons.extend(value_return_reason);
    reasons.extend(holdings_pnl_reason);
    if coverage_unavailable {
        reasons.push(QualityNote::CoverageUnavailable {
            metric: Metric::Pnl,
        });
    }
    let mut data_quality = data_quality(warnings, reasons, false);
    if !holdings {
        let unreconciled = unreconciled_delta(delta_total_value, &attribution);
        push_residual_diagnostic(
            &mut data_quality,
            unreconciled,
            delta_total_value,
            end_value,
        );
        refresh_quality_status(&mut data_quality);
    }

    let mut result = build_result(
        String::new(),
        currency.clone(),
        Some(actual_start),
        Some(actual_end),
        method,
        Returns {
            twr: twr.cumulative.map(|v| v.round_dp(STORED_PRECISION)),
            annualized_twr: if full {
                annualize(actual_start, actual_end, twr.cumulative)
            } else {
                None
            },
            irr: irr.annualized.and_then(|v| {
                period_return_from_annualized(actual_start, actual_end, v)
                    .map(|r| r.round_dp(STORED_PRECISION))
            }),
            annualized_irr: if full { irr.annualized } else { None },
            value_return: value_return.map(|v| v.round_dp(STORED_PRECISION)),
            annualized_value_return: if full {
                annualize(actual_start, actual_end, value_return)
            } else {
                None
            },
        },
        attribution,
        risk,
        data_quality,
        series,
        holdings,
        false,
    );
    result.coverage_unavailable = coverage_unavailable;
    if holdings {
        result.basis_status = end_point.basis_status;
        result.holdings_flows_unavailable = holdings_flows_unavailable;
        refresh_summary(&mut result);
    }
    result
}

/// Each day's external flow as the value stage stamped it, with its
/// provenance: measure infers nothing from stored rows.
fn period_flows(history: &[DailyValuation]) -> Vec<PeriodFlow> {
    history
        .iter()
        .skip(1)
        .map(|day| PeriodFlow {
            date: day.date,
            inflow: day.flow.inflow_base,
            outflow: day.flow.outflow_base,
            source: day.flow.source,
        })
        .collect()
}

fn flow_quality_warnings(flows: &[PeriodFlow]) -> Vec<QualityNote> {
    let mut warnings = Vec::new();
    if flows
        .iter()
        .any(|f| f.source == FlowSource::NetContributionFallback)
    {
        warnings.push(QualityNote::NetContributionFlows);
    }
    if flows.iter().any(|f| f.source.is_degraded()) {
        warnings.push(QualityNote::DegradedFlowProvenance);
    }
    warnings
}

fn time_weighted_returns(history: &[DailyValuation], flows: &[PeriodFlow]) -> TwrComputation {
    let mut factor = Decimal::ONE;
    let mut samples = Vec::new();
    let mut warnings = Vec::new();
    let mut reasons = Vec::new();
    let mut chain_started = false;
    let mut warned_partial = false;

    let excluded = |factor: Decimal| ReturnSample {
        twr: Decimal::ZERO,
        cumulative: factor - Decimal::ONE,
        excluded: true,
    };

    for (pair, flow) in history.windows(2).zip(flows) {
        let (prev, curr) = (&pair[0], &pair[1]);
        let prev_value = prev.total_value_base;
        let curr_value = curr.total_value_base;

        if flow.source.is_unavailable_for_returns() {
            reasons.push(QualityNote::TwrUnknownFlow { date: curr.date });
            samples.push((curr.date, excluded(factor)));
            continue;
        }
        if prev.value_status.is_unavailable_for_returns()
            || curr.value_status.is_unavailable_for_returns()
        {
            reasons.push(QualityNote::TwrCoverageUnavailable { date: curr.date });
            samples.push((curr.date, excluded(factor)));
            continue;
        }
        if !warned_partial && (prev.value_status.is_degraded() || curr.value_status.is_degraded()) {
            warnings.push(QualityNote::PartialUnpricedRows);
            warned_partial = true;
        }

        // A contiguous negative prefix before the chain starts is skipped;
        // afterwards any negative value is fatal.
        let leading_negative_prefix = !chain_started && prev_value.is_sign_negative();
        if (prev_value.is_sign_negative() || curr_value.is_sign_negative())
            && !leading_negative_prefix
        {
            reasons.push(QualityNote::TwrNegativeValue { date: curr.date });
            samples.push((curr.date, excluded(factor)));
            continue;
        }

        let denominator = prev_value + flow.inflow;
        let benign_low_base = denominator >= Decimal::ZERO && denominator < MIN_RETURN_BASE;
        if denominator < Decimal::ZERO && (chain_started || prev_value > Decimal::ZERO) {
            reasons.push(QualityNote::TwrNegativeDenominator { date: curr.date });
            samples.push((curr.date, excluded(factor)));
            continue;
        }
        if !chain_started && (prev_value <= Decimal::ZERO || benign_low_base) {
            samples.push((
                curr.date,
                ReturnSample {
                    twr: Decimal::ZERO,
                    cumulative: Decimal::ZERO,
                    excluded: true,
                },
            ));
            continue;
        }
        chain_started = true;

        // A near-zero positive denominator is a dormant/dust day: pause
        // compounding without nulling the headline.
        let step = if benign_low_base {
            Some((Decimal::ZERO, factor))
        } else {
            arith::div(
                curr_value + flow.outflow - prev_value - flow.inflow,
                denominator,
            )
            .and_then(|twr| arith::mul(factor, Decimal::ONE + twr).map(|next| (twr, next)))
        };
        let Some((twr, next_factor)) = step else {
            reasons.push(QualityNote::TwrOutOfRange { date: curr.date });
            samples.push((curr.date, excluded(factor)));
            continue;
        };
        factor = next_factor;
        samples.push((
            curr.date,
            ReturnSample {
                twr,
                cumulative: factor - Decimal::ONE,
                excluded: benign_low_base,
            },
        ));
    }

    let cumulative = if !chain_started {
        reasons.push(QualityNote::TwrNoChain);
        None
    } else if !reasons.is_empty() {
        None
    } else {
        Some(factor - Decimal::ONE)
    };
    TwrComputation {
        cumulative,
        samples,
        warnings,
        reasons,
    }
}

fn xirr(history: &[DailyValuation], flows: &[PeriodFlow]) -> IrrComputation {
    let unavailable = |reason: QualityNote| IrrComputation {
        annualized: None,
        warnings: Vec::new(),
        reasons: vec![reason],
    };
    let failed = |warning: QualityNote| IrrComputation {
        annualized: None,
        warnings: vec![warning],
        reasons: Vec::new(),
    };
    if history.len() < 2 {
        return unavailable(QualityNote::IrrTwoPointsRequired);
    }
    if flows.iter().any(|f| f.source.is_unavailable_for_returns()) {
        return unavailable(QualityNote::IrrUnknownFlow);
    }
    let start = &history[0];
    let end = &history[history.len() - 1];
    let mut cash_flows: Vec<(NaiveDate, f64)> = Vec::new();
    if let Some(value) = start.total_value_base.to_f64() {
        if value > 0.0 {
            cash_flows.push((start.date, -value));
        }
    }
    for flow in flows {
        if let Some(inflow) = flow.inflow.to_f64() {
            if inflow > 0.0 {
                cash_flows.push((flow.date, -inflow));
            }
        }
        if let Some(outflow) = flow.outflow.to_f64() {
            if outflow > 0.0 {
                cash_flows.push((flow.date, outflow));
            }
        }
    }
    if let Some(value) = end.total_value_base.to_f64() {
        if value > 0.0 {
            cash_flows.push((end.date, value));
        }
    }
    if cash_flows.len() < 2 {
        return unavailable(QualityNote::IrrInsufficientFlows);
    }
    let has_positive = cash_flows.iter().any(|(_, a)| *a > 0.0);
    let has_negative = cash_flows.iter().any(|(_, a)| *a < 0.0);
    if !has_positive || !has_negative {
        return failed(QualityNote::IrrNoSignChange);
    }

    let origin = cash_flows[0].0;
    let npv = |rate: f64| -> Option<f64> {
        if rate <= -0.999_999_999 {
            return None;
        }
        let base = 1.0 + rate;
        let mut total = 0.0;
        for (date, amount) in &cash_flows {
            let years = (*date - origin).num_days() as f64 / 365.25;
            total += amount / base.powf(years);
        }
        total.is_finite().then_some(total)
    };

    let mut low = -0.999_999;
    let mut high = 10.0;
    let Some(mut npv_low) = npv(low) else {
        return failed(QualityNote::IrrCannotEvaluate);
    };
    let mut npv_high = npv(high).unwrap_or(f64::NAN);
    let mut expanded = 0;
    while npv_low.signum() == npv_high.signum() && expanded < 16 {
        high *= 2.0;
        npv_high = npv(high).unwrap_or(f64::NAN);
        if !npv_high.is_finite() {
            break;
        }
        expanded += 1;
    }
    if !npv_high.is_finite() || npv_low.signum() == npv_high.signum() {
        return failed(QualityNote::IrrNoConvergence);
    }
    for _ in 0..128 {
        let mid = (low + high) / 2.0;
        let Some(npv_mid) = npv(mid) else {
            return failed(QualityNote::IrrNoConvergence);
        };
        if npv_mid.abs() < 1e-7 || (high - low).abs() < 1e-10 {
            return IrrComputation {
                annualized: Decimal::from_f64(mid).map(|v| v.round_dp(STORED_PRECISION)),
                warnings: Vec::new(),
                reasons: Vec::new(),
            };
        }
        if npv_low.signum() == npv_mid.signum() {
            low = mid;
            npv_low = npv_mid;
        } else {
            high = mid;
        }
    }
    failed(QualityNote::IrrNoConvergence)
}

fn annualize(start: NaiveDate, end: NaiveDate, value: Option<Decimal>) -> Option<Decimal> {
    if (end - start).num_days() < MIN_ANNUALIZATION_DAYS {
        return None;
    }
    value.and_then(|v| annualized_return(start, end, v).map(|a| a.round_dp(STORED_PRECISION)))
}

/// `None` when the power overflows `Decimal` (a >100x move inside a short
/// window): the annualised figure is not representable, so it is not
/// applicable rather than a panic.
fn annualized_return(start: NaiveDate, end: NaiveDate, total_return: Decimal) -> Option<Decimal> {
    if start > end {
        return Some(Decimal::ZERO);
    }
    if total_return <= dec!(-1) {
        return Some(dec!(-1));
    }
    let days = (end - start).num_days();
    if days <= 0 {
        return Some(total_return);
    }
    let years = Decimal::from(days) / DAYS_PER_YEAR;
    let base = Decimal::ONE + total_return;
    if base <= Decimal::ZERO {
        return Some(dec!(-1));
    }
    base.checked_powd(Decimal::ONE / years)
        .map(|p| p - Decimal::ONE)
}

fn period_return_from_annualized(
    start: NaiveDate,
    end: NaiveDate,
    annualized: Decimal,
) -> Option<Decimal> {
    if start > end {
        return Some(Decimal::ZERO);
    }
    if annualized <= dec!(-1) {
        return Some(dec!(-1));
    }
    let days = (end - start).num_days();
    if days <= 0 {
        return Some(annualized);
    }
    let years = Decimal::from(days) / DAYS_PER_YEAR;
    let base = Decimal::ONE + annualized;
    if base <= Decimal::ZERO {
        return Some(dec!(-1));
    }
    base.checked_powd(years).map(|p| p - Decimal::ONE)
}

/// Observations a year implied by the periods the samples actually cover:
/// 365.25 for a calendar-daily series, about 252 for trading days, correct
/// for gapped and weekly series too.
fn periods_per_year(samples: &[RiskSample]) -> Option<Decimal> {
    let covered_days = samples
        .iter()
        .try_fold(0i64, |total, sample| total.checked_add(sample.period_days))?;
    if samples.is_empty() || covered_days <= 0 {
        return None;
    }
    arith::div(
        Decimal::from(samples.len()) * DAYS_PER_YEAR,
        Decimal::from(covered_days),
    )
}

/// Annualised standard deviation of log returns, scaled by the frequency of
/// the samples the variance is taken over.
fn volatility(samples: &[RiskSample]) -> Option<Decimal> {
    if samples.len() < 2 {
        return None;
    }
    let (usable, log_returns): (Vec<RiskSample>, Vec<Decimal>) = samples
        .iter()
        .filter_map(|sample| {
            let factor = Decimal::ONE + sample.simple_return;
            if factor <= Decimal::ZERO {
                return None;
            }
            let log_return = factor.to_f64().and_then(|f| Decimal::from_f64(f.ln()))?;
            Some((*sample, log_return))
        })
        .unzip();
    if log_returns.len() < 2 {
        return None;
    }
    let count = Decimal::from(log_returns.len());
    let mean = log_returns.iter().sum::<Decimal>() / count;
    let sum_squared: Decimal = log_returns
        .iter()
        .map(|r| {
            let diff = *r - mean;
            diff * diff
        })
        .sum();
    let variance = sum_squared / (count - Decimal::ONE);
    if variance.is_sign_negative() {
        return None;
    }
    let period = variance.sqrt().unwrap_or(Decimal::ZERO);
    let factor = periods_per_year(&usable)?.sqrt()?;
    Some((period * factor).round_dp(STORED_PRECISION))
}

fn risk_from_samples(samples: &[RiskSample], opening_date: Option<NaiveDate>) -> Risk {
    let mut risk = Risk {
        volatility: volatility(samples),
        ..Risk::default()
    };
    if samples.is_empty() {
        return risk;
    }
    let mut cumulative = Decimal::ONE;
    let mut peak_value = Decimal::ONE;
    let mut peak_date = opening_date.unwrap_or(samples[0].date);
    let mut max_drawdown = Decimal::ZERO;
    let mut max_peak_date = peak_date;
    let mut trough_date = samples[0].date;
    let mut recovery_date = None;
    let mut in_max_drawdown = false;
    for sample in samples {
        // A path outside the kernel range has no drawdown to report.
        let Some(next) = arith::mul(cumulative, Decimal::ONE + sample.simple_return) else {
            return risk;
        };
        cumulative = next;
        if cumulative >= peak_value {
            peak_value = cumulative;
            peak_date = sample.date;
            if in_max_drawdown && recovery_date.is_none() {
                recovery_date = Some(sample.date);
            }
        }
        if peak_value > Decimal::ZERO {
            let drawdown = (cumulative - peak_value) / peak_value;
            if drawdown < max_drawdown {
                max_drawdown = drawdown;
                max_peak_date = peak_date;
                trough_date = sample.date;
                recovery_date = None;
                in_max_drawdown = true;
            }
        }
    }
    let duration_end = recovery_date.unwrap_or(trough_date);
    risk.max_drawdown = Some(max_drawdown.round_dp(STORED_PRECISION));
    risk.peak_date = Some(max_peak_date);
    risk.trough_date = Some(trough_date);
    risk.recovery_date = recovery_date;
    risk.drawdown_duration_days = Some((duration_end - max_peak_date).num_days());
    risk
}

fn simple_value_return(history: &[DailyValuation], flows: &[PeriodFlow]) -> Option<Decimal> {
    let first_value = history.first()?.total_value_base;
    // A leading negative row is pre-funding history: rebase on the first
    // observation with at least one base unit.
    let start_index = if first_value.is_sign_negative() {
        history
            .iter()
            .position(|d| d.total_value_base >= MIN_RETURN_BASE)?
    } else {
        0
    };
    let scoped = &history[start_index..];
    let scoped_flows = &flows[start_index..];
    if scoped.len() < 2 {
        return None;
    }
    let start_value = scoped[0].total_value_base;
    if start_value <= Decimal::ZERO {
        return None;
    }
    simple_value_return_amount(scoped, scoped_flows)
        .and_then(|amount| arith::div(amount, start_value))
}

fn simple_value_return_amount(history: &[DailyValuation], flows: &[PeriodFlow]) -> Option<Decimal> {
    let start = history.first()?;
    let end = history.last()?;
    let net: Decimal = flows.iter().map(|f| f.net()).sum();
    Some(end.total_value_base - start.total_value_base - net)
}

/// Legacy dashboard profile: the headline is the exact value change net of
/// external flows, with no attribution (holdings scopes already carry it).
fn apply_dashboard_amount(
    result: &mut PerformanceResult,
    history: &[DailyValuation],
    holdings: bool,
) {
    if result.coverage_unavailable {
        gate_breakdown(result);
    } else if !holdings {
        let flows = period_flows(history);
        result.attribution = Attribution {
            unrealized_pnl_change: simple_value_return_amount(history, &flows)
                .unwrap_or(Decimal::ZERO)
                .round_dp(STORED_PRECISION),
            ..Attribution::default()
        };
    }
    refresh_summary(result);
}

fn total_flows(flows: &[PeriodFlow]) -> (Decimal, Decimal) {
    flows
        .iter()
        .fold((Decimal::ZERO, Decimal::ZERO), |(i, o), f| {
            (i + f.inflow, o + f.outflow)
        })
}

fn attribution_baseline(holdings: bool, start_opt: Option<NaiveDate>) -> Baseline {
    if !holdings && start_opt.is_none() {
        Baseline::Inception
    } else {
        Baseline::PeriodStart
    }
}

fn flows_for_attribution(
    flows: &[PeriodFlow],
    start_point: &DailyValuation,
    baseline: Baseline,
) -> (Decimal, Decimal) {
    let (mut contributions, mut distributions) = total_flows(flows);
    if baseline == Baseline::Inception {
        let opening = start_point.net_contribution_base;
        if opening.is_sign_negative() {
            distributions += -opening;
        } else {
            contributions += opening;
        }
    }
    (contributions, distributions)
}

fn total_value_delta(start: &DailyValuation, end: &DailyValuation, baseline: Baseline) -> Decimal {
    if baseline == Baseline::Inception {
        end.total_value_base
    } else {
        end.total_value_base - start.total_value_base
    }
}

fn residual_threshold(delta_total_value: Decimal, end_value: Decimal) -> Decimal {
    Decimal::ONE.max(
        delta_total_value
            .abs()
            .max(end_value.abs())
            .max(Decimal::ONE)
            * RESIDUAL_TOLERANCE_RATE,
    )
}

fn component_total(attribution: &Attribution) -> Decimal {
    attribution.contributions - attribution.distributions + attribution.pnl()
}

fn unreconciled_delta(delta_total_value: Decimal, attribution: &Attribution) -> Decimal {
    (delta_total_value - component_total(attribution)).round_dp(STORED_PRECISION)
}

fn push_residual_diagnostic(
    quality: &mut DataQuality,
    unreconciled: Decimal,
    delta_total_value: Decimal,
    end_value: Decimal,
) {
    quality
        .warnings
        .retain(|w| !matches!(w, QualityNote::AttributionIncomplete { .. }));
    let threshold = residual_threshold(delta_total_value, end_value);
    if unreconciled.abs() > threshold {
        quality.warnings.push(QualityNote::AttributionIncomplete {
            difference: unreconciled.round_dp(STORED_PRECISION),
            tolerance: threshold.round_dp(STORED_PRECISION),
        });
    }
}

/// Legacy `unrealized_attribution_components`: local movement at the end
/// rate, and the FX residual, when the account is not in base currency.
fn unrealized_components(
    start: &DailyValuation,
    end: &DailyValuation,
    baseline: Baseline,
    account_is_base: bool,
) -> (Decimal, Decimal) {
    let end_base = end.investment_market_value_base - end.cost_basis_base;
    let start_base = if baseline == Baseline::Inception {
        Decimal::ZERO
    } else {
        start.investment_market_value_base - start.cost_basis_base
    };
    let base_change = end_base - start_base;
    if account_is_base {
        return (base_change, Decimal::ZERO);
    }
    let start_local = if baseline == Baseline::Inception {
        Decimal::ZERO
    } else {
        start.investment_market_value - start.cost_basis
    };
    let local_change = (end.investment_market_value - end.cost_basis) - start_local;
    let Some(local_at_end_fx) = arith::mul(local_change, end.fx_rate_to_base) else {
        // Not separable into local movement and FX: all of it is movement.
        return (base_change, Decimal::ZERO);
    };
    (
        local_at_end_fx.round_dp(STORED_PRECISION),
        (base_change - local_at_end_fx).round_dp(STORED_PRECISION),
    )
}

fn cash_only_fx_effect(history: &[DailyValuation], enabled: bool) -> Decimal {
    let cash_only = history.iter().all(|d| {
        d.investment_market_value.is_zero()
            && d.investment_market_value_base.is_zero()
            && d.cost_basis.is_zero()
            && d.cost_basis_base.is_zero()
    });
    if !enabled || !cash_only {
        return Decimal::ZERO;
    }
    history
        .windows(2)
        .map(|pair| {
            let (prev, curr) = (&pair[0], &pair[1]);
            let delta_base = curr.cash_balance_base - prev.cash_balance_base;
            arith::mul(curr.cash_balance - prev.cash_balance, curr.fx_rate_to_base)
                .map_or(Decimal::ZERO, |delta_at_current_fx| {
                    (delta_base - delta_at_current_fx).round_dp(STORED_PRECISION)
                })
        })
        .sum::<Decimal>()
        .round_dp(STORED_PRECISION)
}

fn holdings_basis_is_complete(point: &DailyValuation) -> bool {
    matches!(
        point.basis_status,
        BasisStatus::Complete | BasisStatus::NotApplicable
    )
}

fn holdings_all_time_unavailable_reason(
    end: &DailyValuation,
    metric: Metric,
    subject: Subject,
) -> Option<QualityNote> {
    if end.book_basis_base <= Decimal::ZERO {
        return Some(QualityNote::NonPositiveBookBasis { metric, subject });
    }
    if !holdings_basis_is_complete(end) {
        return Some(QualityNote::IncompleteBookBasis { metric, subject });
    }
    None
}

/// Legacy `compute_holdings_value_return`: gain versus ending book basis
/// (all time) or flow-adjusted value change over the starting value.
fn holdings_return(
    start: &DailyValuation,
    end: &DailyValuation,
    flows: &[PeriodFlow],
    is_all_time: bool,
) -> (Option<Decimal>, Option<Decimal>) {
    if is_all_time {
        let end_book = end.book_basis_base;
        if end_book <= Decimal::ZERO || !holdings_basis_is_complete(end) {
            return (None, None);
        }
        let gain = end.total_value_base - end_book;
        return (Some(gain), arith::div(gain, end_book));
    }
    let start_value = start.total_value_base;
    let net_explicit: Decimal = flows
        .iter()
        .filter(|f| f.source.has_known_amount())
        .map(|f| f.net())
        .sum();
    let change = end.total_value_base - start_value - net_explicit;
    let value_return = (start_value > Decimal::ZERO)
        .then(|| arith::div(change, start_value))
        .flatten();
    (Some(change), value_return)
}

fn has_estimated_holdings_flows(flows: &[PeriodFlow]) -> bool {
    flows
        .iter()
        .any(|f| f.source.has_known_amount() && (!f.inflow.is_zero() || !f.outflow.is_zero()))
}

// -------------------------------------------------------- result shaping

fn data_quality(
    warnings: Vec<QualityNote>,
    reasons: Vec<QualityNote>,
    no_data: bool,
) -> DataQuality {
    let status = if no_data {
        QualityStatus::NoData
    } else if !warnings.is_empty() || !reasons.is_empty() {
        QualityStatus::Partial
    } else {
        QualityStatus::Ok
    };
    DataQuality {
        status,
        warnings,
        not_applicable_reasons: reasons,
    }
}

fn refresh_quality_status(quality: &mut DataQuality) {
    if matches!(
        quality.status,
        QualityStatus::NoData | QualityStatus::NotApplicable
    ) {
        return;
    }
    quality.status = if quality.warnings.is_empty() && quality.not_applicable_reasons.is_empty() {
        QualityStatus::Ok
    } else {
        QualityStatus::Partial
    };
}

#[allow(clippy::too_many_arguments)]
fn build_result(
    scope: String,
    currency: Currency,
    period_start: Option<NaiveDate>,
    period_end: Option<NaiveDate>,
    method: ReturnMethod,
    returns: Returns,
    attribution: Attribution,
    risk: Risk,
    data_quality: DataQuality,
    series: Vec<SeriesPoint>,
    is_holdings_mode: bool,
    is_mixed_tracking_mode: bool,
) -> PerformanceResult {
    let basis_status =
        if is_holdings_mode || is_mixed_tracking_mode || method == ReturnMethod::ValueReturn {
            BasisStatus::Complete
        } else {
            BasisStatus::NotApplicable
        };
    let mut result = PerformanceResult {
        scope,
        currency,
        period_start,
        period_end,
        method,
        returns,
        attribution,
        risk,
        data_quality,
        basis_status,
        summary: Summary {
            amount_status: SummaryStatus::Complete,
            percent_status: SummaryStatus::Complete,
            ..Summary::default()
        },
        series,
        is_holdings_mode,
        is_mixed_tracking_mode,
        holdings_flows_unavailable: false,
        coverage_unavailable: false,
    };
    refresh_summary(&mut result);
    result
}

fn summary_gated(result: &PerformanceResult) -> bool {
    result.holdings_flows_unavailable
        || result.coverage_unavailable
        || (result.is_holdings_mode
            && matches!(
                result.basis_status,
                BasisStatus::Unknown | BasisStatus::PartialUnknown
            ))
}

fn refresh_summary(result: &mut PerformanceResult) {
    let mut amount_available = result.summary.amount_status == SummaryStatus::Complete;
    let mut percent_available = result.summary.percent_status == SummaryStatus::Complete;
    if summary_gated(result) {
        amount_available = false;
        percent_available = false;
    }
    let reasons: Vec<QualityNote> = result
        .data_quality
        .warnings
        .iter()
        .chain(result.data_quality.not_applicable_reasons.iter())
        .cloned()
        .collect();
    let percent = if percent_available {
        match result.method {
            ReturnMethod::TimeWeighted => result.returns.twr,
            ReturnMethod::ValueReturn | ReturnMethod::SymbolPriceBased => {
                result.returns.value_return
            }
            ReturnMethod::NotApplicable => None,
        }
    } else {
        None
    };
    let amount = if !amount_available
        || matches!(
            result.method,
            ReturnMethod::NotApplicable | ReturnMethod::SymbolPriceBased
        )
        || matches!(
            result.data_quality.status,
            QualityStatus::NoData | QualityStatus::NotApplicable
        ) {
        None
    } else {
        Some(result.attribution.pnl())
    };
    let basis = if result.is_mixed_tracking_mode {
        SummaryBasis::Mixed
    } else if result.is_holdings_mode || result.method == ReturnMethod::ValueReturn {
        SummaryBasis::BookBasis
    } else if matches!(
        result.method,
        ReturnMethod::TimeWeighted | ReturnMethod::SymbolPriceBased
    ) {
        SummaryBasis::MarketValue
    } else {
        SummaryBasis::NotApplicable
    };
    let status = |value: Option<Decimal>| {
        if value.is_some() {
            SummaryStatus::Complete
        } else {
            SummaryStatus::Unavailable
        }
    };
    result.summary = Summary {
        amount,
        percent,
        method: result.method,
        basis,
        quality: result.data_quality.status,
        amount_status: status(amount),
        percent_status: status(percent),
        basis_status: result.basis_status,
        reasons,
    };
}

fn empty_response(
    scope: &str,
    currency: &Currency,
    start: Option<NaiveDate>,
    end: Option<NaiveDate>,
    reason: QualityNote,
) -> PerformanceResult {
    build_result(
        scope.to_string(),
        currency.clone(),
        start,
        end,
        ReturnMethod::NotApplicable,
        Returns::default(),
        Attribution::default(),
        Risk::default(),
        DataQuality {
            status: QualityStatus::NoData,
            warnings: Vec::new(),
            not_applicable_reasons: vec![reason],
        },
        Vec::new(),
        false,
        false,
    )
}

fn partial_response(
    scope: &str,
    currency: &Currency,
    start: Option<NaiveDate>,
    end: Option<NaiveDate>,
    warning: QualityNote,
) -> PerformanceResult {
    build_result(
        scope.to_string(),
        currency.clone(),
        start,
        end,
        ReturnMethod::NotApplicable,
        Returns::default(),
        Attribution::default(),
        Risk::default(),
        DataQuality {
            status: QualityStatus::Partial,
            warnings: vec![warning],
            not_applicable_reasons: vec![QualityNote::ScopeMetricsUnavailable],
        },
        Vec::new(),
        false,
        false,
    )
}

// ------------------------------------------------------------ attribution

fn finalize_attribution(
    inputs: &MeasureInputs<'_>,
    result: &mut PerformanceResult,
    scope: &[AccountId],
    history: &[DailyValuation],
    baseline: Baseline,
    seed: Seed,
) {
    let mut effects = base_effects(result, seed.include_base_market_movement);
    effects.extend(seed.effects);
    let mut warnings = seed.warnings;

    let activity = activity_effects(inputs, result, scope, baseline);
    effects.extend(activity.effects);
    warnings.extend(activity.warnings);

    let disposals = period_disposals(inputs, result, scope, baseline);
    let realized = realized_effects(inputs, &disposals);
    effects.extend(realized.effects);
    warnings.extend(realized.warnings);

    let charges = trade_charge_effects(inputs, result, scope, baseline, &disposals);
    effects.extend(charges.effects);
    warnings.extend(charges.warnings);

    result.attribution = attribution_from_effects(&effects);
    result.data_quality.warnings.extend(warnings);
    if result.coverage_unavailable {
        gate_breakdown(result);
    } else {
        recompute_residual(result, history, baseline);
    }
    refresh_summary(result);
}

/// With an UNAVAILABLE period endpoint the P&L has no value to break down:
/// only the flows (contributions, distributions) are known, every
/// value-derived component is reported as zero alongside the coverage
/// reason, and no residual is computed against a partial delta.
fn gate_breakdown(result: &mut PerformanceResult) {
    result.attribution = Attribution {
        contributions: result.attribution.contributions,
        distributions: result.attribution.distributions,
        ..Attribution::default()
    };
}

fn base_effects(result: &PerformanceResult, include_market_movement: bool) -> Vec<Effect> {
    let attribution = &result.attribution;
    let mut effects = Vec::new();
    if !attribution.contributions.is_zero() {
        effects.push(Effect {
            external_flow: attribution.contributions,
            ..Effect::default()
        });
    }
    if !attribution.distributions.is_zero() {
        effects.push(Effect {
            external_flow: -attribution.distributions,
            ..Effect::default()
        });
    }
    if include_market_movement
        && (!attribution.unrealized_pnl_change.is_zero() || !attribution.fx_effect.is_zero())
    {
        effects.push(Effect {
            unrealized: attribution.unrealized_pnl_change,
            fx_effect: attribution.fx_effect,
            ..Effect::default()
        });
    }
    effects
}

fn attribution_from_effects(effects: &[Effect]) -> Attribution {
    let mut a = Attribution::default();
    for effect in effects {
        if effect.external_flow.is_sign_positive() {
            a.contributions += effect.external_flow;
        } else if effect.external_flow.is_sign_negative() {
            a.distributions += effect.external_flow.abs();
        }
        a.income += effect.income;
        a.realized_pnl += effect.realized_pnl;
        a.unrealized_pnl_change += effect.unrealized;
        a.fx_effect += effect.fx_effect;
        a.fees += effect.fee;
        a.taxes += effect.tax;
    }
    let r = |v: Decimal| v.round_dp(STORED_PRECISION);
    Attribution {
        contributions: r(a.contributions),
        distributions: r(a.distributions),
        income: r(a.income),
        realized_pnl: r(a.realized_pnl),
        unrealized_pnl_change: r(a.unrealized_pnl_change),
        fx_effect: r(a.fx_effect),
        fees: r(a.fees),
        taxes: r(a.taxes),
        residual: Decimal::ZERO,
    }
}

fn recompute_residual(
    result: &mut PerformanceResult,
    history: &[DailyValuation],
    baseline: Baseline,
) {
    let (Some(start), Some(end)) = (history.first(), history.last()) else {
        return;
    };
    let end_value = end.total_value_base;
    let delta_total_value = total_value_delta(start, end, baseline);
    result.attribution.residual = Decimal::ZERO;
    let unreconciled = unreconciled_delta(delta_total_value, &result.attribution);
    push_residual_diagnostic(
        &mut result.data_quality,
        unreconciled,
        delta_total_value,
        end_value,
    );
    refresh_quality_status(&mut result.data_quality);
}

/// The days whose events a window attributes. Against a period-start
/// baseline the start row already holds that day's activity, so counting
/// starts the day after; against an inception baseline the delta runs from
/// zero, so the first day's fees, income and trades count too.
#[derive(Debug, Clone, Copy)]
struct Period {
    start: NaiveDate,
    end: NaiveDate,
    includes_start: bool,
}

impl Period {
    fn of(result: &PerformanceResult, baseline: Baseline) -> Option<Self> {
        Some(Self {
            start: result.period_start?,
            end: result.period_end?,
            includes_start: baseline == Baseline::Inception,
        })
    }

    fn contains(self, date: NaiveDate) -> bool {
        let after_start = if self.includes_start {
            date >= self.start
        } else {
            date > self.start
        };
        after_start && date <= self.end
    }
}

/// Income, fees and taxes of the period's events, as `compile` decided them
/// (`EconomicEvent::attribution`), priced in base on the event date.
fn activity_effects(
    inputs: &MeasureInputs<'_>,
    result: &PerformanceResult,
    scope: &[AccountId],
    baseline: Baseline,
) -> EffectSet {
    let Some(period) = Period::of(result, baseline) else {
        return EffectSet::default();
    };
    let mut set = EffectSet::default();
    for event in inputs
        .effects
        .events
        .iter()
        .filter(|e| scope.contains(&e.account) && period.contains(e.date))
    {
        let mut effect = Effect::default();
        let mut has_effect = false;
        for (component, priced, slot) in [
            (Component::Income, event.income, &mut effect.income),
            (Component::Fee, event.fee, &mut effect.fee),
            (Component::Tax, event.tax, &mut effect.tax),
        ] {
            if priced.is_some_and(|amount| amount.is_zero()) {
                continue;
            }
            match priced {
                Some(amount) => {
                    *slot = amount;
                    has_effect = true;
                }
                None => set.warnings.push(QualityNote::AttributionSkipped {
                    component,
                    activity: event.source.as_str().to_string(),
                }),
            }
        }
        if has_effect {
            set.effects.push(effect);
        }
    }
    set
}

/// Disposals of the period whose disposing event is a BUY/SELL dated inside
/// the period (legacy filters lot disposals by trade activity ids).
fn period_disposals<'a>(
    inputs: &'a MeasureInputs<'a>,
    result: &PerformanceResult,
    scope: &[AccountId],
    baseline: Baseline,
) -> Vec<&'a LotDisposal> {
    let Some(period) = Period::of(result, baseline) else {
        return Vec::new();
    };
    let trade_ids: HashSet<&str> = inputs
        .effects
        .events
        .iter()
        .filter(|e| e.trade && scope.contains(&e.account) && period.contains(e.date))
        .map(|e| e.id.as_str())
        .collect();
    inputs
        .disposals
        .iter()
        .filter(|d| scope.contains(&d.account) && period.contains(d.date))
        .filter(|d| trade_ids.contains(d.event.as_str()))
        .collect()
}

fn realized_effects(inputs: &MeasureInputs<'_>, disposals: &[&LotDisposal]) -> EffectSet {
    let base = inputs.base().as_str();
    let mut set = EffectSet::default();
    for disposal in disposals {
        let foreign = !disposal.currency.as_str().eq_ignore_ascii_case(base);
        if foreign && disposal.fx_rate_to_base <= Decimal::ZERO {
            set.warnings.push(QualityNote::RealizedSkipped {
                disposal: disposal.id.clone(),
            });
            continue;
        }
        let sign_mismatch = (disposal.cost_basis.is_sign_positive()
            && disposal.cost_basis_base.is_sign_negative())
            || (disposal.cost_basis.is_sign_negative()
                && disposal.cost_basis_base.is_sign_positive());
        if foreign
            && !disposal.cost_basis.is_zero()
            && (disposal.cost_basis_base.is_zero() || sign_mismatch)
        {
            set.warnings
                .push(QualityNote::RealizedSkippedAcquisitionFx {
                    disposal: disposal.id.clone(),
                });
            continue;
        }
        if disposal.realized_pnl_base.is_zero() {
            continue;
        }
        set.effects.push(Effect {
            realized_pnl: disposal.realized_pnl_base,
            ..Effect::default()
        });
    }
    set
}

/// Legacy `collect_trade_charge_pnl_gross_up_event_effects`: trade charges
/// capitalized into lots are re-expressed as realized/unrealized P&L so
/// reported fees reconcile with value changes.
fn trade_charge_effects(
    inputs: &MeasureInputs<'_>,
    result: &PerformanceResult,
    scope: &[AccountId],
    baseline: Baseline,
    disposals: &[&LotDisposal],
) -> EffectSet {
    let Some(period) = Period::of(result, baseline) else {
        return EffectSet::default();
    };
    struct Charge {
        charge: Decimal,
        quantity: Decimal,
    }
    let mut charge_by_activity: HashMap<&str, Charge> = HashMap::new();
    let mut fallback_buy_charge: HashMap<&str, Decimal> = HashMap::new();
    for (event, trade) in inputs
        .effects
        .events
        .iter()
        .filter(|e| scope.contains(&e.account) && period.contains(e.date))
        .filter_map(|e| e.trade_charge.map(|trade| (e, trade)))
    {
        if trade.buy {
            fallback_buy_charge.insert(event.source.as_str(), trade.charge);
        }
        charge_by_activity.insert(
            event.source.as_str(),
            Charge {
                charge: trade.charge,
                quantity: trade.quantity,
            },
        );
    }
    if charge_by_activity.is_empty() {
        return EffectSet::default();
    }

    let lots: Vec<&LotRecord> = inputs
        .lots
        .iter()
        .filter(|lot| scope.contains(&lot.account))
        .collect();
    let lot_by_id: HashMap<(&AccountId, &str), &LotRecord> = lots
        .iter()
        .map(|lot| ((&lot.account, lot.id.as_str()), *lot))
        .collect();

    let mut period_open_charge_by_activity: HashMap<&str, Decimal> = HashMap::new();
    let mut saw_period_open_lots = false;
    let mut remaining_open_from_lots = Decimal::ZERO;
    for lot in lots.iter().copied() {
        let Some(open_activity) = lot.open_activity.as_ref() else {
            continue;
        };
        if !charge_by_activity.contains_key(open_activity.as_str())
            || !period.contains(lot.open_date)
        {
            continue;
        }
        saw_period_open_lots = true;
        let full_charge = lot.fee_allocated_base + lot.tax_allocated_base;
        if full_charge.is_zero() {
            continue;
        }
        *period_open_charge_by_activity
            .entry(open_activity.as_str())
            .or_default() += full_charge;
        if lot.remaining_quantity.is_zero() {
            continue;
        }
        let original_quantity = lot.original_quantity.abs();
        // A share outside the kernel range attributes nothing.
        let remaining_charge = if original_quantity > Decimal::ZERO {
            arith::proportional(full_charge, lot.remaining_quantity.abs(), original_quantity)
                .unwrap_or(Decimal::ZERO)
        } else if lot.original_cost_basis_base.abs() > Decimal::ZERO {
            arith::proportional(
                full_charge,
                lot.remaining_cost_basis_base.abs(),
                lot.original_cost_basis_base.abs(),
            )
            .unwrap_or(Decimal::ZERO)
        } else {
            full_charge
        };
        remaining_open_from_lots += remaining_charge;
    }

    let mut acquisition_charges_disposed = Decimal::ZERO;
    let mut disposal_activity_ids: HashSet<&str> = HashSet::new();
    let mut disposed_quantity_by_activity: HashMap<&str, Decimal> = HashMap::new();
    for disposal in disposals {
        disposal_activity_ids.insert(disposal.event.as_str());
        *disposed_quantity_by_activity
            .entry(disposal.event.as_str())
            .or_default() += disposal.quantity.abs();
        let Some(lot) = lot_by_id.get(&(&disposal.account, disposal.lot_id.as_str())) else {
            continue;
        };
        if !period.contains(lot.open_date) {
            continue;
        }
        let Some(open_activity) = lot.open_activity.as_ref() else {
            continue;
        };
        if !charge_by_activity.contains_key(open_activity.as_str()) {
            continue;
        }
        let charge_allocated = lot.fee_allocated_base + lot.tax_allocated_base;
        if charge_allocated.is_zero() {
            continue;
        }
        let original_quantity = lot.original_quantity.abs();
        let disposed_quantity = disposal.quantity.abs();
        if original_quantity > Decimal::ZERO {
            acquisition_charges_disposed +=
                arith::proportional(charge_allocated, disposed_quantity, original_quantity)
                    .unwrap_or(Decimal::ZERO);
        } else if lot.original_cost_basis_base.abs() > Decimal::ZERO {
            acquisition_charges_disposed += arith::proportional(
                charge_allocated,
                disposal.cost_basis_base.abs(),
                lot.original_cost_basis_base.abs(),
            )
            .unwrap_or(Decimal::ZERO);
        }
    }

    let r = |v: Decimal| v.round_dp(STORED_PRECISION);
    let mut period_open_charges = r(period_open_charge_by_activity.values().copied().sum());
    if period_open_charges.is_zero() && !saw_period_open_lots {
        period_open_charges = r(fallback_buy_charge
            .iter()
            .filter(|(id, _)| !disposal_activity_ids.contains(*id))
            .map(|(_, charge)| *charge)
            .sum());
    }
    let period_disposal_charges = r(disposed_quantity_by_activity
        .iter()
        .filter_map(|(id, disposed)| {
            let input = charge_by_activity.get(id)?;
            Some(if input.quantity > Decimal::ZERO {
                arith::proportional(input.charge, *disposed, input.quantity)
                    .map_or(input.charge, |charge| charge.min(input.charge))
            } else {
                input.charge
            })
        })
        .sum());
    let acquisition_charges_disposed = r(acquisition_charges_disposed.min(period_open_charges));
    let remaining_period_open = if saw_period_open_lots {
        r(remaining_open_from_lots.min(period_open_charges))
    } else {
        r(period_open_charges - acquisition_charges_disposed)
    };

    let mut set = EffectSet::default();
    if !period_disposal_charges.is_zero() || !acquisition_charges_disposed.is_zero() {
        set.effects.push(Effect {
            realized_pnl: r(period_disposal_charges + acquisition_charges_disposed),
            ..Effect::default()
        });
    }
    if !remaining_period_open.is_zero() {
        set.effects.push(Effect {
            unrealized: r(remaining_period_open),
            ..Effect::default()
        });
    }
    set
}

/// Legacy `scoped_unrealized_attribution_components` over per-account rows.
fn scoped_unrealized_effects(
    inputs: &MeasureInputs<'_>,
    result: &PerformanceResult,
    scope: &[AccountId],
    baseline: Baseline,
) -> EffectSet {
    let (Some(start), Some(end)) = (result.period_start, result.period_end) else {
        return EffectSet::default();
    };
    let window = Window {
        start: Some(start),
        end: Some(end),
    };
    let mut unrealized = Decimal::ZERO;
    let mut fx_effect = Decimal::ZERO;
    let mut warnings = Vec::new();
    let mut saw_account = false;
    let mut complete = true;
    for account in scope {
        let history = inputs.history(account, window);
        if history.is_empty() {
            continue;
        }
        let start_point = if baseline == Baseline::Inception {
            None
        } else {
            history.iter().rev().find(|d| d.date <= start)
        };
        let Some(end_point) = history.iter().rev().find(|d| d.date <= end) else {
            continue;
        };
        let end_fx = if inputs.account_is_base(account) {
            Decimal::ONE
        } else {
            end_point.fx_rate_to_base
        };
        if end_fx <= Decimal::ZERO {
            complete = false;
            warnings.push(QualityNote::ScopedFxSkippedRate {
                account: account.as_str().to_string(),
            });
            continue;
        }
        let local = |d: &DailyValuation| d.investment_market_value - d.cost_basis;
        let base = |d: &DailyValuation| d.investment_market_value_base - d.cost_basis_base;
        let local_change = local(end_point) - start_point.map_or(Decimal::ZERO, local);
        let base_change = base(end_point) - start_point.map_or(Decimal::ZERO, base);
        let Some(local_at_end_fx) = arith::mul(local_change, end_fx) else {
            complete = false;
            warnings.push(QualityNote::ScopedFxSkippedRange {
                account: account.as_str().to_string(),
            });
            continue;
        };
        unrealized += local_at_end_fx;
        fx_effect += base_change - local_at_end_fx;
        saw_account = true;
    }
    let complete = complete && saw_account;
    if !complete {
        return EffectSet {
            effects: Vec::new(),
            warnings,
            complete: false,
        };
    }
    let unrealized = unrealized.round_dp(STORED_PRECISION);
    let fx_effect = fx_effect.round_dp(STORED_PRECISION);
    let effects = if unrealized.is_zero() && fx_effect.is_zero() {
        Vec::new()
    } else {
        vec![Effect {
            unrealized,
            fx_effect,
            ..Effect::default()
        }]
    };
    EffectSet {
        effects,
        warnings,
        complete: true,
    }
}

/// Legacy `collect_scoped_transfer_pair_attribution_event_effects`: the FX
/// gap between the two legs of cross-currency pairs inside the scope.
fn transfer_pair_effects(
    inputs: &MeasureInputs<'_>,
    result: &PerformanceResult,
    scope: &[AccountId],
    baseline: Baseline,
) -> EffectSet {
    let Some(period) = Period::of(result, baseline) else {
        return EffectSet::default();
    };
    let by_source: HashMap<&str, &EventEffect> = inputs
        .effects
        .events
        .iter()
        .map(|e| (e.source.as_str(), e))
        .collect();
    let mut warnings = Vec::new();
    let mut fx_total = Decimal::ZERO;
    for pair in &inputs.effects.pairs {
        if !scope.contains(&pair.in_account) || !scope.contains(&pair.out_account) {
            continue;
        }
        let (Some(transfer_in), Some(transfer_out)) = (
            by_source.get(pair.transfer_in.as_str()),
            by_source.get(pair.transfer_out.as_str()),
        ) else {
            continue;
        };
        let touches_period = [transfer_in, transfer_out]
            .iter()
            .any(|leg| scope.contains(&leg.account) && period.contains(leg.date));
        if !touches_period {
            continue;
        }
        if transfer_in.marked_external || transfer_out.marked_external {
            warnings.push(QualityNote::ExternalMarkerIgnored {
                group: pair.group.clone(),
            });
        }
        if transfer_in
            .currency
            .as_str()
            .eq_ignore_ascii_case(transfer_out.currency.as_str())
        {
            continue;
        }
        let priced = |leg: &EventEffect| leg.flow.map_or(Decimal::ZERO, |flow| flow.amount);
        let (in_base, out_base) = (priced(transfer_in), priced(transfer_out));
        if in_base.is_zero() && out_base.is_zero() {
            continue;
        }
        fx_total += in_base - out_base;
    }
    let effects = if fx_total.is_zero() {
        Vec::new()
    } else {
        vec![Effect {
            fx_effect: fx_total.round_dp(STORED_PRECISION),
            ..Effect::default()
        }]
    };
    EffectSet {
        effects,
        warnings,
        complete: true,
    }
}

// ------------------------------------------------------------ mixed scope

struct MixedComponent {
    account: AccountId,
    tracking: TrackingMode,
    history: Vec<DailyValuation>,
}

struct ComponentMetrics {
    account: AccountId,
    start_date: NaiveDate,
    end_date: NaiveDate,
    amount: Option<Decimal>,
    denominator: Option<Decimal>,
    contributes_to_scope: bool,
    basis_status: BasisStatus,
    attribution: Attribution,
    warnings: Vec<QualityNote>,
    reasons: Vec<QualityNote>,
}

struct MixedSeriesPoint {
    date: NaiveDate,
    amount: Decimal,
    denominator: Option<Decimal>,
}

fn mixed_denominator(
    history: &[DailyValuation],
    tracking: TrackingMode,
    is_all_time: bool,
) -> Option<Decimal> {
    let denominator = if tracking == TrackingMode::Holdings && is_all_time {
        history
            .last()
            .filter(|d| holdings_basis_is_complete(d))
            .map(|d| d.book_basis_base)
            .unwrap_or(Decimal::ZERO)
    } else if is_all_time {
        history
            .iter()
            .map(|d| d.total_value_base)
            .find(|v| *v > Decimal::ZERO)
            .unwrap_or(Decimal::ZERO)
    } else {
        history
            .first()
            .map(|d| d.total_value_base)
            .unwrap_or(Decimal::ZERO)
    };
    (denominator > Decimal::ZERO).then_some(denominator)
}

fn transaction_component_reasons(reasons: Vec<QualityNote>) -> Vec<QualityNote> {
    reasons
        .into_iter()
        .filter(|r| *r != QualityNote::TransactionNonPositiveStart)
        .collect()
}

/// Legacy `compute_mixed_scope_performance_from_account_histories_with_attribution`.
fn mixed_scope_performance(
    inputs: &MeasureInputs<'_>,
    scope: &[AccountId],
    window: Window,
    profile: MeasureProfile,
    include_series: bool,
) -> PerformanceResult {
    let is_all_time = window.start.is_none();
    // Legacy: dashboard requests measure components with the dashboard
    // profile, everything else with the summary profile.
    let component_profile = if profile == MeasureProfile::Dashboard {
        MeasureProfile::Dashboard
    } else {
        MeasureProfile::Summary
    };
    let base = inputs.base();
    let components: Vec<MixedComponent> = scope
        .iter()
        .map(|account| MixedComponent {
            account: account.clone(),
            tracking: inputs.tracking(account),
            history: inputs.history(account, window),
        })
        .collect();

    let mut metrics = Vec::new();
    let mut skipped = Vec::new();
    for component in &components {
        let history = &component.history;
        if history.len() < 2 {
            skipped.push(QualityNote::MixedSkippedTwoPoints {
                account: component.account.as_str().to_string(),
            });
            continue;
        }
        if history
            .iter()
            .any(|d| d.total_value_base.is_sign_negative())
        {
            skipped.push(QualityNote::MixedSkippedNegative {
                account: component.account.as_str().to_string(),
            });
            continue;
        }
        let start_point = &history[0];
        let end_point = &history[history.len() - 1];
        let contributes_to_scope = start_point.total_value_base > Decimal::ZERO
            || end_point.total_value_base > Decimal::ZERO;
        let mut warnings = Vec::new();
        let mut reasons = Vec::new();

        let (amount, attribution, basis_status) = if component.tracking == TrackingMode::Holdings {
            let flows = period_flows(history);
            let flows_unavailable =
                !is_all_time && flows.iter().any(|f| f.source.is_unavailable_for_returns());
            let (amount, _) = if flows_unavailable {
                (None, None)
            } else {
                holdings_return(start_point, end_point, &flows, is_all_time)
            };
            if !is_all_time && has_estimated_holdings_flows(&flows) {
                warnings.push(QualityNote::MixedHoldingsFlowsEstimated {
                    account: component.account.as_str().to_string(),
                });
            }
            let mut attribution = Attribution::default();
            if let Some(amount) = amount {
                attribution.unrealized_pnl_change = amount.round_dp(STORED_PRECISION);
            } else if flows_unavailable {
                warnings.push(QualityNote::MixedExcludedFlows {
                    account: component.account.as_str().to_string(),
                });
                reasons.push(QualityNote::FlowsNotInferred {
                    metric: Metric::Pnl,
                    subject: Subject::HoldingsAccount(component.account.as_str().to_string()),
                });
            } else {
                let subject = Subject::HoldingsAccount(component.account.as_str().to_string());
                let reason =
                    holdings_all_time_unavailable_reason(end_point, Metric::Pnl, subject.clone())
                        .unwrap_or(QualityNote::PnlUnavailable { subject });
                warnings.push(QualityNote::MixedExcludedBasis {
                    account: component.account.as_str().to_string(),
                });
                reasons.push(reason);
            }
            (amount, attribution, end_point.basis_status)
        } else {
            let mut component_result = performance_core(
                history,
                false,
                window.start,
                false,
                component_profile,
                inputs.is_cash_account(&component.account),
                inputs.account_is_base(&component.account),
                base,
            );
            component_result.scope = component.account.as_str().to_string();
            if component_profile == MeasureProfile::Dashboard {
                apply_dashboard_amount(&mut component_result, history, false);
            } else {
                finalize_attribution(
                    inputs,
                    &mut component_result,
                    std::slice::from_ref(&component.account),
                    history,
                    attribution_baseline(false, window.start),
                    Seed::default(),
                );
            }
            warnings = component_result.data_quality.warnings;
            reasons =
                transaction_component_reasons(component_result.data_quality.not_applicable_reasons);
            (
                Some(component_result.attribution.pnl()),
                component_result.attribution,
                BasisStatus::NotApplicable,
            )
        };

        metrics.push(ComponentMetrics {
            account: component.account.clone(),
            start_date: start_point.date,
            end_date: end_point.date,
            amount,
            denominator: mixed_denominator(history, component.tracking, is_all_time),
            contributes_to_scope,
            basis_status,
            attribution,
            warnings,
            reasons,
        });
    }
    build_mixed_result(
        &components,
        metrics,
        skipped,
        base,
        window.start,
        include_series,
    )
}

fn build_mixed_result(
    components: &[MixedComponent],
    metrics: Vec<ComponentMetrics>,
    skipped: Vec<QualityNote>,
    currency: &Currency,
    start_opt: Option<NaiveDate>,
    include_series: bool,
) -> PerformanceResult {
    let is_all_time = start_opt.is_none();
    let mut attribution = Attribution::default();
    let mut summary_amount = Decimal::ZERO;
    let mut denominator = Decimal::ZERO;
    let mut warnings = vec![QualityNote::MixedScope];
    warnings.extend(skipped);
    let mut reasons = vec![
        QualityNote::MixedTwrNotApplicable,
        QualityNote::MixedIrrNotApplicable,
    ];
    let mut coverage_complete = true;

    if metrics.is_empty() {
        reasons.push(QualityNote::TwoValuationPointsRequired);
        let mut result = build_result(
            String::new(),
            currency.clone(),
            start_opt,
            None,
            ReturnMethod::NotApplicable,
            Returns::default(),
            Attribution::default(),
            Risk::default(),
            data_quality(warnings, reasons, true),
            Vec::new(),
            false,
            true,
        );
        result.basis_status = BasisStatus::Unknown;
        refresh_summary(&mut result);
        return result;
    }

    let mut actual_start = metrics[0].start_date;
    let mut actual_end = metrics[0].end_date;
    for component in &metrics {
        actual_start = actual_start.min(component.start_date);
        actual_end = actual_end.max(component.end_date);
        warnings.extend(component.warnings.iter().cloned());
        reasons.extend(component.reasons.iter().cloned());
        let amount_available = component.amount.is_some();
        if let Some(amount) = component.amount {
            summary_amount += amount;
            add_attribution(&mut attribution, &component.attribution);
        }
        match component.denominator {
            Some(value) if amount_available => denominator += value,
            Some(_) => {
                coverage_complete = false;
                warnings.push(QualityNote::MixedPercentExcluded {
                    account: component.account.as_str().to_string(),
                });
            }
            None if amount_available => {
                coverage_complete = false;
                warnings.push(QualityNote::MixedPercentNoDenominator {
                    account: component.account.as_str().to_string(),
                });
            }
            None if component.contributes_to_scope => {
                coverage_complete = false;
                warnings.push(QualityNote::MixedPercentCoverage {
                    account: component.account.as_str().to_string(),
                });
            }
            None => {}
        }
    }

    let value_return = if !coverage_complete {
        reasons.push(QualityNote::MixedCoverageDiffers);
        None
    } else if denominator > Decimal::ZERO {
        let value_return = arith::div(summary_amount, denominator);
        if value_return.is_none() {
            reasons.push(QualityNote::MixedReturnOutOfRange);
        }
        value_return
    } else {
        reasons.push(QualityNote::MixedNonPositiveDenominators);
        None
    };

    let mut series = Vec::new();
    if include_series && value_return.is_some() {
        if is_all_time {
            warnings.push(QualityNote::MixedSeriesUnavailable);
        } else {
            series = mixed_bounded_series(components, actual_start);
        }
    }

    let residual = summary_amount - attribution.pnl();
    if !residual.is_zero() {
        warnings.push(QualityNote::MixedAttributionUnreconciled {
            delta: residual.round_dp(STORED_PRECISION),
        });
    }

    let mut result = build_result(
        String::new(),
        currency.clone(),
        Some(actual_start),
        Some(actual_end),
        ReturnMethod::ValueReturn,
        Returns {
            value_return: value_return.map(|v| v.round_dp(STORED_PRECISION)),
            annualized_value_return: annualize(actual_start, actual_end, value_return),
            ..Returns::default()
        },
        attribution,
        Risk::default(),
        data_quality(warnings, reasons, false),
        series,
        false,
        true,
    );
    result.basis_status = metrics
        .iter()
        .map(|m| m.basis_status)
        .fold(BasisStatus::NotApplicable, BasisStatus::combine);
    let amount_available = metrics.iter().any(|m| m.amount.is_some());
    result.summary.amount_status = if amount_available {
        SummaryStatus::Complete
    } else {
        SummaryStatus::Unavailable
    };
    result.summary.percent_status = if value_return.is_some() && coverage_complete {
        SummaryStatus::Complete
    } else {
        SummaryStatus::Unavailable
    };
    refresh_summary(&mut result);
    result
}

fn add_attribution(target: &mut Attribution, source: &Attribution) {
    target.contributions += source.contributions;
    target.distributions += source.distributions;
    target.income += source.income;
    target.realized_pnl += source.realized_pnl;
    target.unrealized_pnl_change += source.unrealized_pnl_change;
    target.fx_effect += source.fx_effect;
    target.fees += source.fees;
    target.taxes += source.taxes;
}

fn mixed_component_series(component: &MixedComponent) -> Vec<MixedSeriesPoint> {
    let history = &component.history;
    if history.len() < 2
        || history
            .iter()
            .any(|d| d.total_value_base.is_sign_negative())
    {
        return Vec::new();
    }
    let denominator = mixed_denominator(history, component.tracking, false);
    let start_value = history[0].total_value_base;
    let flows = period_flows(history);
    let holdings = component.tracking == TrackingMode::Holdings;
    if holdings && flows.iter().any(|f| f.source.is_unavailable_for_returns()) {
        return Vec::new();
    }
    let mut net_flow = Decimal::ZERO;
    history
        .iter()
        .skip(1)
        .zip(flows.iter())
        .map(|(point, flow)| {
            if !holdings || flow.source.has_known_amount() {
                net_flow += flow.net();
            }
            MixedSeriesPoint {
                date: point.date,
                amount: point.total_value_base - start_value - net_flow,
                denominator,
            }
        })
        .collect()
}

fn mixed_bounded_series(
    components: &[MixedComponent],
    actual_start: NaiveDate,
) -> Vec<SeriesPoint> {
    let component_series: Vec<Vec<MixedSeriesPoint>> =
        components.iter().map(mixed_component_series).collect();
    let mut dates: Vec<NaiveDate> = component_series
        .iter()
        .flat_map(|s| s.iter().map(|p| p.date))
        .filter(|d| *d >= actual_start)
        .collect();
    dates.push(actual_start);
    dates.sort_unstable();
    dates.dedup();

    let mut series = Vec::with_capacity(dates.len());
    let mut cursors: Vec<Option<usize>> = vec![None; component_series.len()];
    for date in dates {
        if date == actual_start {
            series.push(SeriesPoint {
                date,
                value: Decimal::ZERO,
            });
            continue;
        }
        let mut amount = Decimal::ZERO;
        let mut denominator = Decimal::ZERO;
        for (index, points) in component_series.iter().enumerate() {
            let mut next = cursors[index].map_or(0, |i| i + 1);
            while next < points.len() && points[next].date <= date {
                cursors[index] = Some(next);
                next += 1;
            }
            if let Some(point) = cursors[index].map(|i| &points[i]) {
                amount += point.amount;
                if let Some(value) = point.denominator {
                    denominator += value;
                }
            }
        }
        if let Some(value) = (denominator > Decimal::ZERO)
            .then(|| arith::div(amount, denominator))
            .flatten()
        {
            series.push(SeriesPoint {
                date,
                value: value.round_dp(STORED_PRECISION),
            });
        }
    }
    series
}

/// Symbol performance from a price series (legacy
/// `calculate_symbol_performance`): chained daily price returns, no cash
/// flows, so only the value return and risk are meaningful. `points` must be
/// sorted by date with one close per day.
pub fn measure_price_series(
    scope: &str,
    currency: &Currency,
    points: &[(NaiveDate, Decimal)],
) -> PerformanceResult {
    let requested_start = points.first().map(|(d, _)| *d);
    let requested_end = points.last().map(|(d, _)| *d);
    if points.len() < 2 {
        return empty_response(
            scope,
            currency,
            requested_start,
            requested_end,
            QualityNote::TwoQuotePointsRequired,
        );
    }
    let (start_date, start_price) = points[0];
    let (end_date, end_price) = points[points.len() - 1];
    if start_price <= Decimal::ZERO {
        return empty_response(
            scope,
            currency,
            Some(start_date),
            Some(end_date),
            QualityNote::NonPositiveStartingQuote,
        );
    }
    let mut series = Vec::with_capacity(points.len());
    let mut risk_samples = Vec::with_capacity(points.len() - 1);
    let mut cumulative = Decimal::ONE;
    let mut previous = start_price;
    series.push(SeriesPoint {
        date: start_date,
        value: Decimal::ZERO,
    });
    let out_of_range = || {
        empty_response(
            scope,
            currency,
            Some(start_date),
            Some(end_date),
            QualityNote::PriceSeriesOutOfRange,
        )
    };
    let mut previous_date = start_date;
    for (date, price) in points.iter().copied().skip(1) {
        if price <= Decimal::ZERO || previous <= Decimal::ZERO {
            previous = price;
            previous_date = date;
            continue;
        }
        let Some(ratio) = arith::div(price, previous) else {
            return out_of_range();
        };
        let daily_return = ratio - Decimal::ONE;
        risk_samples.push(RiskSample {
            date,
            simple_return: daily_return,
            period_days: (date - previous_date).num_days(),
        });
        let Some(next) = arith::mul(cumulative, ratio) else {
            return out_of_range();
        };
        cumulative = next;
        series.push(SeriesPoint {
            date,
            value: (cumulative - Decimal::ONE).round_dp(STORED_PRECISION),
        });
        previous = price;
        previous_date = date;
    }
    let Some(total_return) = arith::div(end_price, start_price).map(|r| r - Decimal::ONE) else {
        return out_of_range();
    };
    build_result(
        scope.to_string(),
        currency.clone(),
        Some(start_date),
        Some(end_date),
        ReturnMethod::SymbolPriceBased,
        Returns {
            value_return: Some(total_return.round_dp(STORED_PRECISION)),
            annualized_value_return: annualize(start_date, end_date, Some(total_return)),
            ..Returns::default()
        },
        Attribution::default(),
        risk_from_samples(&risk_samples, Some(start_date)),
        data_quality(
            vec![QualityNote::SymbolPriceOnly],
            vec![
                QualityNote::SymbolTwrNotApplicable,
                QualityNote::SymbolIrrNotApplicable,
            ],
            false,
        ),
        series,
        false,
        false,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn samples(periods: &[i64]) -> Vec<RiskSample> {
        let start = NaiveDate::from_ymd_opt(2025, 1, 1).unwrap();
        periods
            .iter()
            .enumerate()
            .map(|(index, days)| RiskSample {
                date: start + chrono::Days::new(index as u64),
                simple_return: if index % 2 == 0 {
                    dec!(0.01)
                } else {
                    dec!(-0.01)
                },
                period_days: *days,
            })
            .collect()
    }

    #[test]
    fn frequency_follows_the_periods_the_samples_cover() {
        // Calendar-daily rows: 365.25 a year.
        assert_eq!(periods_per_year(&samples(&[1; 10])), Some(DAYS_PER_YEAR));
        // Trading days (a weekend every five returns): about 261 a year.
        let trading: Vec<i64> = (0..20).map(|i| if i % 5 == 4 { 3 } else { 1 }).collect();
        let per_year = periods_per_year(&samples(&trading)).unwrap();
        assert!(per_year > dec!(260) && per_year < dec!(262), "{per_year}");
        // The same returns annualise less on a trading-day series than on a
        // calendar-daily one.
        let calendar = volatility(&samples(&[1; 20])).unwrap();
        let weekdays = volatility(&samples(&trading)).unwrap();
        assert!(weekdays < calendar, "{weekdays} vs {calendar}");
    }

    #[test]
    fn frequency_ignores_gaps_left_by_excluded_days() {
        // Every third day excluded; each surviving return still covers one day.
        let start = NaiveDate::from_ymd_opt(2025, 1, 1).unwrap();
        let gapped: Vec<RiskSample> = (0..90u64)
            .filter(|offset| offset % 3 != 0)
            .map(|offset| RiskSample {
                date: start + chrono::Days::new(offset),
                simple_return: Decimal::ZERO,
                period_days: 1,
            })
            .collect();
        assert_eq!(periods_per_year(&gapped), Some(DAYS_PER_YEAR));
    }

    #[test]
    fn frequency_counts_the_first_returns_own_period() {
        // Two returns covering eight days: 2 * 365.25 / 8. Reading the one-day
        // gap between the two sample dates would claim 365.25.
        let per_year = periods_per_year(&samples(&[7, 1])).unwrap();
        assert_eq!(per_year.round_dp(2), dec!(91.31));
    }

    #[test]
    fn volatility_declines_when_the_returns_cover_no_period() {
        assert_eq!(volatility(&samples(&[0, 0])), None);
    }

    #[test]
    fn volatility_scales_with_the_sampling_rate() {
        let returns = [dec!(0), dec!(0.01), dec!(-0.01), dec!(0.02), dec!(-0.02)];
        let at = |step: i64| {
            let start = NaiveDate::from_ymd_opt(2026, 1, 5).unwrap();
            let series: Vec<RiskSample> = returns
                .iter()
                .enumerate()
                .map(|(index, simple_return)| RiskSample {
                    date: start + chrono::Days::new(index as u64 * step as u64),
                    simple_return: *simple_return,
                    period_days: step,
                })
                .collect();
            volatility(&series).unwrap()
        };
        // Same returns at one seventh the rate: sqrt(1/7) of the figure.
        let ratio = at(7) / at(1);
        assert!((ratio - dec!(0.3779)).abs() < dec!(0.001), "{ratio}");
    }

    fn row(date: &str, total: Decimal) -> DailyValuation {
        DailyValuation {
            date: date.parse().unwrap(),
            fx_rate_to_base: Decimal::ONE,
            cash_balance: Decimal::ZERO,
            investment_market_value: total,
            total_value: total,
            cost_basis: dec!(100),
            book_basis: dec!(100),
            net_contribution: dec!(100),
            cash_balance_base: Decimal::ZERO,
            investment_market_value_base: total,
            total_value_base: total,
            cost_basis_base: dec!(100),
            book_basis_base: dec!(100),
            net_contribution_base: dec!(100),
            performance_eligible_value_base: total,
            value_status: ValueStatus::Complete,
            basis_status: BasisStatus::default(),
            flow: DailyFlow::default(),
        }
    }

    #[test]
    fn an_excluded_day_does_not_change_the_annualisation_around_it() {
        let volatility_of = |history: &[DailyValuation]| {
            let currency = Currency::parse("CAD").unwrap();
            performance_core(
                history,
                false,
                None,
                false,
                MeasureProfile::Full,
                false,
                true,
                &currency,
            )
            .risk
            .volatility
            .expect("three returns are enough for a volatility")
        };
        // 05-04 is unavailable, so the returns into and out of it are
        // dropped; +10%, -10%, -10% survive.
        let mut gapped = vec![
            row("2026-05-01", dec!(100)),
            row("2026-05-02", dec!(110)),
            row("2026-05-03", dec!(99)),
            row("2026-05-04", dec!(108.9)),
            row("2026-05-05", dec!(108.9)),
            row("2026-05-06", dec!(98.01)),
        ];
        gapped[3].value_status = ValueStatus::Unavailable;
        let contiguous = vec![
            row("2026-05-01", dec!(100)),
            row("2026-05-02", dec!(110)),
            row("2026-05-03", dec!(99)),
            row("2026-05-04", dec!(89.1)),
        ];
        let gapped_volatility = volatility_of(&gapped);
        assert!(gapped_volatility > Decimal::ZERO);
        // Annualising by the span between the first and last surviving dates
        // would scale the gapped series by sqrt(1/2) of this.
        assert_eq!(gapped_volatility, volatility_of(&contiguous));
    }

    #[test]
    fn annualisation_overflow_is_not_applicable_instead_of_a_panic() {
        let start = NaiveDate::from_ymd_opt(2025, 1, 2).unwrap();
        let end = NaiveDate::from_ymd_opt(2025, 2, 2).unwrap();
        // 2,499x in 31 days: (2500)^(365.25/31) exceeds Decimal's range.
        assert_eq!(annualized_return(start, end, dec!(2499)), None);
        assert_eq!(annualize(start, end, Some(dec!(2499))), None);
        // A 1e10 annualised rate compounded over ten years overflows too.
        let decade_start = NaiveDate::from_ymd_opt(2015, 1, 2).unwrap();
        assert_eq!(
            period_return_from_annualized(decade_start, end, dec!(1e10)),
            None
        );
        // Ordinary returns are unaffected.
        let ordinary = annualized_return(start, end, dec!(0.05)).unwrap();
        assert!(ordinary > dec!(0.7) && ordinary < dec!(0.8), "{ordinary}");
    }

    /// Three days where the second has a 2.50 outflow stamped with `source`
    /// and the net contribution drops by 2.50.
    fn with_stamped_outflow(source: FlowSource) -> PerformanceResult {
        let mut history = vec![
            row("2026-05-01", dec!(100)),
            row("2026-05-02", dec!(97.5)),
            row("2026-05-03", dec!(99)),
        ];
        history[1].net_contribution_base = dec!(97.5);
        history[2].net_contribution_base = dec!(97.5);
        history[1].flow = DailyFlow {
            inflow_base: Decimal::ZERO,
            outflow_base: if source == FlowSource::NoFlow {
                Decimal::ZERO
            } else {
                dec!(2.5)
            },
            source,
        };
        let currency = Currency::parse("CAD").unwrap();
        performance_core(
            &history,
            false,
            None,
            false,
            MeasureProfile::Full,
            false,
            true,
            &currency,
        )
    }

    #[test]
    fn a_stamped_inferred_flow_counts_as_stamped_and_reports_the_inference() {
        let inferred = with_stamped_outflow(FlowSource::NetContributionFallback);
        let exact = with_stamped_outflow(FlowSource::CashAmount);
        assert_eq!(inferred.returns, exact.returns);
        assert!(inferred.returns.twr.is_some());
        for note in [
            QualityNote::NetContributionFlows,
            QualityNote::DegradedFlowProvenance,
        ] {
            assert!(inferred.data_quality.warnings.contains(&note), "{note:?}");
            assert!(!exact.data_quality.warnings.contains(&note), "{note:?}");
        }
    }

    #[test]
    fn measure_infers_no_flow_the_value_stage_did_not_stamp() {
        // The net contribution drops by 2.50 but no flow was stamped: the
        // drop is a loss, not an outflow measure reconstructs.
        let unstamped = with_stamped_outflow(FlowSource::NoFlow);
        let stamped = with_stamped_outflow(FlowSource::CashAmount);
        assert_ne!(unstamped.returns.twr, stamped.returns.twr);
        assert!(!unstamped
            .data_quality
            .warnings
            .contains(&QualityNote::NetContributionFlows));
    }
}
