import type { TFunction } from "i18next";
import { getQuoteUnitCurrency } from "@wealthfolio/ui/lib/currencies";
import { resolveActivityCashMultiplier } from "./activity-final-amount";
import {
  ACTIVITY_SUBTYPES,
  ActivityStatus,
  ActivityType,
  ActivityTypeNames,
  INCOME_ACTIVITY_TYPES,
  METADATA_CONTRACT_MULTIPLIER,
  normalizePositionIntentAlias,
  POSITION_INTENT_ALIASES,
  SUBTYPE_DISPLAY_NAMES,
  SYMBOL_REQUIRED_TYPES,
} from "./constants";
import { ActivityDetails } from "./types";

/**
 * Localized display name for an activity type (e.g. BUY -> "Buy" / "买入").
 * Falls back to the English name from {@link ActivityTypeNames}.
 */
export const localizeActivityTypeName = (t: TFunction, activityType: string): string => {
  const fallback = (ActivityTypeNames as Record<string, string>)[activityType] ?? activityType;
  return t(`activity:type_${activityType.toLowerCase()}`, fallback);
};

/**
 * Localized display name for an activity subtype (e.g. DRIP, POSITION_OPEN).
 * Falls back to the English name from {@link SUBTYPE_DISPLAY_NAMES}, then the raw value.
 */
export const localizeActivitySubtypeName = (t: TFunction, subtype: string): string => {
  const normalized = subtype.trim().toUpperCase();
  const fallback = SUBTYPE_DISPLAY_NAMES[normalized] ?? subtype;
  return t(`activity:subtype_${normalized.toLowerCase()}`, fallback);
};

/**
 * Determines if an activity type does not require a symbol (i.e. can be cash-only).
 * Callers use this for form/grid logic to hide/show symbol fields.
 */
export const isCashActivity = (activityType: string): boolean => {
  return !(SYMBOL_REQUIRED_TYPES as readonly string[]).includes(activityType);
};

