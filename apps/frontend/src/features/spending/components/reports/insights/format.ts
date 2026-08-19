/**
 * Format helpers shared across the insights stages.
 *
 * Adapts the injected formatting service for the report domain's percent and
 * calendar-date conventions.
 */

import { calendarDateFromLocalDate, type FormattingApi } from "@wealthfolio/ui";

/** Format an already-percent value (e.g. `4.2` → `"4%"`). */
export function formatPercentValue(
  percent: number,
  formatting: Pick<FormattingApi, "formatPercent">,
  options: { digits?: number; signDisplay?: "auto" | "always" | "never" } = {},
): string {
  return formatting.formatPercent(percent / 100, options);
}

export const formatMonthName = (d: Date, formatting: Pick<FormattingApi, "formatCalendarDate">) =>
  formatting.formatCalendarDate(calendarDateFromLocalDate(d), { month: "long" });
export const formatMonthYear = (d: Date, formatting: Pick<FormattingApi, "formatCalendarDate">) =>
  formatting.formatCalendarDate(calendarDateFromLocalDate(d), {
    month: "short",
    year: "numeric",
  });
export const formatMonthDay = (d: Date, formatting: Pick<FormattingApi, "formatCalendarDate">) =>
  formatting.formatCalendarDate(calendarDateFromLocalDate(d), {
    month: "short",
    day: "numeric",
  });
export const formatYear = (d: Date, formatting: Pick<FormattingApi, "formatCalendarDate">) =>
  formatting.formatCalendarDate(calendarDateFromLocalDate(d), { year: "numeric" });
