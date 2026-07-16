import { z } from "zod";

// Decimal precision constants (must match Rust crates/core/src/constants.rs)
export const DECIMAL_PRECISION = 8;
export const DISPLAY_DECIMAL_PRECISION = 2;

// Wealthfolio Connect Portal URL - centralized configuration
export const WEALTHFOLIO_CONNECT_PORTAL_URL = "https://connect.wealthfolio.app";

export const PORTFOLIO_SCOPE_ID = "portfolio:all";
export const PORTFOLIO_ACCOUNT_TYPE = "PORTFOLIO";

/**
 * Creates a synthetic "All Portfolio" account used as default selection
 * in account filter dropdowns. Not a real DB account.
 */
export function createPortfolioAccount(baseCurrency: string) {
  return {
    id: PORTFOLIO_SCOPE_ID,
    name: "All Portfolio",
    accountType: PORTFOLIO_ACCOUNT_TYPE as never,
    balance: 0,
    currency: baseCurrency,
    isDefault: false,
    isActive: true,
    isArchived: false,
    trackingMode: "NOT_SET" as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** JSON metadata key for a non-standard option contract multiplier (e.g. mini options = 10). */
export const METADATA_CONTRACT_MULTIPLIER = "contract_multiplier";

export const HoldingType = {
  CASH: "cash",
  SECURITY: "security",
} as const;

export type HoldingType = (typeof HoldingType)[keyof typeof HoldingType];

export const AccountType = {
  SECURITIES: "SECURITIES",
  CASH: "CASH",
  CREDIT_CARD: "CREDIT_CARD",
  CRYPTOCURRENCY: "CRYPTOCURRENCY",
} as const;

export type AccountType = (typeof AccountType)[keyof typeof AccountType];

export const AccountPurpose = {
  SPENDING: "spending",
  PERFORMANCE: "performance",
  HOLDINGS: "holdings",
  INCOME: "income",
  GOAL_FUNDING: "goalFunding",
  CONTRIBUTION_LIMITS: "contributionLimits",
  NET_WORTH: "netWorth",
} as const;

export type AccountPurpose = (typeof AccountPurpose)[keyof typeof AccountPurpose];

export interface AccountCapabilities {
  spending: boolean;
  performance: boolean;
  holdings: boolean;
  income: boolean;
  goalFunding: boolean;
  contributionLimits: boolean;
  netWorth: boolean;
  liability: boolean;
}

const ACCOUNT_PURPOSE_TYPES = {
  [AccountPurpose.SPENDING]: [AccountType.CASH, AccountType.CREDIT_CARD],
  [AccountPurpose.PERFORMANCE]: [
    AccountType.SECURITIES,
    AccountType.CASH,
    AccountType.CRYPTOCURRENCY,
  ],
  [AccountPurpose.HOLDINGS]: [AccountType.SECURITIES, AccountType.CASH, AccountType.CRYPTOCURRENCY],
  [AccountPurpose.INCOME]: [AccountType.SECURITIES, AccountType.CASH, AccountType.CRYPTOCURRENCY],
  [AccountPurpose.GOAL_FUNDING]: [
    AccountType.SECURITIES,
    AccountType.CASH,
    AccountType.CRYPTOCURRENCY,
  ],
  [AccountPurpose.CONTRIBUTION_LIMITS]: [
    AccountType.SECURITIES,
    AccountType.CASH,
    AccountType.CRYPTOCURRENCY,
  ],
  [AccountPurpose.NET_WORTH]: [
    AccountType.SECURITIES,
    AccountType.CASH,
    AccountType.CREDIT_CARD,
    AccountType.CRYPTOCURRENCY,
  ],
} as const satisfies Record<AccountPurpose, readonly AccountType[]>;

export const REPORT_ACCOUNT_TYPES = ACCOUNT_PURPOSE_TYPES[AccountPurpose.PERFORMANCE];

export type ReportAccountType = (typeof REPORT_ACCOUNT_TYPES)[number];

export function isLiabilityAccountType(accountType: string | undefined): boolean {
  return accountType === AccountType.CREDIT_CARD;
}

export function accountPurposeAccountTypes(purpose: AccountPurpose): readonly AccountType[] {
  return ACCOUNT_PURPOSE_TYPES[purpose];
}

export function accountSupportsPurpose(
  accountOrType: { accountType?: string } | string | undefined,
  purpose: AccountPurpose,
): boolean {
  const accountType =
    typeof accountOrType === "string" ? accountOrType : accountOrType?.accountType;
  return (ACCOUNT_PURPOSE_TYPES[purpose] as readonly AccountType[]).includes(
    accountType as AccountType,
  );
}

export function accountCapabilities(
  accountOrType: { accountType?: string } | string | undefined,
): AccountCapabilities {
  return {
    spending: accountSupportsPurpose(accountOrType, AccountPurpose.SPENDING),
    performance: accountSupportsPurpose(accountOrType, AccountPurpose.PERFORMANCE),
    holdings: accountSupportsPurpose(accountOrType, AccountPurpose.HOLDINGS),
    income: accountSupportsPurpose(accountOrType, AccountPurpose.INCOME),
    goalFunding: accountSupportsPurpose(accountOrType, AccountPurpose.GOAL_FUNDING),
    contributionLimits: accountSupportsPurpose(accountOrType, AccountPurpose.CONTRIBUTION_LIMITS),
    netWorth: accountSupportsPurpose(accountOrType, AccountPurpose.NET_WORTH),
    liability: isLiabilityAccountType(
      typeof accountOrType === "string" ? accountOrType : accountOrType?.accountType,
    ),
  };
}

export function isReportAccountType(
  accountType: string | undefined,
): accountType is ReportAccountType {
  return accountSupportsPurpose(accountType, AccountPurpose.PERFORMANCE);
}

export const accountTypeSchema = z.enum([
  AccountType.SECURITIES,
  AccountType.CASH,
  AccountType.CREDIT_CARD,
  AccountType.CRYPTOCURRENCY,
]);

/**
 * Returns the default group name for a given account type.
 */
export function defaultGroupForAccountType(accountType: AccountType): string {
  switch (accountType) {
    case AccountType.SECURITIES:
      return "Investments";
    case AccountType.CASH:
      return "Cash";
    case AccountType.CREDIT_CARD:
      return "Credit Cards";
    case AccountType.CRYPTOCURRENCY:
      return "Crypto";
    default:
      return "Investments";
  }
}

// =============================================================================
// Asset kind helpers
// =============================================================================

/** Alternative asset kinds for filtering */
const ALTERNATIVE_ASSET_KINDS = new Set<AssetKind>([
  "PROPERTY",
  "VEHICLE",
  "COLLECTIBLE",
  "PRECIOUS_METAL",
  "LIABILITY",
  "OTHER",
]);

/**
 * Returns true if an asset kind is an alternative (non-market) asset.
 */
export function isAlternativeAssetKind(kind: AssetKind): boolean {
  return ALTERNATIVE_ASSET_KINDS.has(kind);
}

/**
 * Returns true if an asset kind is a liability.
 */
export function isLiabilityAssetKind(kind: AssetKind): boolean {
  return kind === "LIABILITY";
}

// DataSource: Where quote data comes from (used on Quote objects)
export const DataSource = {
  YAHOO: "YAHOO",
  MANUAL: "MANUAL",
} as const;

export type DataSource = (typeof DataSource)[keyof typeof DataSource];

// Zod schema for data source validation — accepts any string since the backend
// can return many provider IDs (BROKER, ALPHA_VANTAGE, CUSTOM_SCRAPER:xyz, etc.)
export const dataSourceSchema = z.string();

// QuoteMode: How an asset's price is determined (used on Asset/Activity objects)
export const QuoteMode = {
  MARKET: "MARKET", // Auto-fetch prices from market data providers
  MANUAL: "MANUAL", // User manages prices manually
} as const;

export type QuoteMode = (typeof QuoteMode)[keyof typeof QuoteMode];

// Zod schema for quote mode validation
export const quoteModeSchema = z.enum([QuoteMode.MARKET, QuoteMode.MANUAL]);

// Legacy alias for backward compatibility during migration
export const PricingMode = QuoteMode;
export type PricingMode = QuoteMode;
export const pricingModeSchema = quoteModeSchema;

export const ImportFormat = {
  DATE: "date",
  ACCOUNT: "account",
  ACTIVITY_TYPE: "activityType",
  SYMBOL: "symbol",
  ISIN: "isin",
  QUANTITY: "quantity",
  UNIT_PRICE: "unitPrice",
  AMOUNT: "amount",
  CURRENCY: "currency",
  FEE: "fee",
  TAX: "tax",
  COMMENT: "comment",
  FX_RATE: "fxRate",
  SUBTYPE: "subtype",
  INSTRUMENT_TYPE: "instrumentType",
} as const;

export type ImportFormat = (typeof ImportFormat)[keyof typeof ImportFormat];

export const importFormatSchema = z.enum([
  ImportFormat.DATE,
  ImportFormat.ACCOUNT,
  ImportFormat.ACTIVITY_TYPE,
  ImportFormat.SYMBOL,
  ImportFormat.ISIN,
  ImportFormat.QUANTITY,
  ImportFormat.UNIT_PRICE,
  ImportFormat.AMOUNT,
  ImportFormat.CURRENCY,
  ImportFormat.FEE,
  ImportFormat.TAX,
  ImportFormat.COMMENT,
  ImportFormat.FX_RATE,
  ImportFormat.SUBTYPE,
  ImportFormat.INSTRUMENT_TYPE,
]);

export const IMPORT_REQUIRED_FIELDS = [
  ImportFormat.DATE,
  ImportFormat.ACTIVITY_TYPE,
  ImportFormat.SYMBOL,
  ImportFormat.QUANTITY,
  ImportFormat.UNIT_PRICE,
  ImportFormat.AMOUNT,
] as const;

export type ImportRequiredField = (typeof IMPORT_REQUIRED_FIELDS)[number];

export const ExportDataType = {
  ACCOUNTS: "accounts",
  ACTIVITIES: "activities",
  HOLDINGS: "holdings",
  GOALS: "goals",
  PORTFOLIO_HISTORY: "portfolio-history",
} as const;

export type ExportDataType = (typeof ExportDataType)[keyof typeof ExportDataType];

export const exportDataTypeSchema = z.enum([
  ExportDataType.ACCOUNTS,
  ExportDataType.ACTIVITIES,
  ExportDataType.HOLDINGS,
  ExportDataType.GOALS,
  ExportDataType.PORTFOLIO_HISTORY,
]);

export const ExportedFileFormat = {
  CSV: "CSV",
  JSON: "JSON",
  SQLITE: "SQLite",
} as const;

export type ExportedFileFormat = (typeof ExportedFileFormat)[keyof typeof ExportedFileFormat];

export const exportedFileFormatSchema = z.enum([
  ExportedFileFormat.CSV,
  ExportedFileFormat.JSON,
  ExportedFileFormat.SQLITE,
]);

// Canonical activity types (closed set of 14)
export const ActivityType = {
  BUY: "BUY",
  SELL: "SELL",
  SPLIT: "SPLIT",
  DIVIDEND: "DIVIDEND",
  INTEREST: "INTEREST",
  DEPOSIT: "DEPOSIT",
  WITHDRAWAL: "WITHDRAWAL",
  TRANSFER_IN: "TRANSFER_IN",
  TRANSFER_OUT: "TRANSFER_OUT",
  FEE: "FEE",
  TAX: "TAX",
  CREDIT: "CREDIT",
  ADJUSTMENT: "ADJUSTMENT",
  UNKNOWN: "UNKNOWN",
} as const;

export type ActivityType = (typeof ActivityType)[keyof typeof ActivityType];

// Array of all activity types for iteration
export const ACTIVITY_TYPES = [
  ActivityType.BUY,
  ActivityType.SELL,
  ActivityType.SPLIT,
  ActivityType.DIVIDEND,
  ActivityType.INTEREST,
  ActivityType.DEPOSIT,
  ActivityType.WITHDRAWAL,
  ActivityType.TRANSFER_IN,
  ActivityType.TRANSFER_OUT,
  ActivityType.FEE,
  ActivityType.TAX,
  ActivityType.CREDIT,
  ActivityType.ADJUSTMENT,
  ActivityType.UNKNOWN,
] as const;

export const TRADING_ACTIVITY_TYPES = [
  ActivityType.BUY,
  ActivityType.SELL,
  ActivityType.SPLIT,
] as const;

export const SYMBOL_REQUIRED_TYPES = [
  ActivityType.BUY,
  ActivityType.SELL,
  ActivityType.SPLIT,
  ActivityType.DIVIDEND,
  ActivityType.ADJUSTMENT,
] as const;

export const INCOME_ACTIVITY_TYPES = [ActivityType.DIVIDEND, ActivityType.INTEREST] as const;

// Zod schema for activity type validation
export const activityTypeSchema = z.enum([
  ActivityType.BUY,
  ActivityType.SELL,
  ActivityType.SPLIT,
  ActivityType.DIVIDEND,
  ActivityType.INTEREST,
  ActivityType.DEPOSIT,
  ActivityType.WITHDRAWAL,
  ActivityType.TRANSFER_IN,
  ActivityType.TRANSFER_OUT,
  ActivityType.FEE,
  ActivityType.TAX,
  ActivityType.CREDIT,
  ActivityType.ADJUSTMENT,
  ActivityType.UNKNOWN,
]);

// Display names for activity types
export const ActivityTypeNames: Record<ActivityType, string> = {
  [ActivityType.BUY]: "Buy",
  [ActivityType.SELL]: "Sell",
  [ActivityType.SPLIT]: "Split",
  [ActivityType.DIVIDEND]: "Dividend",
  [ActivityType.INTEREST]: "Interest",
  [ActivityType.DEPOSIT]: "Deposit",
  [ActivityType.WITHDRAWAL]: "Withdrawal",
  [ActivityType.TRANSFER_IN]: "Transfer In",
  [ActivityType.TRANSFER_OUT]: "Transfer Out",
  [ActivityType.FEE]: "Fee",
  [ActivityType.TAX]: "Tax",
  [ActivityType.CREDIT]: "Credit",
  [ActivityType.ADJUSTMENT]: "Adjustment",
  [ActivityType.UNKNOWN]: "Unknown",
};

// Alias for backward compatibility
export const ACTIVITY_TYPE_DISPLAY_NAMES = ActivityTypeNames;

// Activity status for lifecycle management
export const ActivityStatus = {
  POSTED: "POSTED",
  PENDING: "PENDING",
  DRAFT: "DRAFT",
  VOID: "VOID",
} as const;

export type ActivityStatus = (typeof ActivityStatus)[keyof typeof ActivityStatus];

// Subtypes that affect calculations (compiler expansion or flow classification)
export const ACTIVITY_SUBTYPES = {
  // DIVIDEND subtypes
  // DRIP: cash dividend → immediately reinvested as BUY of same ticker
  DRIP: "DRIP",
  // DIVIDEND_IN_KIND: dividend paid as additional units of the same asset
  DIVIDEND_IN_KIND: "DIVIDEND_IN_KIND",

  // INTEREST subtypes - STAKING_REWARD expands to INTEREST + BUY
  STAKING_REWARD: "STAKING_REWARD",

  // CREDIT subtypes
  // BONUS: external flow (new capital, affects TWR/net_contribution)
  BONUS: "BONUS",
  // REBATE: internal flow (trading rebate, negative fee, no net_contribution change)
  REBATE: "REBATE",
  // REFUND: internal flow (fee correction/reversal, no net_contribution change)
  REFUND: "REFUND",
  // REIMBURSEMENT: spending flow that offsets an expense category
  REIMBURSEMENT: "REIMBURSEMENT",

  // ADJUSTMENT subtypes
  // OPTION_EXPIRY: removes option lots with no cash effect
  OPTION_EXPIRY: "OPTION_EXPIRY",

  // BUY/SELL position intent subtypes
  // POSITION_OPEN: opens or extends a long/short position
  POSITION_OPEN: "POSITION_OPEN",
  // POSITION_CLOSE: closes or reduces an existing long/short position
  POSITION_CLOSE: "POSITION_CLOSE",
} as const;

export type ActivitySubtype = (typeof ACTIVITY_SUBTYPES)[keyof typeof ACTIVITY_SUBTYPES];

/**
 * Broker/export aliases for BUY/SELL position-intent subtypes, grouped by trade
 * side and resulting intent. Single source of truth shared by the activity-utils
 * canonicalizer and the CSV import draft inference.
 *
 * Aliases are stored separator-stripped + uppercased (the canonical form produced
 * by {@link normalizePositionIntentAlias}); BUY_TO_OPEN and BUYTOOPEN both
 * normalize to "BUYTOOPEN".
 *
 * The Rust backend (NewActivity::canonicalize_subtype_for_activity in
 * crates/core/src/activities/activities_model.rs) is the authority — keep these
 * lists in sync with it.
 */
export const POSITION_INTENT_ALIASES = {
  [ActivityType.BUY]: {
    [ACTIVITY_SUBTYPES.POSITION_OPEN]: ["BTO", "BUYTOOPEN", "BUYOPEN", "OPENBUY"],
    [ACTIVITY_SUBTYPES.POSITION_CLOSE]: [
      "BTC",
      "BUYTOCLOSE",
      "BUYCLOSE",
      "CLOSEBUY",
      "BUYTOCOVER",
      "BUYCOVER",
      "COVERSHORT",
    ],
  },
  [ActivityType.SELL]: {
    [ACTIVITY_SUBTYPES.POSITION_OPEN]: [
      "STO",
      "SELLTOOPEN",
      "SELLOPEN",
      "OPENSELL",
      "SELLSHORT",
      "SHORTSELL",
      "SELLSHORTTOOPEN",
    ],
    [ACTIVITY_SUBTYPES.POSITION_CLOSE]: ["STC", "SELLTOCLOSE", "SELLCLOSE", "CLOSESELL"],
  },
} as const;

/** Normalize a raw subtype label to the canonical alias form (uppercase, no spaces/dashes/underscores). */
export const normalizePositionIntentAlias = (value: string): string =>
  value
    .trim()
    .toUpperCase()
    .replace(/[\s_-]+/g, "");

// Display names for subtypes
export const SUBTYPE_DISPLAY_NAMES: Record<string, string> = {
  [ACTIVITY_SUBTYPES.DRIP]: "Dividend Reinvested (DRIP)",
  [ACTIVITY_SUBTYPES.DIVIDEND_IN_KIND]: "Dividend in Kind",
  [ACTIVITY_SUBTYPES.STAKING_REWARD]: "Staking Reward",
  [ACTIVITY_SUBTYPES.BONUS]: "Bonus",
  [ACTIVITY_SUBTYPES.REBATE]: "Trading Rebate",
  [ACTIVITY_SUBTYPES.REFUND]: "Fee Refund",
  [ACTIVITY_SUBTYPES.REIMBURSEMENT]: "Reimbursement",
  [ACTIVITY_SUBTYPES.OPTION_EXPIRY]: "Option Expiry",
  [ACTIVITY_SUBTYPES.POSITION_OPEN]: "Open Position",
  [ACTIVITY_SUBTYPES.POSITION_CLOSE]: "Close Position",
};

// Suggested subtypes per activity type
export const SUBTYPES_BY_ACTIVITY_TYPE: Record<string, string[]> = {
  [ActivityType.BUY]: [ACTIVITY_SUBTYPES.POSITION_OPEN, ACTIVITY_SUBTYPES.POSITION_CLOSE],
  [ActivityType.SELL]: [ACTIVITY_SUBTYPES.POSITION_OPEN, ACTIVITY_SUBTYPES.POSITION_CLOSE],
  [ActivityType.DIVIDEND]: [ACTIVITY_SUBTYPES.DRIP, ACTIVITY_SUBTYPES.DIVIDEND_IN_KIND],
  [ActivityType.INTEREST]: [ACTIVITY_SUBTYPES.STAKING_REWARD],
  [ActivityType.CREDIT]: [
    ACTIVITY_SUBTYPES.BONUS,
    ACTIVITY_SUBTYPES.REBATE,
    ACTIVITY_SUBTYPES.REFUND,
    ACTIVITY_SUBTYPES.REIMBURSEMENT,
  ],
  [ActivityType.ADJUSTMENT]: [ACTIVITY_SUBTYPES.OPTION_EXPIRY],
};

// Asset kinds for behavior classification
export const AssetKind = {
  INVESTMENT: "INVESTMENT",
  PROPERTY: "PROPERTY",
  VEHICLE: "VEHICLE",
  COLLECTIBLE: "COLLECTIBLE",
  PRECIOUS_METAL: "PRECIOUS_METAL",
  PRIVATE_EQUITY: "PRIVATE_EQUITY",
  LIABILITY: "LIABILITY",
  OTHER: "OTHER",
  FX: "FX",
} as const;

export type AssetKind = (typeof AssetKind)[keyof typeof AssetKind];

// Display names for all asset kinds
export const ASSET_KIND_DISPLAY_NAMES: Record<AssetKind, string> = {
  INVESTMENT: "Investment",
  PROPERTY: "Property",
  VEHICLE: "Vehicle",
  COLLECTIBLE: "Collectible",
  PRECIOUS_METAL: "Precious Metal",
  PRIVATE_EQUITY: "Private Equity",
  LIABILITY: "Liability",
  OTHER: "Other",
  FX: "FX",
};

// User-editable asset kinds (excludes system-managed types like FX)
export const EDITABLE_ASSET_KINDS: AssetKind[] = [
  "INVESTMENT",
  "PRIVATE_EQUITY",
  "PROPERTY",
  "VEHICLE",
  "COLLECTIBLE",
  "PRECIOUS_METAL",
  "LIABILITY",
  "OTHER",
];

// Convenience object for alternative asset kinds
export const AlternativeAssetKind = {
  PROPERTY: "PROPERTY",
  VEHICLE: "VEHICLE",
  COLLECTIBLE: "COLLECTIBLE",
  PRECIOUS_METAL: "PRECIOUS_METAL",
  LIABILITY: "LIABILITY",
  OTHER: "OTHER",
} as const;

export type AlternativeAssetKind = (typeof AlternativeAssetKind)[keyof typeof AlternativeAssetKind];

// Display names for alternative asset kinds
export const ALTERNATIVE_ASSET_KIND_DISPLAY_NAMES: Record<AlternativeAssetKind, string> = {
  [AlternativeAssetKind.PROPERTY]: "Property",
  [AlternativeAssetKind.VEHICLE]: "Vehicle",
  [AlternativeAssetKind.COLLECTIBLE]: "Collectible",
  [AlternativeAssetKind.PRECIOUS_METAL]: "Precious Metal",
  [AlternativeAssetKind.LIABILITY]: "Liability",
  [AlternativeAssetKind.OTHER]: "Other",
};

// Default account groups for alternative assets
export const ALTERNATIVE_ASSET_DEFAULT_GROUPS: Record<AlternativeAssetKind, string> = {
  [AlternativeAssetKind.PROPERTY]: "Properties",
  [AlternativeAssetKind.VEHICLE]: "Vehicles",
  [AlternativeAssetKind.COLLECTIBLE]: "Collectibles",
  [AlternativeAssetKind.PRECIOUS_METAL]: "Precious Metals",
  [AlternativeAssetKind.LIABILITY]: "Liabilities",
  [AlternativeAssetKind.OTHER]: "Other Assets",
};

// Map API kind values (lowercase) to enum values
const API_KIND_TO_ENUM: Record<string, AlternativeAssetKind> = {
  property: AlternativeAssetKind.PROPERTY,
  vehicle: AlternativeAssetKind.VEHICLE,
  collectible: AlternativeAssetKind.COLLECTIBLE,
  precious: AlternativeAssetKind.PRECIOUS_METAL,
  liability: AlternativeAssetKind.LIABILITY,
  other: AlternativeAssetKind.OTHER,
};

/**
 * Convert an API kind string to the AlternativeAssetKind enum value.
 * Returns OTHER if the kind is not recognized.
 */
export function apiKindToAlternativeAssetKind(apiKind: string): AlternativeAssetKind {
  return API_KIND_TO_ENUM[apiKind.toLowerCase()] ?? AlternativeAssetKind.OTHER;
}

// Instrument types (from Rust InstrumentType enum)
export const InstrumentType = {
  EQUITY: "EQUITY",
  CRYPTO: "CRYPTO",
  FX: "FX",
  OPTION: "OPTION",
  METAL: "METAL",
  BOND: "BOND",
} as const;

export type InstrumentType = (typeof InstrumentType)[keyof typeof InstrumentType];

/** Display options for instrument type filters */
export const INSTRUMENT_TYPE_OPTIONS = [
  { value: InstrumentType.EQUITY, label: "Equity" },
  { value: InstrumentType.CRYPTO, label: "Crypto" },
  { value: InstrumentType.FX, label: "FX" },
  { value: InstrumentType.OPTION, label: "Option" },
  { value: InstrumentType.METAL, label: "Metal" },
  { value: InstrumentType.BOND, label: "Bond" },
] as const;

/**
 * Holding category filters for the Holdings page.
 * Three main categories: Investments (stocks, ETFs, crypto, options, etc.), Assets (alternative assets), Liabilities.
 * Uses assetKinds to filter holdings directly by their assetKind field.
 * IDs are stable strings for URL persistence and local storage.
 */
export const HOLDING_CATEGORY_FILTERS = [
  {
    id: "investments",
    label: "Investments",
    assetKinds: ["INVESTMENT", "PRIVATE_EQUITY"],
  },
  {
    id: "assets",
    label: "Personal Assets",
    assetKinds: ["PROPERTY", "VEHICLE", "COLLECTIBLE", "PRECIOUS_METAL", "OTHER"],
  },
  { id: "liabilities", label: "Liabilities", assetKinds: ["LIABILITY"] },
] as const;

export type HoldingCategoryFilterId = (typeof HOLDING_CATEGORY_FILTERS)[number]["id"];

/**
 * Maps account types to their display group names for the Holdings page.
 * Used for collapsible group headers.
 */
export const HOLDING_GROUP_DISPLAY_NAMES: Record<string, string> = {
  [AccountType.SECURITIES]: "Investments",
  [AccountType.CRYPTOCURRENCY]: "Investments",
  [AccountType.CASH]: "Cash",
  [AccountType.CREDIT_CARD]: "Liabilities",
};

/**
 * Order for displaying holding groups in the Holdings page.
 * Lower numbers appear first.
 */
export const HOLDING_GROUP_ORDER: Record<string, number> = {
  Investments: 1,
  Properties: 2,
  Vehicles: 3,
  Collectibles: 4,
  "Precious Metals": 5,
  "Other Assets": 6,
  Liabilities: 7,
  Cash: 8,
};

// =============================================================================
// Exchange Mapping (Fallback)
// =============================================================================

/**
 * Display names for exchange codes (MIC codes and special values).
 * Used to show user-friendly exchange names in the UI.
 */
export const EXCHANGE_DISPLAY_NAMES: Record<string, string> = {
  // Major US exchanges
  XNAS: "NASDAQ",
  XNYS: "NYSE",
  XASE: "NYSE American",
  ARCX: "NYSE Arca",
  BATS: "CBOE BZX",

  // Canadian exchanges
  XTSE: "TSX",
  XTSX: "TSX-V",
  XCNQ: "CSE",
  XNEO: "Cboe Canada",

  // European exchanges
  XLON: "LSE",
  XPAR: "Euronext Paris",
  XAMS: "Euronext Amsterdam",
  XBRU: "Euronext Brussels",
  XLIS: "Euronext Lisbon",
  XETR: "XETRA",
  XFRA: "Frankfurt",
  XSWX: "SIX Swiss",
  XMIL: "Borsa Italiana",
  XMAD: "BME",

  // Asia-Pacific exchanges
  XASX: "ASX",
  XTKS: "Tokyo",
  XHKG: "HKEX",
  XSHG: "Shanghai",
  XSHE: "Shenzhen",
  XSES: "SGX",
  XKRX: "Korea",
  XBOM: "BSE India",
  XNSE: "NSE India",

  // Other major exchanges
  XJSE: "JSE",
  XSAU: "Tadawul",
  XBSP: "B3",
  XMEX: "BMV",

  // Special values
  MANUAL: "Manual",
  CCC: "Crypto",
  CCY: "FX",

  // OTC markets
  PNK: "OTC Pink",
  OTC: "OTC",
  OTCQX: "OTCQX",
  OTCQB: "OTCQB",
};

/**
 * Get a friendly display name for an exchange code.
 * Falls back to the original code if no mapping exists.
 *
 * @param exchangeCode - Exchange MIC code (e.g., XNAS, XTSE, XASX)
 * @returns Friendly display name (e.g., NASDAQ, TSX, ASX) or original code if not mapped
 */
export function getExchangeDisplayName(exchangeCode: string | undefined | null): string {
  if (!exchangeCode) return "";
  const upperCode = exchangeCode.toUpperCase();
  return EXCHANGE_DISPLAY_NAMES[upperCode] ?? exchangeCode;
}
