import { describe, expect, it } from "vitest";
import type { EventSpendingSummary } from "../types/event";
import { computeBaselinePace } from "./use-baseline-pace";
import { computeEventsAggregate } from "./use-events-aggregate";

const event: EventSpendingSummary = {
  eventId: "trip",
  eventName: "Trip",
  eventTypeId: "travel",
  eventTypeName: "Travel",
  eventTypeColor: null,
  startDate: "2024-12-28",
  endDate: "2025-01-05",
  totalSpending: 90,
  transactionCount: 1,
  currency: "USD",
  byCategory: {},
  dailySpending: {},
};

describe("custom event observation periods", () => {
  it("uses the selected year instead of an 84-day divisor", () => {
    const result = computeEventsAggregate([], [], undefined, new Map([["2025-06-10", 3650]]), {
      from: "2025-01-01",
      to: "2025-12-31",
      days: 365,
    });
    expect(result.normalPace).toBe(10);
  });
  it("excludes only event days overlapping the observation range", () => {
    const baseline = computeBaselinePace(
      [],
      [event],
      10,
      undefined,
      new Map([["2025-01-06", 50]]),
      { from: "2025-01-01", to: "2025-01-10", days: 10 },
    );
    expect(baseline).toBe(10);
  });
  it("keeps the preset default of 84 days", () => {
    expect(
      computeEventsAggregate([], [], undefined, new Map([["2025-06-10", 840]])).normalPace,
    ).toBe(10);
  });
});
