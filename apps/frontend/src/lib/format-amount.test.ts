import { formatAmount } from "@wealthfolio/ui";
import { describe, expect, it } from "vitest";

describe("formatAmount", () => {
  it("formats integer with default 2 decimals", () => {
    expect(formatAmount(1234, "USD")).toBe("$1,234.00");
  });

  it("rounds to 2 decimals by default", () => {
    expect(formatAmount(1234.5678, "USD")).toBe("$1,234.57");
  });

  it("shows exactly 4 decimals when precision=4", () => {
    expect(formatAmount(0.9192, "USD", false, 4)).toBe("0.9192");
  });

  it("pads trailing zeros when precision=4 (columns align)", () => {
    expect(formatAmount(0.92, "USD", false, 4)).toBe("0.9200");
  });

  it("pads with zeros for a 3-decimal value at precision=4", () => {
    expect(formatAmount(0.918, "USD", false, 4)).toBe("0.9180");
  });

  it("returns - for null", () => {
    expect(formatAmount(null, "USD")).toBe("-");
  });
});
