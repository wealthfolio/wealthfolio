import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { DECIMAL_PRECISION, DISPLAY_DECIMAL_PRECISION } from "./constants";
import { worldCurrencies } from "./currencies";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format amount with currency support, including special handling for pence (GBp/GBX)
 */
const DECIMAL_FORMAT_OPTIONS: Intl.NumberFormatOptions = {
  minimumFractionDigits: DISPLAY_DECIMAL_PRECISION,
  maximumFractionDigits: DISPLAY_DECIMAL_PRECISION,
};

const decimalFormatter = new Intl.NumberFormat(undefined, DECIMAL_FORMAT_OPTIONS);
const currencyFormatterCache = new Map<string, Intl.NumberFormat>();
const compactCurrencyFormatterCache = new Map<string, Intl.NumberFormat>();
const currencySymbolFormatterCache = new Map<string, Intl.NumberFormat>();
const decimalFormatterCache = new Map<string, Intl.NumberFormat>();

const getDecimalFormatter = (currency: string) => {
  const normalizedCurrency = currency?.toUpperCase?.() ?? "USD";
  if (decimalFormatterCache.has(normalizedCurrency)) {
    return decimalFormatterCache.get(normalizedCurrency)!;
  }

  let formatter: Intl.NumberFormat;
  try {
    const fractionDigits =
      worldCurrencies.find((c) => c.value === normalizedCurrency)?.decimals ??
      DISPLAY_DECIMAL_PRECISION;

  return new Intl.NumberFormat("en-US", {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
  } catch {
    formatter = decimalFormatter;
  }

  decimalFormatterCache.set(normalizedCurrency, formatter);
  return formatter;
};

const getCurrencyFormatter = (currency: string) => {
  const normalizedCurrency = currency?.toUpperCase?.() ?? "USD";
  const cacheKey = normalizedCurrency;

  if (currencyFormatterCache.has(cacheKey)) {
    return currencyFormatterCache.get(cacheKey)!;
  }

  let formatter: Intl.NumberFormat;
  try {
    const fractionDigits =
      worldCurrencies.find((c) => c.value === normalizedCurrency)?.decimals ??
      DISPLAY_DECIMAL_PRECISION;

    formatter = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: normalizedCurrency,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
  } catch {
    formatter = decimalFormatter;
  }

  currencyFormatterCache.set(cacheKey, formatter);
  return formatter;
};

const getCompactCurrencyFormatter = (currency: string, maximumFractionDigits: number) => {
  const normalizedCurrency = currency?.toUpperCase?.() ?? "USD";
  const cacheKey = `${normalizedCurrency}:${maximumFractionDigits}`;

  if (compactCurrencyFormatterCache.has(cacheKey)) {
    return compactCurrencyFormatterCache.get(cacheKey)!;
  }

  let formatter: Intl.NumberFormat;
  try {
    formatter = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: normalizedCurrency,
      notation: "compact",
      maximumFractionDigits,
    });
  } catch {
    formatter = decimalFormatter;
  }

  compactCurrencyFormatterCache.set(cacheKey, formatter);
  return formatter;
};

export function formatCurrencySymbol(currency: string | null | undefined) {
  const rawCurrency = currency || "USD";

  if (rawCurrency === "GBp" || rawCurrency === "GBX") {
    return "p";
  }

  const normalizedCurrency = rawCurrency.toUpperCase();

  try {
    if (!currencySymbolFormatterCache.has(normalizedCurrency)) {
      currencySymbolFormatterCache.set(
        normalizedCurrency,
        new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: normalizedCurrency,
          currencyDisplay: "narrowSymbol",
          maximumFractionDigits: 0,
        }),
      );
    }

    return (
      currencySymbolFormatterCache
        .get(normalizedCurrency)!
        .formatToParts(0)
        .find((part) => part.type === "currency")?.value ?? rawCurrency
    );
  } catch {
    return rawCurrency;
  }
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
  const isPenceCurrency = rawCurrency === "GBp" || rawCurrency === "GBX";

  if (isPenceCurrency) {
    const formattedNumber = getDecimalFormatter(rawCurrency).format(displayAmount);
    return displayCurrency ? `${formattedNumber}p` : formattedNumber;
  }

  if (!displayCurrency) {
    return getDecimalFormatter(rawCurrency).format(displayAmount);
  }

  return getCurrencyFormatter(rawCurrency).format(displayAmount);
}

export function formatCompactAmount(
  amount: number | string | null | undefined,
  currency: string,
  displayCurrency = true,
) {
  if (amount == null) return "-";
  const numericAmount = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(numericAmount)) return "-";
  const rawCurrency = currency ?? "USD";
  const abs = Math.abs(numericAmount);
  const maximumFractionDigits = abs >= 1_000_000 ? 2 : abs >= 100_000 ? 0 : abs >= 1_000 ? 1 : 0;

  if (!displayCurrency) {
    return new Intl.NumberFormat(undefined, {
      notation: "compact",
      maximumFractionDigits,
    }).format(numericAmount);
  }

  return getCompactCurrencyFormatter(rawCurrency, maximumFractionDigits).format(numericAmount);
}

/**
 * Format percentage values with proper formatting
 */
export function formatPercent(value: number | null | undefined) {
  if (value == null) return "-";
  try {
    // Use Intl.NumberFormat for correct percentage formatting (handles x100 and % sign)
    return new Intl.NumberFormat("en-US", {
      style: "percent",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch (error) {
    console.error(`Error formatting percent ${value}: ${error}`);
    // Fallback to simple string conversion if formatting fails
    return `${value}%`;
  }
}

export function formatQuantity(quantity: string | number | null | undefined): string {
  if (quantity == null) return "-";
  const numQuantity = parseFloat(String(quantity));
  if (!Number.isFinite(numQuantity)) return "-";
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: DECIMAL_PRECISION,
    useGrouping: true,
  }).format(numQuantity);
}
