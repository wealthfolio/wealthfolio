import { describe, expect, it } from "vitest";

import {
  getBaseHoldingPerformancePercent,
  getBaseHoldingPerformancePercentForMode,
} from "./holding-performance";

describe("getBaseHoldingPerformancePercent", () => {
  it("derives FX-inclusive percentages independently from local performance", () => {
    const holding = {
      costBasis: { local: 100, base: 50 },
      unrealizedGain: { local: 10, base: -20 },
      realizedGain: { local: 20, base: 5 },
      totalGain: { local: 30, base: -15 },
      totalReturn: { local: 35, base: -13 },
      returnBasis: { local: 150, base: 75 },
    };

    expect(getBaseHoldingPerformancePercent(holding, "unrealizedGain")).toBe(-0.4);
    expect(getBaseHoldingPerformancePercent(holding, "realizedGain")).toBe(0.2);
    expect(getBaseHoldingPerformancePercent(holding, "totalGain")).toBe(-0.2);
    expect(getBaseHoldingPerformancePercent(holding, "totalReturn")).toBeCloseTo(-13 / 75);
  });

  it("matches the backend zero-basis behavior", () => {
    const holding = {
      costBasis: { local: 0, base: 0 },
      unrealizedGain: { local: 0, base: 0 },
      realizedGain: null,
      totalGain: { local: 0, base: 0 },
      totalReturn: { local: 0, base: 1 },
      returnBasis: { local: 0, base: 0 },
    };

    expect(getBaseHoldingPerformancePercent(holding, "unrealizedGain")).toBe(0);
    expect(getBaseHoldingPerformancePercent(holding, "totalGain")).toBe(0);
    expect(getBaseHoldingPerformancePercent(holding, "totalReturn")).toBeNull();
  });
});

describe("getBaseHoldingPerformancePercentForMode", () => {
  it("uses base returns for pnl and return modes while preserving daily performance", () => {
    const holding = {
      costBasis: { local: 100, base: 100 },
      dayChangePct: -0.02,
      unrealizedGain: { local: -10, base: 10 },
      realizedGain: null,
      totalGain: { local: -10, base: 10 },
      totalReturn: { local: -5, base: 12 },
      returnBasis: { local: 100, base: 100 },
    };

    expect(getBaseHoldingPerformancePercentForMode(holding, "daily")).toBe(-0.02);
    expect(getBaseHoldingPerformancePercentForMode(holding, "pnl")).toBe(0.1);
    expect(getBaseHoldingPerformancePercentForMode(holding, "return")).toBe(0.12);
  });

  it("falls back to base total gain when total return is unavailable", () => {
    const holding = {
      costBasis: { local: 100, base: 100 },
      dayChangePct: null,
      unrealizedGain: { local: -10, base: 10 },
      realizedGain: null,
      totalGain: { local: -10, base: 10 },
      totalReturn: null,
      returnBasis: { local: 100, base: 100 },
    };

    expect(getBaseHoldingPerformancePercentForMode(holding, "daily")).toBeNull();
    expect(getBaseHoldingPerformancePercentForMode(holding, "return")).toBe(0.1);
  });

  it("falls back to base unrealized gain when total PnL is unavailable", () => {
    const holding = {
      costBasis: { local: 100, base: 100 },
      dayChangePct: null,
      unrealizedGain: { local: -10, base: 10 },
      realizedGain: null,
      totalGain: null,
      totalReturn: null,
      returnBasis: { local: 100, base: 100 },
    };

    expect(getBaseHoldingPerformancePercentForMode(holding, "pnl")).toBe(0.1);
  });
});
