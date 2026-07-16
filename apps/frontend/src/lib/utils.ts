import { logger } from "@/adapters";
import { type ClassValue, clsx } from "clsx";
import { format, isValid, parse, parseISO } from "date-fns";
import { twMerge } from "tailwind-merge";
import { getQuoteUnitCurrency } from "@wealthfolio/ui/lib/currencies";
import { DECIMAL_PRECISION, DISPLAY_DECIMAL_PRECISION } from "./constants";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Attempts to parse a date string in multiple formats using date-fns
 * @param dateStr The date string to parse
 * @returns A valid Date object if parsing succeeds, null if all parsing attempts fail
 */
export function tryParseDate(dateStr: string): Date | null {
  if (!dateStr) return null;

  // Standardize the input - replace multiple spaces with single space and trim
  const cleaned = dateStr.replace(/\s+/g, " ").trim().toUpperCase();

  // First try ISO parsing since it's most common
  try {
    const isoDate = parseISO(cleaned);
    if (isValid(isoDate) && isDateInRange(isoDate)) {
      return isoDate;
    }
  } catch {}

  // Array of date format patterns to try
  const formatPatterns = [
    // Standard ISO 8601 UTC
    "yyyy-MM-dd'T'HH:mm:ss'Z'", // Added Standard ISO format
    "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", // Added Standard ISO format with milliseconds
    "yyyy-MM-dd'T'HH:mm:ss.SSSSSSXXX", // Added Standard ISO timestamp with microsecond precision and timezone offset

    // 12-hour / AM-PM Formats (e.g. Questrade exports). Only the unambiguous
    // ISO date order is auto-detected; slash orders (MM/dd vs dd/MM) are
    // ambiguous and must be chosen explicitly via an import format preset.
    "yyyy-MM-dd hh:mm:ss a", // "2024-05-01 12:00:00 AM"
    "yyyy-MM-dd hh:mm a", // "2024-05-01 12:00 AM"

    // ISO and Technical Formats
    "yyyy-MM-dd", // "2024-05-01" - ISO 8601
    "yyyyMMdd", // "20240501" - Compact ISO
    "yyyy/MM/dd", // "2024/05/01" - Modified ISO
    "yyyy.MM.dd", // "2024.05.01" - Modified ISO

    // North American Banking Formats
    "MMM dd yyyy", // "MAY 01 2024" - Common in North American banks
    "MMMM dd yyyy", // "MAY 01 2024" (full month)
    "MMM-dd-yyyy", // "MAY-01-2024" - Month name with separators
    "MMMM-dd-yyyy", // "MAY-01-2024" (full month)
    "MM/dd/yyyy", // "05/01/2024" - US Standard
    "M/d/yyyy", // "5/1/2024" - US Relaxed

    // European Banking Formats
    "dd/MM/yyyy", // "01/05/2024" - UK/EU Standard
    "d/M/yyyy", // "1/5/2024" - UK/EU Relaxed
    "dd.MM.yyyy", // "01.05.2024" - German/Swiss/Russian
    "d.M.yyyy", // "1.5.2024" - German/Swiss Relaxed
    "dd-MM-yyyy", // "01-05-2024" - Dutch/Danish

    // Asian Banking Formats
    "yyyy年MM月dd日", // "2024年05月01日" - Japanese
    "yyyy년MM월dd일", // "2024년05월01일" - Korean
    "yyyy年M月d日", // "2024年5月1日" - Chinese Traditional

    // Common Text Formats
    "MMMM d, yyyy", // "May 1, 2024" - US Formal
    "MMM d, yyyy", // "May 1, 2024" - US Common
    "d MMM yyyy", // "1 May 2024" - UK Common
    "dd MMM yyyy", // "01 May 2024" - UK Formal
    "d MMMM yyyy", // "1 May 2024" - UK Extended
    "dd MMMM yyyy", // "01 May 2024" - UK Extended Formal

    // Additional Banking Formats
    "dd-MMM-yyyy", // "01-MAY-2024" - Legacy Banking
    "ddMMMyyyy", // "01MAY2024" - Swift/Wire
    "dd MMM yy", // "01 MAY 24" - Short Year
    "MMM dd, yy", // "MAY 01, 24" - US Short

    // Fiscal Year Formats
    "MMM dd FY yyyy", // "MAY 01 FY 2024"
    "dd MMM FY yyyy", // "01 MAY FY 2024"

    // Quarter Formats
    "Qn yyyy", // "Q2 2024"
    "yyyy-Qn", // "2024-Q2"
  ];

  // Try each format pattern
  for (const pattern of formatPatterns) {
    try {
      const parsedDate = parse(cleaned, pattern, new Date());
      if (isValid(parsedDate) && isDateInRange(parsedDate)) {
        return parsedDate;
      }
    } catch {}
  }

  // Try Unix timestamp (in seconds or milliseconds)
  const num = parseInt(cleaned);
  if (!isNaN(num)) {
    const timestampDate = new Date(num > 1000000000000 ? num : num * 1000);
    if (isValid(timestampDate) && isDateInRange(timestampDate)) {
      return timestampDate;
    }
  }

  return null;
}

