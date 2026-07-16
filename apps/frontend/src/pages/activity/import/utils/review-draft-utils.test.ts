import { describe, it, expect } from "vitest";
import {
  parseNumericValue,
  parseSignedNumericValue,
  toNumber,
  hasPositiveValue,
  hasNonZeroValue,
  resolveCashActivityFields,
} from "./review-draft-utils";
import { ACTIVITY_SUBTYPES, ActivityType } from "@/lib/constants";

describe("parseNumericValue", () => {
  const auto = "auto";
  const none = "none";

  describe("signed value handling", () => {
    it("should preserve signs when requested", () => {
      expect(parseSignedNumericValue("-58.22", auto, none)).toBe("-58.22");
      expect(parseSignedNumericValue("-$1,234.56", auto, none)).toBe("-1234.56");
      expect(parseSignedNumericValue("(100.50)", auto, none)).toBe("-100.50");
      expect(parseSignedNumericValue("58.22", auto, none)).toBe("58.22");
    });
  });

  describe("absolute value handling", () => {
    it("should return absolute value for negative numbers", () => {
      expect(parseNumericValue("-58.22", auto, none)).toBe("58.22");
      expect(parseNumericValue("-1000", auto, none)).toBe("1000");
      expect(parseNumericValue("-0.5", auto, none)).toBe("0.5");
    });

    it("should return absolute value for negative currency amounts", () => {
      expect(parseNumericValue("-$58.22", auto, none)).toBe("58.22");
      expect(parseNumericValue("-$1,234.56", auto, none)).toBe("1234.56");
    });

    it("should return absolute value for parenthesized negatives", () => {
      expect(parseNumericValue("(100.50)", auto, none)).toBe("100.50");
      expect(parseNumericValue("($1,234.56)", auto, none)).toBe("1234.56");
    });

    it("should keep positive values unchanged", () => {
      expect(parseNumericValue("58.22", auto, none)).toBe("58.22");
      expect(parseNumericValue("$190.00", auto, none)).toBe("190.00");
      expect(parseNumericValue("1,234.56", auto, none)).toBe("1234.56");
    });

    it("should handle zero", () => {
      expect(parseNumericValue("0", auto, none)).toBe("0");
      expect(parseNumericValue("0.00", auto, none)).toBe("0.00");
    });
  });

  describe("decimal/thousands separators", () => {
    it("should handle comma as decimal separator", () => {
      expect(parseNumericValue("1.234,56", ",", ".")).toBe("1234.56");
      expect(parseNumericValue("-1.234,56", ",", ".")).toBe("1234.56");
    });

    it("should handle dot as decimal separator", () => {
      expect(parseNumericValue("1,234.56", ".", ",")).toBe("1234.56");
    });

    it("should auto-detect decimal separator", () => {
      // Both present: last one is decimal
      expect(parseNumericValue("1.234,56", auto, auto)).toBe("1234.56");
      expect(parseNumericValue("1,234.56", auto, auto)).toBe("1234.56");
    });
  });

  describe("edge cases", () => {
    it("should return undefined for empty/invalid values", () => {
      expect(parseNumericValue("", auto, none)).toBeUndefined();
      expect(parseNumericValue("   ", auto, none)).toBeUndefined();
      expect(parseNumericValue(undefined, auto, none)).toBeUndefined();
      expect(parseNumericValue("-", auto, none)).toBeUndefined();
      expect(parseNumericValue("+", auto, none)).toBeUndefined();
    });

    it("should handle scientific notation", () => {
      expect(parseNumericValue("1.5e3", auto, none)).toBe("1.5e3");
      expect(parseNumericValue("-1.5e3", auto, none)).toBe("1.5e3");
    });
  });
});

describe("toNumber", () => {
  it("should parse numeric strings", () => {
    expect(toNumber("123.45")).toBe(123.45);
    expect(toNumber("0")).toBe(0);
  });

  it("should pass through numbers", () => {
    expect(toNumber(42)).toBe(42);
  });

  it("should return undefined for non-numeric values", () => {
    expect(toNumber(null)).toBeUndefined();
    expect(toNumber(undefined)).toBeUndefined();
    expect(toNumber("")).toBeUndefined();
    expect(toNumber("abc")).toBeUndefined();
    expect(toNumber(Infinity)).toBeUndefined();
  });
});

describe("hasPositiveValue", () => {
  it("should return true for positive values", () => {
    expect(hasPositiveValue("58.22")).toBe(true);
    expect(hasPositiveValue(1)).toBe(true);
    expect(hasPositiveValue("0.01")).toBe(true);
  });

  it("should return false for zero, negative, or missing values", () => {
    expect(hasPositiveValue("0")).toBe(false);
    expect(hasPositiveValue("-5")).toBe(false);
    expect(hasPositiveValue(0)).toBe(false);
    expect(hasPositiveValue(null)).toBe(false);
    expect(hasPositiveValue(undefined)).toBe(false);
    expect(hasPositiveValue("")).toBe(false);
  });
});

