/**
 * The income page's periods. Tax years are offered beside calendar years when
 * the tax year starts on a day other than 1 January.
 */
export type IncomePeriod = "ALL" | "YTD" | "LAST_YEAR" | "TAX_YTD" | "LAST_TAX_YEAR";

/** The server period each one compares with; All Time has none. */
export const PREVIOUS_INCOME_PERIOD: Record<IncomePeriod, string | null> = {
  ALL: null,
  YTD: "LAST_YEAR",
  LAST_YEAR: "TWO_YEARS_AGO",
  TAX_YTD: "LAST_TAX_YEAR",
  LAST_TAX_YEAR: "TWO_TAX_YEARS_AGO",
};

export function isTaxYearPeriod(period: IncomePeriod): boolean {
  return period === "TAX_YTD" || period === "LAST_TAX_YEAR";
}

/** Periods that cover a year so far rather than a whole earlier year. */
export function isYearToDatePeriod(period: IncomePeriod): boolean {
  return period === "YTD" || period === "TAX_YTD";
}
