use std::collections::HashMap;
use std::hash::{Hash, Hasher};

use rand::{rngs::StdRng, SeedableRng};
use rayon::prelude::*;

use super::dto::*;
use super::engine::*;
use super::model::*;
use super::withdrawal::{
    add_contribution, apply_growth, apply_planned_spending_withdrawal, initial_withdrawal_buckets,
};

// ─── Monte Carlo ─────────────────────────────────────────────────────────────

pub fn run_monte_carlo(
    plan: &RetirementPlan,
    current_portfolio: f64,
    n_sims: u32,
) -> MonteCarloResult {
    run_monte_carlo_with_mode(plan, current_portfolio, n_sims, RetirementTimingMode::Fire)
}

pub fn run_monte_carlo_with_mode(
    plan: &RetirementPlan,
    current_portfolio: f64,
    n_sims: u32,
    mode: RetirementTimingMode,
) -> MonteCarloResult {
    run_monte_carlo_with_mode_and_seed(plan, current_portfolio, n_sims, mode, None)
}

pub fn run_monte_carlo_with_mode_and_seed(
    plan: &RetirementPlan,
    current_portfolio: f64,
    n_sims: u32,
    mode: RetirementTimingMode,
    seed: Option<u64>,
) -> MonteCarloResult {
    let n_sims = n_sims.max(1);
    let current_age = plan.personal.current_age;
    let target_fire_age = plan.personal.target_retirement_age;
    let planning_horizon_age = plan.personal.planning_horizon_age;
    let horizon_years = (planning_horizon_age as i32 - current_age as i32).max(1) as u32;
    let inflation_rate = plan.investment.inflation_rate;
    let monthly_contribution = plan.investment.monthly_contribution;
    let contrib_growth = plan
        .personal
        .salary_growth_rate
        .unwrap_or(plan.investment.contribution_growth_rate);
    let accumulation_mean = plan_accumulation_return(plan);
    let retirement_mean = plan_retirement_return(plan);
    let std_dev = plan.investment.annual_volatility;
    let annual_fee_rate = plan.investment.annual_investment_fee_rate;
    let base_seed =
        seed.unwrap_or_else(|| retirement_plan_seed(plan, current_portfolio, n_sims, mode));

    // Clone fields needed inside the parallel closure
    let expenses_clone = plan.expenses.clone();
    let streams_clone = plan.income_streams.clone();
    let tax_clone = plan.tax.clone();
    let glide_path = plan.investment.glide_path.clone();

    // Precompute per-age required capital and DC payouts for all possible retirement ages.
    // These are deterministic and shared across all simulations.
    let age_range = horizon_years as usize + 1;
    let per_age_capitals: Vec<Option<f64>> = (0..age_range)
        .map(|i| try_compute_required_capital(plan, current_age + i as u32))
        .collect();
    let per_age_payouts: Vec<HashMap<String, f64>> = (0..age_range)
        .map(|i| {
            resolve_plan_dc_payouts(
                &plan.income_streams,
                current_age,
                current_age + i as u32,
                plan_accumulation_return(plan),
            )
        })
        .collect();
    let accumulation_return = plan_accumulation_return(plan);
    let default_post_payout_return = plan_retirement_return(plan);

    // paths[sim] = (year_values, survived, fi_age)
    let sim_results: Vec<(Vec<f64>, bool, Option<u32>)> = (0..n_sims)
        .into_par_iter()
        .map(|sim_idx| {
            let sim_seed = splitmix64(base_seed ^ sim_idx as u64);
            let mut rng = StdRng::seed_from_u64(sim_seed);
            let mut buckets = initial_withdrawal_buckets(&tax_clone, current_portfolio);
            let mut in_fire = false;
            let mut sim_fi_age: Option<u32> = None;
            let mut essential_funded_every_year = true;
            let mut path = Vec::with_capacity(horizon_years as usize + 1);
            let mut cumulative_inflation = 1.0_f64;
            let mut sim_resolved_payouts: Option<&HashMap<String, f64>> = None;
            let mut sim_drawdown = DrawdownLedger::default();
            let mut sim_retirement_age = target_fire_age;

            for i in 0..=horizon_years {
                let age = current_age + i;
                let portfolio = buckets.total();
                path.push(portfolio.max(0.0));

                if !in_fire {
                    let required = per_age_capitals[i as usize];
                    if sim_fi_age.is_none() && required.is_some_and(|target| portfolio >= target) {
                        sim_fi_age = Some(age);
                    }
                    if retirement_start_decision(mode, age, target_fire_age, portfolio, required)
                        .is_some()
                    {
                        in_fire = true;
                        sim_retirement_age = age;
                        sim_resolved_payouts = Some(&per_age_payouts[i as usize]);
                    }
                }

                // A fund can start paying before this path reaches retirement, so the
                // depletion it carries starts at the fund's own start age. Until the
                // retirement decision picks a set of payouts, this year's set is the
                // right one: contributions stop at the earlier of the start age and
                // retirement either way.
                let payouts = sim_resolved_payouts.unwrap_or(&per_age_payouts[i as usize]);
                open_due_drawdown_funds(
                    &mut sim_drawdown,
                    &streams_clone,
                    age,
                    current_age,
                    if in_fire { sim_retirement_age } else { age },
                    accumulation_return,
                );

                // Glide-path-blended return distribution for this year
                let (eff_mean, eff_std) = blended_return_params_mc(
                    accumulation_mean,
                    retirement_mean,
                    std_dev,
                    annual_fee_rate,
                    current_age,
                    sim_retirement_age,
                    planning_horizon_age,
                    glide_path.as_ref(),
                    i,
                    in_fire,
                );
                let (annual_return, annual_inflation) =
                    sample_return_and_inflation(&mut rng, eff_mean, eff_std, inflation_rate);

                if in_fire {
                    let grown_buckets = apply_growth(buckets, annual_return);
                    let (total_expenses, essential_expenses) = annual_expenses_at_year_stochastic(
                        &expenses_clone,
                        age,
                        i,
                        inflation_rate,
                        cumulative_inflation,
                    );
                    let income = plan_income_at_age_with_drawdown(
                        &streams_clone,
                        payouts,
                        &mut sim_drawdown,
                        age,
                        i,
                        inflation_rate,
                        Some(cumulative_inflation),
                        default_post_payout_return,
                    );
                    let outcome = apply_planned_spending_withdrawal(
                        &grown_buckets,
                        total_expenses,
                        income,
                        &tax_clone,
                        age,
                    );

                    // Track essential spending funding
                    let essential_gap = (essential_expenses - income).max(0.0);
                    if outcome.spending_funded < essential_gap * FUNDING_TOLERANCE {
                        essential_funded_every_year = false;
                    }

                    buckets = outcome.remaining_buckets;
                } else {
                    // The withdrawal has to leave the fund even in a year the plan
                    // models no spending for it to fund, or a fund paying since 65
                    // would be whole again when retirement begins at 70.
                    drawdown_income_at_age(
                        &streams_clone,
                        payouts,
                        &mut sim_drawdown,
                        age,
                        i,
                        inflation_rate,
                        Some(cumulative_inflation),
                        default_post_payout_return,
                    );
                    let year_monthly_contribution =
                        monthly_contribution * (1.0 + contrib_growth).powi(i as i32);
                    let annual_contribution = end_of_year_value_of_monthly_contributions(
                        year_monthly_contribution,
                        annual_return,
                    );
                    let grown_buckets = apply_growth(buckets, annual_return);
                    buckets = add_contribution(grown_buckets, annual_contribution, &tax_clone);
                }

                cumulative_inflation *= 1.0 + annual_inflation;
            }

            // Success: essential spending funded, portfolio survives, and FIRE plans reach FI.
            // Keep the definition aligned across market-path runs and the deterministic planner.
            let ending_portfolio = buckets.total();
            let portfolio_survived = ending_portfolio > 0.0;
            let survived = essential_funded_every_year
                && portfolio_survived
                && (matches!(mode, RetirementTimingMode::Traditional) || sim_fi_age.is_some());
            (path, survived, sim_fi_age)
        })
        .collect();

    let year_count = horizon_years as usize + 1;
    let survived_count = sim_results.iter().filter(|(_, s, _)| *s).count();
    // Only collect ages where FI target was genuinely reached (fi_age is Some)
    let mut fire_ages: Vec<u32> = sim_results.iter().filter_map(|(_, _, fa)| *fa).collect();
    fire_ages.sort_unstable();

    let mut p10 = Vec::with_capacity(year_count);
    let mut p25 = Vec::with_capacity(year_count);
    let mut p50 = Vec::with_capacity(year_count);
    let mut p75 = Vec::with_capacity(year_count);
    let mut p90 = Vec::with_capacity(year_count);
    let mut age_axis = Vec::with_capacity(year_count);

    for i in 0..year_count {
        let mut vals: Vec<f64> = sim_results.iter().map(|(path, _, _)| path[i]).collect();
        vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        p10.push(percentile(&vals, 0.1));
        p25.push(percentile(&vals, 0.25));
        p50.push(percentile(&vals, 0.5));
        p75.push(percentile(&vals, 0.75));
        p90.push(percentile(&vals, 0.9));
        age_axis.push(current_age + i as u32);
    }

    let mut final_vals: Vec<f64> = sim_results
        .iter()
        .map(|(path, _, _)| *path.last().unwrap_or(&0.0))
        .collect();
    final_vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    // None when fewer than 50% of simulations reached FI (underfunded plan)
    let median_fire_age = if !fire_ages.is_empty() && fire_ages.len() * 2 >= n_sims as usize {
        Some(fire_ages[fire_ages.len() / 2])
    } else {
        None
    };

    MonteCarloResult {
        success_rate: survived_count as f64 / n_sims as f64,
        median_fire_age,
        percentiles: PercentilePaths {
            p10,
            p25,
            p50,
            p75,
            p90,
        },
        age_axis,
        final_portfolio_at_horizon: FinalPortfolioPercentiles {
            p10: percentile(&final_vals, 0.1),
            p25: percentile(&final_vals, 0.25),
            p50: percentile(&final_vals, 0.5),
            p75: percentile(&final_vals, 0.75),
            p90: percentile(&final_vals, 0.9),
        },
        n_simulations: n_sims,
    }
}