// Helper to check if date is within reasonable range (1900-2100)
function isDateInRange(date: Date): boolean {
  const year = date.getFullYear();
  return year >= 1900 && year <= 2100;
}

export function formatDate(input: string | number | Date | null | undefined): string {
  if (input === null || input === undefined) {
    return "-";
  }

  let date: Date | null = null;

  if (input instanceof Date) {
    date = input;
  } else if (typeof input === "string") {
    if (input.trim() === "") {
      return "-";
    }
    date = tryParseDate(input);
  } else if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      logger.warn(`Invalid number input for date: ${input}`);
      return "-";
    }
    date = new Date(input);
  }

  if (date && isValid(date)) {
    return format(date, "MMM d, yyyy");
  }

  logger.warn(`Failed to format invalid date input: ${String(input)}`);

  if (typeof input === "string") {
    return input;
  }

  return "-";
}

/**
 * Formats a Date to ISO date string (YYYY-MM-DD).
 * @param date The Date object to format
 * @returns ISO date string in YYYY-MM-DD format
 */
export function formatDateISO(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

/**
 * Formats a time as "h:mm a" (e.g. "12:00 AM"). Use when only the time of day
 * is meaningful and the seconds-bearing formatDateTime would be too verbose.
 */
export function formatTime(input: string | number | Date | null | undefined): string {
  if (input === null || input === undefined) return "-";
  let date: Date | null = null;
  if (input instanceof Date) date = input;
  else if (typeof input === "string") date = tryParseDate(input) ?? new Date(input);
  else if (typeof input === "number") date = Number.isFinite(input) ? new Date(input) : null;
  if (date && isValid(date)) return format(date, "h:mm a");
  return "-";
}

export const formatDateTime = (date: string | Date, timezone?: string) => {
  if (!date) return { date: "-", time: "-" };

  let dateObj: Date | null = null;
  if (typeof date === "string") {
    // First attempt with the robust parser
    dateObj = tryParseDate(date);
    // If it fails, try the native Date constructor which is good with ISO date-time strings
    if (!dateObj || !isValid(dateObj)) {
      dateObj = new Date(date);
    }
  } else {
    // It's already a Date object
    dateObj = date;
  }

  // Now validate the final date object
  if (!isValid(dateObj)) {
    logger.warn(`Invalid date input for formatDateTime: ${date}`);
    return { date: "-", time: "-" };
  }

  // Determine the effective timezone: use configured app timezone when valid,
  // otherwise fall back to the browser timezone.
  const effectiveTimezone = resolveDisplayTimezone(timezone);

  const dateOptions: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: effectiveTimezone,
  };

  const timeOptions: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    timeZone: effectiveTimezone,
  };

  const dateFormatter = new Intl.DateTimeFormat("en-US", dateOptions);
  const timeFormatter = new Intl.DateTimeFormat("en-US", timeOptions);

  return {
    date: dateFormatter.format(dateObj),
    time: timeFormatter.format(dateObj),
  };
};

export function resolveDisplayTimezone(timezone?: string | null): string {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const candidate = timezone?.trim();
  if (!candidate) {
    return fallback;
  }

  try {
    // Validate timezone string before passing it to formatters.
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return fallback;
  }
}

