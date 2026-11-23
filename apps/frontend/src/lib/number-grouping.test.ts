import { createAmountFormatting, createFormatter, FORMATTING_REGIONS } from "@wealthfolio/ui";
import { describe, expect, it } from "vitest";

const regionalDecimals = [
  ["CA", "8,765.43"],
  ["US", "8,765.43"],
  ["GB", "8,765.43"],
  ["IN", "8,765.43"],
  ["FR", "8\u202f765,43"],
  ["DE", "8.765,43"],
  ["AT", "8\u00a0765,43"],
  ["CH", "8'765.43"],
  ["ES", "8.765,43"],
  ["MX", "8,765.43"],
  ["BR", "8.765,43"],
  ["PT", "8\u00a0765,43"],
  ["CN", "8,765.43"],
  ["TW", "8,765.43"],
  ["JP", "8,765.43"],
  ["KR", "8,765.43"],
  ["IT", "8.765,43"],
  ["RO", "8.765,43"],
  ["BG", "8\u00a0765,43"],
] as const;

describe("display number grouping", () => {
  it("covers every selectable formatting region", () => {
    expect(regionalDecimals.map(([region]) => region)).toEqual(
      FORMATTING_REGIONS.filter((region) => region !== "system"),
    );
  });

  it.each(regionalDecimals)("groups four-digit displays in %s", (region, expected) => {
    const formatting = createFormatter(region);
    expect(formatting.formatDecimal(8765.43)).toBe(expected);
    expect(formatting.formatDecimal(8765.43, { maximumFractionDigits: 2 })).toBe(expected);
    expect(formatting.formatDecimalAmount(8765.43, "EUR")).toBe(expected);
    expect(formatting.formatDecimalAmount(8765.43, "EUR", { maximumFractionDigits: 2 })).toBe(
      expected,
    );
    expect(formatting.formatAmount(8765.43, "EUR", false)).toBe(expected);
    expect(formatting.formatPrice(8765.43, "EUR", false)).toBe(expected);
    expect(formatting.formatQuantity(8765.43)).toBe(expected);
  });

  it("groups Spanish amounts, prices, percentages and rounding boundaries", () => {
    const formatting = createFormatter("ES");
    expect(formatting.formatDecimal(999)).toBe("999");
    expect(formatting.formatDecimal(1000)).toBe("1.000");
    expect(formatting.formatDecimal(-8765)).toBe("-8.765");
    expect(formatting.formatDecimal(10500)).toBe("10.500");
    expect(formatting.formatAmount(8765.43, "EUR")).toBe("8.765,43\u00a0€");
    expect(formatting.formatPrice(8765.4321, "EUR")).toBe("8.765,4321\u00a0€");
    expect(formatting.formatPercent(87.6543)).toBe("8.765,43\u00a0%");
    expect(formatting.formatRoundedAmount(999.6, "EUR")).toBe("1.000\u00a0€");
    expect(formatting.formatRoundedAmount(8765.43, "EUR")).toBe("8.765\u00a0€");
    expect(formatting.formatDecimalAmount(8765.43, "EUR", { maximumFractionDigits: 0 })).toBe(
      "8.765",
    );
    expect(formatting.formatAmount(8765.43, "GBp")).toBe("8.765,43p");
    expect(formatting.formatPrice(8765.43, "GBp")).toBe("8.765,43p");
    expect(formatting.formatRoundedAmount(8765.43, "GBp")).toBe("8.765p");
    expect(formatting.formatAmount(8765.43, "invalid")).toBe("8.765,43 invalid");
  });

  it("preserves explicit grouping choices for input and other callers", () => {
    const formatting = createFormatter("ES");
    expect(formatting.formatDecimal(8765.43, { useGrouping: false })).toBe("8765,43");
    expect(formatting.formatDecimal(8765.43, { useGrouping: true })).toBe("8.765,43");
    expect(formatting.formatDecimal(8765.43, { useGrouping: undefined })).toBe("8.765,43");
    expect(formatting.parseNumber("8.765,43")).toBe(8765.43);
  });

  it.each(["en-US", "fr-FR", "es-ES"])("preserves compact grouping in %s", (locale) => {
    const formatting = createFormatter(locale);
    const value = 1e15;
    expect(formatting.formatDecimal(value, { notation: "compact" })).toBe(
      new Intl.NumberFormat(locale, { notation: "compact" }).format(value),
    );
    expect(formatting.formatCompactAmount(value, "EUR", false)).toBe(
      new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 2 }).format(
        value,
      ),
    );
    expect(formatting.formatCompactAmount(value, "EUR")).toBe(
      new Intl.NumberFormat(locale, {
        style: "currency",
        currency: "EUR",
        notation: "compact",
        maximumFractionDigits: 2,
      }).format(value),
    );
  });

  it("applies each currency's region and preserves Indian grouping", () => {
    const formatting = createAmountFormatting("US", undefined, { EUR: "ES", INR: "IN" });
    expect(formatting.formatAmount(8765.43, "EUR")).toBe("8.765,43\u00a0€");
    expect(formatting.formatAmount(8765.43, "USD")).toBe("$8,765.43");
    expect(formatting.formatAmount(1234567.89, "INR")).toBe("₹12,34,567.89");
  });
});