fn splitmix64(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9e3779b97f4a7c15);
    let mut z = x;
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
    z ^ (z >> 31)
}

fn retirement_plan_seed(
    plan: &RetirementPlan,
    current_portfolio: f64,
    n_sims: u32,
    mode: RetirementTimingMode,
) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    match serde_json::to_string(plan) {
        Ok(serialized) => serialized.hash(&mut hasher),
        Err(_) => format!("{:?}", plan).hash(&mut hasher),
    }
    current_portfolio.to_bits().hash(&mut hasher);
    n_sims.hash(&mut hasher);
    mode.as_str().hash(&mut hasher);
    hasher.finish()
}

// ─── Scenario Analysis ───────────────────────────────────────────────────────

pub fn run_scenario_analysis(plan: &RetirementPlan, current_portfolio: f64) -> Vec<ScenarioResult> {
    run_scenario_analysis_with_mode(plan, current_portfolio, RetirementTimingMode::Fire)
}

pub fn run_scenario_analysis_with_mode(
    plan: &RetirementPlan,
    current_portfolio: f64,
    mode: RetirementTimingMode,
) -> Vec<ScenarioResult> {
    let scenarios = [
        ("Pessimistic", -0.02_f64),
        ("Base case", 0.0_f64),
        ("Optimistic", 0.015_f64),
    ];

    scenarios
        .iter()
        .map(|(label, delta)| {
            let mut adjusted = plan.clone();
            adjusted.investment.pre_retirement_annual_return += delta;
            adjusted.investment.retirement_annual_return += delta;
            let proj = project_retirement_with_mode(&adjusted, current_portfolio, mode);
            let overview =
                compute_retirement_overview_with_mode(&adjusted, current_portfolio, mode);
            let portfolio_at_horizon = proj
                .year_by_year
                .last()
                .map(|s| s.portfolio_end_value)
                .unwrap_or(0.0);
            let success = matches!(overview.success_status.as_str(), "on_track" | "overfunded");
            ScenarioResult {
                label: label.to_string(),
                annual_return: plan_accumulation_return(&adjusted),
                fire_age: proj.fire_age,
                portfolio_at_horizon,
                funded_at_goal_age: overview.funded_at_goal_age,
                success,
                failure_age: overview.failure_age,
                spending_shortfall_age: overview.spending_shortfall_age,
                year_by_year: proj.year_by_year,
            }
        })
        .collect()
}

// ─── Stress Tests ───────────────────────────────────────────────────────────

struct RiskLabPlanOutcome {
    fi_age: Option<u32>,
    retirement_start_age: Option<u32>,
    funded_at_goal_age: bool,
    shortfall_at_goal_age: f64,
    portfolio_at_horizon: f64,
    portfolio_at_retirement_start: f64,
    required_capital_at_goal_age: f64,
    failure_age: Option<u32>,
    spending_shortfall_age: Option<u32>,
}

