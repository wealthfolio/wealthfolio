import type { FormattingApi } from "@wealthfolio/ui";

import { localDateFromParts } from "./month-period";
import type { ReportsRange } from "./reports-period";
import { calendarDaysBetweenInclusive, zonedCalendarDateBoundaryToDate } from "./timezone";

export const MIN_CALENDAR_YEAR = 1970;
export const SPENDING_YEAR_PARAM = "spendingYear";

/** Calendar picks cover completed years; the current year remains the YTD preset. */
export function parseCalendarYear(value: unknown, todayISO: string): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d{4}$/.test(value))) {
    return null;
  }
  const year = Number(value);
  return Number.isInteger(year) && year >= MIN_CALENDAR_YEAR && year < Number(todayISO.slice(0, 4))
    ? year
    : null;
}

export function yearRange(year: number) {
  return {
    from: localDateFromParts({ year, month: 1, day: 1 }),
    to: localDateFromParts({ year, month: 12, day: 31 }),
  };
}

export function yearReportsRange(year: number, timezone?: string | null): ReportsRange {
  const start = { year, month: 1, day: 1 };
  const end = { year, month: 12, day: 31 };
  return {
    start: zonedCalendarDateBoundaryToDate(start, "start", timezone),
    end: zonedCalendarDateBoundaryToDate(end, "end", timezone),
    days: calendarDaysBetweenInclusive(start, end),
    months: 12,
  };
}

export function yearLabel(year: number, formatting: Pick<FormattingApi, "formatCalendarDate">) {
  return formatting.formatCalendarDate(
    { year, month: 1, day: 1 },
    { calendar: "gregory", year: "numeric" },
  );
}
