use crate::errors::{Error, Result, ValidationError};
use chrono::{
    DateTime, Datelike, Duration, LocalResult, NaiveDate, NaiveTime, TimeZone, Utc, Weekday,
};
use chrono_tz::Tz;
use wealthfolio_market_data::resolver::exchange_metadata;

pub type UtcDateRangeBounds = (Option<DateTime<Utc>>, Option<DateTime<Utc>>);

/// Default timezone for valuation dates.
/// This is used as a runtime fallback when user timezone is missing.
pub const DEFAULT_VALUATION_TZ: Tz = chrono_tz::UTC;

/// Parse and validate an IANA timezone string.
pub fn parse_user_timezone(tz_raw: &str) -> Result<Tz> {
    let normalized = tz_raw.trim();
    if normalized.is_empty() {
        return Err(Error::Validation(ValidationError::InvalidInput(
            "Timezone cannot be empty".to_string(),
        )));
    }

    normalized.parse::<Tz>().map_err(|_| {
        Error::Validation(ValidationError::InvalidInput(format!(
            "Invalid timezone: {normalized}"
        )))
    })
}

/// Parse timezone or fall back to DEFAULT_VALUATION_TZ.
pub fn parse_user_timezone_or_default(tz_raw: &str) -> Tz {
    parse_user_timezone(tz_raw).unwrap_or(DEFAULT_VALUATION_TZ)
}

/// Canonicalize timezone string for persistence.
pub fn canonicalize_timezone(tz_raw: &str) -> Result<String> {
    let tz = parse_user_timezone(tz_raw)?;
    Ok(tz.name().to_string())
}

/// Converts a UTC instant to a valuation date in the given timezone.
///
/// This is the single source of truth for converting instants to domain dates.
/// Use this whenever you need to derive a "business date" from a timestamp.
///
/// # Arguments
/// * `instant` - The UTC timestamp to convert
/// * `tz` - The timezone to use for the conversion
pub fn valuation_date_from_utc(instant: DateTime<Utc>, tz: Tz) -> NaiveDate {
    instant.with_timezone(&tz).date_naive()
}

/// Convenience function that uses the default valuation timezone.
/// Equivalent to `valuation_date_from_utc(instant, DEFAULT_VALUATION_TZ)`.
pub fn valuation_date_today() -> NaiveDate {
    valuation_date_from_utc(crate::utils::clock::now(), DEFAULT_VALUATION_TZ)
}

/// Returns today's date in the configured user timezone.
pub fn user_today(tz: Tz) -> NaiveDate {
    valuation_date_from_utc(crate::utils::clock::now(), tz)
}

/// Converts a UTC instant to a user-local date.
pub fn user_date_from_utc(instant: DateTime<Utc>, tz: Tz) -> NaiveDate {
    valuation_date_from_utc(instant, tz)
}

/// Converts an activity UTC timestamp to a user-local date.
pub fn activity_date_in_tz(activity_instant: DateTime<Utc>, tz: Tz) -> NaiveDate {
    valuation_date_from_utc(activity_instant, tz)
}

/// Converts an activity UTC timestamp to a user-local date using a timezone name.
/// Invalid or empty timezone values fall back to UTC.
pub fn activity_date_in_user_timezone(activity_instant: DateTime<Utc>, tz_raw: &str) -> NaiveDate {
    activity_date_in_tz(activity_instant, parse_user_timezone_or_default(tz_raw))
}

/// Returns UTC boundaries for a local calendar year in a timezone.
/// The returned range is [start_utc, end_utc_exclusive).
pub fn local_year_utc_bounds(year: i32, tz: Tz) -> Result<(DateTime<Utc>, DateTime<Utc>)> {
    let start_local = resolve_local_datetime(tz.with_ymd_and_hms(year, 1, 1, 0, 0, 0), year)?;
    let end_exclusive_local =
        resolve_local_datetime(tz.with_ymd_and_hms(year + 1, 1, 1, 0, 0, 0), year + 1)?;

    Ok((
        start_local.with_timezone(&Utc),
        end_exclusive_local.with_timezone(&Utc),
    ))
}

