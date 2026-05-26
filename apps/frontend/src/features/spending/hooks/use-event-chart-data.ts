import { useMemo } from "react";

import type { Activity, TaxonomyCategory } from "@/lib/types";
import { parseLocalDate } from "@/lib/utils";

import { getActivitySpendingAmount } from "../lib/constants";
import { inclusiveDays } from "../lib/date-utils";
import type { EventSpendingSummary } from "../types/event";
import { computeBaselinePace } from "./use-baseline-pace";

export interface EventCategoryRow {
  id: string;
  name: string;
  color: string;
  amount: number;
}

export interface EventTaggedSeries {
  series: number[];
  inWindow: boolean[];
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
}

function buildEventDailySeries(event: EventSpendingSummary, days: number): number[] {
  const start = parseLocalDate(event.startDate);
  const series = new Array(days).fill(0);
  for (const [dateKey, amount] of Object.entries(event.dailySpending ?? {})) {
    const d = new Date(`${dateKey}T12:00:00`);
    const idx = Math.round((d.getTime() - start.getTime()) / 86_400_000);
    if (idx >= 0 && idx < days) series[idx] = amount;
  }
  return series;
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
 * Build a per-day tagged-spend series covering the union of the event window
 * and any tagged transactions outside it. The `inWindow` mask flags which
 * indices fall within the event's own [startDate, endDate].
 */
function buildEventTaggedSeries(event: EventSpendingSummary): EventTaggedSeries {
  const evStartKey = event.startDate.slice(0, 10);
  const evEndKey = event.endDate.slice(0, 10);
  const allKeys = [
    evStartKey,
    evEndKey,
    ...Object.keys(event.dailySpending ?? {}).map((k) => k.slice(0, 10)),
  ].sort();
  const chartStartDate = new Date(`${allKeys[0]}T12:00:00`);
  const chartEndDate = new Date(`${allKeys[allKeys.length - 1]}T12:00:00`);
  // Day count via Math.round + 1 is DST-safe at the endpoint level: spring
  // forward (23h elapsed) rounds to 1, fall back (25h) also rounds to 1.
  const days = Math.round((chartEndDate.getTime() - chartStartDate.getTime()) / 86_400_000) + 1;

  const series = new Array(days).fill(0);
  const inWindow = new Array(days).fill(false);
  // Use ISO date keys for the in-window membership check rather than
  // ms-arithmetic from chartStartDate. A fixed 86_400_000 step drifts by one
  // hour across DST so the day after spring-forward would otherwise drop
  // out of the window. Walking dates via setDate handles DST correctly.
  const cursor = new Date(chartStartDate);
  for (let i = 0; i < days; i++) {
    const dayKey = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(
      cursor.getDate(),
    ).padStart(2, "0")}`;
    inWindow[i] = dayKey >= evStartKey && dayKey <= evEndKey;
    cursor.setDate(cursor.getDate() + 1);
  }
  for (const [dateKey, amount] of Object.entries(event.dailySpending ?? {})) {
    const d = new Date(`${dateKey.slice(0, 10)}T12:00:00`);
    const idx = Math.round((d.getTime() - chartStartDate.getTime()) / 86_400_000);
    if (idx >= 0 && idx < days) series[idx] = amount;
  }
  return { series, inWindow, chartStartDate, chartEndDate };
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
    const amt = getActivitySpendingAmount(a, accountTypeById?.get(a.accountId));
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
): EventCategoryRow[] {
  const meta = new Map(taxonomyCategories.map((c) => [c.id, c]));
  const byTop = new Map<string, EventCategoryRow>();
  for (const cat of Object.values(event.byCategory)) {
    const m = cat.categoryId ? meta.get(cat.categoryId) : undefined;
    const topId = m?.parentId ?? cat.categoryId ?? cat.categoryName;
    const top = (m?.parentId && meta.get(m.parentId)) || m;
    const name = top?.name ?? cat.categoryName ?? "Uncategorized";
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
  dailySpendByDate?: Map<string, number>,
): EventChartData {
  const startDate = useMemo(() => parseLocalDate(event.startDate), [event.startDate]);
  const endDate = useMemo(() => parseLocalDate(event.endDate), [event.endDate]);
  // `inclusiveDays` is ≥ 1, and we floor at 1 anyway, so days > 0 always.
  const days = Math.max(1, inclusiveDays(startDate, endDate));
  const dailyDuring = event.totalSpending / days;

  const baseline = useMemo(
    () =>
      computeBaselinePace(heatmapActivities, [event], 12 * 7, accountTypeById, dailySpendByDate),
    [accountTypeById, dailySpendByDate, heatmapActivities, event],
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
    () => buildEventCategoryRows(event, taxonomyCategories),
    [event, taxonomyCategories],
  );
  const categoriesTotal = useMemo(
    () => categories.reduce((sum, c) => sum + c.amount, 0),
    [categories],
  );

  const dailySeries = useMemo(() => buildEventDailySeries(event, days), [event, days]);
  const tagged = useMemo(() => buildEventTaggedSeries(event), [event]);
  const peak = useMemo(
    () => findPeakDayAt(tagged.series, tagged.chartStartDate),
    [tagged.series, tagged.chartStartDate],
  );

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
  };
}
