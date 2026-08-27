use std::collections::HashMap;

use chrono::Datelike;
use rand::Rng;
use rand_distr::{Distribution, StandardNormal};

use super::model::*;
use super::withdrawal::{
    add_contribution, apply_growth, apply_planned_spending_withdrawal, initial_withdrawal_buckets,
};
use crate::portfolio::fire::GlidepathSettings;

// Re-export output types used by this module's public API
use super::dto::{FireProjection, IncomeStreamExhaustion, YearlySnapshot};

const MAX_REQUIRED_CAPITAL_DOUBLING_STEPS: usize = 128;
const MIN_RETURN_STD_DEV: f64 = 1e-9;
const DEFAULT_INFLATION_STD_DEV: f64 = 0.015;
const RETURN_INFLATION_CORRELATION: f64 = -0.25;
const DEFAULT_BOND_VOLATILITY_RATIO: f64 = 0.35;
const REQUIRED_CAPITAL_SEED_MULTIPLE: f64 = 30.0;

pub(crate) fn bounded_inflation_factor(rate: f64, years: u32) -> f64 {
    (1.0_f64 + rate).powi(years as i32).clamp(0.01, f64::MAX)
}

// ─── Stochastic helpers ─────────────────────────────────────────────────────

/// Sample a one-year return where `mean` is interpreted as a long-run geometric return.
/// The lognormal calibration keeps the median path aligned with the deterministic projection.
#[cfg(test)]
pub(crate) fn sample_return<R: Rng>(rng: &mut R, mean: f64, std: f64) -> f64 {
    if !mean.is_finite() {
        return 0.0;
    }
    if !std.is_finite() || std <= MIN_RETURN_STD_DEV {
        return mean;
    }

    let z: f64 = StandardNormal.sample(rng);
    sample_return_from_standard(mean, std, z)
}

pub(crate) fn sample_return_and_inflation<R: Rng>(
    rng: &mut R,
    return_mean: f64,
    return_std: f64,
    inflation_mean: f64,
) -> (f64, f64) {
    let z_return: f64 = StandardNormal.sample(rng);
    let z_other: f64 = StandardNormal.sample(rng);
    let corr = RETURN_INFLATION_CORRELATION.clamp(-0.99, 0.99);
    let z_inflation = corr * z_return + (1.0 - corr * corr).sqrt() * z_other;
    (
        sample_return_from_standard(return_mean, return_std, z_return),
        sample_inflation_from_standard(inflation_mean, DEFAULT_INFLATION_STD_DEV, z_inflation),
    )
}

fn sample_return_from_standard(mean: f64, std: f64, z: f64) -> f64 {
    if !mean.is_finite() {
        return 0.0;
    }
    if !std.is_finite() || std <= MIN_RETURN_STD_DEV {
        return mean;
    }
    let safe_growth = (1.0 + mean).max(0.01);
    (safe_growth.ln() + std * z).exp() - 1.0
}

fn sample_inflation_from_standard(mean: f64, std: f64, z: f64) -> f64 {
    if !mean.is_finite() {
        return 0.0;
    }
    if !std.is_finite() || std <= MIN_RETURN_STD_DEV {
        return mean;
    }
    (mean + std * z).max(-0.99)
}

/// MC-closure-safe version of blended return params that works with owned primitives.
#[allow(clippy::too_many_arguments)]
pub(crate) fn blended_return_params_mc(
    accumulation_mean: f64,
    retirement_mean: f64,
    base_std: f64,
    annual_fee_rate: f64,
    current_age: u32,
    retirement_start_age: u32,
    planning_horizon_age: u32,
    gp: Option<&GlidepathSettings>,
    i: u32,
    in_fire: bool,
) -> (f64, f64) {
    if !in_fire {
        return (accumulation_mean, base_std);
    }

    let gp = match gp {
        Some(gp) if gp.enabled => gp,
        _ => return (retirement_mean, base_std),
    };
    let years_to_fire = (retirement_start_age as i32 - current_age as i32).max(0) as f64;
    let years_in_retirement =
        (planning_horizon_age as i32 - retirement_start_age as i32).max(1) as f64;
    let years_from_fire = (i as f64 - years_to_fire).max(0.0);
    let t = (years_from_fire / years_in_retirement).clamp(0.0, 1.0);
    let bond_pct = (gp.bond_allocation_at_fire
        + t * (gp.bond_allocation_at_horizon - gp.bond_allocation_at_fire))
        .clamp(0.0, 1.0);
    let stock_pct = 1.0 - bond_pct;
    let bond_mean = net_annual_return(gp.bond_return_rate, annual_fee_rate);
    let bond_std = base_std * DEFAULT_BOND_VOLATILITY_RATIO;
    let blended_std = ((stock_pct * base_std).powi(2) + (bond_pct * bond_std).powi(2)).sqrt();
    (
        stock_pct * retirement_mean + bond_pct * bond_mean,
        blended_std,
    )
}

