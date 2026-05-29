/**
 * Period model for the Reports page.
 *
 * Distinct from the dashboard's `DashboardPeriod` because Reports operate on
 * larger time horizons by default (≥3 months), and they pair the active
 * window with a comparison window (prior period or YoY).
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

export type ReportsPeriod = "1M" | "3M" | "6M" | "YTD" | "1Y";

export const REPORTS_PERIODS: ReportsPeriod[] = ["1M", "3M", "6M", "YTD", "1Y"];

export const DEFAULT_REPORTS_PERIOD: ReportsPeriod = "6M";

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

  // For 1M we span the full calendar month so "X days left in May" reads
  // correctly and forecasts can project past today. Other periods stay
  // "through today" since they cover multiple months and the "current month"
  // is naturally the trailing edge.
  const { start, end } = (() => {
    switch (period) {
      case "1M": {
        return {
          start: { year: today.year, month: today.month, day: 1 },
          end: {
            year: today.year,
            month: today.month,
            day: daysInCalendarMonth(today.year, today.month),
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
          start: addCalendarMonths({ year: today.year, month: today.month, day: 1 }, -11),
          end: today,
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
  // mode === "prior" — equally sized window ending the day before `range.start`
  const priorEnd = addCalendarDays(startParts, -1);
  const priorStart = addCalendarDays(priorEnd, -(range.days - 1));
  return {
    start: zonedCalendarDateBoundaryToDate(priorStart, "start", timezone),
    end: zonedCalendarDateBoundaryToDate(priorEnd, "end", timezone),
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
    case "1M":
      return "This month";
    case "3M":
      return "Past 3 months";
    case "6M":
      return "Past 6 months";
    case "YTD":
      return "Year to date";
    case "1Y":
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
