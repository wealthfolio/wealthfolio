import type { SymbolSearchResult } from "./types";
import { DataSource, QuoteMode } from "./constants";

/**
 * Common crypto symbols for heuristic detection
 */
const COMMON_CRYPTO_SYMBOLS = new Set([
  "BTC",
  "ETH",
  "XRP",
  "SOL",
  "ADA",
  "DOGE",
  "DOT",
  "MATIC",
  "LTC",
  "AVAX",
  "LINK",
  "UNI",
  "ATOM",
  "XLM",
  "ALGO",
]);

export function quoteModeFromSearchResult(
  searchResult: Pick<SymbolSearchResult, "quoteMode" | "dataSource"> | undefined,
): QuoteMode {
  const explicitMode = searchResult?.quoteMode?.trim().toUpperCase();
  if (explicitMode === QuoteMode.MANUAL) return QuoteMode.MANUAL;
  if (explicitMode === QuoteMode.MARKET) return QuoteMode.MARKET;
  return searchResult?.dataSource === DataSource.MANUAL ? QuoteMode.MANUAL : QuoteMode.MARKET;
}

export function isManualSearchResult(
  searchResult: Pick<SymbolSearchResult, "quoteMode" | "dataSource"> | undefined,
): boolean {
  return quoteModeFromSearchResult(searchResult) === QuoteMode.MANUAL;
}

export function stripCryptoQuoteSuffix(symbol: string, currencyHint?: string): string {
  const trimmed = symbol.trim().toUpperCase();
  const match = /^(.*)-([A-Z]{3,5})$/.exec(trimmed);
  if (!match) return trimmed;
  const base = match[1]?.trim();
  const quote = match[2]?.trim().toUpperCase();
  const hint = currencyHint?.trim().toUpperCase();
  if (hint && quote !== hint) {
    return trimmed;
  }
  return base || trimmed;
}

/**
 * Infers whether a search result is equity, crypto, or other.
 * Used for UI hints (e.g., which form fields to show).
 * NOT used for asset ID generation — the backend assigns opaque UUIDs.
 */
export function inferInstrumentType(
  symbol: string,
  quoteType?: string,
  assetKind?: string,
  exchangeMic?: string,
): "EQUITY" | "CRYPTO" | "OTHER" {
  if (assetKind) {
    const upper = assetKind.toUpperCase();
    if (upper === "SECURITY" || upper === "EQUITY" || upper === "INVESTMENT") return "EQUITY";
    if (upper === "CRYPTO" || upper === "CRYPTOCURRENCY") return "CRYPTO";
    if (upper === "OTHER" || upper === "ALT") return "OTHER";
  }

  if (quoteType) {
    const upper = quoteType.toUpperCase();
    if (upper === "CRYPTOCURRENCY" || upper === "CRYPTO") return "CRYPTO";
    if (upper === "EQUITY" || upper === "ETF" || upper === "INDEX") return "EQUITY";
  }

  if (exchangeMic) {
    return "EQUITY";
  }

  const normalizedSymbol = symbol.trim().toUpperCase();
  if (COMMON_CRYPTO_SYMBOLS.has(normalizedSymbol)) {
    return "CRYPTO";
  }

  if (normalizedSymbol.includes("-USD") || normalizedSymbol.includes("-EUR")) {
    return "CRYPTO";
  }

  return "EQUITY";
}

/**
 * Gets the asset ID from a symbol search result.
 * With opaque UUIDs, the backend provides the ID via existingAssetId.
 * Falls back to a legacy prefix-based ID for backward compatibility.
 */
export function getAssetIdFromSearchResult(
  searchResult: SymbolSearchResult,
  defaultCurrency: string,
): string {
  // Prefer the backend-assigned UUID
  if (searchResult.existingAssetId) {
    return searchResult.existingAssetId;
  }

  // Legacy fallback: build a prefix-based ID for assets not yet in the DB
  const currency = searchResult.currency ?? defaultCurrency;
  const identitySymbol = (searchResult.canonicalSymbol || searchResult.symbol).trim().toUpperCase();
  const identityExchangeMic = searchResult.canonicalExchangeMic || searchResult.exchangeMic;
  const type = inferInstrumentType(
    identitySymbol,
    searchResult.quoteType,
    searchResult.assetKind,
    identityExchangeMic,
  );

  switch (type) {
    case "CRYPTO": {
      const normalizedCurrency = currency.trim().toUpperCase();
      const normalizedSymbol = stripCryptoQuoteSuffix(identitySymbol, normalizedCurrency);
      return `CRYPTO:${normalizedSymbol}:${normalizedCurrency}`;
    }
    case "EQUITY":
    default: {
      const mic = identityExchangeMic?.trim().toUpperCase() || "INDEX";
      return `SEC:${identitySymbol}:${mic}`;
    }
  }
}

// Legacy aliases for backward compatibility
export const buildSecurityAssetId = (symbol: string, exchangeMic?: string): string => {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const mic = exchangeMic?.trim().toUpperCase() || "INDEX";
  return `SEC:${normalizedSymbol}:${mic}`;
};

export const buildCryptoAssetId = (symbol: string, quoteCurrency: string): string => {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const normalizedCurrency = quoteCurrency.trim().toUpperCase();
  return `CRYPTO:${normalizedSymbol}:${normalizedCurrency}`;
};

export const buildCanonicalAssetId = getAssetIdFromSearchResult;
export const inferAssetKind = inferInstrumentType;

/**
 * Determines if a symbol represents an index (starts with ^ or ends with exchange suffix like .SS)
 */
export function isIndexSymbol(symbol: string): boolean {
  return symbol.startsWith("^") || /\.\w{2}$/.test(symbol);
}
