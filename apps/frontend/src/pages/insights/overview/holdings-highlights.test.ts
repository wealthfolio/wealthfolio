import { describe, expect, it } from "vitest";
import { HoldingType } from "@/lib/constants";
import type { Holding } from "@/lib/types";
import { getConcentration, getHoldingsDonut, getTopMovers } from "./holdings-highlights";

function holding(id: string, overrides: Partial<Holding> = {}): Holding {
  return {
    id,
    holdingType: HoldingType.SECURITY,
    accountId: "portfolio",
    instrument: { id, symbol: id, currency: "EUR", quoteMode: "MARKET" },
    quantity: 1,
    localCurrency: "EUR",
    baseCurrency: "USD",
    marketValue: { local: 90, base: 100 },
    dayChange: { local: 90, base: 10 },
    dayChangePct: 0.1,
    weight: 0,
    asOfDate: "2026-09-17",
    ...overrides,
  };
}

describe("getTopMovers", () => {
  it("ranks base-currency daily amounts separately from percentage ratios", () => {
    const holdings = [
      holding("amount", { dayChange: { local: 1, base: 100 }, dayChangePct: 0.01 }),
      holding("percent", { dayChange: { local: 999, base: 10 }, dayChangePct: 0.5 }),
      holding("loss", { dayChange: { local: 999, base: -20 }, dayChangePct: -0.2 }),
      holding("large-loss", { dayChange: { local: -1, base: -50 }, dayChangePct: -0.1 }),
    ];
    expect(getTopMovers(holdings, "amount").gainers.map((h) => h.id)).toEqual([
      "amount",
      "percent",
    ]);
    expect(getTopMovers(holdings, "amount").losers.map((h) => h.id)).toEqual([
      "large-loss",
      "loss",
    ]);
    expect(getTopMovers(holdings, "percent").gainers[0].id).toBe("percent");
    expect(getTopMovers(holdings, "percent").losers[0].id).toBe("loss");
    expect(holdings.map((h) => h.id)).toEqual(["amount", "percent", "loss", "large-loss"]);
  });

  it("excludes cash, alternatives, unlinked holdings, missing, nonfinite and zero moves", () => {
    const excluded = [
      holding("cash", { holdingType: HoldingType.CASH }),
      holding("property", { assetKind: "PROPERTY" }),
      holding("unlinked", { instrument: null }),
      holding("missing", { dayChange: null, dayChangePct: null }),
      holding("nan", { dayChange: { local: 1, base: NaN }, dayChangePct: NaN }),
      holding("infinite", { dayChange: { local: 1, base: Infinity }, dayChangePct: Infinity }),
      holding("zero", { dayChange: { local: 10, base: 0 }, dayChangePct: 0 }),
    ];
    for (const mode of ["amount", "percent"] as const) {
      expect(getTopMovers(excluded, mode)).toEqual({ gainers: [], losers: [] });
    }
  });

  it("limits each direction to three without placing gains among losers", () => {
    const holdings = [-5, -4, -3, -2, 1, 2, 3, 4].map((n) =>
      holding(String(n), { dayChangePct: n / 100 }),
    );
    const result = getTopMovers(holdings, "percent");
    expect(result.gainers.map((h) => h.id)).toEqual(["4", "3", "2"]);
    expect(result.losers.map((h) => h.id)).toEqual(["-5", "-4", "-3"]);
    expect(getTopMovers([holding("gain")], "amount").losers).toEqual([]);
  });
});

