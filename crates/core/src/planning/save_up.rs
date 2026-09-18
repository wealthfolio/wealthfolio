//! Save-Up goal projection engine.
//!
//! Daily compounding for growth using actual calendar day counts,
//! monthly contributions at end of month, annualReturn as decimal (0.07 = 7%).

use chrono::{Datelike, NaiveDate};
use serde::{Deserialize, Serialize};

use crate::errors::{Result, ValidationError};

const MAX_SAVE_UP_AMOUNT: f64 = 1_000_000_000_000.0;
const MAX_SAVE_UP_MONTHLY_CONTRIBUTION: f64 = 1_000_000_000.0;
const MIN_SAVE_UP_ANNUAL_RETURN: f64 = -0.20;
const MAX_SAVE_UP_ANNUAL_RETURN: f64 = 0.50;
const MAX_SAVE_UP_HORIZON_MONTHS: i32 = 1200;

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
    /// YYYY-MM
    pub date: String,
    pub nominal: f64,
    pub optimistic: f64,
    pub pessimistic: f64,
    pub target: f64,
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
    let this_first = NaiveDate::from_ymd_opt(year, month, 1).unwrap();
    let next_first = NaiveDate::from_ymd_opt(next_year, next_month, 1).unwrap();
    (next_first - this_first).num_days() as u32
}

