import * as z from "zod";
import {
  AccountType,
  accountTypeSchema,
  ActivityType,
  activityTypeSchema,
  quoteModeSchema,
} from "./constants";
import { tryParseDate } from "./utils";
import {
  isCashActivity,
  isIncomeActivity,
  isCashTransfer,
  isTradeActivity,
  isFeeActivity,
  isSplitActivity,
} from "./activity-utils";

/**
 * Configuration for CSV parsing (delimiter, date format, etc.)
 */
export const parseConfigSchema = z.object({
  /** Whether the CSV has a header row */
  hasHeaderRow: z.boolean().optional(),
  /** Index of the header row (0-based) */
  headerRowIndex: z.number().optional(),
  /** Column delimiter: ",", ";", "\t", or "auto" */
  delimiter: z.string().optional(),
  /** Quote character for fields */
  quoteChar: z.string().optional(),
  /** Number of rows to skip at the top (after header) */
  skipTopRows: z.number().optional(),
  /** Number of rows to skip at the bottom */
  skipBottomRows: z.number().optional(),
  /** Whether to skip empty rows */
  skipEmptyRows: z.boolean().optional(),
  /** Date format: "auto", "YYYY-MM-DD", "DD/MM/YYYY", etc. */
  dateFormat: z.string().optional(),
  /** Decimal separator: "auto", ".", or "," */
  decimalSeparator: z.string().optional(),
  /** Thousands separator: "auto", ",", ".", " ", or "none" */
  thousandsSeparator: z.string().optional(),
  /** Default currency to use when not specified in CSV */
  defaultCurrency: z.string().optional(),
});

export const ImportType = {
  ACTIVITY: "CSV_ACTIVITY",
  HOLDINGS: "CSV_HOLDINGS",
} as const;
export type ImportType = (typeof ImportType)[keyof typeof ImportType];

export const importMappingSchema = z.object({
  accountId: z.string(),
  importType: z.enum([ImportType.ACTIVITY, ImportType.HOLDINGS]).default(ImportType.ACTIVITY),
  templateId: z.string().optional(),
  name: z.string().optional().default(""),
  fieldMappings: z
    .record(z.string(), z.union([z.string(), z.array(z.string())]))
    .optional()
    .default({}),
  activityMappings: z.record(z.string(), z.array(z.string())).optional().default({}),
  symbolMappings: z.record(z.string(), z.string()).optional().default({}),
  accountMappings: z.record(z.string(), z.string()).optional().default({}),
  /** Rich metadata for resolved symbol mappings (exchange MIC, display name) */
  symbolMappingMeta: z
    .record(
      z.string(),
      z.object({
        exchangeMic: z.string().optional(),
        symbolName: z.string().optional(),
        quoteCcy: z.string().optional(),
        instrumentType: z.string().optional(),
        quoteMode: quoteModeSchema.optional(),
        providerId: z.string().optional(),
        providerSymbol: z.string().optional(),
      }),
    )
    .optional(),
  /** CSV parsing configuration */
  parseConfig: parseConfigSchema.optional(),
});

export const trackingModeSchema = z.enum(["TRANSACTIONS", "HOLDINGS", "NOT_SET"]);

export const newAccountSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z
      .string()
      .min(2, {
        message: "Name must be at least 2 characters.",
      })
      .max(50, {
        message: "Name must not be longer than 50 characters.",
      }),
    group: z.string().optional(),
    isDefault: z.boolean().optional(),
    isActive: z.boolean().optional(),
    isArchived: z.boolean().optional().default(false),
    accountType: accountTypeSchema,
    currency: z.string({ required_error: "Please select a currency." }),
    trackingMode: trackingModeSchema.optional().default("NOT_SET"),
    meta: z.string().nullable().optional(),
  })
  .refine(
    (data) => data.accountType !== AccountType.CREDIT_CARD || data.trackingMode !== "HOLDINGS",
    {
      message: "Credit card accounts cannot use holdings tracking mode.",
      path: ["trackingMode"],
    },
  );

