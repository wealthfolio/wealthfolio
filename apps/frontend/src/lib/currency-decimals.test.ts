import { describe, expect, it } from "vitest";
import { AccountType } from "./constants";
import { cryptoMoneyDecimals, currencyFractionDigits } from "./currency-decimals";

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
