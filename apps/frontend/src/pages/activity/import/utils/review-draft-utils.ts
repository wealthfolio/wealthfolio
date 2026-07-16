import { ActivityType } from "@/lib/constants";
import { isAssetBackedIncomeSubtype } from "@/lib/activity-utils";

/**
 * Parse a numeric value from a string, handling various formats.
 * Preserves the sign so callers can use broker-provided direction when needed.
 */
export function parseSignedNumericValue(
  value: string | undefined,
  decimalSeparator: string,
  thousandsSeparator: string,
): string | undefined {
  if (!value || value.trim() === "") return undefined;

  let normalized = value.trim();
  let isNegative = false;

  if (normalized.startsWith("(") && normalized.endsWith(")")) {
    isNegative = true;
    normalized = normalized.slice(1, -1);
  }

  let mantissa = normalized;
  let exponent = "";
  const expIndex = normalized.search(/[eE]/);
  if (expIndex >= 0) {
    mantissa = normalized.slice(0, expIndex);
    exponent = normalized.slice(expIndex + 1);
  }

  const lastComma = mantissa.lastIndexOf(",");
  const lastDot = mantissa.lastIndexOf(".");
  let resolvedDecimal = decimalSeparator;
  if (decimalSeparator === "auto") {
    if (lastComma !== -1 && lastDot !== -1) {
      resolvedDecimal = lastComma > lastDot ? "," : ".";
    } else if (lastComma !== -1) {
      resolvedDecimal = ",";
    } else {
      resolvedDecimal = ".";
    }
  }

  let cleaned = mantissa.replace(/[^\d.,+-]/g, "");

  if (thousandsSeparator !== "none" && thousandsSeparator !== "auto") {
    cleaned = cleaned.replace(new RegExp(`\\${thousandsSeparator}`, "g"), "");
  } else {
    const defaultThousands = resolvedDecimal === "," ? "." : ",";
    cleaned = cleaned.replace(new RegExp(`\\${defaultThousands}`, "g"), "");
  }

  if (resolvedDecimal === ",") {
    const parts = cleaned.split(",");
    if (parts.length > 1) {
      const decimalPart = parts.pop() ?? "";
      cleaned = `${parts.join("")}.${decimalPart}`;
    }
  } else {
    const parts = cleaned.split(".");
    if (parts.length > 1) {
      const decimalPart = parts.pop() ?? "";
      cleaned = `${parts.join("")}.${decimalPart}`;
    }
  }

  const expClean = exponent.replace(/[^\d+-]/g, "");
  let candidate = cleaned;
  if (isNegative && candidate && !candidate.startsWith("-")) {
    candidate = `-${candidate}`;
  }
  if (expClean) {
    candidate = `${candidate}e${expClean}`;
  }

  if (candidate === "" || candidate === "-" || candidate === "+") {
    return undefined;
  }

  const numericCheck = Number(candidate);
  if (!Number.isFinite(numericCheck)) return undefined;

  return candidate;
}

/**
 * Parse a numeric value from a string, handling various formats.
 * Always returns absolute values — brokers often use negative values to indicate direction.
 */
export function parseNumericValue(
  value: string | undefined,
  decimalSeparator: string,
  thousandsSeparator: string,
): string | undefined {
  const candidate = parseSignedNumericValue(value, decimalSeparator, thousandsSeparator);
  if (!candidate) return undefined;
  return candidate.startsWith("-") ? candidate.slice(1) : candidate;
}

export function toNumber(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function hasPositiveValue(value: string | number | null | undefined): boolean {
  const parsed = toNumber(value);
  return parsed !== undefined && parsed > 0;
}

export function hasNonZeroValue(value: string | number | null | undefined): boolean {
  const parsed = toNumber(value);
  return parsed !== undefined && parsed !== 0;
}

/** Activity types where "quantity" with no unit price is really a dollar amount */
const CASH_LIKE_TYPES: string[] = [
  ActivityType.DIVIDEND,
  ActivityType.INTEREST,
  ActivityType.TAX,
  ActivityType.FEE,
  ActivityType.DEPOSIT,
  ActivityType.WITHDRAWAL,
  ActivityType.CREDIT,
];

/**
 * For cash-like activities, some brokers (e.g. Schwab) put the dollar value
 * in the Quantity column instead of Amount. If amount is missing but quantity
 * is present with no unit price, treat quantity as the amount.
 *
 * Returns adjusted { quantity, amount }.
 */
export function resolveCashActivityFields(
  activityType: string | undefined,
  quantity: string | undefined,
  amount: string | undefined,
  unitPrice: string | undefined,
  subtype?: string,
): { quantity: string | undefined; amount: string | undefined } {
  if (
    activityType &&
    CASH_LIKE_TYPES.includes(activityType) &&
    !isAssetBackedIncomeSubtype(activityType, subtype) &&
    !toNumber(amount) &&
    toNumber(quantity) &&
    !toNumber(unitPrice)
  ) {
    return { quantity: undefined, amount: quantity };
  }
  return { quantity, amount };
}
