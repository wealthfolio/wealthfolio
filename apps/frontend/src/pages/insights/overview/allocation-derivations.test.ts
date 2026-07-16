import type { Account, Holding } from "@/lib/types";
import { describe, expect, it } from "vitest";
import {
  accountTreeWeights,
  computeValueStrip,
  valueStripFromCurrentSummary,
} from "./allocation-derivations";

function holding({
  id,
  accountId,
  holdingType,
  localCurrency,
  baseCurrency = "USD",
  localValue,
  baseValue,
  dayChangeBase,
  prevCloseBase,
}: {
  id: string;
  accountId: string;
  holdingType: "cash" | "security";
  localCurrency: string;
  baseCurrency?: string;
  localValue: number;
  baseValue: number;
  dayChangeBase?: number;
  prevCloseBase?: number;
}): Holding {
  return {
    id,
    accountId,
    holdingType,
    localCurrency,
    baseCurrency,
    marketValue: { local: localValue, base: baseValue },
    dayChange: dayChangeBase == null ? null : { local: dayChangeBase, base: dayChangeBase },
    prevCloseValue: prevCloseBase == null ? null : { local: prevCloseBase, base: prevCloseBase },
    quantity: 1,
    weight: 0,
    asOfDate: "2026-05-30",
  } as Holding;
}

function account(id: string, name: string, group?: string): Account {
  return {
    id,
    name,
    group,
    accountType: "SECURITIES",
    balance: 0,
    currency: "USD",
    isDefault: false,
    isActive: true,
    isArchived: false,
    trackingMode: "NOT_SET",
    createdAt: new Date("2026-05-30"),
    updatedAt: new Date("2026-05-30"),
  } as Account;
}

describe("allocation dashboard derivations", () => {
  it("derives total exposure and cash-by-currency from holdings", () => {
    const data = computeValueStrip(
      [
        holding({
          id: "equity-usd",
          accountId: "taxable",
          holdingType: "security",
          localCurrency: "USD",
          localValue: 500,
          baseValue: 500,
          dayChangeBase: 10,
          prevCloseBase: 490,
        }),
        holding({
          id: "equity-cad",
          accountId: "rrsp",
          holdingType: "security",
          localCurrency: "CAD",
          localValue: 350,
          baseValue: 250,
          dayChangeBase: -5,
          prevCloseBase: 255,
        }),
        holding({
          id: "cash-usd",
          accountId: "taxable",
          holdingType: "cash",
          localCurrency: "USD",
          localValue: 100,
          baseValue: 100,
        }),
        holding({
          id: "cash-cad",
          accountId: "taxable",
          holdingType: "cash",
          localCurrency: "CAD",
          localValue: 70,
          baseValue: 50,
        }),
      ],
      [account("taxable", "Taxable"), account("rrsp", "RRSP")],
    );

    expect(data.total).toBe(900);
    expect(data.cash).toBe(150);
    expect(data.invested).toBe(750);
    expect(data.accountsCount).toBe(2);

    const usdExposure = data.currencySplit.find((row) => row.currency === "USD");
    const cadExposure = data.currencySplit.find((row) => row.currency === "CAD");
    expect(usdExposure?.value).toBe(600);
    expect(usdExposure?.percentage).toBeCloseTo(66.67, 2);
    expect(cadExposure?.value).toBe(300);
    expect(cadExposure?.percentage).toBeCloseTo(33.33, 2);

    const usdCash = data.cashCurrencySplit.find((row) => row.currency === "USD");
    const cadCash = data.cashCurrencySplit.find((row) => row.currency === "CAD");
    expect(usdCash?.value).toBe(100);
    expect(usdCash?.percentage).toBeCloseTo(66.67, 2);
    expect(cadCash?.value).toBe(70);
    expect(cadCash?.percentage).toBeCloseTo(33.33, 2);
  });

  it("maps scoped current valuation summary into value-strip data", () => {
    const data = valueStripFromCurrentSummary({
      scopeId: "portfolio:p1",
      baseCurrency: "USD",
      cashBalanceBase: 25,
      investmentMarketValueBase: 100,
      totalValueBase: 125,
      holdingsCount: 2,
      accountCount: 1,
      currencySplit: [{ currency: "USD", valueBase: 125, valueLocal: null, percentage: 100 }],
      cashCurrencySplit: [{ currency: "USD", valueBase: 25, valueLocal: 25, percentage: 100 }],
      sourceDataAsOf: "2026-06-01T12:30:00Z",
      calculatedAt: "2026-06-01T13:00:00Z",
      warnings: [],
    });

    expect(data.total).toBe(125);
    expect(data.cash).toBe(25);
    expect(data.invested).toBe(100);
    expect(data.investedPercent).toBe(80);
    expect(data.holdingsCount).toBe(2);
    expect(data.accountsCount).toBe(1);
  });

  it("uses current account valuation base totals for account weights", () => {
    const nodes = accountTreeWeights(
      [
        { accountId: "taxable", totalValue: 100, totalValueBase: 125, fxRateToBase: 1 },
        { accountId: "rrsp", totalValue: 500, totalValueBase: 75, fxRateToBase: 1 },
      ],
      [account("taxable", "Taxable", "Investing"), account("rrsp", "RRSP", "Investing")],
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0].value).toBe(200);
    expect(nodes[0].children?.[0].name).toBe("Taxable");
    expect(nodes[0].children?.[0].value).toBe(125);
  });
});
