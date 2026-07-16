import { describe, it, expect } from "vitest";
import {
  calculateCashActivityAmount,
  validateActivityImport,
  normalizeNumericValue,
  parseAndAbsoluteValue,
  validateTickerSymbol,
} from "./validation-utils";
import { ImportFormat, ActivityType, ImportType } from "@/lib/types";

describe("validation-utils", () => {
  describe("validateTickerSymbol (length)", () => {
    it("accepts common ticker formats", () => {
      expect(validateTickerSymbol("AAPL")).toBe(true);
      expect(validateTickerSymbol("CASH:USD")).toBe(true);
      expect(validateTickerSymbol("BRK.B")).toBe(true);
    });

    it("accepts symbols longer than the old 20/21 cap (issue #1145)", () => {
      expect(validateTickerSymbol("A".repeat(21))).toBe(true);
      expect(validateTickerSymbol("A".repeat(50))).toBe(true);
      expect(validateTickerSymbol("A".repeat(100))).toBe(true);
    });

    it("still rejects symbols beyond the 100-char bound", () => {
      expect(validateTickerSymbol("A".repeat(101))).toBe(false);
    });

    it("bounds the full symbol, not just the first segment", () => {
      // The 100-char limit must apply to the whole symbol including suffixes.
      expect(validateTickerSymbol("A".repeat(100) + ".B")).toBe(false);
      expect(validateTickerSymbol("A".repeat(98) + "-" + "B".repeat(50))).toBe(false);
    });

    it("accepts underscores used by custom-provider symbols", () => {
      expect(validateTickerSymbol("GOLD_KRUGERRAND")).toBe(true);
      expect(validateTickerSymbol("XAU_1OZ")).toBe(true);
      // underscores are allowed in suffix segments too, not just the first token
      expect(validateTickerSymbol("FUND.CLASS_A")).toBe(true);
      expect(validateTickerSymbol("ABC-DEF_GHI")).toBe(true);
    });

    it("still rejects free-text/whitespace garbage", () => {
      expect(validateTickerSymbol("bad symbol")).toBe(false);
      expect(validateTickerSymbol("Some Company Inc.")).toBe(false);
    });
  });

  describe("normalizeNumericValue", () => {
    it("should handle currency symbols", () => {
      expect(normalizeNumericValue("$48.945")).toBe(48.945);
      expect(normalizeNumericValue("$1223.63")).toBe(1223.63);
      expect(normalizeNumericValue("-$692.48")).toBe(-692.48);
      expect(normalizeNumericValue("£100.50")).toBe(100.5);
      expect(normalizeNumericValue("€75.25")).toBe(75.25);
      expect(normalizeNumericValue("¥1000")).toBe(1000);
    });

    it("should handle commas and spaces", () => {
      expect(normalizeNumericValue("1,234.56")).toBe(1234.56);
      expect(normalizeNumericValue("1 234.56")).toBe(1234.56);
      expect(normalizeNumericValue("$1,000,000.00")).toBe(1000000.0);
      expect(normalizeNumericValue(" 123.45 ")).toBe(123.45);
    });

    it("should handle parentheses for negative values", () => {
      expect(normalizeNumericValue("(100.50)")).toBe(100.5);
      expect(normalizeNumericValue("$(1,234.56)")).toBe(1234.56);
    });

    it("should handle empty and invalid values", () => {
      expect(normalizeNumericValue("")).toBeUndefined();
      expect(normalizeNumericValue("   ")).toBeUndefined();
      expect(normalizeNumericValue("-")).toBeUndefined();
      expect(normalizeNumericValue("N/A")).toBeUndefined();
      expect(normalizeNumericValue("null")).toBeUndefined();
      expect(normalizeNumericValue("abc")).toBeUndefined();
      expect(normalizeNumericValue(undefined)).toBeUndefined();
    });

    it("should handle plain numeric values", () => {
      expect(normalizeNumericValue("123.45")).toBe(123.45);
      expect(normalizeNumericValue("-67.89")).toBe(-67.89);
      expect(normalizeNumericValue("0")).toBe(0);
      expect(normalizeNumericValue("0.00")).toBe(0);
    });
  });

  describe("parseAndAbsoluteValue", () => {
    it("should return absolute values of normalized numbers", () => {
      expect(parseAndAbsoluteValue("$48.945")).toBe(48.945);
      expect(parseAndAbsoluteValue("-$692.48")).toBe(692.48);
      expect(parseAndAbsoluteValue("(100.50)")).toBe(100.5);
      expect(parseAndAbsoluteValue("-123.45")).toBe(123.45);
    });

    it("should return undefined for invalid values", () => {
      expect(parseAndAbsoluteValue("")).toBeUndefined();
      expect(parseAndAbsoluteValue("abc")).toBeUndefined();
      expect(parseAndAbsoluteValue(undefined)).toBeUndefined();
    });
  });

  describe("calculateCashActivityAmount", () => {
    it("should handle positive values correctly", () => {
      expect(calculateCashActivityAmount(100, 2.5)).toBe(250);
      expect(calculateCashActivityAmount(undefined, 500)).toBe(500);
      expect(calculateCashActivityAmount(200, undefined)).toBe(200);
    });

    it("should convert negative values to positive using absolute values", () => {
      expect(calculateCashActivityAmount(-100, -2.5)).toBe(250);
      expect(calculateCashActivityAmount(undefined, -500)).toBe(500);
      expect(calculateCashActivityAmount(-200, undefined)).toBe(200);
    });

    it("should handle mixed positive and negative values", () => {
      expect(calculateCashActivityAmount(-100, 2.5)).toBe(250);
      expect(calculateCashActivityAmount(100, -2.5)).toBe(250);
    });
  });

  describe("validateActivityImport with negative values", () => {
    const testMapping = {
      accountId: "test-account",
      importType: ImportType.ACTIVITY,
      name: "Test Mapping",
      fieldMappings: {
        [ImportFormat.DATE]: "date",
        [ImportFormat.SYMBOL]: "symbol",
        [ImportFormat.ACTIVITY_TYPE]: "activityType",
        [ImportFormat.QUANTITY]: "quantity",
        [ImportFormat.UNIT_PRICE]: "unitPrice",
        [ImportFormat.AMOUNT]: "amount",
        [ImportFormat.FEE]: "fee",
        [ImportFormat.TAX]: "tax",
        [ImportFormat.CURRENCY]: "currency",
      },
      activityMappings: {
        [ActivityType.BUY]: ["BUY"],
        [ActivityType.SELL]: ["SELL"],
        [ActivityType.DIVIDEND]: ["DIVIDEND"],
        [ActivityType.DEPOSIT]: ["DEPOSIT"],
        [ActivityType.TAX]: ["TAX"],
        [ActivityType.FEE]: ["FEE"],
        [ActivityType.TRANSFER_IN]: ["TRANSFER_IN"],
        [ActivityType.TRANSFER_OUT]: ["TRANSFER_OUT"],
        [ActivityType.SPLIT]: ["SPLIT"],
      },
      symbolMappings: {},
      accountMappings: {},
    };

    it("should convert negative values to positive for BUY activities", () => {
      const testData = [
        {
          lineNumber: "1",
          date: "2024-01-01T00:00:00.000Z",
          symbol: "AAPL",
          activityType: "BUY",
          quantity: "-10",
          unitPrice: "-150.50",
          amount: "-1505.00",
          fee: "-5.00",
          tax: "-2.00",
          currency: "USD",
        },
      ];

      const result = validateActivityImport(testData, testMapping, "test-account", "USD");

      expect(result.activities).toHaveLength(1);
      const activity = result.activities[0];

      expect(activity.quantity).toBe(10);
      expect(activity.unitPrice).toBe(150.5);
      expect(activity.amount).toBe(1505); // quantity * unitPrice (10 * 150.50 = 1505)
      expect(activity.fee).toBe(5.0);
      expect(activity.tax).toBe(2.0);
    });

    it("should apply symbol mappings using trimmed CSV symbol keys", () => {
      const testData = [
        {
          lineNumber: "1",
          date: "2024-01-01T00:00:00.000Z",
          symbol: "  Long Fund Name  ",
          activityType: "BUY",
          quantity: "10",
          unitPrice: "25.00",
          amount: "250.00",
          fee: "0",
          currency: "USD",
        },
      ];

      const result = validateActivityImport(
        testData,
        {
          ...testMapping,
          symbolMappings: {
            "Long Fund Name": "VTI",
          },
        },
        "test-account",
        "USD",
      );

      expect(result.activities).toHaveLength(1);
      expect(result.activities[0].symbol).toBe("VTI");
      expect(result.activities[0].isValid).toBe(true);
    });

    it("should convert negative values to positive for SELL activities", () => {
      const testData = [
        {
          lineNumber: "1",
          date: "2024-01-01T00:00:00.000Z",
          symbol: "MSFT",
          activityType: "SELL",
          quantity: "-5",
          unitPrice: "-300.00",
          amount: "-1500.00",
          fee: "-2.50",
          tax: "-1.25",
          currency: "USD",
        },
      ];

      const result = validateActivityImport(testData, testMapping, "test-account", "USD");

      expect(result.activities).toHaveLength(1);
      const activity = result.activities[0];

      expect(activity.quantity).toBe(5);
      expect(activity.unitPrice).toBe(300.0);
      expect(activity.amount).toBe(1500); // quantity * unitPrice
      expect(activity.fee).toBe(2.5);
      expect(activity.tax).toBe(1.25);
    });

    it("should preserve dividend withholding tax", () => {
      const testData = [
        {
          lineNumber: "1",
          date: "2024-01-01T00:00:00.000Z",
          symbol: "MSFT",
          activityType: "DIVIDEND",
          quantity: "1",
          unitPrice: "0.75",
          amount: "0.75",
          fee: "0",
          tax: "-0.11",
          currency: "USD",
        },
      ];

      const result = validateActivityImport(testData, testMapping, "test-account", "USD");

      expect(result.activities).toHaveLength(1);
      const activity = result.activities[0];

      expect(activity.activityType).toBe(ActivityType.DIVIDEND);
      expect(activity.amount).toBe(0.75);
      expect(activity.tax).toBe(0.11);
    });

    it("should use a tax column as the cash amount for standalone TAX activities", () => {
      const testData = [
        {
          lineNumber: "1",
          date: "2024-01-01T00:00:00.000Z",
          symbol: "",
          activityType: "TAX",
          quantity: "",
          unitPrice: "",
          amount: "",
          fee: "0",
          tax: "-58.22",
          currency: "USD",
        },
      ];

      const result = validateActivityImport(testData, testMapping, "test-account", "USD");

      expect(result.activities).toHaveLength(1);
      const activity = result.activities[0];

      expect(activity.isValid).toBe(true);
      expect(activity.activityType).toBe(ActivityType.TAX);
      expect(activity.amount).toBe(58.22);
      expect(activity.fee).toBe(0);
      expect(activity.tax).toBe(0);
    });

    it("should convert negative values to positive for DEPOSIT activities", () => {
      const testData = [
        {
          lineNumber: "1",
          date: "2024-01-01T00:00:00.000Z",
          symbol: "CASH:USD",
          activityType: "DEPOSIT",
          quantity: "1",
          unitPrice: "1",
          amount: "-1000.00",
          fee: "-0.00",
          currency: "USD",
        },
      ];

      const result = validateActivityImport(testData, testMapping, "test-account", "USD");

      expect(result.activities).toHaveLength(1);
      const activity = result.activities[0];

      expect(activity.amount).toBe(1000.0);
      expect(activity.fee).toBe(0.0);
    });

    it("should handle mixed positive and negative values correctly", () => {
      const testData = [
        {
          lineNumber: "1",
          date: "2024-01-01T00:00:00.000Z",
          symbol: "GOOGL",
          activityType: "BUY",
          quantity: "3", // positive
          unitPrice: "-2500.00", // negative
          amount: "7500.00", // positive
          fee: "-10.00", // negative
          currency: "USD",
        },
      ];

      const result = validateActivityImport(testData, testMapping, "test-account", "USD");

      expect(result.activities).toHaveLength(1);
      const activity = result.activities[0];

      expect(activity.quantity).toBe(3);
      expect(activity.unitPrice).toBe(2500.0); // converted to positive
      expect(activity.amount).toBe(7500); // quantity * unitPrice (3 * 2500)
      expect(activity.fee).toBe(10.0); // converted to positive
    });

    it("should correct unitPrice when CSV amount disagrees with qty*price (bond import)", () => {
      const testData = [
        {
          lineNumber: "1",
          date: "2024-01-05T00:00:00.000Z",
          symbol: "BBG0140BZHN4",
          activityType: "BUY",
          quantity: "6000",
          unitPrice: "97.04917", // bond price as % of par
          amount: "5822.95", // correct tel quel amount from broker
          fee: "2.95",
          currency: "EUR",
        },
      ];

      const result = validateActivityImport(testData, testMapping, "test-account", "EUR");

      expect(result.activities).toHaveLength(1);
      const activity = result.activities[0];

      // Amount should be the CSV value, not qty*price
      expect(activity.amount).toBe(5822.95);
      // unitPrice should be derived from amount/quantity (fraction of par)
      expect(activity.unitPrice).toBeCloseTo(5822.95 / 6000, 10);
      expect(activity.quantity).toBe(6000);
      expect(activity.fee).toBe(2.95);
    });

    it("should handle SPLIT activities with amount as the split ratio", () => {
      const testData = [
        {
          lineNumber: "1",
          date: "2024-01-01T00:00:00.000Z",
          symbol: "AAPL",
          activityType: "SPLIT",
          quantity: "",
          unitPrice: "",
          amount: "2",
          fee: "0",
          currency: "USD",
        },
      ];

      const result = validateActivityImport(testData, testMapping, "test-account", "USD");

      expect(result.activities).toHaveLength(1);
      const activity = result.activities[0];

      expect(activity.quantity).toBeUndefined();
      expect(activity.unitPrice).toBeUndefined();
      expect(activity.amount).toBe(2);
      expect(activity.fee).toBe(0);
    });

    it("should handle TRANSFER_IN activities as cash activities", () => {
      const testData = [
        {
          lineNumber: "1",
          date: "2024-01-01T00:00:00.000Z",
          symbol: "CASH:USD",
          activityType: "TRANSFER_IN",
          quantity: "1",
          unitPrice: "1",
          amount: "-500.00", // negative amount
          fee: "0",
          currency: "USD",
        },
      ];

      const result = validateActivityImport(testData, testMapping, "test-account", "USD");

      expect(result.activities).toHaveLength(1);
      const activity = result.activities[0];

      expect(activity.amount).toBe(500.0); // converted to positive
      expect(activity.fee).toBe(0);
    });

    it("should fail non-cash activities without a symbol", () => {
      const testData = [
        {
          lineNumber: "1",
          date: "2024-01-01T00:00:00.000Z",
          symbol: "",
          activityType: "BUY",
          quantity: "1",
          unitPrice: "100",
          amount: "100",
          fee: "0",
          currency: "USD",
        },
      ];

      const result = validateActivityImport(testData, testMapping, "test-account", "USD");

      expect(result.activities).toHaveLength(1);
      const activity = result.activities[0];
      expect(activity.isValid).toBe(false);
      expect(activity.errors?.symbol).toContain("Symbol is required for non-cash activities");
    });

    it("should handle CSV values with currency symbols like real broker exports", () => {
      const testData = [
        {
          lineNumber: "1",
          date: "06/27/2025",
          symbol: "AAPL",
          activityType: "SELL",
          quantity: "25",
          unitPrice: "$48.945",
          amount: "$1223.63",
          fee: "0",
          currency: "USD",
        },
        {
          lineNumber: "2",
          date: "06/20/2025",
          symbol: "AAPL",
          activityType: "BUY",
          quantity: "8",
          unitPrice: "$86.5599",
          amount: "-$692.48",
          fee: "",
          currency: "USD",
        },
      ];

      const result = validateActivityImport(testData, testMapping, "test-account", "USD");

      expect(result.activities).toHaveLength(2);

      // First activity (SELL)
      const sellActivity = result.activities[0];
      expect(sellActivity.quantity).toBe(25);
      expect(sellActivity.unitPrice).toBe(48.945);
      expect(sellActivity.amount).toBe(1223.625); // quantity * unitPrice (25 * 48.945)
      expect(sellActivity.fee).toBe(0);

      // Second activity (BUY)
      const buyActivity = result.activities[1];
      expect(buyActivity.quantity).toBe(8);
      expect(buyActivity.unitPrice).toBe(86.5599);
      expect(buyActivity.amount).toBe(692.4792); // quantity * unitPrice (8 * 86.5599)
      expect(buyActivity.fee).toBe(0);
    });

    it("should not reconcile when qty*price roughly matches CSV amount", () => {
      const testData = [
        {
          lineNumber: "1",
          date: "2024-06-01T00:00:00.000Z",
          symbol: "AAPL",
          activityType: "BUY",
          quantity: "10",
          unitPrice: "150.50",
          amount: "1505.00",
          fee: "5.00",
          currency: "USD",
        },
      ];

      const result = validateActivityImport(testData, testMapping, "test-account", "USD");

      expect(result.activities).toHaveLength(1);
      const activity = result.activities[0];

      // No reconciliation needed — qty*price matches CSV amount
      expect(activity.amount).toBe(1505);
      expect(activity.unitPrice).toBe(150.5);
    });

    it("should handle FEE activities with fee value only (no amount)", () => {
      const testData = [
        {
          lineNumber: "1",
          date: "2024-01-01T00:00:00.000Z",
          symbol: "CASH:USD",
          activityType: "FEE",
          quantity: "",
          unitPrice: "",
          amount: "", // No amount provided
          fee: "$25.00", // Fee provided with currency symbol
          currency: "USD",
        },
      ];

      const result = validateActivityImport(testData, testMapping, "test-account", "USD");

      expect(result.activities).toHaveLength(1);
      const activity = result.activities[0];

      expect(activity.isValid).toBe(true);
      expect(activity.amount).toBe(0); // Amount should be 0 for fee-only activities
      expect(activity.fee).toBe(25.0); // The actual fee value
      expect(activity.errors).toBeUndefined();
    });

    it("should handle FEE activities with both fee and amount", () => {
      const testData = [
        {
          lineNumber: "1",
          date: "2024-01-01T00:00:00.000Z",
          symbol: "CASH:USD",
          activityType: "FEE",
          quantity: "",
          unitPrice: "",
          amount: "$50.00", // Amount provided
          fee: "$5.00", // Fee also provided
          currency: "USD",
        },
      ];

      const result = validateActivityImport(testData, testMapping, "test-account", "USD");

      expect(result.activities).toHaveLength(1);
      const activity = result.activities[0];

      expect(activity.isValid).toBe(true);
      expect(activity.amount).toBe(50.0); // Should use provided amount
      expect(activity.fee).toBe(5.0); // Should use provided fee
      expect(activity.errors).toBeUndefined();
    });
  });

  describe("validateActivityImport with instrument types", () => {
    const baseMapping = {
      accountId: "test-account",
      importType: ImportType.ACTIVITY,
      name: "Test Mapping",
      fieldMappings: {
        [ImportFormat.DATE]: "date",
        [ImportFormat.SYMBOL]: "symbol",
        [ImportFormat.ACTIVITY_TYPE]: "activityType",
        [ImportFormat.QUANTITY]: "quantity",
        [ImportFormat.UNIT_PRICE]: "unitPrice",
        [ImportFormat.AMOUNT]: "amount",
        [ImportFormat.FEE]: "fee",
        [ImportFormat.CURRENCY]: "currency",
        [ImportFormat.INSTRUMENT_TYPE]: "instrumentType",
      },
      activityMappings: {
        [ActivityType.BUY]: ["BUY"],
        [ActivityType.SELL]: ["SELL"],
      },
      symbolMappings: {},
      accountMappings: {},
    };

    const mappingWithoutInstrumentType = {
      ...baseMapping,
      fieldMappings: Object.fromEntries(
        Object.entries(baseMapping.fieldMappings).filter(
          ([key]) => key !== ImportFormat.INSTRUMENT_TYPE,
        ),
      ),
    };

    it("should parse BOND instrument type from CSV column", () => {
      const testData = [
        {
          lineNumber: "1",
          date: "2024-06-01T00:00:00.000Z",
          symbol: "US912828ZT58",
          activityType: "BUY",
          quantity: "10",
          unitPrice: "99.50",
          amount: "995.00",
          fee: "0",
          currency: "USD",
          instrumentType: "BOND",
        },
      ];

      const result = validateActivityImport(testData, baseMapping, "test-account", "USD");

      expect(result.activities).toHaveLength(1);
      expect(result.activities[0].instrumentType).toBe("BOND");
      expect(result.activities[0].symbol).toBe("US912828ZT58");
      expect(result.activities[0].isValid).toBe(true);
    });

    it("should normalize bond aliases from CSV column", () => {
      for (const alias of ["FIXEDINCOME", "FIXED_INCOME", "DEBT", "Fixed Income"]) {
        const testData = [
          {
            lineNumber: "1",
            date: "2024-06-01T00:00:00.000Z",
            symbol: "US912828ZT58",
            activityType: "BUY",
            quantity: "10",
            unitPrice: "99.50",
            amount: "995.00",
            fee: "0",
            currency: "USD",
            instrumentType: alias,
          },
        ];

        const result = validateActivityImport(testData, baseMapping, "test-account", "USD");

        expect(result.activities[0].instrumentType).toBe("BOND");
      }
    });

    it("should parse OPTION instrument type from CSV column", () => {
      const testData = [
        {
          lineNumber: "1",
          date: "2026-03-01T00:00:00.000Z",
          symbol: "AAPL260918C00200000",
          activityType: "BUY",
          quantity: "1",
          unitPrice: "5.50",
          amount: "550.00",
          fee: "0.65",
          currency: "USD",
          instrumentType: "OPTION",
        },
      ];

      const result = validateActivityImport(testData, baseMapping, "test-account", "USD");

      expect(result.activities).toHaveLength(1);
      expect(result.activities[0].instrumentType).toBe("OPTION");
      expect(result.activities[0].symbol).toBe("AAPL260918C00200000");
      expect(result.activities[0].isValid).toBe(true);
    });

    it("should extract instrument type from bond: prefix when no column mapped", () => {
      const testData = [
        {
          lineNumber: "1",
          date: "2024-06-01T00:00:00.000Z",
          symbol: "bond:US912828ZT58",
          activityType: "BUY",
          quantity: "10",
          unitPrice: "99.50",
          amount: "995.00",
          fee: "0",
          currency: "USD",
        },
      ];

      const result = validateActivityImport(
        testData,
        mappingWithoutInstrumentType,
        "test-account",
        "USD",
      );

      expect(result.activities).toHaveLength(1);
      expect(result.activities[0].instrumentType).toBe("BOND");
      expect(result.activities[0].symbol).toBe("US912828ZT58");
    });

    it("should extract instrument type from option: prefix when no column mapped", () => {
      const testData = [
        {
          lineNumber: "1",
          date: "2026-03-01T00:00:00.000Z",
          symbol: "option:AAPL260918C00200000",
          activityType: "BUY",
          quantity: "1",
          unitPrice: "5.50",
          amount: "550.00",
          fee: "0.65",
          currency: "USD",
        },
      ];

      const result = validateActivityImport(
        testData,
        mappingWithoutInstrumentType,
        "test-account",
        "USD",
      );

      expect(result.activities).toHaveLength(1);
      expect(result.activities[0].instrumentType).toBe("OPTION");
      expect(result.activities[0].symbol).toBe("AAPL260918C00200000");
    });

    it("should prefer CSV column over typed prefix", () => {
      const testData = [
        {
          lineNumber: "1",
          date: "2024-06-01T00:00:00.000Z",
          symbol: "option:AAPL260918C00200000",
          activityType: "BUY",
          quantity: "1",
          unitPrice: "5.50",
          amount: "550.00",
          fee: "0",
          currency: "USD",
          instrumentType: "EQUITY",
        },
      ];

      const result = validateActivityImport(testData, baseMapping, "test-account", "USD");

      expect(result.activities).toHaveLength(1);
      // CSV column value takes precedence over prefix
      expect(result.activities[0].instrumentType).toBe("EQUITY");
    });

    it("should parse METAL instrument type from CSV column", () => {
      const testData = [
        {
          lineNumber: "1",
          date: "2024-06-01T00:00:00.000Z",
          symbol: "XAUUSD",
          activityType: "BUY",
          quantity: "1",
          unitPrice: "2350.00",
          amount: "2350.00",
          fee: "0",
          currency: "USD",
          instrumentType: "METAL",
        },
      ];

      const result = validateActivityImport(testData, baseMapping, "test-account", "USD");

      expect(result.activities).toHaveLength(1);
      expect(result.activities[0].instrumentType).toBe("METAL");
      expect(result.activities[0].isValid).toBe(true);
    });

    it("should handle rows with no instrument type gracefully", () => {
      const testData = [
        {
          lineNumber: "1",
          date: "2024-06-01T00:00:00.000Z",
          symbol: "AAPL",
          activityType: "BUY",
          quantity: "10",
          unitPrice: "190.00",
          amount: "1900.00",
          fee: "0",
          currency: "USD",
        },
      ];

      const result = validateActivityImport(
        testData,
        mappingWithoutInstrumentType,
        "test-account",
        "USD",
      );

      expect(result.activities).toHaveLength(1);
      expect(result.activities[0].instrumentType).toBeUndefined();
      expect(result.activities[0].isValid).toBe(true);
    });
  });
});
