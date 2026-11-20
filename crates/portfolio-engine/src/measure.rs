//! Stage 6: performance over stored valuation rows — a port of the legacy
//! performance service (time-weighted and money-weighted returns, value
//! return, attribution, risk, holdings-mode and mixed-scope handling).
//!
//! Rows are read as storage keeps them (8 decimal places); windows select
//! rows by date. Transaction windows covering inception include the opening
//! day's attribution; later windows count from their first stored day's close.

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::NaiveDate;
use rust_decimal::prelude::{FromPrimitive, ToPrimitive};
use rust_decimal::{Decimal, MathematicalOps};
use rust_decimal_macros::dec;

use crate::arith;
use crate::error::EngineError;
use crate::model::*;
use crate::value::{aggregate_scope, has_started, Window};

const DAYS_PER_YEAR: Decimal = dec!(365.25);
/// A yearly rate needs a year of measured history: a shorter period
/// compounded to a year overstates what was earned (3% in a month reads as
/// 43% a year).
const MIN_ANNUALIZATION_DAYS: i64 = 365;
const MIN_RETURN_BASE: Decimal = Decimal::ONE;
const RESIDUAL_TOLERANCE_RATE: Decimal = dec!(0.002);

/// Inputs of the read path, all plain data: the priced events
/// (`value::effects`) plus valuation series, lots and disposals, computed or
/// stored. Measuring reads no raw facts and resolves no rates.
pub struct MeasureInputs<'a> {
    pub effects: Effects,
    /// Prepared daily cash FX by account. None means preparation was skipped
    /// for Dashboard; Some with empty daily entries means known zero FX.
    /// Attribution reads require an entry for each transaction account used.
    pub cash_fx: Option<BTreeMap<AccountId, Vec<CashFxEffect>>>,
    pub series: &'a BTreeMap<AccountId, ValuationSeries>,
    pub lots: &'a [LotRecord],
    pub disposals: &'a [LotDisposal],
}

/// Revaluation of opening cash exposure, priced before measurement. These
/// transient inputs are independent of investment and conversion execution.
#[derive(Debug, Clone, PartialEq)]
pub struct CashFxEffect {
    pub date: NaiveDate,
    /// None means exposure or its valuation rate could not be determined.
    pub amount: Option<Decimal>,
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

