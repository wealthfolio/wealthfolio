import { describe, expect, it } from "vitest";
import { parseDateValue } from "./draft-utils";

/**
 * Regression coverage for issue #984: Questrade exports dates as
 * "YYYY-MM-DD HH:MM:SS AM/PM" (e.g. "2026-05-04 12:00:00 AM"), which previously
 * failed to parse and surfaced as an epoch date (1969-12-31).
 *
 * Assertions read local Date fields rather than the ISO string, because
 * parseDateValue serializes a local-time Date via toISOString() — comparing the
 * UTC prefix would be timezone-dependent (local midnight rolls to the previous
 * UTC day east of UTC).
 */
function local(iso: string) {
  const d = new Date(iso);
  return { y: d.getFullYear(), mo: d.getMonth() + 1, day: d.getDate(), h: d.getHours() };
}

describe("parseDateValue — 12-hour AM/PM (issue #984)", () => {
  it("auto-detects the Questrade format without explicit config", () => {
    // 12:00:00 AM == local midnight of 2026-05-04
    expect(local(parseDateValue("2026-05-04 12:00:00 AM", "auto"))).toEqual({
      y: 2026,
      mo: 5,
      day: 4,
      h: 0,
    });
  });

  it("auto-detects PM correctly (noon, not midnight)", () => {
    expect(local(parseDateValue("2026-05-04 12:00:00 PM", "auto"))).toEqual({
      y: 2026,
      mo: 5,
      day: 4,
      h: 12,
    });
  });

  it("distinguishes 1 AM from 1 PM", () => {
    expect(local(parseDateValue("2026-05-04 01:30:00 AM", "auto")).h).toBe(1);
    expect(local(parseDateValue("2026-05-04 01:30:00 PM", "auto")).h).toBe(13);
  });

  it("respects the explicit AM/PM preset", () => {
    expect(local(parseDateValue("2026-05-04 12:00:00 PM", "YYYY-MM-DD hh:mm:ss A"))).toEqual({
      y: 2026,
      mo: 5,
      day: 4,
      h: 12,
    });
  });

  it("respects an explicit EU day/month AM/PM preset (no US-order fallback)", () => {
    // 04/05/2026 under DD/MM order is 4 May, not 5 April
    expect(local(parseDateValue("04/05/2026 09:15:00 PM", "DD/MM/YYYY hh:mm:ss A"))).toEqual({
      y: 2026,
      mo: 5,
      day: 4,
      h: 21,
    });
  });

  it("still parses plain date-only values", () => {
    const r = local(parseDateValue("2026-05-04", "auto"));
    expect({ y: r.y, mo: r.mo, day: r.day }).toEqual({ y: 2026, mo: 5, day: 4 });
  });
});

describe("parseDateValue — month-name dates", () => {
  it("auto-detects month-name dates with hyphens", () => {
    const r = local(parseDateValue("May-19-2023", "auto"));
    expect({ y: r.y, mo: r.mo, day: r.day }).toEqual({ y: 2023, mo: 5, day: 19 });
  });
});