fn risk_lab_plan_outcome(
    plan: &RetirementPlan,
    current_portfolio: f64,
    mode: RetirementTimingMode,
) -> RiskLabPlanOutcome {
    let mut required_capital_cache = RequiredCapitalCache::new();
    let required_capital = required_capital_for(
        plan,
        plan.personal.target_retirement_age,
        &mut required_capital_cache,
    );
    let required_capital_value = required_capital.unwrap_or(0.0);
    let projection = project_retirement_with_mode_cached(
        plan,
        current_portfolio,
        mode,
        &mut required_capital_cache,
    );
    let portfolio_at_goal = projection
        .year_by_year
        .iter()
        .find(|snap| snap.age == plan.personal.target_retirement_age)
        .map(|snap| snap.portfolio_value)
        .unwrap_or(0.0);
    let portfolio_at_retirement_start = projection
        .retirement_start_age
        .and_then(|age| {
            projection
                .year_by_year
                .iter()
                .find(|snap| snap.age == age)
                .map(|snap| snap.portfolio_value)
        })
        .unwrap_or(0.0);
    let failure_age = projection
        .year_by_year
        .iter()
        .find(|snap| snap.phase == "fire" && snap.portfolio_value <= 0.0)
        .map(|snap| snap.age);
    let spending_shortfall_age = projection
        .year_by_year
        .iter()
        .find(|snap| has_material_spending_shortfall(snap))
        .map(|snap| snap.age);

    RiskLabPlanOutcome {
        fi_age: projection.fire_age,
        retirement_start_age: projection.retirement_start_age,
        funded_at_goal_age: required_capital.is_some_and(|target| portfolio_at_goal >= target),
        shortfall_at_goal_age: required_capital
            .map(|target| (target - portfolio_at_goal).max(0.0))
            .unwrap_or(0.0),
        portfolio_at_horizon: projection
            .year_by_year
            .last()
            .map(|snap| snap.portfolio_end_value)
            .unwrap_or(0.0),
        portfolio_at_retirement_start,
        required_capital_at_goal_age: required_capital_value,
        failure_age,
        spending_shortfall_age,
    }
}

pub fn run_stress_tests(plan: &RetirementPlan, current_portfolio: f64) -> Vec<StressTestResult> {
    run_stress_tests_with_mode(plan, current_portfolio, RetirementTimingMode::Fire)
}

