import { describe, expect, it } from "vitest";

import type { NetWorthHistoryPoint, TaxonomyAllocation } from "@/lib/types";
import {
  averageMonthlyChange,
  computeMomentum,
  computeVelocity,
  deriveChange,
  investmentAllocation,
  parseHistory,
  type ParsedHistoryPoint,
} from "./utils";

function rawPoint(overrides: Partial<NetWorthHistoryPoint>): NetWorthHistoryPoint {
  return {
    date: "2024-01-01",
    portfolioValue: "0",
    alternativeAssetsValue: "0",
    totalLiabilities: "0",
    totalAssets: "0",
    netWorth: "0",
    netContribution: "0",
    breakdown: {},
    currency: "USD",
    ...overrides,
  };
}

function point(overrides: Partial<ParsedHistoryPoint>): ParsedHistoryPoint {
  return {
    date: "2024-01-01",
    netWorth: 0,
    totalAssets: 0,
    totalLiabilities: 0,
    portfolioValue: 0,
    alternativeAssetsValue: 0,
    netContribution: 0,
    breakdown: {},
    ...overrides,
  };
}

describe("net worth utils", () => {
  it("parses decimal strings and breakdown values into finite numbers", () => {
    const parsed = parseHistory([
      rawPoint({
        portfolioValue: "100.25",
        alternativeAssetsValue: "50",
        totalLiabilities: "25",
        totalAssets: "150.25",
        netWorth: "125.25",
        netContribution: "80",
        breakdown: { cash: "10.5", investments: "bad-value" },
      }),
    ]);

    expect(parsed).toEqual([
      expect.objectContaining({
        portfolioValue: 100.25,
        alternativeAssetsValue: 50,
        totalLiabilities: 25,
        totalAssets: 150.25,
        netWorth: 125.25,
        netContribution: 80,
        breakdown: { cash: 10.5, investments: 0 },
      }),
    ]);
  });

  it("derives asset and liability changes with the right sign", () => {
    expect(deriveChange([100, 125], false)).toEqual({ amount: 25, percent: 0.25 });
    expect(deriveChange([125, 100], true)).toEqual({ amount: 25, percent: 0.2 });
    expect(deriveChange([0, 25], false)).toEqual({ amount: 25, percent: 0 });
    expect(deriveChange([100], false)).toEqual({ amount: 0, percent: 0 });
  });

  it("decomposes monthly velocity into market gains, contributions, and equity built", () => {
    const history = [
      point({
        date: "2024-01-01",
        netWorth: 900,
        totalAssets: 1000,
        totalLiabilities: 100,
        portfolioValue: 700,
        alternativeAssetsValue: 300,
        netContribution: 600,
      }),
      point({
        date: "2024-02-01",
        netWorth: 1120,
        totalAssets: 1200,
        totalLiabilities: 80,
        portfolioValue: 820,
        alternativeAssetsValue: 380,
        netContribution: 650,
      }),
    ];

    const velocity = computeVelocity(history);
    const expectedMonths = 31 / (365.25 / 12);

    expect(velocity).toMatchObject({
      netChange: 220,
      marketGains: 150,
      contributions: 50,
      equityBuilt: 20,
    });
    expect(velocity?.months).toBeCloseTo(expectedMonths);
    expect(velocity?.perMonth).toBeCloseTo(220 / expectedMonths);
    expect(averageMonthlyChange(history)).toBeCloseTo(220 / expectedMonths);
    expect(averageMonthlyChange([history[0]])).toBe(0);
  });

  it("compares current momentum against an equal prior window", () => {
    const momentum = computeMomentum(
      [
        point({ date: "2024-01-01", netWorth: 100 }),
        point({ date: "2024-02-01", netWorth: 130 }),
        point({ date: "2024-03-01", netWorth: 150 }),
        point({ date: "2024-04-01", netWorth: 210 }),
      ],
      "2024-03-01",
      "2024-04-01",
    );

    expect(momentum).toMatchObject({
      currentChange: 60,
      priorChange: 50,
      beatBy: 10,
    });
    expect(momentum?.bars).toEqual([
      { month: "2024-02", value: 0, current: false },
      { month: "2024-03", value: 20, current: true },
      { month: "2024-04", value: 60, current: true },
    ]);
  });

  it("removes cash from investment allocation and rescales the remaining categories", () => {
    const allocation: TaxonomyAllocation = {
      taxonomyId: "asset-class",
      taxonomyName: "Asset Class",
      color: "#000",
      categories: [
        {
          categoryId: "cash",
          categoryName: "Cash",
          color: "#ccc",
          value: 200,
          percentage: 33.33,
        },
        {
          categoryId: "stocks",
          categoryName: "Stocks",
          color: "#0a0",
          value: 300,
          percentage: 50,
        },
        {
          categoryId: "bonds",
          categoryName: "Bonds",
          color: "#00a",
          value: 100,
          percentage: 16.67,
        },
      ],
    };

    const result = investmentAllocation(allocation);

    expect(result?.categories.map((category) => category.categoryName)).toEqual([
      "Stocks",
      "Bonds",
    ]);
    expect(result?.categories[0].percentage).toBe(75);
    expect(result?.categories[1].percentage).toBe(25);
    expect(investmentAllocation(undefined)).toBeUndefined();
  });
});
