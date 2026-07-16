export type ProviderOverrideType = "equity_symbol" | "crypto_symbol" | "fx_symbol" | "bond_isin";

export interface ProviderOverrideConfig {
  provider: string;
  symbol: string;
}

export function getOverrideTypeForInstrumentType(
  instrumentType: string | null | undefined,
): ProviderOverrideType {
  switch (instrumentType) {
    case "BOND":
      return "bond_isin";
    case "CRYPTO":
    case "CRYPTOCURRENCY":
      return "crypto_symbol";
    case "FX":
      return "fx_symbol";
    default:
      return "equity_symbol";
  }
}

export function serializeProviderConfig(
  preferredProvider: string | undefined,
  overrides: ProviderOverrideConfig[],
  instrumentType: string | null | undefined,
): Record<string, unknown> | null {
  const overrideType = getOverrideTypeForInstrumentType(instrumentType);
  const overridesMap: Record<string, unknown> = {};
  for (const override of overrides ?? []) {
    if (override.provider && override.symbol) {
      overridesMap[override.provider] =
        overrideType === "bond_isin"
          ? { type: overrideType, isin: override.symbol }
          : { type: overrideType, symbol: override.symbol };
    }
  }
  const hasOverrides = Object.keys(overridesMap).length > 0;

  let actualProvider = preferredProvider;
  let customProviderCode: string | undefined;
  if (preferredProvider?.startsWith("CUSTOM:")) {
    actualProvider = "CUSTOM_SCRAPER";
    customProviderCode = preferredProvider.slice("CUSTOM:".length);
  }

  const hasPref = !!actualProvider;
  if (!hasOverrides && !hasPref) return null;
  const result: Record<string, unknown> = {};
  if (hasPref) result.preferred_provider = actualProvider;
  if (customProviderCode) result.custom_provider_code = customProviderCode;
  if (hasOverrides) result.overrides = overridesMap;
  return result;
}
