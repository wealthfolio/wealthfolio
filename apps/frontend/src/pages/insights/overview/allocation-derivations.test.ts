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
  it("sums only unrealized P&L in base currency and excludes cash", () => {
    const security = holding({
      id: "stock",
      accountId: "a",
      holdingType: "security",
      localCurrency: "CAD",
      localValue: 150,
      baseValue: 100,
    });
    security.unrealizedGain = { local: 45, base: 30 };
    security.realizedGain = { local: 15, base: 10 };
    const loss = {
      ...security,
      id: "loss",
      unrealizedGain: { local: -10, base: -5 },
      realizedGain: { local: -4, base: -2 },
    };
    const cash = {
      ...security,
      id: "cash",
      holdingType: "cash",
      unrealizedGain: { local: 900, base: 600 },
      realizedGain: { local: 900, base: 600 },
    } as Holding;
    expect(computeValueStrip([security, loss, cash], []).unrealizedPnl).toBe(25);
    expect(computeValueStrip([loss], []).unrealizedPnl).toBe(-5);
    expect(computeValueStrip([], []).unrealizedPnl).toBe(0);
  });

  it("keeps P&L unavailable when a non-cash holding lacks performance", () => {
    const security = holding({
      id: "stock",
      accountId: "a",
      holdingType: "security",
      localCurrency: "USD",
      localValue: 150,
      baseValue: 150,
    });
    expect(computeValueStrip([security], []).unrealizedPnl).toBeNull();
    security.realizedGain = { local: 0, base: 0 };
    security.unrealizedGain = { local: NaN, base: NaN };
    expect(computeValueStrip([security], []).unrealizedPnl).toBeNull();
  });

  it("uses holdings P&L when the current valuation summary provides balances", () => {
    const security = holding({
      id: "stock",
      accountId: "a",
      holdingType: "security",
      localCurrency: "USD",
      localValue: 150,
      baseValue: 150,
    });
    security.unrealizedGain = { local: 35, base: 35 };
    security.realizedGain = { local: 5, base: 5 };
    const summary = {
      scopeId: "account:a",
      baseCurrency: "USD",
      cashBalanceBase: 0,
      investmentMarketValueBase: 150,
      totalValueBase: 150,
      holdingsCount: 1,
      accountCount: 1,
      currencySplit: [],
      cashCurrencySplit: [],
      sourceDataAsOf: "2026-09-17",
      calculatedAt: "2026-09-17",
      warnings: [],
    };
    expect(valueStripFromCurrentSummary(summary, [security]).unrealizedPnl).toBe(35);
  });

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

  it("keeps a single-account group as an expandable group carrying the account name", () => {
    const nodes = accountTreeWeights(
      [{ accountId: "taxable", totalValue: 100, totalValueBase: 100, fxRateToBase: 1 }],
      [account("taxable", "Fidelity Brokerage", "taxable")],
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe("taxable");
    expect(nodes[0].children).toHaveLength(1);
    expect(nodes[0].children?.[0].name).toBe("Fidelity Brokerage");
    expect(nodes[0].children?.[0].value).toBe(100);
  });

  it("renders an ungrouped account as a flat row named after the account", () => {
    const nodes = accountTreeWeights(
      [{ accountId: "solo", totalValue: 100, totalValueBase: 100, fxRateToBase: 1 }],
      [account("solo", "Schwab IRA")],
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe("Schwab IRA");
    expect(nodes[0].children).toBeUndefined();
  });

  it("keeps same-named ungrouped accounts as separate rows", () => {
    const nodes = accountTreeWeights(
      [
        { accountId: "a", totalValue: 100, totalValueBase: 100, fxRateToBase: 1 },
        { accountId: "b", totalValue: 50, totalValueBase: 50, fxRateToBase: 1 },
      ],
      [account("a", "Checking"), account("b", "Checking")],
    );

    expect(nodes).toHaveLength(2);
    expect(nodes.map((n) => n.value)).toEqual([100, 50]);
  });
});
