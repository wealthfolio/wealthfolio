import { describe, expect, it } from "vitest";

import {
  calculateBasePortfolioPerformance,
  calculateDailyPortfolioPerformance,
  getPortfolioChangePercent,
} from "./holdings-tool-semantics";

describe("calculateBasePortfolioPerformance", () => {
  it("uses gross exposure when long and short bases offset", () => {
    const performance = calculateBasePortfolioPerformance([
      { returnBasisBase: 100, totalGainBase: 10, totalReturnBase: 12 },
      { returnBasisBase: -100, totalGainBase: 10, totalReturnBase: 8 },
    ]);

    expect(performance.totalPnl).toBe(20);
    expect(performance.totalPnlPct).toBe(0.1);
    expect(performance.totalReturn).toBe(20);
    expect(performance.totalReturnPct).toBe(0.1);
  });

  it("returns zero percentages for an empty gross basis", () => {
    const performance = calculateBasePortfolioPerformance([
      { returnBasisBase: 0, totalGainBase: 0, totalReturnBase: 0 },
    ]);

    expect(performance.totalPnlPct).toBe(0);
    expect(performance.totalReturnPct).toBe(0);
  });

  it("returns unavailable percentages for nonzero returns without gross basis", () => {
    const performance = calculateBasePortfolioPerformance([
      { returnBasisBase: 0, totalGainBase: 1, totalReturnBase: 2 },
    ]);

    expect(performance.totalPnlPct).toBeNull();
    expect(performance.totalReturnPct).toBeNull();
  });

  it("does not dilute a nonzero unbased PnL into holdings with valid basis", () => {
    const performance = calculateBasePortfolioPerformance([
      { returnBasisBase: 100, totalGainBase: 10 },
      { returnBasisBase: 0, totalGainBase: 20 },
    ]);

    expect(performance.totalPnl).toBe(30);
    expect(performance.totalPnlPct).toBeNull();
  });

  it("tracks unavailable PnL and total return independently", () => {
    const missingPnlBasis = calculateBasePortfolioPerformance([
      { returnBasisBase: 100, totalGainBase: 10, totalReturnBase: 10 },
      { totalGainBase: 20, totalReturnBase: 0 },
    ]);
    const missingReturnBasis = calculateBasePortfolioPerformance([
      { returnBasisBase: 100, totalGainBase: 10, totalReturnBase: 10 },
      { totalGainBase: 0, totalReturnBase: 20 },
    ]);

    expect(missingPnlBasis.totalPnlPct).toBeNull();
    expect(missingPnlBasis.totalReturnPct).toBe(0.1);
    expect(missingReturnBasis.totalPnlPct).toBe(0.1);
    expect(missingReturnBasis.totalReturnPct).toBeNull();
  });

  it("does not invalidate percentages for zero returns without basis", () => {
    const performance = calculateBasePortfolioPerformance([
      { returnBasisBase: 100, totalGainBase: 10, totalReturnBase: 12 },
      { totalGainBase: 0, totalReturnBase: 0 },
    ]);

    expect(performance.totalPnlPct).toBe(0.1);
    expect(performance.totalReturnPct).toBe(0.12);
  });
});

describe("calculateDailyPortfolioPerformance", () => {
  it("uses gross exposure for long and short holdings", () => {
    const performance = calculateDailyPortfolioPerformance([
      { marketValueBase: 100, dayChangePct: 0.1 },
      { marketValueBase: -100, dayChangePct: 0.2 },
    ]);

    expect(performance.changeAmount).toBe(30);
    expect(performance.changePct).toBe(0.15);
  });

  it("keeps daily change available when net market value is zero", () => {
    const performance = calculateDailyPortfolioPerformance([
      { marketValueBase: 100, dayChangePct: 0.1 },
      { marketValueBase: -100, dayChangePct: 0 },
    ]);

    expect(performance.changeAmount).toBe(10);
    expect(performance.changePct).toBe(0.05);
  });

  it("returns zero daily performance when gross exposure is zero", () => {
    const performance = calculateDailyPortfolioPerformance([
      { marketValueBase: 0, dayChangePct: 0.1 },
    ]);

    expect(performance.changeAmount).toBe(0);
    expect(performance.changePct).toBe(0);
  });

  it("excludes holdings with unavailable daily returns from gross exposure", () => {
    const performance = calculateDailyPortfolioPerformance([
      { marketValueBase: 100, dayChangePct: 0.1 },
      { marketValueBase: 100, dayChangePct: null },
    ]);

    expect(performance.changeAmount).toBe(10);
    expect(performance.changePct).toBe(0.1);
  });

  it("returns an unavailable percentage when every daily return is unavailable", () => {
    const performance = calculateDailyPortfolioPerformance([
      { marketValueBase: 100, dayChangePct: null },
    ]);

    expect(performance.changeAmount).toBe(0);
    expect(performance.changePct).toBeNull();
  });
});

describe("getPortfolioChangePercent", () => {
  it("uses the weighted row value only for daily performance", () => {
    expect(getPortfolioChangePercent("daily", 0.03, 0.4, 0.5)).toBe(0.03);
    expect(getPortfolioChangePercent("daily", null, 0.4, 0.5)).toBeNull();
  });

  it("uses base-currency aggregate returns for pnl and total return", () => {
    expect(getPortfolioChangePercent("pnl", 0.03, 0.4, 0.5)).toBe(0.4);
    expect(getPortfolioChangePercent("return", 0.03, 0.4, 0.5)).toBe(0.5);
  });
});
