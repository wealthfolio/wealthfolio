import { describe, expect, it } from "vitest";
import { getOverrideTypeForInstrumentType, serializeProviderConfig } from "./asset-provider-config";

describe("asset provider config", () => {
  it("serializes bond overrides as bond ISIN mappings", () => {
    expect(
      serializeProviderConfig(
        "BOERSE_FRANKFURT",
        [{ provider: "BOERSE_FRANKFURT", symbol: "IT0005415291" }],
        "BOND",
      ),
    ).toEqual({
      preferred_provider: "BOERSE_FRANKFURT",
      overrides: {
        BOERSE_FRANKFURT: {
          type: "bond_isin",
          isin: "IT0005415291",
        },
      },
    });
  });

  it("maps market instrument types to provider override variants", () => {
    expect(getOverrideTypeForInstrumentType("BOND")).toBe("bond_isin");
    expect(getOverrideTypeForInstrumentType("CRYPTO")).toBe("crypto_symbol");
    expect(getOverrideTypeForInstrumentType("CRYPTOCURRENCY")).toBe("crypto_symbol");
    expect(getOverrideTypeForInstrumentType("FX")).toBe("fx_symbol");
    expect(getOverrideTypeForInstrumentType("EQUITY")).toBe("equity_symbol");
    expect(getOverrideTypeForInstrumentType("OPTION")).toBe("equity_symbol");
  });
});
