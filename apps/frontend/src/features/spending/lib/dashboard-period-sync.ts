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
import { addMonthsToMonthKey, localDateFromParts, monthRange, parseMonthKey } from "./month-period";
import { REPORTS_PERIODS, type ReportsPeriod } from "./reports-period";
import { addCalendarDays, addCalendarMonths, localDateParts } from "./timezone";
import { MIN_CALENDAR_YEAR, parseCalendarYear, yearRange } from "./year-period";

export const DASHBOARD_PERIOD_STORAGE_KEY = "dashboard-period";
/** Last preset shown on Investments and Net Worth; restored when a custom period is cleared. */
export const DASHBOARD_INTERVAL_STORAGE_KEY = "dashboard-interval";

/** Dates are `YYYY-MM-DD` strings so the persisted-state date reviver leaves them as calendar days. */
export type DashboardPresetPick =
  | { kind: "portfolio"; code: TimePeriod }
  | { kind: "spending"; code: ReportsPeriod };

/** Preserve the interval and original as-of date while its window is in the past. */
export interface PresetWindow {
  preset: DashboardPresetPick;
  anchor: string;
  offset: number;
  /** Insights starts multi-month presets at month boundaries. */
  alignment?: "calendar";
}

export type DashboardPeriodPick =
  | DashboardPresetPick
  | { kind: "month"; monthKey: string }
  | { kind: "year"; year: number }
  | { kind: "range"; from: string; to: string; presetWindow?: PresetWindow };

export interface PortfolioPeriodView {
  /** Null when the pick is a month or range that matches no preset. */
  code: TimePeriod | null;
  range: DateRange | undefined;
}

export type SpendingPeriodView =
  | { kind: "period"; code: ReportsPeriod }
  | { kind: "month"; monthKey: string }
  | { kind: "year"; year: number }
  | {
      kind: "range";
      range: SpendingDateRange;
      preset?: DashboardPresetPick;
      presetWindow?: PresetWindow;
    };

// Presets both selectors offer.
const SHARED_PRESETS: ReadonlySet<string> = new Set(["1W", "3M", "6M", "YTD", "1Y"]);
// Presets a picked range can match; ALL has no fixed start a user would pick.
const RANGE_PRESETS: TimePeriod[] = ["1D", "1W", "1M", "3M", "6M", "YTD", "1Y", "5Y"];

export function portfolioPeriodRange(code: TimePeriod, todayISO: string): DateRange | undefined {
  return getInitialIntervalData(code, parseLocalDate(todayISO)).range;
}

export function spendingPeriodRange(code: ReportsPeriod, todayISO: string): SpendingDateRange {
  const today = localDateParts(parseLocalDate(todayISO));
  if (code === "1W") {
    return { from: localDateFromParts(addCalendarDays(today, -6)), to: localDateFromParts(today) };
  }
  if (code === "LAST_MONTH") {
    const month = addMonthsToMonthKey(todayISO.slice(0, 7), -1);
    const range = monthRange(month);
    return { from: range.from!, to: range.to! };
  }
  const start =
    code === "MTD"
      ? { ...today, day: 1 }
      : code === "YTD"
        ? { year: today.year, month: 1, day: 1 }
        : code === "1Y"
          ? { ...today, year: today.year - 1 }
          : addCalendarMonths(today, code === "3M" ? -3 : -6);
  return { from: localDateFromParts(start), to: localDateFromParts(today) };
}

function isPreset(value: unknown): value is DashboardPresetPick {
  if (!value || typeof value !== "object") return false;
  const preset = value as DashboardPresetPick;
  return preset.kind === "portfolio"
    ? preset.code !== "ALL" && RANGE_PRESETS.includes(preset.code)
    : preset.kind === "spending" && REPORTS_PERIODS.includes(preset.code);
}

