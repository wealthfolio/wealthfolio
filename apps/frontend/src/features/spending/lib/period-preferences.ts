import { REPORTS_PERIODS, type ReportsPeriod } from "./reports-period";

export const INSIGHTS_PERIOD_STORAGE_KEY = "spending-insights-period";
/** The Spending tab's preset; the insights page writes it too so both fall back alike. */
export const SPENDING_INTERVAL_STORAGE_KEY = "spending-interval";

export function normalizeReportsPeriod(value: string | null | undefined): ReportsPeriod | null {
  if (!value) return null;
  if (REPORTS_PERIODS.includes(value as ReportsPeriod)) return value as ReportsPeriod;
  return null;
}
