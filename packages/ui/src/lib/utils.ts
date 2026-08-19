import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { getQuoteUnitCurrency } from "./currencies";
import { createFormatter } from "./formatting";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Backward-compatible helpers for consumers of the published package. New application code should
// use FormattingProvider hooks so the user's configured locale is applied.
const legacyFormatter = createFormatter("en-US");
const legacyCurrencyFormatters = new Map<string, Intl.NumberFormat>();
const legacyCurrencySymbolFormatters = new Map<string, Intl.NumberFormat>();
const LEGACY_AMOUNT_OPTIONS: Intl.NumberFormatOptions = {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
};

/** @deprecated Use useAmountFormatting().formatAmount instead. */
export function formatAmount(
  amount: number | string | null | undefined,
  currency: string,
  displayCurrency = true,
) {
  if (amount == null) return "-";
  const numericAmount = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(numericAmount)) return "-";
  const displayed = Math.abs(numericAmount) < 0.005 ? 0 : numericAmount;
  const quoteUnit = getQuoteUnitCurrency(currency);
  const formattedNumber = legacyFormatter.formatDecimal(displayed, LEGACY_AMOUNT_OPTIONS);
  if (quoteUnit) return displayCurrency ? `${formattedNumber}${quoteUnit.symbol}` : formattedNumber;
  if (!displayCurrency) return formattedNumber;

  const normalizedCurrency = currency?.toUpperCase?.() || "USD";
  try {
    let formatter = legacyCurrencyFormatters.get(normalizedCurrency);
    if (!formatter) {
      formatter = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: normalizedCurrency,
        ...LEGACY_AMOUNT_OPTIONS,
      });
      legacyCurrencyFormatters.set(normalizedCurrency, formatter);
    }
    return formatter.format(displayed);
  } catch {
    return formattedNumber;
  }
}

/** @deprecated Use useAmountFormatting().formatPrice instead. */
export function formatPrice(
  amount: number | string | null | undefined,
  currency: string,
  displayCurrency = true,
) {
  return legacyFormatter.formatPrice(amount, currency, displayCurrency);
}

/** @deprecated Use useAmountFormatting().formatCompactAmount instead. */
export function formatCompactAmount(
  amount: number | string | null | undefined,
  currency: string,
  displayCurrency = true,
) {
  return legacyFormatter.formatCompactAmount(amount, currency, displayCurrency);
}

/** @deprecated Use useNumberFormatting().formatPercent instead. */
export function formatPercent(value: number | null | undefined) {
  return legacyFormatter.formatPercent(value);
}

/** @deprecated Use useNumberFormatting().formatQuantity instead. */
export function formatQuantity(quantity: string | number | null | undefined) {
  return legacyFormatter.formatQuantity(quantity);
}

/** @deprecated Use useAmountFormatting().formatCurrencySymbol instead. */
export function formatCurrencySymbol(currency: string | null | undefined) {
  const rawCurrency = currency || "USD";
  const quoteUnit = getQuoteUnitCurrency(rawCurrency);
  if (quoteUnit) return quoteUnit.symbol;

  const normalizedCurrency = rawCurrency.toUpperCase();
  try {
    let formatter = legacyCurrencySymbolFormatters.get(normalizedCurrency);
    if (!formatter) {
      formatter = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: normalizedCurrency,
        currencyDisplay: "narrowSymbol",
        maximumFractionDigits: 0,
      });
      legacyCurrencySymbolFormatters.set(normalizedCurrency, formatter);
    }
    return (
      formatter.formatToParts(0).find((part) => part.type === "currency")?.value ?? rawCurrency
    );
  } catch {
    return rawCurrency;
  }
}