    /// Use the full stored history, not the first row left by the window:
    /// a dated read that covers inception has no earlier value to subtract.
    /// Holdings keep their existing snapshot-based attribution rules.
    fn attribution_baseline(
        &self,
        holdings: bool,
        start: Option<NaiveDate>,
        scope: &[AccountId],
    ) -> Baseline {
        let inception = scope
            .iter()
            .filter_map(|account| self.series.get(account)?.days.first().map(|day| day.date))
            .min();
        if !holdings && start.is_none_or(|start| inception.is_some_and(|date| start <= date)) {
            Baseline::Inception
        } else {
            Baseline::PeriodStart
        }
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

fn check_cash_fx_prepared(
    inputs: &MeasureInputs<'_>,
    scope: &[AccountId],
    window: Window,
    profile: MeasureProfile,
) -> Result<(), EngineError> {
    if profile == MeasureProfile::Dashboard {
        return Ok(());
    }
    for account in scope {
        if inputs.tracking(account) == TrackingMode::Holdings {
            continue;
        }
        let points = inputs.series.get(account).map_or(0, |series| {
            series
                .days
                .iter()
                .filter(|day| window.contains(day.date))
                .take(2)
                .count()
        });
        if points == 2
            && inputs
                .cash_fx
                .as_ref()
                .and_then(|fx| fx.get(account))
                .is_none()
        {
            return Err(EngineError::CashFxNotPrepared {
                account: account.as_str().to_string(),
            });
        }
    }
    Ok(())
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
    check_cash_fx_prepared(inputs, std::slice::from_ref(account), window, profile)?;
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
    let baseline =
        inputs.attribution_baseline(holdings, window.start, std::slice::from_ref(account));
    let mut result = performance_core(
        &history,
        holdings,
        window.start,
        baseline,
        include_series,
        profile,
        inputs.account_is_base(account),
        inputs.base(),
    );
    result.scope = account.as_str().to_string();
    result.unclassified_transfers =
        unclassified_transfers(inputs, std::slice::from_ref(account), &result);
    if profile == MeasureProfile::Dashboard {
        apply_dashboard_amount(&mut result, &history, holdings, baseline);
        return Ok(result);
    }
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
    // An account that has not started holds and moves nothing: it takes no
    // part, in the scope's mix of tracking modes either (P-IDLE).
    let started: Vec<AccountId> = scope
        .iter()
        .filter(|a| has_started(&inputs.effects, a))
        .cloned()
        .collect();
    let scope = started.as_slice();
    check_cash_fx_prepared(inputs, scope, window, profile)?;
    let has_holdings = scope
        .iter()
        .any(|a| inputs.tracking(a) == TrackingMode::Holdings);
    let has_transactions = scope
        .iter()
        .any(|a| inputs.tracking(a) != TrackingMode::Holdings);

    if has_holdings && has_transactions {
        let mut result = mixed_scope_performance(inputs, scope, window, profile, include_series);
        result.scope = scope_id.to_string();
        result.unclassified_transfers = unclassified_transfers(inputs, scope, &result);
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

    let baseline = inputs.attribution_baseline(has_holdings, window.start, scope);
    let mut result = performance_core(
        &history,
        has_holdings,
        window.start,
        baseline,
        include_series,
        profile,
        true,
        base,
    );
    result.scope = scope_id.to_string();
    result.unclassified_transfers = unclassified_transfers(inputs, scope, &result);
    if profile == MeasureProfile::Dashboard {
        apply_dashboard_amount(&mut result, &history, has_holdings, baseline);
        return Ok(result);
    }

    let unrealized = scoped_unrealized_effects(inputs, &result, scope, baseline);
    let mut seed = Seed::default();
    if unrealized.complete {
        seed.include_base_market_movement = false;
        seed.effects.extend(unrealized.effects);
    }
    seed.warnings.extend(unrealized.warnings);
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
    baseline: Baseline,
    include_series: bool,
    profile: MeasureProfile,
    account_is_base: bool,
    currency: &Currency,
) -> PerformanceResult {
    debug_assert!(history.len() >= 2);
    let start_point = &history[0];
    let end_point = &history[history.len() - 1];
    let actual_start = start_point.date;
    let actual_end = end_point.date;
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

    // A holdings scope has no transaction flows: its time-weighted return
    // for a dated window is the chained snapshot return below, and over the
    // full history it has none.
    let twr = if holdings {
        TwrComputation {
            cumulative: None,
            samples: Vec::new(),
            warnings: Vec::new(),
            reasons: if start_opt.is_none() {
                vec![QualityNote::HoldingsTwrNotApplicable]
            } else {
                Vec::new()
            },
        }
    } else {
        time_weighted_returns(history, &flows, baseline == Baseline::Inception)
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

    let holdings_return_reason = |metric: Metric| {
        if holdings_out_of_range && start_opt.is_some() {
            QualityNote::HoldingsReturnOutOfRange
        } else if holdings_flows_unavailable {
            QualityNote::FlowsNotInferred {
                metric,
                subject: Subject::HoldingsScope,
            }
        } else if coverage_unavailable {
            QualityNote::CoverageUnavailable { metric }
        } else if start_opt.is_none() {
            holdings_all_time_unavailable_reason(end_point, metric, Subject::HoldingsScope)
                .unwrap_or(QualityNote::HoldingsValueReturnUnavailable)
        } else {
            QualityNote::HoldingsNonPositiveStart
        }
    };
    let method = if holdings {
        ReturnMethod::ValueReturn
    } else {
        ReturnMethod::TimeWeighted
    };
    // Holdings scopes: the chained snapshot return is the time-weighted
    // return of a dated window. Over the full history they report gain on
    // book cost instead, which keeps gains made before the first snapshot.
    let (twr_period, twr_reason) = if !holdings {
        let reason = twr
            .cumulative
            .is_none()
            .then(|| twr.reasons.first().cloned())
            .flatten();
        (twr.cumulative, reason)
    } else if start_opt.is_none() {
        (None, Some(QualityNote::HoldingsTwrNotApplicable))
    } else {
        // The chained return ends on the last snapshot's value: an
        // unvalued endpoint leaves it as unknown as the other returns.
        let ret = if holdings_flows_unavailable || coverage_unavailable {
            None
        } else {
            holdings_chained
        };
        (
            ret,
            ret.is_none().then(|| holdings_return_reason(Metric::Twr)),
        )
    };
    let (return_on_cost, return_on_cost_reason) = match holdings_value_return {
        Some((_, all_time_return)) if start_opt.is_none() => (
            all_time_return,
            all_time_return
                .is_none()
                .then(|| holdings_return_reason(Metric::ReturnOnCost)),
        ),
        _ => (None, Some(QualityNote::ReturnOnCostNotApplicable)),
    };
    // A holdings scope has no recorded deposits or withdrawals to weigh: the
    // flows between its snapshots are inferred, in amount and in date.
    let money_weighted = if holdings {
        MoneyWeighted::unavailable(QualityNote::HoldingsMoneyWeightedNotApplicable)
    } else if coverage_unavailable {
        MoneyWeighted::unavailable(QualityNote::CoverageUnavailable {
            metric: Metric::MoneyWeighted,
        })
    } else {
        money_weighted_return(
            history,
            &flows,
            include_series,
            Opening::for_baseline(holdings, baseline),
        )
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
            let (unrealized_change, fx_effect) =
                unrealized_components(start_point, end_point, baseline, account_is_base);
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
    let mut reasons = twr.reasons;
    if holdings {
        reasons.extend(twr_reason.clone().filter(|_| start_opt.is_some()));
        reasons.extend(
            return_on_cost_reason
                .clone()
                .filter(|_| start_opt.is_none()),
        );
    }
    reasons.extend(money_weighted.reason.clone());
    reasons.extend(holdings_pnl_reason);
    if coverage_unavailable {
        reasons.push(QualityNote::CoverageUnavailable {
            metric: Metric::Pnl,
        });
    }
    let mut data_quality = data_quality(warnings, reasons, false);
    if !holdings && profile != MeasureProfile::Dashboard {
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
            twr: ReturnView {
                period: twr_period.map(|v| v.round_dp(STORED_PRECISION)),
                annualized: if full {
                    annualize(actual_start, actual_end, twr_period)
                } else {
                    None
                },
                series: if twr_period.is_some() {
                    series
                } else {
                    Vec::new()
                },
                unavailable_reason: twr_reason,
            },
            money_weighted: ReturnView {
                period: money_weighted.period.map(|v| v.round_dp(STORED_PRECISION)),
                // The same rate over a year, counted from the day the
                // measurement opens, so the two never disagree.
                annualized: if full {
                    annualize(
                        money_weighted.start.unwrap_or(actual_start),
                        actual_end,
                        money_weighted.period,
                    )
                } else {
                    None
                },
                series: money_weighted.series,
                unavailable_reason: money_weighted.reason,
            },
            return_on_cost: ReturnView {
                period: return_on_cost.map(|v| v.round_dp(STORED_PRECISION)),
                // How long the positions were held is not known: no yearly rate.
                annualized: None,
                series: if include_series && return_on_cost.is_some() {
                    return_on_cost_series(history)
                } else {
                    Vec::new()
                },
                unavailable_reason: return_on_cost_reason,
            },
        },
        attribution,
        risk,
        data_quality,
        holdings,
        false,
    );
    result.coverage_unavailable = coverage_unavailable;
    result.amounts = period_amounts(
        start_point,
        end_point,
        &flows,
        holdings,
        start_opt.is_none(),
        baseline,
    );
    if holdings {
        result.basis_status = end_point.basis_status;
        result.holdings_flows_unavailable = holdings_flows_unavailable;
        // An incomplete book cost hides the gain amount: say why, rather than
        // leaving the amount unavailable without a reason.
        let basis_incomplete = matches!(
            result.basis_status,
            BasisStatus::Unknown | BasisStatus::PartialUnknown
        );
        let explained = result
            .data_quality
            .not_applicable_reasons
            .iter()
            .any(|note| {
                matches!(
                    note,
                    QualityNote::IncompleteBookBasis {
                        metric: Metric::Pnl,
                        ..
                    } | QualityNote::NonPositiveBookBasis {
                        metric: Metric::Pnl,
                        ..
                    }
                )
            });
        if basis_incomplete && !explained {
            result
                .data_quality
                .not_applicable_reasons
                .push(QualityNote::IncompleteBookBasis {
                    metric: Metric::Pnl,
                    subject: Subject::HoldingsScope,
                });
            refresh_quality_status(&mut result.data_quality);
        }
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

/// `from_inception`: the period starts when the scope does, so the chain
/// waits for money to come in; a later period starts already funded.
fn time_weighted_returns(
    history: &[DailyValuation],
    flows: &[PeriodFlow],
    from_inception: bool,
) -> TwrComputation {
    let mut factor = Decimal::ONE;
    let mut samples = Vec::new();
    let mut warnings = Vec::new();
    let mut reasons = Vec::new();
    let mut chain_started = false;
    let mut warned_partial = false;
    // Money has come in: a contribution (in either currency: a conversion can
    // round the base amount away), or any inflow such as a transfer from
    // another account, from the first close on.
    let contributed = |day: &DailyValuation| {
        day.net_contribution_base > Decimal::ZERO || day.net_contribution > Decimal::ZERO
    };
    let mut funded = !from_inception
        || history
            .first()
            .is_some_and(|first| contributed(first) || first.flow.inflow_base > Decimal::ZERO);

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
        // The chain starts once money has come in: closes funded only by
        // income before the first deposit are too small a base to compound
        // (a few dollars of dividends would multiply into thousands of percent).
        funded |= contributed(prev) || flow.inflow > Decimal::ZERO;
        if !chain_started && (prev_value <= Decimal::ZERO || benign_low_base || !funded) {
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

/// Money-weighted return over a history: the internal rate of return, the
/// one rate at which the opening capital and every deposit, less every
/// withdrawal, grow to the closing value. It is reported for the period; the
/// yearly rate is the same rate over a year. A deposit counts from the
/// previous close, as the time-weighted step does (`prev + inflow` is its
/// base); a withdrawal counts until the close of the day it leaves.
struct MoneyWeighted {
    /// The day the measurement opens, after any rebase: the yearly rate
    /// counts from it.
    start: Option<NaiveDate>,
    period: Option<Decimal>,
    reason: Option<QualityNote>,
    series: Vec<SeriesPoint>,
}

/// Gain and average capital invested at a close (Modified Dietz). A mixed
/// scope sums them across its accounts for its ROI, and the money-weighted
/// solve starts from their ratio.
#[derive(Debug, Clone, Copy)]
struct DietzPoint {
    date: NaiveDate,
    gain: Decimal,
    capital: Decimal,
}

impl MoneyWeighted {
    fn unavailable(reason: QualityNote) -> Self {
        Self {
            start: None,
            period: None,
            reason: Some(reason),
            series: Vec::new(),
        }
    }
}

/// One dated amount of the money-weighted equation: the days since the
/// period opened, and the money put in (positive) or taken out (negative).
#[derive(Debug, Clone, Copy)]
struct CashTerm {
    day: f64,
    amount: f64,
}

/// The largest growth the solve considers, as `ln(1 + return)`: beyond it
/// the terms no longer fit a float.
const MAX_LOG_GROWTH: f64 = 600.0;

/// The return over a period of `period_days` at which `terms` grow to
/// `end_value`: each amount compounds for the share of the period it was
/// invested. Solved in `ln(1 + return)`, where every real number is a valid
/// return, by Newton's method from `seed`, and by bisection when a step
/// cannot be taken. The same inputs always give the same return.
fn solve_period_return(
    terms: &[CashTerm],
    period_days: f64,
    end_value: f64,
    seed: f64,
) -> Result<f64, QualityNote> {
    if !terms.iter().any(|term| term.amount > 0.0) {
        return Err(QualityNote::MoneyWeightedNoCapital);
    }
    if period_days <= 0.0 {
        return Ok(0.0);
    }
    // Nothing is left and nothing was taken out: all of it was lost.
    if end_value <= 0.0 && terms.iter().all(|term| term.amount >= 0.0) {
        return if end_value == 0.0 {
            Ok(-1.0)
        } else {
            Err(QualityNote::MoneyWeightedNoSolution)
        };
    }
    let scale = terms
        .iter()
        .map(|term| term.amount.abs())
        .sum::<f64>()
        .max(end_value.abs());
    // What the terms have grown to, less the end value, and how fast that
    // changes with the growth: one pass over the terms for both.
    let evaluate = |log_growth: f64| -> (f64, f64) {
        let (mut value, mut slope) = (-end_value, 0.0);
        for term in terms {
            let share = ((period_days - term.day) / period_days).clamp(0.0, 1.0);
            let grown = term.amount * (log_growth * share).exp();
            value += grown;
            slope += grown * share;
        }
        (value, slope)
    };
    let solved = |log_growth: f64| -> Result<f64, QualityNote> {
        let period_return = log_growth.exp_m1();
        if period_return.is_finite() {
            Ok(period_return)
        } else {
            Err(QualityNote::MoneyWeightedOutOfRange)
        }
    };

    let mut log_growth = if seed > -1.0 && seed.is_finite() {
        seed.ln_1p().clamp(-MAX_LOG_GROWTH, MAX_LOG_GROWTH)
    } else {
        0.0
    };
    let (mut value, mut slope) = evaluate(log_growth);
    for _ in 0..64 {
        if !value.is_finite() || !slope.is_finite() || slope <= 0.0 {
            break;
        }
        let step = value / slope;
        let next = log_growth - step;
        if !next.is_finite() || next.abs() > MAX_LOG_GROWTH {
            break;
        }
        log_growth = next;
        (value, slope) = evaluate(log_growth);
        if step.abs() <= 1e-13 * log_growth.abs().max(1.0) {
            if value.abs() <= 1e-9 * scale {
                return solved(log_growth);
            }
            break;
        }
    }

    // Newton could not finish (a flat or falling stretch, or a jump out of
    // range): bracket a crossing from below to above and halve it.
    let residual = |log_growth: f64| evaluate(log_growth).0;
    let (mut low, mut high) = (-1.0_f64, 1.0_f64);
    while residual(high) < 0.0 && high < MAX_LOG_GROWTH {
        high = (high * 2.0).min(MAX_LOG_GROWTH);
    }
    while residual(low) > 0.0 && low > -MAX_LOG_GROWTH {
        low = (low * 2.0).max(-MAX_LOG_GROWTH);
    }
    let (at_low, at_high) = (residual(low), residual(high));
    if !at_low.is_finite() || !at_high.is_finite() || at_low > 0.0 || at_high < 0.0 {
        return Err(QualityNote::MoneyWeightedNoSolution);
    }
    for _ in 0..200 {
        let middle = (low + high) / 2.0;
        if residual(middle) < 0.0 {
            low = middle;
        } else {
            high = middle;
        }
    }
    solved((low + high) / 2.0)
}

/// What the first close of a money-weighted period opens with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Opening {
    /// The period starts after inception: the opening close is the capital
    /// already invested.
    Close,
    /// The period starts at inception: the capital is the money contributed
    /// by the first close, so the first day's gain counts.
    Contribution,
}

impl Opening {
    /// Every profile counts the first day's gain from inception, so the
    /// Dashboard and the account page report the same return and amount.
    fn for_baseline(holdings: bool, baseline: Baseline) -> Self {
        if !holdings && baseline == Baseline::Inception {
            Self::Contribution
        } else {
            Self::Close
        }
    }
}

/// Index of the close a money-weighted period opens on: a period opening on
/// a negative close (pre-funding history) starts from the first close with
/// at least one base unit; opening with the contribution needs no rebase.
/// `None` when no close qualifies.
fn opening_index(history: &[DailyValuation], opening: Opening) -> Option<usize> {
    match history.first() {
        Some(first) if opening == Opening::Close && first.total_value_base.is_sign_negative() => {
            history
                .iter()
                .position(|d| d.total_value_base >= MIN_RETURN_BASE)
        }
        Some(_) => Some(0),
        None => None,
    }
}

/// Gain and average capital at each close (the first one only when the
/// period opens with a contribution). `known_only` counts a flow only when
/// its amount is known (holdings snapshots); otherwise any flow without a
/// known amount makes the return unavailable.
fn dietz_points(
    history: &[DailyValuation],
    flows: &[PeriodFlow],
    known_only: bool,
    opening: Opening,
) -> Result<Vec<DietzPoint>, QualityNote> {
    if history.len() < 2 {
        return Err(QualityNote::TwoValuationPointsRequired);
    }
    if !known_only && flows.iter().any(|f| f.source.is_unavailable_for_returns()) {
        return Err(QualityNote::MoneyWeightedUnknownFlow);
    }
    let start_index = opening_index(history, opening).ok_or(QualityNote::MoneyWeightedNoCapital)?;
    let scoped = &history[start_index..];
    let scoped_flows = &flows[start_index..];
    let first = &scoped[0];
    let opening_value = match opening {
        Opening::Close => first.total_value_base,
        Opening::Contribution => first.net_contribution_base,
    };
    let days_since = |date: NaiveDate| Decimal::from((date - first.date).num_days());

    let mut inflows = Decimal::ZERO;
    let mut inflow_days = Decimal::ZERO;
    let mut outflows = Decimal::ZERO;
    let mut outflow_days = Decimal::ZERO;
    let mut points = Vec::with_capacity(scoped.len());
    if opening == Opening::Contribution {
        points.push(DietzPoint {
            date: first.date,
            gain: first.total_value_base - opening_value,
            capital: opening_value,
        });
    }
    for (pair, flow) in scoped.windows(2).zip(scoped_flows) {
        let (prev, curr) = (&pair[0], &pair[1]);
        let (inflow, outflow) = if !known_only || flow.source.has_known_amount() {
            (flow.inflow, flow.outflow)
        } else {
            (Decimal::ZERO, Decimal::ZERO)
        };
        inflows += inflow;
        outflows += outflow;
        inflow_days += arith::mul(inflow, days_since(prev.date))
            .ok_or(QualityNote::MoneyWeightedOutOfRange)?;
        outflow_days += arith::mul(outflow, days_since(curr.date))
            .ok_or(QualityNote::MoneyWeightedOutOfRange)?;
        let elapsed = days_since(curr.date);
        let weighted = arith::mul(inflows - outflows, elapsed)
            .ok_or(QualityNote::MoneyWeightedOutOfRange)?
            - inflow_days
            + outflow_days;
        let capital = opening_value
            + arith::div(weighted, elapsed).ok_or(QualityNote::MoneyWeightedOutOfRange)?;
        points.push(DietzPoint {
            date: curr.date,
            gain: curr.total_value_base - opening_value - (inflows - outflows),
            capital,
        });
    }
    Ok(points)
}

fn dietz_return(point: &DietzPoint) -> Result<Decimal, QualityNote> {
    if point.capital < MIN_RETURN_BASE {
        return Err(QualityNote::MoneyWeightedNoCapital);
    }
    arith::div(point.gain, point.capital).ok_or(QualityNote::MoneyWeightedOutOfRange)
}

fn money_weighted_return(
    history: &[DailyValuation],
    flows: &[PeriodFlow],
    include_series: bool,
    opening: Opening,
) -> MoneyWeighted {
    // The Dietz points carry the checks on the flows and the opening, and
    // each one's gain over capital is where its close's solve starts.
    let points = match dietz_points(history, flows, false, opening) {
        Ok(points) => points,
        Err(reason) => return MoneyWeighted::unavailable(reason),
    };
    if points.is_empty() {
        return MoneyWeighted::unavailable(QualityNote::TwoValuationPointsRequired);
    }
    let Some(start_index) = opening_index(history, opening) else {
        return MoneyWeighted::unavailable(QualityNote::MoneyWeightedNoCapital);
    };
    let scoped = &history[start_index..];
    let scoped_flows = &flows[start_index..];
    let first = &scoped[0];
    // Money contributed on the first day was invested for that day, as a
    // later deposit is from the close before it: the period opens a day
    // before the first close. A period opening on a close starts there.
    let (origin, opening_capital) = match opening {
        Opening::Close => (first.date, first.total_value_base),
        Opening::Contribution => (
            first.date.pred_opt().unwrap_or(first.date),
            first.net_contribution_base,
        ),
    };
    let day_of = |date: NaiveDate| (date - origin).num_days() as f64;
    let seeds: HashMap<NaiveDate, f64> = points
        .iter()
        .filter_map(|point| Some((point.date, dietz_return(point).ok()?.to_f64()?)))
        .collect();
    let seed_at = |date: NaiveDate| seeds.get(&date).copied().unwrap_or(0.0);
    let solve_at = |terms: &[CashTerm], close: &DailyValuation| -> Result<Decimal, QualityNote> {
        let end_value = close
            .total_value_base
            .to_f64()
            .ok_or(QualityNote::MoneyWeightedOutOfRange)?;
        let period_return =
            solve_period_return(terms, day_of(close.date), end_value, seed_at(close.date))?;
        Decimal::from_f64(period_return).ok_or(QualityNote::MoneyWeightedOutOfRange)
    };

    let mut terms = Vec::with_capacity(scoped.len());
    let push = |terms: &mut Vec<CashTerm>, day: f64, amount: Decimal| {
        if let Some(amount) = amount.to_f64().filter(|amount| *amount != 0.0) {
            terms.push(CashTerm { day, amount });
        }
    };
    push(&mut terms, 0.0, opening_capital);

    // One point per close, so the curve lines up with the time-weighted
    // one. A close before any capital is invested holds the last value; a
    // close the solve cannot answer has no point.
    let mut series = Vec::new();
    let mut current = Decimal::ZERO;
    let mut plot =
        |series: &mut Vec<SeriesPoint>, date: NaiveDate, solved: &Result<Decimal, QualityNote>| {
            if !include_series {
                return;
            }
            match solved {
                Ok(value) => current = value.round_dp(STORED_PRECISION),
                Err(QualityNote::MoneyWeightedNoCapital) => {}
                Err(_) => return,
            }
            series.push(SeriesPoint {
                date,
                value: current,
            });
        };
    for day in &history[..start_index] {
        plot(
            &mut series,
            day.date,
            &Err(QualityNote::MoneyWeightedNoCapital),
        );
    }
    let mut last = match opening {
        Opening::Close => Ok(Decimal::ZERO),
        Opening::Contribution => solve_at(&terms, first),
    };
    plot(&mut series, first.date, &last);
    for (pair, flow) in scoped.windows(2).zip(scoped_flows) {
        let (prev, curr) = (&pair[0], &pair[1]);
        push(&mut terms, day_of(prev.date), flow.inflow);
        push(&mut terms, day_of(curr.date), -flow.outflow);
        let is_last = curr.date == scoped[scoped.len() - 1].date;
        if include_series || is_last {
            last = solve_at(&terms, curr);
            plot(&mut series, curr.date, &last);
        }
    }

    let (period, reason) = match last {
        Ok(value) => (Some(value), None),
        Err(reason) => (None, Some(reason)),
    };
    MoneyWeighted {
        start: Some(origin),
        period,
        reason,
        series: if period.is_some() { series } else { Vec::new() },
    }
}

fn simple_value_return_amount(history: &[DailyValuation], flows: &[PeriodFlow]) -> Option<Decimal> {
    let start = history.first()?;
    let end = history.last()?;
    let net: Decimal = flows.iter().map(|f| f.net()).sum();
    Some(end.total_value_base - start.total_value_base - net)
}

/// Legacy dashboard profile: the headline is the exact value change net of
/// external flows, with no attribution (holdings scopes already carry it).
/// The Dashboard's gain amount: the value change net of flows, measured from
/// the money contributed by the first close when the period starts at
/// inception, as its money-weighted return is.
fn apply_dashboard_amount(
    result: &mut PerformanceResult,
    history: &[DailyValuation],
    holdings: bool,
    baseline: Baseline,
) {
    if result.coverage_unavailable {
        gate_breakdown(result);
    } else if !holdings {
        let flows = period_flows(history);
        let opening_gain = match (Opening::for_baseline(holdings, baseline), history.first()) {
            (Opening::Contribution, Some(first)) => {
                first.total_value_base - first.net_contribution_base
            }
            _ => Decimal::ZERO,
        };
        result.attribution = Attribution {
            unrealized_pnl_change: (simple_value_return_amount(history, &flows)
                .unwrap_or(Decimal::ZERO)
                + opening_gain)
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

/// Gain over book cost at each close, for a holdings account over its full
/// history; a close without a complete book cost holds the previous value.
/// The last point is the period's return on cost.
fn return_on_cost_series(history: &[DailyValuation]) -> Vec<SeriesPoint> {
    let mut current = Decimal::ZERO;
    history
        .iter()
        .map(|day| {
            if holdings_basis_is_complete(day) && day.book_basis_base >= MIN_RETURN_BASE {
                if let Some(value) = arith::div(
                    day.total_value_base - day.book_basis_base,
                    day.book_basis_base,
                ) {
                    current = value.round_dp(STORED_PRECISION);
                }
            }
            SeriesPoint {
                date: day.date,
                value: current,
            }
        })
        .collect()
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

/// The amounts behind a period's return, from the same rows and flows the
/// percentages use: what the scope opened with, what went in and out, what
/// it closed with, and the gain left once the flows are taken out.
fn period_amounts(
    start: &DailyValuation,
    end: &DailyValuation,
    flows: &[PeriodFlow],
    holdings: bool,
    is_all_time: bool,
    baseline: Baseline,
) -> Amounts {
    let valued = |day: &DailyValuation| !day.value_status.is_unavailable_for_returns();
    let stored = |value: Decimal| value.round_dp(STORED_PRECISION);
    let end_value = valued(end).then_some(end.total_value_base);
    // Over its full history a holdings account has no opening value and no
    // dated flows: its gain is measured on what its positions cost.
    if holdings && is_all_time {
        let capital = Some(end.book_basis_base)
            .filter(|book| *book > Decimal::ZERO && holdings_basis_is_complete(end));
        return Amounts {
            gain: end_value
                .zip(capital)
                .map(|(value, book)| stored(value - book)),
            end_value: end_value.map(stored),
            capital: capital.map(stored),
            flows: FlowKnowledge::Inferred,
            ..Amounts::default()
        };
    }
    let opens_at_inception = Opening::for_baseline(holdings, baseline) == Opening::Contribution;
    let start_value = if opens_at_inception {
        Some(Decimal::ZERO)
    } else {
        valued(start).then_some(start.total_value_base)
    };
    let knowledge = if flows.iter().any(|f| f.source.is_unavailable_for_returns()) {
        FlowKnowledge::Missing
    } else if holdings || flows.iter().any(|f| f.source.is_degraded()) {
        FlowKnowledge::Inferred
    } else {
        FlowKnowledge::Confirmed
    };
    let (money_in, money_out) = if knowledge == FlowKnowledge::Missing {
        (None, None)
    } else if holdings {
        let (money_in, money_out) = total_flows(flows);
        (Some(money_in), Some(money_out))
    } else {
        let (money_in, money_out) = flows_for_attribution(flows, start, baseline);
        (Some(money_in), Some(money_out))
    };
    let gain = match (start_value, money_in, money_out, end_value) {
        (Some(start), Some(money_in), Some(money_out), Some(end)) => {
            Some(end - start - money_in + money_out)
        }
        _ => None,
    };
    Amounts {
        start_value: start_value.map(stored),
        money_in: money_in.map(stored),
        money_out: money_out.map(stored),
        gain: gain.map(stored),
        end_value: end_value.map(stored),
        capital: None,
        flows: knowledge,
        parts: Vec::new(),
    }
}

/// The transfers of `scope` inside the measured period that are neither
/// matched nor marked external, oldest first. The first row of a period only
/// opens it, so a transfer on that day is outside.
fn unclassified_transfers(
    inputs: &MeasureInputs<'_>,
    scope: &[AccountId],
    result: &PerformanceResult,
) -> Vec<UnclassifiedTransfer> {
    let (Some(start), Some(end)) = (result.period_start, result.period_end) else {
        return Vec::new();
    };
    let mut transfers: Vec<UnclassifiedTransfer> = inputs
        .effects
        .events
        .iter()
        .filter(|event| event.date > start && event.date <= end && scope.contains(&event.account))
        .filter_map(|event| {
            let flow = event.flow.as_ref()?;
            (flow.source == FlowSource::UnknownBoundaryTransfer).then(|| UnclassifiedTransfer {
                activity: event.source.clone(),
                account: event.account.clone(),
                date: event.date,
                amount: flow.unclassified,
                currency: event.currency.clone(),
                outflow: flow.leg_outflow,
            })
        })
        .collect();
    transfers.sort_by(|a, b| (a.date, &a.activity).cmp(&(b.date, &b.activity)));
    transfers.dedup_by(|a, b| a.activity == b.activity);
    transfers
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
            ..Summary::default()
        },
        is_holdings_mode,
        is_mixed_tracking_mode,
        amounts: Amounts::default(),
        unclassified_transfers: Vec::new(),
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

/// Clears the returns a gated scope cannot support, each with the reason
/// that applies to it.
fn gate_returns(result: &mut PerformanceResult) {
    let gate = |view: &mut ReturnView, reason: QualityNote| {
        if view.period.is_some() || view.unavailable_reason.is_none() {
            *view = ReturnView::unavailable(reason);
        }
    };
    let returns = &mut result.returns;
    if result.coverage_unavailable {
        gate(
            &mut returns.money_weighted,
            QualityNote::CoverageUnavailable {
                metric: Metric::MoneyWeighted,
            },
        );
        gate(
            &mut returns.return_on_cost,
            QualityNote::CoverageUnavailable {
                metric: Metric::ReturnOnCost,
            },
        );
        // The transaction TWR excludes unvalued days itself; the chained
        // holdings return ends on the unvalued snapshot.
        if result.is_holdings_mode {
            gate(
                &mut returns.twr,
                QualityNote::CoverageUnavailable {
                    metric: Metric::Twr,
                },
            );
        }
    }
    if result.holdings_flows_unavailable {
        for (view, metric) in [
            (&mut returns.twr, Metric::Twr),
            (&mut returns.money_weighted, Metric::MoneyWeighted),
            (&mut returns.return_on_cost, Metric::ReturnOnCost),
        ] {
            gate(
                view,
                QualityNote::FlowsNotInferred {
                    metric,
                    subject: Subject::HoldingsScope,
                },
            );
        }
    }
    if result.is_holdings_mode
        && matches!(
            result.basis_status,
            BasisStatus::Unknown | BasisStatus::PartialUnknown
        )
    {
        gate(
            &mut returns.return_on_cost,
            QualityNote::IncompleteBookBasis {
                metric: Metric::ReturnOnCost,
                subject: Subject::HoldingsScope,
            },
        );
    }
}

fn refresh_summary(result: &mut PerformanceResult) {
    let mut amount_available = result.summary.amount_status == SummaryStatus::Complete;
    if summary_gated(result) {
        amount_available = false;
        gate_returns(result);
    }
    let reasons: Vec<QualityNote> = result
        .data_quality
        .warnings
        .iter()
        .chain(result.data_quality.not_applicable_reasons.iter())
        .cloned()
        .collect();
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
    result.summary = Summary {
        amount,
        basis,
        quality: result.data_quality.status,
        amount_status: if amount.is_some() {
            SummaryStatus::Complete
        } else {
            SummaryStatus::Unavailable
        },
        basis_status: result.basis_status,
        reasons,
    };
}

fn unavailable_returns(reason: &QualityNote) -> Returns {
    Returns {
        twr: ReturnView::unavailable(reason.clone()),
        money_weighted: ReturnView::unavailable(reason.clone()),
        return_on_cost: ReturnView::unavailable(reason.clone()),
    }
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
        unavailable_returns(&reason),
        Attribution::default(),
        Risk::default(),
        DataQuality {
            status: QualityStatus::NoData,
            warnings: Vec::new(),
            not_applicable_reasons: vec![reason],
        },
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
        unavailable_returns(&QualityNote::ScopeMetricsUnavailable),
        Attribution::default(),
        Risk::default(),
        DataQuality {
            status: QualityStatus::Partial,
            warnings: vec![warning],
            not_applicable_reasons: vec![QualityNote::ScopeMetricsUnavailable],
        },
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

    // Cash revaluation survives a scoped investment seed replacing the base
    // market movement. Conversions' execution differences are separate from
    // holding FX and count once, including same-account pairs on direct reads.
    let cash_fx = cash_fx_attribution(inputs, result, scope);
    effects.extend(cash_fx.effects);
    warnings.extend(cash_fx.warnings);
    let transfers = transfer_pair_effects(inputs, result, scope, baseline);
    effects.extend(transfers.effects);
    warnings.extend(transfers.warnings);

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

fn cash_fx_attribution(
    inputs: &MeasureInputs<'_>,
    result: &PerformanceResult,
    scope: &[AccountId],
) -> EffectSet {
    let (Some(start), Some(end)) = (result.period_start, result.period_end) else {
        return EffectSet::default();
    };
    let mut set = EffectSet::default();
    let mut total = Decimal::ZERO;
    // Keep known daily FX when another day is unavailable. The warning marks
    // the result Partial; completeness is not used to substitute a fallback
    // here, unlike the scoped investment seed.
    for account in scope {
        let mut warned = false;
        for day in inputs
            .cash_fx
            .as_ref()
            .and_then(|fx| fx.get(account))
            .into_iter()
            .flatten()
            .filter(|day| day.date > start && day.date <= end)
        {
            match day.amount {
                Some(amount) => total += amount,
                None if !warned => {
                    set.warnings.push(QualityNote::CashFxUnavailable {
                        account: account.as_str().to_string(),
                        date: day.date,
                    });
                    warned = true;
                }
                None => {}
            }
        }
    }
    if !total.is_zero() {
        set.effects.push(Effect {
            fx_effect: total,
            ..Effect::default()
        });
    }
    set
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

/// Disposals of the period whose disposing event realizes (a trade, an
/// option's expiry, units a transfer delivered into a short, or a return of
/// capital, rules R7.4) and is dated inside the period. The previous
/// calculator kept trades only, which left out the P&L of an expiry or a
/// transfer cover.
fn period_disposals<'a>(
    inputs: &'a MeasureInputs<'a>,
    result: &PerformanceResult,
    scope: &[AccountId],
    baseline: Baseline,
) -> Vec<&'a LotDisposal> {
    let Some(period) = Period::of(result, baseline) else {
        return Vec::new();
    };
    let realizing: HashSet<&str> = inputs
        .effects
        .events
        .iter()
        .filter(|e| e.realizes && scope.contains(&e.account) && period.contains(e.date))
        .map(|e| e.id.as_str())
        .collect();
    inputs
        .disposals
        .iter()
        .filter(|d| scope.contains(&d.account) && period.contains(d.date))
        .filter(|d| realizing.contains(d.event.as_str()))
        .collect()
}

fn realized_effects(inputs: &MeasureInputs<'_>, disposals: &[&LotDisposal]) -> EffectSet {
    let base = inputs.base().as_str();
    // Adjustments can legitimately exhaust foreign book cost while local
    // cost remains. The lot's acquisition FX distinguishes that known zero
    // from a disposal whose original basis never converted.
    let known_acquisition: HashSet<_> = inputs
        .lots
        .iter()
        .filter(|lot| lot.fx_rate_to_base > Decimal::ZERO)
        .map(|lot| (&lot.account, lot.id.as_str()))
        .collect();
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
            && ((disposal.cost_basis_base.is_zero()
                && !known_acquisition.contains(&(&disposal.account, disposal.lot_id.as_str())))
                || (!disposal.cost_basis_base.is_zero() && sign_mismatch))
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

    // A lot a transfer moved within the scope keeps the purchase charges it
    // was bought with (its original date and allocation): they were counted
    // where they were paid, so the lot gives them back like the lot its
    // purchase opened (rules R3.5).
    let moved_pairs: Vec<&PairEffect> = inputs
        .effects
        .pairs
        .iter()
        .filter(|pair| {
            pair.security && scope.contains(&pair.in_account) && scope.contains(&pair.out_account)
        })
        .collect();
    let moved_in: HashSet<&str> = moved_pairs
        .iter()
        .map(|pair| pair.transfer_in.as_str())
        .collect();
    let charged = |lot: &LotRecord| {
        lot.open_activity.as_ref().is_some_and(|activity| {
            charge_by_activity.contains_key(activity.as_str())
                || moved_in.contains(activity.as_str())
        }) && period.contains(lot.open_date)
    };
    // The share of a lot's charges `units` of it carry.
    let charge_share = |lot: &LotRecord, units: Decimal, cost_base: Decimal| {
        let charge = lot.fee_allocated_base + lot.tax_allocated_base;
        let original_quantity = lot.original_quantity.abs();
        if original_quantity > Decimal::ZERO {
            arith::proportional(charge, units.abs(), original_quantity).unwrap_or(Decimal::ZERO)
        } else if lot.original_cost_basis_base.abs() > Decimal::ZERO {
            arith::proportional(charge, cost_base.abs(), lot.original_cost_basis_base.abs())
                .unwrap_or(Decimal::ZERO)
        } else {
            Decimal::ZERO
        }
    };

    let mut period_open_charge_by_activity: HashMap<&str, Decimal> = HashMap::new();
    let mut saw_period_open_lots = false;
    let mut remaining_open_from_lots = Decimal::ZERO;
    for lot in lots.iter().copied() {
        let Some(open_activity) = lot.open_activity.as_ref() else {
            continue;
        };
        if !charged(lot) {
            continue;
        }
        let moved = moved_in.contains(open_activity.as_str());
        if !moved {
            saw_period_open_lots = true;
        }
        let full_charge = lot.fee_allocated_base + lot.tax_allocated_base;
        if full_charge.is_zero() {
            continue;
        }
        // A moved lot's charges were counted at the lot its purchase opened.
        if !moved {
            *period_open_charge_by_activity
                .entry(open_activity.as_str())
                .or_default() += full_charge;
        }
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
        if charged(lot) {
            acquisition_charges_disposed +=
                charge_share(lot, disposal.quantity, disposal.cost_basis_base);
        }
    }
    // Charges a moved lot carried into a cover leave no lot behind: they are
    // what the transfer out took from charged lots less what its lots opened
    // with on arrival.
    for pair in &moved_pairs {
        let sent: Decimal = inputs
            .disposals
            .iter()
            .filter(|d| {
                d.account == pair.out_account
                    && d.event.as_str() == pair.transfer_out.as_str()
                    && period.contains(d.date)
            })
            .filter_map(|d| {
                let lot = lot_by_id.get(&(&d.account, d.lot_id.as_str()))?;
                charged(lot).then(|| charge_share(lot, d.quantity, d.cost_basis_base))
            })
            .sum();
        let arrived: Decimal = lots
            .iter()
            .filter(|lot| {
                lot.open_activity
                    .as_ref()
                    .is_some_and(|activity| activity.as_str() == pair.transfer_in.as_str())
                    && period.contains(lot.open_date)
            })
            .map(|lot| lot.fee_allocated_base + lot.tax_allocated_base)
            .sum();
        acquisition_charges_disposed += (sent - arrived).max(Decimal::ZERO);
    }

    // A WAC account's purchases pool (rules R7.2): a pooled purchase has no
    // lot of its own, so its charge (what of it opened units) counts here,
    // and a sale from a pool relieves the pool's charge per unit, of these
    // charges at most.
    let wac = |account: &AccountId| {
        inputs
            .effects
            .account(account)
            .is_some_and(|profile| profile.cost_basis_method == CostBasisMethod::Wac)
    };
    let lot_activities: HashSet<&str> = lots
        .iter()
        .filter_map(|lot| lot.open_activity.as_ref().map(ActivityId::as_str))
        .collect();
    let mut pooled_charges = Decimal::ZERO;
    for (event, trade) in inputs
        .effects
        .events
        .iter()
        .filter(|e| scope.contains(&e.account) && period.contains(e.date) && wac(&e.account))
        .filter_map(|e| e.trade_charge.map(|trade| (e, trade)))
        .filter(|(e, trade)| trade.buy && !lot_activities.contains(e.source.as_str()))
    {
        let covered = disposed_quantity_by_activity
            .get(event.source.as_str())
            .copied()
            .unwrap_or_default();
        pooled_charges += if trade.quantity > Decimal::ZERO {
            let opened = (trade.quantity - covered).max(Decimal::ZERO);
            arith::proportional(trade.charge, opened, trade.quantity).unwrap_or(Decimal::ZERO)
        } else {
            trade.charge
        };
    }
    let mut pool_charges_relieved = Decimal::ZERO;
    for disposal in disposals.iter().filter(|d| wac(&d.account)) {
        let Some(pool) = lot_by_id.get(&(&disposal.account, disposal.lot_id.as_str())) else {
            continue;
        };
        if pool.open_activity.is_some() {
            continue;
        }
        let units = arith::mul(pool.original_quantity, pool.split_ratio)
            .unwrap_or(Decimal::ZERO)
            .abs();
        if units > Decimal::ZERO {
            pool_charges_relieved += arith::proportional(
                pool.fee_allocated_base + pool.tax_allocated_base,
                disposal.quantity.abs(),
                units,
            )
            .unwrap_or(Decimal::ZERO);
        }
    }
    let pooled_relieved = pool_charges_relieved.min(pooled_charges);

    let r = |v: Decimal| v.round_dp(STORED_PRECISION);
    let mut period_open_charges = r(period_open_charge_by_activity.values().copied().sum());
    if period_open_charges.is_zero() && !saw_period_open_lots {
        // The window's purchases, pooled ones included.
        period_open_charges = r(fallback_buy_charge
            .iter()
            .filter(|(id, _)| !disposal_activity_ids.contains(*id))
            .map(|(_, charge)| *charge)
            .sum());
    } else {
        period_open_charges = r(period_open_charges + pooled_charges);
        remaining_open_from_lots += pooled_charges - pooled_relieved;
    }
    acquisition_charges_disposed += pooled_relieved;
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
        // Holdings attribution already derives its entire P&L from snapshots
        // and inferred flows; transaction legs must not be added to it.
        if inputs.tracking(&pair.in_account) == TrackingMode::Holdings
            || inputs.tracking(&pair.out_account) == TrackingMode::Holdings
        {
            continue;
        }
        // Unmarked same-account pairs already put their execution difference
        // into net contribution (and fallback flows), so it is not P&L too.
        if pair.in_account == pair.out_account && !pair.contribution_neutral {
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
        // A cut pair leaves principal in transit under the valuation rules.
        // It is an unreconciled delta, not an execution FX gain or loss.
        // Only a window containing both legs can attribute their difference.
        if !period.contains(transfer_in.date) || !period.contains(transfer_out.date) {
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
    /// Gain and the capital it was earned on, for the scope's ROI; a
    /// holdings account over its full history counts at cost (value less
    /// book cost, over book cost).
    gain: Option<Decimal>,
    capital: Option<Decimal>,
    holdings: bool,
    amounts: Amounts,
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

/// A component's gain and the capital it was earned on, for the scope's
/// ROI: the average capital invested over the period (Modified Dietz), or
/// the book cost for a holdings account over its full history. The capital
/// is tested on the scope's total, so an account at zero, or one that took
/// out more than it held on average, still adds up.
fn component_gain_and_capital(
    history: &[DailyValuation],
    flows: &[PeriodFlow],
    tracking: TrackingMode,
    is_all_time: bool,
    baseline: Baseline,
    amount: Option<Decimal>,
) -> (Option<Decimal>, Option<Decimal>) {
    // Like a single account's return, a component's gain needs both endpoints
    // valued.
    let unvalued = |day: Option<&DailyValuation>| {
        day.is_none_or(|d| d.value_status.is_unavailable_for_returns())
    };
    if unvalued(history.first()) || unvalued(history.last()) {
        return (None, None);
    }
    if tracking == TrackingMode::Holdings && is_all_time {
        let capital = history
            .last()
            .filter(|d| holdings_basis_is_complete(d))
            .map(|d| d.book_basis_base)
            .filter(|book| *book >= MIN_RETURN_BASE);
        return (amount.filter(|_| capital.is_some()), capital);
    }
    let holdings = tracking == TrackingMode::Holdings;
    let opening = Opening::for_baseline(holdings, baseline);
    match dietz_points(history, flows, holdings, opening)
        .ok()
        .and_then(|points| points.last().copied())
    {
        Some(point) => (Some(point.gain), Some(point.capital)),
        None => (None, None),
    }
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
    let mut series_unavailable = is_all_time;
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
            let baseline = inputs.attribution_baseline(
                false,
                window.start,
                std::slice::from_ref(&component.account),
            );
            let mut component_result = performance_core(
                history,
                false,
                window.start,
                baseline,
                false,
                component_profile,
                inputs.account_is_base(&component.account),
                base,
            );
            component_result.scope = component.account.as_str().to_string();
            // The bounded series measures changes from the opening close; it
            // cannot represent a gain measured from inception.
            series_unavailable |= baseline == Baseline::Inception;
            if component_profile == MeasureProfile::Dashboard {
                apply_dashboard_amount(&mut component_result, history, false, baseline);
            } else {
                finalize_attribution(
                    inputs,
                    &mut component_result,
                    std::slice::from_ref(&component.account),
                    history,
                    baseline,
                    Seed::default(),
                );
            }
            warnings = component_result.data_quality.warnings;
            reasons = component_result.data_quality.not_applicable_reasons;
            (
                Some(component_result.attribution.pnl()),
                component_result.attribution,
                BasisStatus::NotApplicable,
            )
        };

        let holdings = component.tracking == TrackingMode::Holdings;
        let flows = period_flows(history);
        let baseline = inputs.attribution_baseline(
            holdings,
            window.start,
            std::slice::from_ref(&component.account),
        );
        let (gain, capital) = if amount.is_some() {
            component_gain_and_capital(
                history,
                &flows,
                component.tracking,
                is_all_time,
                baseline,
                amount,
            )
        } else {
            (None, None)
        };
        metrics.push(ComponentMetrics {
            account: component.account.clone(),
            start_date: start_point.date,
            end_date: end_point.date,
            amount,
            gain,
            capital,
            holdings,
            amounts: period_amounts(
                start_point,
                end_point,
                &flows,
                holdings,
                is_all_time,
                baseline,
            ),
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
        series_unavailable,
    )
}

fn build_mixed_result(
    components: &[MixedComponent],
    metrics: Vec<ComponentMetrics>,
    skipped: Vec<QualityNote>,
    currency: &Currency,
    start_opt: Option<NaiveDate>,
    include_series: bool,
    series_unavailable: bool,
) -> PerformanceResult {
    let mut attribution = Attribution::default();
    let mut summary_amount = Decimal::ZERO;
    let mut gain = Decimal::ZERO;
    let mut capital = Decimal::ZERO;
    let mut warnings = vec![QualityNote::MixedScope];
    warnings.extend(skipped);
    let mut reasons = vec![
        QualityNote::MixedTwrNotApplicable,
        QualityNote::MixedMoneyWeightedNotApplicable,
    ];
    let mut coverage_complete = true;
    // Gain and capital of the transactions accounts, then of the holdings
    // accounts; the amounts of the accounts the ROI is measured on.
    let mut parts = [(Decimal::ZERO, Decimal::ZERO); 2];
    let mut amounts = Amounts {
        start_value: Some(Decimal::ZERO),
        money_in: Some(Decimal::ZERO),
        money_out: Some(Decimal::ZERO),
        end_value: Some(Decimal::ZERO),
        ..Amounts::default()
    };

    if metrics.is_empty() {
        reasons.push(QualityNote::TwoValuationPointsRequired);
        let mut result = build_result(
            String::new(),
            currency.clone(),
            start_opt,
            None,
            ReturnMethod::NotApplicable,
            unavailable_returns(&QualityNote::TwoValuationPointsRequired),
            Attribution::default(),
            Risk::default(),
            data_quality(warnings, reasons, true),
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
        if let Some(amount) = component.amount {
            summary_amount += amount;
            add_attribution(&mut attribution, &component.attribution);
        }
        match (component.capital, component.gain) {
            (Some(value), Some(component_gain)) => {
                capital += value;
                gain += component_gain;
                let part = &mut parts[usize::from(component.holdings)];
                part.0 += component_gain;
                part.1 += value;
                add_amounts(&mut amounts, &component.amounts);
            }
            _ if component.amount.is_none() && component.contributes_to_scope => {
                coverage_complete = false;
                warnings.push(QualityNote::MixedPercentExcluded {
                    account: component.account.as_str().to_string(),
                });
            }
            _ if component.amount.is_some() => {
                coverage_complete = false;
                warnings.push(QualityNote::MixedPercentNoDenominator {
                    account: component.account.as_str().to_string(),
                });
            }
            _ => {}
        }
    }

    let value_return = if !coverage_complete {
        reasons.push(QualityNote::MixedCoverageDiffers);
        None
    } else if capital >= MIN_RETURN_BASE {
        let value_return = arith::div(gain, capital);
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
        if series_unavailable {
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
            twr: ReturnView::unavailable(QualityNote::MixedTwrNotApplicable),
            // A holdings account has no recorded deposits or withdrawals, so
            // the scope has no dated cash flows to solve a rate on.
            money_weighted: ReturnView::unavailable(QualityNote::MixedMoneyWeightedNotApplicable),
            // The scope's one figure: its accounts' gains over the capital
            // they were earned on. How long that capital was held is not
            // known for a holdings account, so it has no yearly rate.
            return_on_cost: ReturnView {
                period: value_return.map(|v| v.round_dp(STORED_PRECISION)),
                annualized: None,
                series,
                unavailable_reason: value_return
                    .is_none()
                    .then(|| reasons.last().cloned())
                    .flatten(),
            },
        },
        attribution,
        Risk::default(),
        data_quality(warnings, reasons, false),
        false,
        true,
    );
    // The amounts stand behind the ROI: without it there is nothing to show.
    if value_return.is_some() {
        let stored = |value: Decimal| value.round_dp(STORED_PRECISION);
        amounts.gain = Some(stored(gain));
        amounts.capital = Some(stored(capital));
        amounts.parts = [TrackingMode::Transactions, TrackingMode::Holdings]
            .into_iter()
            .zip(parts)
            .map(|(tracking, (gain, capital))| AmountsPart {
                tracking,
                gain: stored(gain),
                capital: stored(capital),
            })
            .collect();
        result.amounts = amounts;
    }
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
    refresh_summary(&mut result);
    result
}

/// Adds one account's amounts to a scope's: an amount one account lacks is
/// lacking for the scope, and the weakest knowledge of the flows marks it.
fn add_amounts(total: &mut Amounts, part: &Amounts) {
    let add = |total: &mut Option<Decimal>, part: Option<Decimal>| {
        *total = total.zip(part).map(|(total, part)| total + part);
    };
    add(&mut total.start_value, part.start_value);
    add(&mut total.money_in, part.money_in);
    add(&mut total.money_out, part.money_out);
    add(&mut total.end_value, part.end_value);
    total.flows = total.flows.combine(part.flows);
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
    let flows = period_flows(history);
    let holdings = component.tracking == TrackingMode::Holdings;
    if holdings && flows.iter().any(|f| f.source.is_unavailable_for_returns()) {
        return Vec::new();
    }
    // The bounded series only exists when no component starts at its
    // inception, so every component opens on its first close.
    dietz_points(history, &flows, holdings, Opening::Close)
        .unwrap_or_default()
        .into_iter()
        .map(|point| MixedSeriesPoint {
            date: point.date,
            amount: point.gain,
            denominator: (point.capital >= MIN_RETURN_BASE).then_some(point.capital),
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

/// A price series has no cash flows, so its time-weighted and
/// money-weighted returns are both the price return.
fn price_returns(
    start: NaiveDate,
    end: NaiveDate,
    total_return: Decimal,
    series: Vec<SeriesPoint>,
) -> Returns {
    let view = ReturnView {
        period: Some(total_return.round_dp(STORED_PRECISION)),
        annualized: annualize(start, end, Some(total_return)),
        series,
        unavailable_reason: None,
    };
    Returns {
        twr: view.clone(),
        money_weighted: view,
        return_on_cost: ReturnView::unavailable(QualityNote::ReturnOnCostNotApplicable),
    }
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
        price_returns(start_date, end_date, total_return, series),
        Attribution::default(),
        risk_from_samples(&risk_samples, Some(start_date)),
        data_quality(vec![QualityNote::SymbolPriceOnly], Vec::new(), false),
        false,
        false,
    )
}

// ------------------------------------------------------------ benchmark replay

/// The money a scope put in and took out over a window, to replay into a
/// benchmark: the capital it opened with and each day's deposits and
/// withdrawals, in base currency.
#[derive(Debug, Clone, PartialEq)]
pub struct ScopeCashFlows {
    pub opening_date: NaiveDate,
    pub opening_capital: Decimal,
    /// `(date, inflow, outflow)`, both legs non-negative.
    pub flows: Vec<(NaiveDate, Decimal, Decimal)>,
}

/// The scope's opening capital and dated flows over `window`, on the same
/// terms as its money-weighted return: from inception the capital is the
/// money contributed by the first close, otherwise the first close. Flows
/// without a known amount are left out, as holdings snapshots do. `None`
/// when the scope has fewer than two closes in the window.
pub fn scope_cash_flows(
    inputs: &MeasureInputs<'_>,
    scope: &[AccountId],
    window: Window,
) -> Result<Option<ScopeCashFlows>, EngineError> {
    check_window(window)?;
    let started: Vec<AccountId> = scope
        .iter()
        .filter(|a| has_started(&inputs.effects, a))
        .cloned()
        .collect();
    let Ok(scoped) = aggregate_scope(&inputs.effects, inputs.series, &started, window) else {
        return Ok(None);
    };
    let history: Vec<DailyValuation> = scoped.days.iter().map(DailyValuation::stored).collect();
    if history.len() < 2 {
        return Ok(None);
    }
    let has_holdings = started
        .iter()
        .any(|a| inputs.tracking(a) == TrackingMode::Holdings);
    let baseline = inputs.attribution_baseline(has_holdings, window.start, &started);
    let opening = Opening::for_baseline(has_holdings, baseline);
    // The replay opens where the scope's own money-weighted return does.
    let Some(start_index) = opening_index(&history, opening) else {
        return Ok(None);
    };
    let first = &history[start_index];
    let opening_capital = match opening {
        Opening::Contribution => first.net_contribution_base,
        Opening::Close => first.total_value_base,
    };
    let all_flows = period_flows(&history);
    // A flow without a known amount leaves the scope's own money-weighted
    // return unavailable: replaying the rest would compare different money.
    if all_flows
        .iter()
        .any(|f| f.source.is_unavailable_for_returns())
    {
        return Ok(None);
    }
    let flows = all_flows
        .into_iter()
        .skip(start_index)
        .filter(|f| f.source.has_known_amount() && (!f.inflow.is_zero() || !f.outflow.is_zero()))
        .map(|f| (f.date, f.inflow, f.outflow))
        .collect();
    Ok(Some(ScopeCashFlows {
        opening_date: first.date,
        opening_capital,
        flows,
    }))
}

/// One day of a simulated account holding only the benchmark.
fn replay_day(
    date: NaiveDate,
    value: Decimal,
    contributed: Decimal,
    flow: DailyFlow,
) -> DailyValuation {
    DailyValuation {
        date,
        fx_rate_to_base: Decimal::ONE,
        cash_balance: Decimal::ZERO,
        investment_market_value: value,
        total_value: value,
        cost_basis: contributed,
        book_basis: contributed,
        net_contribution: contributed,
        cash_balance_base: Decimal::ZERO,
        investment_market_value_base: value,
        total_value_base: value,
        cost_basis_base: contributed,
        book_basis_base: contributed,
        net_contribution_base: contributed,
        performance_eligible_value_base: value,
        value_status: ValueStatus::Complete,
        basis_status: BasisStatus::default(),
        flow,
    }
}

/// A benchmark measured with a scope's own money: the opening capital buys
/// the symbol at the first close, each deposit buys at the previous close
/// and each withdrawal sells at its day's close, as the money-weighted
/// return counts them. The time-weighted view stays the price return; the
/// money-weighted view is the simulated account's. Prices only, without FX:
/// the same basis as the price return.
pub fn measure_price_series_replayed(
    scope: &str,
    currency: &Currency,
    points: &[(NaiveDate, Decimal)],
    cash: &ScopeCashFlows,
) -> PerformanceResult {
    let mut result = measure_price_series(scope, currency, points);
    if result.returns.twr.period.is_none() {
        return result;
    }
    result.returns.money_weighted = match replay_history(points, cash) {
        Ok(history) => {
            let flows = period_flows(&history);
            let replayed = money_weighted_return(&history, &flows, true, Opening::Close);
            let annualized = history
                .first()
                .zip(history.last())
                .and_then(|(first, last)| annualize(first.date, last.date, replayed.period));
            ReturnView {
                period: replayed.period.map(|v| v.round_dp(STORED_PRECISION)),
                annualized,
                series: replayed.series,
                unavailable_reason: replayed.reason,
            }
        }
        Err(reason) => ReturnView::unavailable(reason),
    };
    result
}

fn replay_history(
    points: &[(NaiveDate, Decimal)],
    cash: &ScopeCashFlows,
) -> Result<Vec<DailyValuation>, QualityNote> {
    let priced: Vec<(NaiveDate, Decimal)> = points
        .iter()
        .copied()
        .filter(|(date, price)| *date >= cash.opening_date && *price > Decimal::ZERO)
        .collect();
    let Some(&(first_date, first_price)) = priced.first() else {
        return Err(QualityNote::TwoQuotePointsRequired);
    };
    if priced.len() < 2 {
        return Err(QualityNote::TwoQuotePointsRequired);
    }
    // Flows up to the first quoted close join the opening capital.
    let mut flows = cash.flows.iter().peekable();
    let mut contributed = cash.opening_capital;
    while let Some(&(_, inflow, outflow)) = flows.next_if(|(date, _, _)| *date <= first_date) {
        contributed += inflow - outflow;
    }
    let out_of_range = QualityNote::MoneyWeightedOutOfRange;
    let mut units = arith::div(contributed, first_price).ok_or(out_of_range.clone())?;
    let mut history = vec![replay_day(
        first_date,
        contributed,
        contributed,
        DailyFlow::default(),
    )];
    let mut previous_price = first_price;
    for &(date, price) in &priced[1..] {
        let (mut inflow, mut outflow) = (Decimal::ZERO, Decimal::ZERO);
        while let Some(&(_, day_in, day_out)) =
            flows.next_if(|(flow_date, _, _)| *flow_date <= date)
        {
            inflow += day_in;
            outflow += day_out;
        }
        units += arith::div(inflow, previous_price).ok_or(out_of_range.clone())?;
        // A withdrawal sells at most what the replay holds: the scope may
        // take out more than the benchmark would have grown to.
        let wanted = arith::div(outflow, price).ok_or(out_of_range.clone())?;
        let sold = wanted.min(units.max(Decimal::ZERO));
        units -= sold;
        let outflow = arith::mul(sold, price).ok_or(out_of_range.clone())?;
        contributed += inflow - outflow;
        let value = arith::mul(units, price).ok_or(out_of_range.clone())?;
        let flow = DailyFlow {
            inflow_base: inflow,
            outflow_base: outflow,
            source: if inflow.is_zero() && outflow.is_zero() {
                FlowSource::NoFlow
            } else {
                FlowSource::CashAmount
            },
        };
        history.push(replay_day(date, value, contributed, flow));
        previous_price = price;
    }
    Ok(history)
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
                Baseline::Inception,
                false,
                MeasureProfile::Full,
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
        // Ordinary returns are unaffected.
        let ordinary = annualized_return(start, end, dec!(0.05)).unwrap();
        assert!(ordinary > dec!(0.7) && ordinary < dec!(0.8), "{ordinary}");
    }

    fn dated(date: &str, total: Decimal, inflow: Decimal, outflow: Decimal) -> DailyValuation {
        let mut day = row(date, total);
        if !inflow.is_zero() || !outflow.is_zero() {
            day.flow = DailyFlow {
                inflow_base: inflow,
                outflow_base: outflow,
                source: FlowSource::CashAmount,
            };
        }
        day
    }

    /// A dated window: each period opens on its first close.
    fn measured(history: &[DailyValuation], profile: MeasureProfile) -> PerformanceResult {
        measured_from(history, profile, Baseline::PeriodStart)
    }

    fn measured_from(
        history: &[DailyValuation],
        profile: MeasureProfile,
        baseline: Baseline,
    ) -> PerformanceResult {
        let currency = Currency::parse("USD").unwrap();
        performance_core(
            history, false, None, baseline, true, profile, true, &currency,
        )
    }

    /// Money-weighted returns worked by hand: the period return R at which
    /// the opening capital and each flow grow to the closing value, each for
    /// the share of the period it was invested (a deposit counts from the
    /// previous close, a withdrawal until the close it leaves on).
    #[test]
    fn money_weighted_matches_hand_worked_cases() {
        let z = Decimal::ZERO;
        let cases: Vec<(&str, Vec<DailyValuation>, Decimal)> = vec![
            (
                // No flows: the simple return, equal to the TWR.
                "no flows",
                vec![
                    dated("2026-01-01", dec!(100), z, z),
                    dated("2026-01-02", dec!(110), z, z),
                    dated("2026-01-03", dec!(121), z, z),
                ],
                dec!(0.21),
            ),
            (
                // 100 deposited after the Jan 2 close, 3 of 4 days invested:
                // 100 (1+R) + 100 (1+R)^(3/4) = 220.
                "deposit mid-period",
                vec![
                    dated("2026-01-01", dec!(100), z, z),
                    dated("2026-01-02", dec!(105), z, z),
                    dated("2026-01-03", dec!(210), dec!(100), z),
                    dated("2026-01-05", dec!(220), z, z),
                ],
                dec!(0.11496185),
            ),
            (
                // 600 withdrawn on Jan 3, a third of the period before the end:
                // 1000 (1+R) - 600 (1+R)^(1/3) = 530.
                "withdrawal larger than the gain",
                vec![
                    dated("2026-01-01", dec!(1000), z, z),
                    dated("2026-01-02", dec!(1100), z, z),
                    dated("2026-01-03", dec!(520), z, dec!(600)),
                    dated("2026-01-04", dec!(530), z, z),
                ],
                dec!(0.16052578),
            ),
            (
                // 99% lost, then refunded with 1000 that gains 10%: the TWR
                // stays near -100%; 1000 (1+R) + 1000 (1+R)^(2/3) = 1111.
                "wiped out and refunded",
                vec![
                    dated("2026-01-01", dec!(1000), z, z),
                    dated("2026-01-02", dec!(10), z, z),
                    dated("2026-01-03", dec!(1010), dec!(1000), z),
                    dated("2026-01-04", dec!(1111), z, z),
                ],
                dec!(-0.51028867),
            ),
            (
                // A pre-funding negative close is skipped: measured from 995.
                "pre-funding prefix",
                vec![
                    dated("2026-01-01", dec!(-5), z, z),
                    dated("2026-01-02", dec!(995), dec!(1000), z),
                    dated("2026-01-03", dec!(1045), z, z),
                ],
                dec!(0.05025126),
            ),
        ];
        for (name, history, expected) in cases {
            for profile in [MeasureProfile::Full, MeasureProfile::Dashboard] {
                let result = measured(&history, profile);
                let view = &result.returns.money_weighted;
                assert_eq!(view.period, Some(expected), "{name} ({profile:?})");
                assert_eq!(view.unavailable_reason, None, "{name}");
            }
            let full = measured(&history, MeasureProfile::Full);
            let curve = &full.returns.money_weighted.series;
            assert_eq!(
                curve.iter().map(|p| p.date).collect::<Vec<_>>(),
                history.iter().map(|d| d.date).collect::<Vec<_>>(),
                "{name}: one point per close"
            );
            assert_eq!(
                curve.first().map(|p| p.value),
                Some(Decimal::ZERO),
                "{name}"
            );
            assert_eq!(curve.last().map(|p| p.value), Some(expected), "{name}");
        }
    }

    #[test]
    fn money_weighted_from_inception_counts_the_first_day_gain() {
        // 1000 deposited and invested on day one, closing at 1095.45; the
        // account ends at 1107.97. The money earned 107.97 on 1000, while a
        // window opening on the first close sees only 12.52 on 1095.45.
        let z = Decimal::ZERO;
        let mut history = vec![
            dated("2026-01-30", dec!(1095.45), z, z),
            dated("2026-10-30", dec!(1107.97), z, z),
        ];
        for day in &mut history {
            day.net_contribution_base = dec!(1000);
        }
        let from_inception = measured_from(&history, MeasureProfile::Full, Baseline::Inception);
        assert_eq!(
            from_inception.returns.money_weighted.period,
            Some(dec!(0.10797))
        );
        let curve = &from_inception.returns.money_weighted.series;
        assert_eq!(curve.first().map(|p| p.value), Some(dec!(0.09545)));
        assert_eq!(curve.last().map(|p| p.value), Some(dec!(0.10797)));
        let from_close = measured(&history, MeasureProfile::Full);
        assert_eq!(
            from_close.returns.money_weighted.period,
            Some(dec!(0.01142909))
        );
        assert_eq!(
            from_close.returns.money_weighted.period,
            from_close.returns.twr.period
        );
    }

    /// A close `day` days after `base`, with that day's deposits and
    /// withdrawals.
    fn on_day(
        base: &str,
        day: i64,
        total: Decimal,
        inflow: Decimal,
        outflow: Decimal,
    ) -> DailyValuation {
        let base: NaiveDate = base.parse().unwrap();
        let date = base + chrono::Duration::days(day);
        dated(&date.to_string(), total, inflow, outflow)
    }

    /// Published worked examples. A deposit is the row after the close it
    /// counts from; a withdrawal is the row it leaves on. Values between the
    /// flows do not enter a money-weighted return.
    #[test]
    fn money_weighted_matches_published_examples() {
        let z = Decimal::ZERO;
        // TD Wealth, "Personal (Money-Weighted) Rate of Return" (2016),
        // calendar 2015.
        let td = "2014-12-31";
        // Portfolio Performance manual, money-weighted examples 4 and 6
        // (demo-portfolio-03): remaining days 730/514/255 and
        // 1095/878/514/179/61, yearly rates on a 365-day year.
        let pp4 = "2021-06-12";
        let pp6 = "2020-06-12";
        let cases: Vec<(&str, Vec<DailyValuation>, Decimal, Decimal)> = vec![
            (
                // 550,000, +30,000 on 1 Aug, 667,980: TD prints 15.7%.
                "TD, a deposit",
                vec![
                    on_day(td, 0, dec!(550000), z, z),
                    on_day(td, 212, dec!(600000), z, z),
                    on_day(td, 213, dec!(630000), dec!(30000), z),
                    on_day(td, 365, dec!(667980), z, z),
                ],
                dec!(0.157),
                dec!(0.001),
            ),
            (
                // 12,000, +5,000 on 1 Apr, 15,000: TD prints -12.7%.
                "TD, a deposit before a fall",
                vec![
                    on_day(td, 0, dec!(12000), z, z),
                    on_day(td, 90, dec!(11000), z, z),
                    on_day(td, 91, dec!(16000), dec!(5000), z),
                    on_day(td, 365, dec!(15000), z, z),
                ],
                dec!(-0.127),
                dec!(0.001),
            ),
            (
                // 1,500,000, -600,000 on 19 Feb, 1,050,000: TD prints 15.19%.
                "TD, a withdrawal",
                vec![
                    on_day(td, 0, dec!(1500000), z, z),
                    on_day(td, 50, dec!(950000), z, dec!(600000)),
                    on_day(td, 365, dec!(1050000), z, z),
                ],
                dec!(0.1519),
                dec!(0.001),
            ),
            (
                // 177.94, +84, +67, 426.82 over 730 days: 17.63% a year, so
                // 1.1763^2 - 1 for the period.
                "Portfolio Performance, example 4",
                vec![
                    on_day(pp4, 0, dec!(177.94), z, z),
                    on_day(pp4, 216, dec!(160.26), z, z),
                    on_day(pp4, 217, dec!(244.26), dec!(84), z),
                    on_day(pp4, 475, dec!(264.57), z, z),
                    on_day(pp4, 476, dec!(331.57), dec!(67), z),
                    on_day(pp4, 730, dec!(426.82), z, z),
                ],
                dec!(0.38368),
                dec!(0.0002),
            ),
            (
                // From nothing: +153, +83, -30, -107, 190.06 over 1095 days:
                // 18.00% a year, so 1.18^3 - 1 for the period.
                "Portfolio Performance, example 6",
                vec![
                    on_day(pp6, 0, z, z, z),
                    on_day(pp6, 217, z, z, z),
                    on_day(pp6, 218, dec!(153), dec!(153), z),
                    on_day(pp6, 581, dec!(160), z, z),
                    on_day(pp6, 582, dec!(243), dec!(83), z),
                    on_day(pp6, 916, dec!(310), z, dec!(30)),
                    on_day(pp6, 1034, dec!(232), z, dec!(107)),
                    on_day(pp6, 1095, dec!(190.06), z, z),
                ],
                dec!(0.643032),
                dec!(0.0005),
            ),
        ];
        for (name, history, published, tolerance) in cases {
            let result = measured(&history, MeasureProfile::Full);
            let period = result
                .returns
                .money_weighted
                .period
                .unwrap_or_else(|| panic!("{name}: no money-weighted return"));
            assert!(
                (period - published).abs() <= tolerance,
                "{name}: {period} against the published {published}"
            );
        }
        // The same Portfolio Performance example prints a 25.58% cumulative
        // time-weighted return.
        let history = vec![
            on_day(pp4, 0, dec!(177.94), z, z),
            on_day(pp4, 216, dec!(160.26), z, z),
            on_day(pp4, 217, dec!(244.26), dec!(84), z),
            on_day(pp4, 475, dec!(264.57), z, z),
            on_day(pp4, 476, dec!(331.57), dec!(67), z),
            on_day(pp4, 730, dec!(426.82), z, z),
        ];
        let twr = measured(&history, MeasureProfile::Full)
            .returns
            .twr
            .period
            .unwrap();
        assert!((twr - dec!(0.2558)).abs() <= dec!(0.0001), "{twr}");
    }

    #[test]
    fn the_two_methods_can_disagree_on_the_sign() {
        // Wealthsimple's help-centre example: 100 falls to 50, another 100
        // goes in, and it ends at 250. The investment lost a sixth; the money
        // gained, because most of it arrived after the fall:
        // 100 (1+R) + 100 (1+R)^(2/3) = 250.
        let z = Decimal::ZERO;
        let history = vec![
            dated("2026-01-01", dec!(100), z, z),
            dated("2026-01-02", dec!(50), z, z),
            dated("2026-01-03", dec!(150), dec!(100), z),
            dated("2026-01-04", dec!(250), z, z),
        ];
        let result = measured(&history, MeasureProfile::Full);
        assert_eq!(result.returns.twr.period, Some(dec!(-0.16666667)));
        assert_eq!(result.returns.money_weighted.period, Some(dec!(0.30550268)));
    }

    #[test]
    fn a_long_history_of_deposits_returns_the_rate_it_grew_at() {
        // 10,000 a year for twenty years into something that grows 8% a
        // year: the yearly money-weighted rate is 8%, however many deposits.
        let base = "2006-01-01";
        let daily = 1.08_f64.powf(1.0 / 365.25);
        let cents = |value: f64| Decimal::from_f64(value).unwrap().round_dp(2);
        let mut value = 10_000.0_f64;
        let mut day = 0_i64;
        let mut history = vec![on_day(
            base,
            day,
            cents(value),
            Decimal::ZERO,
            Decimal::ZERO,
        )];
        for year in 1..20 {
            // Grow to the close the deposit counts from, then a day with it.
            value *= daily.powi((365 * year - day) as i32);
            day = 365 * year;
            history.push(on_day(
                base,
                day,
                cents(value),
                Decimal::ZERO,
                Decimal::ZERO,
            ));
            value = (value + 10_000.0) * daily;
            day += 1;
            history.push(on_day(base, day, cents(value), dec!(10000), Decimal::ZERO));
        }
        value *= daily.powi((7300 - day) as i32);
        history.push(on_day(
            base,
            7300,
            cents(value),
            Decimal::ZERO,
            Decimal::ZERO,
        ));
        let view = measured(&history, MeasureProfile::Full)
            .returns
            .money_weighted;
        let yearly = view.annualized.expect("twenty years have a yearly rate");
        assert!((yearly - dec!(0.08)).abs() < dec!(0.000001), "{yearly}");
        // 1.08^(7300/365.25) - 1.
        let period = view.period.unwrap();
        assert!((period - dec!(3.65604923)).abs() < dec!(0.0001), "{period}");
    }

    /// Histories the solve must answer the same way every time, or decline.
    #[test]
    fn money_weighted_answers_awkward_histories() {
        let z = Decimal::ZERO;
        let base = "2026-01-01";
        let measure =
            |history: &[DailyValuation], profile| measured(history, profile).returns.money_weighted;

        // Everything lost, nothing taken out.
        let lost = vec![
            on_day(base, 0, dec!(1000), z, z),
            on_day(base, 1, dec!(500), z, z),
            on_day(base, 2, z, z, z),
        ];
        assert_eq!(measure(&lost, MeasureProfile::Full).period, Some(dec!(-1)));

        // Nearly everything lost after a second deposit halfway:
        // 100 (1+R) + 100 (1+R)^(1/2) = 1.
        let nearly = vec![
            on_day(base, 0, dec!(100), z, z),
            on_day(base, 5, dec!(50), z, z),
            on_day(base, 6, dec!(150), dec!(100), z),
            on_day(base, 10, dec!(1), z, z),
        ];
        assert_eq!(
            measure(&nearly, MeasureProfile::Full).period,
            Some(dec!(-0.99990195))
        );

        // Sold out at a gain, empty for a while, bought back and nearly
        // lost: 100 (1+R) - 150 (1+R)^(2/3) + 66 (1+R)^(1/3) = 8 holds at
        // -99.2%, -87.5% and -48.8%. The solve gives one of them, the same
        // one for the headline alone and as the end of the curve.
        let back = |end: Decimal| {
            vec![
                on_day(base, 0, dec!(100), z, z),
                on_day(base, 3, z, z, dec!(150)),
                on_day(base, 6, z, z, z),
                on_day(base, 7, dec!(66), dec!(66), z),
                on_day(base, 9, end, z, z),
            ]
        };
        let history = back(dec!(8));
        let full = measure(&history, MeasureProfile::Full);
        let period = full.period.expect("one of the three rates");
        assert!(
            [dec!(-0.992), dec!(-0.875), dec!(-0.488)]
                .iter()
                .any(|rate| (period - rate).abs() < dec!(0.000001)),
            "{period}"
        );
        assert_eq!(
            measure(&history, MeasureProfile::Dashboard).period,
            full.period
        );
        assert_eq!(measure(&history, MeasureProfile::Full).period, full.period);
        assert_eq!(full.series.last().map(|p| p.value), full.period);
        assert_eq!(
            full.series.iter().map(|p| p.date).collect::<Vec<_>>(),
            history.iter().map(|d| d.date).collect::<Vec<_>>(),
            "a point for every close, the empty ones included"
        );
        // The time-weighted return carries on across the empty stretch:
        // +50%, then 66 down to 8.
        assert_eq!(
            measured(&history, MeasureProfile::Full).returns.twr.period,
            Some(dec!(-0.81818182))
        );

        // The same history ending at nothing: no rate fits it.
        let none = measure(&back(z), MeasureProfile::Full);
        assert_eq!(none.period, None);
        assert_eq!(
            none.unavailable_reason,
            Some(QualityNote::MoneyWeightedNoSolution)
        );
        assert!(none.series.is_empty());
    }

    fn quotes(points: &[(&str, Decimal)]) -> Vec<(NaiveDate, Decimal)> {
        points
            .iter()
            .map(|(date, price)| (date.parse().unwrap(), *price))
            .collect()
    }

    fn cash(opening: &str, capital: Decimal, flows: &[(&str, Decimal, Decimal)]) -> ScopeCashFlows {
        ScopeCashFlows {
            opening_date: opening.parse().unwrap(),
            opening_capital: capital,
            flows: flows
                .iter()
                .map(|(date, inflow, outflow)| (date.parse().unwrap(), *inflow, *outflow))
                .collect(),
        }
    }

    /// The scope's own money replayed into a benchmark, worked by hand.
    #[test]
    fn a_benchmark_replays_the_scopes_deposits_and_withdrawals() {
        let currency = Currency::parse("USD").unwrap();
        let z = Decimal::ZERO;
        let rally = quotes(&[
            ("2026-01-01", dec!(100)),
            ("2026-01-02", dec!(100)),
            ("2026-01-03", dec!(200)),
        ]);
        let cases: Vec<(&str, ScopeCashFlows, Option<Decimal>)> = vec![
            (
                // No flows: the replay is the price return.
                "no flows",
                cash("2026-01-01", dec!(1000), &[]),
                Some(dec!(1)),
            ),
            (
                // 1000 more bought at the Jan 2 close (100) before the rally:
                // 20 units worth 4000; 1000 (1+R) + 1000 (1+R)^(1/2) = 4000.
                "deposit before the rally",
                cash("2026-01-01", dec!(1000), &[("2026-01-03", dec!(1000), z)]),
                Some(dec!(1.43844719)),
            ),
            (
                // 500 sold at the Jan 2 close (100): 5 units left, worth 1000;
                // 1000 (1+R) - 500 (1+R)^(1/2) = 1000.
                "withdrawal before the rally",
                cash("2026-01-01", dec!(1000), &[("2026-01-02", z, dec!(500))]),
                Some(dec!(0.6403882)),
            ),
            (
                // A deposit dated before the first quote joins the opening
                // capital: 2000 from the start, the price return.
                "deposit before the first quote",
                cash("2025-12-31", dec!(1000), &[("2025-12-31", dec!(1000), z)]),
                Some(dec!(1)),
            ),
        ];
        for (name, flows, expected) in cases {
            let result = measure_price_series_replayed("SPY", &currency, &rally, &flows);
            assert_eq!(
                result.returns.twr.period,
                Some(dec!(1)),
                "{name}: price return"
            );
            assert_eq!(result.returns.money_weighted.period, expected, "{name}");
            let curve = &result.returns.money_weighted.series;
            assert_eq!(
                curve.last().map(|p| p.value),
                expected,
                "{name}: curve ends there"
            );
        }
    }

    #[test]
    fn a_replay_without_quotes_after_the_opening_says_why() {
        let currency = Currency::parse("USD").unwrap();
        let before = quotes(&[("2026-01-01", dec!(100)), ("2026-01-02", dec!(110))]);
        let result = measure_price_series_replayed(
            "SPY",
            &currency,
            &before,
            &cash("2026-02-01", dec!(1000), &[]),
        );
        assert_eq!(result.returns.twr.period, Some(dec!(0.1)));
        assert_eq!(result.returns.money_weighted.period, None);
        assert_eq!(
            result.returns.money_weighted.unavailable_reason,
            Some(QualityNote::TwoQuotePointsRequired)
        );
    }

    #[test]
    fn a_holdings_window_ending_unvalued_has_no_time_weighted_return() {
        let z = Decimal::ZERO;
        let mut history = vec![
            dated("2026-01-01", dec!(1000), z, z),
            dated("2026-01-02", dec!(1010), z, z),
            dated("2026-01-03", dec!(300), z, z),
        ];
        history[2].value_status = ValueStatus::Unavailable;
        let currency = Currency::parse("USD").unwrap();
        let result = performance_core(
            &history,
            true,
            Some("2026-01-01".parse().unwrap()),
            Baseline::PeriodStart,
            true,
            MeasureProfile::Full,
            true,
            &currency,
        );
        let twr = &result.returns.twr;
        assert_eq!(twr.period, None);
        assert!(twr.series.is_empty());
        assert!(matches!(
            twr.unavailable_reason,
            Some(QualityNote::CoverageUnavailable { .. })
        ));
        // A holdings scope has no money-weighted return, valued or not.
        let money_weighted = &result.returns.money_weighted;
        assert_eq!(money_weighted.period, None);
        assert!(money_weighted.series.is_empty());
    }

    #[test]
    fn the_yearly_money_weighted_rate_is_the_period_rate_over_a_year() {
        // From inception the period opens a day before the first close, on the
        // 1000 contributed: 400 days to the last close, at +10%.
        let z = Decimal::ZERO;
        let mut history = vec![
            dated("2025-01-02", dec!(1050), z, z),
            dated("2026-02-05", dec!(1100), z, z),
        ];
        for day in &mut history {
            day.net_contribution_base = dec!(1000);
        }
        let result = measured_from(&history, MeasureProfile::Full, Baseline::Inception);
        let view = &result.returns.money_weighted;
        assert_eq!(view.period, Some(dec!(0.1)));
        // 1.1^(365.25/400) - 1: the yearly rate counts from the opening day,
        // not from the first close.
        assert_eq!(view.annualized, Some(dec!(0.09092952)));
        // Under a year there is no yearly rate, for either method.
        let short = vec![
            dated("2026-01-01", dec!(1000), z, z),
            dated("2026-12-30", dec!(1010), z, z),
        ];
        let result = measured(&short, MeasureProfile::Full);
        assert_eq!(result.returns.money_weighted.period, Some(dec!(0.01)));
        assert_eq!(result.returns.money_weighted.annualized, None);
        assert_eq!(result.returns.twr.annualized, None);
        // From a year on there is one.
        let year = vec![
            dated("2026-01-01", dec!(1000), z, z),
            dated("2027-01-01", dec!(1010), z, z),
        ];
        let result = measured(&year, MeasureProfile::Full);
        assert!(result.returns.money_weighted.annualized.is_some());
        assert!(result.returns.twr.annualized.is_some());
    }

    #[test]
    fn a_replay_sells_no_more_than_it_holds() {
        // The scope withdraws 900 when the replay holds only 500 (10 units at
        // 50): it sells those 10 units and never goes short.
        let currency = Currency::parse("USD").unwrap();
        let prices = quotes(&[
            ("2026-01-01", dec!(100)),
            ("2026-01-02", dec!(50)),
            ("2026-01-03", dec!(100)),
        ]);
        let flows = cash(
            "2026-01-01",
            dec!(1000),
            &[("2026-01-02", Decimal::ZERO, dec!(900))],
        );
        let result = measure_price_series_replayed("SPY", &currency, &prices, &flows);
        assert_eq!(result.returns.twr.period, Some(Decimal::ZERO));
        // 1000 in, 500 out halfway, nothing left: 1000 (1+R) = 500 (1+R)^(1/2),
        // so (1+R)^(1/2) = 1/2. A zero close after a withdrawal still solves.
        assert_eq!(result.returns.money_weighted.period, Some(dec!(-0.75)));
        let history = replay_history(&prices, &flows).unwrap();
        assert!(history
            .iter()
            .all(|day| !day.total_value_base.is_sign_negative()));
    }

    #[test]
    fn a_period_opening_on_a_negative_close_starts_at_the_first_funded_one() {
        let z = Decimal::ZERO;
        let history = vec![
            dated("2026-01-01", dec!(-5), z, z),
            dated("2026-01-02", dec!(995), dec!(1000), z),
        ];
        assert_eq!(opening_index(&history, Opening::Close), Some(1));
        assert_eq!(opening_index(&history, Opening::Contribution), Some(0));
        assert_eq!(opening_index(&history[..1], Opening::Close), None);
    }

    #[test]
    fn a_mixed_component_with_an_unvalued_endpoint_adds_no_money_weighted_return() {
        let z = Decimal::ZERO;
        let mut history = vec![
            dated("2026-01-01", dec!(1000), z, z),
            dated("2026-02-01", dec!(10), z, z),
        ];
        history[1].value_status = ValueStatus::Unavailable;
        let flows = period_flows(&history);
        assert_eq!(
            component_gain_and_capital(
                &history,
                &flows,
                TrackingMode::Transactions,
                false,
                Baseline::PeriodStart,
                Some(dec!(-990)),
            ),
            (None, None)
        );
    }

    fn holdings_measured(history: &[DailyValuation], start: Option<&str>) -> PerformanceResult {
        let currency = Currency::parse("USD").unwrap();
        performance_core(
            history,
            true,
            start.map(|d| d.parse().unwrap()),
            Baseline::PeriodStart,
            true,
            MeasureProfile::Full,
            true,
            &currency,
        )
    }

    #[test]
    fn a_holdings_account_charts_its_return_on_cost_over_its_full_history() {
        let z = Decimal::ZERO;
        let mut history = vec![
            dated("2026-01-01", dec!(1000), z, z),
            dated("2026-02-01", dec!(1100), z, z),
            dated("2026-03-01", dec!(1200), z, z),
        ];
        for day in &mut history {
            day.book_basis_base = dec!(1000);
            day.basis_status = BasisStatus::Complete;
        }
        let result = holdings_measured(&history, None);
        let roi = &result.returns.return_on_cost;
        assert_eq!(roi.period, Some(dec!(0.2)));
        assert_eq!(
            roi.series.iter().map(|p| p.value).collect::<Vec<_>>(),
            vec![dec!(0), dec!(0.1), dec!(0.2)]
        );
    }

    #[test]
    fn a_holdings_window_has_no_money_weighted_return() {
        // Its flows are inferred between snapshots, in amount and in date: a
        // dated window has the chained time-weighted return and nothing to
        // weigh by money.
        let z = Decimal::ZERO;
        let history = vec![
            dated("2025-01-01", dec!(1000), z, z),
            dated("2025-07-01", dec!(1050), z, z),
            dated("2026-01-01", dec!(1100), z, z),
        ];
        let result = holdings_measured(&history, Some("2025-01-01"));
        assert_eq!(result.returns.twr.period, Some(dec!(0.1)));
        assert!(result.returns.twr.annualized.is_some());
        let money_weighted = &result.returns.money_weighted;
        assert_eq!(money_weighted.period, None);
        assert_eq!(money_weighted.annualized, None);
        assert_eq!(
            money_weighted.unavailable_reason,
            Some(QualityNote::HoldingsMoneyWeightedNotApplicable)
        );
    }

    #[test]
    fn from_inception_the_time_weighted_return_starts_at_the_first_deposit() {
        // 385 of dividends and nothing contributed, then a 50000 deposit: the
        // income-only closes are too small a base to compound.
        let z = Decimal::ZERO;
        let mut history = vec![
            dated("2023-03-28", dec!(385), z, z),
            dated("2023-03-29", dec!(400), z, z),
            dated("2025-02-03", dec!(50400), dec!(50000), z),
            dated("2025-02-04", dec!(50500), z, z),
        ];
        for day in &mut history[..2] {
            day.net_contribution_base = z;
            day.net_contribution = z;
        }
        let from_inception = measured_from(&history, MeasureProfile::Full, Baseline::Inception);
        // Only the funded step counts: 50500 / 50400 - 1.
        assert_eq!(from_inception.returns.twr.period, Some(dec!(0.00198413)));
        // A window starting later opens already funded and keeps every step.
        let later = measured_from(&history, MeasureProfile::Full, Baseline::PeriodStart);
        assert!(later.returns.twr.period > from_inception.returns.twr.period);
    }

    #[test]
    fn money_weighted_equals_the_time_weighted_return_without_flows() {
        let z = Decimal::ZERO;
        let history = vec![
            dated("2026-01-01", dec!(250), z, z),
            dated("2026-01-02", dec!(240), z, z),
            dated("2026-02-01", dec!(275), z, z),
        ];
        let result = measured(&history, MeasureProfile::Full);
        assert_eq!(
            result.returns.money_weighted.period,
            result.returns.twr.period
        );
        assert_eq!(
            result.returns.money_weighted.series,
            result.returns.twr.series
        );
    }

    #[test]
    fn money_weighted_reports_why_it_is_unavailable() {
        let z = Decimal::ZERO;
        let mut unknown = vec![
            dated("2026-01-01", dec!(100), z, z),
            dated("2026-01-02", dec!(150), dec!(50), z),
        ];
        unknown[1].flow.source = FlowSource::Unknown;
        let result = measured(&unknown, MeasureProfile::Full);
        assert_eq!(
            result.returns.money_weighted.unavailable_reason,
            Some(QualityNote::MoneyWeightedUnknownFlow)
        );
        assert!(result.returns.money_weighted.series.is_empty());

        let never_funded = vec![dated("2026-01-01", z, z, z), dated("2026-01-02", z, z, z)];
        let result = measured(&never_funded, MeasureProfile::Full);
        assert_eq!(result.returns.money_weighted.period, None);
        assert_eq!(
            result.returns.money_weighted.unavailable_reason,
            Some(QualityNote::MoneyWeightedNoCapital)
        );
        // Transaction accounts have no return on cost, and say so.
        assert_eq!(
            result.returns.return_on_cost.unavailable_reason,
            Some(QualityNote::ReturnOnCostNotApplicable)
        );
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
            Baseline::Inception,
            false,
            MeasureProfile::Full,
            true,
            &currency,
        )
    }

    #[test]
    fn a_stamped_inferred_flow_counts_as_stamped_and_reports_the_inference() {
        let inferred = with_stamped_outflow(FlowSource::NetContributionFallback);
        let exact = with_stamped_outflow(FlowSource::CashAmount);
        assert_eq!(inferred.returns, exact.returns);
        assert!(inferred.returns.twr.period.is_some());
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
        assert_ne!(unstamped.returns.twr.period, stamped.returns.twr.period);
        assert!(!unstamped
            .data_quality
            .warnings
            .contains(&QualityNote::NetContributionFlows));
    }
}
