import type { AssetResolutionInput, QuoteMode, SymbolSearchResult } from "./types";
import { quoteModeFromSearchResult } from "./asset-utils";

export function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function buildAssetResolutionInput(input: {
  id?: unknown;
  symbol?: unknown;
  exchangeMic?: unknown;
  kind?: unknown;
  name?: unknown;
  quoteMode?: unknown;
  quoteCcy?: unknown;
  instrumentType?: unknown;
  providerId?: unknown;
  providerSymbol?: unknown;
}): AssetResolutionInput | undefined {
  const asset: AssetResolutionInput = {
    id: normalizeOptionalString(input.id),
    symbol: normalizeOptionalString(input.symbol),
    exchangeMic: normalizeOptionalString(input.exchangeMic),
    kind: normalizeOptionalString(input.kind),
    name: normalizeOptionalString(input.name),
    quoteMode: normalizeOptionalString(input.quoteMode) as QuoteMode | undefined,
    quoteCcy: normalizeOptionalString(input.quoteCcy),
    instrumentType: normalizeOptionalString(input.instrumentType),
    providerId: normalizeOptionalString(input.providerId),
    providerSymbol: normalizeOptionalString(input.providerSymbol),
  };

  return Object.values(asset).some((value) => value !== undefined) ? asset : undefined;
}

export function buildAssetResolutionInputFromSearchResult(
  result: SymbolSearchResult,
  symbol: string = result.canonicalSymbol ?? result.symbol,
): AssetResolutionInput {
  return {
    id: normalizeOptionalString(result.existingAssetId),
    symbol: normalizeOptionalString(symbol),
    exchangeMic: normalizeOptionalString(result.canonicalExchangeMic ?? result.exchangeMic),
    kind: normalizeOptionalString(result.assetKind),
    name: normalizeOptionalString(result.longName) ?? normalizeOptionalString(result.shortName),
    quoteMode: quoteModeFromSearchResult(result),
    quoteCcy: normalizeOptionalString(result.currency),
    instrumentType: normalizeOptionalString(result.quoteType),
    providerId: normalizeOptionalString(result.providerId),
    providerSymbol: normalizeOptionalString(result.providerSymbol),
  };
}
