import { describe, expect, it } from "vitest";
import type { PerformanceResult } from "@/lib/types";
import {
  chartViewFor,
  comparablePerformanceChartData,
  earliestPerformanceStartDate,
} from "./performance-chart-series";

interface Curves {
  /** Period value; a curve is attached only when the view has one. */
  twr?: number | null;
  moneyWeighted?: number | null;
}

function result(
  id: string,
  values: Curves,
  series = [
    { date: "2026-01-01", value: 0 },
    { date: "2026-01-31", value: values.twr ?? values.moneyWeighted ?? 0 },
  ],
  moneyWeightedSeries = series,
): PerformanceResult & { id: string; name: string } {
  const view = (value: number | null | undefined, curve: typeof series) =>
    value == null ? { unavailableReason: "Unavailable." } : { period: value, series: curve };
  return {
    id,
    name: id,
    scope: { id, currency: "USD" },
    period: { startDate: "2026-01-01", endDate: "2026-01-31" },
    returns: {
      twr: view(values.twr, series),
      moneyWeighted: view(values.moneyWeighted, moneyWeightedSeries),
      returnOnCost: { unavailableReason: "Unavailable." },
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
  };
}

describe("comparablePerformanceChartData", () => {
  it("charts every item with a time-weighted curve, benchmarks included", () => {
    const data = comparablePerformanceChartData(
      [
        result("portfolio", { twr: 0.04, moneyWeighted: 0.03 }),
        result("SPY", { twr: 0.05, moneyWeighted: 0.05 }),
        // A holdings account over its full history has no time-weighted return.
        result("holdings", { twr: null }),
      ],
      "twr",
      "portfolio",
    );

    expect(data.map((item) => item.id)).toEqual(["portfolio", "SPY"]);
  });

  it("charts money-weighted curves with the selected item first", () => {
    const data = comparablePerformanceChartData(
      [
        result("portfolio", { twr: 0.04, moneyWeighted: 0.03 }),
        result("mixed", { twr: null, moneyWeighted: 0.06 }),
      ],
      "moneyWeighted",
      "mixed",
    );

    expect(data.map((item) => item.id)).toEqual(["mixed", "portfolio"]);
  });

  it("does not rebase money-weighted curves: each keeps its own start", () => {
    const early = [
      { date: "2026-01-01", value: 0 },
      { date: "2026-01-02", value: 0.02 },
      { date: "2026-01-03", value: 0.03 },
    ];
    const late = [
      { date: "2026-01-02", value: 0 },
      { date: "2026-01-03", value: 0.01 },
    ];
    const data = comparablePerformanceChartData(
      [
        result("early", { twr: 0.03, moneyWeighted: 0.03 }, early, early),
        result("late", { twr: 0.01, moneyWeighted: 0.01 }, late, late),
      ],
      "moneyWeighted",
      "early",
    );

    expect(data.map((item) => item.returns)).toEqual([early, late]);
  });

  it("charts the other items when the selected one has no curve in this method", () => {
    const data = comparablePerformanceChartData(
      [result("holdings", { twr: null }), result("SPY", { twr: 0.05 })],
      "twr",
      "holdings",
    );

    expect(data.map((item) => item.id)).toEqual(["SPY"]);
  });

  it("does not chart a comparison with fewer than two shared dates", () => {
    const data = comparablePerformanceChartData(
      [
        result("portfolio", { twr: 0.04 }, [{ date: "2026-01-31", value: 0.04 }]),
        result("SPY", { twr: 0.05 }, [{ date: "2026-01-31", value: 0.05 }]),
      ],
      "twr",
      "portfolio",
    );

    expect(data).toEqual([]);
  });

  it("clips time-weighted curves to shared dates and rebases them", () => {
    const data = comparablePerformanceChartData(
      [
        result("portfolio", { twr: 0.03 }, [
          { date: "2026-01-02", value: 0.02 },
          { date: "2026-01-03", value: 0.03 },
        ]),
        result("SPY", { twr: 0.05 }, [
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
        result("portfolio", { twr: 0.03 }, [
          { date: "2026-01-01", value: 0 },
          { date: "2026-01-02", value: 0.02 },
          { date: "2026-01-03", value: 0.03 },
        ]),
        result("SPY", { twr: 0.05 }, [
          { date: "2026-01-01", value: 0 },
          { date: "2026-01-02", value: 0.04 },
          { date: "2026-01-03", value: 0.05 },
        ]),
        result("illiquid", { twr: 0.01 }, [
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

describe("chartViewFor", () => {
  it("draws the chosen method when the selected item has its curve", () => {
    const data = [result("portfolio", { twr: 0.04, moneyWeighted: 0.03 })];
    expect(chartViewFor(data, "moneyWeighted", "portfolio")).toBe("moneyWeighted");
  });

  it("draws a holdings account's ROI line over its full history, unrebased", () => {
    // No TWR or MWR over the full history: its return on investment stands in.
    const holdings = result("holdings", { twr: null, moneyWeighted: null });
    const roi = [
      { date: "2026-01-02", value: 0.1 },
      { date: "2026-01-31", value: 0.2 },
    ];
    holdings.returns.returnOnCost = { period: 0.2, series: roi };
    const data = [holdings, result("portfolio", { twr: 0.04 })];

    const view = chartViewFor(data, "twr", "holdings");
    expect(view).toBe("returnOnCost");
    expect(comparablePerformanceChartData(data, view, "holdings")).toEqual([
      { id: "holdings", name: "holdings", returns: roi },
    ]);
  });

  it("keeps benchmarks on an ROI chart, drawn as their price return", () => {
    const holdings = result("holdings", { twr: null, moneyWeighted: null });
    const roi = [
      { date: "2026-01-02", value: 0.1 },
      { date: "2026-01-31", value: 0.2 },
    ];
    holdings.returns.returnOnCost = { period: 0.2, series: roi };
    const spy = { ...result("SPY", { twr: 0.05, moneyWeighted: 0.05 }), type: "symbol" as const };

    const data = comparablePerformanceChartData([holdings, spy], "returnOnCost", "holdings");
    expect(data.map((item) => item.id)).toEqual(["holdings", "SPY"]);
    expect(data[1].returns).toEqual(spy.returns.twr.series);
  });
});

describe("earliestPerformanceStartDate", () => {
  it("returns undefined when there is no data", () => {
    expect(earliestPerformanceStartDate(undefined)).toBeUndefined();
    expect(earliestPerformanceStartDate([])).toBeUndefined();
    expect(earliestPerformanceStartDate([null])).toBeUndefined();
  });

  it("prefers period.startDate and picks the earliest across items", () => {
    const older = result("older", { twr: 0.1 }, [{ date: "2020-06-15", value: 0 }]);
    // period.startDate is authoritative even when series starts later
    older.period.startDate = "2019-03-04";
    const newer = result("newer", { twr: 0.2 }, [{ date: "2023-01-02", value: 0 }]);
    const date = earliestPerformanceStartDate([newer, older])!;
    expect(date.getFullYear()).toBe(2019);
    expect(date.getMonth()).toBe(2);
    expect(date.getDate()).toBe(4);
  });

  it("falls back to the first series point without period.startDate", () => {
    const item = result("item", { twr: 0 }, [{ date: "2021-11-30", value: 0 }]);
    item.period.startDate = null;
    const date = earliestPerformanceStartDate([item])!;
    expect(date.getFullYear()).toBe(2021);
    expect(date.getMonth()).toBe(10); // November, 0-based
    expect(date.getDate()).toBe(30);
  });

  it("ignores unparseable dates", () => {
    const item = result("item", { twr: 0 }, [{ date: "not-a-date", value: 0 }]);
    item.period.startDate = undefined;
    expect(earliestPerformanceStartDate([item])).toBeUndefined();
  });
});