/// Returns UTC boundaries for an inclusive local date range in a timezone.
/// The returned range is [start_utc, end_utc_exclusive).
pub fn local_date_range_utc_bounds(
    start: Option<NaiveDate>,
    end: Option<NaiveDate>,
    tz: Tz,
) -> Result<UtcDateRangeBounds> {
    let start_utc = start
        .map(|date| local_date_start_utc(date, tz))
        .transpose()?;
    let end_exclusive_utc = end
        .map(|date| {
            let next_date = date.succ_opt().ok_or_else(|| {
                Error::Validation(ValidationError::InvalidInput(format!(
                    "Invalid local date range end: {date}"
                )))
            })?;
            local_date_start_utc(next_date, tz)
        })
        .transpose()?;

    Ok((start_utc, end_exclusive_utc))
}

/// The first instant of a local calendar day, in UTC. When a DST change skips
/// local midnight, the day starts where the skipped time ends. A day that never
/// existed locally (a date-line jump) is an error.
pub fn local_date_start_utc(date: NaiveDate, tz: Tz) -> Result<DateTime<Utc>> {
    let midnight = date.and_time(NaiveTime::MIN);
    // Gaps last at most a few hours and end on a quarter hour.
    (0..=12)
        .find_map(|quarter| {
            tz.from_local_datetime(&(midnight + Duration::minutes(15 * quarter)))
                .earliest()
        })
        .map(|start| start.with_timezone(&Utc))
        .ok_or_else(|| {
            Error::Validation(ValidationError::InvalidInput(format!(
                "{date} does not exist in {tz}"
            )))
        })
}

/// The instant a bare calendar date is stored at: the later of UTC midnight and
/// the start of that day in `tz`. It falls on `date` both in UTC and in `tz`, so
/// readers that work in either see the same day. West of UTC that is local
/// midnight; at or east of UTC, UTC midnight.
pub fn calendar_day_instant(date: NaiveDate, tz: Tz) -> DateTime<Utc> {
    let utc_midnight = date.and_time(NaiveTime::MIN).and_utc();
    local_date_start_utc(date, tz).map_or(utc_midnight, |start| start.max(utc_midnight))
}

fn resolve_local_datetime(
    result: LocalResult<chrono::DateTime<Tz>>,
    year: i32,
) -> Result<chrono::DateTime<Tz>> {
    match result {
        LocalResult::Single(dt) => Ok(dt),
        LocalResult::Ambiguous(earliest, _) => Ok(earliest),
        LocalResult::None => Err(Error::Validation(ValidationError::InvalidInput(format!(
            "Invalid local datetime boundary for year {year}"
        )))),
    }
}

/// Default grace period after market close before considering a new trading day.
pub const DEFAULT_MARKET_CLOSE_GRACE_MINUTES: i64 = 60;

pub fn get_days_between(start: NaiveDate, end: NaiveDate) -> Vec<NaiveDate> {
    if start > end {
        return Vec::new();
    }
    let mut days = Vec::new();
    let mut current = start;
    while current <= end {
        days.push(current);
        if let Some(next) = current.succ_opt() {
            current = next;
        } else {
            // Should not happen for typical date ranges
            break;
        }
    }
    days
}

/// Returns the most recent trading day (weekday) before the given date.
fn previous_trading_day(date: NaiveDate) -> NaiveDate {
    let mut current = date;
    while let Some(prev) = current.pred_opt() {
        current = prev;
        let weekday = current.weekday();
        if weekday != Weekday::Sat && weekday != Weekday::Sun {
            return current;
        }
    }
    date
}

