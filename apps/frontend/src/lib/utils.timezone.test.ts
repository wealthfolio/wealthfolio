import { afterEach, describe, expect, it, vi } from "vitest";

import { createFormatter } from "@wealthfolio/ui";
import {
  formatDate,
  formatDateISO,
  formatDateTime,
  formatDistanceToNow,
  resolveDisplayTimezone,
} from "./utils";

const formatting = createFormatter("en-US", "UTC");

describe("timezone formatting", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats with configured timezone", () => {
    const instant = "2025-01-01T00:30:00Z";
    const timezone = "America/Los_Angeles";

    const expectedDate = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: timezone,
    }).format(new Date(instant));
    const expectedTime = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      timeZone: timezone,
    }).format(new Date(instant));

    const formatted = formatDateTime(instant, formatting, timezone);
    expect(formatted.date).toBe(expectedDate);
    expect(formatted.time).toBe(expectedTime);
  });

  it("falls back to browser timezone for invalid configured timezone", () => {
    const instant = "2025-01-01T00:30:00Z";
    const fallbackTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    expect(resolveDisplayTimezone("Mars/Phobos")).toBe(fallbackTimezone);

    const expectedDate = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: fallbackTimezone,
    }).format(new Date(instant));

    const formatted = formatDateTime(instant, formatting, "Mars/Phobos");
    expect(formatted.date).toBe(expectedDate);
  });

  it("formats date picker dates without UTC day shift", () => {
    const originalTimezone = process.env.TZ;
    process.env.TZ = "Europe/Helsinki";

    try {
      const selectedDate = new Date(2026, 4, 2);

      expect(selectedDate.toISOString().split("T")[0]).toBe("2026-05-01");
      expect(formatDateISO(selectedDate)).toBe("2026-05-02");
    } finally {
      process.env.TZ = originalTimezone;
    }
  });

  it("keeps date-only values on the same calendar day", () => {
    const configuredFormatting = createFormatter("en-US", "Pacific/Honolulu");

    expect(formatDate("2026-07-10", configuredFormatting)).toBe("Jul 10, 2026");
  });

  it("uses the UI language for relative prose, independently of date formatting", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T12:00:00Z"));

    expect(
      formatDistanceToNow(
        new Date("2026-08-16T12:00:00Z"),
        { locale: "fr-FR", uiLocale: "en" },
        { addSuffix: true },
      ),
    ).toBe("2 days ago");
  });
});