describe("hasNonZeroValue", () => {
  it("should return true for non-zero values", () => {
    expect(hasNonZeroValue("58.22")).toBe(true);
    expect(hasNonZeroValue("-5")).toBe(true);
    expect(hasNonZeroValue(1)).toBe(true);
  });

  it("should return false for zero or missing values", () => {
    expect(hasNonZeroValue("0")).toBe(false);
    expect(hasNonZeroValue(0)).toBe(false);
    expect(hasNonZeroValue(null)).toBe(false);
    expect(hasNonZeroValue(undefined)).toBe(false);
  });
});

describe("resolveCashActivityFields", () => {
  describe("swaps quantity to amount for cash-like activities", () => {
    const cashTypes = [
      ActivityType.TAX,
      ActivityType.FEE,
      ActivityType.DIVIDEND,
      ActivityType.INTEREST,
      ActivityType.DEPOSIT,
      ActivityType.WITHDRAWAL,
      ActivityType.CREDIT,
    ];

    it.each(cashTypes)(
      "should swap for %s when amount is missing, quantity present, no unit price",
      (type) => {
        const result = resolveCashActivityFields(type, "58.22", undefined, undefined);
        expect(result.quantity).toBeUndefined();
        expect(result.amount).toBe("58.22");
      },
    );

    it.each(cashTypes)(
      "should swap for %s when amount is '0', quantity present, no unit price",
      (type) => {
        const result = resolveCashActivityFields(type, "190.00", "0", undefined);
        expect(result.quantity).toBeUndefined();
        expect(result.amount).toBe("190.00");
      },
    );
  });

  describe("does NOT swap when conditions are not met", () => {
    it("should not swap for BUY/SELL (non-cash types)", () => {
      const result = resolveCashActivityFields(ActivityType.BUY, "10", undefined, undefined);
      expect(result.quantity).toBe("10");
      expect(result.amount).toBeUndefined();
    });

    it("should not swap when amount already has a value", () => {
      const result = resolveCashActivityFields(ActivityType.TAX, "10", "58.22", undefined);
      expect(result.quantity).toBe("10");
      expect(result.amount).toBe("58.22");
    });

    it("should not swap when unit price is present (real qty * price)", () => {
      const result = resolveCashActivityFields(ActivityType.DIVIDEND, "10", undefined, "5.00");
      expect(result.quantity).toBe("10");
      expect(result.amount).toBeUndefined();
    });

    it("should not swap staking reward quantity into cash amount", () => {
      const result = resolveCashActivityFields(
        ActivityType.INTEREST,
        "0.25",
        undefined,
        undefined,
        ACTIVITY_SUBTYPES.STAKING_REWARD,
      );
      expect(result.quantity).toBe("0.25");
      expect(result.amount).toBeUndefined();
    });

    it("should not swap when quantity is also missing", () => {
      const result = resolveCashActivityFields(ActivityType.TAX, undefined, undefined, undefined);
      expect(result.quantity).toBeUndefined();
      expect(result.amount).toBeUndefined();
    });

    it("should not swap when activity type is undefined", () => {
      const result = resolveCashActivityFields(undefined, "58.22", undefined, undefined);
      expect(result.quantity).toBe("58.22");
      expect(result.amount).toBeUndefined();
    });

    it("should not swap for SPLIT", () => {
      const result = resolveCashActivityFields(ActivityType.SPLIT, "20", undefined, undefined);
      expect(result.quantity).toBe("20");
      expect(result.amount).toBeUndefined();
    });

    it("should not swap for TRANSFER_IN/OUT", () => {
      const result = resolveCashActivityFields(
        ActivityType.TRANSFER_IN,
        "100",
        undefined,
        undefined,
      );
      expect(result.quantity).toBe("100");
      expect(result.amount).toBeUndefined();
    });
  });

  describe("Schwab CSV scenarios", () => {
    it("should handle Bond Interest with amount in quantity column", () => {
      // Schwab: Quantity=$190.00, Amount=empty → after parseNumericValue: qty="190.00", amt=undefined
      const result = resolveCashActivityFields(
        ActivityType.INTEREST,
        "190.00",
        undefined,
        undefined,
      );
      expect(result.quantity).toBeUndefined();
      expect(result.amount).toBe("190.00");
    });

    it("should handle Foreign Tax Paid with amount in quantity column", () => {
      // Schwab: Quantity=-$58.22 → after parseNumericValue (abs): qty="58.22", amt=undefined
      const result = resolveCashActivityFields(ActivityType.TAX, "58.22", undefined, undefined);
      expect(result.quantity).toBeUndefined();
      expect(result.amount).toBe("58.22");
    });
  });
});
