import { describe, expect, it } from "vitest";
import type { PerformanceResult } from "@/lib/types";
import {
  comparablePerformanceChartData,
  earliestPerformanceStartDate,
} from "./performance-chart-series";

function result(
  id: string,
  mode: PerformanceResult["mode"],
  returns: Partial<PerformanceResult["returns"]>,
  series = [
    { date: "2026-01-01", value: 0 },
    { date: "2026-01-31", value: returns.twr ?? returns.valueReturn ?? 0 },
  ],
): PerformanceResult & { id: string; name: string } {
  return {
    id,
    name: id,
    scope: { id, currency: "USD" },
    period: { startDate: "2026-01-01", endDate: "2026-01-31" },
    mode,
    returns: {
      twr: null,
      annualizedTwr: null,
      irr: null,
      annualizedIrr: null,
      valueReturn: null,
      annualizedValueReturn: null,
      ...returns,
    },
    attribution: {
      contributions: 0,
      distributions: 0,
      income: 0,
      realizedPnl: 0,
      unrealizedPnlChange: 0,
      fxEffect: 0,
      fees: 0,
      taxes: 0,
      residual: 0,
    },
    risk: {
      volatility: null,
      maxDrawdown: null,
      peakDate: null,
      troughDate: null,
      recoveryDate: null,
      drawdownDurationDays: null,
    },
    dataQuality: {
      status: "ok",
      warnings: [],
      notApplicableReasons: [],
    },
    series,
  };
}

describe("comparablePerformanceChartData", () => {
  it("charts transaction TWR against symbol benchmark returns for TWR comparison", () => {
    const data = comparablePerformanceChartData(
      [
        result("portfolio", "timeWeighted", { twr: 0.04, valueReturn: 0.03 }),
        result("SPY", "symbolPriceBased", { valueReturn: 0.05 }),
        result("holdings", "valueReturn", { valueReturn: 0.06 }),
      ],
      "twr",
      "portfolio",
    );

    expect(data.map((item) => item.id)).toEqual(["portfolio", "SPY"]);
  });

  it("does not chart transaction TWR when Value Return is selected", () => {
    const data = comparablePerformanceChartData(
      [
        result("portfolio", "timeWeighted", { twr: 0.04, valueReturn: 0.03 }),
        result("holdings", "valueReturn", { valueReturn: 0.06 }),
      ],
      "valueReturn",
      "holdings",
    );

    expect(data.map((item) => item.id)).toEqual(["holdings"]);
  });

  it("charts symbol price returns as market references with holdings value returns", () => {
    const data = comparablePerformanceChartData(
      [
        result("holdings", "valueReturn", { valueReturn: 0.06 }),
        result("SPY", "symbolPriceBased", { valueReturn: 0.05 }),
      ],
      "valueReturn",
      "holdings",
    );

    expect(data.map((item) => item.id)).toEqual(["holdings", "SPY"]);
  });

  it("does not fall back to a different comparable group when the selected item is not chartable", () => {
    const data = comparablePerformanceChartData(
      [
        result("portfolio", "timeWeighted", { twr: 0.04, valueReturn: 0.03 }),
        result("SPY", "symbolPriceBased", { valueReturn: 0.05 }),
      ],
      "valueReturn",
      "portfolio",
    );

    expect(data).toEqual([]);
  });

  it("does not chart a comparison with fewer than two shared dates", () => {
    const data = comparablePerformanceChartData(
      [
        result("portfolio", "timeWeighted", { twr: 0.04 }, [{ date: "2026-01-31", value: 0.04 }]),
        result("SPY", "symbolPriceBased", { valueReturn: 0.05 }, [
          { date: "2026-01-31", value: 0.05 },
        ]),
      ],
      "twr",
      "portfolio",
    );

    expect(data).toEqual([]);
  });

  it("clips to shared dates and rebases cumulative returns before charting", () => {
    const data = comparablePerformanceChartData(
      [
        result("portfolio", "timeWeighted", { twr: 0.03 }, [
          { date: "2026-01-02", value: 0.02 },
          { date: "2026-01-03", value: 0.03 },
        ]),
        result("SPY", "symbolPriceBased", { valueReturn: 0.05 }, [
          { date: "2026-01-01", value: 0.01 },
          { date: "2026-01-02", value: 0.04 },
          { date: "2026-01-03", value: 0.05 },
        ]),
      ],
      "twr",
      "portfolio",
    );

    expect(data.map((item) => item.returns.map((point) => point.date))).toEqual([
      ["2026-01-02", "2026-01-03"],
      ["2026-01-02", "2026-01-03"],
    ]);
    expect(data[0].returns[0].value).toBe(0);
    expect(data[0].returns[1].value).toBeCloseTo(1.03 / 1.02 - 1);
    expect(data[1].returns[0].value).toBe(0);
    expect(data[1].returns[1].value).toBeCloseTo(1.05 / 1.04 - 1);
  });

  it("drops sparse non-overlapping comparisons instead of blanking comparable series", () => {
    const data = comparablePerformanceChartData(
      [
        result("portfolio", "timeWeighted", { twr: 0.03 }, [
          { date: "2026-01-01", value: 0 },
          { date: "2026-01-02", value: 0.02 },
          { date: "2026-01-03", value: 0.03 },
        ]),
        result("SPY", "symbolPriceBased", { valueReturn: 0.05 }, [
          { date: "2026-01-01", value: 0 },
          { date: "2026-01-02", value: 0.04 },
          { date: "2026-01-03", value: 0.05 },
        ]),
        result("illiquid", "symbolPriceBased", { valueReturn: 0.01 }, [
          { date: "2026-02-01", value: 0 },
          { date: "2026-02-02", value: 0.01 },
        ]),
      ],
      "twr",
      "portfolio",
    );

    expect(data.map((item) => item.id)).toEqual(["portfolio", "SPY"]);
  });
});

describe("earliestPerformanceStartDate", () => {
  it("returns undefined when there is no data", () => {
    expect(earliestPerformanceStartDate(undefined)).toBeUndefined();
    expect(earliestPerformanceStartDate([])).toBeUndefined();
    expect(earliestPerformanceStartDate([null])).toBeUndefined();
  });

  it("prefers period.startDate and picks the earliest across items", () => {
    const older = result("older", "timeWeighted", { twr: 0.1 }, [{ date: "2020-06-15", value: 0 }]);
    // period.startDate is authoritative even when series starts later
    older.period.startDate = "2019-03-04";
    const newer = result("newer", "timeWeighted", { twr: 0.2 }, [{ date: "2023-01-02", value: 0 }]);
    const date = earliestPerformanceStartDate([newer, older])!;
    expect(date.getFullYear()).toBe(2019);
    expect(date.getMonth()).toBe(2);
    expect(date.getDate()).toBe(4);
  });

  it("falls back to the first series point without period.startDate", () => {
    const item = result("item", "timeWeighted", { twr: 0 }, [{ date: "2021-11-30", value: 0 }]);
    item.period.startDate = null;
    const date = earliestPerformanceStartDate([item])!;
    expect(date.getFullYear()).toBe(2021);
    expect(date.getMonth()).toBe(10); // November, 0-based
    expect(date.getDate()).toBe(30);
  });

  it("ignores unparseable dates", () => {
    const item = result("item", "timeWeighted", { twr: 0 }, [{ date: "not-a-date", value: 0 }]);
    item.period.startDate = undefined;
    expect(earliestPerformanceStartDate([item])).toBeUndefined();
  });
});
