import { REPORTS_PERIODS, type ReportsPeriod } from "./reports-period";

export const INSIGHTS_PERIOD_STORAGE_KEY = "spending-insights-period";

export function normalizeReportsPeriod(value: string | null | undefined): ReportsPeriod | null {
  if (!value) return null;
  if (REPORTS_PERIODS.includes(value as ReportsPeriod)) return value as ReportsPeriod;
  return null;
}
