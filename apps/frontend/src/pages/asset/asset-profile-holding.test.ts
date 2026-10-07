import type { Holding } from "@/lib/types";
import { describe, expect, it } from "vitest";
import { getAssetProfileHolding } from "./asset-profile-holding";

const position = (overrides: Partial<Holding> = {}): Holding => ({
  id: "AGG-asset-1",
  accountId: "TOTAL",
  holdingType: "security",
  instrument: { id: "asset-1", symbol: "AAPL", currency: "USD", quoteMode: "MARKET" },
  isClosed: false,
  quantity: 10,
  localCurrency: "USD",
  baseCurrency: "CAD",
  marketValue: { local: 1200, base: 1800 },
  costBasis: { local: 1000, base: 1500 },
  unrealizedGain: { local: 200, base: 300 },
  unrealizedGainPct: 0.2,
  realizedGain: { local: 0, base: 0 },
  income: { local: 5, base: 7 },
  totalGain: { local: 200, base: 300 },
  totalReturn: { local: 205, base: 307 },
  returnBasis: { local: 1000, base: 1500 },
  weight: 0.25,
  asOfDate: "2026-10-06",
  ...overrides,
});

const closed = (overrides: Partial<Holding> = {}): Holding =>
  position({
    id: "AGG-CLOSED-asset-1",
    isClosed: true,
    quantity: 0,
    marketValue: { local: 0, base: 0 },
    costBasis: { local: 0, base: 0 },
    unrealizedGain: { local: 0, base: 0 },
    income: { local: 25, base: 32 },
    totalGain: { local: 0, base: 0 },
    totalReturn: { local: 25, base: 32 },
    returnBasis: { local: 0, base: 0 },
    weight: 0,
    ...overrides,
  });

describe("getAssetProfileHolding", () => {
  it.each([true, false])(
    "retains pre-transfer income regardless of row order (%s)",
    (closedFirst) => {
      const open = position();
      const historical = closed();
      const holdings = closedFirst ? [historical, open] : [open, historical];
      const result = getAssetProfileHolding(holdings, "asset-1");

      expect(result).toMatchObject({
        quantity: 10,
        isClosed: false,
        marketValue: open.marketValue,
        costBasis: open.costBasis,
        unrealizedGain: open.unrealizedGain,
        unrealizedGainPct: 0.2,
        weight: 0.25,
        income: { local: 30, base: 39 },
        totalReturn: { local: 230, base: 339 },
        totalReturnPct: 0.23,
        returnBasis: open.returnBasis,
      });
      expect(holdings).toEqual(closedFirst ? [closed(), position()] : [position(), closed()]);
    },
  );

  it("combines realized P&L and recomputes percentages from the combined basis", () => {
    const result = getAssetProfileHolding(
      [
        position(),
        closed({
          realizedGain: { local: 40, base: 55 },
          totalGain: { local: 40, base: 55 },
          totalReturn: { local: 65, base: 87 },
          returnBasis: { local: 200, base: 250 },
        }),
      ],
      "asset-1",
    );

    expect(result?.realizedGain).toEqual({ local: 40, base: 55 });
    expect(result?.realizedGainPct).toBe(0.2);
    expect(result?.totalGain).toEqual({ local: 240, base: 355 });
    expect(result?.totalGainPct).toBe(0.2);
    expect(result?.totalReturnPct).toBe(270 / 1200);
  });

  it("preserves single open or closed positions and handles an unheld asset", () => {
    const open = position();
    const historical = closed();
    expect(getAssetProfileHolding([open], "asset-1")).toBe(open);
    expect(getAssetProfileHolding([historical], "asset-1")).toBe(historical);
    expect(getAssetProfileHolding([open], "unheld")).toBeNull();
  });

  it("does not combine distinct asset IDs sharing the same symbol", () => {
    const other = closed({
      instrument: { id: "asset-2", symbol: "AAPL", currency: "USD", quoteMode: "MARKET" },
    });
    expect(getAssetProfileHolding([position(), closed(), other], "asset-1")?.income?.local).toBe(
      30,
    );
  });

  it("does not interpret zero net open quantity as a closed position", () => {
    const open = position({ quantity: 0 });
    expect(getAssetProfileHolding([closed(), open], "asset-1")?.isClosed).toBe(false);
  });

  it("keeps unavailable metrics null and avoids dividing by zero", () => {
    const result = getAssetProfileHolding(
      [
        position({ returnBasis: null, costBasis: null, income: null, realizedGain: null }),
        closed({ returnBasis: null, income: null, realizedGain: null }),
      ],
      "asset-1",
    );
    expect(result?.income).toBeNull();
    expect(result?.realizedGainPct).toBeNull();
    expect(result?.totalGainPct).toBeNull();
    expect(result?.totalReturnPct).toBeNull();
  });
});
