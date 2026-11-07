/**
 * Keeps the dashboard's Investments, Net Worth and Spending tabs on the same
 * period. The last explicit pick on any tab is stored once, in the vocabulary
 * of the tab it was made on, and each tab maps it to the nearest period it can
 * show.
 */
import { getInitialIntervalData, type TimePeriod } from "@wealthfolio/ui";

import { isAllTimeDateRange } from "@/lib/performance-date-range";
import type { DateRange } from "@/lib/types";
import { formatDateISO, parseLocalDate } from "@/lib/utils";

import { parseSpendingDate, type SpendingDateRange } from "./date-range-params";
import { addMonthsToMonthKey, monthRange, parseMonthKey } from "./month-period";
import { REPORTS_PERIODS, type ReportsPeriod } from "./reports-period";
import { MIN_CALENDAR_YEAR, parseCalendarYear, yearRange } from "./year-period";

export const DASHBOARD_PERIOD_STORAGE_KEY = "dashboard-period";
/** Last preset shown on Investments and Net Worth; restored when a custom period is cleared. */
export const DASHBOARD_INTERVAL_STORAGE_KEY = "dashboard-interval";

/** Dates are `YYYY-MM-DD` strings so the persisted-state date reviver leaves them as calendar days. */
export type DashboardPeriodPick =
  | { kind: "portfolio"; code: TimePeriod }
  | { kind: "spending"; code: ReportsPeriod }
  | { kind: "month"; monthKey: string }
  | { kind: "year"; year: number }
  | { kind: "range"; from: string; to: string };

export interface PortfolioPeriodView {
  /** Null when the pick is a month or range that matches no preset. */
  code: TimePeriod | null;
  range: DateRange | undefined;
}

export type SpendingPeriodView =
  | { kind: "period"; code: ReportsPeriod }
  | { kind: "month"; monthKey: string }
  | { kind: "year"; year: number }
  | { kind: "range"; range: SpendingDateRange };

// Presets both selectors offer with the same rolling range.
const SHARED_PRESETS: ReadonlySet<string> = new Set(["3M", "6M", "YTD", "1Y"]);
// Presets a picked range can match; ALL has no fixed start a user would pick.
const RANGE_PRESETS: TimePeriod[] = ["1D", "1W", "1M", "3M", "6M", "YTD", "1Y", "5Y"];

export function portfolioPeriodRange(code: TimePeriod, todayISO: string): DateRange | undefined {
  return getInitialIntervalData(code, parseLocalDate(todayISO)).range;
}

/** The Investments/Net Worth preset a Spending preset moves them to. */
export function portfolioPresetForSpendingPeriod(code: ReportsPeriod): TimePeriod {
  return code === "MTD" || code === "LAST_MONTH" ? "1M" : code;
}

/** What Investments and Net Worth show for a pick, or null when the pick is unreadable. */
export function portfolioViewForPick(
  pick: DashboardPeriodPick,
  todayISO: string,
): PortfolioPeriodView | null {
  if (!pick || typeof pick !== "object") return null;
  if (pick.kind === "portfolio" || pick.kind === "spending") {
    if (pick.kind === "portfolio" && pick.code !== "ALL" && !RANGE_PRESETS.includes(pick.code)) {
      return null;
    }
    if (pick.kind === "spending" && !REPORTS_PERIODS.includes(pick.code)) return null;
    const code =
      pick.kind === "portfolio" ? pick.code : portfolioPresetForSpendingPeriod(pick.code);
    return { code, range: portfolioPeriodRange(code, todayISO) };
  }
  if (pick.kind === "year") {
    const year = parseCalendarYear(pick.year, todayISO);
    return year === null ? null : { code: null, range: yearRange(year) };
  }
  if (pick.kind !== "month" && pick.kind !== "range") return null;
  const range = pickedRange(pick);
  if (!range) return null;
  return { code: matchingPreset(range, todayISO), range };
}

