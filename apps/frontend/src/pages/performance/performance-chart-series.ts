import { performanceViewSeries, type ChosenReturnView } from "@/lib/performance";
import type { PerformanceResult, PerformanceReturnViewKey, ReturnData } from "@/lib/types";

export type PerformanceMetric = ChosenReturnView | "volatility" | "drawdown";

export interface ComparablePerformanceSeries extends PerformanceResult {
  id: string;
  name: string;
  type?: "account" | "symbol";
}

export interface ComparableChartDataItem {
  id: string;
  name: string;
  returns: ReturnData[];
}

interface CurveSeries {
  id: string;
  name: string;
  series: ReturnData[];
}

const ONE = 1;

function comparableDateIntersection(series: CurveSeries[]): string[] {
  if (!series.length) return [];

  const [firstSeries, ...rest] = series.map((item) =>
    [...item.series].sort((a, b) => a.date.localeCompare(b.date)),
  );
  if (!firstSeries.length) return [];

  const commonDates = new Set(firstSeries.map((point) => point.date));
  for (const returnSeries of rest) {
    const dates = new Set(returnSeries.map((point) => point.date));
    for (const date of commonDates) {
      if (!dates.has(date)) commonDates.delete(date);
    }
  }

  return [...commonDates].sort((a, b) => a.localeCompare(b));
}

function comparableDateIntersectionLength(series: CurveSeries[]): number {
  return comparableDateIntersection(series).length;
}

function selectComparableSeries(
  series: CurveSeries[],
  selectedItemId: string | null,
): CurveSeries[] {
  if (!series.length) return [];

  const anchor = selectedItemId
    ? (series.find((item) => item.id === selectedItemId) ?? series[0])
    : series[0];
  if (!anchor || anchor.series.length < 2) return [];

  const candidates = series
    .filter((item) => item.id !== anchor.id)
    .sort(
      (a, b) =>
        comparableDateIntersectionLength([anchor, b]) -
        comparableDateIntersectionLength([anchor, a]),
    );

  const selected = [anchor];
  let commonDates = comparableDateIntersection(selected);

  for (const candidate of candidates) {
    const next = [...selected, candidate];
    const nextCommonDates = comparableDateIntersection(next);
    if (nextCommonDates.length >= 2) {
      selected.push(candidate);
      commonDates = nextCommonDates;
    }
  }

  return commonDates.length >= 2 ? selected : [];
}

function rebaseSeriesToDates(series: ReturnData[], dates: string[]): ReturnData[] | null {
  const valuesByDate = new Map(series.map((point) => [point.date, Number(point.value)]));
  const baseValue = valuesByDate.get(dates[0]);
  const base = baseValue == null ? null : ONE + baseValue;
  if (base == null || !Number.isFinite(base) || base === 0) return null;

  const rebased = dates.map((date) => {
    const value = valuesByDate.get(date);
    if (value == null || !Number.isFinite(value)) return null;
    return {
      date,
      value: (ONE + value) / base - ONE,
    };
  });

  return rebased.every((point): point is ReturnData => point !== null) ? rebased : null;
}

/**
 * The view the chart draws: the chosen method when the selected item has its
 * curve, else the item's labelled stand-in (return on investment, then the
 * other method), as its figure shows. Only lines of that view join it.
 */
export function chartViewFor(
  performanceData: (ComparablePerformanceSeries | null)[] | undefined,
  view: ChosenReturnView,
  selectedItemId: string | null,
): PerformanceReturnViewKey {
  const items = (performanceData ?? []).filter(
    (item): item is ComparablePerformanceSeries => item !== null,
  );
  const anchor = items.find((item) => item.id === selectedItemId) ?? items[0];
  if (!anchor) return view;
  const other: ChosenReturnView = view === "twr" ? "moneyWeighted" : "twr";
  const candidates: PerformanceReturnViewKey[] = [view, "returnOnCost", other];
  return (
    candidates.find((candidate) => performanceViewSeries(anchor, candidate).length >= 2) ?? view
  );
}

/**
 * Lines for the chart in the chosen return method, the selected item first.
 * Time-weighted curves compound, so they are rebased to the dates every line
 * shares and start together at 0%. Money-weighted curves cannot be rebased:
 * each keeps its own start, where its money was first invested.
 */
export function comparablePerformanceChartData(
  performanceData: (ComparablePerformanceSeries | null)[] | undefined,
  view: PerformanceReturnViewKey,
  selectedItemId: string | null,
): ComparableChartDataItem[] {
  if (!performanceData) return [];

  const curves: CurveSeries[] = performanceData
    .filter(
      (item): item is ComparablePerformanceSeries => item !== null && typeof item.id === "string",
    )
    .map((item) => ({
      id: item.id,
      name: item.name,
      // A benchmark has no ROI: beside a holdings account's ROI line it draws
      // its price return, as a reference.
      series: [
        ...performanceViewSeries(
          item,
          view === "returnOnCost" && item.type === "symbol" ? "twr" : view,
        ),
      ].sort((a, b) => a.date.localeCompare(b.date)),
    }))
    .filter((item) => item.series.length >= 2);
  if (!curves.length) return [];

  // Only compounding curves rebase; a money-weighted or return-on-investment
  // curve keeps its own start.
  if (view !== "twr") {
    const anchor = curves.find((item) => item.id === selectedItemId) ?? curves[0];
    return [anchor, ...curves.filter((item) => item.id !== anchor.id)].map((item) => ({
      id: item.id,
      name: item.name,
      returns: item.series,
    }));
  }

  const selectedComparableSeries = selectComparableSeries(curves, selectedItemId);
  const commonDates = comparableDateIntersection(selectedComparableSeries);
  if (commonDates.length < 2) return [];

  return selectedComparableSeries.flatMap((item) => {
    const returns = rebaseSeriesToDates(item.series, commonDates);
    if (!returns) return [];
    return {
      id: item.id,
      name: item.name,
      returns,
    };
  });
}

/**
 * Earliest start represented by the given results. Call with loaded all-time
 * results to anchor the custom-range calendar without changing the ALL sentinel
 * kept in selection state.
 */
export function earliestPerformanceStartDate(
  results: (PerformanceResult | null | undefined)[] | null | undefined,
): Date | undefined {
  let earliestMs: number | undefined;
  for (const result of results ?? []) {
    const iso =
      result?.period?.startDate ??
      performanceViewSeries(result, "twr")[0]?.date ??
      performanceViewSeries(result, "moneyWeighted")[0]?.date;
    if (!iso) continue;
    const ms = new Date(`${iso.slice(0, 10)}T00:00:00`).getTime();
    if (Number.isNaN(ms)) continue;
    if (earliestMs === undefined || ms < earliestMs) {
      earliestMs = ms;
    }
  }
  return earliestMs === undefined ? undefined : new Date(earliestMs);
}
