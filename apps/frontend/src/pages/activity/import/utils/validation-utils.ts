import { looksLikeIsin, parseIsin } from "@/lib/isin";
import { looksLikeOccSymbol, normalizeOptionSymbol } from "@/lib/occ-symbol";
import { findMappedActivityType } from "./activity-type-mapping";
import { splitInstrumentPrefixedSymbol } from "./instrument-type";

// Full symbol is bounded to 100 characters by the leading lookahead.
const tickerRegex = /^(?=.{1,100}$)(CASH:[A-Z]{3}|[A-Z0-9_]+([.-][A-Z0-9_]+){0,2})$/;
const cusipRegex = /^[A-Z0-9]{8}\d$/;

export function validateTickerSymbol(symbol: string): boolean {
  const { symbol: strippedSymbol } = splitInstrumentPrefixedSymbol(symbol);
  const normalized = (strippedSymbol || "").trim();
  const upper = normalized.toUpperCase();
  if (!normalized) return false;

  return (
    tickerRegex.test(upper) ||
    looksLikeOccSymbol(normalized) ||
    normalizeOptionSymbol(normalized) !== null ||
    looksLikeIsin(normalized) ||
    cusipRegex.test(upper)
  );
}

/**
 * The ISIN to resolve a row's asset by when its Symbol value isn't a symbol, such as
 * a fund name, but its ISIN column holds a valid ISIN. Undefined otherwise, including
 * when Symbol is blank or already a valid symbol.
 */
export function isinFallbackSymbol(
  symbol: string | undefined,
  isin: string | undefined,
): string | undefined {
  const trimmedSymbol = symbol?.trim();
  if (!trimmedSymbol || !isin || validateTickerSymbol(trimmedSymbol)) return undefined;
  return parseIsin(isin) ? isin.trim().toUpperCase() : undefined;
}

export { findMappedActivityType };
