import {
  ACTIVITY_SUBTYPES,
  AccountType,
  ActivityType,
  ImportFormat,
  POSITION_INTENT_ALIASES,
} from "@/lib/constants";
import { canonicalizeActivitySubtype } from "@/lib/activity-utils";
import type { ActivityImport } from "@/lib/types";
import { tryParseDate } from "@/lib/utils";
import { isValid, parse, parseISO } from "date-fns";
import { findMappedActivityType } from "./activity-type-mapping";
import { getDateFnsPattern } from "./date-format-options";
import { normalizeInstrumentType, splitInstrumentPrefixedSymbol } from "./instrument-type";
import { buildImportAssetCandidateKey } from "./asset-review-utils";
import {
  parseNumericValue,
  parseSignedNumericValue,
  hasPositiveValue,
  hasNonZeroValue,
  resolveCashActivityFields,
} from "./review-draft-utils";
import type { DraftActivity, DraftActivityStatus } from "../context";
import {
  getAllowedActivityTypesForAccountType,
  isTransactionImportProfile,
  type ActivityImportProfile,
} from "./activity-import-profile";

// ---------------------------------------------------------------------------
// Skip sentinel — used in activity mappings to exclude rows from import
// ---------------------------------------------------------------------------

/** Sentinel value for activity types the user chooses to skip during import. */
export const ACTIVITY_SKIP = "_SKIP_";
const IMPORTABLE_ACTIVITY_TYPES = new Set<string>(
  Object.values(ActivityType).filter((type) => type !== ActivityType.UNKNOWN),
);

// ---------------------------------------------------------------------------
// Fallback-column helpers — support `string | string[]` in fieldMappings
// ---------------------------------------------------------------------------

/** Return the first (primary) header name, or undefined. */
export function primaryHeader(value: string | string[] | undefined): string | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/** True when at least one listed header exists in `headers`. */
export function isFieldMapped(value: string | string[] | undefined, headers: string[]): boolean {
  if (!value) return false;
  if (Array.isArray(value)) return value.some((h) => headers.includes(h));
  return headers.includes(value);
}

export function mergeIssueMaps(
  current: Record<string, string[]>,
  incoming: Record<string, string[]>,
): Record<string, string[]> {
  const merged: Record<string, string[]> = { ...current };
  for (const [key, messages] of Object.entries(incoming)) {
    const existing = merged[key] ?? [];
    const next = [...existing];
    for (const message of messages) {
      if (!next.includes(message)) {
        next.push(message);
      }
    }
    merged[key] = next;
  }
  return merged;
}

export function hasDuplicateWarning(draft: DraftActivity): boolean {
  const hasDuplicateLineNumber = typeof draft.duplicateOfLineNumber === "number";
  return Boolean(
    draft.duplicateOfId || hasDuplicateLineNumber || draft.warnings?._duplicate?.length,
  );
}

/**
 * Parse a date value using the configured format (priority) then auto-detection fallback.
 * Returns a full ISO datetime string preserving any time component from the source.
 */
export function parseDateValue(value: string | undefined, dateFormat: string): string {
  if (!value || value.trim() === "") return "";

  const trimmed = value.trim();

  // 1. If user specified a format, try it first
  const pattern = getDateFnsPattern(dateFormat);
  if (pattern) {
    try {
      const parsed = parse(trimmed, pattern, new Date());
      if (isValid(parsed)) return parsed.toISOString();
    } catch {
      // fall through to auto-detection
    }
  }

  // 2. For ISO8601 preset, try parseISO directly
  if (dateFormat === "ISO8601") {
    try {
      const parsed = parseISO(trimmed);
      if (isValid(parsed)) return parsed.toISOString();
    } catch {
      // fall through
    }
  }

  // 3. Auto-detection fallback (handles 80+ formats)
  const autoDetected = tryParseDate(trimmed);
  if (autoDetected) return autoDetected.toISOString();

  // 4. Return as-is if nothing works (will surface as validation error)
  return trimmed;
}

/**
 * Map a CSV activity type value to a Wealthfolio activity type.
 * Returns only explicit user/template mappings.
 */
export function mapActivityType(
  csvValue: string | undefined,
  activityMappings: Record<string, string[]>,
): string | undefined {
  if (!csvValue) return undefined;
  return findMappedActivityType(csvValue, activityMappings) ?? undefined;
}

