import { describe, expect, it } from "vitest";
import { resolveAssetPerformance } from "./asset-performance";

describe("resolveAssetPerformance", () => {
  it("combines realized lots with the current open unrealized P&L", () => {
    expect(
      resolveAssetPerformance({
        holdingTotalGain: -248.26,
        holdingTotalGainPercent: -0.0223,
        holdingTotalReturn: -248.26,
        holdingRealizedGain: null,
        holdingUnrealizedGain: -248.26,
        realizedGainFromLots: 1404.87,
        realizedCostBasisFromLots: 7000,
        openCostBasis: 11127.7,
        income: 0,
      }),
    ).toEqual({
      totalPnl: 1156.61,
      totalPnlPercent: 1156.61 / (7000 + 11127.7),
      totalReturn: 1156.61,
    });
  });

  it("keeps an engine total when it already contains realized lots", () => {
    expect(
      resolveAssetPerformance({
        holdingTotalGain: 1156.61,
        holdingTotalGainPercent: 0.071,
        holdingTotalReturn: 1156.61,
        holdingRealizedGain: 1404.87,
        holdingUnrealizedGain: -248.26,
        realizedGainFromLots: 1404.87,
        realizedCostBasisFromLots: 7000,
        openCostBasis: 11127.7,
        income: 0,
      }),
    ).toEqual({
      totalPnl: 1156.61,
      totalPnlPercent: 0.071,
      totalReturn: 1156.61,
    });
  });
});
