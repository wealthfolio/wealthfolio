import { describe, expect, it } from "vitest";
import {
  calculateIncomeFinalAmount,
  calculateTradeFinalAmount,
  calculateTradeFinalCash,
  isStoredTradeAmountCustom,
  resolveActivityCashMultiplier,
} from "./activity-final-amount";
import { ActivityType } from "./constants";

describe("resolveActivityCashMultiplier", () => {
  it("keeps the lockstep defaults with Asset::contract_multiplier", () => {
    expect(resolveActivityCashMultiplier("EQUITY")).toBe(1);
    expect(resolveActivityCashMultiplier("OPTION")).toBe(100);
    // Bonds deliberately default to 1: provider quotes are fraction-of-par,
    // so a 0.01 default would double-apply the /100 (the 1/100 valuation
    // bug). Percent-of-par is opt-in via explicit metadata.
    expect(resolveActivityCashMultiplier("BOND")).toBe(1);
  });

  it("lets an explicit multiplier win over every default", () => {
    expect(resolveActivityCashMultiplier("BOND", 0.01)).toBe(0.01);
    expect(resolveActivityCashMultiplier("OPTION", 10)).toBe(10);
    expect(resolveActivityCashMultiplier("EQUITY", "50")).toBe(50);
  });
});

describe("calculateTradeFinalAmount for bonds", () => {
  it("prices a default bond in fraction-of-par like its provider quotes", () => {
    // Face qty 10,000 at 0.985 of par, fee 5: final = 9,850 + 5.
    expect(
      calculateTradeFinalAmount({
        activityType: ActivityType.BUY,
        instrumentType: "BOND",
        quantity: 10_000,
        unitPrice: 0.985,
        fee: 5,
        tax: 0,
      }),
    ).toBe(9_855);
  });

  it("prices an opt-in percent-of-par bond via its explicit multiplier", () => {
    // Same economics entered as percent (98.5) with contractMultiplier 0.01.
    expect(
      calculateTradeFinalAmount({
        activityType: ActivityType.BUY,
        instrumentType: "BOND",
        quantity: 10_000,
        unitPrice: 98.5,
        fee: 5,
        tax: 0,
        contractMultiplier: 0.01,
      }),
    ).toBe(9_855);
  });
});

describe("calculateTradeFinalCash direction", () => {
  it("treats a sell whose charges exceed its proceeds as a debit", () => {
    expect(
      calculateTradeFinalCash({
        activityType: ActivityType.SELL,
        instrumentType: "OPTION",
        quantity: 1,
        unitPrice: 0.01,
        fee: 2,
        tax: 0,
        contractMultiplier: 100,
      }),
    ).toBe(-1);
  });
});