const SIGNED_FX_TRANSFER_LABELS = new Set([
  "FXEXCHANGE",
  "FXCONVERSION",
  "CURRENCYEXCHANGE",
  "CURRENCYCONVERSION",
  "FOREIGNEXCHANGE",
  "FOREIGNEXCHANGECONVERSION",
]);

const SIGNED_CASH_MOVEMENT_LABELS = new Set(["TRANSFER", "TRANSFERTF", "MONEYMOVEMENT"]);

const SIGNED_SECURITY_TRANSFER_LABELS = new Set(["INTERNALSECURITYTRANSFER"]);

const REIMBURSEMENT_LABELS = new Set([
  "REIMBURSEMENT",
  "REIMBURSED",
  "REIMBURSE",
  "EXPENSEREIMBURSEMENT",
]);

function normalizeSignAwareActivityLabel(value: string | undefined): string {
  return (
    value
      ?.trim()
      .toUpperCase()
      .replace(/[\s_-]+/g, "") ?? ""
  );
}

function inferSignedFxTransferType(
  csvValue: string | undefined,
  signedAmount: string | undefined,
): typeof ActivityType.TRANSFER_IN | typeof ActivityType.TRANSFER_OUT | undefined {
  if (!SIGNED_FX_TRANSFER_LABELS.has(normalizeSignAwareActivityLabel(csvValue))) {
    return undefined;
  }

  if (signedAmount == null) return undefined;
  const amount = Number(signedAmount);
  if (!Number.isFinite(amount) || amount === 0) return undefined;

  return amount < 0 ? ActivityType.TRANSFER_OUT : ActivityType.TRANSFER_IN;
}

function signedDirection(value: string | undefined): "positive" | "negative" | undefined {
  if (value == null) return undefined;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount === 0) return undefined;
  return amount < 0 ? "negative" : "positive";
}

const BUY_POSITION_INTENT_ALIASES = [
  ...POSITION_INTENT_ALIASES[ActivityType.BUY][ACTIVITY_SUBTYPES.POSITION_OPEN],
  ...POSITION_INTENT_ALIASES[ActivityType.BUY][ACTIVITY_SUBTYPES.POSITION_CLOSE],
] as readonly string[];
const SELL_POSITION_INTENT_ALIASES = [
  ...POSITION_INTENT_ALIASES[ActivityType.SELL][ACTIVITY_SUBTYPES.POSITION_OPEN],
  ...POSITION_INTENT_ALIASES[ActivityType.SELL][ACTIVITY_SUBTYPES.POSITION_CLOSE],
] as readonly string[];

function inferTradeTypeFromPositionIntentSubtype(
  subtypeValue: string | undefined,
): typeof ActivityType.BUY | typeof ActivityType.SELL | undefined {
  const subtype = normalizeSignAwareActivityLabel(subtypeValue);
  if (BUY_POSITION_INTENT_ALIASES.includes(subtype)) {
    return ActivityType.BUY;
  }
  if (SELL_POSITION_INTENT_ALIASES.includes(subtype)) {
    return ActivityType.SELL;
  }
  return undefined;
}

function inferSignedTradeType(
  csvValue: string | undefined,
  subtypeValue: string | undefined,
  signedQuantity: string | undefined,
  signedAmount: string | undefined,
): typeof ActivityType.BUY | typeof ActivityType.SELL | undefined {
  if (normalizeSignAwareActivityLabel(csvValue) !== "TRADE") {
    return undefined;
  }

  const subtype = normalizeSignAwareActivityLabel(subtypeValue);
  if (subtype === "BUY" || subtype === "DRIP") return ActivityType.BUY;
  if (subtype === "SELL") return ActivityType.SELL;
  const positionIntentType = inferTradeTypeFromPositionIntentSubtype(subtypeValue);
  if (positionIntentType) return positionIntentType;

  const quantityDirection = signedDirection(signedQuantity);
  if (quantityDirection) {
    return quantityDirection === "negative" ? ActivityType.SELL : ActivityType.BUY;
  }

  const amountDirection = signedDirection(signedAmount);
  if (!amountDirection) return undefined;
  return amountDirection === "positive" ? ActivityType.SELL : ActivityType.BUY;
}

