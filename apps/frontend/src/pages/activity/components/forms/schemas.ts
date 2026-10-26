import { ActivityType, QuoteMode } from "@/lib/constants";
import { isoDateTimeSchema } from "@/lib/schemas";
import { invalidTypeError } from "@/lib/zod-errors";
import type { TFunction } from "i18next";
import { z } from "zod";

// Asset metadata schema for custom assets
export const assetMetadataSchema = z
  .object({
    name: z.string().nullable().optional(),
    kind: z.string().nullable().optional(),
    exchangeMic: z.string().nullable().optional(),
    providerId: z.string().nullable().optional(),
    providerSymbol: z.string().nullable().optional(),
  })
  .optional();

// Translated message helper: uses `t` when provided (runtime UI),
// otherwise falls back to the English source string (static export / tests).
type MsgFn = TFunction | undefined;
const msg = (t: MsgFn, key: string, en: string) => (t ? t(key) : en);

// Builds the activity schemas. `t` is optional so the exported static schemas
// keep English messages (used by tests, type inference and the assistant).
export const createActivitySchemas = (t?: TFunction) => {
  const currencyRequired = msg(t, "activity:form.err_currency_required", "Currency is required.");
  const feeNumber = invalidTypeError(
    msg(t, "activity:form.err_fee_number", "Fee must be a number."),
  );
  const feeNonNegative = msg(t, "activity:form.err_fee_non_negative", "Fee must be non-negative.");
  const taxNumber = invalidTypeError(
    msg(t, "activity:form.err_tax_number", "Tax must be a number."),
  );
  const taxNonNegative = msg(t, "activity:form.err_tax_non_negative", "Tax must be non-negative.");
  const amountPositiveNumber = invalidTypeError(
    msg(t, "activity:form.err_amount_positive_number", "Amount must be a positive number."),
  );
  const amountNonNegative = msg(
    t,
    "activity:form.err_amount_non_negative",
    "Amount must be non-negative.",
  );
  const amountGreaterThanZero = msg(
    t,
    "activity:form.err_amount_gt_zero",
    "Amount must be greater than 0.",
  );
  const selectSecurity = msg(t, "activity:form.err_select_security", "Please select a security.");

  const base = z.object({
    id: z.string().optional(),
    accountId: z.string().min(1, {
      message: msg(t, "activity:form.err_select_account", "Please select an account."),
    }),
    activityDate: z.union([z.date(), isoDateTimeSchema]).default(new Date()),
    currency: z.string({ error: currencyRequired }).min(1, { message: currencyRequired }),
    comment: z.string().optional().nullable(),
    subtype: z.string().optional().nullable(), // Semantic variation (DRIP, STAKING_REWARD, etc.)
    fxRate: z.coerce
      .number({
        error: invalidTypeError(
          msg(t, "activity:form.err_fxrate_number", "FX Rate must be a number."),
        ),
      })
      .positive({
        message: msg(t, "activity:form.err_fxrate_positive", "FX Rate must be positive."),
      })
      .optional()
      .nullable(),
    // Exchange MIC for canonical asset ID generation (e.g., "XNAS", "XTSE")
    exchangeMic: z.string().nullable().optional(),
    // Asset metadata for custom assets (name, etc.)
    assetMetadata: assetMetadataSchema,
    // Optional symbol-level quote currency hint from search/provider (e.g., "GBp")
    symbolQuoteCcy: z.string().nullable().optional(),
    // Optional symbol-level instrument type hint from search/provider (e.g., "EQUITY", "CRYPTO")
    symbolInstrumentType: z.string().nullable().optional(),
    // Existing asset id selected from symbol search, when available
    existingAssetId: z.string().nullable().optional(),
  });

  // Transfer schema: TRANSFER_IN/OUT supports both cash (amount) and securities (assetId + quantity + unitPrice)
  // Field-level validation is handled by the form component based on transferMode
  const transfer = base.extend({
    activityType: z.enum([ActivityType.TRANSFER_IN, ActivityType.TRANSFER_OUT]),
    transferMode: z.enum(["cash", "securities"]).default("cash"),
    isExternal: z.boolean().default(false),
    direction: z.enum(["in", "out"]).default("out"),
    toAccountId: z.string().optional(),
    amount: z.coerce
      .number({
        error: invalidTypeError(
          msg(t, "activity:form.err_amount_number", "Amount must be a number."),
        ),
      })
      .positive({ message: amountGreaterThanZero })
      .optional()
      .nullable(),
    sourceAmount: z.coerce
      .number({
        error: invalidTypeError(
          msg(t, "activity:form.err_sent_amount_number", "Sent amount must be a number."),
        ),
      })
      .positive({
        message: msg(
          t,
          "activity:form.err_sent_amount_gt_zero",
          "Sent amount must be greater than 0.",
        ),
      })
      .optional()
      .nullable(),
    destinationAmount: z.coerce
      .number({
        error: invalidTypeError(
          msg(t, "activity:form.err_received_amount_number", "Received amount must be a number."),
        ),
      })
      .positive({
        message: msg(
          t,
          "activity:form.err_received_amount_gt_zero",
          "Received amount must be greater than 0.",
        ),
      })
      .optional()
      .nullable(),
    transferRate: z.coerce
      .number()
      .positive({
        message: msg(
          t,
          "activity:form.err_transfer_rate_gt_zero",
          "Transfer exchange rate must be greater than 0.",
        ),
      })
      .optional()
      .nullable(),
    sourceCurrency: z.string().optional(),
    destinationCurrency: z.string().optional(),
    fee: z.coerce.number({ error: feeNumber }).min(0, { message: feeNonNegative }).optional(),
    assetId: z.string().optional().nullable(),
    quantity: z.coerce
      .number({
        error: invalidTypeError(
          msg(t, "activity:form.err_quantity_number", "Quantity must be a number."),
        ),
      })
      .positive({
        message: msg(t, "activity:form.err_quantity_gt_zero", "Quantity must be greater than 0."),
      })
      .optional()
      .nullable(),
    unitPrice: z.coerce
      .number({
        error: invalidTypeError(
          msg(t, "activity:form.err_cost_basis_number", "Cost basis must be a number."),
        ),
      })
      .positive({
        message: msg(
          t,
          "activity:form.err_cost_basis_gt_zero",
          "Cost basis must be greater than 0.",
        ),
      })
      .optional()
      .nullable(),
    quoteMode: z.enum([QuoteMode.MARKET, QuoteMode.MANUAL]).default(QuoteMode.MARKET),
    metadata: z
      .object({
        flow: z.object({
          is_external: z.boolean(),
        }),
      })
      .optional(),
  });

  const bulkHoldingRow = z
    .object({
      id: z.string(),
      ticker: z.string().min(1, {
        message: msg(t, "activity:form.err_ticker_required", "Ticker is required"),
      }),
      canonicalSymbol: z.string().optional(),
      name: z.string().optional(),
      sharesOwned: z.coerce
        .number({
          error: invalidTypeError(
            msg(t, "activity:form.err_shares_number", "Shares must be a number."),
          ),
        })
        .positive({
          message: msg(t, "activity:form.err_shares_gt_zero", "Shares must be greater than 0"),
        }),
      averageCost: z.coerce
        .number({
          error: invalidTypeError(
            msg(t, "activity:form.err_average_cost_number", "Average cost must be a number."),
          ),
        })
        .positive({
          message: msg(
            t,
            "activity:form.err_average_cost_gt_zero",
            "Average cost must be greater than 0",
          ),
        }),
      totalValue: z.number().optional(),
      assetId: z.string().optional(),
      quoteMode: z.enum([QuoteMode.MARKET, QuoteMode.MANUAL]).optional(),
      // Exchange MIC for canonical asset ID generation (e.g., "XNAS", "XTSE")
      exchangeMic: z.string().optional(),
      // Optional symbol-level quote currency hint from search/provider (e.g., "USD")
      symbolQuoteCcy: z.string().optional(),
      // Optional symbol-level instrument type hint from search/provider (e.g., "EQUITY")
      symbolInstrumentType: z.string().optional(),
      providerId: z.string().optional(),
      providerSymbol: z.string().optional(),
      // Optional asset kind for custom assets (e.g., "INVESTMENT", "OTHER")
      assetKind: z.string().optional(),
    })
    .superRefine((row, ctx) => {
      if ((row.quoteMode ?? QuoteMode.MARKET) === QuoteMode.MARKET && !row.symbolQuoteCcy?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ticker"],
          message: msg(
            t,
            "activity:form.err_select_symbol_from_search",
            "Please select the symbol from search so quote currency is populated.",
          ),
        });
      }
    });

  const bulkHoldingsForm = base.extend({
    holdings: z.array(bulkHoldingRow).min(1, {
      message: msg(t, "activity:form.err_at_least_one_holding", "At least one holding is required"),
    }),
  });

  // NOTE: Option fields are `.optional()` here. Option field validation is
  // enforced at runtime:
  //   - Desktop: `buyFormSchema`/`sellFormSchema` have their own `.superRefine()`
  //   - Mobile: `validateTradeFields()` in the submit handler
  const trade = base.extend({
    activityType: z.enum([ActivityType.BUY, ActivityType.SELL]),
    assetId: z.string().default(""), // Relaxed: options build OCC symbol at submit
    quantity: z.coerce
      .number({
        error: invalidTypeError(
          msg(t, "activity:form.err_quantity_number", "Quantity must be a number."),
        ),
      })
      .positive({
        message: msg(t, "activity:form.err_quantity_gt_zero", "Quantity must be greater than 0."),
      }),
    unitPrice: z.coerce
      .number({
        error: invalidTypeError(
          msg(t, "activity:form.err_price_number", "Price must be a number."),
        ),
      })
      .positive({
        message: msg(t, "activity:form.err_price_gt_zero", "Price must be greater than 0."),
      }),
    amount: z.coerce.number().min(0, { message: amountNonNegative }).optional(),
    fee: z.coerce.number({ error: feeNumber }).min(0, { message: feeNonNegative }).default(0),
    tax: z.coerce.number({ error: taxNumber }).min(0, { message: taxNonNegative }).default(0),
    quoteMode: z.enum([QuoteMode.MARKET, QuoteMode.MANUAL]).default(QuoteMode.MARKET),
    // Asset type selection (stock/option/bond)
    assetType: z.enum(["stock", "option", "bond"]).default("stock"),
    assetKind: z.string().optional(),
    // Option-specific fields
    underlyingSymbol: z.string().optional(),
    strikePrice: z.coerce
      .number()
      .positive({
        message: msg(t, "activity:form.err_strike_gt_zero", "Strike price must be greater than 0."),
      })
      .optional(),
    expirationDate: z.string().optional(),
    optionType: z.enum(["CALL", "PUT"]).optional(),
    contractMultiplier: z.coerce
      .number({
        error: invalidTypeError(
          msg(t, "activity:form.err_multiplier_number", "Contract multiplier must be a number."),
        ),
      })
      .positive({
        message: msg(
          t,
          "activity:form.err_multiplier_gt_zero",
          "Contract multiplier must be greater than 0.",
        ),
      })
      .optional(),
  });

  // Cash activity schema - DEPOSIT/WITHDRAWAL only
  // TRANSFER_IN/TRANSFER_OUT are handled by the transfer schema
  const cash = base.extend({
    activityType: z.enum([ActivityType.DEPOSIT, ActivityType.WITHDRAWAL]),
    assetId: z.string().optional(),
    amount: z.coerce.number({ error: amountPositiveNumber }).min(0, { message: amountNonNegative }),
    fee: z.coerce.number({ error: feeNumber }).min(0, { message: feeNonNegative }).optional(),
    quoteMode: z.enum([QuoteMode.MARKET, QuoteMode.MANUAL]).default(QuoteMode.MANUAL),
  });

  const income = base.extend({
    activityType: z.enum([ActivityType.DIVIDEND, ActivityType.INTEREST]),
    assetId: z.string().min(1, { message: selectSecurity }).optional(),
    // No .positive() on unitPrice: cash records persist quantity/unitPrice as 0,
    // so a top-level check would reject edits over these hidden fields. Positivity
    // for asset-backed subtypes is enforced by validateAssetBackedIncomeFields.
    quantity: z.coerce.number().default(0),
    unitPrice: z.coerce.number().optional(),
    amount: z.coerce.number({ error: amountPositiveNumber }).min(0, { message: amountNonNegative }),
    fee: z.coerce.number({ error: feeNumber }).min(0, { message: feeNonNegative }).optional(),
    tax: z.coerce.number({ error: taxNumber }).min(0, { message: taxNonNegative }).optional(),
  });

  const other = base.extend({
    activityType: z.enum([ActivityType.SPLIT, ActivityType.TAX, ActivityType.FEE]),
    assetId: z.string().min(1, { message: selectSecurity }).optional(),
    amount: z.coerce.number().min(0, { message: amountNonNegative }).optional(),
    quantity: z.coerce.number().nonnegative().optional(),
    fee: z.coerce.number({ error: feeNumber }).min(0, { message: feeNonNegative }).optional(),
  });

  const credit = base.extend({
    activityType: z.enum([ActivityType.CREDIT]),
    amount: z.coerce.number({ error: amountPositiveNumber }).min(0, { message: amountNonNegative }),
    fee: z.coerce.number({ error: feeNumber }).min(0, { message: feeNonNegative }).optional(),
    quoteMode: z.enum([QuoteMode.MARKET, QuoteMode.MANUAL]).default(QuoteMode.MANUAL),
  });

  const adjustment = base.extend({
    activityType: z.enum([ActivityType.ADJUSTMENT]),
    assetId: z.string().optional(),
    quantity: z.coerce.number().nonnegative().optional().nullable(),
    unitPrice: z.coerce.number().nonnegative().optional().nullable(),
    amount: z.coerce.number().optional().nullable(),
    fee: z.coerce.number({ error: feeNumber }).min(0, { message: feeNonNegative }).optional(),
    quoteMode: z.enum([QuoteMode.MARKET, QuoteMode.MANUAL]).default(QuoteMode.MARKET),
  });

  const newActivity = z
    .discriminatedUnion("activityType", [trade, cash, income, other, credit, adjustment, transfer])
    .and(
      z.object({
        showCurrencySelect: z.boolean().optional(),
      }),
    )
    .superRefine((activity, ctx) => {
      if (activity.activityType !== ActivityType.ADJUSTMENT || activity.assetId?.trim()) return;

      const amount = Number(activity.amount);
      if (Number.isFinite(amount) && amount > 0) return;

      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: activity.amount == null ? ["assetId"] : ["amount"],
        message: activity.amount == null ? selectSecurity : amountGreaterThanZero,
      });
    });

  return {
    base,
    transfer,
    bulkHoldingRow,
    bulkHoldingsForm,
    trade,
    cash,
    income,
    other,
    credit,
    adjustment,
    newActivity,
  };
};

const englishSchemas = createActivitySchemas();

export const baseActivitySchema = englishSchemas.base;
export const transferActivitySchema = englishSchemas.transfer;
export const bulkHoldingRowSchema = englishSchemas.bulkHoldingRow;
export const bulkHoldingsFormSchema = englishSchemas.bulkHoldingsForm;
export const tradeActivitySchema = englishSchemas.trade;
export const cashActivitySchema = englishSchemas.cash;
export const incomeActivitySchema = englishSchemas.income;
export const otherActivitySchema = englishSchemas.other;
export const creditActivitySchema = englishSchemas.credit;
export const adjustmentActivitySchema = englishSchemas.adjustment;
export const newActivitySchema = englishSchemas.newActivity;

export type NewActivityFormValues = z.infer<typeof newActivitySchema>;
