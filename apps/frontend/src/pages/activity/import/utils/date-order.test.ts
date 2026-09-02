import { format as formatDate } from "date-fns";
import { describe, expect, it } from "vitest";

import { detectDateOrder, isAmbiguousNumericDate, tryParseDate } from "@/lib/utils";
import { HoldingsFormat } from "../steps/holdings-mapping-step";
import { analyzeDateColumn, parseDateToYMD } from "./holdings-import-utils";

// tryParseDate returns a local-midnight Date, so compare in local time —
// toISOString would shift the day for any positive UTC offset.
const ymd = (date: Date | null) => (date ? formatDate(date, "yyyy-MM-dd") : null);

describe("detectDateOrder", () => {
  it("reads a column as day-first when a day exceeds 12", () => {
    expect(detectDateOrder(["03/08/2026", "26/06/2026"])).toBe("DMY");
  });

  it("reads a column as month-first when the second field exceeds 12", () => {
    expect(detectDateOrder(["03/08/2026", "06/26/2026"])).toBe("MDY");
  });

  it("returns null when every value could be read either way", () => {
    expect(detectDateOrder(["03/08/2026", "10/06/2026"])).toBeNull();
  });

  it("returns null when the column contradicts itself", () => {
    expect(detectDateOrder(["26/06/2026", "06/26/2026"])).toBeNull();
  });

  it("ignores values that are not numeric dates", () => {
    expect(detectDateOrder(["2026-08-03", "", "not a date"])).toBeNull();
  });

  it("handles dot and dash separators", () => {
    expect(detectDateOrder(["13.08.2026"])).toBe("DMY");
    expect(detectDateOrder(["08-13-2026"])).toBe("MDY");
  });

  it("does not mix separators within one value", () => {
    expect(detectDateOrder(["13/08-2026"])).toBeNull();
  });

  it("detects the order of two-digit-year dates", () => {
    expect(detectDateOrder(["13/08/26"])).toBe("DMY");
    expect(detectDateOrder(["08/13/26"])).toBe("MDY");
  });

  it("still reads a four-digit year followed by a time", () => {
    expect(detectDateOrder(["13/08/2026 14:30"])).toBe("DMY");
  });
});

describe("numeric format coverage", () => {
  // Detection reports an order for any separator NUMERIC_DATE_RE accepts, so
  // both parsers must be able to read that order back for each of them.
  const separatorCases = [
    ["/", "08/13/2026", "13/08/2026"],
    [".", "08.13.2026", "13.08.2026"],
    ["-", "08-13-2026", "13-08-2026"],
  ] as const;

  it.each(separatorCases)(
    "resolves and parses month-first %s dates",
    (_sep, monthFirst, _dayFirst) => {
      const order = detectDateOrder([monthFirst]);
      expect(order).toBe("MDY");
      expect(parseDateToYMD(monthFirst, "auto", order ?? undefined)).toBe("2026-08-13");
      expect(ymd(tryParseDate(monthFirst, order ?? undefined))).toBe("2026-08-13");
    },
  );

  it.each(separatorCases)(
    "resolves and parses day-first %s dates",
    (_sep, _monthFirst, dayFirst) => {
      const order = detectDateOrder([dayFirst]);
      expect(order).toBe("DMY");
      expect(parseDateToYMD(dayFirst, "auto", order ?? undefined)).toBe("2026-08-13");
      expect(ymd(tryParseDate(dayFirst, order ?? undefined))).toBe("2026-08-13");
    },
  );

  it("applies a resolved order to single-digit dates too", () => {
    expect(parseDateToYMD("3/8/2026", "auto", "DMY")).toBe("2026-08-03");
    expect(ymd(tryParseDate("3/8/2026", "DMY"))).toBe("2026-08-03");
  });

  it("applies the order detected from a two-digit-year row to the whole column", () => {
    const order = detectDateOrder(["03/08/26", "26/06/26"]);
    expect(order).toBe("DMY");
    expect(ymd(tryParseDate("03/08/26", order ?? undefined))).toBe("2026-08-03");
  });
});