function inferSignedCashMovementType(
  csvValue: string | undefined,
  signedAmount: string | undefined,
  mappedActivityType: string | undefined,
): typeof ActivityType.DEPOSIT | typeof ActivityType.WITHDRAWAL | undefined {
  if (!SIGNED_CASH_MOVEMENT_LABELS.has(normalizeSignAwareActivityLabel(csvValue))) {
    return undefined;
  }
  if (
    mappedActivityType !== ActivityType.DEPOSIT &&
    mappedActivityType !== ActivityType.WITHDRAWAL
  ) {
    return undefined;
  }

  const direction = signedDirection(signedAmount);
  if (!direction) return undefined;
  return direction === "negative" ? ActivityType.WITHDRAWAL : ActivityType.DEPOSIT;
}

function inferSignedSecurityTransferType(
  csvValue: string | undefined,
  signedQuantity: string | undefined,
  signedAmount: string | undefined,
): typeof ActivityType.TRANSFER_IN | typeof ActivityType.TRANSFER_OUT | undefined {
  if (!SIGNED_SECURITY_TRANSFER_LABELS.has(normalizeSignAwareActivityLabel(csvValue))) {
    return undefined;
  }

  const direction = signedDirection(signedQuantity) ?? signedDirection(signedAmount);
  if (!direction) return undefined;
  return direction === "negative" ? ActivityType.TRANSFER_OUT : ActivityType.TRANSFER_IN;
}

/**
 * Map a CSV symbol to a resolved symbol, optionally with exchange MIC and name metadata
 */
export function mapSymbol(
  csvSymbol: string | undefined,
  symbolMappings: Record<string, string>,
  symbolMappingMeta?: Record<
    string,
    {
      exchangeMic?: string;
      symbolName?: string;
      quoteCcy?: string;
      instrumentType?: string;
      quoteMode?: string;
      providerId?: string;
      providerSymbol?: string;
    }
  >,
): {
  symbol: string | undefined;
  exchangeMic?: string;
  symbolName?: string;
  quoteCcy?: string;
  instrumentType?: string;
  quoteMode?: string;
  providerId?: string;
  providerSymbol?: string;
} {
  if (!csvSymbol) return { symbol: undefined };

  const trimmed = csvSymbol.trim();
  const symbol = symbolMappings[trimmed] || trimmed;
  const meta = symbolMappingMeta?.[trimmed];
  return {
    symbol,
    exchangeMic: meta?.exchangeMic,
    symbolName: meta?.symbolName,
    quoteCcy: meta?.quoteCcy,
    instrumentType: meta?.instrumentType,
    quoteMode: meta?.quoteMode,
    providerId: meta?.providerId,
    providerSymbol: meta?.providerSymbol,
  };
}

/**
 * Validate a draft activity and return errors/warnings
 */
