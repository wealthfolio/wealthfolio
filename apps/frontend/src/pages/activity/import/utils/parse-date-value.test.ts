import { detectDateOrder } from "@/lib/utils";
import { describe, expect, it } from "vitest";
import { parseDateValue, validateDraft } from "./draft-utils";

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

  it("auto-detects day-month-name dates with a two-digit year instead of an epoch date", () => {
    const r = local(parseDateValue("21-Sep-26", "auto"));
    expect({ y: r.y, mo: r.mo, day: r.day }).toEqual({ y: 2026, mo: 9, day: 21 });
  });
});

describe("parseDateValue — two-digit years (issue #1341)", () => {
  it("auto-detects a day-first dot date instead of interpreting it as a timestamp", () => {
    expect(local(parseDateValue("26.06.26", "auto"))).toMatchObject({
      y: 2026,
      mo: 6,
      day: 26,
    });
  });
});

describe("parseDateValue — Schwab 'as of' dates (issue #1874)", () => {
  const asOf = "09/16/2026 as of 09/15/2026";

  it("auto-detects the posting date", () => {
    expect(local(parseDateValue(asOf, "auto"))).toMatchObject({ y: 2026, mo: 9, day: 16 });
  });

  it("reads the posting date with an explicit format", () => {
    expect(local(parseDateValue(asOf, "MM/DD/YYYY"))).toMatchObject({ y: 2026, mo: 9, day: 16 });
  });

  it("orders an ambiguous row by the column's posting dates", () => {
    // Read month-first, "03/09/2026" would be 9 March; the 16th settles day-first.
    const column = ["16/09/2026 as of 15/09/2026", "03/09/2026 as of 02/09/2026"];
    const order = detectDateOrder(column) ?? undefined;
    expect(local(parseDateValue(column[1], "auto", order))).toMatchObject({
      y: 2026,
      mo: 9,
      day: 3,
    });
  });

  it("ignores case and spacing around 'as of'", () => {
    expect(local(parseDateValue("09/16/2026  AS  OF  09/15/2026", "auto"))).toMatchObject({
      y: 2026,
      mo: 9,
      day: 16,
    });
  });
});

describe("parseDateValue — Unix timestamps", () => {
  it("still parses a bare timestamp in seconds", () => {
    expect(parseDateValue("1714521600", "auto")).toBe("2024-05-01T00:00:00.000Z");
  });

  it("returns text with leading digits as-is instead of an epoch date", () => {
    expect(parseDateValue("12 Main St", "auto")).toBe("12 Main St");
  });
});

describe("validateDraft — activity dates", () => {
  const dateErrors = (activityDate: unknown) =>
    validateDraft({ activityDate: activityDate as string }).errors.activityDate;

  it("flags a date no format could read", () => {
    expect(dateErrors(parseDateValue("09/16/2026 10:30", "auto"))).toEqual(["Date not recognized"]);
  });

  it("accepts parsed, calendar and grid-edited dates", () => {
    expect(dateErrors(parseDateValue("09/16/2026 as of 09/15/2026", "auto"))).toBeUndefined();
    expect(dateErrors("2026-09-16")).toBeUndefined();
    expect(dateErrors(new Date(2026, 8, 16, 10, 30))).toBeUndefined();
  });

  it("still reports a missing date as required", () => {
    expect(dateErrors("")).toEqual(["Date is required"]);
  });
});