pub fn run_stress_tests_with_mode(
    plan: &RetirementPlan,
    current_portfolio: f64,
    mode: RetirementTimingMode,
) -> Vec<StressTestResult> {
    let baseline_outcome = risk_lab_plan_outcome(plan, current_portfolio, mode);
    let baseline = stress_outcome_from_plan_outcome(&baseline_outcome);
    let severity_base = baseline_outcome.required_capital_at_goal_age.max(1.0);

    // The 6 stress scenarios are independent, so run them across the rayon
    // pool instead of sequentially: this is ~N× faster on multi-core machines
    // and noticeably shortens the "What could break this plan?" spinner.
    type PlanMutator = fn(&mut RetirementPlan);
    let plan_stresses: [(StressTestId, &str, &str, StressCategory, PlanMutator); 5] = [
        (
            StressTestId::ReturnDrag,
            "Lower returns",
            "Pre-retirement and retirement returns are 2 percentage points lower.",
            StressCategory::Market,
            apply_return_drag_stress,
        ),
        (
            StressTestId::InflationShock,
            "Inflation shock",
            "General inflation is 1.5 percentage points higher.",
            StressCategory::Inflation,
            apply_inflation_shock_stress,
        ),
        (
            StressTestId::SpendingShock,
            "Higher spending",
            "All retirement spending lines are 10% higher.",
            StressCategory::Spending,
            apply_spending_shock_stress,
        ),
        (
            StressTestId::RetireEarlier,
            "Retire 2 years earlier",
            "Desired retirement age is moved two years earlier.",
            StressCategory::Timing,
            apply_retire_earlier_stress,
        ),
        (
            StressTestId::SaveLess,
            "Save less",
            "Monthly contributions are 25% lower.",
            StressCategory::Saving,
            apply_save_less_stress,
        ),
    ];

    let (mut specs, early_crash) = rayon::join(
        || {
            plan_stresses
                .par_iter()
                .map(|(id, label, description, category, mutate)| {
                    build_plan_stress(
                        id.clone(),
                        label,
                        description,
                        category.clone(),
                        plan,
                        current_portfolio,
                        mode,
                        &baseline,
                        severity_base,
                        *mutate,
                    )
                })
                .collect::<Vec<_>>()
        },
        || build_early_crash_stress(plan, &baseline_outcome, &baseline, severity_base),
    );
    specs.push(early_crash);

    specs.sort_by(|a, b| {
        severity_rank(&b.severity)
            .cmp(&severity_rank(&a.severity))
            .then_with(|| {
                b.delta
                    .shortfall_at_goal_age
                    .partial_cmp(&a.delta.shortfall_at_goal_age)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
    specs
}

#[allow(clippy::too_many_arguments)]
fn build_plan_stress<F>(
    id: StressTestId,
    label: &str,
    description: &str,
    category: StressCategory,
    plan: &RetirementPlan,
    current_portfolio: f64,
    mode: RetirementTimingMode,
    baseline: &StressOutcome,
    severity_base: f64,
    mutate: F,
) -> StressTestResult
where
    F: FnOnce(&mut RetirementPlan),
{
    let mut stressed_plan = plan.clone();
    mutate(&mut stressed_plan);
    let outcome = risk_lab_plan_outcome(&stressed_plan, current_portfolio, mode);
    let stressed = stress_outcome_from_plan_outcome(&outcome);
    build_stress_result(
        id,
        label,
        description,
        category,
        baseline.clone(),
        stressed,
        severity_base,
    )
}

fn build_early_crash_stress(
    plan: &RetirementPlan,
    baseline_outcome: &RiskLabPlanOutcome,
    baseline: &StressOutcome,
    severity_base: f64,
) -> StressTestResult {
    let Some(retirement_age) = baseline_outcome.retirement_start_age else {
        return build_stress_result(
            StressTestId::EarlyCrash,
            "Retire into a crash",
            "A 30% market drop happens in the first retirement year.",
            StressCategory::Market,
            baseline.clone(),
            baseline.clone(),
            severity_base,
        );
    };

    let portfolio_at_start = baseline_outcome.portfolio_at_retirement_start.max(0.0);
    let crash = run_sorr(plan, portfolio_at_start, retirement_age)
        .into_iter()
        .find(|s| s.label == "Crash Year 1 (-30%)");

    let stressed = match crash {
        Some(scenario) => StressOutcome {
            fi_age: baseline.fi_age,
            retirement_start_age: Some(retirement_age),
            funded_at_goal_age: baseline.funded_at_goal_age,
            shortfall_at_goal_age: baseline.shortfall_at_goal_age,
            portfolio_at_horizon: scenario.final_value,
            failure_age: scenario.failure_age.or({
                if scenario.survived {
                    None
                } else {
                    Some(retirement_age)
                }
            }),
            spending_shortfall_age: scenario.spending_shortfall_age,
        },
        None => StressOutcome {
            fi_age: baseline.fi_age,
            retirement_start_age: Some(retirement_age),
            funded_at_goal_age: false,
            shortfall_at_goal_age: baseline.shortfall_at_goal_age,
            portfolio_at_horizon: 0.0,
            failure_age: Some(retirement_age),
            spending_shortfall_age: Some(retirement_age),
        },
    };

    build_stress_result(
        StressTestId::EarlyCrash,
        "Retire into a crash",
        "A 30% market drop happens in the first retirement year.",
        StressCategory::Market,
        baseline.clone(),
        stressed,
        severity_base,
    )
}

fn build_stress_result(
    id: StressTestId,
    label: &str,
    description: &str,
    category: StressCategory,
    baseline: StressOutcome,
    stressed: StressOutcome,
    severity_base: f64,
) -> StressTestResult {
    let delta = StressDelta {
        fi_age_years: match (baseline.fi_age, stressed.fi_age) {
            (Some(base), Some(stress)) => Some(stress as i32 - base as i32),
            _ => None,
        },
        shortfall_at_goal_age: stressed.shortfall_at_goal_age - baseline.shortfall_at_goal_age,
        portfolio_at_horizon: stressed.portfolio_at_horizon - baseline.portfolio_at_horizon,
    };
    let severity = classify_stress(&baseline, &stressed, &delta, severity_base);

    StressTestResult {
        id,
        label: label.to_string(),
        description: description.to_string(),
        category,
        baseline,
        stressed,
        delta,
        severity,
    }
}

fn stress_outcome_from_plan_outcome(outcome: &RiskLabPlanOutcome) -> StressOutcome {
    StressOutcome {
        fi_age: outcome.fi_age,
        retirement_start_age: outcome.retirement_start_age,
        funded_at_goal_age: outcome.funded_at_goal_age,
        shortfall_at_goal_age: outcome.shortfall_at_goal_age,
        portfolio_at_horizon: outcome.portfolio_at_horizon,
        failure_age: outcome.failure_age,
        spending_shortfall_age: outcome.spending_shortfall_age,
    }
}

fn classify_stress(
    baseline: &StressOutcome,
    stressed: &StressOutcome,
    delta: &StressDelta,
    severity_base: f64,
) -> StressSeverity {
    let shortfall_increase = delta.shortfall_at_goal_age.max(0.0);
    if stressed.failure_age.is_some()
        || stressed.spending_shortfall_age.is_some()
        || (baseline.fi_age.is_some() && stressed.fi_age.is_none())
        || delta.fi_age_years.is_some_and(|years| years >= 3)
        || shortfall_increase >= severity_base * 0.15
    {
        StressSeverity::High
    } else if delta.fi_age_years.is_some_and(|years| years >= 1)
        || shortfall_increase >= severity_base * 0.05
    {
        StressSeverity::Medium
    } else {
        StressSeverity::Low
    }
}

fn severity_rank(severity: &StressSeverity) -> u8 {
    match severity {
        StressSeverity::Low => 0,
        StressSeverity::Medium => 1,
        StressSeverity::High => 2,
    }
}

fn apply_return_drag_stress(plan: &mut RetirementPlan) {
    plan.investment.pre_retirement_annual_return -= 0.02;
    plan.investment.retirement_annual_return -= 0.02;
}

fn apply_inflation_shock_stress(plan: &mut RetirementPlan) {
    plan.investment.inflation_rate += 0.015;
}

fn apply_spending_shock_stress(plan: &mut RetirementPlan) {
    scale_expenses(&mut plan.expenses, 1.10);
}

fn apply_retire_earlier_stress(plan: &mut RetirementPlan) {
    plan.personal.target_retirement_age = plan
        .personal
        .target_retirement_age
        .saturating_sub(2)
        .max(plan.personal.current_age + 1);
}

fn apply_save_less_stress(plan: &mut RetirementPlan) {
    plan.investment.monthly_contribution *= 0.75;
}

fn scale_expenses(expenses: &mut ExpenseBudget, factor: f64) {
    for item in &mut expenses.items {
        item.monthly_amount *= factor;
    }
}

// ─── Sequence of Returns Risk ────────────────────────────────────────────────

pub fn run_sorr(
    plan: &RetirementPlan,
    portfolio_at_fire: f64,
    retirement_start_age: u32,
) -> Vec<SorrScenario> {
    if portfolio_at_fire <= 0.0 {
        return vec![]; // SORR disabled when not funded
    }

    let resolved_payouts = resolve_plan_dc_payouts(
        &plan.income_streams,
        plan.personal.current_age,
        retirement_start_age,
        plan_accumulation_return(plan),
    );
    let r = plan_retirement_return(plan);
    let years =
        (plan.personal.planning_horizon_age as i32 - retirement_start_age as i32).max(0) as usize;
    if years == 0 {
        return vec![];
    }
    let years_to_fire =
        (retirement_start_age as i32 - plan.personal.current_age as i32).max(0) as u32;
    let inflation = plan.investment.inflation_rate;

    let mut crash_year_1 = vec![r; years];
    crash_year_1[0] = -0.3;

    let mut crash_year_5 = vec![r; years];
    if years >= 5 {
        crash_year_5[4] = -0.3;
    }

    let mut double_crash = vec![r; years];
    double_crash[0] = -0.25;
    if years >= 5 {
        double_crash[4] = -0.2;
    }

    let mut lost_decade = vec![r; years];
    for year_return in lost_decade.iter_mut().take(10) {
        *year_return = 0.0;
    }

    let scenarios: Vec<(&str, Vec<f64>)> = vec![
        ("Base case", vec![r; years]),
        ("Crash Year 1 (-30%)", crash_year_1),
        ("Crash Year 5 (-30%)", crash_year_5),
        ("Double Crash", double_crash),
        ("Lost Decade", lost_decade),
    ];

    scenarios
        .into_iter()
        .map(|(label, returns)| {
            let mut buckets = initial_withdrawal_buckets(&plan.tax, portfolio_at_fire);
            let mut path = Vec::with_capacity(years + 1);
            let mut essential_funded_every_year = true;
            let mut failure_age = None;
            // Each scenario depletes its own funds; a shock year does not change
            // the draw, but the fund still has to have the money. A fund that started
            // paying before retirement arrives already part-drawn.
            let mut drawdown = drawdown_ledger_entering_retirement(
                &plan.income_streams,
                &resolved_payouts,
                plan.personal.current_age,
                retirement_start_age,
                plan_accumulation_return(plan),
                inflation,
                r,
            );

            #[allow(clippy::needless_range_loop)]
            for i in 0..years {
                path.push(buckets.total().max(0.0));
                let age = retirement_start_age + i as u32;
                let years_from_now = years_to_fire + i as u32;
                open_due_drawdown_funds(
                    &mut drawdown,
                    &plan.income_streams,
                    age,
                    plan.personal.current_age,
                    retirement_start_age,
                    plan_accumulation_return(plan),
                );
                let (total_expenses, essential_expenses) =
                    annual_expenses_at_year(&plan.expenses, age, years_from_now, inflation);
                let income = plan_income_at_age_with_drawdown(
                    &plan.income_streams,
                    &resolved_payouts,
                    &mut drawdown,
                    age,
                    years_from_now,
                    inflation,
                    None,
                    r,
                );
                // Use scenario returns[i] but blend with glide path for the base-return component.
                // For non-base scenarios the shock return overrides the actual return for that year.
                let glide_mean =
                    plan_blended_return(plan, years_from_now, true, retirement_start_age);
                let effective_return = if (returns[i] - r).abs() < 1e-9 {
                    // "normal" year: use glide-path-adjusted mean
                    glide_mean
                } else {
                    // shock or recovery year: keep scenario return as-is
                    returns[i]
                };
                let grown_buckets = apply_growth(buckets, effective_return);
                let outcome = apply_planned_spending_withdrawal(
                    &grown_buckets,
                    total_expenses,
                    income,
                    &plan.tax,
                    age,
                );
                let essential_gap = (essential_expenses - income).max(0.0);
                if failure_age.is_none()
                    && outcome.spending_funded < essential_gap * FUNDING_TOLERANCE
                {
                    essential_funded_every_year = false;
                    failure_age = Some(age);
                }
                buckets = outcome.remaining_buckets;
            }
            let portfolio = buckets.total();
            path.push(portfolio.max(0.0));

            let portfolio_survived = portfolio > 0.0;
            let survived = essential_funded_every_year && portfolio_survived;
            let spending_shortfall_age = failure_age;
            let failure_age = if !portfolio_survived {
                // Find the first year where portfolio was depleted.
                path.iter()
                    .enumerate()
                    .find(|(_, &v)| v <= 0.0)
                    .map(|(idx, _)| retirement_start_age + idx as u32)
            } else {
                None
            };
            SorrScenario {
                label: label.to_string(),
                returns,
                portfolio_path: path,
                final_value: portfolio,
                survived,
                failure_age,
                spending_shortfall_age,
            }
        })
        .collect()
}

// ─── Sensitivity Analysis ────────────────────────────────────────────────────

pub fn run_sensitivity_analysis(
    plan: &RetirementPlan,
    current_portfolio: f64,
) -> SensitivityResult {
    run_sensitivity_analysis_with_mode(plan, current_portfolio, RetirementTimingMode::Fire)
}

pub fn run_sensitivity_analysis_with_mode(
    plan: &RetirementPlan,
    current_portfolio: f64,
    mode: RetirementTimingMode,
) -> SensitivityResult {
    let contribution_multipliers = [0.5_f64, 0.75, 1.0, 1.25, 1.5];
    let return_values = [0.04_f64, 0.05, 0.06, 0.07, 0.08, 0.09];

    let contribution_base = plan.investment.monthly_contribution;
    let contribution_rows: Vec<f64> = contribution_multipliers
        .iter()
        .map(|m| contribution_base * m)
        .collect();

    let fire_ages: Vec<Vec<Option<u32>>> = contribution_rows
        .iter()
        .map(|&contribution| {
            return_values
                .iter()
                .map(|&ret| {
                    let mut adjusted = plan.clone();
                    adjusted.investment.monthly_contribution = contribution;
                    adjusted.investment.pre_retirement_annual_return =
                        ret + adjusted.investment.annual_investment_fee_rate;
                    adjusted.investment.retirement_annual_return =
                        ret + adjusted.investment.annual_investment_fee_rate;
                    project_retirement_with_mode(&adjusted, current_portfolio, mode).fire_age
                })
                .collect()
        })
        .collect();

    SensitivityResult {
        contribution: SensitivityMatrix {
            contribution_rows,
            return_columns: return_values.to_vec(),
            fire_ages,
        },
    }
}

pub fn run_decision_sensitivity_matrix_with_mode(
    plan: &RetirementPlan,
    current_portfolio: f64,
    mode: RetirementTimingMode,
    map: DecisionSensitivityMap,
) -> DecisionSensitivityMatrix {
    match map {
        DecisionSensitivityMap::ContributionReturn => {
            build_contribution_return_sensitivity(plan, current_portfolio, mode)
        }
        DecisionSensitivityMap::RetirementAgeSpending => {
            build_retirement_age_spending_sensitivity(plan, current_portfolio, mode)
        }
    }
}

fn build_contribution_return_sensitivity(
    plan: &RetirementPlan,
    current_portfolio: f64,
    mode: RetirementTimingMode,
) -> DecisionSensitivityMatrix {
    let base_contribution = plan.investment.monthly_contribution;
    let base_net_return = plan_accumulation_return(plan);
    let contribution_values = contribution_axis(base_contribution);
    let return_values = return_axis(base_net_return);
    let baseline_row = return_values
        .iter()
        .position(|value| approx_eq(*value, base_net_return, 0.000_001));
    let baseline_column = contribution_values
        .iter()
        .position(|value| approx_eq(*value, base_contribution, 0.01));

    let cells = return_values
        .par_iter()
        .map(|&net_return| {
            contribution_values
                .par_iter()
                .map(|&contribution| {
                    let mut adjusted = plan.clone();
                    adjusted.investment.monthly_contribution = contribution;
                    apply_return_delta(&mut adjusted, net_return - base_net_return);
                    decision_cell_from_plan(&adjusted, current_portfolio, mode)
                })
                .collect()
        })
        .collect();

    DecisionSensitivityMatrix {
        row_label: "After-fee return".to_string(),
        column_label: "Monthly contribution".to_string(),
        row_labels: return_values
            .iter()
            .map(|value| format!("{:.1}%", value * 100.0))
            .collect(),
        column_labels: contribution_values
            .iter()
            .map(|value| format!("{:.0}", value))
            .collect(),
        row_values: return_values,
        column_values: contribution_values,
        cells,
        baseline_row,
        baseline_column,
    }
}

fn build_retirement_age_spending_sensitivity(
    plan: &RetirementPlan,
    current_portfolio: f64,
    mode: RetirementTimingMode,
) -> DecisionSensitivityMatrix {
    let base_retirement_age = plan.personal.target_retirement_age;
    let base_monthly_spending = active_monthly_expense_today(plan, base_retirement_age);
    let spending_values = spending_axis(base_monthly_spending);
    let retirement_age_values = retirement_age_axis(plan);
    let baseline_row = spending_values
        .iter()
        .position(|value| approx_eq(*value, base_monthly_spending, 0.01));
    let baseline_column = retirement_age_values
        .iter()
        .position(|value| *value as u32 == base_retirement_age);

    let cells = spending_values
        .par_iter()
        .map(|&monthly_spending| {
            retirement_age_values
                .par_iter()
                .map(|&retirement_age| {
                    let mut adjusted = plan.clone();
                    adjusted.personal.target_retirement_age = retirement_age as u32;
                    set_total_monthly_expense(
                        &mut adjusted.expenses,
                        base_monthly_spending,
                        monthly_spending,
                    );
                    decision_cell_from_plan(&adjusted, current_portfolio, mode)
                })
                .collect()
        })
        .collect();

    DecisionSensitivityMatrix {
        row_label: "Monthly spending".to_string(),
        column_label: "Retirement age".to_string(),
        row_labels: spending_values
            .iter()
            .map(|value| format!("{:.0}", value))
            .collect(),
        column_labels: retirement_age_values
            .iter()
            .map(|value| format!("{value}"))
            .collect(),
        row_values: spending_values,
        column_values: retirement_age_values,
        cells,
        baseline_row,
        baseline_column,
    }
}

fn decision_cell_from_plan(
    plan: &RetirementPlan,
    current_portfolio: f64,
    mode: RetirementTimingMode,
) -> DecisionSensitivityCell {
    let outcome = risk_lab_plan_outcome(plan, current_portfolio, mode);
    let target_factor = inflation_factor_to_age(plan, plan.personal.target_retirement_age);
    let horizon_factor = inflation_factor_to_age(plan, plan.personal.planning_horizon_age);
    DecisionSensitivityCell {
        fi_age: outcome.fi_age,
        retirement_start_age: outcome.retirement_start_age,
        funded_at_goal_age: outcome.funded_at_goal_age,
        shortfall_at_goal_age: outcome.shortfall_at_goal_age / target_factor,
        portfolio_at_horizon: outcome.portfolio_at_horizon / horizon_factor,
    }
}

fn inflation_factor_to_age(plan: &RetirementPlan, age: u32) -> f64 {
    let years = (age as i32 - plan.personal.current_age as i32).max(0) as u32;
    bounded_inflation_factor(plan.investment.inflation_rate, years)
}

fn apply_return_delta(plan: &mut RetirementPlan, delta: f64) {
    plan.investment.pre_retirement_annual_return =
        (plan.investment.pre_retirement_annual_return + delta).max(-0.99);
    plan.investment.retirement_annual_return =
        (plan.investment.retirement_annual_return + delta).max(-0.99);
}

fn contribution_axis(base: f64) -> Vec<f64> {
    if base <= 0.0 {
        return vec![0.0, 500.0, 1_000.0, 1_500.0, 2_000.0];
    }

    let mut values = Vec::with_capacity(5);
    for multiplier in [0.6_f64, 0.8, 1.0, 1.2, 1.4] {
        let value = if approx_eq(multiplier, 1.0, 0.000_001) {
            base
        } else {
            round_money_axis(base * multiplier)
        };
        push_unique_axis_value(&mut values, value);
    }
    fill_money_axis(&mut values, base);
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    values
}

fn return_axis(base: f64) -> Vec<f64> {
    [-0.02_f64, -0.01, 0.0, 0.01, 0.02]
        .iter()
        .map(|delta| (base + delta).max(-0.95))
        .collect()
}

fn spending_axis(base: f64) -> Vec<f64> {
    if base <= 0.0 {
        return vec![0.0, 1_000.0, 2_000.0, 3_000.0, 4_000.0];
    }

    let mut values = Vec::with_capacity(5);
    for multiplier in [0.8_f64, 0.9, 1.0, 1.1, 1.2] {
        let value = if approx_eq(multiplier, 1.0, 0.000_001) {
            base
        } else {
            round_money_axis(base * multiplier)
        };
        push_unique_axis_value(&mut values, value);
    }
    fill_money_axis(&mut values, base);
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    values
}

fn retirement_age_axis(plan: &RetirementPlan) -> Vec<f64> {
    let target = plan.personal.target_retirement_age as i32;
    let min_age = plan.personal.current_age as i32 + 1;
    let max_age = plan.personal.planning_horizon_age as i32;
    let mut values = Vec::with_capacity(5);
    for offset in [-3_i32, -1, 0, 2, 4] {
        let age = (target + offset).clamp(min_age, max_age);
        if !values.contains(&age) {
            values.push(age);
        }
    }
    let mut next = target;
    while values.len() < 5 && next < max_age {
        next += 1;
        if !values.contains(&next) {
            values.push(next);
        }
    }
    let mut prev = target;
    while values.len() < 5 && prev > min_age {
        prev -= 1;
        if !values.contains(&prev) {
            values.push(prev);
        }
    }
    values.sort_unstable();
    values.into_iter().map(f64::from).collect()
}

fn active_monthly_expense_today(plan: &RetirementPlan, age: u32) -> f64 {
    plan.expenses
        .all_buckets()
        .into_iter()
        .filter(|(bucket, _)| {
            bucket.start_age.is_none_or(|start| age >= start)
                && bucket.end_age.is_none_or(|end| age < end)
        })
        .map(|(bucket, _)| bucket.monthly_amount)
        .sum()
}

fn set_total_monthly_expense(expenses: &mut ExpenseBudget, base_total: f64, target_total: f64) {
    if base_total > 0.0 {
        scale_expenses(expenses, target_total / base_total);
        return;
    }

    if let Some(first) = expenses.items.first_mut() {
        first.monthly_amount = target_total;
    } else {
        expenses.items.push(ExpenseBucket {
            id: None,
            label: None,
            monthly_amount: target_total,
            inflation_rate: None,
            start_age: None,
            end_age: None,
            essential: Some(true),
        });
    }
}

fn round_money_axis(value: f64) -> f64 {
    let step = if value.abs() >= 1_000.0 { 100.0 } else { 50.0 };
    (value / step).round() * step
}

fn push_unique_axis_value(values: &mut Vec<f64>, value: f64) {
    if !values
        .iter()
        .any(|existing| approx_eq(*existing, value, 0.01))
    {
        values.push(value.max(0.0));
    }
}

fn fill_money_axis(values: &mut Vec<f64>, base: f64) {
    let step = round_money_axis((base.abs() * 0.2).max(100.0)).max(100.0);
    let mut next = base + step;
    while values.len() < 5 {
        push_unique_axis_value(values, round_money_axis(next));
        next += step;
    }
}

fn approx_eq(left: f64, right: f64, epsilon: f64) -> bool {
    (left - right).abs() <= epsilon
}

#[cfg(test)]
mod tests {
    use super::*;
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
    fn monte_carlo_success_rate_in_range() {
        let p = base_plan();
        let result = run_monte_carlo(&p, 100_000.0, 500);
        assert!(result.success_rate >= 0.0 && result.success_rate <= 1.0);
        assert_eq!(result.n_simulations, 500);
        assert_eq!(result.age_axis.first(), Some(&p.personal.current_age));
        assert_eq!(
            result.age_axis.last(),
            Some(&p.personal.planning_horizon_age)
        );
    }

    #[test]
    fn seeded_monte_carlo_is_stable() {
        let p = base_plan();
        let a = run_monte_carlo_with_mode_and_seed(
            &p,
            100_000.0,
            100,
            RetirementTimingMode::Fire,
            Some(42),
        );
        let b = run_monte_carlo_with_mode_and_seed(
            &p,
            100_000.0,
            100,
            RetirementTimingMode::Fire,
            Some(42),
        );

        assert_eq!(a.success_rate, b.success_rate);
        assert_eq!(a.median_fire_age, b.median_fire_age);
        assert_eq!(a.percentiles.p10, b.percentiles.p10);
        assert_eq!(a.percentiles.p50, b.percentiles.p50);
        assert_eq!(
            a.final_portfolio_at_horizon.p10,
            b.final_portfolio_at_horizon.p10
        );
    }

    #[test]
    fn monte_carlo_clamps_zero_simulations_to_one() {
        let p = base_plan();
        let result = run_monte_carlo_with_mode_and_seed(
            &p,
            100_000.0,
            0,
            RetirementTimingMode::Fire,
            Some(42),
        );

        assert_eq!(result.n_simulations, 1);
        assert_eq!(result.age_axis.first(), Some(&p.personal.current_age));
        assert_eq!(
            result.age_axis.last(),
            Some(&p.personal.planning_horizon_age)
        );
    }

    #[test]
    fn monte_carlo_accepts_zero_volatility() {
        let mut p = base_plan();
        p.investment.annual_volatility = 0.0;

        let result = run_monte_carlo_with_mode_and_seed(
            &p,
            100_000.0,
            25,
            RetirementTimingMode::Fire,
            Some(42),
        );

        assert_eq!(result.n_simulations, 25);
        assert!(result.success_rate >= 0.0 && result.success_rate <= 1.0);
    }

    #[test]
    fn sorr_produces_five_scenarios() {
        let p = base_plan();
        let scenarios = run_sorr(&p, 900_000.0, p.personal.target_retirement_age);
        assert_eq!(scenarios.len(), 5);
        assert_eq!(scenarios[0].label, "Base case");
        // Base scenario should survive with a healthy portfolio
        assert!(scenarios[0].survived);
    }

    #[test]
    fn sensitivity_dimensions() {
        let p = base_plan();
        let result = run_sensitivity_analysis(&p, 100_000.0);
        assert_eq!(result.contribution.contribution_rows.len(), 5);
        assert_eq!(result.contribution.return_columns.len(), 6);
        assert_eq!(result.contribution.fire_ages.len(), 5);
    }

    #[test]
    fn decision_sensitivity_returns_two_outcome_grids() {
        let p = base_plan();
        let contribution_return = run_decision_sensitivity_matrix_with_mode(
            &p,
            100_000.0,
            RetirementTimingMode::Fire,
            DecisionSensitivityMap::ContributionReturn,
        );
        let retirement_age_spending = run_decision_sensitivity_matrix_with_mode(
            &p,
            100_000.0,
            RetirementTimingMode::Fire,
            DecisionSensitivityMap::RetirementAgeSpending,
        );

        assert_eq!(contribution_return.row_values.len(), 5);
        assert_eq!(contribution_return.column_values.len(), 5);
        assert_eq!(contribution_return.cells.len(), 5);
        assert!(contribution_return.cells.iter().all(|row| row.len() == 5));
        assert_eq!(retirement_age_spending.row_values.len(), 5);
        assert_eq!(retirement_age_spending.column_values.len(), 5);
        assert_eq!(retirement_age_spending.cells.len(), 5);
        assert!(retirement_age_spending
            .cells
            .iter()
            .all(|row| row.len() == 5));
    }

    #[test]
    fn decision_sensitivity_highlights_baseline_cell() {
        let p = base_plan();
        let contribution_return = run_decision_sensitivity_matrix_with_mode(
            &p,
            100_000.0,
            RetirementTimingMode::Fire,
            DecisionSensitivityMap::ContributionReturn,
        );
        let retirement_age_spending = run_decision_sensitivity_matrix_with_mode(
            &p,
            100_000.0,
            RetirementTimingMode::Fire,
            DecisionSensitivityMap::RetirementAgeSpending,
        );

        assert_eq!(contribution_return.baseline_row, Some(2));
        assert_eq!(contribution_return.baseline_column, Some(2));
        assert_eq!(retirement_age_spending.baseline_row, Some(2));
        assert_eq!(retirement_age_spending.baseline_column, Some(2));
    }

    #[test]
    fn decision_sensitivity_baseline_matches_overview() {
        let p = base_plan();
        let contribution_return = run_decision_sensitivity_matrix_with_mode(
            &p,
            100_000.0,
            RetirementTimingMode::Fire,
            DecisionSensitivityMap::ContributionReturn,
        );
        let overview =
            compute_retirement_overview_with_mode(&p, 100_000.0, RetirementTimingMode::Fire);
        let expected_horizon = overview
            .trajectory
            .last()
            .map(|point| point.portfolio_end)
            .unwrap_or(0.0)
            / inflation_factor_to_age(&p, p.personal.planning_horizon_age);
        let cell = &contribution_return.cells[contribution_return.baseline_row.unwrap()]
            [contribution_return.baseline_column.unwrap()];

        assert_eq!(cell.fi_age, overview.fi_age);
        assert!((cell.portfolio_at_horizon - expected_horizon).abs() < 0.01);
    }

    #[test]
    fn stress_tests_return_expected_presets() {
        let p = base_plan();
        let stresses = run_stress_tests(&p, 100_000.0);
        let mut ids: Vec<_> = stresses.iter().map(|s| s.id.clone()).collect();
        ids.sort_by_key(|id| format!("{:?}", id));

        assert_eq!(stresses.len(), 6);
        assert!(ids.contains(&StressTestId::ReturnDrag));
        assert!(ids.contains(&StressTestId::InflationShock));
        assert!(ids.contains(&StressTestId::SpendingShock));
        assert!(ids.contains(&StressTestId::RetireEarlier));
        assert!(ids.contains(&StressTestId::SaveLess));
        assert!(ids.contains(&StressTestId::EarlyCrash));
    }

    #[test]
    fn stress_deltas_use_same_baseline() {
        let p = base_plan();
        let stresses = run_stress_tests(&p, 100_000.0);
        let baseline_shortfall = stresses[0].baseline.shortfall_at_goal_age;
        let baseline_horizon = stresses[0].baseline.portfolio_at_horizon;

        for stress in stresses {
            assert_eq!(stress.baseline.shortfall_at_goal_age, baseline_shortfall);
            assert_eq!(stress.baseline.portfolio_at_horizon, baseline_horizon);
            assert!(
                (stress.delta.shortfall_at_goal_age
                    - (stress.stressed.shortfall_at_goal_age
                        - stress.baseline.shortfall_at_goal_age))
                    .abs()
                    < 0.01
            );
            assert!(
                (stress.delta.portfolio_at_horizon
                    - (stress.stressed.portfolio_at_horizon
                        - stress.baseline.portfolio_at_horizon))
                    .abs()
                    < 0.01
            );
        }
    }

    #[test]
    fn early_crash_is_neutral_when_fire_plan_does_not_retire() {
        let mut p = base_plan();
        p.investment.monthly_contribution = 0.0;
        let stresses = run_stress_tests_with_mode(&p, 0.0, RetirementTimingMode::Fire);
        let early_crash = stresses
            .iter()
            .find(|stress| stress.id == StressTestId::EarlyCrash)
            .expect("early crash stress should be returned");

        assert_eq!(early_crash.baseline.retirement_start_age, None);
        assert_eq!(early_crash.stressed.retirement_start_age, None);
        assert_eq!(early_crash.delta.fi_age_years, None);
        assert_eq!(early_crash.delta.shortfall_at_goal_age, 0.0);
        assert_eq!(early_crash.delta.portfolio_at_horizon, 0.0);
        assert_eq!(early_crash.severity, StressSeverity::Low);
    }

    #[test]
    fn stress_mutators_change_only_intended_inputs() {
        let p = base_plan();

        let mut actual = p.clone();
        apply_return_drag_stress(&mut actual);
        let mut expected = p.clone();
        expected.investment.pre_retirement_annual_return -= 0.02;
        expected.investment.retirement_annual_return -= 0.02;
        assert_eq!(actual, expected);

        let mut actual = p.clone();
        apply_inflation_shock_stress(&mut actual);
        let mut expected = p.clone();
        expected.investment.inflation_rate += 0.015;
        assert_eq!(actual, expected);

        let mut actual = p.clone();
        apply_spending_shock_stress(&mut actual);
        let mut expected = p.clone();
        for item in &mut expected.expenses.items {
            item.monthly_amount *= 1.10;
        }
        assert_eq!(actual, expected);

        let mut actual = p.clone();
        apply_retire_earlier_stress(&mut actual);
        let mut expected = p.clone();
        expected.personal.target_retirement_age =
            (expected.personal.target_retirement_age.saturating_sub(2))
                .max(expected.personal.current_age + 1);
        assert_eq!(actual, expected);

        let mut actual = p.clone();
        apply_save_less_stress(&mut actual);
        let mut expected = p.clone();
        expected.investment.monthly_contribution *= 0.75;
        assert_eq!(actual, expected);
    }

    #[test]
    fn severe_stress_is_classified_high() {
        let baseline = StressOutcome {
            fi_age: Some(55),
            retirement_start_age: Some(55),
            funded_at_goal_age: true,
            shortfall_at_goal_age: 0.0,
            portfolio_at_horizon: 100_000.0,
            failure_age: None,
            spending_shortfall_age: None,
        };
        let stressed = StressOutcome {
            fi_age: Some(59),
            retirement_start_age: Some(59),
            funded_at_goal_age: false,
            shortfall_at_goal_age: 200_000.0,
            portfolio_at_horizon: 0.0,
            failure_age: None,
            spending_shortfall_age: None,
        };
        let delta = StressDelta {
            fi_age_years: Some(4),
            shortfall_at_goal_age: 200_000.0,
            portfolio_at_horizon: -100_000.0,
        };

        assert_eq!(
            classify_stress(&baseline, &stressed, &delta, 1_000_000.0),
            StressSeverity::High
        );
    }

    #[test]
    fn sorr_uses_retirement_start_age() {
        let p = base_plan();
        // SORR at age 50 (early retirement) vs 55 (target age)
        let sorr_50 = run_sorr(&p, 900_000.0, 50);
        let sorr_55 = run_sorr(&p, 900_000.0, 55);
        // Earlier retirement -> longer withdrawal period -> more data points
        assert!(
            sorr_50[0].portfolio_path.len() > sorr_55[0].portfolio_path.len(),
            "SORR at 50 should have longer path ({}) than at 55 ({})",
            sorr_50[0].portfolio_path.len(),
            sorr_55[0].portfolio_path.len(),
        );
    }

    #[test]
    fn sorr_does_not_extend_past_planning_horizon() {
        let mut p = base_plan();
        p.personal.target_retirement_age = 89;
        p.personal.planning_horizon_age = 90;

        let scenarios = run_sorr(&p, 900_000.0, 89);

        assert_eq!(scenarios.len(), 5);
        assert!(scenarios.iter().all(|scenario| scenario.returns.len() == 1));
        assert!(scenarios
            .iter()
            .all(|scenario| scenario.portfolio_path.len() == 2));
    }

    #[test]
    fn sorr_returns_empty_when_retirement_starts_at_horizon() {
        let mut p = base_plan();
        p.personal.target_retirement_age = 90;
        p.personal.planning_horizon_age = 90;

        let scenarios = run_sorr(&p, 900_000.0, 90);

        assert!(scenarios.is_empty());
    }

    #[test]
    fn sorr_does_not_add_recovery_premium_after_stress_years() {
        let p = base_plan();
        let normal_return = plan_retirement_return(&p);

        let scenarios = run_sorr(&p, 900_000.0, p.personal.target_retirement_age);

        assert!(scenarios[1].returns.iter().skip(1).all(|value| approx_eq(
            *value,
            normal_return,
            0.000_001
        )));
        assert!(scenarios[4].returns.iter().skip(10).all(|value| approx_eq(
            *value,
            normal_return,
            0.000_001
        )));
    }

    #[test]
    fn mc_underfunded_plan_has_no_median_fire_age() {
        let mut plan = base_plan();
        plan.expenses.items[0].monthly_amount = 50_000.0; // Very high expenses
        plan.investment.monthly_contribution = 100.0; // Tiny contributions
        let result = run_monte_carlo(&plan, 1_000.0, 100);
        // FI target = 50000*12/0.04 = 15M — unreachable with tiny contributions.
        // Fewer than 50% of sims should reach FI, so median_fire_age is None.
        assert!(
            result.median_fire_age.is_none(),
            "underfunded plan should have no median fire age, got {:?}",
            result.median_fire_age,
        );
    }

    #[test]
    fn sorr_returns_empty_when_not_funded() {
        let plan = base_plan();
        let scenarios = run_sorr(&plan, 0.0, 55);
        assert!(
            scenarios.is_empty(),
            "SORR should be empty for zero portfolio",
        );
    }
}
