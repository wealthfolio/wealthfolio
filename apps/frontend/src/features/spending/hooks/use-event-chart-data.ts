import { useMemo } from "react";

import type { Activity, TaxonomyCategory } from "@/lib/types";
import { parseLocalDate } from "@/lib/utils";

import { getVisibleSpendingAmount } from "../lib/constants";
import { inclusiveDays } from "../lib/date-utils";
import type { EventSpendingSummary } from "../types/event";
import { computeBaselinePace, type BaselinePeriod } from "./use-baseline-pace";

export interface EventCategoryRow {
  id: string;
  name: string;
  color: string;
  amount: number;
}

export interface EventTaggedSeries {
  series: number[];
  inWindow: boolean[];
  /** The day each bar stands for; bars outside the event are not contiguous. */
  dates: Date[];
  chartStartDate: Date;
  chartEndDate: Date;
}

export interface EventChartData {
  startDate: Date;
  endDate: Date;
  days: number;
  dailyDuring: number;
  baseline: number;
  expected: number;
  lift: number;
  dailyDeltaPct: number;
  categories: EventCategoryRow[];
  categoriesTotal: number;
  dailySeries: number[];
  tagged: EventTaggedSeries;
  peak: { date: Date; amount: number } | null;
  beforeSeries: number[];
  afterSeries: number[];
  beforeAvg: number;
  afterAvg: number;
  hangoverPct: number;
  /** ISO date strings of tagged tx that fall outside the event's own window. */
  outOfRange: string[];
  /** Tagged spending on those days. It is part of the event total. */
  outOfRangeTotal: number;
}

function toDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function findPeakDayAt(series: number[], base: Date): { date: Date; amount: number } | null {
  let bestIdx = -1;
  let best = -Infinity;
  series.forEach((v, i) => {
    if (v > best) {
      best = v;
      bestIdx = i;
    }
  });
  if (bestIdx < 0 || best <= 0) return null;
  const d = new Date(base);
  d.setDate(d.getDate() + bestIdx);
  return { date: d, amount: best };
}

/**
 * Build the day-by-day bars: one for every day of the event's own
 * [startDate, endDate], plus one for each day outside it that has tagged
 * spending. Empty days outside the event get no bar, so a deposit paid months
 * ahead sits next to the event instead of stretching the chart across the gap.
 * The `inWindow` mask flags the bars within the event's own dates.
 */