describe("getConcentration", () => {
  it("ranks five securities in base currency and includes cash in the denominator", () => {
    const holdings = [1, 6, 3, 2, 5, 4].map((n) =>
      holding(String(n), { marketValue: { local: 1000 / n, base: n * 100 } }),
    );
    const result = getConcentration([
      ...holdings,
      holding("cash", { holdingType: HoldingType.CASH, marketValue: { local: 900, base: 900 } }),
      holding("alternative", { assetKind: "PROPERTY", marketValue: { local: 99999, base: 99999 } }),
      holding("zero", { marketValue: { local: 0, base: 0 } }),
    ])!;
    expect(result.holdings.map((h) => h.id)).toEqual(["6", "5", "4", "3", "2"]);
    expect(result.total).toBe(3000);
    expect(result.topFiveWeight).toBeCloseTo(2 / 3);
    expect(result.largestWeight).toBe(0.2);
    expect(holdings.map((h) => h.id)).toEqual(["1", "6", "3", "2", "5", "4"]);
  });

  it.each([NaN, Infinity, -1, undefined, null])(
    "rejects invalid or short base values: %s",
    (value) => {
      const invalid = holding("invalid", { marketValue: { local: 100, base: value! } });
      expect(getConcentration([holding("valid"), invalid])).toBeNull();
      expect(
        getConcentration([holding("valid"), { ...invalid, holdingType: HoldingType.CASH }]),
      ).toBeNull();
    },
  );

  it("rejects absent market values, zero totals and overflowing totals", () => {
    expect(getConcentration([holding("missing", { marketValue: undefined as never })])).toBeNull();
    expect(getConcentration([])).toBeNull();
    expect(getConcentration([holding("zero", { marketValue: { local: 0, base: 0 } })])).toBeNull();
    expect(
      getConcentration(
        [1, 2].map((n) =>
          holding(String(n), { marketValue: { local: 1, base: Number.MAX_VALUE } }),
        ),
      ),
    ).toBeNull();
  });

  it("reports zero security concentration for an all-cash portfolio", () => {
    expect(getConcentration([holding("cash", { holdingType: HoldingType.CASH })])).toEqual({
      holdings: [],
      total: 100,
      topFiveWeight: 0,
      largestWeight: 0,
    });
  });
});

describe("getHoldingsDonut", () => {
  const valued = (id: string, base: number, overrides: Partial<Holding> = {}) =>
    holding(id, { marketValue: { local: base, base }, ...overrides });

  it("keeps the largest holdings, groups the rest as Other and adds cash last", () => {
    const holdings = [
      valued("small", 50),
      valued("big", 400),
      valued("mid", 200),
      valued("tiny", 25),
      valued("cash", 300, { holdingType: HoldingType.CASH }),
      valued("house", 10_000, { assetKind: "PROPERTY" }),
      valued("empty", 0),
    ];
    const donut = getHoldingsDonut(holdings, 2)!;
    expect(donut.total).toBe(975);
    expect(donut.holdingCount).toBe(4);
    expect(donut.slices.map((slice) => [slice.id, slice.value])).toEqual([
      ["big", 400],
      ["mid", 200],
      ["other", 75],
      ["cash", 300],
    ]);
    expect(donut.slices.find((slice) => slice.kind === "other")).toMatchObject({ count: 2 });
    expect(donut.slices.find((slice) => slice.kind === "cash")).toMatchObject({
      currencies: ["EUR"],
    });
    expect(donut.slices.reduce((sum, slice) => sum + slice.weight, 0)).toBeCloseTo(1);
  });

  it("lists each currency that holds cash once", () => {
    const donut = getHoldingsDonut([
      valued("a", 100),
      valued("eur", 10, { holdingType: HoldingType.CASH }),
      valued("eur-2", 5, { holdingType: HoldingType.CASH }),
      valued("usd", 20, { holdingType: HoldingType.CASH, localCurrency: "USD" }),
      valued("cad", 0, { holdingType: HoldingType.CASH, localCurrency: "CAD" }),
    ])!;
    expect(donut.slices.at(-1)).toMatchObject({ kind: "cash", currencies: ["EUR", "USD"] });
  });

  it("names a single leftover holding instead of showing a one-item Other", () => {
    const donut = getHoldingsDonut([valued("a", 3), valued("b", 2), valued("c", 1)], 2)!;
    expect(donut.slices.map((slice) => slice.kind)).toEqual(["holding", "holding", "holding"]);
  });

  it("matches the Concentration card's weights", () => {
    const holdings = [valued("a", 300), valued("cash", 100, { holdingType: HoldingType.CASH })];
    const donut = getHoldingsDonut(holdings)!;
    expect(donut.slices[0].weight).toBe(getConcentration(holdings)!.largestWeight);
  });

  it("is unavailable for short positions, negative cash or an empty portfolio", () => {
    expect(getHoldingsDonut([valued("a", 100), valued("short", -10)])).toBeNull();
    expect(
      getHoldingsDonut([valued("a", 100), valued("cash", -10, { holdingType: HoldingType.CASH })]),
    ).toBeNull();
    expect(getHoldingsDonut([])).toBeNull();
  });
});
