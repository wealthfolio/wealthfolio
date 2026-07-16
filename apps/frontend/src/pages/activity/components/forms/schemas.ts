import { ActivityType, QuoteMode } from "@/lib/constants";
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

export const baseActivitySchema = z.object({
  id: z.string().optional(),
  accountId: z.string().min(1, { message: "Please select an account." }),
  activityDate: z.union([z.date(), z.string().datetime()]).default(new Date()),
  currency: z.string().min(1, { message: "Currency is required." }),
  comment: z.string().optional().nullable(),
  subtype: z.string().optional().nullable(), // Semantic variation (DRIP, STAKING_REWARD, etc.)
  fxRate: z.coerce
    .number()
    .positive({ message: "FX rate must be a positive number." })
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
export const transferActivitySchema = baseActivitySchema.extend({
  activityType: z.enum([ActivityType.TRANSFER_IN, ActivityType.TRANSFER_OUT]),
  transferMode: z.enum(["cash", "securities"]).default("cash"),
  isExternal: z.boolean().default(false),
  direction: z.enum(["in", "out"]).default("out"),
  toAccountId: z.string().optional(),
  amount: z.coerce.number().positive().optional().nullable(),
  sourceAmount: z.coerce.number().positive().optional().nullable(),
  destinationAmount: z.coerce.number().positive().optional().nullable(),
  sourceCurrency: z.string().optional(),
  destinationCurrency: z.string().optional(),
  fee: z.coerce.number().min(0).default(0).optional(),
  assetId: z.string().optional().nullable(),
  quantity: z.coerce.number().positive().optional().nullable(),
  unitPrice: z.coerce.number().positive().optional().nullable(),
  quoteMode: z.enum([QuoteMode.MARKET, QuoteMode.MANUAL]).default(QuoteMode.MARKET),
  metadata: z
    .object({
      flow: z.object({
        is_external: z.boolean(),
      }),
    })
    .optional(),
});

export const bulkHoldingRowSchema = z
  .object({
    id: z.string(),
    ticker: z.string().min(1, { message: "Ticker is required" }),
    name: z.string().optional(),
    sharesOwned: z.coerce
      .number({
        required_error: "Shares owned is required.",
        invalid_type_error: "Shares must be a number.",
      })
      .positive({ message: "Shares must be greater than 0" }),
    averageCost: z.coerce
      .number({
        required_error: "Average cost is required.",
        invalid_type_error: "Average cost must be a number.",
      })
      .positive({ message: "Average cost must be greater than 0" }),
    totalValue: z.number().optional(),
    assetId: z.string().optional(),
    quoteMode: z.enum([QuoteMode.MARKET, QuoteMode.MANUAL]).optional(),
    // Exchange MIC for canonical asset ID generation (e.g., "XNAS", "XTSE")
    exchangeMic: z.string().optional(),
    // Optional symbol-level quote currency hint from search/provider (e.g., "USD")
    symbolQuoteCcy: z.string().optional(),
    // Optional symbol-level instrument type hint from search/provider (e.g., "EQUITY")
    symbolInstrumentType: z.string().optional(),
    // Optional asset kind for custom assets (e.g., "INVESTMENT", "OTHER")
    assetKind: z.string().optional(),
  })
  .superRefine((row, ctx) => {
    if ((row.quoteMode ?? QuoteMode.MARKET) === QuoteMode.MARKET && !row.symbolQuoteCcy?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ticker"],
        message: "Please select the symbol from search so quote currency is populated.",
      });
    }
  });

export const bulkHoldingsFormSchema = baseActivitySchema.extend({
  holdings: z.array(bulkHoldingRowSchema).min(1, { message: "At least one holding is required" }),
});

// NOTE: Option fields are `.optional()` here because Zod's `discriminatedUnion`
// requires `ZodObject` branches — `.superRefine()` produces `ZodEffects` which
// breaks the union. Option field validation is enforced at runtime:
//   - Desktop: `buyFormSchema`/`sellFormSchema` have their own `.superRefine()`
//   - Mobile: `validateTradeFields()` in the submit handler
export const tradeActivitySchema = baseActivitySchema.extend({
  activityType: z.enum([ActivityType.BUY, ActivityType.SELL]),
  assetId: z.string().default(""), // Relaxed: options build OCC symbol at submit
  quantity: z.coerce
    .number({
      required_error: "Please enter a valid quantity.",
      invalid_type_error: "Quantity must be a number.",
    })
    .positive(),
  unitPrice: z.coerce
    .number({
      required_error: "Please enter a valid unit price.",
      invalid_type_error: "Unit price must be a number.",
    })
    .positive(),
  fee: z.coerce
    .number({
      required_error: "Please enter a valid fee.",
      invalid_type_error: "Fee must be a positive number.",
    })
    .min(0, { message: "Fee must be a non-negative number." })
    .default(0),
  tax: z.coerce
    .number({
      required_error: "Please enter a valid tax.",
      invalid_type_error: "Tax must be a positive number.",
    })
    .min(0, { message: "Tax must be a non-negative number." })
    .default(0),
  quoteMode: z.enum([QuoteMode.MARKET, QuoteMode.MANUAL]).default(QuoteMode.MARKET),
  // Asset type selection (stock/option/bond)
  assetType: z.enum(["stock", "option", "bond"]).default("stock"),
  assetKind: z.string().optional(),
  // Option-specific fields
  underlyingSymbol: z.string().optional(),
  strikePrice: z.coerce.number().positive().optional(),
  expirationDate: z.string().optional(),
  optionType: z.enum(["CALL", "PUT"]).optional(),
  contractMultiplier: z.coerce.number().positive().default(100).optional(),
});

