/**
 * Period model for the Reports page.
 *
 * Distinct from the portfolio-wide `TimePeriod` because spending reports use
 * cashflow language: current month, last month, and longer comparison windows.
 */

import type { DateRange } from "@/lib/types";

import {
  addCalendarDays,
  addCalendarMonths,
  calendarDaysBetweenInclusive,
  calendarMonthsBetweenInclusive,
  daysInCalendarMonth,
  getZonedDateParts,
  zonedCalendarDateBoundaryToDate,
  type ZonedCalendarDate,
} from "./timezone";

export type ReportsPeriod = "MTD" | "LAST_MONTH" | "3M" | "6M" | "YTD" | "1Y" | "LAST_YEAR";

export const REPORTS_PERIODS: ReportsPeriod[] = [
  "MTD",
  "LAST_MONTH",
  "3M",
  "6M",
  "YTD",
  "1Y",
  "LAST_YEAR",
];

export const DEFAULT_REPORTS_PERIOD: ReportsPeriod = "MTD";

export type ComparisonMode = "prior" | "yoy" | "none";

export const DEFAULT_COMPARISON: ComparisonMode = "prior";

export interface ReportsRange {
  start: Date;
  end: Date;
  /** Number of calendar days the active window covers (inclusive). */
  days: number;
  /** Number of full months the active window covers (used for sparklines). */
  months: number;
}

/** Convert a period selection into the active date range. */
export function periodToReportsRange(
  period: ReportsPeriod,
  timezone?: string | null,
): ReportsRange {
  const now = new Date();
  const today = getZonedDateParts(now, timezone);
  const isLeapYear = today.year % 4 == 0;
  const daysToSubtract = isLeapYear ? 366 : 365;

  // For MTD/This month we span the full calendar month so "X days left in May"
  // reads correctly and forecasts can project past today. Last month also uses
  // a full calendar month. Longer periods stay "through today" since the
  // current month is naturally the trailing edge.
  const { start, end } = (() => {
    switch (period) {
      case "MTD": {
        return {
          start: { year: today.year, month: today.month, day: 1 },
          end: {
            year: today.year,
            month: today.month,
            day: daysInCalendarMonth(today.year, today.month),
          },
        };
      }
      case "LAST_MONTH": {
        const lastMonth = addCalendarMonths({ year: today.year, month: today.month, day: 1 }, -1);
        return {
          start: { year: lastMonth.year, month: lastMonth.month, day: 1 },
          end: {
            year: lastMonth.year,
            month: lastMonth.month,
            day: daysInCalendarMonth(lastMonth.year, lastMonth.month),
          },
        };
      }
      case "3M":
        return {
          start: addCalendarMonths({ year: today.year, month: today.month, day: 1 }, -2),
          end: today,
        };
      case "6M":
        return {
          start: addCalendarMonths({ year: today.year, month: today.month, day: 1 }, -5),
          end: today,
        };
      case "YTD":
        return { start: { year: today.year, month: 1, day: 1 }, end: today };
      case "1Y":
        return {
          start: addCalendarDays(
            { year: today.year, month: today.month, day: today.day },
            -daysToSubtract + 2,
          ),
          end: today,
        };
      case "LAST_YEAR":
        return {
          start: { year: today.year - 1, month: 1, day: 1 },
          end: { year: today.year - 1, month: 12, day: 31 },
        };
    }
  })();

  return {
    start: zonedCalendarDateBoundaryToDate(start, "start", timezone),
    end: zonedCalendarDateBoundaryToDate(end, "end", timezone),
    days: calendarDaysBetweenInclusive(start, end),
    months: calendarMonthsBetweenInclusive(start, end),
  };
}