export function validateDraft(
  draft: Partial<DraftActivity>,
  accountTypeById?: Map<string, string>,
): {
  status: DraftActivityStatus;
  errors: Record<string, string[]>;
  warnings: Record<string, string[]>;
} {
  const errors: Record<string, string[]> = {};
  const warnings: Record<string, string[]> = {};

  const activityType = draft.activityType?.toUpperCase();
  const subtype = draft.subtype?.trim().toUpperCase();

  // Required field validation
  if (!draft.activityDate) {
    errors.activityDate = ["Date is required"];
  }

  if (!draft.activityType) {
    errors.activityType = ["Activity type is required"];
  } else if (!IMPORTABLE_ACTIVITY_TYPES.has(draft.activityType.toUpperCase() as ActivityType)) {
    errors.activityType = ["Map the CSV activity type before continuing"];
  }

  // SPLIT is a ratio event — currency is not meaningful
  if (!draft.currency && activityType !== ActivityType.SPLIT) {
    errors.currency = ["Currency is required"];
  }

  if (!draft.accountId) {
    errors.accountId = ["Account is required"];
  }

  const accountType = draft.accountId ? accountTypeById?.get(draft.accountId) : undefined;
  const allowedActivityTypes = new Set(getAllowedActivityTypesForAccountType(accountType));
  if (
    accountType === AccountType.CREDIT_CARD &&
    activityType &&
    !allowedActivityTypes.has(activityType as ActivityType)
  ) {
    errors.activityType = [
      ...(errors.activityType ?? []),
      "Credit card imports only support charges, payments, refunds, fees, and interest",
    ];
  }

  // Trade activities (BUY/SELL)
  if (activityType === ActivityType.BUY || activityType === ActivityType.SELL) {
    if (!draft.symbol) {
      errors.symbol = ["Symbol is required for trade activities"];
    }
    if (!hasPositiveValue(draft.quantity)) {
      errors.quantity = ["Quantity must be greater than 0"];
    }
    if (!hasPositiveValue(draft.unitPrice)) {
      errors.unitPrice = ["Unit price must be greater than 0"];
    }
  }

  // DIVIDEND validation
  if (activityType === ActivityType.DIVIDEND) {
    if (subtype === ACTIVITY_SUBTYPES.DRIP) {
      // DRIP: cash dividend → reinvested as BUY of same ticker
      // Needs: symbol, quantity, and either amount or unit price.
      if (!draft.symbol) {
        errors.symbol = ["Symbol is required for DRIP dividends"];
      }
      if (!hasPositiveValue(draft.quantity)) {
        errors.quantity = ["Quantity is required for DRIP (shares received)"];
      }
      if (!hasNonZeroValue(draft.amount) && !hasPositiveValue(draft.unitPrice)) {
        errors.unitPrice = ["Either amount or unit price is required for DRIP dividends"];
      }
    } else if (subtype === ACTIVITY_SUBTYPES.DIVIDEND_IN_KIND) {
      // DIVIDEND_IN_KIND: dividend paid as additional units of the same asset
      // Needs: symbol, quantity, and either amount or unit price.
      if (!draft.symbol) {
        errors.symbol = ["Symbol is required for dividend in kind activities"];
      }
      if (!hasPositiveValue(draft.quantity)) {
        errors.quantity = ["Quantity is required for dividend in kind (shares received)"];
      }
      if (!hasNonZeroValue(draft.amount) && !hasPositiveValue(draft.unitPrice)) {
        errors.unitPrice = ["Either amount or unit price is required for dividend in kind"];
      }
    } else {
      // Regular cash dividend - amount is required
      if (!hasNonZeroValue(draft.amount)) {
        errors.amount = ["Amount is required for dividend activities"];
      }
    }
  }

  // INTEREST validation
  if (activityType === ActivityType.INTEREST) {
    // STAKING_REWARD - needs quantity (tokens received) and may have unit price
    if (subtype === ACTIVITY_SUBTYPES.STAKING_REWARD) {
      if (!draft.symbol) {
        errors.symbol = ["Symbol is required for staking rewards"];
      }
      if (!hasPositiveValue(draft.quantity)) {
        errors.quantity = ["Quantity is required for staking rewards (tokens received)"];
      }
      if (!hasNonZeroValue(draft.amount) && !hasPositiveValue(draft.unitPrice)) {
        errors.unitPrice = ["Either amount or unit price is required for staking rewards"];
      }
    } else {
      // Regular interest - amount is required
      if (!hasNonZeroValue(draft.amount)) {
        errors.amount = ["Amount is required for interest activities"];
      }
    }
  }

  // DEPOSIT/WITHDRAWAL - amount is required
  if (activityType === ActivityType.DEPOSIT || activityType === ActivityType.WITHDRAWAL) {
    if (!hasNonZeroValue(draft.amount)) {
      errors.amount = ["Amount is required for deposit/withdrawal activities"];
    }
  }

  // FEE validation - either fee or amount required
  if (activityType === ActivityType.FEE) {
    const hasFee = hasPositiveValue(draft.fee);
    const hasAmount = hasPositiveValue(draft.amount);
    if (!hasFee && !hasAmount) {
      errors.fee = ["Either fee or amount is required for fee activities"];
    }
  }

  // TAX validation - amount is required
  if (activityType === ActivityType.TAX) {
    const hasFee = hasPositiveValue(draft.fee);
    const hasAmount = hasPositiveValue(draft.amount);
    if (!hasFee && !hasAmount) {
      errors.amount = ["Amount or fee is required for tax activities"];
    }
  }

  // TRANSFER_IN/TRANSFER_OUT - amount or quantity required
  if (activityType === ActivityType.TRANSFER_IN || activityType === ActivityType.TRANSFER_OUT) {
    const hasAmount = hasPositiveValue(draft.amount);
    const hasQuantity = hasPositiveValue(draft.quantity);
    if (!hasAmount && !hasQuantity) {
      errors.amount = ["Amount or quantity is required for transfer activities"];
    }
  }

  // SPLIT validation
  if (activityType === ActivityType.SPLIT) {
    if (!draft.symbol) {
      errors.symbol = ["Symbol is required for split activities"];
    }
    if (!hasPositiveValue(draft.amount)) {
      errors.amount = ["Amount (split ratio) must be greater than 0"];
    }
  }

  // CREDIT validation
  if (activityType === ActivityType.CREDIT) {
    if (!hasNonZeroValue(draft.amount)) {
      errors.amount = ["Amount is required for credit activities"];
    }
  }

  // Determine status
  const hasErrors = Object.keys(errors).length > 0;
  const hasWarnings = Object.keys(warnings).length > 0;

  let status: DraftActivityStatus = "valid";
  if (hasErrors) {
    status = "error";
  } else if (hasWarnings) {
    status = "warning";
  }

  return { status, errors, warnings };
}
/**
 * Create DraftActivity objects from parsed CSV data and mapping
 */
