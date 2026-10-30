//! Save-Up goal projection engine.
//!
//! One simulation drives every output, so the health status, projected value,
//! required contribution, completion date and chart always agree.
//!
//! - The expected return is an effective annual rate (0.05 = 5% a year), the
//!   meaning the retirement planner gives it. `d` days grow the balance by
//!   `(1 + r)^(d / 365)`.
//! - The monthly contribution lands at each calendar month-end after `as_of`,
//!   up to and including the target date. Money saved by `as_of` is already in
//!   the current value.
//! - The simulation records the balance at each month-end and on the target
//!   date.

use chrono::{Datelike, Months, NaiveDate};
use serde::{Deserialize, Serialize};

use crate::errors::{Result, ValidationError};

const MAX_SAVE_UP_AMOUNT: f64 = 1_000_000_000_000.0;
const MAX_SAVE_UP_MONTHLY_CONTRIBUTION: f64 = 1_000_000_000.0;
const MIN_SAVE_UP_ANNUAL_RETURN: f64 = -0.20;
const MAX_SAVE_UP_ANNUAL_RETURN: f64 = 0.50;
const MAX_SAVE_UP_HORIZON_MONTHS: i32 = 1200;
/// Expected return for a goal without a saved plan. The save-up editor shows the same default.
pub const DEFAULT_SAVE_UP_ANNUAL_RETURN: f64 = 0.05;
/// The chart's optimistic and pessimistic scenarios sit this far from the expected return.
const SCENARIO_RETURN_SPREAD: f64 = 0.02;
/// How far ahead the completion date search looks for a goal without a target date.
const UNDATED_COMPLETION_SEARCH_MONTHS: i32 = 600;
/// The shortest completion date search for a goal with a target date.
const MIN_DATED_COMPLETION_SEARCH_MONTHS: i32 = 120;
/// Most whole-unit steps used to correct float rounding in the required contribution.
const REQUIRED_MONTHLY_CORRECTION_STEPS: u32 = 4;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveUpInput {
    pub current_value: f64,
    pub target_amount: f64,
    /// ISO date string (YYYY-MM-DD). `None` means open-ended.
    pub target_date: Option<String>,
    pub monthly_contribution: f64,
    pub expected_annual_return: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveUpOverview {
    pub current_value: f64,
    pub target_amount: f64,
    /// 0.0 .. 1.0
    pub progress: f64,
    /// "on_track" | "at_risk" | "off_track" | "not_applicable"
    pub health: String,
    pub projected_value_at_target_date: f64,
    pub required_monthly_contribution: f64,
    pub projected_completion_date: Option<String>,
    pub trajectory: Vec<SaveUpTrajectoryPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveUpTrajectoryPoint {
    /// YYYY-MM-DD: `as_of`, then each month-end, then the target date.
    pub date: String,
    pub nominal: f64,
    pub optimistic: f64,
    pub pessimistic: f64,
    pub target: f64,
    /// Balance needed on this date to still reach the target by the target date
    /// with the planned monthly contribution. Not below zero, or below `nominal`
    /// when that is negative, so `nominal >= needed` exactly when on track.
    pub needed: f64,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Number of days in a given month (1-indexed month).
fn days_in_month(year: i32, month: u32) -> u32 {
    // The last day of month M is day 0 of month M+1 in many date libs.
    // In chrono we compute the first day of the next month then subtract.
    let (next_year, next_month) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    let this_first =
        NaiveDate::from_ymd_opt(year, month, 1).expect("callers pass a month from a NaiveDate");
    let next_first =
        NaiveDate::from_ymd_opt(next_year, next_month, 1).expect("the next month is 1-12");
    (next_first - this_first).num_days() as u32
}

/// Parse an ISO date string (YYYY-MM-DD) to NaiveDate.
fn parse_date(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

/// Months between two dates (whole calendar months).
fn months_between(start: NaiveDate, end: NaiveDate) -> i32 {
    let m = (end.year() - start.year()) * 12 + (end.month() as i32 - start.month() as i32);
    m.max(0)
}

fn invalid_save_up_input(message: impl Into<String>) -> crate::errors::Error {
    ValidationError::InvalidInput(message.into()).into()
}

fn validate_finite_amount(label: &str, value: f64, min: f64, max: f64) -> Result<()> {
    if value.is_finite() && value >= min && value <= max {
        Ok(())
    } else {
        Err(invalid_save_up_input(format!(
            "{label} must be between {min:.0} and {max:.0}"
        )))
    }
}

pub fn validate_save_up_input(input: &SaveUpInput, as_of: chrono::NaiveDate) -> Result<()> {
    validate_finite_amount(
        "Current value",
        input.current_value,
        -MAX_SAVE_UP_AMOUNT,
        MAX_SAVE_UP_AMOUNT,
    )?;
    validate_finite_amount(
        "Target amount",
        input.target_amount,
        0.0,
        MAX_SAVE_UP_AMOUNT,
    )?;
    validate_finite_amount(
        "Monthly contribution",
        input.monthly_contribution,
        0.0,
        MAX_SAVE_UP_MONTHLY_CONTRIBUTION,
    )?;

    if !input.expected_annual_return.is_finite()
        || input.expected_annual_return < MIN_SAVE_UP_ANNUAL_RETURN
        || input.expected_annual_return > MAX_SAVE_UP_ANNUAL_RETURN
    {
        return Err(invalid_save_up_input(format!(
            "Expected annual return must be between {:.0}% and {:.0}%",
            MIN_SAVE_UP_ANNUAL_RETURN * 100.0,
            MAX_SAVE_UP_ANNUAL_RETURN * 100.0
        )));
    }

    if let Some(target_date) = input.target_date.as_deref() {
        let parsed = parse_date(target_date)
            .ok_or_else(|| invalid_save_up_input("Target date must use YYYY-MM-DD"))?;
        let now = as_of;
        if months_between(now, parsed) > MAX_SAVE_UP_HORIZON_MONTHS {
            return Err(invalid_save_up_input(
                "Target date must be within 100 years",
            ));
        }
    }

    Ok(())
}

/// Last day of a month.
fn month_end(year: i32, month: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(year, month, days_in_month(year, month))
        .expect("days_in_month is the month's length")
}

/// The first month-end after `date`.
fn next_month_end(date: NaiveDate) -> NaiveDate {
    let end = month_end(date.year(), date.month());
    if end > date {
        return end;
    }
    let (year, month) = if date.month() == 12 {
        (date.year() + 1, 1)
    } else {
        (date.year(), date.month() + 1)
    };
    month_end(year, month)
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

/// A date the simulation records: a month-end, the target date, or both.
#[derive(Debug, Clone, Copy)]
struct Checkpoint {
    date: NaiveDate,
    /// The monthly contribution lands on this date.
    contributes: bool,
}

/// Month-ends after `start` up to `until`, plus `target_date` when it falls in that range.
fn checkpoints(
    start: NaiveDate,
    until: NaiveDate,
    target_date: Option<NaiveDate>,
) -> Vec<Checkpoint> {
    let mut pending_target = target_date.filter(|date| *date > start && *date <= until);
    let mut points = Vec::new();
    let mut month_end = next_month_end(start);
    while month_end <= until {
        if let Some(date) = pending_target.filter(|date| *date <= month_end) {
            if date < month_end {
                points.push(Checkpoint {
                    date,
                    contributes: false,
                });
            }
            pending_target = None;
        }
        points.push(Checkpoint {
            date: month_end,
            contributes: true,
        });
        month_end = next_month_end(month_end);
    }
    if let Some(date) = pending_target {
        points.push(Checkpoint {
            date,
            contributes: false,
        });
    }
    points
}

/// Growth over `days` at an effective annual rate.
fn growth(annual_rate: f64, days: i64) -> f64 {
    (1.0 + annual_rate).powf(days as f64 / 365.0)
}

/// Balance at each checkpoint, starting from `current` on `start`.
fn simulate(
    current: f64,
    monthly_contribution: f64,
    annual_rate: f64,
    start: NaiveDate,
    points: &[Checkpoint],
) -> Vec<f64> {
    let mut balance = current;
    let mut previous = start;
    points
        .iter()
        .map(|point| {
            balance *= growth(annual_rate, (point.date - previous).num_days());
            if point.contributes {
                balance += monthly_contribution;
            }
            previous = point.date;
            balance
        })
        .collect()
}

/// Smallest whole monthly contribution that reaches `target` by the last
/// checkpoint. With no month-end before then, the shortfall as one amount.
fn required_monthly(
    current: f64,
    target: f64,
    annual_rate: f64,
    start: NaiveDate,
    points: &[Checkpoint],
) -> f64 {
    let final_balance = |monthly: f64| {
        simulate(current, monthly, annual_rate, start, points)
            .last()
            .copied()
            .unwrap_or(current)
    };
    let without = final_balance(0.0);
    if without >= target {
        return 0.0;
    }
    // The final balance grows linearly with the contribution. Simulate one unit
    // on its own: subtracting two large balances would lose its precision.
    let per_unit = simulate(0.0, 1.0, annual_rate, start, points)
        .last()
        .copied()
        .unwrap_or(0.0);
    if per_unit <= 0.0 {
        return (target - without).ceil();
    }
    let mut monthly = ((target - without) / per_unit).ceil().max(0.0);
    // Float rounding can leave the estimate a unit off this simulation's result.
    for _ in 0..REQUIRED_MONTHLY_CORRECTION_STEPS {
        if final_balance(monthly) < target {
            monthly += 1.0;
        } else if monthly >= 1.0 && final_balance(monthly - 1.0) >= target {
            monthly -= 1.0;
        } else {
            break;
        }
    }
    monthly
}

/// Balance needed on `start` and at each checkpoint to still reach `target` at
/// the last checkpoint with the planned contribution. Negative when the
/// contributions alone more than cover the target.
fn needed_path(
    target: f64,
    monthly_contribution: f64,
    annual_rate: f64,
    start: NaiveDate,
    points: &[Checkpoint],
) -> Vec<f64> {
    let mut needed = vec![target; points.len() + 1];
    let mut next = target;
    for (i, point) in points.iter().enumerate().rev() {
        let previous = if i == 0 { start } else { points[i - 1].date };
        let before_contribution = if point.contributes {
            next - monthly_contribution
        } else {
            next
        };
        next = before_contribution / growth(annual_rate, (point.date - previous).num_days());
        needed[i] = next;
    }
    needed
}

/// Chart points: `as_of`, then each checkpoint through the target date.
fn trajectory(
    input: &SaveUpInput,
    as_of: NaiveDate,
    points: &[Checkpoint],
) -> Vec<SaveUpTrajectoryPoint> {
    if points.is_empty() {
        return vec![];
    }
    let rate = input.expected_annual_return;
    let path = |annual_rate: f64| {
        let mut balances = vec![input.current_value];
        balances.extend(simulate(
            input.current_value,
            input.monthly_contribution,
            annual_rate,
            as_of,
            points,
        ));
        balances
    };
    let nominal = path(rate);
    let optimistic = path(rate + SCENARIO_RETURN_SPREAD);
    let pessimistic = path((rate - SCENARIO_RETURN_SPREAD).max(0.0));
    let needed = needed_path(
        input.target_amount,
        input.monthly_contribution,
        rate,
        as_of,
        points,
    );

    std::iter::once(as_of)
        .chain(points.iter().map(|point| point.date))
        .enumerate()
        .map(|(i, date)| SaveUpTrajectoryPoint {
            date: date.format("%Y-%m-%d").to_string(),
            nominal: nominal[i],
            optimistic: optimistic[i],
            pessimistic: pessimistic[i],
            target: input.target_amount,
            // Plot no lower than zero, or than the projection when it is below
            // zero. The projection still sits above the line exactly when on track.
            needed: needed[i].max(nominal[i].min(0.0)),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/// Compute the full save-up overview from inputs.
pub fn compute_save_up_overview(input: &SaveUpInput, as_of: chrono::NaiveDate) -> SaveUpOverview {
    let target_date = input.target_date.as_deref().and_then(parse_date);
    let rate = input.expected_annual_return;

    let progress = if input.target_amount > 0.0 {
        (input.current_value / input.target_amount).clamp(0.0, 1.0)
    } else {
        0.0
    };

    // Simulate through the target date and far enough past it to find the completion date.
    let search_months = match target_date {
        Some(td) => (months_between(as_of, td) * 3).clamp(
            MIN_DATED_COMPLETION_SEARCH_MONTHS,
            MAX_SAVE_UP_HORIZON_MONTHS,
        ),
        None => UNDATED_COMPLETION_SEARCH_MONTHS,
    };
    let until = as_of
        .checked_add_months(Months::new(search_months as u32))
        .unwrap_or(as_of);
    let until = target_date.map_or(until, |td| until.max(td));
    let points = checkpoints(as_of, until, target_date);
    let path = simulate(
        input.current_value,
        input.monthly_contribution,
        rate,
        as_of,
        &points,
    );

    let (projected_value, required_monthly, health, trajectory) = if let Some(td) = target_date {
        let through_target = points.partition_point(|point| point.date <= td);
        let to_target = &points[..through_target];
        let projected = path[..through_target]
            .last()
            .copied()
            .unwrap_or(input.current_value);

        let required = required_monthly(
            input.current_value,
            input.target_amount,
            rate,
            as_of,
            to_target,
        );

        let h = if input.target_amount <= 0.0 {
            "not_applicable".to_string()
        } else if projected >= input.target_amount {
            "on_track".to_string()
        } else if projected >= input.target_amount * 0.9 {
            "at_risk".to_string()
        } else {
            "off_track".to_string()
        };

        (projected, required, h, trajectory(input, as_of, to_target))
    } else {
        // No target date
        (0.0, 0.0, "not_applicable".to_string(), vec![])
    };

    // Completion date: search regardless of target date
    let projected_completion_date = if input.target_amount <= 0.0 {
        None
    } else if input.current_value >= input.target_amount {
        Some(as_of)
    } else {
        points
            .iter()
            .zip(&path)
            .find(|(_, balance)| **balance >= input.target_amount)
            .map(|(point, _)| point.date)
    }
    .map(|d| d.format("%Y-%m-%d").to_string());

    SaveUpOverview {
        current_value: input.current_value,
        target_amount: input.target_amount,
        progress,
        health,
        projected_value_at_target_date: projected_value,
        required_monthly_contribution: required_monthly,
        projected_completion_date,
        trajectory,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const AS_OF: chrono::NaiveDate = chrono::NaiveDate::from_ymd_opt(2026, 1, 1).unwrap();

    fn date(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
    }

    fn input(
        current_value: f64,
        target_amount: f64,
        target_date: Option<&str>,
        monthly_contribution: f64,
        expected_annual_return: f64,
    ) -> SaveUpInput {
        SaveUpInput {
            current_value,
            target_amount,
            target_date: target_date.map(str::to_string),
            monthly_contribution,
            expected_annual_return,
        }
    }

    fn final_point(overview: &SaveUpOverview) -> &SaveUpTrajectoryPoint {
        overview.trajectory.last().expect("dated goal has a chart")
    }

    #[test]
    fn test_days_in_month() {
        assert_eq!(days_in_month(2024, 2), 29); // leap year
        assert_eq!(days_in_month(2023, 2), 28);
        assert_eq!(days_in_month(2024, 1), 31);
        assert_eq!(days_in_month(2024, 4), 30);
    }

    #[test]
    fn overview_uses_the_supplied_date_for_growth_and_trajectory() {
        let input = input(1000.0, 2000.0, Some("2027-01-01"), 100.0, 0.10);
        let december = compute_save_up_overview(&input, date(2025, 12, 31));
        let january = compute_save_up_overview(&input, date(2026, 1, 1));
        assert_eq!(december.trajectory[0].date, "2025-12-31");
        assert_eq!(january.trajectory[0].date, "2026-01-01");
        assert!(december.projected_value_at_target_date > january.projected_value_at_target_date);
    }

    #[test]
    fn expected_return_is_an_effective_annual_rate() {
        let overview = compute_save_up_overview(
            &input(10_000.0, 20_000.0, Some("2027-01-01"), 0.0, 0.05),
            AS_OF,
        );
        assert!((overview.projected_value_at_target_date - 10_500.0).abs() < 1e-6);
        assert_eq!(
            final_point(&overview).nominal,
            overview.projected_value_at_target_date
        );
    }

    // The example from wealthfolio/wealthfolio#2204: status, chart and completion date disagreed.
    #[test]
    fn status_agrees_with_chart_and_completion_date() {
        let overview = compute_save_up_overview(
            &input(10_000.0, 10_510.0, Some("2027-01-01"), 0.0, 0.05),
            AS_OF,
        );
        assert_eq!(overview.health, "at_risk");
        assert_eq!(final_point(&overview).date, "2027-01-01");
        assert_eq!(
            final_point(&overview).nominal,
            overview.projected_value_at_target_date
        );
        assert_eq!(
            overview.projected_completion_date.as_deref(),
            Some("2027-01-31")
        );
        assert_eq!(overview.required_monthly_contribution, 1.0);

        let with_required = compute_save_up_overview(
            &input(10_000.0, 10_510.0, Some("2027-01-01"), 1.0, 0.05),
            AS_OF,
        );
        assert_eq!(with_required.health, "on_track");
        assert_eq!(
            with_required.projected_completion_date.as_deref(),
            Some("2026-12-31")
        );
    }

    #[test]
    fn contributions_land_at_month_ends_after_today() {
        // Today is a month-end: its contribution is already in the current value.
        let overview = compute_save_up_overview(
            &input(0.0, 100.0, Some("2026-02-01"), 100.0, 0.0),
            date(2026, 1, 31),
        );
        assert_eq!(overview.projected_value_at_target_date, 0.0);
        assert_eq!(overview.health, "off_track");
        assert_eq!(
            overview.projected_completion_date.as_deref(),
            Some("2026-02-28")
        );
        // No month-end before the target date, so the shortfall is due as one amount.
        assert_eq!(overview.required_monthly_contribution, 100.0);

        // A contribution on the target date counts.
        let overview = compute_save_up_overview(
            &input(0.0, 300.0, Some("2026-03-31"), 100.0, 0.0),
            date(2026, 1, 15),
        );
        assert_eq!(overview.projected_value_at_target_date, 300.0);
        assert_eq!(overview.health, "on_track");
        assert_eq!(
            overview.projected_completion_date.as_deref(),
            Some("2026-03-31")
        );
    }

    #[test]
    fn completion_dates_stay_on_month_ends() {
        let overview =
            compute_save_up_overview(&input(0.0, 1_000.0, None, 100.0, 0.0), date(2026, 1, 31));
        assert_eq!(
            overview.projected_completion_date.as_deref(),
            Some("2026-11-30")
        );
    }

    #[test]
    fn trajectory_points_are_today_month_ends_and_target_date() {
        let overview = compute_save_up_overview(
            &input(0.0, 1_000.0, Some("2026-04-10"), 100.0, 0.0),
            date(2026, 1, 15),
        );
        let dates: Vec<&str> = overview
            .trajectory
            .iter()
            .map(|p| p.date.as_str())
            .collect();
        assert_eq!(
            dates,
            [
                "2026-01-15",
                "2026-01-31",
                "2026-02-28",
                "2026-03-31",
                "2026-04-10"
            ]
        );
        let nominal: Vec<f64> = overview.trajectory.iter().map(|p| p.nominal).collect();
        assert_eq!(nominal, [0.0, 100.0, 200.0, 300.0, 300.0]);
    }

    #[test]
    fn needed_path_ends_at_target_and_matches_status() {
        let on_track = compute_save_up_overview(
            &input(5_000.0, 10_000.0, Some("2028-01-01"), 300.0, 0.06),
            AS_OF,
        );
        assert_eq!(on_track.health, "on_track");
        assert_eq!(final_point(&on_track).needed, 10_000.0);
        assert!(on_track.trajectory.iter().all(|p| p.nominal >= p.needed));

        let behind = compute_save_up_overview(
            &input(5_000.0, 20_000.0, Some("2028-01-01"), 300.0, 0.06),
            AS_OF,
        );
        assert_eq!(behind.health, "off_track");
        assert!(behind.trajectory.iter().all(|p| p.nominal < p.needed));
    }

    #[test]
    fn required_monthly_contribution_is_the_smallest_whole_amount() {
        // Ten years at 7% to reach 100k.
        let base = input(0.0, 100_000.0, Some("2036-01-01"), 0.0, 0.07);
        let required = compute_save_up_overview(&base, AS_OF).required_monthly_contribution;
        assert!(
            required > 500.0 && required < 700.0,
            "required was {required}"
        );
        let with = |monthly: f64| {
            compute_save_up_overview(
                &SaveUpInput {
                    monthly_contribution: monthly,
                    ..base.clone()
                },
                AS_OF,
            )
            .health
        };
        assert_eq!(with(required), "on_track");
        assert_ne!(with(required - 1.0), "on_track");
    }

    #[test]
    fn required_monthly_contribution_holds_for_large_balances() {
        let base = input(
            10_000_000_000.0,
            11_000_000_000.0,
            Some("2026-03-31"),
            0.0,
            0.05,
        );
        let required = compute_save_up_overview(&base, AS_OF).required_monthly_contribution;
        let health_with = |monthly: f64| {
            compute_save_up_overview(
                &SaveUpInput {
                    monthly_contribution: monthly,
                    ..base.clone()
                },
                AS_OF,
            )
            .health
        };
        assert_eq!(health_with(required), "on_track", "required was {required}");
        assert_ne!(health_with(required - 1.0), "on_track");
    }

    #[test]
    fn needed_line_matches_status_for_a_negative_balance() {
        let overview = compute_save_up_overview(
            &input(-1_000.0, 1_000.0, Some("2026-03-31"), 1_000.0, 0.0),
            AS_OF,
        );
        assert_eq!(overview.health, "on_track");
        assert!(overview.trajectory.iter().all(|p| p.nominal >= p.needed));
    }

    // save-up-projection-card.test.tsx draws these points.
    #[test]
    fn partial_month_target_keeps_an_at_risk_goal_below_the_needed_line() {
        let overview = compute_save_up_overview(
            &input(0.0, 3_001.0, Some("2026-04-01"), 1_000.0, 0.0),
            AS_OF,
        );
        assert_eq!(overview.health, "at_risk");
        let points: Vec<(&str, f64, f64)> = overview
            .trajectory
            .iter()
            .map(|p| (p.date.as_str(), p.nominal, p.needed))
            .collect();
        assert_eq!(
            points,
            [
                ("2026-01-01", 0.0, 1.0),
                ("2026-01-31", 1_000.0, 1_001.0),
                ("2026-02-28", 2_000.0, 2_001.0),
                ("2026-03-31", 3_000.0, 3_001.0),
                ("2026-04-01", 3_000.0, 3_001.0),
            ]
        );
    }

    #[test]
    fn test_compute_overview_on_track() {
        let overview = compute_save_up_overview(
            &input(80_000.0, 100_000.0, Some("2030-01-01"), 500.0, 0.07),
            AS_OF,
        );
        assert_eq!(overview.health, "on_track");
        assert!(overview.projected_value_at_target_date > 100000.0);
        assert!(overview.progress > 0.79 && overview.progress < 0.81);
        assert_eq!(overview.required_monthly_contribution, 0.0);
    }

    #[test]
    fn test_compute_overview_no_target_date() {
        let overview =
            compute_save_up_overview(&input(5_000.0, 50_000.0, None, 200.0, 0.05), AS_OF);
        assert_eq!(overview.health, "not_applicable");
        assert_eq!(overview.projected_value_at_target_date, 0.0);
        assert!(overview.trajectory.is_empty());
        // But completion date should still be computed
        assert!(overview.projected_completion_date.is_some());
    }

    #[test]
    fn test_compute_overview_zero_target() {
        let overview =
            compute_save_up_overview(&input(1_000.0, 0.0, Some("2030-01-01"), 100.0, 0.07), AS_OF);
        assert_eq!(overview.health, "not_applicable");
        assert_eq!(overview.progress, 0.0);
        assert_eq!(overview.projected_completion_date, None);
    }

    #[test]
    fn completion_is_today_when_already_met_and_none_when_never_reached() {
        let met = compute_save_up_overview(&input(50_000.0, 10_000.0, None, 100.0, 0.07), AS_OF);
        assert_eq!(met.projected_completion_date.as_deref(), Some("2026-01-01"));
        let never = compute_save_up_overview(&input(0.0, 1_000_000.0, None, 0.0, 0.0), AS_OF);
        assert_eq!(never.projected_completion_date, None);
    }

    #[test]
    fn past_target_date_uses_the_current_value() {
        let overview = compute_save_up_overview(
            &input(400.0, 1_000.0, Some("2025-06-01"), 100.0, 0.05),
            AS_OF,
        );
        assert_eq!(overview.projected_value_at_target_date, 400.0);
        assert_eq!(overview.required_monthly_contribution, 600.0);
        assert_eq!(overview.health, "off_track");
        assert!(overview.trajectory.is_empty());
    }

    #[test]
    fn validate_save_up_input_rejects_unbounded_preview_work() {
        let target_date = AS_OF
            .checked_add_months(chrono::Months::new((MAX_SAVE_UP_HORIZON_MONTHS + 1) as u32))
            .unwrap()
            .format("%Y-%m-%d")
            .to_string();
        let input = input(1000.0, 50_000.0, Some(&target_date), 100.0, 0.07);

        assert!(validate_save_up_input(&input, AS_OF)
            .expect_err("distant target dates should be rejected")
            .to_string()
            .contains("within 100 years"));
    }

    #[test]
    fn validate_save_up_input_rejects_invalid_amounts_and_returns() {
        let input_with_infinite_target =
            input(1000.0, f64::INFINITY, Some("2030-01-01"), 100.0, 0.07);
        assert!(validate_save_up_input(&input_with_infinite_target, AS_OF)
            .expect_err("non-finite target should be rejected")
            .to_string()
            .contains("Target amount"));

        let input_with_large_return = input(1000.0, 50_000.0, Some("2030-01-01"), 100.0, 2.0);
        assert!(validate_save_up_input(&input_with_large_return, AS_OF)
            .expect_err("unbounded returns should be rejected")
            .to_string()
            .contains("Expected annual return"));
    }

    #[test]
    fn test_trajectory_scenarios() {
        let overview = compute_save_up_overview(
            &input(10_000.0, 50_000.0, Some("2027-06-01"), 500.0, 0.07),
            AS_OF,
        );
        assert!(!overview.trajectory.is_empty());
        for pt in &overview.trajectory {
            assert_eq!(pt.target, 50000.0);
            assert!(pt.optimistic >= pt.nominal);
            assert!(pt.nominal >= pt.pessimistic);
        }
    }

    proptest! {
        // Status, chart, completion date, required contribution and needed path read one path.
        #[test]
        fn every_output_agrees_with_the_status(
            start_offset in 0i64..730,
            horizon_days in 1i64..3650,
            // Negative balances happen (overdrawn accounts); large ones test float precision.
            current in prop_oneof![-1_000_000.0f64..1_000_000.0, -1e9f64..1e11],
            target in prop_oneof![1.0f64..2_000_000.0, 1.0f64..2e11],
            monthly in prop_oneof![0.0f64..10_000.0, 0.0f64..1e9],
            rate in 0.0f64..0.5,
        ) {
            let as_of = AS_OF + chrono::Duration::days(start_offset);
            let target_date = as_of + chrono::Duration::days(horizon_days);
            let td = target_date.format("%Y-%m-%d").to_string();
            let goal = input(current, target, Some(&td), monthly, rate);
            let overview = compute_save_up_overview(&goal, as_of);

            let done_on_time = overview
                .projected_completion_date
                .as_deref()
                .and_then(parse_date)
                .is_some_and(|completion| completion <= target_date);
            prop_assert_eq!(overview.health == "on_track", done_on_time);

            let last = final_point(&overview);
            prop_assert_eq!(last.date.as_str(), td.as_str());
            prop_assert_eq!(last.nominal, overview.projected_value_at_target_date);
            prop_assert_eq!(last.needed, target);

            let gap = overview.projected_value_at_target_date - target;
            if gap.abs() > 1e-9 * overview.projected_value_at_target_date.abs().max(target) {
                for point in &overview.trajectory {
                    prop_assert_eq!(point.nominal >= point.needed, gap > 0.0);
                }
            }

            let required = overview.required_monthly_contribution;
            let health_with = |monthly: f64| compute_save_up_overview(
                &SaveUpInput { monthly_contribution: monthly, ..goal.clone() },
                as_of,
            )
            .health;
            let has_contribution_date = next_month_end(as_of) <= target_date;
            if has_contribution_date {
                prop_assert_eq!(health_with(required), "on_track");
                if required >= 1.0 {
                    prop_assert_ne!(health_with(required - 1.0), "on_track");
                }
            }
        }
    }
}