export const newGoalSchema = z.object({
  id: z.string().uuid().optional(),
  goalType: z.enum([
    "retirement",
    "education",
    "wedding",
    "home",
    "emergency_fund",
    "custom_save_up",
  ]),
  title: z.string(),
  description: z.string().optional(),
  targetAmount: z.coerce
    .number({
      required_error: "Please enter a valid target amount.",
      invalid_type_error: "Target amount must be a positive number.",
    })
    .min(0, { message: "Target amount must be a positive number." }),
  coverImageKey: z.string().optional(),
  currency: z.string().optional(),
  startDate: z.string().optional(),
  targetDate: z.string().optional(),
});

const parseNumberLike = (value: unknown): number | undefined => {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const decimalLikeSchema = z.union([
  z.number(),
  z.string().refine((val) => {
    const trimmed = val.trim();
    if (!trimmed) return false;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed);
  }),
]);

export const importActivitySchema = z
  .object({
    id: z.string().uuid().optional(),
    accountId: z.string().min(1, { message: "Please select an account." }),
    currency: z.string().optional(),
    activityType: activityTypeSchema,
    date: z
      .union([
        z.date(),
        z.string().refine((val) => tryParseDate(val) !== null, {
          message: "Invalid date format",
        }),
      ])
      .optional(),
    symbol: z
      .string()
      .optional()
      .refine(
        (val) => {
          if (!val || val.trim() === "") return true;
          return /^(?=.{1,100}$)(CASH:[A-Z]{3}|[A-Z0-9_]+([.-][A-Z0-9_]+){0,2})$/.test(val.trim());
        },
        { message: "Invalid symbol format" },
      ),
    amount: decimalLikeSchema.nullable().optional(),
    quantity: decimalLikeSchema.nullable().optional(),
    unitPrice: decimalLikeSchema.nullable().optional(),
    fee: decimalLikeSchema.nullable().optional(),
    tax: decimalLikeSchema.nullable().optional(),
    accountName: z.string().optional(),
    symbolName: z.string().optional(),
    /** Resolved exchange MIC for the symbol (populated during validation) */
    exchangeMic: z.string().optional(),
    /** Optional resolved quote currency hint for symbol identity (e.g., GBp). */
    quoteCcy: z.string().optional(),
    /** Optional resolved instrument type hint (e.g., EQUITY, CRYPTO). */
    instrumentType: z.string().optional(),
    /** Optional quote mode hint (e.g., MANUAL, MARKET). */
    quoteMode: quoteModeSchema.optional(),
    /** Market data provider that resolved this import row, if selected. */
    providerId: z.string().optional(),
    /** Provider-native symbol/code selected by search/import. */
    providerSymbol: z.string().optional(),
    /** ISIN identifier from the CSV (e.g. GB0007188757). Used for unambiguous exchange resolution. */
    isin: z.string().optional(),
    errors: z.record(z.string(), z.array(z.string())).optional(),
    warnings: z.record(z.string(), z.array(z.string())).optional(),
    duplicateOfId: z.string().optional(),
    duplicateOfLineNumber: z.number().optional(),
    assetId: z.string().optional(),
    isValid: z.boolean().default(false),
    lineNumber: z.number().optional(),
    isDraft: z.boolean(),
    comment: z.string().optional(),
    fxRate: decimalLikeSchema.nullable().optional(),
    subtype: z.string().optional(),
    forceImport: z.boolean().default(false),
    /** True when a TRANSFER_IN/OUT crosses the tracked-account boundary
     * (e.g. RSU grant deposit). Persisted as `metadata.flow.is_external` on the activity. */
    isExternal: z.boolean().optional(),
  })
  .refine(
    (data) => {
      const quantity = parseNumberLike(data.quantity);
      return quantity === undefined || quantity >= 0;
    },
    {
      message: "Quantity must be a non-negative number.",
      path: ["quantity"],
    },
  )
  .refine(
    (data) => {
      const unitPrice = parseNumberLike(data.unitPrice);
      return unitPrice === undefined || unitPrice >= 0;
    },
    {
      message: "Price must be a non-negative number.",
      path: ["unitPrice"],
    },
  )
  .refine(
    (data) => {
      const fee = parseNumberLike(data.fee);
      return fee === undefined || fee >= 0;
    },
    {
      message: "Fee must be a non-negative number.",
      path: ["fee"],
    },
  )
  .refine(
    (data) => {
      const tax = parseNumberLike(data.tax);
      return tax === undefined || tax >= 0;
    },
    {
      message: "Tax must be a non-negative number.",
      path: ["tax"],
    },
  )
  .refine(
    (data) => {
      const fxRate = parseNumberLike(data.fxRate);
      return fxRate === undefined || fxRate > 0;
    },
    {
      message: "FX rate must be a positive number.",
      path: ["fxRate"],
    },
  )
  .refine(
    (data) => {
      if (isCashActivity(data.activityType as string)) {
        return true;
      }

      return !!data.symbol?.trim();
    },
    {
      message: "Symbol is required for non-cash activities",
      path: ["symbol"],
    },
  )
  .refine(
    (data) => {
      // For cash activities, income activities or cash transfers, either amount or both quantity and unit price must be provided
      // Exclude FEE activities as they have their own validation rule
      const isCashOrIncomeActivity =
        (isCashActivity(data.activityType as string) && data.activityType !== ActivityType.FEE) ||
        isIncomeActivity(data.activityType as string) ||
        (data.symbol && isCashTransfer(data.activityType as string, data.symbol));

      if (isCashOrIncomeActivity) {
        const hasAmount = (parseNumberLike(data.amount) ?? 0) !== 0;
        const hasQuantity = (parseNumberLike(data.quantity) ?? 0) !== 0;
        const hasUnitPrice = (parseNumberLike(data.unitPrice) ?? 0) !== 0;

        // For cash activities, at least one of: amount, quantity, or unit price must be specified
        return hasAmount || hasQuantity || hasUnitPrice;
      }

      return true;
    },
    {
      message: "Cash activities require at least one of: amount, quantity, or unit price",
      path: ["amount"],
    },
  )
  .refine(
    (data) => {
      // Fee activity validations
      if (data.activityType === ActivityType.FEE) {
        const hasFee = (parseNumberLike(data.fee) ?? 0) !== 0;
        const hasAmount = (parseNumberLike(data.amount) ?? 0) !== 0;

        // For fee activities, at least one of: fee or amount must be specified
        return hasFee || hasAmount;
      }
      return true;
    },
    {
      message: "Fee activities require either fee or amount",
      path: ["fee"],
    },
  )
  .refine(
    (data) => {
      // Trade activity unit price validations
      if (isTradeActivity(data.activityType as string)) {
        const unitPrice = parseNumberLike(data.unitPrice);
        return unitPrice !== undefined && unitPrice > 0;
      }
      return true;
    },
    {
      message: "Unit price must be positive for buy/sell activities",
      path: ["unitPrice"],
    },
  )
  .refine(
    (data) => {
      const activityType = data.activityType;
      if (isSplitActivity(activityType)) {
        const amount = parseNumberLike(data.amount);
        return amount !== undefined && amount > 0;
      }
      return true;
    },
    {
      message: "Split ratio must be greater than 0",
      path: ["amount"],
    },
  )
  .refine(
    (data) => {
      // Non-cash, non-trade activities need positive quantity
      const isNonCashNonTradeActivity =
        !isCashActivity(data.activityType as string) &&
        !isIncomeActivity(data.activityType as string) &&
        !(data.symbol && isCashTransfer(data.activityType as string, data.symbol)) &&
        !isTradeActivity(data.activityType as string) &&
        !isFeeActivity(data.activityType as string) &&
        !isSplitActivity(data.activityType as string);

      if (isNonCashNonTradeActivity) {
        const quantity = parseNumberLike(data.quantity);
        return quantity !== undefined && quantity > 0;
      }
      return true;
    },
    {
      message: "Quantity must be positive for non-cash activities",
      path: ["quantity"],
    },
  );

export const newContributionLimitSchema = z.object({
  id: z.string().optional(),
  groupName: z.string().min(1, "Group name is required"),
  contributionYear: z.number().int().min(1900, "Invalid year"),
  limitAmount: z.coerce
    .number({
      required_error: "Please enter a valid limit amount.",
      invalid_type_error: "Limit amount must be a positive number.",
    })
    .min(0, { message: "Price must be a non-negative number." }),
  accountIds: z.string().nullable().optional(),
  startDate: z.union([z.date(), z.string().datetime(), z.null()]).optional(),
  endDate: z.union([z.date(), z.string().datetime(), z.null()]).optional(),
});
