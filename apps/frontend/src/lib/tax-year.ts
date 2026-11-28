import type { CalendarDateParts } from "@wealthfolio/ui";

/**
 * The day the user's tax year starts. A tax year is named by the calendar year
 * it ends in, as the Australian and New Zealand tax offices name theirs: with a
 * 1 July start, 1 July 2025 – 30 June 2026 is tax year 2026. With the default
 * 1 January start, tax year 2026 is calendar year 2026.
 * Matches `crates/core/src/settings/tax_year.rs`.
 */
export interface TaxYearStart {
  /** 1–12. */
  month: number;
  day: number;
}

export const DEFAULT_TAX_YEAR_START = "01-01";

/** Days in each month of a non-leap year: a start day must exist every year. */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** The last day a tax year can start on in `month`; 29 February is never one. */
export function lastTaxYearStartDay(month: number): number {
  return DAYS_IN_MONTH[month - 1] ?? 31;
}

/** Reads `MM-DD`, such as `07-01` for 1 July. */
export function parseTaxYearStart(value: string | null | undefined): TaxYearStart | null {
  const match = /^(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > lastTaxYearStartDay(month)) return null;
  return { month, day };
}

/** The stored setting's start, or 1 January when it is absent or unreadable. */
export function readTaxYearStart(value: string | null | undefined): TaxYearStart {
  return parseTaxYearStart(value) ?? { month: 1, day: 1 };
}

export function formatTaxYearStart({ month, day }: TaxYearStart): string {
  return `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function isCalendarTaxYear({ month, day }: TaxYearStart): boolean {
  return month === 1 && day === 1;
}

/** The tax year `date` falls in, named by the calendar year it ends in. */
export function taxYearOf(date: CalendarDateParts, start: TaxYearStart): number {
  const beforeStart =
    date.month < start.month || (date.month === start.month && date.day < start.day);
  // A tax year that starts this year ends next year, unless it is a calendar year.
  return beforeStart || isCalendarTaxYear(start) ? date.year : date.year + 1;
}

/** The first and last day of tax year `year`. */
export function taxYearRange(
  year: number,
  start: TaxYearStart,
): { start: CalendarDateParts; end: CalendarDateParts } {
  const startYear = isCalendarTaxYear(start) ? year : year - 1;
  // The day before the next start: Date.UTC rolls day 0 back into the month before.
  const end = new Date(Date.UTC(startYear + 1, start.month - 1, start.day - 1));
  return {
    start: { year: startYear, month: start.month, day: start.day },
    end: { year: end.getUTCFullYear(), month: end.getUTCMonth() + 1, day: end.getUTCDate() },
  };
}
