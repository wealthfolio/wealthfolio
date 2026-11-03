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
