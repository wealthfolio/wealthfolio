import {
  ACTIVITY_SUBTYPES,
  ActivityType,
  DECIMAL_PRECISION,
  INCOME_ACTIVITY_TYPES,
  SYMBOL_REQUIRED_TYPES,
} from "./constants";
import { ActivityDetails } from "./types";

const roundCurrency = (value: number, precision = DECIMAL_PRECISION) => {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
};

/**
 * Determines if an activity type does not require a symbol (i.e. can be cash-only).
 * Callers use this for form/grid logic to hide/show symbol fields.
 */
export const isCashActivity = (activityType: string): boolean => {
  return !(SYMBOL_REQUIRED_TYPES as readonly string[]).includes(activityType);
};

/**
 * Determines if an activity is an income activity based on its type
 * @param activityType The activity type to check
 * @returns True if the activity is an income activity
 */
export const isIncomeActivity = (activityType: string): boolean => {
  return (INCOME_ACTIVITY_TYPES as readonly string[]).includes(activityType);
};

/**
 * Recognizes cash symbol patterns from brokers/exports (e.g. $CASH-CAD, CASH:USD).
 */
export const isCashSymbol = (symbol?: string): boolean => {
  if (!symbol?.trim()) return false;
  return /^\$?CASH[-_:][A-Z]{3}$/i.test(symbol.trim());
};

/**
 * Whether a symbol is required for this activity type.
 */
export const isSymbolRequired = (activityType: string): boolean => {
  return (SYMBOL_REQUIRED_TYPES as readonly string[]).includes(activityType);
};

/**
 * Subtypes that make income activities asset-backed rather than cash-only.
 */
export const isAssetBackedIncomeSubtype = (
  activityType: string,
  subtype?: string | null,
): boolean => {
  const normalizedActivityType = activityType?.trim().toUpperCase();
  const normalizedSubtype = subtype?.trim().toUpperCase();
  return (
    (normalizedActivityType === ActivityType.DIVIDEND &&
      (normalizedSubtype === ACTIVITY_SUBTYPES.DRIP ||
        normalizedSubtype === ACTIVITY_SUBTYPES.DIVIDEND_IN_KIND)) ||
    (normalizedActivityType === ActivityType.INTEREST &&
      normalizedSubtype === ACTIVITY_SUBTYPES.STAKING_REWARD)
  );
};

/**
 * Activity/subtype pairs that must carry a market asset identity.
 */
export const isAssetIdentityRequired = (activityType: string, subtype?: string | null): boolean => {
  return isSymbolRequired(activityType) || isAssetBackedIncomeSubtype(activityType, subtype);
};

/**
 * Import-time asset resolution can also be required by subtype even when the
 * base activity type is normally cash-oriented (e.g. staking rewards).
 */
export const needsImportAssetResolution = (
  activityType: string,
  subtype?: string | null,
): boolean => {
  return isAssetIdentityRequired(activityType, subtype);
};

const hasNonZeroNumericValue = (value?: string | number | null): boolean => {
  if (value == null) {
    return false;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) && value !== 0;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed !== 0;
};

/**
 * Determines if an activity is a cash transfer based on its type and identifiers.
 * A transfer is cash when:
 * - it has no asset identifier at all (blank symbol AND blank assetId), OR
 * - its symbol/assetId matches any supported cash placeholder:
 *   `CASH`, `CASH:USD`, `$CASH-EUR`, `CASH-GBP`, `CASH_GBP`, etc.
 */
export const isCashTransfer = (
  activityType: string,
  assetSymbol?: string,
  assetId?: string,
): boolean => {
  if (activityType !== ActivityType.TRANSFER_IN && activityType !== ActivityType.TRANSFER_OUT) {
    return false;
  }

  const symbol = assetSymbol?.trim() ?? "";
  const id = assetId?.trim() ?? "";

  // No asset at all → cash transfer
  if (!symbol && !id) {
    return true;
  }

  const upper = (symbol || id).toUpperCase();

  // Display placeholder used by applyCashDefaults
  if (upper === "CASH") {
    return true;
  }

  // Canonical backend form: CASH:{ccy}
  if (upper.startsWith("CASH:")) {
    const currency = upper.slice("CASH:".length);
    return /^[A-Z]{3}$/.test(currency);
  }

  // Broker-export placeholders: $CASH-XXX, $CASH_XXX, CASH-XXX, CASH_XXX
  return isCashSymbol(symbol) || isCashSymbol(id);
};