/// Difference in calendar days between two dates (b - a).
fn days_between(a: NaiveDate, b: NaiveDate) -> i64 {
    (b - a).num_days()
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

/// Advance a NaiveDate by one month (same day, clamped).
fn advance_month(d: NaiveDate) -> NaiveDate {
    let (y, m) = if d.month() == 12 {
        (d.year() + 1, 1)
    } else {
        (d.year(), d.month() + 1)
    };
    let max_day = days_in_month(y, m);
    let day = d.day().min(max_day);
    NaiveDate::from_ymd_opt(y, m, day).unwrap()
}

// ---------------------------------------------------------------------------
// Core math
// ---------------------------------------------------------------------------

/// Future value with daily compounding and monthly end-of-month contributions.
/// Uses actual calendar day counts per month.
pub fn future_value(
    principal: f64,
    monthly_contribution: f64,
    annual_rate: f64,
    start_date: NaiveDate,
    end_date: NaiveDate,
) -> f64 {
    if end_date <= start_date {
        return principal;
    }

    let daily_rate = annual_rate / 365.0;
    let mut balance = principal;
    let mut cursor = start_date;

    while cursor < end_date {
        // End of current month (last day)
        let dim = days_in_month(cursor.year(), cursor.month());
        let month_end = NaiveDate::from_ymd_opt(cursor.year(), cursor.month(), dim).unwrap();
        let period_end = if month_end < end_date {
            month_end
        } else {
            end_date
        };

        let days = days_between(cursor, period_end);
        if days > 0 {
            balance *= (1.0 + daily_rate).powi(days as i32);
        }

        // Add contribution at end of month (only if we reached month end, not early endDate)
        if period_end == month_end && period_end < end_date {
            balance += monthly_contribution;
        }

        // Move cursor to day after period_end
        cursor = period_end + chrono::Duration::days(1);
    }

    balance
}

/// Bisection solver: find monthly contribution needed so future_value >= target.
pub fn solve_required_monthly(
    current: f64,
    target: f64,
    annual_rate: f64,
    start_date: NaiveDate,
    end_date: NaiveDate,
) -> f64 {
    if end_date <= start_date {
        return (target - current).max(0.0);
    }
    if current >= target {
        return 0.0;
    }

    let mut lo = 0.0_f64;
    let mut hi = target;

    for _ in 0..50 {
        let mid = (lo + hi) / 2.0;
        let fv = future_value(current, mid, annual_rate, start_date, end_date);
        if fv < target {
            lo = mid;
        } else {
            hi = mid;
        }
    }

    ((lo + hi) / 2.0).ceil()
}

/// Month-by-month iteration to find when balance first reaches target.
/// Returns `None` if target is never reached within `max_months`.
pub fn find_completion_date(
    current: f64,
    target: f64,
    monthly_contribution: f64,
    annual_rate: f64,
    start_date: NaiveDate,
    max_months: i32,
) -> Option<NaiveDate> {
    if current >= target {
        return Some(start_date);
    }
    if monthly_contribution <= 0.0 && annual_rate <= 0.0 {
        return None;
    }

    let daily_rate = annual_rate / 365.0;
    let mut balance = current;
    let mut cursor = start_date;

    for _ in 1..=max_months {
        let days = days_in_month(cursor.year(), cursor.month());
        balance *= (1.0 + daily_rate).powi(days as i32);
        balance += monthly_contribution;
        cursor = advance_month(cursor);
        if balance >= target {
            return Some(cursor);
        }
    }

    None
}

/// Generate monthly trajectory points with 3 scenarios.
pub fn generate_projection_series(
    input: &SaveUpInput,
    months: i32,
    as_of: chrono::NaiveDate,
) -> Vec<SaveUpTrajectoryPoint> {
    if months <= 0 {
        return vec![];
    }

    let rates = [
        (
            "pessimistic",
            (input.expected_annual_return - 0.02).max(0.0),
        ),
        ("nominal", input.expected_annual_return),
        ("optimistic", input.expected_annual_return + 0.02),
    ];

    let start = as_of;

    // We collect into an ordered vec of (label, nominal, optimistic, pessimistic).
    // First build per-scenario vectors, then merge.
    let mut labels: Vec<String> = Vec::with_capacity((months + 1) as usize);
    let mut nominal_vals: Vec<f64> = Vec::with_capacity((months + 1) as usize);
    let mut optimistic_vals: Vec<f64> = Vec::with_capacity((months + 1) as usize);
    let mut pessimistic_vals: Vec<f64> = Vec::with_capacity((months + 1) as usize);

    for &(scenario_key, rate) in &rates {
        let daily_rate = rate / 365.0;
        let mut balance = input.current_value;
        let mut cursor = start;

        for m in 0..=months {
            let label = format!("{}-{:02}", cursor.year(), cursor.month());

            match scenario_key {
                "nominal" => {
                    labels.push(label);
                    nominal_vals.push(balance);
                }
                "optimistic" => {
                    optimistic_vals.push(balance);
                }
                "pessimistic" => {
                    pessimistic_vals.push(balance);
                }
                _ => unreachable!(),
            }

            if m < months {
                let days = days_in_month(cursor.year(), cursor.month());
                balance *= (1.0 + daily_rate).powi(days as i32);
                balance += input.monthly_contribution;
                cursor = advance_month(cursor);
            }
        }
    }

    labels
        .into_iter()
        .enumerate()
        .map(|(i, date)| SaveUpTrajectoryPoint {
            date,
            nominal: nominal_vals[i],
            optimistic: optimistic_vals[i],
            pessimistic: pessimistic_vals[i],
            target: input.target_amount,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/// Compute the full save-up overview from inputs.
pub fn compute_save_up_overview(input: &SaveUpInput, as_of: chrono::NaiveDate) -> SaveUpOverview {
    let now = as_of;

    let target_date = input.target_date.as_deref().and_then(parse_date);

    let progress = if input.target_amount > 0.0 {
        (input.current_value / input.target_amount).clamp(0.0, 1.0)
    } else {
        0.0
    };

    // If no target date, many projections are not applicable.
    let (projected_value, required_monthly, health, trajectory) = if let Some(td) = target_date {
        let projected = future_value(
            input.current_value,
            input.monthly_contribution,
            input.expected_annual_return,
            now,
            td,
        );

        let required = solve_required_monthly(
            input.current_value,
            input.target_amount,
            input.expected_annual_return,
            now,
            td,
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

        let months = months_between(now, td).min(MAX_SAVE_UP_HORIZON_MONTHS);
        let traj = generate_projection_series(input, months, as_of);

        (projected, required, h, traj)
    } else {
        // No target date
        (0.0, 0.0, "not_applicable".to_string(), vec![])
    };

    // Completion date: search regardless of target date
    let projected_completion_date = if input.target_amount > 0.0 {
        let search_months = if let Some(td) = target_date {
            let m = months_between(now, td);
            (m * 3).clamp(120, MAX_SAVE_UP_HORIZON_MONTHS)
        } else {
            600 // 50 years
        };

        find_completion_date(
            input.current_value,
            input.target_amount,
            input.monthly_contribution,
            input.expected_annual_return,
            now,
            search_months,
        )
        .map(|d| d.format("%Y-%m-%d").to_string())
    } else {
        None
    };

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
    #[test]
    fn overview_uses_the_supplied_date_for_growth_and_trajectory() {
        let input = SaveUpInput {
            current_value: 1000.0,
            target_amount: 2000.0,
            target_date: Some("2027-01-01".to_string()),
            monthly_contribution: 100.0,
            expected_annual_return: 0.10,
        };
        let december =
            compute_save_up_overview(&input, NaiveDate::from_ymd_opt(2025, 12, 31).unwrap());
        let january =
            compute_save_up_overview(&input, NaiveDate::from_ymd_opt(2026, 1, 1).unwrap());
        assert_eq!(december.trajectory[0].date, "2025-12");
        assert_eq!(january.trajectory[0].date, "2026-01");
        assert!(december.projected_value_at_target_date > january.projected_value_at_target_date);
    }

    const AS_OF: chrono::NaiveDate = chrono::NaiveDate::from_ymd_opt(2026, 1, 1).unwrap();
    use super::*;

    fn date(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
    }

    #[test]
    fn test_days_in_month() {
        assert_eq!(days_in_month(2024, 2), 29); // leap year
        assert_eq!(days_in_month(2023, 2), 28);
        assert_eq!(days_in_month(2024, 1), 31);
        assert_eq!(days_in_month(2024, 4), 30);
    }

    #[test]
    fn test_future_value_no_time() {
        let fv = future_value(1000.0, 100.0, 0.07, date(2024, 6, 1), date(2024, 6, 1));
        assert_eq!(fv, 1000.0);
    }

    #[test]
    fn test_future_value_end_before_start() {
        let fv = future_value(1000.0, 100.0, 0.07, date(2025, 1, 1), date(2024, 1, 1));
        assert_eq!(fv, 1000.0);
    }

    #[test]
    fn test_future_value_one_year() {
        let fv = future_value(10000.0, 500.0, 0.07, date(2024, 1, 1), date(2025, 1, 1));
        // With daily compounding at 7% on 10k + 500/mo contributions, should be ~17k
        assert!(fv > 16000.0 && fv < 18000.0, "fv was {}", fv);
    }

    #[test]
    fn test_future_value_zero_rate() {
        let fv = future_value(1000.0, 100.0, 0.0, date(2024, 1, 1), date(2025, 1, 1));
        // 1000 + 12 * 100 = 2200 (but last contribution may not happen depending on month boundary)
        assert!(fv > 2100.0 && fv < 2300.0, "fv was {}", fv);
    }

    #[test]
    fn test_solve_required_monthly_already_met() {
        let req =
            solve_required_monthly(50000.0, 10000.0, 0.07, date(2024, 1, 1), date(2030, 1, 1));
        assert_eq!(req, 0.0);
    }

    #[test]
    fn test_solve_required_monthly_basic() {
        let req = solve_required_monthly(0.0, 100000.0, 0.07, date(2024, 1, 1), date(2034, 1, 1));
        // Need ~573/mo at 7% for 10 years to reach 100k
        assert!(req > 500.0 && req < 700.0, "req was {}", req);
    }

    #[test]
    fn test_find_completion_already_met() {
        let d = find_completion_date(50000.0, 10000.0, 100.0, 0.07, date(2024, 1, 1), 120);
        assert_eq!(d, Some(date(2024, 1, 1)));
    }

    #[test]
    fn test_find_completion_never() {
        let d = find_completion_date(0.0, 1_000_000.0, 0.0, 0.0, date(2024, 1, 1), 120);
        assert_eq!(d, None);
    }

    #[test]
    fn test_find_completion_basic() {
        let d = find_completion_date(10000.0, 50000.0, 500.0, 0.07, date(2024, 1, 1), 600);
        assert!(d.is_some());
        let completion = d.unwrap();
        // ~5.5 years roughly
        assert!(
            completion.year() >= 2029 && completion.year() <= 2031,
            "completion was {}",
            completion
        );
    }

    #[test]
    fn test_compute_overview_on_track() {
        let input = SaveUpInput {
            current_value: 80000.0,
            target_amount: 100000.0,
            target_date: Some("2030-01-01".to_string()),
            monthly_contribution: 500.0,
            expected_annual_return: 0.07,
        };
        let overview = compute_save_up_overview(&input, AS_OF);
        assert_eq!(overview.health, "on_track");
        assert!(overview.projected_value_at_target_date > 100000.0);
        assert!(overview.progress > 0.79 && overview.progress < 0.81);
    }

    #[test]
    fn test_compute_overview_no_target_date() {
        let input = SaveUpInput {
            current_value: 5000.0,
            target_amount: 50000.0,
            target_date: None,
            monthly_contribution: 200.0,
            expected_annual_return: 0.05,
        };
        let overview = compute_save_up_overview(&input, AS_OF);
        assert_eq!(overview.health, "not_applicable");
        assert_eq!(overview.projected_value_at_target_date, 0.0);
        assert!(overview.trajectory.is_empty());
        // But completion date should still be computed
        assert!(overview.projected_completion_date.is_some());
    }

    #[test]
    fn test_compute_overview_zero_target() {
        let input = SaveUpInput {
            current_value: 1000.0,
            target_amount: 0.0,
            target_date: Some("2030-01-01".to_string()),
            monthly_contribution: 100.0,
            expected_annual_return: 0.07,
        };
        let overview = compute_save_up_overview(&input, AS_OF);
        assert_eq!(overview.health, "not_applicable");
        assert_eq!(overview.progress, 0.0);
    }

    #[test]
    fn validate_save_up_input_rejects_unbounded_preview_work() {
        let target_date = AS_OF
            .checked_add_months(chrono::Months::new((MAX_SAVE_UP_HORIZON_MONTHS + 1) as u32))
            .unwrap()
            .format("%Y-%m-%d")
            .to_string();
        let input = SaveUpInput {
            current_value: 1000.0,
            target_amount: 50_000.0,
            target_date: Some(target_date),
            monthly_contribution: 100.0,
            expected_annual_return: 0.07,
        };

        assert!(validate_save_up_input(&input, AS_OF)
            .expect_err("distant target dates should be rejected")
            .to_string()
            .contains("within 100 years"));
    }

    #[test]
    fn validate_save_up_input_rejects_invalid_amounts_and_returns() {
        let input = SaveUpInput {
            current_value: 1000.0,
            target_amount: f64::INFINITY,
            target_date: Some("2030-01-01".to_string()),
            monthly_contribution: 100.0,
            expected_annual_return: 0.07,
        };
        assert!(validate_save_up_input(&input, AS_OF)
            .expect_err("non-finite target should be rejected")
            .to_string()
            .contains("Target amount"));

        let input = SaveUpInput {
            current_value: 1000.0,
            target_amount: 50_000.0,
            target_date: Some("2030-01-01".to_string()),
            monthly_contribution: 100.0,
            expected_annual_return: 2.0,
        };
        assert!(validate_save_up_input(&input, AS_OF)
            .expect_err("unbounded returns should be rejected")
            .to_string()
            .contains("Expected annual return"));
    }

    #[test]
    fn test_trajectory_length() {
        let input = SaveUpInput {
            current_value: 10000.0,
            target_amount: 50000.0,
            target_date: Some("2027-06-01".to_string()),
            monthly_contribution: 500.0,
            expected_annual_return: 0.07,
        };
        let overview = compute_save_up_overview(&input, AS_OF);
        // Trajectory should have roughly (months between now and target + 1) points
        assert!(!overview.trajectory.is_empty());
        // All points should have the target line
        for pt in &overview.trajectory {
            assert_eq!(pt.target, 50000.0);
            assert!(pt.optimistic >= pt.nominal);
            assert!(pt.nominal >= pt.pessimistic);
        }
    }
}
