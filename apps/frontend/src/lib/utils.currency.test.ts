import { describe, expect, it } from "vitest";

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
});
