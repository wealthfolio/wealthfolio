/**
 * Format helpers shared across the insights stages.
 *
 * Wraps the canonical `formatPercent` from `@/lib/utils` for the common
 * "I already have a percent value, give me 'X%'" case, and centralises a
 * couple of `Intl.DateTimeFormat` configurations the stage components reach
 * for repeatedly.
 */

import { formatPercent as formatFractionPercent } from "@/lib/utils";

/** Format an already-percent value (e.g. `4.2` → `"4%"`). */
export function formatPercentValue(
  percent: number,
  options: { digits?: number; signDisplay?: "auto" | "always" | "never" } = {},
): string {
  return formatFractionPercent(percent / 100, options);
}

const monthLong = new Intl.DateTimeFormat(undefined, { month: "long" });
const monthShortYear = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" });
const monthDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const yearOnly = new Intl.DateTimeFormat(undefined, { year: "numeric" });

export const formatMonthName = (d: Date) => monthLong.format(d);
export const formatMonthYear = (d: Date) => monthShortYear.format(d);
export const formatMonthDay = (d: Date) => monthDay.format(d);
export const formatYear = (d: Date) => yearOnly.format(d);