/**
 * Securities transfer: TRANSFER_IN/OUT whose asset identifiers clearly refer
 * to a real security (not cash, not blank). These move shares/units, so their
 * value derives from quantity × unitPrice (or a stored amount when unitPrice
 * is absent on legacy/imported rows).
 */
export const isSecuritiesTransfer = (
  activityType: string,
  assetSymbol?: string,
  assetId?: string,
): boolean => {
  if (activityType !== ActivityType.TRANSFER_IN && activityType !== ActivityType.TRANSFER_OUT) {
    return false;
  }
  const hasConcreteAsset = Boolean((assetSymbol?.trim() || assetId?.trim())?.length);
  if (!hasConcreteAsset) {
    return false;
  }
  return !isCashTransfer(activityType, assetSymbol, assetId);
};

/**
 * Import-time asset resolution for transfer rows needs row-level values.
 * Security transfers require asset resolution only when they have a real
 * non-cash symbol and a non-zero quantity or unit price, matching backend
 * import classification.
 */
export const needsImportAssetResolutionForRow = (input: {
  activityType?: string | null;
  subtype?: string | null;
  symbol?: string | null;
  assetId?: string | null;
  quantity?: string | number | null;
  unitPrice?: string | number | null;
}): boolean => {
  const activityType = input.activityType?.trim() ?? "";
  if (needsImportAssetResolution(activityType, input.subtype)) {
    return true;
  }

  if (!isSecuritiesTransfer(activityType, input.symbol ?? undefined, input.assetId ?? undefined)) {
    return false;
  }

  return hasNonZeroNumericValue(input.quantity) || hasNonZeroNumericValue(input.unitPrice);
};

const isCanonicalCashIdentifier = (identifier: string): boolean => {
  const upper = identifier.toUpperCase();
  if (upper === "CASH") {
    return true;
  }
  if (upper.startsWith("CASH:")) {
    const currency = upper.slice("CASH:".length);
    return /^[A-Z]{3}$/.test(currency);
  }
  return false;
};

/**
 * Income activities can still be asset-backed (e.g. in-kind staking rewards).
 * Returns true when an income activity carries a non-cash asset identifier.
 */
export const isAssetBackedIncomeActivity = (
  activityType: string,
  assetSymbol?: string,
  assetId?: string,
): boolean => {
  if (!isIncomeActivity(activityType)) {
    return false;
  }

  const identifiers = [assetSymbol, assetId]
    .map((value) => value?.trim() ?? "")
    .filter((value) => value.length > 0);

  if (identifiers.length === 0) {
    return false;
  }

  return identifiers.some((value) => !isCashSymbol(value) && !isCanonicalCashIdentifier(value));
};

// Helper to check if activity is a trade type
export const isTradeActivity = (type: string): boolean => {
  return type === ActivityType.BUY || type === ActivityType.SELL;
};

// Helper to check if activity is a fee type
export const isFeeActivity = (activityType: string): boolean => {
  return activityType === ActivityType.FEE;
};

// Helper to check if activity is a tax type
export const isTaxActivity = (activityType: string): boolean => {
  return activityType === ActivityType.TAX;
};

// Helper to check if activity is a split type
export const isSplitActivity = (activityType: string): boolean => {
  return activityType === ActivityType.SPLIT;
};

// Format a split ratio stored as a decimal multiplier into a human-readable ratio string.
// Uses rational approximation to find the simplest N:D form.
// e.g. 2 → "2:1", 0.2 → "1:5", 0.3 → "3:10", 1.5 → "3:2"
export const formatSplitRatio = (amount: number): string => {
  if (!amount || amount <= 0) return "0:1";

  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

  // Find the best rational approximation N/D ≈ amount with D ≤ maxDenom
  const toFraction = (x: number, maxDenom = 1000): [number, number] => {
    let bestN = 1,
      bestD = 1,
      minErr = Infinity;
    for (let d = 1; d <= maxDenom; d++) {
      const n = Math.round(x * d);
      const err = Math.abs(x - n / d);
      if (err < minErr) {
        minErr = err;
        bestN = n;
        bestD = d;
      }
      if (err < 1e-9) break;
    }
    const g = gcd(bestN, bestD);
    return [bestN / g, bestD / g];
  };

  const [n, d] = toFraction(amount);
  return `${n}:${d}`;
};