// Cash activity schema - DEPOSIT/WITHDRAWAL only
// TRANSFER_IN/TRANSFER_OUT are handled by transferActivitySchema
export const cashActivitySchema = baseActivitySchema.extend({
  activityType: z.enum([ActivityType.DEPOSIT, ActivityType.WITHDRAWAL]),
  assetId: z.string().optional(),
  amount: z.coerce
    .number({
      required_error: "Please enter a valid amount.",
      invalid_type_error: "Amount must be a positive number.",
    })
    .positive(),
  fee: z.coerce
    .number({
      invalid_type_error: "Fee must be a positive number.",
    })
    .min(0, { message: "Fee must be a non-negative number." })
    .default(0)
    .optional(),
  quoteMode: z.enum([QuoteMode.MARKET, QuoteMode.MANUAL]).default(QuoteMode.MANUAL),
});

export const incomeActivitySchema = baseActivitySchema.extend({
  activityType: z.enum([ActivityType.DIVIDEND, ActivityType.INTEREST]),
  assetId: z.string().min(1, { message: "Please select a security" }).optional(),
  quantity: z.coerce.number().default(0),
  unitPrice: z.coerce.number().positive().optional(),
  amount: z.coerce
    .number({
      required_error: "Please enter a valid amount.",
      invalid_type_error: "Amount must be a positive number.",
    })
    .positive(),
  fee: z.coerce
    .number({
      invalid_type_error: "Fee must be a positive number.",
    })
    .min(0, { message: "Fee must be a non-negative number." })
    .default(0)
    .optional(),
  tax: z.coerce
    .number({
      invalid_type_error: "Tax must be a positive number.",
    })
    .min(0, { message: "Tax must be a non-negative number." })
    .default(0)
    .optional(),
});

export const otherActivitySchema = baseActivitySchema.extend({
  activityType: z.enum([ActivityType.SPLIT, ActivityType.TAX, ActivityType.FEE]),
  assetId: z.string().min(1, { message: "Please select a security" }).optional(),
  amount: z.coerce.number().min(0).optional(),
  quantity: z.coerce.number().nonnegative().optional(),
  fee: z.coerce
    .number({
      invalid_type_error: "Fee must be a positive number.",
    })
    .min(0, { message: "Fee must be a non-negative number." })
    .default(0)
    .optional(),
});

export const creditActivitySchema = baseActivitySchema.extend({
  activityType: z.enum([ActivityType.CREDIT]),
  amount: z.coerce
    .number({
      required_error: "Please enter a valid amount.",
      invalid_type_error: "Amount must be a positive number.",
    })
    .positive(),
  fee: z.coerce
    .number({
      invalid_type_error: "Fee must be a positive number.",
    })
    .min(0, { message: "Fee must be a non-negative number." })
    .default(0)
    .optional(),
  quoteMode: z.enum([QuoteMode.MARKET, QuoteMode.MANUAL]).default(QuoteMode.MANUAL),
});

export const adjustmentActivitySchema = baseActivitySchema.extend({
  activityType: z.enum([ActivityType.ADJUSTMENT]),
  assetId: z.string().min(1, { message: "Please select a security" }),
  quantity: z.coerce.number().nonnegative().optional().nullable(),
  unitPrice: z.coerce.number().nonnegative().optional().nullable(),
  amount: z.coerce.number().optional().nullable(),
  fee: z.coerce
    .number({
      invalid_type_error: "Fee must be a positive number.",
    })
    .min(0, { message: "Fee must be a non-negative number." })
    .default(0)
    .optional(),
  quoteMode: z.enum([QuoteMode.MARKET, QuoteMode.MANUAL]).default(QuoteMode.MARKET),
});

export const newActivitySchema = z
  .discriminatedUnion("activityType", [
    tradeActivitySchema,
    cashActivitySchema,
    incomeActivitySchema,
    otherActivitySchema,
    creditActivitySchema,
    adjustmentActivitySchema,
    transferActivitySchema,
  ])
  .and(
    z.object({
      showCurrencySelect: z.boolean().optional(),
    }),
  );

export type NewActivityFormValues = z.infer<typeof newActivitySchema>;
