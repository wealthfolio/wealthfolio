import { describe, expect, it } from "vitest";

import { comparisonRange } from "./reports-period";
import { getZonedDateParts } from "./timezone";
import { parseCalendarYear, yearReportsRange } from "./year-period";

describe("calendar year selection", () => {
  it("validates completed years at stored-state and URL boundaries", () => {
    for (const value of [
      null,
      undefined,
      {},
      [],
      "",
      "2025.0",
      "2e3",
      " 2025",
      2025.5,
      1969,
      2026,
      NaN,
    ]) {
      expect(parseCalendarYear(value, "2026-01-01")).toBeNull();
    }
    expect(parseCalendarYear("2025", "2026-01-01")).toBe(2025);
    expect(parseCalendarYear(1970, "2026-12-31")).toBe(1970);
    expect(parseCalendarYear(2025, "2027-01-01")).toBe(2025);
  });

  it.each(["UTC", "America/Toronto", "Pacific/Kiritimati"])(
    "uses complete calendar boundaries and real comparison lengths in %s",
    (timezone) => {
      const range = yearReportsRange(2025, timezone);
      const prior = comparisonRange(range, "prior", timezone, 2025)!;
      expect(getZonedDateParts(prior.start, timezone)).toEqual({ year: 2024, month: 1, day: 1 });
      expect(getZonedDateParts(prior.end, timezone)).toEqual({ year: 2024, month: 12, day: 31 });
      expect(range.days).toBe(365);
      expect(prior.days).toBe(366);
      expect(prior.months).toBe(12);
      expect(comparisonRange(range, "yoy", timezone, 2025)).toEqual(prior);
      expect(comparisonRange(range, "none", timezone, 2025)).toBeNull();
    },
  );

  it("distinguishes calendar intent from an identical explicit date range", () => {
    const custom = yearReportsRange(2025, "UTC");
    expect(comparisonRange(custom, "prior", "UTC")?.start.toISOString()).toBe(
      "2024-01-02T00:00:00.000Z",
    );
    expect(comparisonRange(custom, "prior", "UTC", 2025)?.start.toISOString()).toBe(
      "2024-01-01T00:00:00.000Z",
    );
    expect(yearReportsRange(2000, "UTC").days).toBe(366);
    expect(yearReportsRange(2100, "UTC").days).toBe(365);
  });
});
