//! Date bounds for Spending filters. A bound is an RFC 3339 timestamp or a
//! plain `YYYY-MM-DD` day, which covers that whole day in the user's
//! timezone, as the Spending screens do.

use chrono::{DateTime, Duration, NaiveDate, SecondsFormat};
use wealthfolio_core::utils::time_utils::{local_date_start_utc, parse_user_timezone_or_default};

use crate::env::AgentEnvironment;
use crate::tool::AgentToolError;

/// Schema text for a date bound argument.
pub(crate) const DATE_BOUND_DESCRIPTION: &str =
    "Inclusive. A YYYY-MM-DD day in the user's timezone, or an RFC 3339 timestamp.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Bound {
    /// The first instant of a plain day.
    Start,
    /// The last millisecond of a plain day.
    End,
}

/// Returns `value` as an RFC 3339 timestamp. Timestamps pass through
/// unchanged; a plain day becomes its start or end in the user's timezone.
/// A malformed value fails without reading settings, and the error names
/// the field but never repeats the value.
pub(crate) fn date_bound(
    env: &dyn AgentEnvironment,
    field: &str,
    value: &str,
    bound: Bound,
) -> Result<String, AgentToolError> {
    let Some(day) = plain_day(field, value)? else {
        return Ok(value.to_string());
    };
    let settings = env
        .settings_service()
        .get_settings()
        .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;
    day_bound(field, day, bound, &settings.timezone)
}

/// [`date_bound`] for an optional argument.
pub(crate) fn optional_date_bound(
    env: &dyn AgentEnvironment,
    field: &str,
    value: Option<String>,
    bound: Bound,
) -> Result<Option<String>, AgentToolError> {
    value
        .map(|value| date_bound(env, field, &value, bound))
        .transpose()
}

fn invalid(field: &str) -> AgentToolError {
    AgentToolError::InvalidInput(format!(
        "{field} must be a YYYY-MM-DD date or an RFC 3339 timestamp"
    ))
}

/// `None` for a timestamp, the day for a plain `YYYY-MM-DD` date.
fn plain_day(field: &str, value: &str) -> Result<Option<NaiveDate>, AgentToolError> {
    if DateTime::parse_from_rfc3339(value).is_ok() {
        return Ok(None);
    }
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map(Some)
        .map_err(|_| invalid(field))
}

fn day_bound(
    field: &str,
    day: NaiveDate,
    bound: Bound,
    timezone: &str,
) -> Result<String, AgentToolError> {
    let tz = parse_user_timezone_or_default(timezone);
    let instant = match bound {
        Bound::Start => local_date_start_utc(day, tz),
        Bound::End => {
            let next = day.succ_opt().ok_or_else(|| invalid(field))?;
            local_date_start_utc(next, tz).map(|start| start - Duration::milliseconds(1))
        }
    }
    .map_err(|e| AgentToolError::InvalidInput(format!("{field}: {e}")))?;
    Ok(instant.to_rfc3339_opts(SecondsFormat::Millis, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fails the test if the helper reads settings.
    struct NoServices;

    #[async_trait::async_trait]
    impl AgentEnvironment for NoServices {
        crate::tools::test_support::unreachable_services!();
    }

    fn bound_in(timezone: &str, value: &str, bound: Bound) -> Result<String, AgentToolError> {
        match plain_day("startDate", value)? {
            Some(day) => day_bound("startDate", day, bound, timezone),
            None => Ok(value.to_string()),
        }
    }

    #[test]
    fn plain_days_cover_the_whole_local_day() {
        let cases = [
            ("UTC", Bound::Start, "2026-01-01T00:00:00.000Z"),
            ("UTC", Bound::End, "2026-01-01T23:59:59.999Z"),
            ("America/Toronto", Bound::Start, "2026-01-01T05:00:00.000Z"),
            ("America/Toronto", Bound::End, "2026-01-02T04:59:59.999Z"),
            ("", Bound::Start, "2026-01-01T00:00:00.000Z"),
        ];
        for (timezone, bound, expected) in cases {
            assert_eq!(
                bound_in(timezone, "2026-01-01", bound).expect("valid day"),
                expected,
                "{timezone} {bound:?}"
            );
        }
    }

    #[test]
    fn timestamps_and_bad_values_never_read_settings() {
        let value = "2026-01-01T08:30:00+02:00";
        assert_eq!(
            date_bound(&NoServices, "endDate", value, Bound::End).expect("timestamp"),
            value
        );
        for value in ["2026-13-01", "01/02/2026", "2026-01-01T00:00", "private"] {
            let error = date_bound(&NoServices, "startDate", value, Bound::Start).unwrap_err();
            let message = error.to_string();
            assert!(message.contains("startDate must be"), "{value}: {message}");
            assert!(!message.contains(value), "{value}: {message}");
        }
    }
}