/// Returns the effective trading date for a given exchange at the provided instant.
///
/// If the exchange is known, this uses its local timezone and close time to decide
/// whether the "current" trading day has completed. If the market has not closed
/// (plus grace), the effective date is the previous trading day. Unknown exchanges
/// fall back to the UTC date.
///
/// `is_continuous` should be `true` for 24/7 markets (e.g. crypto): weekend dates
/// are returned as-is instead of being rolled back to the previous trading day.
pub fn market_effective_date(
    now: DateTime<Utc>,
    mic: Option<&str>,
    is_continuous: bool,
) -> NaiveDate {
    let (tz, close_time) = match mic
        .and_then(exchange_metadata::mic_to_timezone)
        .and_then(|tz_name| tz_name.parse::<Tz>().ok())
    {
        Some(tz) => (tz, mic.and_then(exchange_metadata::mic_to_market_close)),
        None => (DEFAULT_VALUATION_TZ, None),
    };

    let local_now = now.with_timezone(&tz);
    let local_date = local_now.date_naive();

    // 24/7 markets (crypto) have no weekend close — return the calendar date as-is.
    if !is_continuous {
        let weekday = local_date.weekday();
        if weekday == Weekday::Sat || weekday == Weekday::Sun {
            return previous_trading_day(local_date);
        }
    }

    let Some((close_hour, close_minute)) = close_time else {
        return local_date;
    };

    let Some(close_naive) = local_date.and_hms_opt(close_hour.into(), close_minute.into(), 0)
    else {
        return local_date;
    };

    let close_local = tz
        .from_local_datetime(&close_naive)
        .single()
        .or_else(|| tz.from_local_datetime(&close_naive).earliest())
        .or_else(|| tz.from_local_datetime(&close_naive).latest());

    let Some(close_local) = close_local else {
        return local_date;
    };

    let cutoff = close_local + Duration::minutes(DEFAULT_MARKET_CLOSE_GRACE_MINUTES);
    if local_now < cutoff {
        previous_trading_day(local_date)
    } else {
        local_date
    }
}