function buildEventTaggedSeries(event: EventSpendingSummary): EventTaggedSeries {
  const evStartKey = event.startDate.slice(0, 10);
  const evEndKey = event.endDate.slice(0, 10);
  const spendByDay = new Map<string, number>();
  for (const [dateKey, amount] of Object.entries(event.dailySpending ?? {})) {
    spendByDay.set(dateKey.slice(0, 10), amount);
  }

  const dayKeys = new Set<string>([evStartKey, evEndKey, ...spendByDay.keys()]);
  // Walk the event's days with setDate and compare ISO date keys, rather than
  // stepping a fixed 86_400_000 ms: that drifts by an hour across DST and
  // would drop the day after spring-forward.
  const cursor = new Date(`${evStartKey}T12:00:00`);
  while (toDayKey(cursor) <= evEndKey) {
    dayKeys.add(toDayKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  const keys = Array.from(dayKeys).sort();
  const dates = keys.map((key) => new Date(`${key}T12:00:00`));
  return {
    series: keys.map((key) => spendByDay.get(key) ?? 0),
    inWindow: keys.map((key) => key >= evStartKey && key <= evEndKey),
    dates,
    chartStartDate: dates[0],
    chartEndDate: dates[dates.length - 1],
  };
}

function buildWindowSeries(
  activities: Activity[],
  accountTypeById: Map<string, string> | undefined,
  anchor: Date,
  offsetDays: number,
  windowDays: number,
): number[] {
  const start = new Date(anchor);
  start.setDate(start.getDate() + offsetDays);
  start.setHours(0, 0, 0, 0);
  const series = new Array(windowDays).fill(0);
  for (const a of activities) {
    const amt = getVisibleSpendingAmount(a, accountTypeById?.get(a.accountId));
    if (amt <= 0) continue;
    const idx = Math.floor((new Date(a.activityDate).getTime() - start.getTime()) / 86_400_000);
    if (idx >= 0 && idx < windowDays) series[idx] += amt;
  }
  return series.some((v) => v > 0) ? series : [];
}

function avgSeries(series: number[]): number {
  if (series.length === 0) return 0;
  return series.reduce((a, b) => a + b, 0) / series.length;
}

function buildEventCategoryRows(
  event: EventSpendingSummary,
  taxonomyCategories: TaxonomyCategory[],
  uncategorizedLabel: string,
): EventCategoryRow[] {
  const meta = new Map(taxonomyCategories.map((c) => [c.id, c]));
  const byTop = new Map<string, EventCategoryRow>();
  for (const cat of Object.values(event.byCategory)) {
    const m = cat.categoryId ? meta.get(cat.categoryId) : undefined;
    const topId = m?.parentId ?? cat.categoryId ?? cat.categoryName;
    const top = (m?.parentId && meta.get(m.parentId)) || m;
    const name = cat.categoryId ? (top?.name ?? cat.categoryName) : uncategorizedLabel;
    const color = top?.color ?? cat.color ?? "#9CA3AF";
    const e = byTop.get(topId) ?? { id: topId, name, color, amount: 0 };
    e.amount += cat.amount;
    byTop.set(topId, e);
  }
  return Array.from(byTop.values())
    .filter((row) => row.amount > 0)
    .sort((a, b) => b.amount - a.amount);
}

function buildOutOfRange(event: EventSpendingSummary): string[] {
  const s = event.startDate.slice(0, 10);
  const e = event.endDate.slice(0, 10);
  const dates: string[] = [];
  for (const dateKey of Object.keys(event.dailySpending ?? {})) {
    const k = dateKey.slice(0, 10);
    if (k < s || k > e) dates.push(k);
  }
  return dates.sort();
}

/** All derived data for the EventDetailPanel, in one memoized hook. */
export function useEventChartData(
  event: EventSpendingSummary,
  heatmapActivities: Activity[],
  accountTypeById: Map<string, string> | undefined,
  taxonomyCategories: TaxonomyCategory[],
  uncategorizedLabel: string,
  dailySpendByDate?: Map<string, number>,
  baselinePeriod?: BaselinePeriod,
): EventChartData {
  const startDate = useMemo(() => parseLocalDate(event.startDate), [event.startDate]);
  const endDate = useMemo(() => parseLocalDate(event.endDate), [event.endDate]);
  // `inclusiveDays` is ≥ 1, and we floor at 1 anyway, so days > 0 always.
  const days = Math.max(1, inclusiveDays(startDate, endDate));

  const tagged = useMemo(() => buildEventTaggedSeries(event), [event]);
  // Spending on the event's own days. Tagged spending outside them (a deposit
  // paid months ahead) counts in the event total, but not in what a day of the
  // event cost or which of its days peaked.
  const dailySeries = useMemo(
    () => tagged.series.filter((_, i) => tagged.inWindow[i]),
    [tagged.series, tagged.inWindow],
  );
  const outOfRangeTotal = useMemo(
    () => tagged.series.reduce((sum, v, i) => (tagged.inWindow[i] ? sum : sum + v), 0),
    [tagged.series, tagged.inWindow],
  );
  const dailyDuring = dailySeries.reduce((sum, v) => sum + v, 0) / days;

  const baseline = useMemo(
    () =>
      computeBaselinePace(
        heatmapActivities,
        [event],
        baselinePeriod?.days ?? 12 * 7,
        accountTypeById,
        dailySpendByDate,
        baselinePeriod,
      ),
    [accountTypeById, dailySpendByDate, heatmapActivities, event, baselinePeriod],
  );

  // Floor `expected` at zero before computing lift. `computeBaselinePace`
  // clamps its result ≥ 0 today, but tying the lift formula to that invariant
  // is fragile — a future refund-aware baseline could legitimately go
  // slightly negative from FP. Mirror the display-side `Math.max(0, expected)`
  // at event-detail-panel.tsx:251 so headline and lift stay consistent.
  const expected = Math.max(0, baseline * days);
  const lift = event.totalSpending - expected;
  const dailyDeltaPct = baseline > 0 ? Math.round((dailyDuring / baseline - 1) * 100) : 0;

  const categories = useMemo(
    () => buildEventCategoryRows(event, taxonomyCategories, uncategorizedLabel),
    [event, taxonomyCategories, uncategorizedLabel],
  );
  const categoriesTotal = useMemo(
    () => categories.reduce((sum, c) => sum + c.amount, 0),
    [categories],
  );

  const peak = useMemo(() => findPeakDayAt(dailySeries, startDate), [dailySeries, startDate]);

  const beforeSeries = useMemo(
    () => buildWindowSeries(heatmapActivities, accountTypeById, startDate, -7, 7),
    [heatmapActivities, accountTypeById, startDate],
  );
  const afterSeries = useMemo(
    () => buildWindowSeries(heatmapActivities, accountTypeById, endDate, 1, 3),
    [heatmapActivities, accountTypeById, endDate],
  );
  const beforeAvg = useMemo(() => avgSeries(beforeSeries), [beforeSeries]);
  const afterAvg = useMemo(() => avgSeries(afterSeries), [afterSeries]);
  const hangoverPct = baseline > 0 ? Math.round((afterAvg / baseline - 1) * 100) : 0;

  const outOfRange = useMemo(() => buildOutOfRange(event), [event]);

  return {
    startDate,
    endDate,
    days,
    dailyDuring,
    baseline,
    expected,
    lift,
    dailyDeltaPct,
    categories,
    categoriesTotal,
    dailySeries,
    tagged,
    peak,
    beforeSeries,
    afterSeries,
    beforeAvg,
    afterAvg,
    hangoverPct,
    outOfRange,
    outOfRangeTotal,
  };
}