export function createDraftActivities(
  parsedRows: string[][],
  headers: string[],
  mapping: {
    fieldMappings: Record<string, string | string[]>;
    activityMappings: Record<string, string[]>;
    symbolMappings: Record<string, string>;
    accountMappings: Record<string, string>;
    symbolMappingMeta?: Record<
      string,
      {
        exchangeMic?: string;
        symbolName?: string;
        quoteCcy?: string;
        instrumentType?: string;
        quoteMode?: string;
        providerId?: string;
        providerSymbol?: string;
      }
    >;
  },
  parseConfig: {
    dateFormat: string;
    decimalSeparator: string;
    thousandsSeparator: string;
    defaultCurrency: string;
  },
  defaultAccountId: string,
  validAccountIds?: Set<string>,
  accountTypeById?: Map<string, string>,
  options?: { importProfile?: ActivityImportProfile },
): DraftActivity[] {
  const { fieldMappings, activityMappings, symbolMappings, accountMappings, symbolMappingMeta } =
    mapping;
  const { dateFormat, decimalSeparator, thousandsSeparator, defaultCurrency } = parseConfig;

  // Create header index lookup
  const headerIndex: Record<string, number> = {};
  headers.forEach((header, idx) => {
    headerIndex[header] = idx;
  });

  // Get column value — supports fallback columns when mapping is an array
  const getColumnValue = (row: string[], field: ImportFormat): string | undefined => {
    const csvHeader = fieldMappings[field];
    if (!csvHeader) return undefined;

    if (Array.isArray(csvHeader)) {
      for (const h of csvHeader) {
        const idx = headerIndex[h];
        if (idx !== undefined) {
          const val = row[idx]?.trim();
          if (val) return val;
        }
      }
      return undefined;
    }

    const idx = headerIndex[csvHeader];
    if (idx === undefined) return undefined;
    return row[idx];
  };

  return parsedRows.flatMap((row, rowIndex): DraftActivity[] => {
    // Extract raw values from CSV
    const rawDate = getColumnValue(row, ImportFormat.DATE);
    const rawType = getColumnValue(row, ImportFormat.ACTIVITY_TYPE);

    // Skip rows mapped to SKIP
    const preCheckType = mapActivityType(rawType, activityMappings);
    if (preCheckType === ACTIVITY_SKIP) return [];
    const ignoresAssetFields =
      options?.importProfile && isTransactionImportProfile(options.importProfile);
    const rawSymbol = ignoresAssetFields ? undefined : getColumnValue(row, ImportFormat.SYMBOL);
    const rawIsin = ignoresAssetFields ? undefined : getColumnValue(row, ImportFormat.ISIN);
    const rawQuantity = ignoresAssetFields ? undefined : getColumnValue(row, ImportFormat.QUANTITY);
    const rawUnitPrice = ignoresAssetFields
      ? undefined
      : getColumnValue(row, ImportFormat.UNIT_PRICE);
    const rawAmount = getColumnValue(row, ImportFormat.AMOUNT);
    const rawCurrency = getColumnValue(row, ImportFormat.CURRENCY);
    const rawFee = getColumnValue(row, ImportFormat.FEE);
    const rawTax = getColumnValue(row, ImportFormat.TAX);
    const rawComment = getColumnValue(row, ImportFormat.COMMENT);
    const rawAccount = getColumnValue(row, ImportFormat.ACCOUNT);
    const rawFxRate = getColumnValue(row, ImportFormat.FX_RATE);
    const rawSubtype = getColumnValue(row, ImportFormat.SUBTYPE);
    const rawInstrumentType = ignoresAssetFields
      ? undefined
      : getColumnValue(row, ImportFormat.INSTRUMENT_TYPE);

    // Parse and normalize values
    const activityDate = parseDateValue(rawDate, dateFormat);
    const signedAmount = parseSignedNumericValue(rawAmount, decimalSeparator, thousandsSeparator);
    const signedQuantity = parseSignedNumericValue(
      rawQuantity,
      decimalSeparator,
      thousandsSeparator,
    );
    const mappedActivityType = mapActivityType(rawType, activityMappings);
    const signedTradeType = inferSignedTradeType(rawType, rawSubtype, signedQuantity, signedAmount);
    const rawTypePositionIntentType = inferTradeTypeFromPositionIntentSubtype(rawType);
    const signedFxTransferType = inferSignedFxTransferType(rawType, signedAmount);
    const signedCashMovementType = inferSignedCashMovementType(
      rawType,
      signedAmount,
      mappedActivityType,
    );
    const signedSecurityTransferType = inferSignedSecurityTransferType(
      rawType,
      signedQuantity,
      signedAmount,
    );
    const activityType =
      signedTradeType ??
      rawTypePositionIntentType ??
      signedFxTransferType ??
      signedCashMovementType ??
      signedSecurityTransferType ??
      mappedActivityType;
    const {
      symbol: mappedSymbol,
      exchangeMic: mappedExchangeMic,
      symbolName: mappedSymbolName,
      quoteCcy: mappedQuoteCcy,
      instrumentType: mappedInstrumentType,
      quoteMode: mappedQuoteMode,
      providerId: mappedProviderId,
      providerSymbol: mappedProviderSymbol,
    } = mapSymbol(rawSymbol, symbolMappings, symbolMappingMeta);

    // Parse typed symbol prefixes (e.g., "bond:US037833DU14")
    const { symbol: prefixParsedSymbol, instrumentType: prefixInstrumentType } =
      splitInstrumentPrefixedSymbol(mappedSymbol);
    const symbol = prefixParsedSymbol;

    // Normalize instrument type: explicit CSV column > prefix > symbol mapping meta
    const normalizedCsvInstrumentType = normalizeInstrumentType(rawInstrumentType);
    const resolvedInstrumentType =
      normalizedCsvInstrumentType || prefixInstrumentType || mappedInstrumentType;
    const quantity = parseNumericValue(rawQuantity, decimalSeparator, thousandsSeparator);
    const unitPrice = parseNumericValue(rawUnitPrice, decimalSeparator, thousandsSeparator);
    let amount = parseNumericValue(rawAmount, decimalSeparator, thousandsSeparator);
    const rawCurrencyValue = rawCurrency?.trim();
    const currency = rawCurrencyValue || defaultCurrency;
    const currencySource = rawCurrencyValue ? "csv" : "default";
    const assetResolutionCurrency = rawCurrencyValue || undefined;
    const fee = parseNumericValue(rawFee, decimalSeparator, thousandsSeparator);
    let tax = parseNumericValue(rawTax, decimalSeparator, thousandsSeparator);
    const comment = rawComment?.trim();
    const fxRate = parseNumericValue(rawFxRate, decimalSeparator, thousandsSeparator);
    const signedFxSubtype = signedFxTransferType
      ? normalizeSignAwareActivityLabel(rawType)
      : undefined;
    const rawTypePositionIntentSubtype = rawTypePositionIntentType ? rawType : undefined;
    const trimmedRawSubtype = rawSubtype?.trim();
    const normalizedSubtype = trimmedRawSubtype || rawTypePositionIntentSubtype || signedFxSubtype;
    const inferredCreditSubtype =
      activityType === ActivityType.CREDIT &&
      (REIMBURSEMENT_LABELS.has(normalizeSignAwareActivityLabel(rawType)) ||
        REIMBURSEMENT_LABELS.has(normalizeSignAwareActivityLabel(rawSubtype)))
        ? ACTIVITY_SUBTYPES.REIMBURSEMENT
        : undefined;
    const canonicalSubtype =
      normalizedSubtype && normalizedSubtype.toUpperCase() !== activityType
        ? canonicalizeActivitySubtype(activityType ?? "", normalizedSubtype)
        : undefined;
    const subtype = inferredCreditSubtype ?? canonicalSubtype;

    // Resolve account ID: use CSV account mapping, or fall back to default
    let accountId = accountMappings[""] || defaultAccountId;
    if (rawAccount?.trim()) {
      const rawAccountId = rawAccount.trim();
      const mappedAccount =
        accountMappings[rawAccountId] ?? accountMappings[rawAccountId.toLowerCase()];
      if (mappedAccount) {
        accountId = mappedAccount;
      } else if (!validAccountIds || validAccountIds.has(rawAccountId)) {
        accountId = rawAccountId;
      }
    }

    // For cash-like activities, some brokers (e.g. Schwab) put the dollar value
    // in the Quantity column instead of Amount.
    if (
      activityType === ActivityType.TAX &&
      !hasPositiveValue(amount) &&
      !hasPositiveValue(fee) &&
      hasPositiveValue(tax)
    ) {
      amount = tax;
      tax = undefined;
    }
    const resolved = resolveCashActivityFields(activityType, quantity, amount, unitPrice, subtype);

    // Infer isExternal for transfers: external unless the raw CSV label says "INTERNAL"
    const isTransfer =
      activityType === ActivityType.TRANSFER_IN || activityType === ActivityType.TRANSFER_OUT;
    const isExternal = isTransfer
      ? signedFxTransferType
        ? false
        : !rawType?.trim().toUpperCase().includes("INTERNAL")
      : undefined;

    // Create draft object
    const draft: Partial<DraftActivity> = {
      rowIndex,
      rawRow: row,
      activityDate,
      activityType,
      symbol,
      isin: rawIsin?.trim() || undefined,
      exchangeMic: mappedExchangeMic,
      symbolName: mappedSymbolName,
      quoteCcy: mappedQuoteCcy,
      instrumentType: resolvedInstrumentType,
      quoteMode: mappedQuoteMode,
      providerId: mappedProviderId,
      providerSymbol: mappedProviderSymbol,
      assetCandidateKey:
        symbol && activityType
          ? buildImportAssetCandidateKey({
              accountId,
              symbol,
              instrumentType: resolvedInstrumentType,
              quoteMode: mappedQuoteMode,
              quoteCcy: mappedQuoteCcy || assetResolutionCurrency,
              exchangeMic: mappedExchangeMic,
              isin: rawIsin?.trim() || undefined,
            })
          : undefined,
      quantity: resolved.quantity,
      unitPrice,
      amount: resolved.amount,
      currency,
      currencySource,
      fee,
      tax,
      fxRate,
      subtype,
      isExternal,
      accountId,
      comment,
      isEdited: false,
    };

    // Validate and get status
    const validation = validateDraft(draft, accountTypeById);

    return [
      {
        ...draft,
        status: validation.status,
        errors: validation.errors,
        warnings: validation.warnings,
      } as DraftActivity,
    ];
  });
}