/** What Spending shows for a pick, or null to keep its own selection. */
export function spendingViewForPick(
  pick: DashboardPeriodPick,
  todayISO: string,
): SpendingPeriodView | null {
  if (!pick || typeof pick !== "object") return null;
  switch (pick.kind) {
    case "spending":
      return REPORTS_PERIODS.includes(pick.code) ? { kind: "period", code: pick.code } : null;
    case "portfolio": {
      if (pick.code === "ALL") return null;
      if (!RANGE_PRESETS.includes(pick.code)) return null;
      if (SHARED_PRESETS.has(pick.code)) {
        return { kind: "period", code: pick.code as ReportsPeriod };
      }
      const range = portfolioPeriodRange(pick.code, todayISO);
      return range?.from && range.to
        ? { kind: "range", range: { from: range.from, to: range.to } }
        : null;
    }
    case "month":
      return typeof pick.monthKey === "string" && parseMonthKey(pick.monthKey)
        ? { kind: "month", monthKey: pick.monthKey }
        : null;
    case "year": {
      const year = parseCalendarYear(pick.year, todayISO);
      return year === null ? null : { kind: "year", year };
    }
    case "range": {
      const range = pickedRange(pick);
      return range ? { kind: "range", range } : null;
    }
    default:
      return null;
  }
}

/** Step explicit calendar picks only; relative presets and custom ranges keep their semantics. */
export function stepCalendarPick(
  pick: DashboardPeriodPick | null,
  direction: -1 | 1,
  todayISO: string,
): DashboardPeriodPick | null {
  if (pick?.kind === "year") {
    if (parseCalendarYear(pick.year, todayISO) === null) return null;
    const year = parseCalendarYear(pick.year + direction, todayISO);
    return year === null ? null : { kind: "year", year };
  }
  if (pick?.kind === "month" && typeof pick.monthKey === "string" && parseMonthKey(pick.monthKey)) {
    const monthKey = addMonthsToMonthKey(pick.monthKey, direction);
    const maxMonth = addMonthsToMonthKey(todayISO.slice(0, 7), -1);
    return monthKey >= `${MIN_CALENDAR_YEAR}-01` && monthKey <= maxMonth
      ? { kind: "month", monthKey }
      : null;
  }
  return null;
}

export function rangePick(range: SpendingDateRange): DashboardPeriodPick {
  return { kind: "range", from: formatDateISO(range.from), to: formatDateISO(range.to) };
}

/**
 * The pick for a range chosen on a selector without period codes (Performance):
 * a portfolio preset when the dates match one, otherwise the dates themselves.
 */
export function pickForPortfolioRange(
  range: DateRange | undefined,
  todayISO: string,
): DashboardPeriodPick | null {
  if (!range?.from || isAllTimeDateRange(range)) return { kind: "portfolio", code: "ALL" };
  if (!range.to) return null;
  const dates = { from: range.from, to: range.to };
  const code = matchingPreset(dates, todayISO);
  return code ? { kind: "portfolio", code } : rangePick(dates);
}

function pickedRange(
  pick: Extract<DashboardPeriodPick, { kind: "month" | "range" }>,
): SpendingDateRange | null {
  if (pick.kind === "month") {
    if (typeof pick.monthKey !== "string" || !parseMonthKey(pick.monthKey)) return null;
    const { from, to } = monthRange(pick.monthKey);
    return from && to ? { from, to } : null;
  }
  if (typeof pick.from !== "string" || typeof pick.to !== "string") return null;
  const from = parseSpendingDate(pick.from);
  const to = parseSpendingDate(pick.to);
  return from && to && from <= to ? { from, to } : null;
}

function matchingPreset(range: SpendingDateRange, todayISO: string): TimePeriod | null {
  const from = formatDateISO(range.from);
  const to = formatDateISO(range.to);
  return (
    RANGE_PRESETS.find((code) => {
      const preset = portfolioPeriodRange(code, todayISO);
      return (
        !!preset?.from &&
        !!preset.to &&
        formatDateISO(preset.from) === from &&
        formatDateISO(preset.to) === to
      );
    }) ?? null
  );
}
