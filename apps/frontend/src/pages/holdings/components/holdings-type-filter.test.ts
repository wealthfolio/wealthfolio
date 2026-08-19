import { HoldingType, QuoteMode } from "@/lib/constants";
import type { Holding } from "@/lib/types";
import deHoldings from "@/i18n/locales/de/holdings.json";
import enHoldings from "@/i18n/locales/en/holdings.json";
import esHoldings from "@/i18n/locales/es/holdings.json";
import frHoldings from "@/i18n/locales/fr/holdings.json";
import jaHoldings from "@/i18n/locales/ja/holdings.json";
import koHoldings from "@/i18n/locales/ko/holdings.json";
import zhHoldings from "@/i18n/locales/zh/holdings.json";
import { describe, expect, it } from "vitest";
import {
  CASH_HOLDING_TYPE_KEY,
  filterHoldingsByType,
  getHoldingTypeFilterOption,
  getHoldingTypeFilterValue,
  getHoldingTypeTranslationKey,
} from "./holdings-type-filter";

function holding(
  id: string,
  holdingType: Holding["holdingType"],
  assetType?: { key: string; name: string },
): Holding {
  return {
    id,
    holdingType,
    accountId: "account-1",
    instrument: assetType
      ? {
          id: `asset-${id}`,
          symbol: id,
          currency: "USD",
          quoteMode: QuoteMode.MARKET,
          classifications: {
            assetType: {
              id: assetType.key,
              taxonomyId: "asset-type",
              name: assetType.name,
              key: assetType.key,
              color: "#000000",
              sortOrder: 0,
              createdAt: "2026-08-18",
              updatedAt: "2026-08-18",
            },
            assetClasses: [],
            sectors: [],
            regions: [],
            customGroups: [],
          },
        }
      : undefined,
    quantity: 1,
    localCurrency: "USD",
    baseCurrency: "USD",
    marketValue: { local: 100, base: 100 },
    weight: 1,
    asOfDate: "2026-08-18",
  };
}

const stock = holding("stock", HoldingType.SECURITY, { key: "STOCK_COMMON", name: "Stock" });
const etf = holding("etf", HoldingType.SECURITY, { key: "ETF", name: "ETF" });
const cash = holding("cash", HoldingType.CASH);

describe("holdings type filters", () => {
  it("maps holdings to stable system taxonomy keys", () => {
    expect(getHoldingTypeFilterValue(cash)).toBe(CASH_HOLDING_TYPE_KEY);
    expect(getHoldingTypeFilterValue(stock)).toBe("STOCK_COMMON");
  });

  it("keeps the stored name as the localization fallback", () => {
    expect(getHoldingTypeFilterOption(stock, "Cash")).toEqual({
      value: "STOCK_COMMON",
      fallbackLabel: "Stock",
    });
    expect(getHoldingTypeTranslationKey("STOCK_COMMON")).toBe(
      "holdings:instrument_types.STOCK_COMMON",
    );
  });

  it("includes every holding when no asset type is selected", () => {
    expect(filterHoldingsByType([stock, etf, cash], [])).toEqual([stock, etf, cash]);
  });

  it("filters cash alongside taxonomy-backed asset types", () => {
    expect(filterHoldingsByType([stock, etf, cash], [CASH_HOLDING_TYPE_KEY])).toEqual([cash]);
    expect(filterHoldingsByType([stock, etf, cash], ["ETF", "STOCK_COMMON"])).toEqual([stock, etf]);
  });

  it("keeps cash balances distinct from securities classified as Cash Balance", () => {
    // "CASH" is a real instrument_type taxonomy key (the "Cash Balance" category), so
    // the synthetic cash pseudo-type must not reuse it.
    const cashBalanceFund = holding("mmf", HoldingType.SECURITY, {
      key: "CASH",
      name: "Cash Balance",
    });

    expect(getHoldingTypeFilterValue(cashBalanceFund)).not.toBe(CASH_HOLDING_TYPE_KEY);
    expect(filterHoldingsByType([cash, cashBalanceFund], [CASH_HOLDING_TYPE_KEY])).toEqual([cash]);
    expect(filterHoldingsByType([cash, cashBalanceFund], ["CASH"])).toEqual([cashBalanceFund]);
    expect(getHoldingTypeFilterOption(cashBalanceFund, "Cash")).toEqual({
      value: "CASH",
      fallbackLabel: "Cash Balance",
    });
  });

  it("resolves the cash label outside the instrument type namespace", () => {
    expect(getHoldingTypeTranslationKey(CASH_HOLDING_TYPE_KEY)).toBe("holdings:cash");
    expect(getHoldingTypeTranslationKey("CASH")).toBe("holdings:instrument_types.CASH");
  });

  it("defines the same system instrument types in every locale", () => {
    const englishKeys = Object.keys(enHoldings.instrument_types).sort();

    for (const locale of [deHoldings, esHoldings, frHoldings, jaHoldings, koHoldings, zhHoldings]) {
      expect(Object.keys(locale.instrument_types).sort()).toEqual(englishKeys);
    }
  });

  it("labels the Cash Balance category distinctly from cash in every locale", () => {
    // The two are separate values now, so they must also read as separate things. Dropping
    // instrument_types.CASH would silently fall back to the English taxonomy name instead.
    for (const locale of [
      enHoldings,
      deHoldings,
      esHoldings,
      frHoldings,
      jaHoldings,
      koHoldings,
      zhHoldings,
    ]) {
      expect(locale.instrument_types.CASH).toBeTruthy();
      expect(locale.instrument_types.CASH).not.toBe(locale.cash);
    }
  });
});
