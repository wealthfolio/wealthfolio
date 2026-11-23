import { afterEach, describe, expect, it, vi } from "vitest";

import { comparisonRange, periodLabel, periodToReportsRange } from "./reports-period";

describe("reports periods", () => {
  it("keeps 1W and its prior period at seven calendar days across DST", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T12:00:00.000Z"));
    const range = periodToReportsRange("1W", "America/New_York");
    expect(range.start.toISOString()).toBe("2026-03-04T05:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-03-11T03:59:59.999Z");
    expect(range.days).toBe(7);
    const prior = comparisonRange(range, "prior", "America/New_York")!;
    expect(prior.start.toISOString()).toBe("2026-02-25T05:00:00.000Z");
    expect(prior.end.toISOString()).toBe("2026-03-04T04:59:59.999Z");
    expect(prior.days).toBe(7);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves LAST_MONTH to the previous full calendar month", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T12:00:00.000Z"));

    const range = periodToReportsRange("LAST_MONTH", "UTC");

    expect(range.start.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-05-31T23:59:59.999Z");
    expect(range.days).toBe(31);
    expect(range.months).toBe(1);
    expect(periodLabel("LAST_MONTH")).toBe("Last month");
  });
});