/**
 * Gets the fee amount from an activity
 * @param activity The activity to get the fee from
 * @returns The fee amount
 */
export const getFee = (activity: ActivityDetails): number => {
  return Number(activity.fee);
};

/**
 * Gets the amount from an activity, with a fallback to 0 if not provided
 * @param activity The activity to get the amount from
 * @returns The amount or 0 if not provided
 */
export const getAmount = (activity: ActivityDetails): number => {
  return Number(activity.amount ?? 0);
};

/**
 * Gets the quantity from an activity
 * @param activity The activity to get the quantity from
 * @returns The quantity
 */
export const getQuantity = (activity: ActivityDetails): number => {
  return Number(activity.quantity);
};

/**
 * Gets the unit price from an activity
 * @param activity The activity to get the unit price from
 * @returns The unit price
 */
export const getUnitPrice = (activity: ActivityDetails): number => {
  return Number(activity.unitPrice);
};

/**
 * Calculates the total value of an activity based on its type and data
 * @param activity The activity to calculate the value for
 * @returns The calculated value
 */
export const calculateActivityValue = (activity: ActivityDetails): number => {
  const { activityType, assetSymbol, assetId, subtype } = activity;

  // Handle special cases first
  if (activityType === ActivityType.SPLIT) {
    return 0; // Split activities don't have a monetary value
  }

  if (activityType === ActivityType.FEE || activityType === ActivityType.TAX) {
    const amount = getAmount(activity);
    if (amount !== 0) {
      return roundCurrency(amount);
    }
    return roundCurrency(getFee(activity));
  }

  const isSecTransfer = isSecuritiesTransfer(activityType, assetSymbol, assetId);

  // Handle cash activities (but NOT securities transfers, which need qty × price)
  if (
    (isCashActivity(activityType) && !isSecTransfer) ||
    isCashTransfer(activityType, assetSymbol, assetId) ||
    isIncomeActivity(activityType)
  ) {
    let amount = getAmount(activity);
    const fee = getFee(activity);

    if (isAssetBackedIncomeSubtype(activityType, subtype) && amount === 0) {
      const derivedAmount = getQuantity(activity) * getUnitPrice(activity);
      if (Number.isFinite(derivedAmount) && derivedAmount > 0) {
        amount = derivedAmount;
      }
    }

    // For outgoing cash activities, subtract fee from amount
    if (activityType === ActivityType.WITHDRAWAL || activityType === ActivityType.TRANSFER_OUT) {
      return roundCurrency(Number(amount) + Number(fee));
    }

    // For incoming cash activities, subtract fee from amount
    return roundCurrency(Number(amount) - Number(fee));
  }

  // Handle trading activities (and securities transfers)
  const quantity = getQuantity(activity);
  const unitPrice = getUnitPrice(activity);
  const fee = getFee(activity);
  let activityAmount = roundCurrency(Number(quantity) * Number(unitPrice));

  // Securities transfers imported without a unit price (legacy / some broker
  // exports) carry their monetary value on `amount`. Fall back to it so those
  // rows don't render as 0 just because we no longer trust `amount` by default.
  if (isSecTransfer && activityAmount === 0) {
    const storedAmount = getAmount(activity);
    if (storedAmount !== 0) {
      activityAmount = roundCurrency(storedAmount);
    }
  }

  if (activityType === ActivityType.BUY) {
    return roundCurrency(Number(activityAmount) + Number(fee)); // Total cost including fees
  }

  if (activityType === ActivityType.SELL) {
    return roundCurrency(Number(activityAmount) - Number(fee)); // Net proceeds after fees
  }

  // Default case - just return the activity amount
  return roundCurrency(Number(activityAmount));
};

/**
 * Determines if the value should be displayed as positive or negative
 * @param activityType The activity type
 * @returns True if the value should be displayed as negative
 */
export const isNegativeValueActivity = (activityType: string): boolean => {
  return (
    activityType === ActivityType.BUY ||
    activityType === ActivityType.WITHDRAWAL ||
    activityType === ActivityType.TRANSFER_OUT ||
    activityType === ActivityType.FEE ||
    activityType === ActivityType.TAX
  );
};
