import { describe, expect, it } from "vitest";
import { formatPrice } from "@wealthfolio/ui";

import { formatAmount, normalizeCurrency } from "./utils";

describe("currency utilities", () => {
  it("does not treat GBP as the GBp quote unit", () => {
    expect(normalizeCurrency("GBP")).toBe("GBP");
    expect(normalizeCurrency("gbp")).toBe("GBP");
    expect(formatAmount(12.34, "GBP")).toBe("£12.34");
  });

  it("normalizes and formats quote units", () => {
    expect(normalizeCurrency("GBp")).toBe("GBP");
    expect(normalizeCurrency("gbx")).toBe("GBP");
    expect(normalizeCurrency("ILA")).toBe("ILS");
    expect(normalizeCurrency("USX")).toBe("USD");
    expect(normalizeCurrency("ZAC")).toBe("ZAR");

    expect(formatAmount(12.34, "GBp")).toBe("12.34p");
    expect(formatAmount(12.34, "ILA")).toBe("12.34ag");
  });

  it("preserves meaningful precision for per-unit prices", () => {
    expect(formatPrice(1.4018, "CNY")).toBe("CN¥1.4018");
    expect(formatPrice(12, "USD")).toBe("$12.00");
    expect(formatPrice(268.3999939, "USD")).toBe("$268.40");
    expect(formatPrice(0.00012345, "USD", false)).toBe("0.00012345");
    expect(formatPrice(-0.000000001, "USD", false)).toBe("0.00");
    expect(formatPrice(1.4018, "GBp")).toBe("1.4018p");
  });
});