describe("calculated totals round like the backend writer", () => {
  const buy = (
    quantity: number,
    unitPrice: number,
    currency: string,
    extra: { fee?: number; instrumentType?: string } = {},
  ) =>
    calculateTradeFinalAmount({
      activityType: ActivityType.BUY,
      instrumentType: extra.instrumentType ?? "EQUITY",
      quantity,
      unitPrice,
      fee: extra.fee ?? 0,
      tax: 0,
      currency,
    });

  it("rounds the trade value to the currency's minor unit", () => {
    // 2,282 × 22.526204 = 51,404.797528; the statement books 51,404.80.
    expect(buy(2282, 22.526204, "USD")).toBe(51_404.8);
    expect(buy(3, 1234.5678, "JPY")).toBe(3_704);
    expect(buy(7, 1.23456, "KWD")).toBe(8.642);
  });

  it("rounds an exact tie away from zero despite binary floating point", () => {
    expect(buy(1, 10.005, "USD")).toBe(10.01);
  });

  it("rounds the exact product once, as the writer does", () => {
    // 0.3 × 3.34999999 is exactly 1.004999997: rounding it to 8 places first
    // would make it a tie and round it up to 1.01.
    expect(buy(0.3, 3.34999999, "USD")).toBe(1);
  });

  it("rounds a pence total to whole pence, a penny being GBP's minor unit", () => {
    // 3 × 1,234.5678 GBp is 3,703.7034p; the writer stores £37.04.
    expect(buy(3, 1234.5678, "GBp")).toBe(3_704);
  });

  it("keeps a sell's exact value when rounding would flip its direction", () => {
    const sell = (unitPrice: number, fee: number) =>
      calculateTradeFinalCash({
        activityType: ActivityType.SELL,
        instrumentType: "EQUITY",
        quantity: 1,
        unitPrice,
        fee,
        tax: 0,
        currency: "USD",
      });
    // 10.004 rounds to 10.00, which would turn 0.003 of proceeds into a debit.
    expect(sell(10.004, 10.001)).toBe(0.003);
    // 10.006 rounds to 10.01, which would turn a 0.003 debit into proceeds.
    expect(sell(10.006, 10.009)).toBe(-0.003);
    expect(sell(10.006, 5)).toBe(5.01);
  });

  it("adds charges after rounding the trade value", () => {
    expect(buy(2282, 22.526204, "USD", { fee: 1.0034 })).toBe(51_405.8034);
  });

  it("keeps a crypto trade's value exact", () => {
    expect(buy(0.00123, 61234.56, "USD", { instrumentType: "CRYPTO" })).toBe(75.3185088);
    expect(buy(0.00123, 61234.56, "USD", { instrumentType: "CRYPTOCURRENCY" })).toBe(75.3185088);
  });

  it("never rounds a non-zero value to zero", () => {
    expect(buy(0.001, 4, "USD")).toBe(0.004);
  });

  it("rounds a reinvested dividend's value the same way", () => {
    expect(
      calculateIncomeFinalAmount({ quantity: 0.5, unitPrice: 40.12345, currency: "USD" }),
    ).toBe(20.06);
  });
});

describe("isStoredTradeAmountCustom", () => {
  const trade = {
    activityType: ActivityType.BUY,
    instrumentType: "EQUITY",
    quantity: 2,
    unitPrice: 60,
    fee: 3,
    tax: 2,
  };

  it("lets an existing calculated total continue following the calculation", () => {
    expect(isStoredTradeAmountCustom({ ...trade, storedAmount: 125 })).toBe(false);
  });

  it("preserves an existing custom total and an explicit zero", () => {
    expect(isStoredTradeAmountCustom({ ...trade, storedAmount: 99 })).toBe(true);
    expect(isStoredTradeAmountCustom({ ...trade, storedAmount: 0 })).toBe(true);
  });

  it("preserves a stored total when the initial calculation is incomplete", () => {
    expect(
      isStoredTradeAmountCustom({
        ...trade,
        storedAmount: 99,
        quantity: undefined,
      }),
    ).toBe(true);
  });

  it("treats a total saved unrounded before rounding as the calculation", () => {
    // 3 × 1,234.5678 JPY was saved as 3,703.7034; the calculation now
    // rounds it to 3,704, which is still the same calculated total.
    expect(
      isStoredTradeAmountCustom({
        ...trade,
        fee: 0,
        tax: 0,
        quantity: 3,
        unitPrice: 1234.5678,
        currency: "JPY",
        storedAmount: 3703.7034,
      }),
    ).toBe(false);
  });

  it("keeps a crypto exchange's total that differs by less than a cent", () => {
    const crypto = {
      ...trade,
      fee: 0,
      tax: 0,
      instrumentType: "CRYPTO",
      quantity: 0.00123,
      unitPrice: 61234.56,
      currency: "USD",
    };
    expect(isStoredTradeAmountCustom({ ...crypto, storedAmount: 75.3185088 })).toBe(false);
    expect(isStoredTradeAmountCustom({ ...crypto, storedAmount: 75.3185 })).toBe(true);
  });

  it("uses the resolved option multiplier when determining ownership", () => {
    expect(
      isStoredTradeAmountCustom({
        ...trade,
        storedAmount: 105,
        instrumentType: "OPTION",
        unitPrice: 5,
        contractMultiplier: 10,
      }),
    ).toBe(false);
  });
});