/**
 * Formats a date for use with HTML datetime-local input elements.
 * Returns format: "YYYY-MM-DDTHH:mm" in local timezone.
 * @param date Date string, Date object, or undefined
 * @returns Formatted string suitable for datetime-local input, or empty string if invalid
 */
export function formatDateTimeLocal(date: Date | string | undefined): string {
  if (!date) return "";
  const value = typeof date === "string" ? new Date(date) : date;
  if (!isValid(value)) return "";
  // Format in local timezone for datetime-local input
  return format(value, "yyyy-MM-dd'T'HH:mm");
}

/**
 * Formats a date for display in the UI.
 * Returns format: "YYYY/MM/DD HH:mm" in local timezone.
 * @param date Date string, Date object, or undefined
 * @returns Formatted string for display, or empty string if invalid
 */
export function formatDateTimeDisplay(date: Date | string | undefined): string {
  if (!date) return "";
  const value = typeof date === "string" ? new Date(date) : date;
  if (!isValid(value)) return "";
  // Display format: YYYY/MM/DD HH:mm
  return format(value, "yyyy/MM/dd HH:mm");
}
const DECIMAL_FORMAT_OPTIONS: Intl.NumberFormatOptions = {
  minimumFractionDigits: DISPLAY_DECIMAL_PRECISION,
  maximumFractionDigits: DISPLAY_DECIMAL_PRECISION,
};

const decimalFormatter = new Intl.NumberFormat("en-US", DECIMAL_FORMAT_OPTIONS);
const currencyFormatterCache = new Map<string, Intl.NumberFormat>();

const getCurrencyFormatter = (currency: string) => {
  const normalizedCurrency = currency?.toUpperCase?.() ?? "USD";
  const cacheKey = normalizedCurrency;

  if (currencyFormatterCache.has(cacheKey)) {
    return currencyFormatterCache.get(cacheKey)!;
  }

  let formatter: Intl.NumberFormat;
  try {
    formatter = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: normalizedCurrency,
      ...DECIMAL_FORMAT_OPTIONS,
    });
  } catch {
    formatter = decimalFormatter;
  }

  currencyFormatterCache.set(cacheKey, formatter);
  return formatter;
};

/**
 * Normalizes a minor currency code to its major equivalent.
 * E.g., "GBp" -> "GBP", "ZAc" -> "ZAR"
 * If no normalization rule exists, returns the uppercased input.
 */
export function normalizeCurrency(currency: string | undefined): string | undefined {
  if (!currency) return currency;
  const trimmed = currency.trim();
  return getQuoteUnitCurrency(trimmed)?.major ?? trimmed.toUpperCase();
}

export function formatAmount(
  amount: number | string | null | undefined,
  currency: string,
  displayCurrency = true,
) {
  if (amount == null) return "-";
  const numericAmount = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(numericAmount)) return "-";
  const displayAmount = Math.abs(numericAmount) < 0.005 ? 0 : numericAmount;
  const rawCurrency = currency ?? "USD";
  const quoteUnit = getQuoteUnitCurrency(rawCurrency);

  if (quoteUnit) {
    const formattedNumber = decimalFormatter.format(displayAmount);
    return displayCurrency ? `${formattedNumber}${quoteUnit.symbol}` : formattedNumber;
  }

  if (!displayCurrency) {
    return decimalFormatter.format(displayAmount);
  }

  return getCurrencyFormatter(rawCurrency).format(displayAmount);
}

export function formatPercent(
  value: number | null | undefined,
  options: { digits?: number; signDisplay?: "auto" | "always" | "never" } = {},
) {
  if (value == null) return "-";
  const digits = options.digits ?? 2;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "percent",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      signDisplay: options.signDisplay ?? "auto",
    }).format(value);
  } catch (error) {
    logger.error(`Error formatting percent ${value}: ${error}`);
    return `${value}%`;
  }
}

export function toPascalCase(input: string) {
  return input
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("");
}

export function formatQuantity(quantity: number | string | null | undefined): string {
  if (quantity === null || quantity === undefined) {
    return "-";
  }
  const numQuantity = typeof quantity === "string" ? parseFloat(quantity) : quantity;
  if (!Number.isFinite(numQuantity)) return "-";

  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
    useGrouping: true,
  }).format(numQuantity);
}

