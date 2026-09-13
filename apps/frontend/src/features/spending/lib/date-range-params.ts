import { formatDateISO, parseLocalDate } from "@/lib/utils";

import type { ReportsRange } from "./reports-period";
import {
  calendarDaysBetweenInclusive,
  calendarMonthsBetweenInclusive,
  localDateParts,
  zonedCalendarDateBoundaryToDate,
} from "./timezone";

export const SPENDING_RANGE_FROM_PARAM = "spendingFrom";
export const SPENDING_RANGE_TO_PARAM = "spendingTo";

export interface SpendingDateRange {
  from: Date;
  to: Date;
}

export function parseSpendingDate(value: string | null): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = parseLocalDate(value);
  return Number.isNaN(date.getTime()) || formatDateISO(date) !== value ? null : date;
}

export function spendingRangeFromParams(params: URLSearchParams): SpendingDateRange | undefined {
  const from = parseSpendingDate(params.get(SPENDING_RANGE_FROM_PARAM));
  const to = parseSpendingDate(params.get(SPENDING_RANGE_TO_PARAM));
  if (!from || !to || from > to) return undefined;
  return { from, to };
}

/** Interpret picker dates as calendar days in the app timezone, not UTC instants. */
export function spendingRangeToReportsRange(
  range: SpendingDateRange,
  timezone?: string | null,
): ReportsRange {
  const start = localDateParts(range.from);
  const end = localDateParts(range.to);
  return {
    start: zonedCalendarDateBoundaryToDate(start, "start", timezone),
    end: zonedCalendarDateBoundaryToDate(end, "end", timezone),
    days: calendarDaysBetweenInclusive(start, end),
    months: calendarMonthsBetweenInclusive(start, end),
  };
}
