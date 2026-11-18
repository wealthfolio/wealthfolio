import type {
  PerformanceResult,
  PerformanceReturnView,
  PerformanceReturnViewKey,
  ReturnData,
  Settings,
} from "@/lib/types";

const numberOrNull = (value: number | null | undefined): number | null =>
  value == null || !Number.isFinite(Number(value)) ? null : Number(value);

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ANNUALIZED_DISPLAY_MIN_DAYS = 365;

function dateKeyToUtcMs(value: string | null | undefined): number | null {
  if (!value) return null;

  const [dateKey] = value.split("T");
  const [year, month, day] = dateKey.split("-").map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;

  const timestamp = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(timestamp)) return null;

  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return timestamp;
}

export function performancePeriodPnl(result: PerformanceResult | null | undefined): number | null {
  if (!result || result.summary?.amountStatus !== "complete") return null;
  return numberOrNull(result.summary.amount);
}

/** The two methods a person can choose between. */
export type ChosenReturnView = Extract<PerformanceReturnViewKey, "twr" | "moneyWeighted">;

/** The method the `defaultReturnMetric` setting chooses; legacy "valueReturn" reads as money-weighted. */
export function chosenReturnView(
  metric: Settings["defaultReturnMetric"] | null | undefined,
): ChosenReturnView {
  return metric === "irr" || metric === "valueReturn" ? "moneyWeighted" : "twr";
}

export function returnMetricForView(view: ChosenReturnView): Settings["defaultReturnMetric"] {
  return view === "moneyWeighted" ? "irr" : "twr";
}

export interface PresentedReturn {
  /** The view the value comes from; differs from the chosen one on a fallback. */
  view: PerformanceReturnViewKey;
  value: number;
  annualized: number | null;
  /** True when the chosen method is unavailable and another view stands in. */
  isFallback: boolean;
  /** Why the chosen method is unavailable, when it is. */
  chosenUnavailableReason: string | null;
}

function viewOf(
  result: PerformanceResult | null | undefined,
  key: PerformanceReturnViewKey,
): PerformanceReturnView | undefined {
  return result?.returns?.[key];
}

export function performanceViewReturn(
  result: PerformanceResult | null | undefined,
  key: PerformanceReturnViewKey,
): number | null {
  return numberOrNull(viewOf(result, key)?.period);
}

export function performanceViewAnnualized(
  result: PerformanceResult | null | undefined,
  key: PerformanceReturnViewKey,
): number | null {
  return numberOrNull(viewOf(result, key)?.annualized);
}

export function performanceViewSeries(
  result: PerformanceResult | null | undefined,
  key: PerformanceReturnViewKey,
): ReturnData[] {
  return viewOf(result, key)?.series ?? [];
}

export function performanceViewReason(
  result: PerformanceResult | null | undefined,
  key: PerformanceReturnViewKey,
): string | null {
  return viewOf(result, key)?.unavailableReason ?? null;
}

/**
 * The return to show for the chosen method. When the scope cannot support it
 * (a holdings account over its full history, a mixed portfolio under TWR), the
 * next available view stands in, labelled by `view`: return on cost first,
 * then the other method.
 */
export function presentedReturn(
  result: PerformanceResult | null | undefined,
  chosen: ChosenReturnView,
): PresentedReturn | null {
  if (!result) return null;
  return presentReturnViews(
    {
      value: (view) => performanceViewReturn(result, view),
      annualized: (view) => performanceViewAnnualized(result, view),
      reason: (view) => performanceViewReason(result, view),
    },
    chosen,
  );
}

/** Reads one return view's figures; lets other shapes (assistant tool output) share the rule. */
export interface ReturnViewReader {
  value: (view: PerformanceReturnViewKey) => number | null;
  annualized: (view: PerformanceReturnViewKey) => number | null;
  reason: (view: PerformanceReturnViewKey) => string | null;
}

export function presentReturnViews(
  reader: ReturnViewReader,
  chosen: ChosenReturnView,
): PresentedReturn | null {
  const other: ChosenReturnView = chosen === "twr" ? "moneyWeighted" : "twr";
  const chosenUnavailableReason = reader.value(chosen) == null ? reader.reason(chosen) : null;
  for (const view of [chosen, "returnOnCost", other] as const) {
    const value = reader.value(view);
    if (value == null) continue;
    return {
      view,
      value,
      annualized: reader.annualized(view),
      isFallback: view !== chosen,
      chosenUnavailableReason,
    };
  }
  return null;
}

export function shouldDisplayAnnualizedPerformanceReturn(
  result: PerformanceResult | null | undefined,
): boolean {
  const start = dateKeyToUtcMs(result?.period.startDate);
  const end = dateKeyToUtcMs(result?.period.endDate);
  if (start == null || end == null || end < start) return false;

  return (end - start) / MS_PER_DAY >= ANNUALIZED_DISPLAY_MIN_DAYS;
}