describe("isAmbiguousNumericDate", () => {
  it("flags values whose leading fields are both <= 12", () => {
    expect(isAmbiguousNumericDate("03/08/2026")).toBe(true);
  });

  it("does not flag values a day field already resolves", () => {
    expect(isAmbiguousNumericDate("26/06/2026")).toBe(false);
  });

  it("does not flag ISO dates", () => {
    expect(isAmbiguousNumericDate("2026-08-03")).toBe(false);
  });

  it("checks ambiguity for two-digit-year dates", () => {
    expect(isAmbiguousNumericDate("03/08/26")).toBe(true);
    expect(isAmbiguousNumericDate("26/06/26")).toBe(false);
  });
});

describe("parseDateToYMD", () => {
  it("honours a resolved day-first order", () => {
    expect(parseDateToYMD("03/08/2026", "auto", "DMY")).toBe("2026-08-03");
  });

  it("keeps month-first when no order was resolved", () => {
    expect(parseDateToYMD("03/08/2026", "auto")).toBe("2026-03-08");
  });

  it("lets an explicit preset win over a resolved order", () => {
    expect(parseDateToYMD("03/08/2026", "MM/DD/YYYY", "DMY")).toBe("2026-03-08");
  });

  it("leaves ISO dates alone", () => {
    expect(parseDateToYMD("2026-08-03", "auto", "DMY")).toBe("2026-08-03");
  });

  it("leaves the existing dot-date reading alone when no order was resolved", () => {
    // Regression guard: "auto" must stay byte-for-byte the historical order,
    // where dd.MM precedes MM.dd.
    expect(parseDateToYMD("01.05.2024", "auto")).toBe("2024-05-01");
  });

  it("refuses a numeric date no pattern matched rather than guessing", () => {
    // 33 is not a day and not a month; the Date constructor would still invent
    // something engine-specific here.
    expect(parseDateToYMD("33/33/2026", "auto")).toBeNull();
  });
});

describe("tryParseDate", () => {
  it("honours a resolved day-first order", () => {
    expect(ymd(tryParseDate("03/08/2026", "DMY"))).toBe("2026-08-03");
  });

  it("is unchanged without an order", () => {
    expect(ymd(tryParseDate("03/08/2026"))).toBe("2026-03-08");
  });

  it("reads dot dates month-first once the column resolved that order", () => {
    expect(ymd(tryParseDate("01.05.2024", "MDY"))).toBe("2024-01-05");
  });

  it("leaves dot dates day-first when no order was resolved", () => {
    // Regression guard: the `auto` sequence is unchanged, so German/Swiss files
    // that read correctly today keep doing so.
    expect(ymd(tryParseDate("01.05.2024"))).toBe("2024-05-01");
  });
});

describe("analyzeDateColumn", () => {
  const headers = ["data", "isin", "qty"];
  const mapping = { [HoldingsFormat.DATE]: "data" };

  it("resolves the order from the column and asks for nothing", () => {
    const rows = [
      ["03/08/2026", "IT0005425761", "8000"],
      ["26/06/2026", "IT0005425761", "8000"],
    ];
    expect(analyzeDateColumn(headers, rows, mapping, "auto")).toEqual({
      order: "DMY",
      needsExplicitFormat: false,
    });
  });

  it("asks for an explicit format when the whole column is ambiguous", () => {
    // The real case: a statement whose every row carries one date, 3 August.
    const rows = [
      ["03/08/2026", "IT0005425761", "8000"],
      ["03/08/2026", "DE000WA7T3D8", "3"],
    ];
    expect(analyzeDateColumn(headers, rows, mapping, "auto")).toEqual({
      needsExplicitFormat: true,
      ambiguousSample: "03/08/2026",
    });
  });

  it("stays quiet once the user picked a format", () => {
    const rows = [["03/08/2026", "IT0005425761", "8000"]];
    expect(analyzeDateColumn(headers, rows, mapping, "DD/MM/YYYY")).toEqual({
      needsExplicitFormat: false,
    });
  });

  it("stays quiet when the date column is not mapped", () => {
    const rows = [["03/08/2026", "IT0005425761", "8000"]];
    expect(analyzeDateColumn(headers, rows, {}, "auto")).toEqual({
      needsExplicitFormat: false,
    });
  });

  it("stays quiet for ISO columns", () => {
    const rows = [["2026-08-03", "IT0005425761", "8000"]];
    expect(analyzeDateColumn(headers, rows, mapping, "auto")).toEqual({
      needsExplicitFormat: false,
    });
  });
});
