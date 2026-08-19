import type { FormattingApi } from "@wealthfolio/ui";

/**
 * OCC (Options Clearing Corporation) symbol parser.
 *
 * Format: {underlying}{YYMMDD}{C|P}{strike×1000 as 8 digits}
 * Example: "AAPL240119C00195000" → AAPL, 2024-01-19, Call, $195.00
 */

export interface ParsedOccSymbol {
  underlying: string;
  expiration: string; // ISO date YYYY-MM-DD
  optionType: "CALL" | "PUT";
  strikePrice: number;
}

export function formatOptionExpiration(
  expiration: string,
  formatting: Pick<FormattingApi, "formatCalendarDate">,
): string {
  return formatting.formatCalendarDate(expiration, {
    month: "short",
    day: "numeric",
  });
}

export function formatOptionSubtitle(
  option: ParsedOccSymbol,
  formatting: Pick<FormattingApi, "formatCalendarDate" | "formatDecimal">,
): string {
  const expiration = formatOptionExpiration(option.expiration, formatting);
  const strike = formatting.formatDecimal(option.strikePrice, {
    maximumFractionDigits: 3,
  });
  return `${expiration} $${strike} ${option.optionType}`;
}

/**
 * Parse an OCC option symbol into its components.
 * Returns null if the symbol is not a valid OCC symbol.
 */
export function parseOccSymbol(symbol: string): ParsedOccSymbol | null {
  const s = symbol.trim();
  const len = s.length;

  if (len < 15 || len > 21) return null;

  // Fixed-length fields from the end
  const strikeStr = s.slice(len - 8);
  const typeChar = s[len - 9];
  const dateStr = s.slice(len - 15, len - 9);
  const underlying = s.slice(0, len - 15).trim();

  if (!underlying) return null;

  // Validate date portion (all digits)
  if (!/^\d{6}$/.test(dateStr)) return null;

  // Validate option type
  const upper = typeChar.toUpperCase();
  if (upper !== "C" && upper !== "P") return null;

  // Validate strike (all digits)
  if (!/^\d{8}$/.test(strikeStr)) return null;

  // Parse date
  const year = 2000 + parseInt(dateStr.slice(0, 2), 10);
  const month = parseInt(dateStr.slice(2, 4), 10);
  const day = parseInt(dateStr.slice(4, 6), 10);

  // Date validation: construct a Date and verify components match (catches invalid dates like Feb 30)
  const dateCheck = new Date(year, month - 1, day);
  if (dateCheck.getMonth() !== month - 1 || dateCheck.getDate() !== day) return null;

  const expiration = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  // Parse strike: 5 integer + 3 decimal digits → divide by 1000
  const strikePrice = parseInt(strikeStr, 10) / 1000;

  return {
    underlying: underlying.toUpperCase(),
    expiration,
    optionType: upper === "C" ? "CALL" : "PUT",
    strikePrice,
  };
}

/**
 * Build an OCC symbol from components.
 * Format: {UNDERLYING}{YYMMDD}{C|P}{strike×1000 padded to 8 digits}
 */
export function buildOccSymbol(
  underlying: string,
  expiration: string,
  optionType: "CALL" | "PUT",
  strikePrice: number,
): string {
  const sym = underlying.toUpperCase();
  const yymmdd = expiration.slice(2, 4) + expiration.slice(5, 7) + expiration.slice(8, 10);
  const typeChar = optionType === "CALL" ? "C" : "P";
  const strike = String(Math.round(strikePrice * 1000)).padStart(8, "0");
  return `${sym}${yymmdd}${typeChar}${strike}`;
}

/**
 * Normalize a compact broker option symbol (e.g. Fidelity's "-MU270115C600")
 * into standard OCC format ("MU270115C00600000").
 * Returns null if the symbol doesn't match the compact pattern or is already standard OCC.
 */
export function normalizeOptionSymbol(symbol: string): string | null {
  let s = symbol.trim();
  if (s.startsWith("-")) s = s.slice(1);
  if (!s) return null;

  // Already standard OCC? Leave it alone.
  if (looksLikeOccSymbol(s)) return null;

  // Find boundary: alpha prefix → digits
  const re = /^([A-Za-z]+)(\d{6})([CPcp])(\d+)$/;
  const result = re.exec(s);
  if (!result) return null;

  const [, underlying, dateStr, typeChar, strikeStr] = result;

  // Date validation (reject impossible dates like Feb 30)
  const year = parseInt(dateStr.slice(0, 2), 10);
  const month = parseInt(dateStr.slice(2, 4), 10);
  const day = parseInt(dateStr.slice(4, 6), 10);
  const dateCheck = new Date(2000 + year, month - 1, day);
  if (dateCheck.getMonth() !== month - 1 || dateCheck.getDate() !== day) return null;

  // Strike: plain integer dollars → ×1000, pad to 8 digits
  const strikeScaled = parseInt(strikeStr, 10) * 1000;
  const strikePadded = String(strikeScaled).padStart(8, "0");
  if (strikePadded.length > 8) return null;

  return `${underlying.toUpperCase()}${dateStr}${typeChar.toUpperCase()}${strikePadded}`;
}

/**
 * Returns true if the symbol parses as an OCC option whose expiration date is in the past.
 */
export function isExpiredOptionSymbol(symbol: string): boolean {
  const parsed = parseOccSymbol(symbol);
  if (!parsed) return false;
  const today = new Date().toISOString().split("T")[0];
  return parsed.expiration < today;
}

/**
 * Heuristic check if a symbol looks like an OCC option symbol.
 * Does not fully validate — use parseOccSymbol for that.
 */
export function looksLikeOccSymbol(symbol: string): boolean {
  const s = symbol.trim();
  const len = s.length;

  if (len < 15 || len > 21) return false;

  const typeChar = s[len - 9]?.toUpperCase();
  if (typeChar !== "C" && typeChar !== "P") return false;

  // Strike (last 8) must be digits
  if (!/^\d{8}$/.test(s.slice(len - 8))) return false;

  // Date (6 chars before type) must be digits
  if (!/^\d{6}$/.test(s.slice(len - 15, len - 9))) return false;

  return true;
}
