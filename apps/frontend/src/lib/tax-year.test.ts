import { describe, expect, it } from "vitest";

import {
  formatTaxYearStart,
  isCalendarTaxYear,
  lastTaxYearStartDay,
  parseTaxYearStart,
  readTaxYearStart,
  taxYearOf,
  taxYearRange,
} from "./tax-year";

const day = (year: number, month: number, dayOfMonth: number) => ({
  year,
  month,
  day: dayOfMonth,
});

describe("tax year start", () => {
  it("reads and writes MM-DD", () => {
    expect(parseTaxYearStart("07-01")).toEqual({ month: 7, day: 1 });
    expect(formatTaxYearStart({ month: 4, day: 6 })).toBe("04-06");
    expect(isCalendarTaxYear(readTaxYearStart("01-01"))).toBe(true);
  });

  it.each(["02-29", "02-30", "04-31", "13-01", "00-10", "01-00", "7-01", "07-1", "", "ab-cd"])(
    "rejects %j",
    (value) => {
      expect(parseTaxYearStart(value)).toBeNull();
    },
  );

  it("reads an absent or unreadable start as 1 January", () => {
    expect(readTaxYearStart(undefined)).toEqual({ month: 1, day: 1 });
    expect(readTaxYearStart("02-29")).toEqual({ month: 1, day: 1 });
  });

  it("never offers 29 February", () => {
    expect(lastTaxYearStartDay(2)).toBe(28);
    expect(lastTaxYearStartDay(4)).toBe(30);
    expect(lastTaxYearStartDay(12)).toBe(31);
  });
});

describe("tax years", () => {
  it("are calendar years with the default start", () => {
    const start = readTaxYearStart("01-01");
    expect(taxYearOf(day(2026, 1, 1), start)).toBe(2026);
    expect(taxYearOf(day(2026, 12, 31), start)).toBe(2026);
    expect(taxYearRange(2026, start)).toEqual({ start: day(2026, 1, 1), end: day(2026, 12, 31) });
  });

  it("start on 1 July in Australia and are named by the year they end in", () => {
    const start = readTaxYearStart("07-01");
    expect(taxYearOf(day(2026, 6, 30), start)).toBe(2026);
    expect(taxYearOf(day(2026, 7, 1), start)).toBe(2027);
    expect(taxYearRange(2026, start)).toEqual({ start: day(2025, 7, 1), end: day(2026, 6, 30) });
  });

  it("end on 5 April in the UK", () => {
    const start = readTaxYearStart("04-06");
    expect(taxYearOf(day(2026, 4, 5), start)).toBe(2026);
    expect(taxYearOf(day(2026, 4, 6), start)).toBe(2027);
    expect(taxYearRange(2026, start)).toEqual({ start: day(2025, 4, 6), end: day(2026, 4, 5) });
  });

  it("end on 29 February in a leap year when they start on 1 March", () => {
    const start = readTaxYearStart("03-01");
    expect(taxYearRange(2028, start).end).toEqual(day(2028, 2, 29));
    expect(taxYearRange(2027, start).end).toEqual(day(2027, 2, 28));
  });
});