/**
 * Safely divides two numbers, returning 0 if the divisor is 0.
 * @param numerator The number to be divided.
 * @param denominator The number to divide by.
 * @returns The result of the division, or 0 if the denominator is 0.
 */
export function safeDivide(numerator: number, denominator: number): number {
  if (denominator === 0) {
    return 0;
  }
  return numerator / denominator;
}

/**
 * Rounds a decimal number to a specified precision.
 * @param value The number to round
 * @param precision The number of decimal places (default: 6)
 * @returns The rounded number, or 0 if the value is not finite
 */
export function roundDecimal(value: number, precision = DECIMAL_PRECISION): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

/**
 * Parses a string or number input as a decimal with specified precision.
 * @param value The value to parse (string or number)
 * @param precision The number of decimal places (default: 6)
 * @returns The parsed and rounded number, or 0 if parsing fails
 */
export function parseDecimalInput(value: string | number, precision = DECIMAL_PRECISION): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : NaN;
  return Number.isFinite(parsed) ? roundDecimal(parsed, precision) : 0;
}

/**
 * Parses a YYYY-MM-DD string as a local-timezone Date.
 * `new Date("2023-07-20")` treats date-only strings as UTC midnight, which
 * shifts the day back for users west of UTC. This avoids that by splitting
 * the components and constructing a local Date directly.
 */
export function parseLocalDate(dateStr: string): Date {
  const [datePart] = dateStr.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  return new Date(year, month - 1, day);
}

/**
 * Parses a local datetime string in format "YYYY-MM-DDTHH:mm" to a Date object.
 * @param value The datetime string to parse
 * @returns A Date object, or current date if parsing fails
 */
export function parseLocalDateTime(value: string): Date {
  if (!value) {
    return new Date();
  }

  const [datePart, timePart = ""] = value.split("T");
  const [year, month, day] = datePart.split("-").map((segment) => Number.parseInt(segment, 10));
  const [hour = 0, minute = 0] = timePart.split(":").map((segment) => Number.parseInt(segment, 10));
  const parsed = new Date(year, (month ?? 1) - 1, day ?? 1, hour, minute);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

/**
 * Converts an unknown value to a string suitable for numeric cell display.
 * @param value The value to convert
 * @returns A string representation of the number, or empty string if invalid
 */
export function getNumericCellValue(value: unknown): string {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value.toString() : "";
  }
  if (typeof value === "string") {
    return value;
  }
  return "";
}

/**
 * Converts an unknown value to a finite number or undefined.
 * @param value The value to convert
 * @returns A finite number if valid, undefined otherwise
 */
export function toFiniteNumberOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Converts an unknown value to a rounded number suitable for API payloads.
 * @param value The value to convert
 * @param precision The number of decimal places (default: 6)
 * @returns A rounded number if valid, undefined otherwise
 */
export function toPayloadNumber(value: unknown, precision = DECIMAL_PRECISION): number | undefined {
  const parsed = toFiniteNumberOrUndefined(value);
  if (parsed === undefined) {
    return undefined;
  }
  return roundDecimal(parsed, precision);
}

/**
 * Normalize decimal string for storage: trim whitespace, remove trailing zeros.
 * Returns null for empty/invalid input. Used for storing numeric values as strings.
 */
export function normalizeDecimalString(value: unknown): string | null {
  if (value == null || value === "") return null;
  // Only accept string or number primitives
  if (typeof value !== "string" && typeof value !== "number") return null;
  const raw = String(value).trim();
  if (raw === "" || raw === "." || raw === "-") return null;
  const normalized = raw.toLowerCase();
  const decimalPattern = /^-?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?$/i;
  if (!decimalPattern.test(normalized)) return null;
  if (normalized.includes("e")) {
    return normalized;
  }
  const trimmed = normalized.endsWith(".") ? normalized.slice(0, -1) : normalized;
  if (trimmed.includes(".")) {
    return trimmed.replace(/\.?0+$/, "") || "0";
  }
  return trimmed;
}
