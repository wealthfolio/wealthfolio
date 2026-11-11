import { describe, expect, it } from "vitest";
import { AccountType } from "./constants";
import {
  cryptoMoneyDecimals,
  currencyFractionDigits,
  valueDecimalPlaces,
} from "./currency-decimals";

it("keeps existing precision, including values written in exponent notation", () => {
  expect(valueDecimalPlaces(0.005)).toBe(3);
  expect(valueDecimalPlaces(1.2e-8)).toBe(9);
  expect(valueDecimalPlaces(1e21)).toBe(0);
  expect(valueDecimalPlaces(undefined)).toBe(0);
});

describe("currencyFractionDigits", () => {
  it("follows core's accounting table, not display precision", () => {
    expect(currencyFractionDigits("USD")).toBe(2);
    expect(currencyFractionDigits("JPY")).toBe(0);
    expect(currencyFractionDigits("KWD")).toBe(3);
    // Intl displays these with 0 decimals; core books 2 and 3.
    expect(currencyFractionDigits("HUF")).toBe(2);
    expect(currencyFractionDigits("IQD")).toBe(3);
    expect(currencyFractionDigits("BTC")).toBe(8);
    expect(currencyFractionDigits("USDT")).toBe(2);
    expect(currencyFractionDigits(undefined)).toBe(2);
  });
});

describe("cryptoMoneyDecimals", () => {
  it("gives money fields 8 decimals in a crypto account or for a crypto asset", () => {
    expect(cryptoMoneyDecimals(AccountType.CRYPTOCURRENCY)).toBe(8);
    expect(cryptoMoneyDecimals(AccountType.SECURITIES, "CRYPTO")).toBe(8);
    expect(cryptoMoneyDecimals(undefined, "CRYPTOCURRENCY")).toBe(8);
  });

  it("leaves other fields to their currency", () => {
    expect(cryptoMoneyDecimals(AccountType.SECURITIES, "EQUITY")).toBeUndefined();
    expect(cryptoMoneyDecimals(undefined)).toBeUndefined();
  });
});