/// Returns the market-local trading date for fetch windows.
///
/// Unlike `market_effective_date`, this does not wait for market close + grace.
/// It uses the exchange-local calendar day (weekends roll back to prior trading day).
///
/// `is_continuous` should be `true` for 24/7 markets (e.g. crypto): weekend dates
/// are returned as-is instead of being rolled back to the previous trading day.
pub fn market_calendar_date(
    now: DateTime<Utc>,
    mic: Option<&str>,
    is_continuous: bool,
) -> NaiveDate {
    let tz = mic
        .and_then(exchange_metadata::mic_to_timezone)
        .and_then(|tz_name| tz_name.parse::<Tz>().ok())
        .unwrap_or(DEFAULT_VALUATION_TZ);

    let local_date = now.with_timezone(&tz).date_naive();
    if is_continuous {
        return local_date;
    }
    let weekday = local_date.weekday();
    if weekday == Weekday::Sat || weekday == Weekday::Sun {
        previous_trading_day(local_date)
    } else {
        local_date
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn parse_user_timezone_rejects_empty() {
        let err = parse_user_timezone("").unwrap_err().to_string();
        assert!(err.contains("Timezone cannot be empty"));
    }

    #[test]
    fn parse_user_timezone_rejects_invalid() {
        let err = parse_user_timezone("Mars/Phobos").unwrap_err().to_string();
        assert!(err.contains("Invalid timezone"));
    }

    #[test]
    fn canonicalize_timezone_returns_iana_name() {
        assert_eq!(
            canonicalize_timezone("America/Toronto").unwrap(),
            "America/Toronto"
        );
    }

    #[test]
    fn parse_user_timezone_or_default_falls_back_to_utc() {
        let tz = parse_user_timezone_or_default("invalid");
        assert_eq!(tz, chrono_tz::UTC);
    }

    #[test]
    fn user_date_from_utc_handles_dst_transition() {
        let tz = chrono_tz::Europe::Paris;
        let instant = Utc.with_ymd_and_hms(2026, 3, 29, 0, 30, 0).unwrap();
        let local_date = user_date_from_utc(instant, tz);
        assert_eq!(local_date.to_string(), "2026-03-29");
    }

    #[test]
    fn activity_date_in_user_timezone_uses_timezone_name() {
        let instant = Utc.with_ymd_and_hms(2025, 1, 1, 1, 30, 0).unwrap();
        let local_date = activity_date_in_user_timezone(instant, "America/Toronto");
        assert_eq!(local_date.to_string(), "2024-12-31");
    }

    #[test]
    fn local_year_utc_bounds_match_local_midnight_boundaries() {
        let tz = chrono_tz::Pacific::Kiritimati; // UTC+14 edge case
        let (start_utc, end_exclusive_utc) = local_year_utc_bounds(2026, tz).unwrap();
        assert_eq!(
            start_utc,
            Utc.with_ymd_and_hms(2025, 12, 31, 10, 0, 0).unwrap()
        );
        assert_eq!(
            end_exclusive_utc,
            Utc.with_ymd_and_hms(2026, 12, 31, 10, 0, 0).unwrap()
        );
    }

    fn day(year: i32, month: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(year, month, day).unwrap()
    }

    #[test]
    fn local_date_start_utc_starts_a_gap_day_where_the_gap_ends() {
        // Chile springs forward at midnight: 2024-09-08 00:00 does not exist,
        // the day starts at 01:00 -03:00.
        let start = local_date_start_utc(day(2024, 9, 8), chrono_tz::America::Santiago).unwrap();
        assert_eq!(start, Utc.with_ymd_and_hms(2024, 9, 8, 4, 0, 0).unwrap());
        // Samoa skipped 2011-12-30 entirely.
        assert!(local_date_start_utc(day(2011, 12, 30), chrono_tz::Pacific::Apia).is_err());
    }

    #[test]
    fn local_date_range_utc_bounds_accept_a_dst_gap_day() {
        let tz = chrono_tz::America::Santiago;
        let (start_utc, end_exclusive_utc) =
            local_date_range_utc_bounds(Some(day(2024, 9, 8)), Some(day(2024, 9, 8)), tz).unwrap();
        assert_eq!(
            start_utc,
            Some(Utc.with_ymd_and_hms(2024, 9, 8, 4, 0, 0).unwrap())
        );
        assert_eq!(
            end_exclusive_utc,
            Some(Utc.with_ymd_and_hms(2024, 9, 9, 3, 0, 0).unwrap())
        );
    }

    #[test]
    fn calendar_day_instant_falls_on_the_day_in_utc_and_locally() {
        let utc = |h| Utc.with_ymd_and_hms(2026, 4, 1, h, 0, 0).unwrap();
        // West of UTC: local midnight.
        assert_eq!(
            calendar_day_instant(day(2026, 4, 1), chrono_tz::America::Toronto),
            utc(4)
        );
        assert_eq!(
            calendar_day_instant(day(2026, 4, 1), chrono_tz::Pacific::Honolulu),
            utc(10)
        );
        // At or east of UTC: UTC midnight.
        for tz in [
            chrono_tz::UTC,
            chrono_tz::Europe::Paris,
            chrono_tz::Asia::Tokyo,
            chrono_tz::Pacific::Kiritimati,
        ] {
            assert_eq!(calendar_day_instant(day(2026, 4, 1), tz), utc(0), "{tz}");
        }
        // A DST gap at midnight west of UTC: where the gap ends.
        assert_eq!(
            calendar_day_instant(day(2024, 9, 8), chrono_tz::America::Santiago),
            Utc.with_ymd_and_hms(2024, 9, 8, 4, 0, 0).unwrap()
        );
        // A day that never existed locally keeps UTC midnight.
        assert_eq!(
            calendar_day_instant(day(2011, 12, 30), chrono_tz::Pacific::Apia),
            Utc.with_ymd_and_hms(2011, 12, 30, 0, 0, 0).unwrap()
        );
    }

    #[test]
    fn local_date_range_utc_bounds_match_local_midnight_boundaries() {
        let tz = chrono_tz::America::Toronto;
        let (start_utc, end_exclusive_utc) = local_date_range_utc_bounds(
            Some(NaiveDate::from_ymd_opt(2024, 1, 3).unwrap()),
            Some(NaiveDate::from_ymd_opt(2024, 1, 3).unwrap()),
            tz,
        )
        .unwrap();

        assert_eq!(
            start_utc,
            Some(Utc.with_ymd_and_hms(2024, 1, 3, 5, 0, 0).unwrap())
        );
        assert_eq!(
            end_exclusive_utc,
            Some(Utc.with_ymd_and_hms(2024, 1, 4, 5, 0, 0).unwrap())
        );
    }
}