function presetWindowRange(window: PresetWindow): SpendingDateRange | null {
  const anchor = parseSpendingDate(window.anchor);
  if (!anchor) return null;
  const date = localDateParts(anchor);
  const { code } = window.preset;
  const months =
    code === "1Y" || code === "YTD"
      ? 12
      : code === "5Y"
        ? 60
        : code === "3M"
          ? 3
          : code === "6M"
            ? 6
            : 1;
  if (window.alignment === "calendar") {
    if (window.preset.kind !== "spending" || !["3M", "6M", "1Y"].includes(code)) return null;
    const currentStart = addCalendarMonths({ ...date, day: 1 }, 1 - months);
    const start = addCalendarMonths(currentStart, window.offset * months);
    const end = addCalendarDays(addCalendarMonths(currentStart, (window.offset + 1) * months), -1);
    if (!Number.isFinite(start.year) || start.year < MIN_CALENDAR_YEAR) return null;
    return { from: localDateFromParts(start), to: localDateFromParts(end) };
  }
  if (window.alignment !== undefined) return null;
  if (window.preset.kind === "spending" && code === "1W") {
    const end = addCalendarDays(date, window.offset * 7);
    const start = addCalendarDays(end, -6);
    if (!Number.isFinite(start.year) || start.year < MIN_CALENDAR_YEAR) return null;
    return { from: localDateFromParts(start), to: localDateFromParts(end) };
  }
  const asOf =
    code === "1D" || code === "1W"
      ? addCalendarDays(date, window.offset * (code === "1W" ? 7 : 1))
      : addCalendarMonths(date, window.offset * months);
  if (!Number.isFinite(asOf.year) || asOf.year < MIN_CALENDAR_YEAR) return null;
  const asOfISO = formatDateISO(localDateFromParts(asOf));
  // Derive both rolling boundaries from the same anchor: March 31 → February
  // 28 must not move the next historical boundary from January 31 to January 28.
  if (code !== "YTD" && code !== "MTD" && code !== "LAST_MONTH") {
    const start =
      code === "1D" || code === "1W"
        ? addCalendarDays(date, (window.offset - 1) * (code === "1W" ? 7 : 1))
        : addCalendarMonths(date, (window.offset - 1) * months);
    if (!Number.isFinite(start.year) || start.year < MIN_CALENDAR_YEAR) return null;
    return { from: localDateFromParts(start), to: localDateFromParts(asOf) };
  }
  const range =
    window.preset.kind === "portfolio"
      ? portfolioPeriodRange(window.preset.code, asOfISO)
      : spendingPeriodRange(window.preset.code, asOfISO);
  return range?.from && range.to ? { from: range.from, to: range.to } : null;
}

/** Treat malformed optional metadata as an ordinary custom date range. */
export function getPresetWindow(pick: DashboardPeriodPick | null): PresetWindow | undefined {
  const window = pick?.kind === "range" ? pick.presetWindow : undefined;
  if (
    !window ||
    typeof window !== "object" ||
    !isPreset(window.preset) ||
    typeof window.anchor !== "string" ||
    !Number.isSafeInteger(window.offset) ||
    window.offset >= 0
  )
    return undefined;
  const range = presetWindowRange(window);
  return pick?.kind === "range" &&
    range &&
    formatDateISO(range.from) === pick.from &&
    formatDateISO(range.to) === pick.to
    ? window
    : undefined;
}

/** Calendar picks keep calendar units; presets use their existing range at an earlier as-of date. */
export function stepDashboardPeriod(
  pick: DashboardPeriodPick,
  direction: -1 | 1,
  todayISO: string,
  alignment?: PresetWindow["alignment"],
): DashboardPeriodPick | null {
  if (pick.kind === "spending" && (pick.code === "MTD" || pick.code === "LAST_MONTH")) {
    if (pick.code === "MTD" && direction === 1) return null;
    const monthKey =
      pick.code === "MTD" ? todayISO.slice(0, 7) : addMonthsToMonthKey(todayISO.slice(0, 7), -1);
    return stepDashboardPeriod({ kind: "month", monthKey }, direction, todayISO);
  }
  if (
    pick.kind === "month" &&
    direction === 1 &&
    addMonthsToMonthKey(pick.monthKey, 1) === todayISO.slice(0, 7)
  ) {
    return { kind: "spending", code: "MTD" };
  }
  if (pick.kind === "month" || pick.kind === "year")
    return stepCalendarPick(pick, direction, todayISO);
  const previous = getPresetWindow(pick);
  const preset = previous?.preset ?? (isPreset(pick) ? pick : null);
  if (!preset) return null;
  const offset = (previous?.offset ?? 0) + direction;
  if (offset > 0) return null;
  if (offset === 0) return preset;
  const windowAlignment = previous ? previous.alignment : alignment;
  const window: PresetWindow = {
    preset,
    anchor: previous?.anchor ?? todayISO,
    offset,
    ...(windowAlignment === "calendar" &&
    preset.kind === "spending" &&
    ["3M", "6M", "1Y"].includes(preset.code)
      ? { alignment: "calendar" as const }
      : {}),
  };
  if (window.anchor > todayISO) return null;
  const range = presetWindowRange(window);
  if (
    !range ||
    formatDateISO(range.from) < `${MIN_CALENDAR_YEAR}-01-01` ||
    formatDateISO(range.to) > todayISO
  )
    return null;
  return { ...rangePick(range), presetWindow: window };
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
        ? { kind: "range", range: { from: range.from, to: range.to }, preset: pick }
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
      const presetWindow = getPresetWindow(pick);
      return range
        ? {
            kind: "range",
            range,
            ...(presetWindow ? { presetWindow, preset: presetWindow.preset } : {}),
          }
        : null;
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

export function rangePick(
  range: SpendingDateRange,
): Extract<DashboardPeriodPick, { kind: "range" }> {
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