export function draftToActivityImport(draft: DraftActivity): ActivityImport {
  const activityType = draft.activityType?.trim().toUpperCase();
  const subtype = canonicalizeActivitySubtype(draft.activityType ?? "", draft.subtype?.trim());
  const isTransfer =
    activityType === ActivityType.TRANSFER_IN || activityType === ActivityType.TRANSFER_OUT;

  return {
    id: undefined,
    accountId: draft.accountId,
    assetId: draft.assetId,
    currency: draft.currencySource === "default" ? "" : (draft.currency ?? ""),
    activityType: draft.activityType as ActivityImport["activityType"],
    date: draft.activityDate,
    symbol: draft.symbol ?? "",
    symbolName: draft.symbolName,
    amount: draft.amount,
    quantity: draft.quantity,
    unitPrice: draft.unitPrice,
    fee: draft.fee,
    tax: draft.tax,
    fxRate: draft.fxRate,
    subtype: subtype && subtype.toUpperCase() !== activityType ? subtype : undefined,
    exchangeMic: draft.exchangeMic,
    quoteCcy: draft.quoteCcy,
    instrumentType: draft.instrumentType,
    quoteMode: draft.quoteMode as ActivityImport["quoteMode"],
    providerId: draft.providerId,
    providerSymbol: draft.providerSymbol,
    errors: draft.errors,
    isValid:
      draft.status === "valid" ||
      draft.status === "warning" ||
      (draft.status === "duplicate" && !!draft.forceImport),
    lineNumber: draft.rowIndex + 1,
    isDraft: false,
    comment: draft.comment,
    forceImport: draft.forceImport ?? false,
    isExternal: isTransfer ? draft.isExternal : undefined,
  };
}
