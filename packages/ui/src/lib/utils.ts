import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { DECIMAL_PRECISION, DISPLAY_DECIMAL_PRECISION } from "./constants";
import { getQuoteUnitCurrency } from "./currencies";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format amount with currency support, including quote units such as GBp and ILA. */
const DECIMAL_FORMAT_OPTIONS: Intl.NumberFormatOptions = {
  minimumFractionDigits: DISPLAY_DECIMAL_PRECISION,
  maximumFractionDigits: DISPLAY_DECIMAL_PRECISION,
};
const STANDARD_PRICE_DECIMAL_PRECISION = 4;

const decimalFormatter = new Intl.NumberFormat("en-US", DECIMAL_FORMAT_OPTIONS);
const currencyFormatterCache = new Map<string, Intl.NumberFormat>();
const priceDecimalFormatterCache = new Map<number, Intl.NumberFormat>();
const priceCurrencyFormatterCache = new Map<string, Intl.NumberFormat>();
const compactCurrencyFormatterCache = new Map<string, Intl.NumberFormat>();
const currencySymbolFormatterCache = new Map<string, Intl.NumberFormat>();

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

const getPriceDecimalFormatter = (maximumFractionDigits: number) => {
  if (!priceDecimalFormatterCache.has(maximumFractionDigits)) {
    priceDecimalFormatterCache.set(
      maximumFractionDigits,
      new Intl.NumberFormat("en-US", {
        minimumFractionDigits: DISPLAY_DECIMAL_PRECISION,
        maximumFractionDigits,
      }),
    );
  }

  return priceDecimalFormatterCache.get(maximumFractionDigits)!;
};

const getPriceCurrencyFormatter = (currency: string, maximumFractionDigits: number) => {
  const normalizedCurrency = currency?.toUpperCase?.() ?? "USD";
  const cacheKey = `${normalizedCurrency}:${maximumFractionDigits}`;

  if (priceCurrencyFormatterCache.has(cacheKey)) {
    return priceCurrencyFormatterCache.get(cacheKey)!;
  }

  let formatter: Intl.NumberFormat;
  try {
    formatter = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: normalizedCurrency,
      minimumFractionDigits: DISPLAY_DECIMAL_PRECISION,
      maximumFractionDigits,
    });
  } catch {
    formatter = getPriceDecimalFormatter(maximumFractionDigits);
  }

  priceCurrencyFormatterCache.set(cacheKey, formatter);
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
    formatter = new Intl.NumberFormat("en-US", {
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
  const quoteUnit = getQuoteUnitCurrency(rawCurrency);

  if (quoteUnit) {
    return quoteUnit.symbol;
  }

  const normalizedCurrency = rawCurrency.toUpperCase();

  try {
    if (!currencySymbolFormatterCache.has(normalizedCurrency)) {
      currencySymbolFormatterCache.set(
        normalizedCurrency,
        new Intl.NumberFormat("en-US", {
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

/** Format a per-unit price without discarding meaningful precision. */
export function formatPrice(
  amount: number | string | null | undefined,
  currency: string,
  displayCurrency = true,
) {
  if (amount == null) return "-";
  const numericAmount = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(numericAmount)) return "-";
  const displayPrice = Math.abs(numericAmount) < 0.000000005 ? 0 : numericAmount;
  const maximumFractionDigits =
    displayPrice !== 0 && Math.abs(displayPrice) < 0.01
      ? DECIMAL_PRECISION
      : STANDARD_PRICE_DECIMAL_PRECISION;
  const rawCurrency = currency ?? "USD";
  const quoteUnit = getQuoteUnitCurrency(rawCurrency);

  if (quoteUnit) {
    const formattedNumber = getPriceDecimalFormatter(maximumFractionDigits).format(displayPrice);
    return displayCurrency ? `${formattedNumber}${quoteUnit.symbol}` : formattedNumber;
  }

  if (!displayCurrency) {
    return getPriceDecimalFormatter(maximumFractionDigits).format(displayPrice);
  }

  return getPriceCurrencyFormatter(rawCurrency, maximumFractionDigits).format(displayPrice);
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
  const quoteUnit = getQuoteUnitCurrency(rawCurrency);

  if (!displayCurrency) {
    return new Intl.NumberFormat("en-US", {
      notation: "compact",
      maximumFractionDigits,
    }).format(numericAmount);
  }

  if (quoteUnit) {
    const formattedNumber = new Intl.NumberFormat("en-US", {
      notation: "compact",
      maximumFractionDigits,
    }).format(numericAmount);
    return `${formattedNumber}${quoteUnit.symbol}`;
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
    return `${(value * 100).toFixed(2)}%`;
  }
}

export function formatQuantity(quantity: string | number | null | undefined): string {
  if (quantity == null) return "-";
  const numQuantity = parseFloat(String(quantity));
  if (!Number.isFinite(numQuantity)) return "-";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: DECIMAL_PRECISION,
    useGrouping: true,
  }).format(numQuantity);
}
