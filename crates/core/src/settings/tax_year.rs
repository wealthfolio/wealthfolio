//! The day the user's tax year starts, and the tax years it gives.
//!
//! A tax year is named by the calendar year it ends in, as the Australian and
//! New Zealand tax offices name theirs: with a 1 July start, 1 July 2025 –
//! 30 June 2026 is tax year 2026. With the default 1 January start, tax year
//! 2026 is calendar year 2026.

use chrono::{Datelike, Days, NaiveDate};

/// Setting key for the tax year's start day, stored as `MM-DD`.
pub const TAX_YEAR_START_KEY: &str = "tax_year_start";
pub const DEFAULT_TAX_YEAR_START: &str = "01-01";

/// The month and day a tax year starts on. 29 February is never a start day:
/// it doesn't exist every year.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaxYearStart {
    month: u32,
    day: u32,
}

impl Default for TaxYearStart {
    fn default() -> Self {
        Self { month: 1, day: 1 }
    }
}

impl TaxYearStart {
    /// Reads `MM-DD`, such as `07-01` for 1 July.
    pub fn parse(value: &str) -> Option<Self> {
        let (month, day) = value.split_once('-')?;
        // Digits only: `u32::from_str` also takes a leading `+`.
        let two_digits = |part: &str| part.len() == 2 && part.bytes().all(|b| b.is_ascii_digit());
        if !two_digits(month) || !two_digits(day) {
            return None;
        }
        let month: u32 = month.parse().ok()?;
        let day: u32 = day.parse().ok()?;
        // 2001 is not a leap year, so a day that exists then exists every year.
        NaiveDate::from_ymd_opt(2001, month, day)?;
        Some(Self { month, day })
    }

    pub fn month(&self) -> u32 {
        self.month
    }

    pub fn day(&self) -> u32 {
        self.day
    }

    /// True for the default 1 January start, where tax years are calendar years.
    pub fn is_calendar_year(&self) -> bool {
        *self == Self::default()
    }

    /// The start day in calendar year `year`.
    fn start_in(&self, year: i32) -> NaiveDate {
        NaiveDate::from_ymd_opt(year, self.month, self.day)
            .expect("parse only accepts days that exist every year")
    }

    /// The calendar year tax year `year` starts in: the year before, unless
    /// tax years are calendar years.
    fn start_year(&self, year: i32) -> i32 {
        if self.is_calendar_year() {
            year
        } else {
            year - 1
        }
    }

    /// The tax year `date` falls in, named by the calendar year it ends in.
    pub fn tax_year_of(&self, date: NaiveDate) -> i32 {
        // A tax year that starts this year ends next year, unless it is a
        // calendar year.
        if !self.is_calendar_year() && date >= self.start_in(date.year()) {
            date.year() + 1
        } else {
            date.year()
        }
    }

    /// The first and last day of tax year `year`.
    pub fn range(&self, year: i32) -> (NaiveDate, NaiveDate) {
        let start_year = self.start_year(year);
        let end = self
            .start_in(start_year + 1)
            .checked_sub_days(Days::new(1))
            .expect("the day before a tax year's start exists");
        (self.start_in(start_year), end)
    }
}

impl std::fmt::Display for TaxYearStart {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:02}-{:02}", self.month, self.day)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(year: i32, month: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(year, month, day).unwrap()
    }

    #[test]
    fn parses_month_and_day() {
        let start = TaxYearStart::parse("07-01").unwrap();
        assert_eq!((start.month(), start.day()), (7, 1));
        assert_eq!(start.to_string(), "07-01");
        assert_eq!(TaxYearStart::parse("04-06").unwrap().to_string(), "04-06");
        assert!(TaxYearStart::parse(DEFAULT_TAX_YEAR_START)
            .unwrap()
            .is_calendar_year());
    }

    #[test]
    fn rejects_days_that_are_not_every_year() {
        for value in [
            "02-29", "02-30", "04-31", "13-01", "00-10", "01-00", "7-01", "07-1", "0701", "07-01x",
            "", "ab-cd", "+7-01", "07-+1",
        ] {
            assert!(TaxYearStart::parse(value).is_none(), "{value}");
        }
    }

    #[test]
    fn calendar_tax_years_are_calendar_years() {
        let start = TaxYearStart::default();
        assert_eq!(start.tax_year_of(date(2026, 1, 1)), 2026);
        assert_eq!(start.tax_year_of(date(2026, 12, 31)), 2026);
        assert_eq!(start.range(2026), (date(2026, 1, 1), date(2026, 12, 31)));
    }

    #[test]
    fn a_july_tax_year_is_named_by_the_year_it_ends_in() {
        let start = TaxYearStart::parse("07-01").unwrap();
        assert_eq!(start.tax_year_of(date(2026, 6, 30)), 2026);
        assert_eq!(start.tax_year_of(date(2026, 7, 1)), 2027);
        assert_eq!(start.tax_year_of(date(2026, 1, 15)), 2026);
        assert_eq!(start.range(2026), (date(2025, 7, 1), date(2026, 6, 30)));
    }

    #[test]
    fn a_6_april_tax_year_ends_on_5_april() {
        let start = TaxYearStart::parse("04-06").unwrap();
        assert_eq!(start.tax_year_of(date(2026, 4, 5)), 2026);
        assert_eq!(start.tax_year_of(date(2026, 4, 6)), 2027);
        assert_eq!(start.range(2026), (date(2025, 4, 6), date(2026, 4, 5)));
    }

    #[test]
    fn a_1_march_tax_year_ends_on_the_last_day_of_february() {
        let start = TaxYearStart::parse("03-01").unwrap();
        assert_eq!(start.range(2028), (date(2027, 3, 1), date(2028, 2, 29)));
        assert_eq!(start.range(2027), (date(2026, 3, 1), date(2027, 2, 28)));
        assert_eq!(start.tax_year_of(date(2028, 2, 29)), 2028);
    }
}
