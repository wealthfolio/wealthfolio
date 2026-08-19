import { afterEach, describe, expect, it, vi } from "vitest";
import { createFormatter } from "@wealthfolio/ui";

import {
  addMonthsToMonthKey,
  compactMonthLabel,
  currentMonthKey,
  monthLabel,
  monthReportsRange,
  parseMonthKey,
} from "./month-period";

describe("spending month periods", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("parses and shifts valid month keys", () => {
    expect(parseMonthKey("2026-05")).toEqual({ year: 2026, month: 5 });
    expect(parseMonthKey("2026-13")).toBeNull();
    expect(addMonthsToMonthKey("2026-01", -1)).toBe("2025-12");
  });

  it("resolves a month key to a full calendar month report range", () => {
    const range = monthReportsRange("2026-05", "UTC");

    expect(range?.start.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(range?.end.toISOString()).toBe("2026-05-31T23:59:59.999Z");
    expect(range?.days).toBe(31);
    expect(range?.months).toBe(1);
  });

  it("labels Gregorian month buckets with Gregorian calendar names", () => {
    const formatting = createFormatter("fa-IR");
    const date = new Date(Date.UTC(2026, 0, 1));
    const expectedMonth = new Intl.DateTimeFormat("fa-IR", {
      calendar: "gregory",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(date);
    const expectedCompactMonth = new Intl.DateTimeFormat("fa-IR", {
      calendar: "gregory",
      month: "short",
      timeZone: "UTC",
    }).format(date);
    const expectedCompactYear = new Intl.DateTimeFormat("fa-IR", {
      calendar: "gregory",
      year: "2-digit",
      timeZone: "UTC",
    }).format(date);

    expect(monthLabel("2026-01", formatting)).toBe(expectedMonth);
    expect(compactMonthLabel("2026-01", formatting)).toBe(
      `${expectedCompactMonth} '${expectedCompactYear}`,
    );
  });

  it("reads the current month in the requested timezone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T03:00:00.000Z"));

    expect(currentMonthKey("America/Toronto")).toBe("2026-05");
  });
});
