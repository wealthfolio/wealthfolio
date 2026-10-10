import { describe, expect, it } from "vitest";
import { resolveAssetPerformance } from "./asset-performance";

describe("resolveAssetPerformance", () => {
  it("combines realized lots with the current open unrealized P&L", () => {
    expect(
      resolveAssetPerformance({
        holdingTotalGain: -248.26,
        holdingTotalGainPercent: -0.0223,
        holdingTotalReturn: -248.26,
        holdingTotalReturnPercent: -0.0223,
        holdingRealizedGain: null,
        holdingUnrealizedGain: -248.26,
        realizedGainFromLots: 1404.87,
        realizedCostBasisFromLots: 7000,
        realizedLotsComparable: true,
        openCostBasis: 11127.7,
        holdingReturnBasis: 11127.7,
        income: 0,
      }),
    ).toEqual({
      totalPnl: 1156.61,
      totalPnlPercent: 1156.61 / (7000 + 11127.7),
      totalReturn: 1156.61,
      totalReturnPercent: 1156.61 / (7000 + 11127.7),
    });
  });

  it("keeps an engine total when it already contains realized lots", () => {
    expect(
      resolveAssetPerformance({
        holdingTotalGain: 1156.61,
        holdingTotalGainPercent: 0.071,
        holdingTotalReturn: 1156.61,
        holdingTotalReturnPercent: 0.071,
        holdingRealizedGain: 1404.87,
        holdingUnrealizedGain: -248.26,
        realizedGainFromLots: 1404.87,
        realizedCostBasisFromLots: 7000,
        realizedLotsComparable: true,
        openCostBasis: 11127.7,
        holdingReturnBasis: 18127.7,
        income: 0,
      }),
    ).toEqual({
      totalPnl: 1156.61,
      totalPnlPercent: 0.071,
      totalReturn: 1156.61,
      totalReturnPercent: 0.071,
    });
  });

  it("uses absolute basis for short and fully closed positions", () => {
    expect(
      resolveAssetPerformance({
        holdingTotalGain: null,
        holdingTotalGainPercent: null,
        holdingTotalReturn: null,
        holdingTotalReturnPercent: null,
        holdingRealizedGain: null,
        holdingUnrealizedGain: null,
        realizedGainFromLots: 40,
        realizedCostBasisFromLots: -200,
        realizedLotsComparable: true,
        openCostBasis: null,
        holdingReturnBasis: null,
        income: 5,
      }),
    ).toEqual({
      totalPnl: 40,
      totalPnlPercent: 0.2,
      totalReturn: 45,
      totalReturnPercent: 0.225,
    });
  });

  it("does not combine lots when their valuation currency is incomparable", () => {
    expect(
      resolveAssetPerformance({
        holdingTotalGain: -10,
        holdingTotalGainPercent: -0.1,
        holdingTotalReturn: -5,
        holdingTotalReturnPercent: -0.05,
        holdingRealizedGain: null,
        holdingUnrealizedGain: -10,
        realizedGainFromLots: 40,
        realizedCostBasisFromLots: 200,
        realizedLotsComparable: false,
        openCostBasis: 100,
        holdingReturnBasis: 100,
        income: 5,
      }),
    ).toEqual({
      totalPnl: -10,
      totalPnlPercent: -0.1,
      totalReturn: -5,
      totalReturnPercent: -0.05,
    });
  });

  it("keeps P&L unavailable when incomparable lots are the only realized source", () => {
    expect(
      resolveAssetPerformance({
        holdingTotalGain: null,
        holdingTotalGainPercent: null,
        holdingTotalReturn: null,
        holdingTotalReturnPercent: null,
        holdingRealizedGain: null,
        holdingUnrealizedGain: null,
        realizedGainFromLots: null,
        realizedCostBasisFromLots: 0,
        realizedLotsComparable: false,
        openCostBasis: null,
        holdingReturnBasis: null,
        income: null,
      }),
    ).toEqual({
      totalPnl: null,
      totalPnlPercent: null,
      totalReturn: null,
      totalReturnPercent: null,
    });
  });

  it("does not keep a stale backend percentage when the amount falls back to lots", () => {
    expect(
      resolveAssetPerformance({
        holdingTotalGain: null,
        holdingTotalGainPercent: -0.5,
        holdingTotalReturn: null,
        holdingTotalReturnPercent: -0.5,
        holdingRealizedGain: null,
        holdingUnrealizedGain: null,
        realizedGainFromLots: 40,
        realizedCostBasisFromLots: 200,
        realizedLotsComparable: true,
        openCostBasis: null,
        holdingReturnBasis: 200,
        income: 5,
      }),
    ).toEqual({
      totalPnl: 40,
      totalPnlPercent: 0.1,
      totalReturn: 45,
      totalReturnPercent: 0.1125,
    });
  });
});
