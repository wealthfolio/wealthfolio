import { describe, expect, it } from "vitest";
import { calculateActivityCashImpact } from "./activity-utils";
import { ActivityType } from "./constants";
import type { ActivityDetails } from "./types";

function sell(currency: string | undefined, amount: number): ActivityDetails {
  return {
    activityType: ActivityType.SELL,
    quantity: "10",
    unitPrice: "0.05",
    fee: "10.5",
    tax: "0",
    amount: String(amount),
    currency,
  } as ActivityDetails;
}

describe("SELL reversal uses the core currency contract, not display precision", () => {
  // crates/core/src/fx/currency.rs owns these minor-unit acceptance bands.
  const cases: [string | undefined, number][] = [
    ...[
      "BIF",
      "CLP",
      "DJF",
      "GNF",
      "ISK",
      "JPY",
      "KMF",
      "KRW",
      "PYG",
      "RWF",
      "UGX",
      "UYI",
      "VND",
      "VUV",
      "XAF",
      "XOF",
      "XPF",
    ].map((code): [string, number] => [code, 1]),
    ...["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND", "KWF", "kwf"].map(
      (code): [string, number] => [code, 0.001],
    ),
    ...["CLF", "UYW"].map((code): [string, number] => [code, 0.0001]),
    ...[
      "BTC",
      "ETH",
      "XRP",
      "LTC",
      "BCH",
      "ADA",
      "DOT",
      "LINK",
      "XLM",
      "DOGE",
      "UNI",
      "SOL",
      "AVAX",
      "MATIC",
      "ATOM",
      "ALGO",
      "VET",
      "FIL",
      "TRX",
      "ETC",
      "XMR",
      "AAVE",
      "MKR",
      "COMP",
      "SNX",
      "YFI",
      "SUSHI",
      "CRV",
    ].map((code): [string, number] => [code, 1e-8]),
    ...[
      "HUF",
      "IDR",
      "USD",
      "USDT",
      "USDC",
      "DAI",
      "GBp",
      "GBX",
      "ILA",
      "ZAc",
      "USX",
      "ZZZ",
      "huf",
    ].map((code): [string, number] => [code, 0.01]),
    [undefined, 0.01],
  ];

  it.each(cases)("%s accepts only the core minor-unit band (%s)", (currency, unit) => {
    // Small crypto totals exercise the 1e-8 minor unit itself, not just the
    // relative epsilon. Stay away from the binary floating-point boundary.
    const expected = unit === 1e-8 ? 1e-6 : 10;
    const activity = (amount: number) => ({
      ...sell(currency, amount),
      ...(unit === 1e-8 ? { quantity: "1", unitPrice: "0.000001", fee: "0.000002" } : {}),
    });
    const tolerance = Math.max(unit, expected * 1e-8);
    const within = expected - tolerance / 2;
    const outside = expected - tolerance * 2;
    expect(calculateActivityCashImpact(activity(within))).toBe(-within);
    expect(calculateActivityCashImpact(activity(outside))).toBe(outside);
    expect(calculateActivityCashImpact(activity(expected))).toBe(-expected);
  });

  it.each(["HUF", "IDR", "IQD"])("does not reverse a mismatched %s final amount", (currency) => {
    expect(calculateActivityCashImpact(sell(currency, 9.5))).toBe(9.5);
  });
});
