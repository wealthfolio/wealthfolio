import type { PerformanceResult, ReturnData } from "@/lib/types";

export type PerformanceMetric = "twr" | "irr" | "valueReturn" | "volatility" | "drawdown";

export interface ComparablePerformanceSeries extends PerformanceResult {
  id: string;
  name: string;
}

export interface ComparableChartDataItem {
  id: string;
  name: string;
  returns: ReturnData[];
  isReference?: boolean;
}

type ChartSeriesGroup = "marketComparison" | "valueReturn";

const ONE = 1;

function chartSeriesGroupForMetric(
  result: PerformanceResult,
  metric: PerformanceMetric,
): ChartSeriesGroup | null {
  if (!result.series.length) return null;

  if (metric === "twr") {
    if (result.mode === "timeWeighted" && result.returns.twr != null) {
      return "marketComparison";
    }
    if (result.mode === "symbolPriceBased" && result.returns.valueReturn != null) {
      return "marketComparison";
    }
    return null;
  }

  if (metric === "valueReturn") {
    if (result.mode === "valueReturn" && result.returns.valueReturn != null) {
      return "valueReturn";
    }
    if (result.mode === "symbolPriceBased" && result.returns.valueReturn != null) {
      return "valueReturn";
    }
  }

  return null;
}

function comparableDateIntersection(series: ComparablePerformanceSeries[]): string[] {
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

function comparableDateIntersectionLength(series: ComparablePerformanceSeries[]): number {
  return comparableDateIntersection(series).length;
}

function selectComparableSeries(
  series: ComparablePerformanceSeries[],
  selectedItemId: string | null,
): ComparablePerformanceSeries[] {
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

export function comparablePerformanceChartData(
  performanceData: (ComparablePerformanceSeries | null)[] | undefined,
  metric: PerformanceMetric,
  selectedItemId: string | null,
): ComparableChartDataItem[] {
  if (metric !== "twr" && metric !== "valueReturn") return [];
  if (!performanceData) return [];

  const candidates = performanceData
    .filter(
      (item): item is ComparablePerformanceSeries =>
        item !== null && typeof item.id === "string" && Array.isArray(item.series),
    )
    .map((item) => ({
      item,
      group: chartSeriesGroupForMetric(item, metric),
    }))
    .filter(
      (entry): entry is { item: ComparablePerformanceSeries; group: ChartSeriesGroup } =>
        entry.group !== null,
    );

  const selectedGroup = selectedItemId
    ? candidates.find((entry) => entry.item.id === selectedItemId)?.group
    : candidates[0]?.group;
  if (!selectedGroup) return [];

  const comparableSeries = candidates
    .filter((entry) => entry.group === selectedGroup)
    .map(({ item }) => item);
  const selectedComparableSeries = selectComparableSeries(comparableSeries, selectedItemId);
  const commonDates = comparableDateIntersection(selectedComparableSeries);
  if (commonDates.length < 2) return [];

  return selectedComparableSeries.flatMap((item) => {
    const returns = rebaseSeriesToDates(item.series, commonDates);
    if (!returns) return [];
    return {
      id: item.id,
      name: item.name,
      returns,
      isReference: item.mode === "symbolPriceBased",
    };
  });
}

/**
 * Earliest data date across the given results. For all-time queries the
 * backend returns series starting at each item's inception, so this resolves
 * the selected items' earliest start (e.g. an account's first data point).
 * Used to anchor the custom-range calendar when the ALL preset is active,
 * instead of the 1970-01-01 sentinel kept in state.
 */
export function earliestPerformanceStartDate(
  results: (PerformanceResult | null | undefined)[] | null | undefined,
): Date | undefined {
  let earliestMs: number | undefined;
  for (const result of results ?? []) {
    const iso = result?.period?.startDate ?? result?.series?.[0]?.date;
    if (!iso) continue;
    const ms = new Date(`${iso.slice(0, 10)}T00:00:00`).getTime();
    if (Number.isNaN(ms)) continue;
    if (earliestMs === undefined || ms < earliestMs) {
      earliestMs = ms;
    }
  }
  return earliestMs === undefined ? undefined : new Date(earliestMs);
}
