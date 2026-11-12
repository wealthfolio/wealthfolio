import { describe, expect, it } from "vitest";
import { parseLocalDate } from "@/lib/utils";
import { comparisonBuckets } from "./chart-comparison";

const range = (from: string, to: string) => ({
  from: parseLocalDate(from),
  to: parseLocalDate(to),
});

describe("spending chart comparison", () => {
  it("retains all days in unequal calendar months, including empty and future days", () => {
    const current = comparisonBuckets(
      [{ date: "2026-04-03", income: 0, outflow: 12 }],
      range("2026-04-01", "2026-04-30"),
      "day",
      "2026-04-15",
    );
    const prior = comparisonBuckets(
      [{ date: "2026-03-31", income: 0, outflow: 50 }],
      range("2026-03-01", "2026-03-31"),
      "day",
      "2026-04-15",
    );
    expect(current).toHaveLength(30);
    expect(prior).toHaveLength(31);
    expect(current[0]).toMatchObject({ from: "2026-04-01", value: 0, future: false });
    expect(current[2].value).toBe(12);
    expect(current[15].future).toBe(true);
    expect(prior[30]).toMatchObject({ from: "2026-03-31", to: "2026-03-31", value: 50 });
  });

  it("aligns weeks from each window's start and clips the final partial week", () => {
    const buckets = comparisonBuckets(
      [
        { date: "2026-03-03", income: 0, outflow: 999 },
        { date: "2026-03-04", income: 0, outflow: 10 },
        { date: "2026-03-10", income: 0, outflow: 20 },
        { date: "2026-03-11", income: 0, outflow: 30 },
        { date: "2026-03-12", income: 0, outflow: 40 },
        { date: "2026-03-13", income: 0, outflow: 999 },
      ],
      range("2026-03-04", "2026-03-12"),
      "week",
      "2026-04-01",
    );
    expect(buckets).toEqual([
      { key: "2026-03-04", from: "2026-03-04", to: "2026-03-10", value: 30, future: false },
      { key: "2026-03-11", from: "2026-03-11", to: "2026-03-12", value: 70, future: false },
    ]);
  });

  it("keeps leap days and partial calendar months within their exact drill-down dates", () => {
    const buckets = comparisonBuckets(
      [
        { date: "2024-02-29", income: 0, outflow: 25 },
        { date: "2024-03-01", income: 0, outflow: 50 },
      ],
      range("2024-02-15", "2024-03-07"),
      "month",
      "2026-04-01",
    );
    expect(buckets).toEqual([
      { key: "2024-02", from: "2024-02-15", to: "2024-02-29", value: 25, future: false },
      { key: "2024-03", from: "2024-03-01", to: "2024-03-07", value: 50, future: false },
    ]);
  });
});
