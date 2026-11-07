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
import { monthRange, parseMonthKey } from "./month-period";
import type { ReportsPeriod } from "./reports-period";

export const DASHBOARD_PERIOD_STORAGE_KEY = "dashboard-period";
/** Last preset shown on Investments and Net Worth; restored when a custom period is cleared. */
export const DASHBOARD_INTERVAL_STORAGE_KEY = "dashboard-interval";

/** Dates are `YYYY-MM-DD` strings so the persisted-state date reviver leaves them as calendar days. */
export type DashboardPeriodPick =
  | { kind: "portfolio"; code: TimePeriod }
  | { kind: "spending"; code: ReportsPeriod }
  | { kind: "month"; monthKey: string }
  | { kind: "range"; from: string; to: string };

export interface PortfolioPeriodView {
  /** Null when the pick is a month or range that matches no preset. */
  code: TimePeriod | null;
  range: DateRange | undefined;
}

export type SpendingPeriodView =
  | { kind: "period"; code: ReportsPeriod }
  | { kind: "month"; monthKey: string }
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
  return code === "MTD" || code === "LAST_MONTH" ? "1M" : code === "LAST_YEAR" ? "1Y" : code;
}

/** What Investments and Net Worth show for a pick, or null when the pick is unreadable. */
export function portfolioViewForPick(
  pick: DashboardPeriodPick,
  todayISO: string,
): PortfolioPeriodView | null {
  if (pick.kind === "portfolio" || pick.kind === "spending") {
    const code =
      pick.kind === "portfolio" ? pick.code : portfolioPresetForSpendingPeriod(pick.code);
    return { code, range: portfolioPeriodRange(code, todayISO) };
  }
  const range = pickedRange(pick);
  if (!range) return null;
  return { code: matchingPreset(range, todayISO), range };
}

/** What Spending shows for a pick, or null to keep its own selection. */
export function spendingViewForPick(
  pick: DashboardPeriodPick,
  todayISO: string,
): SpendingPeriodView | null {
  switch (pick.kind) {
    case "spending":
      return { kind: "period", code: pick.code };
    case "portfolio": {
      if (pick.code === "ALL") return null;
      if (SHARED_PRESETS.has(pick.code)) {
        return { kind: "period", code: pick.code as ReportsPeriod };
      }
      const range = portfolioPeriodRange(pick.code, todayISO);
      return range?.from && range.to
        ? { kind: "range", range: { from: range.from, to: range.to } }
        : null;
    }
    case "month":
      return parseMonthKey(pick.monthKey) ? { kind: "month", monthKey: pick.monthKey } : null;
    case "range": {
      const range = pickedRange(pick);
      return range ? { kind: "range", range } : null;
    }
  }
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
    if (!parseMonthKey(pick.monthKey)) return null;
    const { from, to } = monthRange(pick.monthKey);
    return from && to ? { from, to } : null;
  }
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
