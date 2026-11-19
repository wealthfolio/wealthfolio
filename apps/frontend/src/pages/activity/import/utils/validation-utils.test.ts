import { describe, expect, it } from "vitest";
import { isinFallbackSymbol, validateTickerSymbol } from "./validation-utils";

describe("validateTickerSymbol", () => {
  it("accepts supported ticker formats", () => {
    expect(validateTickerSymbol("AAPL")).toBe(true);
    expect(validateTickerSymbol("CASH:USD")).toBe(true);
    expect(validateTickerSymbol("BRK.B")).toBe(true);
    expect(validateTickerSymbol("GOLD_KRUGERRAND")).toBe(true);
    expect(validateTickerSymbol("FUND.CLASS_A")).toBe(true);
  });

  it("accepts the full supported length", () => {
    expect(validateTickerSymbol("A".repeat(21))).toBe(true);
    expect(validateTickerSymbol("A".repeat(100))).toBe(true);
  });

  it("bounds the complete symbol", () => {
    expect(validateTickerSymbol("A".repeat(101))).toBe(false);
    expect(validateTickerSymbol(`${"A".repeat(100)}.B`)).toBe(false);
    expect(validateTickerSymbol(`${"A".repeat(98)}-${"B".repeat(50)}`)).toBe(false);
  });

  it("rejects free text and whitespace", () => {
    expect(validateTickerSymbol("bad symbol")).toBe(false);
    expect(validateTickerSymbol("Some Company Inc.")).toBe(false);
  });
});

describe("isinFallbackSymbol", () => {
  const fund = "PARAG PARIKH FLEXI CAP FUND - DIRECT PLAN";

  it("returns the ISIN when Symbol is a name and the ISIN is valid", () => {
    expect(isinFallbackSymbol(fund, "INF879O01027")).toBe("INF879O01027");
    expect(isinFallbackSymbol(` ${fund} `, " inf879o01027 ")).toBe("INF879O01027");
  });

  it("keeps a symbol that passes the symbol check", () => {
    expect(isinFallbackSymbol("AAPL", "US0378331005")).toBeUndefined();
    expect(isinFallbackSymbol("US0378331005", "US0378331005")).toBeUndefined();
  });

  it("ignores a blank Symbol and a missing or invalid ISIN", () => {
    expect(isinFallbackSymbol("", "INF879O01027")).toBeUndefined();
    expect(isinFallbackSymbol("   ", "INF879O01027")).toBeUndefined();
    expect(isinFallbackSymbol(fund, undefined)).toBeUndefined();
    expect(isinFallbackSymbol(fund, "")).toBeUndefined();
    // Wrong check digit
    expect(isinFallbackSymbol(fund, "INF879O01028")).toBeUndefined();
    expect(isinFallbackSymbol(fund, fund)).toBeUndefined();
  });
});