/** Whether an activity can explicitly cross the tracked-account performance boundary. */
export const supportsPerformanceBoundary = (activityType?: string | null): boolean => {
  const normalizedActivityType = activityType?.trim().toUpperCase();
  return (
    normalizedActivityType === ActivityType.CREDIT ||
    normalizedActivityType === ActivityType.TRANSFER_IN ||
    normalizedActivityType === ActivityType.TRANSFER_OUT
  );
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
 * Matches the backend's import-only placeholder detection. These values are
 * not real tickers and must never enter asset mapping/resolution.
 */
export const isGarbageSymbol = (symbol?: string): boolean => {
  const normalized = symbol?.trim() ?? "";
  if (!normalized) return false;
  if (/^-+$/.test(normalized)) return true;
  return normalized.startsWith("$") && !isCashSymbol(normalized);
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
  if (activityType === ActivityType.ADJUSTMENT) {
    const canonical = canonicalizeActivitySubtype(activityType, subtype);
    return (
      canonical === ACTIVITY_SUBTYPES.OPTION_EXPIRY ||
      canonical === ACTIVITY_SUBTYPES.RETURN_OF_CAPITAL ||
      canonical === ACTIVITY_SUBTYPES.NOTIONAL_DISTRIBUTION
    );
  }
  return isSymbolRequired(activityType) || isAssetBackedIncomeSubtype(activityType, subtype);
};

/**
 * Import-time asset resolution also applies to optional, provider-supplied
 * adjustment symbols and asset-backed income subtypes such as staking rewards.
 */
export const needsImportAssetResolution = (
  activityType: string,
  subtype?: string | null,
): boolean => {
  return (
    activityType === ActivityType.ADJUSTMENT ||
    isSymbolRequired(activityType) ||
    isAssetBackedIncomeSubtype(activityType, subtype)
  );
};

/** Whether an imported symbol represents an asset the user must resolve. */
export const shouldResolveImportAsset = (
  activityType: string,
  subtype: string | null | undefined,
  symbol: string,
): boolean => {
  if (!needsImportAssetResolution(activityType, subtype)) return false;
  // Required-asset rows still enter validation so malformed symbols surface
  // as errors. Optional-asset rows mirror backend classification and treat
  // placeholders as cash movements.
  if (
    (isSymbolRequired(activityType) &&
      activityType !== ActivityType.DIVIDEND &&
      activityType !== ActivityType.ADJUSTMENT) ||
    (activityType === ActivityType.ADJUSTMENT && isAssetIdentityRequired(activityType, subtype))
  ) {
    return true;
  }
  return !isCashSymbol(symbol) && !isGarbageSymbol(symbol);
};

export const canonicalizeActivitySubtype = (
  activityType: string,
  subtype?: string | null,
): string | undefined => {
  const trimmedSubtype = subtype?.trim() ?? "";
  if (!trimmedSubtype) return undefined;
  const normalizedSubtype = normalizePositionIntentAlias(trimmedSubtype);

  const normalizedActivityType = activityType?.trim().toUpperCase();
  const sideAliases =
    normalizedActivityType === ActivityType.BUY
      ? POSITION_INTENT_ALIASES[ActivityType.BUY]
      : normalizedActivityType === ActivityType.SELL
        ? POSITION_INTENT_ALIASES[ActivityType.SELL]
        : undefined;
  if (sideAliases) {
    if (
      (sideAliases[ACTIVITY_SUBTYPES.POSITION_OPEN] as readonly string[]).includes(
        normalizedSubtype,
      )
    ) {
      return ACTIVITY_SUBTYPES.POSITION_OPEN;
    }
    if (
      (sideAliases[ACTIVITY_SUBTYPES.POSITION_CLOSE] as readonly string[]).includes(
        normalizedSubtype,
      )
    ) {
      return ACTIVITY_SUBTYPES.POSITION_CLOSE;
    }
  }

  const knownSubtype = trimmedSubtype.toUpperCase().replace(/[ -]/g, "_");
  if (
    knownSubtype === ACTIVITY_SUBTYPES.RETURN_OF_CAPITAL ||
    knownSubtype === ACTIVITY_SUBTYPES.NOTIONAL_DISTRIBUTION ||
    knownSubtype === ACTIVITY_SUBTYPES.OPTION_EXPIRY
  ) {
    return knownSubtype;
  }
  return trimmedSubtype;
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
 * Returns the authoritative stored activity amount for display. Ledger views
 * use `calculateActivityCashImpact` instead.
 */
export const calculateActivityValue = (activity: ActivityDetails): number => {
  if (activity.activityType === ActivityType.SPLIT) return 0;
  if (isSecuritiesTransfer(activity.activityType, activity.assetSymbol, activity.assetId)) {
    const quantity = Math.abs(Number(activity.quantity));
    const unitPrice = Math.abs(Number(activity.unitPrice));
    const derived = quantity * unitPrice * activityCashMultiplier(activity);
    if (Number.isFinite(derived) && derived > 0) return derived;
  }
  const value = Number(activity.amount ?? 0);
  return Number.isFinite(value) ? Math.abs(value) : 0;
};

/**
 * Derives the signed ledger movement from the authoritative final amount.
 * This is presentation-only cash-audit logic; it never replaces a missing
 * amount or changes persisted economics.
 */
export const calculateActivityCashImpact = (
  activity: ActivityDetails,
  isCreditCardAccount = false,
): number => {
  if (activity.status && activity.status !== ActivityStatus.POSTED) return 0;
  if (activity.activityType === ActivityType.SPLIT) return 0;

  if (isSecuritiesTransfer(activity.activityType, activity.assetSymbol, activity.assetId)) {
    const fee = Math.abs(Number(activity.fee ?? 0));
    return Number.isFinite(fee) && fee > 0 ? -fee : 0;
  }

  if (isAssetBackedIncomeSubtype(activity.activityType, activity.subtype)) return 0;

  const amount = Math.abs(Number(activity.amount ?? 0));
  if (!Number.isFinite(amount) || amount === 0) return 0;

  switch (activity.activityType) {
    case ActivityType.BUY:
    case ActivityType.WITHDRAWAL:
    case ActivityType.FEE:
    case ActivityType.TAX:
    case ActivityType.TRANSFER_OUT:
      return -amount;
    case ActivityType.SELL:
      return isProvenNegativeSell(activity, amount) ? -amount : amount;
    case ActivityType.INTEREST:
      return isCreditCardAccount ? -amount : amount;
    case ActivityType.DEPOSIT:
    case ActivityType.DIVIDEND:
    case ActivityType.CREDIT:
    case ActivityType.TRANSFER_IN:
      return amount;
    default:
      return 0;
  }
};

/**
 * Keep in lockstep with the SELL reversal check in
 * crates/core/src/portfolio/economic_events.rs, including the epsilon.
 */
function isProvenNegativeSell(activity: ActivityDetails, finalAmount: number): boolean {
  const quantity = Math.abs(Number(activity.quantity));
  const unitPrice = Math.abs(Number(activity.unitPrice));
  const fee = Math.abs(Number(activity.fee ?? 0));
  const tax = Math.abs(Number(activity.tax ?? 0));
  const multiplier = activityCashMultiplier(activity);
  if (![quantity, unitPrice, fee, tax, multiplier].every(Number.isFinite)) return false;
  if (quantity === 0 || unitPrice === 0 || multiplier <= 0) return false;

  const expected = quantity * unitPrice * multiplier - fee - tax;
  if (expected >= 0) return false;
  const tolerance = Math.max(currencyMinorUnit(activity.currency), finalAmount * 1e-8);
  return Math.abs(Math.abs(expected) - finalAmount) <= tolerance;
}

/**
 * Crypto quote currencies priced at 8 fraction digits. Keep in lockstep with
 * the crypto arm of `currency_fraction_digits` in
 * crates/core/src/fx/currency.rs (dollar-pegged stablecoins deliberately keep
 * the two-decimal fiat default there and here).
 */
const CRYPTO_QUOTE_CURRENCIES = new Set([
  "BTC",
  "ETH",
  "XRP",
  "LTC",
  "BCH",
  "ADA",
  "DOT",
  "LINK",
  "XLM",
  "DOGE",
  "UNI",
  "SOL",
  "AVAX",
  "MATIC",
  "ATOM",
  "ALGO",
  "VET",
  "FIL",
  "TRX",
  "ETC",
  "XMR",
  "AAVE",
  "MKR",
  "COMP",
  "SNX",
  "YFI",
  "SUSHI",
  "CRV",
]);

/**
 * One minor unit of the currency. Keep in lockstep with `currency_minor_unit`
 * in crates/core/src/fx/currency.rs, including minor-unit aliases. This is an
 * accounting tolerance, not display precision: Intl/CLDR can differ from core.
 */
function currencyMinorUnit(currency: string | undefined): number {
  if (!currency) return 0.01;
  const upper = (getQuoteUnitCurrency(currency)?.major ?? currency).toUpperCase();
  if (CRYPTO_QUOTE_CURRENCIES.has(upper)) return 1e-8;
  switch (upper) {
    case "BIF":
    case "CLP":
    case "DJF":
    case "GNF":
    case "ISK":
    case "JPY":
    case "KMF":
    case "KRW":
    case "PYG":
    case "RWF":
    case "UGX":
    case "UYI":
    case "VND":
    case "VUV":
    case "XAF":
    case "XOF":
    case "XPF":
      return 1;
    case "BHD":
    case "IQD":
    case "JOD":
    case "KWD":
    case "LYD":
    case "OMR":
    case "TND":
      return 0.001;
    case "CLF":
    case "UYW":
      return 0.0001;
    default:
      return 0.01;
  }
}

/**
 * Uses the asset-owned multiplier, with the activity's creation seed as a
 * compatibility fallback for older payloads. Presentation only: never let
 * this decide a persisted amount.
 */
function activityCashMultiplier(activity: ActivityDetails): number {
  return resolveActivityCashMultiplier(
    activity.instrumentType,
    activity.assetContractMultiplier ?? activity.metadata?.[METADATA_CONTRACT_MULTIPLIER],
  );
}

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