/** Comparison range — equally-sized prior window or same period last year. */
export function comparisonRange(
  range: ReportsRange,
  mode: ComparisonMode,
  timezone?: string | null,
  period?: ReportsPeriod,
): ReportsRange | null {
  if (mode === "none") return null;
  const startParts = getZonedDateParts(range.start, timezone);
  const endParts = getZonedDateParts(range.end, timezone);
  if (mode === "yoy") {
    const start = subtractCalendarYear(startParts);
    const end = subtractCalendarYear(endParts);
    return {
      start: zonedCalendarDateBoundaryToDate(start, "start", timezone),
      end: zonedCalendarDateBoundaryToDate(end, "end", timezone),
      days: range.days,
      months: range.months,
    };
  }
  // mode === "prior" — semantically correct prior period based on the period type
  let priorRange: { start: ZonedCalendarDate; end: ZonedCalendarDate };

  if (period) {
    // Use period-aware logic to find the semantically correct prior period
    priorRange = getPriorPeriodRange(startParts, period);
  } else {
    // Fallback to day-based subtraction if period is not provided
    const priorEnd = addCalendarDays(startParts, -1);
    const priorStart = addCalendarDays(priorEnd, -(range.days - 1));
    priorRange = { start: priorStart, end: priorEnd };
  }

  return {
    start: zonedCalendarDateBoundaryToDate(priorRange.start, "start", timezone),
    end: zonedCalendarDateBoundaryToDate(priorRange.end, "end", timezone),
    days: range.days,
    months: range.months,
  };
}

/** Used by `react-router-dom` Link-typed APIs that expect a DateRange. */
export function toDateRange(range: ReportsRange): DateRange {
  return { from: range.start, to: range.end };
}

export function periodLabel(period: ReportsPeriod): string {
  switch (period) {
    case "MTD":
      return "This month";
    case "LAST_MONTH":
      return "Last month";
    case "3M":
      return "Past 3 months";
    case "6M":
      return "Past 6 months";
    case "YTD":
      return "Year to date";
    case "1Y":
      return "Past 12 months";
    case "LAST_YEAR":
      return "Past year";
  }
}

export function comparisonLabel(mode: ComparisonMode): string {
  switch (mode) {
    case "prior":
      return "Prior period";
    case "yoy":
      return "Same period last year";
    case "none":
      return "No comparison";
  }
}

function subtractCalendarYear(date: ZonedCalendarDate): ZonedCalendarDate {
  const year = date.year - 1;
  return {
    year,
    month: date.month,
    day: Math.min(date.day, daysInCalendarMonth(year, date.month)),
  };
}

/**
 * Get the semantically correct prior period range based on the period type.
 * This ensures that comparable periods maintain their semantic meaning:
 * - MTD (Mar 1–31) → LAST_MONTH (Feb 1–29)
 * - YTD (Jan 1–Dec 31, 2024) → Prior full year (Jan 1–Dec 31, 2023)
 * - 1Y (Jan 1–Dec 31, 2024) → Prior full year (Jan 1–Dec 31, 2023)
 */
function getPriorPeriodRange(
  currentStart: ZonedCalendarDate,
  period: ReportsPeriod,
): { start: ZonedCalendarDate; end: ZonedCalendarDate } {
  let start, end;

  switch (period) {
    case "MTD":
    case "LAST_MONTH":
      // Prior period is LAST_MONTH (full previous month)
      const lastMonth = addCalendarMonths(
        { year: currentStart.year, month: currentStart.month, day: 1 },
        -1,
      );
      start = { year: lastMonth.year, month: lastMonth.month, day: 1 };
      end = {
        year: lastMonth.year,
        month: lastMonth.month,
        day: daysInCalendarMonth(lastMonth.year, lastMonth.month),
      };
      break;

    case "3M":
      // Prior 3-month window: the 3 months immediately before the current start
      const threeMonthsBeforeStart = addCalendarMonths(
        { year: currentStart.year, month: currentStart.month, day: 1 },
        -3,
      );
      // End is the day before current start
      start = threeMonthsBeforeStart;
      end = addCalendarDays(currentStart, -1);
      break;

    case "6M":
      // Prior 6-month window: the 6 months immediately before the current start
      const sixMonthsBeforeStart = addCalendarMonths(
        { year: currentStart.year, month: currentStart.month, day: currentStart.day },
        -6,
      );
      // End is the day before current start
      start = sixMonthsBeforeStart;
      end = addCalendarDays(currentStart, -1);
      break;

    case "YTD":
    case "LAST_YEAR":
      // Prior period is the full prior year
      start = { year: currentStart.year - 1, month: 1, day: 1 };
      end = { year: currentStart.year - 1, month: 12, day: 31 };
      break;

    case "1Y":
      // The 1 year immediately before the current start
      const twelveMonthsBeforeStart = addCalendarMonths(
        { year: currentStart.year, month: currentStart.month, day: currentStart.day },
        -12,
      );
      start = twelveMonthsBeforeStart;
      end = addCalendarDays(currentStart, -1);
      break;
  }

  return { start, end };
}
