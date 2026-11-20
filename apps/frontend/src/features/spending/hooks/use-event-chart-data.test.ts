import { renderHook } from "@/test/render";
import { expect, it } from "vitest";
import type { EventSpendingSummary } from "../types/event";
import { useEventChartData } from "./use-event-chart-data";

it("localizes only the null-category fallback and preserves event totals and source data", () => {
  const event: EventSpendingSummary = {
    eventId: "event-1",
    eventName: "My trip",
    eventTypeId: "custom",
    eventTypeName: "My type",
    eventTypeColor: null,
    startDate: "2026-10-01",
    endDate: "2026-10-02",
    totalSpending: 150,
    transactionCount: 2,
    currency: "USD",
    byCategory: {
      uncategorized: {
        categoryId: null,
        categoryName: "Uncategorized",
        color: null,
        amount: 100,
        transactionCount: 1,
      },
      custom: {
        categoryId: "custom-category",
        categoryName: "Uncategorized",
        color: "#123456",
        amount: 50,
        transactionCount: 1,
      },
    },
    dailySpending: { "2026-10-01": 100, "2026-10-02": 50 },
  };
  const original = structuredClone(event);
  const { result, rerender } = renderHook(
    ({ label }) => useEventChartData(event, [], undefined, [], label),
    { initialProps: { label: "未分类" } },
  );
  expect(result.current.categories).toEqual([
    { id: "Uncategorized", name: "未分类", color: "#9CA3AF", amount: 100 },
    { id: "custom-category", name: "Uncategorized", color: "#123456", amount: 50 },
  ]);
  expect(result.current.categoriesTotal).toBe(150);
  const metrics = { ...result.current, categories: undefined };
  rerender({ label: "Uncategorized" });
  expect(result.current.categories[0].name).toBe("Uncategorized");
  expect({ ...result.current, categories: undefined }).toEqual(metrics);
  expect(event).toEqual(original);
});

function eventWith(
  startDate: string,
  endDate: string,
  dailySpending: Record<string, number>,
): EventSpendingSummary {
  return {
    eventId: "event-1",
    eventName: "My trip",
    eventTypeId: "custom",
    eventTypeName: "My type",
    eventTypeColor: null,
    startDate,
    endDate,
    totalSpending: Object.values(dailySpending).reduce((sum, v) => sum + v, 0),
    transactionCount: Object.keys(dailySpending).length,
    currency: "USD",
    byCategory: {},
    dailySpending,
  };
}

const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

it("keeps spending tagged outside the event's dates out of the daily figures", () => {
  // A deposit paid 10 months ahead and a late charge, around a 3-day trip.
  const event = eventWith("2026-04-10", "2026-04-12", {
    "2025-06-03": 600,
    "2026-04-10": 30,
    "2026-04-11": 90,
    "2026-04-12": 60,
    "2026-04-20": 20,
  });
  const { result } = renderHook(() => useEventChartData(event, [], undefined, [], "Uncategorized"));
  const data = result.current;

  // One bar per event day plus one per outside day with spending: no bars for
  // the empty months in between.
  expect(data.tagged.dates.map(dayKey)).toEqual([
    "2025-06-03",
    "2026-04-10",
    "2026-04-11",
    "2026-04-12",
    "2026-04-20",
  ]);
  expect(data.tagged.series).toEqual([600, 30, 90, 60, 20]);
  expect(data.tagged.inWindow).toEqual([false, true, true, true, false]);

  expect(data.days).toBe(3);
  expect(data.dailySeries).toEqual([30, 90, 60]);
  expect(data.dailyDuring).toBe(60);
  expect(data.peak?.amount).toBe(90);
  expect(data.peak && dayKey(data.peak.date)).toBe("2026-04-11");

  expect(data.outOfRange).toEqual(["2025-06-03", "2026-04-20"]);
  expect(data.outOfRangeTotal).toBe(620);
  // The event total, and so the lift, still cover everything tagged.
  expect(event.totalSpending).toBe(800);
  expect(data.lift).toBe(800 - data.expected);
});

it("gives every event day a bar and keeps the first and last day's spending", () => {
  const event = eventWith("2026-03-07", "2026-03-10", { "2026-03-07": 40, "2026-03-10": 10 });
  const { result } = renderHook(() => useEventChartData(event, [], undefined, [], "Uncategorized"));

  expect(result.current.tagged.dates.map(dayKey)).toEqual([
    "2026-03-07",
    "2026-03-08",
    "2026-03-09",
    "2026-03-10",
  ]);
  expect(result.current.dailySeries).toEqual([40, 0, 0, 10]);
  expect(result.current.dailyDuring).toBe(12.5);
  expect(result.current.outOfRange).toEqual([]);
  expect(result.current.outOfRangeTotal).toBe(0);
});

it("has no peak day when all the tagged spending is outside the event's dates", () => {
  const event = eventWith("2027-02-05", "2027-02-06", { "2026-09-14": 500 });
  const { result } = renderHook(() => useEventChartData(event, [], undefined, [], "Uncategorized"));

  expect(result.current.peak).toBeNull();
  expect(result.current.dailyDuring).toBe(0);
  expect(result.current.outOfRangeTotal).toBe(500);
});