pub(crate) fn percentile(sorted: &[f64], p: f64) -> f64 {
    let idx = (sorted.len() as f64 * p).floor() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

pub(crate) fn net_annual_return(gross_return: f64, annual_fee_rate: f64) -> f64 {
    (gross_return - annual_fee_rate).max(-0.99)
}

pub(crate) fn end_of_year_value_of_monthly_contributions(
    monthly_amount: f64,
    annual_return: f64,
) -> f64 {
    if monthly_amount <= 0.0 || !monthly_amount.is_finite() {
        return 0.0;
    }
    let monthly_growth = (1.0 + annual_return).max(0.01).powf(1.0 / 12.0);
    let monthly_return = monthly_growth - 1.0;
    if monthly_return.abs() <= 1e-9 {
        monthly_amount * 12.0
    } else {
        monthly_amount * (monthly_growth.powi(12) - 1.0) / monthly_return
    }
}

pub(crate) fn plan_accumulation_return(plan: &RetirementPlan) -> f64 {
    net_annual_return(
        plan.investment.pre_retirement_annual_return,
        plan.investment.annual_investment_fee_rate,
    )
}

pub(crate) fn plan_retirement_return(plan: &RetirementPlan) -> f64 {
    net_annual_return(
        plan.investment.retirement_annual_return,
        plan.investment.annual_investment_fee_rate,
    )
}

// ─── Expense & income helpers ────────────────────────────────────────────────

/// Compute total annual expenses from expense buckets at a given simulation year.
/// Returns `(total_expenses, essential_expenses)`.
pub(crate) fn annual_expenses_at_year(
    budget: &ExpenseBudget,
    age: u32,
    years_from_now: u32,
    general_inflation: f64,
) -> (f64, f64) {
    let mut total = 0.0;
    let mut essential = 0.0;
    for (bucket, is_essential) in budget.all_buckets() {
        // Check age bounds
        if let Some(start) = bucket.start_age {
            if age < start {
                continue;
            }
        }
        if let Some(end) = bucket.end_age {
            if age >= end {
                continue;
            }
        }
        let rate = bucket.inflation_rate.unwrap_or(general_inflation);
        let annual = bucket.monthly_amount * 12.0 * (1.0 + rate).powi(years_from_now as i32);
        total += annual;
        if is_essential {
            essential += annual;
        }
    }
    (total, essential)
}

/// Like `annual_expenses_at_year` but uses a stochastic cumulative inflation factor
/// for buckets that have no custom `inflation_rate`, and deterministic `(1+rate)^years`
/// for buckets with an explicit rate (e.g. healthcare). This matches the old MC behaviour
/// where living expenses tracked the stochastic path and healthcare used its own rate.
pub(crate) fn annual_expenses_at_year_stochastic(
    budget: &ExpenseBudget,
    age: u32,
    years_from_now: u32,
    _general_inflation: f64,
    cumulative_inflation: f64,
) -> (f64, f64) {
    let mut total = 0.0;
    let mut essential = 0.0;
    for (bucket, is_essential) in budget.all_buckets() {
        if let Some(start) = bucket.start_age {
            if age < start {
                continue;
            }
        }
        if let Some(end) = bucket.end_age {
            if age >= end {
                continue;
            }
        }
        let annual = match bucket.inflation_rate {
            Some(rate) => {
                // Custom inflation rate: deterministic
                bucket.monthly_amount * 12.0 * (1.0 + rate).powi(years_from_now as i32)
            }
            None => {
                // General inflation: use stochastic cumulative factor
                bucket.monthly_amount * 12.0 * cumulative_inflation
            }
        };
        total += annual;
        if is_essential {
            essential += annual;
        }
    }
    (total, essential)
}

/// The income a single stream is scheduled to pay at `age`, before anything checks
/// whether there is a balance left to pay it out of.
fn scheduled_stream_annual_income(
    s: &RetirementIncomeStream,
    resolved_payouts: &HashMap<String, f64>,
    years_from_now: u32,
    inflation_rate: f64,
    cumulative_inflation: Option<f64>,
) -> f64 {
    let base_monthly = resolved_payouts
        .get(&s.id)
        .copied()
        .unwrap_or(s.monthly_amount.unwrap_or(0.0));
    let annual = base_monthly * 12.0;
    if let Some(r) = s.annual_growth_rate {
        // Custom growth rate: always deterministic
        annual * (1.0 + r).powi(years_from_now as i32)
    } else if s.adjust_for_inflation {
        match cumulative_inflation {
            Some(cum) => annual * cum,
            None => annual * (1.0 + inflation_rate).powi(years_from_now as i32),
        }
    } else {
        annual
    }
}

/// Like `plan_income_at_age` but accepts an optional stochastic `cumulative_inflation`
/// factor for inflation-indexed streams. When `cumulative_inflation` is `Some`, those
/// streams use the stochastic factor instead of `(1+rate)^years`.
pub(crate) fn plan_income_at_age_stochastic(
    streams: &[RetirementIncomeStream],
    resolved_payouts: &HashMap<String, f64>,
    age: u32,
    years_from_now: u32,
    inflation_rate: f64,
    cumulative_inflation: Option<f64>,
) -> f64 {
    streams
        .iter()
        .filter(|s| age >= s.start_age)
        .map(|s| {
            scheduled_stream_annual_income(
                s,
                resolved_payouts,
                years_from_now,
                inflation_rate,
                cumulative_inflation,
            )
        })
        .sum()
}

/// This year's withdrawals from the funds being drawn down, each capped at what its
/// balance can still pay.
///
/// Called on its own for the years before retirement, where the plan has no modelled
/// spending for the money to fund: a fund that starts paying at 65 still has to be
/// smaller by the time retirement begins at 70.
#[allow(clippy::too_many_arguments)]
pub(crate) fn drawdown_income_at_age(
    streams: &[RetirementIncomeStream],
    resolved_payouts: &HashMap<String, f64>,
    ledger: &mut DrawdownLedger,
    age: u32,
    years_from_now: u32,
    inflation_rate: f64,
    cumulative_inflation: Option<f64>,
    default_post_payout_return: f64,
) -> f64 {
    streams
        .iter()
        .filter(|s| s.is_drawdown() && age >= s.start_age)
        .map(|s| {
            let modeled_start_age = age.saturating_sub(years_from_now);
            let growth_years = age.saturating_sub(s.start_age.max(modeled_start_age));
            let cumulative_inflation_since_start =
                if s.annual_growth_rate.is_none() && s.adjust_for_inflation {
                    cumulative_inflation
                        .map(|cumulative| ledger.inflation_since_start(&s.id, cumulative))
                } else {
                    None
                };
            let scheduled = scheduled_stream_annual_income(
                s,
                resolved_payouts,
                growth_years,
                inflation_rate,
                cumulative_inflation_since_start,
            );
            let post_payout_return = s
                .post_payout_return
                .unwrap_or(default_post_payout_return)
                .max(-0.99);
            ledger.withdraw(&s.id, scheduled, age, post_payout_return)
        })
        .sum()
}

/// Plan income at `age` where a drawdown fund pays only what its remaining balance
/// covers, and stops for good once that balance is gone.
///
/// Every stream that is not in drawdown pays its scheduled amount, so a plan with no
/// drawdown fund returns exactly what `plan_income_at_age_stochastic` would.
#[allow(clippy::too_many_arguments)]
pub(crate) fn plan_income_at_age_with_drawdown(
    streams: &[RetirementIncomeStream],
    resolved_payouts: &HashMap<String, f64>,
    ledger: &mut DrawdownLedger,
    age: u32,
    years_from_now: u32,
    inflation_rate: f64,
    cumulative_inflation: Option<f64>,
    default_post_payout_return: f64,
) -> f64 {
    let scheduled: f64 = streams
        .iter()
        .filter(|s| !s.is_drawdown() && age >= s.start_age)
        .map(|s| {
            scheduled_stream_annual_income(
                s,
                resolved_payouts,
                years_from_now,
                inflation_rate,
                cumulative_inflation,
            )
        })
        .sum();
    scheduled
        + drawdown_income_at_age(
            streams,
            resolved_payouts,
            ledger,
            age,
            years_from_now,
            inflation_rate,
            cumulative_inflation,
            default_post_payout_return,
        )
}

/// Fund balance projected forward to `start_age` — the figure the payout rate is
/// applied to, and the pot a drawdown fund then draws against.
pub(crate) fn projected_dc_balance_at_start(
    s: &RetirementIncomeStream,
    current_age: u32,
    retirement_age: u32,
    default_accumulation_return: f64,
) -> f64 {
    let total_years = (s.start_age as i32 - current_age as i32).max(0) as u32;
    let contrib_years = (s.start_age.min(retirement_age) as i32 - current_age as i32).max(0) as u32;
    let growth_only_years = total_years - contrib_years;
    let r = s
        .accumulation_return
        .unwrap_or(default_accumulation_return)
        .max(-0.99);
    let initial = s.current_value.unwrap_or(0.0);
    let monthly_contrib = s.monthly_contribution.unwrap_or(0.0);
    let fv_lump = initial * (1.0 + r).powi(total_years as i32);
    let annual_contrib_end_value = end_of_year_value_of_monthly_contributions(monthly_contrib, r);
    let fv_annuity_at_stop = if r.abs() > 1e-9 {
        annual_contrib_end_value * ((1.0 + r).powi(contrib_years as i32) - 1.0) / r
    } else {
        monthly_contrib * 12.0 * contrib_years as f64
    };
    let fv_annuity = fv_annuity_at_stop * (1.0 + r).powi(growth_only_years as i32);
    fv_lump + fv_annuity
}

/// DC payout resolver: precompute the monthly payout from accumulated balance at start_age.
pub(crate) fn resolve_plan_dc_payouts(
    streams: &[RetirementIncomeStream],
    current_age: u32,
    retirement_age: u32,
    default_accumulation_return: f64,
) -> HashMap<String, f64> {
    streams
        .iter()
        .filter(|s| s.stream_type == StreamKind::DefinedContribution)
        .map(|s| {
            let payout_rate = s
                .payout_rate
                .unwrap_or(DEFAULT_DC_PAYOUT_ESTIMATE_RATE)
                .max(0.0);
            if s.start_age <= current_age {
                let fallback = s.current_value.unwrap_or(0.0).max(0.0) * payout_rate / 12.0;
                return (s.id.clone(), s.monthly_amount.unwrap_or(fallback).max(0.0));
            }
            let balance = projected_dc_balance_at_start(
                s,
                current_age,
                retirement_age,
                default_accumulation_return,
            );
            (s.id.clone(), balance * payout_rate / 12.0)
        })
        .collect()
}

/// The balances of the funds being drawn down, and the age each one empties at.
///
/// One of these belongs to a single projected path: the deterministic run, one
/// Monte Carlo simulation, one SORR scenario, or one required-capital trial. It
/// is what makes a fund's income depend on what earlier years already took out.
#[derive(Debug, Clone, Default)]
pub(crate) struct DrawdownLedger {
    balances: HashMap<String, f64>,
    exhausted_ages: HashMap<String, u32>,
    cumulative_inflation_at_start: HashMap<String, f64>,
}

impl DrawdownLedger {
    /// Hand a fund over to its payout phase the first year it is due to pay, opening
    /// it with the balance accumulation left it. Opening at the fund's own
    /// `start_age` rather than when retirement begins is what stops a fund that
    /// started paying earlier from sitting untouched until then. Returns whether
    /// this call opened one.
    pub(crate) fn open_if_due(
        &mut self,
        stream: &RetirementIncomeStream,
        age: u32,
        opening_balance: impl FnOnce() -> f64,
    ) -> bool {
        if !stream.is_drawdown() || age < stream.start_age || self.balances.contains_key(&stream.id)
        {
            return false;
        }
        self.balances
            .insert(stream.id.clone(), opening_balance().max(0.0));
        true
    }

    /// What is left in the fund, as at the start of the year.
    pub(crate) fn balance(&self, stream_id: &str) -> f64 {
        self.balances.get(stream_id).copied().unwrap_or(0.0)
    }

    /// Rebase a stochastic inflation path to the first modelled withdrawal so the
    /// opening draw is the payout rate itself and only later draws are escalated.
    fn inflation_since_start(&mut self, stream_id: &str, cumulative_inflation: f64) -> f64 {
        let at_start = self
            .cumulative_inflation_at_start
            .entry(stream_id.to_string())
            .or_insert(cumulative_inflation);
        cumulative_inflation / *at_start
    }

    /// Take this year's withdrawal, capped at what is actually there, then grow
    /// what survives it. Returns the amount genuinely paid, which is what the
    /// spending ledger may count as income.
    fn withdraw(
        &mut self,
        stream_id: &str,
        scheduled: f64,
        age: u32,
        post_payout_return: f64,
    ) -> f64 {
        let Some(balance) = self.balances.get_mut(stream_id) else {
            return 0.0;
        };
        let paid = scheduled.max(0.0).min(*balance);
        let remaining = (*balance - paid).max(0.0);
        *balance = remaining * (1.0 + post_payout_return);
        if remaining <= 0.0 {
            self.exhausted_ages
                .entry(stream_id.to_string())
                .or_insert(age);
        }
        paid
    }

    pub(crate) fn exhausted_ages(&self) -> &HashMap<String, u32> {
        &self.exhausted_ages
    }
}

/// Open every drawdown fund whose payouts are due to have started by `age`, at the
/// balance `projected_dc_balance_at_start` gives it: the same figure its payout is a
/// percentage of. Returns whether any fund opened this year.
pub(crate) fn open_due_drawdown_funds(
    ledger: &mut DrawdownLedger,
    streams: &[RetirementIncomeStream],
    age: u32,
    current_age: u32,
    retirement_age: u32,
    default_accumulation_return: f64,
) -> bool {
    let mut opened = false;
    for s in streams {
        opened |= ledger.open_if_due(s, age, || {
            projected_dc_balance_at_start(
                s,
                current_age,
                retirement_age,
                default_accumulation_return,
            )
        });
    }
    opened
}

/// A ledger for a path that models only the years from `retirement_age` onwards, with
/// any fund that started paying earlier already opened and drawn down to that age.
/// Without it a fund paying since 65 would still be full when retirement began at 70.
pub(crate) fn drawdown_ledger_entering_retirement(
    streams: &[RetirementIncomeStream],
    resolved_payouts: &HashMap<String, f64>,
    current_age: u32,
    retirement_age: u32,
    default_accumulation_return: f64,
    inflation_rate: f64,
    default_post_payout_return: f64,
) -> DrawdownLedger {
    let mut ledger = DrawdownLedger::default();
    if !streams
        .iter()
        .any(|s| s.is_drawdown() && s.start_age < retirement_age)
    {
        return ledger;
    }
    for age in current_age..retirement_age {
        open_due_drawdown_funds(
            &mut ledger,
            streams,
            age,
            current_age,
            retirement_age,
            default_accumulation_return,
        );
        drawdown_income_at_age(
            streams,
            resolved_payouts,
            &mut ledger,
            age,
            age - current_age,
            inflation_rate,
            None,
            default_post_payout_return,
        );
    }
    ledger
}

/// Compute total annual income from plan income streams at a given age.
pub(crate) fn plan_income_at_age(
    streams: &[RetirementIncomeStream],
    resolved_payouts: &HashMap<String, f64>,
    age: u32,
    years_from_now: u32,
    inflation_rate: f64,
) -> f64 {
    plan_income_at_age_stochastic(
        streams,
        resolved_payouts,
        age,
        years_from_now,
        inflation_rate,
        None,
    )
}

/// Advance pre-payout pension fund balances for plan income streams.
///
/// One year of `projected_dc_balance_at_start`: the same return fallback and the same
/// monthly contribution timing, so the balance a fund reaches at its start age is the
/// balance its payout is a percentage of, and the chart does not step at that age.
pub(crate) fn step_plan_pension_funds(
    streams: &[RetirementIncomeStream],
    balances: &mut HashMap<String, f64>,
    age: u32,
    in_fire: bool,
    default_accumulation_return: f64,
) {
    for s in streams {
        let has_accumulation =
            s.current_value.unwrap_or(0.0) > 0.0 || s.monthly_contribution.unwrap_or(0.0) > 0.0;
        if !has_accumulation {
            continue;
        }
        let current = *balances
            .get(&s.id)
            .unwrap_or(&s.current_value.unwrap_or(0.0));
        if age < s.start_age {
            // The same fallback `resolve_plan_dc_payouts` uses, so the balance
            // reported as an asset and the balance the payout is derived from
            // are the same balance.
            let r = s.accumulation_return.unwrap_or(default_accumulation_return);
            let contributions = if in_fire {
                0.0
            } else {
                end_of_year_value_of_monthly_contributions(s.monthly_contribution.unwrap_or(0.0), r)
            };
            let next = current * (1.0 + r) + contributions;
            balances.insert(s.id.clone(), next);
        } else {
            balances.insert(s.id.clone(), 0.0);
        }
    }
}

/// Plan-aware glide-path blending.
pub(crate) fn plan_blended_return(
    plan: &RetirementPlan,
    i: u32,
    in_fire: bool,
    retirement_start_age: u32,
) -> f64 {
    let accumulation_return = plan_accumulation_return(plan);
    let retirement_return = plan_retirement_return(plan);
    if !in_fire {
        return accumulation_return;
    }

    let gp = match plan.investment.glide_path.as_ref() {
        Some(gp) if gp.enabled => gp,
        _ => return retirement_return,
    };
    let years_to_fire =
        (retirement_start_age as i32 - plan.personal.current_age as i32).max(0) as f64;
    let years_in_retirement =
        (plan.personal.planning_horizon_age as i32 - retirement_start_age as i32).max(1) as f64;
    let years_from_fire = (i as f64 - years_to_fire).max(0.0);
    let t = (years_from_fire / years_in_retirement).clamp(0.0, 1.0);
    let bond_pct = (gp.bond_allocation_at_fire
        + t * (gp.bond_allocation_at_horizon - gp.bond_allocation_at_fire))
        .clamp(0.0, 1.0);
    let stock_pct = 1.0 - bond_pct;
    let bond_return = net_annual_return(
        gp.bond_return_rate,
        plan.investment.annual_investment_fee_rate,
    );
    stock_pct * retirement_return + bond_pct * bond_return
}

fn initial_required_capital_upper_bound(plan: &RetirementPlan, retirement_age: u32) -> f64 {
    let years_from_now = (retirement_age as i32 - plan.personal.current_age as i32).max(0) as u32;
    let resolved = resolve_plan_dc_payouts(
        &plan.income_streams,
        plan.personal.current_age,
        retirement_age,
        plan_accumulation_return(plan),
    );
    let (annual_expenses, _) = annual_expenses_at_year(
        &plan.expenses,
        retirement_age,
        years_from_now,
        plan.investment.inflation_rate,
    );
    let annual_income = plan_income_at_age(
        &plan.income_streams,
        &resolved,
        retirement_age,
        years_from_now,
        plan.investment.inflation_rate,
    );
    // Loose starting bound for binary search only. The final required capital
    // comes from the year-by-year feasibility ledger plus the doubling loop.
    (annual_expenses - annual_income).max(0.0) * REQUIRED_CAPITAL_SEED_MULTIPLE
}

fn retirement_feasible_from_capital(
    plan: &RetirementPlan,
    retirement_age: u32,
    starting_capital: f64,
) -> bool {
    let current_age = plan.personal.current_age;
    let horizon = plan.personal.planning_horizon_age;
    let inflation = plan.investment.inflation_rate;
    let years_to_retirement = (retirement_age as i32 - current_age as i32).max(0) as u32;
    let resolved_payouts = resolve_plan_dc_payouts(
        &plan.income_streams,
        current_age,
        retirement_age,
        plan_accumulation_return(plan),
    );

    // Sizing has to see a drawdown fund's income stop, or it would size the
    // portfolio against income the fund cannot actually pay for that long. A fund
    // that started paying before this retirement age arrives already part-drawn.
    let default_post_payout_return = plan_retirement_return(plan);
    let mut drawdown = drawdown_ledger_entering_retirement(
        &plan.income_streams,
        &resolved_payouts,
        current_age,
        retirement_age,
        plan_accumulation_return(plan),
        inflation,
        default_post_payout_return,
    );

    let mut buckets = initial_withdrawal_buckets(&plan.tax, starting_capital.max(0.0));
    for y in 0..=(horizon as i32 - retirement_age as i32).max(0) as u32 {
        let age = retirement_age + y;
        let years_from_now = years_to_retirement + y;
        open_due_drawdown_funds(
            &mut drawdown,
            &plan.income_streams,
            age,
            current_age,
            retirement_age,
            plan_accumulation_return(plan),
        );
        let annual_return = plan_blended_return(plan, years_from_now, true, retirement_age);
        let grown_buckets = apply_growth(buckets, annual_return);
        let (expenses, _) = annual_expenses_at_year(&plan.expenses, age, years_from_now, inflation);
        let income = plan_income_at_age_with_drawdown(
            &plan.income_streams,
            &resolved_payouts,
            &mut drawdown,
            age,
            years_from_now,
            inflation,
            None,
            default_post_payout_return,
        );
        // Required capital is a target-sizing problem: can the portfolio fund
        // the planned spending schedule? This drives the dashed "need" path.
        let outcome =
            apply_planned_spending_withdrawal(&grown_buckets, expenses, income, &plan.tax, age);
        let spending_gap = (expenses - income).max(0.0);
        if outcome.spending_funded < spending_gap * FUNDING_TOLERANCE {
            return false;
        }
        buckets = outcome.remaining_buckets;
    }

    let ending_portfolio = buckets.total();
    ending_portfolio > 0.0
}

/// Schedule-feasibility FI trigger computed by reusing the retirement ledger
/// with a binary search over starting capital at `retirement_age`.
pub fn try_compute_required_capital(plan: &RetirementPlan, retirement_age: u32) -> Option<f64> {
    let horizon = plan.personal.planning_horizon_age;
    if retirement_age > horizon {
        return Some(0.0);
    }
    if retirement_feasible_from_capital(plan, retirement_age, 0.0) {
        return Some(0.0);
    }

    let mut hi = initial_required_capital_upper_bound(plan, retirement_age).max(1.0);
    for _ in 0..MAX_REQUIRED_CAPITAL_DOUBLING_STEPS {
        if retirement_feasible_from_capital(plan, retirement_age, hi) {
            break;
        }
        if !hi.is_finite() || hi >= f64::MAX / 2.0 {
            return None;
        }
        hi *= 2.0;
    }
    if !retirement_feasible_from_capital(plan, retirement_age, hi) {
        return None;
    }

    let mut lo = 0.0;
    for _ in 0..50 {
        let mid = (lo + hi) / 2.0;
        if retirement_feasible_from_capital(plan, retirement_age, mid) {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    Some(hi)
}

pub fn compute_required_capital(plan: &RetirementPlan, retirement_age: u32) -> Option<f64> {
    try_compute_required_capital(plan, retirement_age)
}

pub(crate) type RequiredCapitalCache = HashMap<u32, Option<f64>>;

pub(crate) fn required_capital_for(
    plan: &RetirementPlan,
    retirement_age: u32,
    cache: &mut RequiredCapitalCache,
) -> Option<f64> {
    if let Some(required) = cache.get(&retirement_age) {
        return *required;
    }

    let required = try_compute_required_capital(plan, retirement_age);
    cache.insert(retirement_age, required);
    required
}

// ─── Plan-aware Deterministic Projection ────────────────────────────────────

pub fn project_retirement(plan: &RetirementPlan, current_portfolio: f64) -> FireProjection {
    project_retirement_with_mode(plan, current_portfolio, RetirementTimingMode::Fire)
}

pub(crate) fn retirement_start_decision(
    mode: RetirementTimingMode,
    age: u32,
    target_age: u32,
    portfolio: f64,
    required_capital: Option<f64>,
) -> Option<RetirementStartReason> {
    match mode {
        RetirementTimingMode::Fire
            if age >= target_age
                && required_capital.is_some_and(|required| portfolio >= required) =>
        {
            Some(RetirementStartReason::Funded)
        }
        RetirementTimingMode::Fire => None,
        RetirementTimingMode::Traditional
            if age >= target_age
                && required_capital.is_some_and(|required| portfolio >= required) =>
        {
            Some(RetirementStartReason::Funded)
        }
        RetirementTimingMode::Traditional if age >= target_age => {
            Some(RetirementStartReason::TargetAgeForced)
        }
        RetirementTimingMode::Traditional => None,
    }
}

pub fn project_retirement_with_mode(
    plan: &RetirementPlan,
    current_portfolio: f64,
    mode: RetirementTimingMode,
) -> FireProjection {
    let mut required_capital_cache = RequiredCapitalCache::new();
    project_retirement_with_mode_cached(plan, current_portfolio, mode, &mut required_capital_cache)
}

pub(crate) fn project_retirement_with_mode_cached(
    plan: &RetirementPlan,
    current_portfolio: f64,
    mode: RetirementTimingMode,
    required_capital_cache: &mut RequiredCapitalCache,
) -> FireProjection {
    let target_at_goal = required_capital_for(
        plan,
        plan.personal.target_retirement_age,
        required_capital_cache,
    );
    let coast_amount = {
        let years = plan.personal.target_retirement_age as i32 - plan.personal.current_age as i32;
        if years <= 0 {
            target_at_goal.unwrap_or(0.0)
        } else {
            target_at_goal
                .map(|target| target / (1.0 + plan_accumulation_return(plan)).powi(years))
                .unwrap_or(0.0)
        }
    };

    let start_year = chrono::Local::now().year() as u32;
    let current_age = plan.personal.current_age;
    let horizon_years =
        (plan.personal.planning_horizon_age as i32 - current_age as i32).max(1) as u32;
    let contrib_growth = plan
        .personal
        .salary_growth_rate
        .unwrap_or(plan.investment.contribution_growth_rate);
    let inflation = plan.investment.inflation_rate;

    let mut buckets = initial_withdrawal_buckets(&plan.tax, current_portfolio);
    let mut fire_age: Option<u32> = None;
    let mut fire_year: Option<u32> = None;
    let mut retirement_start_age: Option<u32> = None;
    let mut retirement_start_reason: Option<RetirementStartReason> = None;
    let mut portfolio_at_fire = 0.0;
    let mut funded_at_retirement = false;
    let mut in_fire = false;
    let mut actual_retirement_age = plan.personal.target_retirement_age;
    let mut resolved_payouts: Option<HashMap<String, f64>> = None;
    let mut drawdown = DrawdownLedger::default();
    let mut year_by_year = Vec::new();

    let mut pension_balances: HashMap<String, f64> = plan
        .income_streams
        .iter()
        .map(|s| (s.id.clone(), s.current_value.unwrap_or(0.0)))
        .collect();

    for i in 0..=horizon_years {
        let age = current_age + i;
        let year = start_year + i;
        let portfolio = buckets.total();

        if !in_fire {
            let required = required_capital_for(plan, age, required_capital_cache);
            if fire_age.is_none() && required.is_some_and(|target| portfolio >= target) {
                fire_age = Some(age);
                fire_year = Some(year);
                portfolio_at_fire = portfolio;
            }
            if let Some(start_reason) = retirement_start_decision(
                mode,
                age,
                plan.personal.target_retirement_age,
                portfolio,
                required,
            ) {
                in_fire = true;
                actual_retirement_age = age;
                retirement_start_age = Some(age);
                retirement_start_reason = Some(start_reason);
                if start_reason == RetirementStartReason::Funded {
                    funded_at_retirement = true;
                }
                resolved_payouts = Some(resolve_plan_dc_payouts(
                    &plan.income_streams,
                    current_age,
                    age,
                    plan_accumulation_return(plan),
                ));
            }
        }

        // A fund can start paying years before retirement begins, so it is handed
        // over to the ledger at its own start age rather than at the retirement
        // decision, at the balance accumulation left it.
        let opened = open_due_drawdown_funds(
            &mut drawdown,
            &plan.income_streams,
            age,
            current_age,
            retirement_start_age.unwrap_or(age),
            plan_accumulation_return(plan),
        );
        if opened && !in_fire {
            // The payouts a fund reaching its start age needs, before the retirement
            // decision has a set to give it. Contributions stop at the earlier of the
            // start age and retirement, so every fund already paying gets the same
            // figure here as it will when that decision runs.
            resolved_payouts = Some(resolve_plan_dc_payouts(
                &plan.income_streams,
                current_age,
                age,
                plan_accumulation_return(plan),
            ));
        }

        // Counted after the hand-over above, because a fund that starts paying in
        // this same year is the ledger's from now on.
        let pension_assets: f64 = plan
            .income_streams
            .iter()
            .map(|stream| {
                if age >= stream.start_age {
                    // An annuitised pot is gone at start age; one in drawdown is
                    // still an asset, and shrinking.
                    return drawdown.balance(&stream.id);
                }
                let has_accumulation = stream.current_value.unwrap_or(0.0) > 0.0
                    || stream.monthly_contribution.unwrap_or(0.0) > 0.0;
                if !has_accumulation {
                    return 0.0;
                }
                *pension_balances
                    .get(&stream.id)
                    .unwrap_or(&stream.current_value.unwrap_or(0.0))
            })
            .sum();

        let r = plan_blended_return(plan, i, in_fire, actual_retirement_age);

        if in_fire {
            let payouts = resolved_payouts.as_ref().unwrap();
            let (total_expenses, _) = annual_expenses_at_year(&plan.expenses, age, i, inflation);
            let income = plan_income_at_age_with_drawdown(
                &plan.income_streams,
                payouts,
                &mut drawdown,
                age,
                i,
                inflation,
                None,
                plan_retirement_return(plan),
            );

            let grown_buckets = apply_growth(buckets, r);
            let outcome = apply_planned_spending_withdrawal(
                &grown_buckets,
                total_expenses,
                income,
                &plan.tax,
                age,
            );

            let shortfall = (total_expenses - outcome.spending_funded - income).max(0.0);
            let remaining_buckets = outcome.remaining_buckets;
            let portfolio_end_value = remaining_buckets.total().max(0.0);
            year_by_year.push(YearlySnapshot {
                age,
                year,
                phase: "fire".to_string(),
                portfolio_value: portfolio.max(0.0),
                portfolio_end_value,
                annual_contribution: 0.0,
                annual_withdrawal: outcome.spending_funded + income,
                annual_income: income,
                net_withdrawal_from_portfolio: outcome.spending_funded,
                pension_assets,
                annual_taxes: Some(outcome.tax_amount),
                gross_withdrawal: Some(outcome.gross_withdrawal),
                planned_expenses: Some(total_expenses),
                funded_expenses: Some(outcome.spending_funded + income),
                annual_shortfall: Some(shortfall),
            });

            buckets = remaining_buckets;
        } else {
            // A fund can be paying while the plan is still accumulating. There is no
            // modelled spending for that income to fund, but the withdrawal still has
            // to leave the fund, or the pot would be whole again at retirement.
            let income = match resolved_payouts.as_ref() {
                Some(payouts) => drawdown_income_at_age(
                    &plan.income_streams,
                    payouts,
                    &mut drawdown,
                    age,
                    i,
                    inflation,
                    None,
                    plan_retirement_return(plan),
                ),
                None => 0.0,
            };
            let monthly_contribution =
                plan.investment.monthly_contribution * (1.0 + contrib_growth).powi(i as i32);
            let annual_contribution = monthly_contribution * 12.0;
            let contribution_end_value =
                end_of_year_value_of_monthly_contributions(monthly_contribution, r);
            let grown_buckets = apply_growth(buckets, r);
            let next_buckets = add_contribution(grown_buckets, contribution_end_value, &plan.tax);
            let portfolio_end_value = next_buckets.total().max(0.0);

            year_by_year.push(YearlySnapshot {
                age,
                year,
                phase: "accumulation".to_string(),
                portfolio_value: portfolio,
                portfolio_end_value,
                annual_contribution,
                annual_withdrawal: 0.0,
                annual_income: income,
                net_withdrawal_from_portfolio: 0.0,
                pension_assets,
                annual_taxes: None,
                gross_withdrawal: None,
                planned_expenses: None,
                funded_expenses: None,
                annual_shortfall: None,
            });

            buckets = next_buckets;
        }

        step_plan_pension_funds(
            &plan.income_streams,
            &mut pension_balances,
            age,
            in_fire,
            plan_accumulation_return(plan),
        );
    }

    let mut income_stream_exhaustion: Vec<IncomeStreamExhaustion> = plan
        .income_streams
        .iter()
        .filter_map(|stream| {
            drawdown
                .exhausted_ages()
                .get(&stream.id)
                .map(|age| IncomeStreamExhaustion {
                    stream_id: stream.id.clone(),
                    label: stream.label.clone(),
                    exhausted_age: *age,
                })
        })
        .collect();
    income_stream_exhaustion.sort_by_key(|entry| entry.exhausted_age);

    FireProjection {
        fire_age,
        fire_year,
        retirement_start_age,
        retirement_start_reason,
        portfolio_at_fire,
        funded_at_retirement,
        coast_fire_amount: coast_amount,
        coast_fire_reached: target_at_goal.is_some() && current_portfolio >= coast_amount,
        year_by_year,
        income_stream_exhaustion,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;

    fn base_plan() -> RetirementPlan {
        RetirementPlan {
            version: None,
            personal: PersonalProfile {
                birth_year_month: None,
                current_age: 35,
                target_retirement_age: 55,
                planning_horizon_age: 90,
                current_annual_salary: None,
                salary_growth_rate: None,
            },
            expenses: ExpenseBudget {
                items: vec![ExpenseBucket {
                    id: None,
                    label: None,
                    monthly_amount: 3_000.0,
                    inflation_rate: None,
                    start_age: None,
                    end_age: None,
                    essential: None,
                }],
            },
            income_streams: vec![],
            investment: InvestmentAssumptions {
                pre_retirement_annual_return: 0.07,
                retirement_annual_return: 0.07,
                annual_investment_fee_rate: 0.0,
                annual_volatility: 0.12,
                inflation_rate: 0.02,
                monthly_contribution: 2_000.0,
                contribution_growth_rate: 0.0,
                glide_path: None,
            },
            tax: None,
            currency: "EUR".to_string(),
        }
    }

    #[test]
    fn sample_return_returns_mean_when_volatility_is_zero() {
        let mut rng = rand::rngs::StdRng::seed_from_u64(42);
        let sampled = sample_return(&mut rng, 0.052, 0.0);
        assert!((sampled - 0.052).abs() < f64::EPSILON);
    }

    #[test]
    fn monthly_contributions_receive_in_year_growth() {
        let value = end_of_year_value_of_monthly_contributions(1_000.0, 0.12);

        assert!(
            value > 12_000.0,
            "monthly deposits should not be treated as one year-end lump sum"
        );
    }

    #[test]
    fn phase_returns_subtract_fee() {
        let mut p = base_plan();
        p.investment.pre_retirement_annual_return = 0.0577;
        p.investment.retirement_annual_return = 0.0337;
        p.investment.annual_investment_fee_rate = 0.006;

        assert!((plan_accumulation_return(&p) - 0.0517).abs() < 0.000001);
        assert!((plan_retirement_return(&p) - 0.0277).abs() < 0.000001);
        assert!((plan_blended_return(&p, 0, false, 55) - 0.0517).abs() < 0.000001);
        assert!((plan_blended_return(&p, 20, true, 55) - 0.0277).abs() < 0.000001);
    }

    #[test]
    fn required_capital_uses_retirement_return() {
        let mut high_return = base_plan();
        high_return.investment.retirement_annual_return = 0.07;

        let mut low_return = high_return.clone();
        low_return.investment.retirement_annual_return = 0.03;

        let high_return_target =
            compute_required_capital(&high_return, high_return.personal.target_retirement_age)
                .expect("target should be reachable");
        let low_return_target =
            compute_required_capital(&low_return, low_return.personal.target_retirement_age)
                .expect("target should be reachable");

        assert!(
            low_return_target > high_return_target,
            "lower retirement return should require more capital: {low_return_target} <= {high_return_target}"
        );
    }

    #[test]
    fn required_capital_searches_above_old_one_trillion_cutoff() {
        let mut p = base_plan();
        p.personal.current_age = 54;
        p.personal.target_retirement_age = 55;
        p.personal.planning_horizon_age = 90;
        p.expenses.items[0].monthly_amount = 1_000_000.0;
        p.investment.inflation_rate = 0.30;
        p.investment.retirement_annual_return = -0.10;

        let target = compute_required_capital(&p, p.personal.target_retirement_age)
            .expect("target should be reachable");

        assert!(
            target > 1_000_000_000_000.0,
            "target should not be capped at the old 1T search bound: {target}"
        );
        assert!(
            retirement_feasible_from_capital(&p, p.personal.target_retirement_age, target * 1.001),
            "returned target should be a feasible upper bound"
        );
    }

    #[test]
    fn required_capital_reports_unreachable_without_magic_sentinel() {
        let mut p = base_plan();
        p.expenses.items[0].monthly_amount = f64::MAX / 4.0;

        assert!(try_compute_required_capital(&p, p.personal.target_retirement_age).is_none());
        assert_eq!(
            compute_required_capital(&p, p.personal.target_retirement_age),
            None
        );
    }

    #[test]
    fn projection_reaches_fire() {
        let p = base_plan();
        let proj = project_retirement(&p, 100_000.0);
        assert!(proj.fire_age.is_some(), "should reach FIRE");
        assert!(proj.fire_age.unwrap() <= p.personal.target_retirement_age);
    }

    #[test]
    fn fire_mode_reports_early_fi_but_starts_withdrawals_at_target_age() {
        let p = base_plan();
        let proj = project_retirement(&p, 100_000.0);

        let fi_age = proj.fire_age.expect("should reach FI");
        assert!(fi_age <= p.personal.target_retirement_age);
        assert_eq!(
            proj.retirement_start_age,
            Some(p.personal.target_retirement_age)
        );
        assert!(
            proj.year_by_year
                .iter()
                .filter(|s| s.age < p.personal.target_retirement_age)
                .all(|s| s.phase == "accumulation"),
            "reaching FI early should not start withdrawals before the desired retirement age"
        );
    }

    #[test]
    fn projection_snapshots_continuous() {
        let p = base_plan();
        let proj = project_retirement(&p, 50_000.0);
        let expected_len = (p.personal.planning_horizon_age - p.personal.current_age + 1) as usize;
        assert_eq!(proj.year_by_year.len(), expected_len);
    }

    #[test]
    fn net_target_higher_when_retiring_before_pension_starts() {
        let mut p = base_plan();
        // Pension starts at 60, target FIRE at 55
        p.personal.target_retirement_age = 55;
        p.income_streams.push(RetirementIncomeStream {
            id: "pension".into(),
            label: "Pension".into(),
            stream_type: StreamKind::DefinedBenefit,
            start_age: 60,
            adjust_for_inflation: false,
            annual_growth_rate: None,
            monthly_amount: Some(1_200.0),
            linked_account_id: None,
            current_value: None,
            monthly_contribution: None,
            accumulation_return: None,
            payout_rate: None,
            payout_mode: None,
            post_payout_return: None,
        });
        let target_at_50 = compute_required_capital(&p, 50).expect("target should be reachable");
        let target_at_60 = compute_required_capital(&p, 60).expect("target should be reachable");
        assert!(
            target_at_50 > target_at_60,
            "target at 50 ({}) should be larger than at 60 ({}) because pension is not yet available",
            target_at_50, target_at_60,
        );
    }

    #[test]
    fn dc_payout_varies_with_retirement_age() {
        // DC fund: 10k initial, 200/mo contribution, 4% return, starts paying at 65
        let dc = RetirementIncomeStream {
            id: "dc".into(),
            label: "DC Fund".into(),
            stream_type: StreamKind::DefinedContribution,
            start_age: 65,
            adjust_for_inflation: false,
            annual_growth_rate: None,
            monthly_amount: None,
            linked_account_id: None,
            current_value: Some(10_000.0),
            monthly_contribution: Some(200.0),
            accumulation_return: Some(0.04),
            payout_rate: None,
            payout_mode: None,
            post_payout_return: None,
        };
        // Retiring at 50: contributions stop at 50, 15 years of growth-only until 65
        let payouts_at_50 = resolve_plan_dc_payouts(std::slice::from_ref(&dc), 35, 50, 0.04);
        // Retiring at 55: contributions until 55, 10 years of growth-only until 65
        let payouts_at_55 = resolve_plan_dc_payouts(&[dc], 35, 55, 0.04);
        let payout_50 = payouts_at_50.get("dc").unwrap();
        let payout_55 = payouts_at_55.get("dc").unwrap();
        // Longer contribution period -> higher payout
        assert!(
            payout_55 > payout_50,
            "DC payout with retirement at 55 ({:.0}) should exceed retirement at 50 ({:.0})",
            payout_55,
            payout_50,
        );
    }

    #[test]
    fn dc_payout_uses_default_accumulation_return_when_stream_return_missing() {
        let dc = RetirementIncomeStream {
            id: "dc".into(),
            label: "RRSP".into(),
            stream_type: StreamKind::DefinedContribution,
            start_age: 65,
            adjust_for_inflation: false,
            annual_growth_rate: None,
            monthly_amount: None,
            linked_account_id: None,
            current_value: Some(100_000.0),
            monthly_contribution: None,
            accumulation_return: None,
            payout_rate: None,
            payout_mode: None,
            post_payout_return: None,
        };

        let low = resolve_plan_dc_payouts(std::slice::from_ref(&dc), 45, 65, 0.02);
        let high = resolve_plan_dc_payouts(&[dc], 45, 65, 0.06);

        assert!(high.get("dc").unwrap() > low.get("dc").unwrap());
    }

    #[test]
    fn dc_payout_without_monthly_amount_uses_estimate_rate() {
        let dc = RetirementIncomeStream {
            id: "dc".into(),
            label: "RRSP".into(),
            stream_type: StreamKind::DefinedContribution,
            start_age: 65,
            adjust_for_inflation: false,
            annual_growth_rate: None,
            monthly_amount: None,
            linked_account_id: None,
            current_value: Some(120_000.0),
            monthly_contribution: None,
            accumulation_return: Some(0.0),
            payout_rate: None,
            payout_mode: None,
            post_payout_return: None,
        };

        let payouts = resolve_plan_dc_payouts(&[dc], 65, 65, 0.04);

        assert!(
            (payouts.get("dc").copied().unwrap() - 350.0).abs() < 0.01,
            "120k fund should estimate 3.5%/yr / 12 as monthly payout"
        );
    }

    #[test]
    fn dc_payout_uses_stream_payout_rate_override() {
        let dc = RetirementIncomeStream {
            id: "dc".into(),
            label: "RRSP".into(),
            stream_type: StreamKind::DefinedContribution,
            start_age: 65,
            adjust_for_inflation: false,
            annual_growth_rate: None,
            monthly_amount: None,
            linked_account_id: None,
            current_value: Some(120_000.0),
            monthly_contribution: None,
            accumulation_return: Some(0.0),
            payout_rate: Some(0.06),
            payout_mode: None,
            post_payout_return: None,
        };

        let payouts = resolve_plan_dc_payouts(&[dc], 45, 65, 0.04);

        assert!(
            (payouts.get("dc").copied().unwrap() - 600.0).abs() < 0.01,
            "120k fund at a 6%/yr payout rate should pay 600/mo"
        );
    }

    #[test]
    fn already_started_dc_fallback_uses_stream_payout_rate_override() {
        let dc = RetirementIncomeStream {
            id: "dc".into(),
            label: "Active RRIF".into(),
            stream_type: StreamKind::DefinedContribution,
            start_age: 60,
            adjust_for_inflation: false,
            annual_growth_rate: None,
            monthly_amount: None,
            linked_account_id: None,
            current_value: Some(120_000.0),
            monthly_contribution: None,
            accumulation_return: None,
            payout_rate: Some(0.06),
            payout_mode: None,
            post_payout_return: None,
        };

        let payouts = resolve_plan_dc_payouts(&[dc], 65, 65, 0.04);

        assert!(
            (payouts.get("dc").copied().unwrap() - 600.0).abs() < 0.01,
            "already-started fund should fall back to its own payout rate"
        );
    }

    #[test]
    fn already_started_dc_payout_respects_declared_monthly_amount() {
        let dc = RetirementIncomeStream {
            id: "dc".into(),
            label: "Active RRIF".into(),
            stream_type: StreamKind::DefinedContribution,
            start_age: 60,
            adjust_for_inflation: false,
            annual_growth_rate: None,
            monthly_amount: Some(1_250.0),
            linked_account_id: None,
            current_value: Some(500_000.0),
            monthly_contribution: Some(500.0),
            accumulation_return: Some(0.04),
            payout_rate: None,
            payout_mode: None,
            post_payout_return: None,
        };

        let payouts = resolve_plan_dc_payouts(&[dc], 65, 65, 0.04);

        assert_eq!(payouts.get("dc").copied(), Some(1_250.0));
    }

    #[test]
    fn pension_assets_stop_showing_once_dc_payout_starts() {
        let mut plan = base_plan();
        plan.personal.current_age = 63;
        plan.personal.target_retirement_age = 65;
        plan.personal.planning_horizon_age = 68;
        plan.investment.monthly_contribution = 0.0;
        plan.income_streams.push(RetirementIncomeStream {
            id: "dc".into(),
            label: "RRSP".into(),
            stream_type: StreamKind::DefinedContribution,
            start_age: 65,
            adjust_for_inflation: false,
            annual_growth_rate: None,
            monthly_amount: None,
            linked_account_id: None,
            current_value: Some(100_000.0),
            monthly_contribution: Some(500.0),
            accumulation_return: Some(0.04),
            payout_rate: None,
            payout_mode: None,
            post_payout_return: None,
        });

        let projection = project_retirement(&plan, 500_000.0);
        let age_64 = projection
            .year_by_year
            .iter()
            .find(|snapshot| snapshot.age == 64)
            .expect("age 64 snapshot should exist");
        let age_65 = projection
            .year_by_year
            .iter()
            .find(|snapshot| snapshot.age == 65)
            .expect("age 65 snapshot should exist");

        assert!(age_64.pension_assets > 0.0);
        assert_eq!(age_65.pension_assets, 0.0);
    }

    /// A plan whose only income is one fund, arranged so the arithmetic is exact:
    /// a 100k balance that neither grows nor receives contributions before its
    /// start age, which is also the age retirement begins.
    fn plan_with_fund(
        payout_rate: f64,
        payout_mode: Option<PayoutMode>,
        post_payout_return: f64,
        indexed: bool,
    ) -> RetirementPlan {
        let mut plan = base_plan();
        plan.personal.current_age = 64;
        plan.personal.target_retirement_age = 65;
        plan.personal.planning_horizon_age = 95;
        plan.investment.monthly_contribution = 0.0;
        plan.income_streams.push(RetirementIncomeStream {
            id: "dc".into(),
            label: "RRSP".into(),
            stream_type: StreamKind::DefinedContribution,
            start_age: 65,
            adjust_for_inflation: indexed,
            annual_growth_rate: None,
            monthly_amount: None,
            linked_account_id: None,
            current_value: Some(100_000.0),
            monthly_contribution: None,
            accumulation_return: Some(0.0),
            payout_rate: Some(payout_rate),
            payout_mode,
            post_payout_return: Some(post_payout_return),
        });
        plan
    }

    fn income_at(projection: &FireProjection, age: u32) -> f64 {
        projection
            .year_by_year
            .iter()
            .find(|snapshot| snapshot.age == age)
            .unwrap_or_else(|| panic!("age {age} snapshot should exist"))
            .annual_income
    }

    fn pension_assets_at(projection: &FireProjection, age: u32) -> f64 {
        projection
            .year_by_year
            .iter()
            .find(|snapshot| snapshot.age == age)
            .unwrap_or_else(|| panic!("age {age} snapshot should exist"))
            .pension_assets
    }

    #[test]
    fn a_drawdown_fund_empties_and_its_income_stops() {
        // 100k drawn at 12%/yr with nothing left growing: eight years of 12k takes
        // it to 4k, which is all the ninth year can pay.
        let projection = project_retirement(
            &plan_with_fund(0.12, Some(PayoutMode::Drawdown), 0.0, false),
            5_000_000.0,
        );

        assert_eq!(
            projection.income_stream_exhaustion,
            vec![IncomeStreamExhaustion {
                stream_id: "dc".into(),
                label: "RRSP".into(),
                exhausted_age: 73,
            }],
        );
        assert!((income_at(&projection, 72) - 12_000.0).abs() < 1e-6);
        assert!(
            (income_at(&projection, 73) - 4_000.0).abs() < 1e-6,
            "the last withdrawal is capped at what is left, not paid in full"
        );
        assert_eq!(income_at(&projection, 74), 0.0);
        assert_eq!(income_at(&projection, 95), 0.0);
        assert!(
            projection
                .year_by_year
                .iter()
                .all(|snapshot| snapshot.pension_assets >= 0.0),
            "a fund must never be overdrawn"
        );
    }

    #[test]
    fn an_annuity_fund_at_the_same_rate_pays_to_the_horizon() {
        // The shipped behaviour, and the reason drawdown had to be opt-in: at 12%
        // on a pot earning nothing, an annuity still pays every year.
        let projection = project_retirement(&plan_with_fund(0.12, None, 0.0, false), 5_000_000.0);

        assert!(projection.income_stream_exhaustion.is_empty());
        for age in [73, 80, 95] {
            assert!(
                (income_at(&projection, age) - 12_000.0).abs() < 1e-6,
                "an annuitised pot should still be paying at age {age}"
            );
        }
    }

    #[test]
    fn an_explicit_annuity_projects_identically_to_an_absent_payout_mode() {
        let stored = project_retirement(&plan_with_fund(0.12, None, 0.0, false), 5_000_000.0);
        let explicit = project_retirement(
            &plan_with_fund(0.12, Some(PayoutMode::Annuity), 0.0, false),
            5_000_000.0,
        );

        let income = |projection: &FireProjection| -> Vec<f64> {
            projection
                .year_by_year
                .iter()
                .map(|snapshot| snapshot.annual_income)
                .collect()
        };
        let portfolio = |projection: &FireProjection| -> Vec<f64> {
            projection
                .year_by_year
                .iter()
                .map(|snapshot| snapshot.portfolio_end_value)
                .collect()
        };

        assert_eq!(income(&stored), income(&explicit));
        assert_eq!(portfolio(&stored), portfolio(&explicit));
    }

    #[test]
    fn a_drawdown_below_its_payout_phase_return_never_empties() {
        let projection = project_retirement(
            &plan_with_fund(0.03, Some(PayoutMode::Drawdown), 0.05, false),
            5_000_000.0,
        );

        assert!(projection.income_stream_exhaustion.is_empty());
        assert!((income_at(&projection, 95) - 3_000.0).abs() < 1e-6);
        assert!(
            pension_assets_at(&projection, 95) > 100_000.0,
            "a 3% draw on a fund earning 5% should leave the pot larger, not smaller"
        );
    }

    #[test]
    fn an_indexed_drawdown_empties_before_a_fixed_one() {
        let fixed = project_retirement(
            &plan_with_fund(0.12, Some(PayoutMode::Drawdown), 0.0, false),
            5_000_000.0,
        );
        let indexed = project_retirement(
            &plan_with_fund(0.12, Some(PayoutMode::Drawdown), 0.0, true),
            5_000_000.0,
        );

        let fixed_age = fixed.income_stream_exhaustion[0].exhausted_age;
        let indexed_age = indexed.income_stream_exhaustion[0].exhausted_age;
        assert!(
            indexed_age < fixed_age,
            "an indexed draw empties the pot sooner: indexed {indexed_age}, fixed {fixed_age}"
        );
    }

    #[test]
    fn pension_assets_keep_counting_a_drawdown_fund_in_payout() {
        let projection = project_retirement(
            &plan_with_fund(0.12, Some(PayoutMode::Drawdown), 0.0, false),
            5_000_000.0,
        );

        assert!((pension_assets_at(&projection, 65) - 100_000.0).abs() < 1e-6);
        assert!(
            (pension_assets_at(&projection, 66) - 88_000.0).abs() < 1e-6,
            "the pot is still an asset once it starts paying, minus what it paid"
        );
        assert_eq!(pension_assets_at(&projection, 74), 0.0);
    }

    /// A fund that starts paying before the plan retires. Opening the ledger only
    /// when retirement begins left the pot out of the chart from 65, paying nothing,
    /// and back whole at 70.
    #[test]
    fn a_drawdown_starting_before_retirement_is_drawn_from_its_start_age() {
        let mut plan = plan_with_fund(0.12, Some(PayoutMode::Drawdown), 0.0, false);
        plan.personal.current_age = 60;
        plan.personal.target_retirement_age = 70;

        let projection = project_retirement(&plan, 5_000_000.0);

        assert_eq!(projection.retirement_start_age, Some(70));
        for (age, expected) in [(65, 100_000.0), (66, 88_000.0), (70, 40_000.0)] {
            let actual = pension_assets_at(&projection, age);
            assert!(
                (actual - expected).abs() < 1e-6,
                "at {age} the fund should hold {expected}, not {actual}"
            );
        }
        assert!(
            (income_at(&projection, 66) - 12_000.0).abs() < 1e-6,
            "a fund whose payouts start at 65 is paying at 66, retired or not"
        );
        assert_eq!(
            projection.income_stream_exhaustion,
            vec![IncomeStreamExhaustion {
                stream_id: "dc".into(),
                label: "RRSP".into(),
                exhausted_age: 73,
            }],
            "five years of payouts before retirement empty it five years sooner"
        );
    }

    /// The payout-phase return falls back to the plan's retirement return after fees,
    /// which is the figure the sidebar shows for it and the figure an override
    /// replaces.
    #[test]
    fn the_default_payout_phase_return_is_net_of_fees() {
        let fund_path = |post_payout_return: Option<f64>| -> Vec<f64> {
            let mut plan = plan_with_fund(0.05, Some(PayoutMode::Drawdown), 0.0, false);
            plan.investment.retirement_annual_return = 0.0337;
            plan.investment.annual_investment_fee_rate = 0.006;
            plan.income_streams[0].post_payout_return = post_payout_return;
            let projection = project_retirement(&plan, 5_000_000.0);
            (65..=95)
                .map(|age| pension_assets_at(&projection, age))
                .collect()
        };

        assert_eq!(fund_path(None), fund_path(Some(0.0337 - 0.006)));
        assert_ne!(
            fund_path(None),
            fund_path(Some(0.0337)),
            "the gross return is not what an absent override means"
        );
    }

    /// One balance calculation across both phases: the year a fund starts paying, its
    /// opening balance is the year before's grown on and contributed to, and its first
    /// payout is the payout rate applied to that same balance.
    #[test]
    fn a_fund_balance_is_continuous_at_its_start_age() {
        let mut plan = base_plan();
        plan.personal.current_age = 60;
        plan.personal.target_retirement_age = 65;
        plan.personal.planning_horizon_age = 95;
        plan.investment.annual_investment_fee_rate = 0.006;
        plan.income_streams.push(RetirementIncomeStream {
            id: "dc".into(),
            label: "RRSP".into(),
            stream_type: StreamKind::DefinedContribution,
            start_age: 65,
            adjust_for_inflation: false,
            annual_growth_rate: None,
            monthly_amount: None,
            linked_account_id: None,
            current_value: Some(200_000.0),
            monthly_contribution: Some(500.0),
            // Both phases have to read the same plan-level return, not a 4% stand-in.
            accumulation_return: None,
            payout_rate: Some(0.05),
            payout_mode: Some(PayoutMode::Drawdown),
            post_payout_return: None,
        });

        let projection = project_retirement(&plan, 5_000_000.0);

        let r = plan_accumulation_return(&plan);
        let before = pension_assets_at(&projection, 64);
        let at_start = pension_assets_at(&projection, 65);
        let stepped = before * (1.0 + r) + end_of_year_value_of_monthly_contributions(500.0, r);
        assert!(
            (at_start - stepped).abs() < 1e-6,
            "the pot should not jump at the payout age: {before} grows to {stepped}, chart says {at_start}"
        );
        assert!(
            (income_at(&projection, 65) - 0.05 * at_start).abs() < 1e-6,
            "the first payout is the rate applied to the balance the chart shows"
        );
    }

    #[test]
    fn an_escalating_drawdown_starts_at_the_payout_rate() {
        for (indexed, custom_growth, expected_second_draw) in
            [(true, None, 12_240.0), (false, Some(0.10), 13_200.0)]
        {
            let mut plan = plan_with_fund(0.12, Some(PayoutMode::Drawdown), 0.0, indexed);
            plan.income_streams[0].annual_growth_rate = custom_growth;
            let projection = project_retirement(&plan, 5_000_000.0);

            assert!(
                (income_at(&projection, 65) - 12_000.0).abs() < 1e-6,
                "the first draw must be 12% of the 100k opening balance"
            );
            assert!(
                (income_at(&projection, 66) - expected_second_draw).abs() < 1e-6,
                "growth should begin in the year after the fund starts paying"
            );
        }

        let mut already_started = plan_with_fund(0.12, Some(PayoutMode::Drawdown), 0.0, true);
        already_started.personal.current_age = 65;
        already_started.income_streams[0].start_age = 60;
        let projection = project_retirement(&already_started, 5_000_000.0);
        assert!((income_at(&projection, 65) - 12_000.0).abs() < 1e-6);
    }

    #[test]
    fn stochastic_inflation_escalates_drawdown_from_its_start_age() {
        let mut plan = plan_with_fund(0.12, Some(PayoutMode::Drawdown), 0.0, true);
        plan.personal.current_age = 60;
        let stream = &plan.income_streams[0];
        let payouts = resolve_plan_dc_payouts(
            &plan.income_streams,
            plan.personal.current_age,
            plan.personal.target_retirement_age,
            0.0,
        );
        let mut ledger = DrawdownLedger::default();
        ledger.open_if_due(stream, 65, || 100_000.0);

        let first = drawdown_income_at_age(
            &plan.income_streams,
            &payouts,
            &mut ledger,
            65,
            5,
            0.02,
            Some(1.25),
            0.0,
        );
        let second = drawdown_income_at_age(
            &plan.income_streams,
            &payouts,
            &mut ledger,
            66,
            6,
            0.02,
            Some(1.275),
            0.0,
        );

        assert!((first - 12_000.0).abs() < 1e-6);
        assert!((second - 12_240.0).abs() < 1e-6);
    }

    #[test]
    fn a_fund_balance_is_continuous_with_a_negative_return() {
        let mut plan = base_plan();
        plan.personal.current_age = 60;
        plan.personal.target_retirement_age = 65;
        plan.personal.planning_horizon_age = 95;
        plan.investment.monthly_contribution = 0.0;
        plan.income_streams.push(RetirementIncomeStream {
            id: "dc-negative".into(),
            label: "RRSP".into(),
            stream_type: StreamKind::DefinedContribution,
            start_age: 65,
            adjust_for_inflation: false,
            annual_growth_rate: None,
            monthly_amount: None,
            linked_account_id: None,
            current_value: Some(200_000.0),
            monthly_contribution: Some(500.0),
            accumulation_return: Some(-0.10),
            payout_rate: Some(0.05),
            payout_mode: Some(PayoutMode::Drawdown),
            post_payout_return: Some(0.0),
        });

        let projection = project_retirement(&plan, 5_000_000.0);
        let before = pension_assets_at(&projection, 64);
        let at_start = pension_assets_at(&projection, 65);
        let expected = before * 0.90 + end_of_year_value_of_monthly_contributions(500.0, -0.10);

        assert!(
            (at_start - expected).abs() < 1e-6,
            "the negative-return pot should continue from {before} to {expected}, not {at_start}"
        );
    }

    #[test]
    fn an_unset_fund_return_grows_the_balance_at_the_plan_rate_net_of_fees() {
        let mut plan = base_plan();
        plan.personal.current_age = 60;
        plan.personal.target_retirement_age = 65;
        plan.personal.planning_horizon_age = 70;
        plan.investment.monthly_contribution = 0.0;
        plan.investment.pre_retirement_annual_return = 0.10;
        plan.investment.annual_investment_fee_rate = 0.02;
        plan.income_streams.push(RetirementIncomeStream {
            id: "dc".into(),
            label: "RRSP".into(),
            stream_type: StreamKind::DefinedContribution,
            start_age: 65,
            adjust_for_inflation: false,
            annual_growth_rate: None,
            monthly_amount: None,
            linked_account_id: None,
            current_value: Some(100_000.0),
            monthly_contribution: None,
            accumulation_return: None,
            payout_rate: None,
            payout_mode: None,
            post_payout_return: None,
        });

        let projection = project_retirement(&plan, 5_000_000.0);
        let reported = |age: u32| {
            projection
                .year_by_year
                .iter()
                .find(|snapshot| snapshot.age == age)
                .unwrap_or_else(|| panic!("age {age} snapshot should exist"))
                .pension_assets
        };

        // 8%/yr: the plan's 10% net of its 2% fee. Not the gross 10%, and not the
        // 4% constant this used to fall back to.
        assert!((reported(60) - 100_000.0).abs() < 1e-6);
        assert!(
            (reported(61) - 108_000.0).abs() < 1e-6,
            "expected the plan's net rate, got {}",
            reported(61)
        );
        assert!((reported(64) - 100_000.0 * 1.08_f64.powi(4)).abs() < 1e-6);

        // And the payout is taken from that same balance carried one more year,
        // rather than from a second balance grown at a different rate.
        let payouts = resolve_plan_dc_payouts(
            &plan.income_streams,
            60,
            65,
            plan_accumulation_return(&plan),
        );
        let expected = reported(64) * 1.08 * DEFAULT_DC_PAYOUT_ESTIMATE_RATE / 12.0;
        assert!(
            (payouts["dc"] - expected).abs() < 1e-6,
            "the reported balance and the payout basis must be one balance"
        );
    }

    #[test]
    fn early_fi_projection_does_not_subtract_deferred_income() {
        let mut p = base_plan();
        p.personal.target_retirement_age = 60;
        p.investment.monthly_contribution = 0.0;
        // Pension at 60 -- should NOT help an earlier FI check
        p.income_streams.push(RetirementIncomeStream {
            id: "pension".into(),
            label: "Late Pension".into(),
            stream_type: StreamKind::DefinedBenefit,
            start_age: 60,
            adjust_for_inflation: false,
            annual_growth_rate: None,
            monthly_amount: Some(2_000.0),
            linked_account_id: None,
            current_value: None,
            monthly_contribution: None,
            accumulation_return: None,
            payout_rate: None,
            payout_mode: None,
            post_payout_return: None,
        });
        let target_at_60 = compute_required_capital(&p, 60).expect("target should be reachable");
        let target_at_35 = compute_required_capital(&p, 35).expect("target should be reachable");
        assert!(target_at_35 > target_at_60);
        // With 500k portfolio: should NOT reach FI at 35, but should eventually reach FI.
        let proj = project_retirement(&p, 500_000.0);
        assert!(proj.fire_age.is_some(), "should eventually reach FIRE");
        assert!(
            proj.fire_age.unwrap() > 35,
            "should not report FI at age 35 with only 500k vs 900k target",
        );
    }

    #[test]
    fn expense_bucket_with_end_age() {
        let mut plan = base_plan();
        // Add housing that ends at age 60
        plan.expenses.items.push(ExpenseBucket {
            id: None,
            label: None,
            monthly_amount: 1_000.0,
            inflation_rate: None,
            start_age: None,
            end_age: Some(60),
            essential: None,
        });
        let proj = project_retirement(&plan, 500_000.0);
        // Find fire-phase snapshots
        let fire_snaps: Vec<_> = proj
            .year_by_year
            .iter()
            .filter(|s| s.phase == "fire")
            .collect();
        if fire_snaps.len() >= 2 {
            // Find a snap before 60 and after 60
            let before = fire_snaps.iter().find(|s| s.age == 55);
            let after = fire_snaps.iter().find(|s| s.age == 65);
            if let (Some(b), Some(a)) = (before, after) {
                // Before 60: expenses include housing. After 60: housing drops.
                assert!(
                    b.annual_withdrawal > a.annual_withdrawal,
                    "expenses at 55 ({}) should exceed 65 ({}) due to housing ending",
                    b.annual_withdrawal,
                    a.annual_withdrawal,
                );
            }
        }
    }

    #[test]
    fn expense_items_respect_age_windows_and_essential_flags() {
        let mut plan = base_plan();
        plan.expenses.items = vec![
            ExpenseBucket {
                id: None,
                label: None,
                monthly_amount: 1_000.0,
                inflation_rate: None,
                start_age: None,
                end_age: Some(65),
                essential: Some(true),
            },
            ExpenseBucket {
                id: None,
                label: None,
                monthly_amount: 500.0,
                inflation_rate: None,
                start_age: Some(70),
                end_age: None,
                essential: Some(false),
            },
        ];

        let (age_55_expenses, age_55_essential) =
            annual_expenses_at_year(&plan.expenses, 55, 0, plan.investment.inflation_rate);
        let (age_70_expenses, age_70_essential) =
            annual_expenses_at_year(&plan.expenses, 70, 0, plan.investment.inflation_rate);

        assert_eq!(age_55_expenses, 12_000.0);
        assert_eq!(age_55_essential, 12_000.0);
        assert_eq!(age_70_expenses, 6_000.0);
        assert_eq!(age_70_essential, 0.0);
    }

    #[test]
    fn healthcare_inflation_isolation() {
        let mut plan = base_plan();
        plan.expenses.items.push(ExpenseBucket {
            id: None,
            label: None,
            monthly_amount: 500.0,
            inflation_rate: Some(0.08), // 8% healthcare inflation
            start_age: None,
            end_age: None,
            essential: None,
        });
        plan.investment.inflation_rate = 0.02; // 2% general

        let (total_y0, _) = annual_expenses_at_year(&plan.expenses, 55, 0, 0.02);
        let (total_y20, _) = annual_expenses_at_year(&plan.expenses, 75, 20, 0.02);

        // Healthcare at 8% for 20 years: 500*12 * 1.08^20
        // Living at 2% for 20 years: 3000*12 * 1.02^20
        // Total y20 should be much higher than naive 2% on everything
        let naive_total_y20 = total_y0 * (1.02_f64).powi(20);
        assert!(
            total_y20 > naive_total_y20,
            "healthcare at 8% inflation should outpace 2% general: {} vs {}",
            total_y20,
            naive_total_y20,
        );
    }

    #[test]
    fn projection_populates_taxes_and_gross_withdrawal() {
        let mut p = base_plan();
        p.tax = Some(TaxProfile {
            taxable_withdrawal_rate: 0.20,
            tax_deferred_withdrawal_rate: 0.0,
            tax_free_withdrawal_rate: 0.0,
            early_withdrawal_penalty_rate: None,
            early_withdrawal_penalty_age: None,
            country_code: None,
            withdrawal_buckets: TaxBucketBalances::default(),
        });
        let proj = project_retirement(&p, 100_000.0);
        let fire_snaps: Vec<_> = proj
            .year_by_year
            .iter()
            .filter(|s| s.phase == "fire")
            .collect();
        assert!(!fire_snaps.is_empty(), "should have fire-phase snapshots");
        for snap in &fire_snaps {
            assert!(
                snap.annual_taxes.is_some(),
                "annual_taxes should be populated in fire phase (age {})",
                snap.age,
            );
            assert!(
                snap.gross_withdrawal.is_some(),
                "gross_withdrawal should be populated in fire phase (age {})",
                snap.age,
            );
        }
        // Accumulation phase should have None
        let accum_snaps: Vec<_> = proj
            .year_by_year
            .iter()
            .filter(|s| s.phase == "accumulation")
            .collect();
        for snap in &accum_snaps {
            assert!(snap.annual_taxes.is_none());
            assert!(snap.gross_withdrawal.is_none());
        }
    }

    #[test]
    fn schedule_aware_target_excludes_ended_buckets() {
        let mut p = base_plan();
        // Housing ends at 60
        p.expenses.items.push(ExpenseBucket {
            id: None,
            label: None,
            monthly_amount: 1_500.0,
            inflation_rate: None,
            start_age: None,
            end_age: Some(60),
            essential: None,
        });
        let target_55 = compute_required_capital(&p, 55).expect("target should be reachable");
        let target_65 = compute_required_capital(&p, 65).expect("target should be reachable");
        // Target at 55 should be higher because housing is active
        assert!(
            target_55 > target_65,
            "target at 55 ({}) should exceed target at 65 ({}) because housing ends at 60",
            target_55,
            target_65,
        );
    }

    #[test]
    fn deferred_pension_reduces_spending_gap_after_start_age() {
        let mut plan = base_plan();
        plan.income_streams.push(RetirementIncomeStream {
            id: "pension".into(),
            label: "State pension".into(),
            stream_type: StreamKind::DefinedBenefit,
            monthly_amount: Some(1500.0),
            start_age: 67,
            adjust_for_inflation: true,
            annual_growth_rate: None,
            linked_account_id: None,
            current_value: None,
            monthly_contribution: None,
            accumulation_return: None,
            payout_rate: None,
            payout_mode: None,
            post_payout_return: None,
        });
        let proj = project_retirement(&plan, 800_000.0);
        let at_60 = proj
            .year_by_year
            .iter()
            .find(|s| s.age == 60 && s.phase == "fire");
        let at_70 = proj
            .year_by_year
            .iter()
            .find(|s| s.age == 70 && s.phase == "fire");
        if let (Some(before), Some(after)) = (at_60, at_70) {
            assert!(
                after.net_withdrawal_from_portfolio < before.net_withdrawal_from_portfolio,
                "pension at 67 should reduce portfolio withdrawal: {} vs {}",
                after.net_withdrawal_from_portfolio,
                before.net_withdrawal_from_portfolio,
            );
        }
    }

    #[test]
    fn housing_bucket_ends_at_specified_age() {
        let mut plan = base_plan();
        plan.expenses.items.push(ExpenseBucket {
            id: None,
            label: None,
            monthly_amount: 1500.0,
            inflation_rate: None,
            start_age: None,
            end_age: Some(65),
            essential: None,
        });
        let proj = project_retirement(&plan, 800_000.0);
        let at_60 = proj
            .year_by_year
            .iter()
            .find(|s| s.age == 60 && s.phase == "fire");
        let at_70 = proj
            .year_by_year
            .iter()
            .find(|s| s.age == 70 && s.phase == "fire");
        if let (Some(before), Some(after)) = (at_60, at_70) {
            assert!(
                after.annual_withdrawal < before.annual_withdrawal,
                "expenses should drop after housing ends: {} vs {}",
                after.annual_withdrawal,
                before.annual_withdrawal,
            );
        }
    }

    #[test]
    fn early_withdrawal_penalty_stops_at_cutoff_age() {
        let mut plan = base_plan();
        plan.personal.target_retirement_age = 50;
        plan.tax = Some(TaxProfile {
            taxable_withdrawal_rate: 0.20,
            tax_deferred_withdrawal_rate: 0.0,
            tax_free_withdrawal_rate: 0.0,
            early_withdrawal_penalty_rate: Some(0.10),
            early_withdrawal_penalty_age: Some(59),
            country_code: None,
            withdrawal_buckets: TaxBucketBalances::default(),
        });
        let proj = project_retirement(&plan, 1_500_000.0);
        let at_55 = proj
            .year_by_year
            .iter()
            .find(|s| s.age == 55 && s.phase == "fire");
        let at_62 = proj
            .year_by_year
            .iter()
            .find(|s| s.age == 62 && s.phase == "fire");
        if let (Some(early), Some(late)) = (at_55, at_62) {
            let early_gross = early.gross_withdrawal.unwrap_or(0.0);
            let late_gross = late.gross_withdrawal.unwrap_or(0.0);
            if early_gross > 0.0 && late_gross > 0.0 {
                let early_ratio = early.annual_taxes.unwrap_or(0.0) / early_gross;
                let late_ratio = late.annual_taxes.unwrap_or(0.0) / late_gross;
                assert!(
                    early_ratio > late_ratio,
                    "early tax ratio ({:.3}) should exceed late ({:.3})",
                    early_ratio,
                    late_ratio,
                );
            }
        }
    }

    #[test]
    fn fire_mode_does_not_force_retirement_when_underfunded() {
        let mut plan = base_plan();
        plan.expenses.items[0].monthly_amount = 20_000.0;
        plan.investment.monthly_contribution = 0.0;

        let projection = project_retirement_with_mode(&plan, 10_000.0, RetirementTimingMode::Fire);

        assert!(projection.fire_age.is_none());
        assert!(projection.retirement_start_age.is_none());
        assert!(projection.retirement_start_reason.is_none());
        assert!(!projection.funded_at_retirement);
        assert!(
            projection
                .year_by_year
                .iter()
                .all(|y| y.phase == "accumulation"),
            "fire mode should stay in accumulation when FI is never reached"
        );
    }

    #[test]
    fn traditional_mode_forces_retirement_at_target_age() {
        let mut plan = base_plan();
        plan.expenses.items[0].monthly_amount = 20_000.0;
        plan.investment.monthly_contribution = 0.0;

        let projection =
            project_retirement_with_mode(&plan, 10_000.0, RetirementTimingMode::Traditional);

        assert!(projection.fire_age.is_none());
        assert_eq!(
            projection.retirement_start_age,
            Some(plan.personal.target_retirement_age)
        );
        assert_eq!(
            projection.retirement_start_reason,
            Some(RetirementStartReason::TargetAgeForced)
        );
        assert!(!projection.funded_at_retirement);
        assert!(
            projection.year_by_year.iter().any(|y| y.phase == "fire"),
            "traditional mode should enter retirement at target age"
        );
    }
}
