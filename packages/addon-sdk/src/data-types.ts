/**
 * Comprehensive data types for Wealthfolio addons
 * These types mirror the main application types to ensure compatibility
 */

// Canonical activity types (closed set of 14)
export const ActivityType = {
  BUY: 'BUY',
  SELL: 'SELL',
  SPLIT: 'SPLIT',
  DIVIDEND: 'DIVIDEND',
  INTEREST: 'INTEREST',
  DEPOSIT: 'DEPOSIT',
  WITHDRAWAL: 'WITHDRAWAL',
  TRANSFER_IN: 'TRANSFER_IN',
  TRANSFER_OUT: 'TRANSFER_OUT',
  FEE: 'FEE',
  TAX: 'TAX',
  CREDIT: 'CREDIT',
  ADJUSTMENT: 'ADJUSTMENT',
  UNKNOWN: 'UNKNOWN',
} as const;

export type ActivityType = (typeof ActivityType)[keyof typeof ActivityType];

// Array of all activity types for iteration
export const ACTIVITY_TYPES = [
  'BUY',
  'SELL',
  'SPLIT',
  'DIVIDEND',
  'INTEREST',
  'DEPOSIT',
  'WITHDRAWAL',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'FEE',
  'TAX',
  'CREDIT',
  'ADJUSTMENT',
  'UNKNOWN',
] as const;

// Activity status for lifecycle management
export const ActivityStatus = {
  POSTED: 'POSTED',
  PENDING: 'PENDING',
  DRAFT: 'DRAFT',
  VOID: 'VOID',
} as const;

export type ActivityStatus = (typeof ActivityStatus)[keyof typeof ActivityStatus];

// Known subtypes for UI
export const ACTIVITY_SUBTYPES = {
  // Dividend subtypes
  DRIP: 'DRIP',
  QUALIFIED: 'QUALIFIED',
  ORDINARY: 'ORDINARY',
  RETURN_OF_CAPITAL: 'RETURN_OF_CAPITAL',
  DIVIDEND_IN_KIND: 'DIVIDEND_IN_KIND',

  // Interest subtypes
  STAKING_REWARD: 'STAKING_REWARD',
  LENDING_INTEREST: 'LENDING_INTEREST',
  COUPON: 'COUPON',

  // Split subtypes
  REVERSE_SPLIT: 'REVERSE_SPLIT',

  // Option subtypes
  OPTION_OPEN: 'OPTION_OPEN',
  OPTION_CLOSE: 'OPTION_CLOSE',
  OPTION_EXPIRE: 'OPTION_EXPIRE',
  OPTION_ASSIGNMENT: 'OPTION_ASSIGNMENT',
  OPTION_EXERCISE: 'OPTION_EXERCISE',

  // Fee subtypes
  MANAGEMENT_FEE: 'MANAGEMENT_FEE',
  ADR_FEE: 'ADR_FEE',
  INTEREST_CHARGE: 'INTEREST_CHARGE',

  // Tax subtypes
  WITHHOLDING: 'WITHHOLDING',
  NRA_WITHHOLDING: 'NRA_WITHHOLDING',

  // Credit subtypes
  FEE_REFUND: 'FEE_REFUND',
  TAX_REFUND: 'TAX_REFUND',
  BONUS: 'BONUS',
  ADJUSTMENT: 'ADJUSTMENT',
  REBATE: 'REBATE',
  REVERSAL: 'REVERSAL',

  // Liability subtypes
  LIABILITY_INTEREST_ACCRUAL: 'LIABILITY_INTEREST_ACCRUAL',
  LIABILITY_PRINCIPAL_PAYMENT: 'LIABILITY_PRINCIPAL_PAYMENT',
} as const;

export type ActivitySubtype = (typeof ACTIVITY_SUBTYPES)[keyof typeof ACTIVITY_SUBTYPES];

// Asset kinds for behavior classification
export const AssetKind = {
  INVESTMENT: 'INVESTMENT',
  PROPERTY: 'PROPERTY',
  VEHICLE: 'VEHICLE',
  COLLECTIBLE: 'COLLECTIBLE',
  PRECIOUS_METAL: 'PRECIOUS_METAL',
  PRIVATE_EQUITY: 'PRIVATE_EQUITY',
  LIABILITY: 'LIABILITY',
  OTHER: 'OTHER',
  FX: 'FX',
} as const;

export type AssetKind = (typeof AssetKind)[keyof typeof AssetKind];

// QuoteMode: How an asset's price is determined
export const QuoteMode = {
  MARKET: 'MARKET',
  MANUAL: 'MANUAL',
} as const;

export type QuoteMode = (typeof QuoteMode)[keyof typeof QuoteMode];

export const DataSource = {
  YAHOO: 'YAHOO',
  MANUAL: 'MANUAL',
} as const;

export type DataSource = (typeof DataSource)[keyof typeof DataSource];

export const AccountType = {
  SECURITIES: 'SECURITIES',
  CASH: 'CASH',
  CREDIT_CARD: 'CREDIT_CARD',
  CRYPTOCURRENCY: 'CRYPTOCURRENCY',
} as const;

export type AccountType = (typeof AccountType)[keyof typeof AccountType];

export const HoldingType = {
  CASH: 'cash',
  SECURITY: 'security',
  ALTERNATIVE_ASSET: 'AlternativeAsset',
} as const;

export type HoldingType = (typeof HoldingType)[keyof typeof HoldingType];

export type ImportRequiredField = 'symbol' | 'quantity' | 'price' | 'date' | 'type';

// Core data types
export interface Account {
  id: string;
  name: string;
  accountType: AccountType;
  group?: string;
  balance: number;
  currency: string;
  isDefault: boolean;
  isActive: boolean;
  isArchived: boolean;
  trackingMode: 'TRANSACTIONS' | 'HOLDINGS' | 'NOT_SET';
  createdAt: Date;
  updatedAt: Date;
  platformId?: string;
  accountNumber?: string;
  meta?: string;
  provider?: string;
  providerAccountId?: string;
}

/**
 * Activity interface matching the v3 backend model
 */
export interface Activity {
  // Identity
  id: string;
  accountId: string;
  assetId?: string; // NOW OPTIONAL for pure cash events

  // Classification
  activityType: string; // Canonical type (closed set of 15)
  activityTypeOverride?: string; // User override (never touched by sync)
  sourceType?: string; // Raw provider label (REI, DIV, etc.)
  subtype?: string; // Semantic variation (DRIP, STAKING_REWARD, etc.)
  status: ActivityStatus;

  // Timing
  activityDate: string; // ISO timestamp (UTC)
  settlementDate?: string;

  // Quantities (strings to preserve decimal precision)
  quantity?: string | null;
  unitPrice?: string | null;
  amount?: string | null;
  fee?: string | null;
  tax?: string | null;
  currency: string;
  fxRate?: string | null;

  // Metadata
  notes?: string;
  metadata?: Record<string, unknown>;

  // Source identity
  sourceSystem?: string; // SNAPTRADE, PLAID, MANUAL, CSV
  sourceRecordId?: string;
  sourceGroupId?: string;
  idempotencyKey?: string;
  importRunId?: string;

  // Sync flags
  isUserModified: boolean; // User edited; sync protects economics
  needsReview: boolean; // Needs user review (low confidence, etc.)

  // Audit
  createdAt: string;
  updatedAt: string;
}

/**
 * Helper to get effective type (respects user override)
 */
export function getEffectiveType(activity: Activity): string {
  return activity.activityTypeOverride ?? activity.activityType;
}

/**
 * Check if activity has user override
 */
export function hasUserOverride(activity: Activity): boolean {
  return (
    activity.activityTypeOverride !== undefined && activity.activityTypeOverride !== null
  );
}

export interface ActivityDetails {
  id: string;
  activityType: ActivityType;
  subtype?: string | null;
  status?: ActivityStatus;
  date: Date;
  quantity: string | null;
  unitPrice: string | null;
  amount: string | null;
  fee: string | null;
  tax?: string | null;
  currency: string;
  needsReview: boolean;
  comment?: string;
  fxRate?: string | null;
  createdAt: Date;
  assetId: string;
  updatedAt: Date;
  accountId: string;
  accountName: string;
  accountCurrency: string;
  assetSymbol: string;
  assetName?: string;
  assetQuoteMode?: QuoteMode;
  exchangeMic?: string;
  // Sync/source metadata
  sourceSystem?: string;
  sourceRecordId?: string;
  idempotencyKey?: string;
  importRunId?: string;
  isUserModified?: boolean;
  metadata?: Record<string, unknown>;
  subRows?: ActivityDetails[];
}

export interface ActivitySearchResponse {
  data: ActivityDetails[];
  meta: {
    totalRowCount: number;
  };
}

export interface AssetResolutionInput {
  id?: string;
  symbol?: string;
  exchangeMic?: string;
  kind?: string;
  name?: string;
  quoteMode?: QuoteMode;
  quoteCcy?: string;
  instrumentType?: string;
  providerId?: string;
  providerSymbol?: string;
}

/** @deprecated Use AssetResolutionInput. */
export type SymbolInput = AssetResolutionInput;

export interface ActivityCreate {
  id?: string;
  accountId: string;
  activityType: string;
  subtype?: string | null;
  activityDate: string | Date;
  sourceGroupId?: string;
  asset?: AssetResolutionInput;
  /** @deprecated Use asset. */
  symbol?: AssetResolutionInput;
  quantity?: string | number | null;
  unitPrice?: string | number | null;
  amount?: string | number | null;
  currency?: string;
  fee?: string | number | null;
  tax?: string | number | null;
  comment?: string | null;
  fxRate?: string | number | null;
  metadata?: string | Record<string, unknown>;
}

export interface ActivityUpdate {
  id: string;
  accountId: string;
  activityType: string;
  subtype?: string | null;
  activityDate: string | Date;
  sourceGroupId?: string;
  asset?: AssetResolutionInput;
  /** @deprecated Use asset. */
  symbol?: AssetResolutionInput;
  quantity?: string | number | null;
  unitPrice?: string | number | null;
  amount?: string | number | null;
  currency?: string;
  fee?: string | number | null;
  tax?: string | number | null;
  comment?: string | null;
  fxRate?: string | number | null;
  metadata?: string | Record<string, unknown>;
}

export interface ActivityBulkMutationRequest {
  creates?: ActivityCreate[];
  updates?: ActivityUpdate[];
  deleteIds?: string[];
}

export interface ActivityBulkMutationError {
  id?: string;
  action: string;
  message: string;
}

export interface ActivityBulkIdentifierMapping {
  tempId?: string | null;
  activityId: string;
}

export interface ActivityBulkMutationResult {
  created: Activity[];
  updated: Activity[];
  deleted: Activity[];
  createdMappings: ActivityBulkIdentifierMapping[];
  errors: ActivityBulkMutationError[];
}

export interface ActivityImport {
  id?: string;
  accountId: string;
  currency?: string;
  activityType: ActivityType;
  subtype?: string;
  date?: Date | string;
  symbol?: string;
  assetId?: string;
  amount?: number | string | null;
  quantity?: number | string | null;
  unitPrice?: number | string | null;
  fee?: number | string | null;
  tax?: number | string | null;
  fxRate?: number | string | null;
  accountName?: string;
  symbolName?: string;
  /** Resolved exchange MIC for the symbol (populated during validation) */
  exchangeMic?: string;
  /** Resolved quote currency hint (e.g., GBp) */
  quoteCcy?: string;
  /** Resolved instrument type hint (e.g., EQUITY, CRYPTO) */
  instrumentType?: string;
  /** Resolved quote mode hint (e.g., MANUAL, MARKET) */
  quoteMode?: string;
  /** Market data provider that resolved this import row, if selected. */
  providerId?: string;
  /** Provider-native symbol/code selected by search/import. */
  providerSymbol?: string;
  errors?: Record<string, string[]>;
  warnings?: Record<string, string[]>;
  duplicateOfId?: string;
  duplicateOfLineNumber?: number;
  isValid: boolean;
  lineNumber?: number;
  isDraft: boolean;
  forceImport?: boolean;
  comment?: string;
}

export interface ImportActivitiesSummary {
  total: number;
  imported: number;
  skipped: number;
  duplicates: number;
  assetsCreated: number;
  success: boolean;
}

export interface ImportActivitiesResult {
  activities: ActivityImport[];
  importRunId: string;
  summary: ImportActivitiesSummary;
}

export interface ImportMappingData {
  accountId: string;
  fieldMappings: Record<string, string | string[]>;
  activityMappings: Record<string, string[]>;
  symbolMappings: Record<string, string>;
  accountMappings: Record<string, string>;
}

export interface SymbolSearchResult {
  exchange: string;
  /** Canonical exchange MIC code (e.g., "XNAS", "XTSE") */
  exchangeMic?: string;
  /** Canonical asset symbol used for persistence (e.g., "SHOP" for "SHOP.TO") */
  canonicalSymbol?: string;
  /** Canonical exchange MIC used for persistence */
  canonicalExchangeMic?: string;
  /** Market data provider that returned or resolved this symbol */
  providerId?: string;
  /** Provider-native symbol/code (e.g., Yahoo "BRK-B") */
  providerSymbol?: string;
  /** Friendly exchange name (e.g., "NASDAQ" instead of "NMS" or "XNAS") */
  exchangeName?: string;
  /** Currency derived from exchange (e.g., "USD", "CAD") */
  currency?: string;
  shortName: string;
  quoteType: string;
  symbol: string;
  index: string;
  score: number;
  typeDisplay: string;
  longName: string;
  dataSource?: string;
  /** Asset kind for custom assets (e.g., "INVESTMENT", "OTHER") */
  assetKind?: string;
  /** True if this asset already exists in user's database */
  isExisting?: boolean;
  /** The existing asset ID if found */
  existingAssetId?: string;
}

export interface MarketDataProviderInfo {
  id: string;
  name: string;
  logoFilename: string;
  lastSyncedDate: string | null;
}

export interface Tag {
  id: string;
  name: string;
  activityId: string | null;
}

export interface ImportValidationResult {
  activities: ActivityImport[];
  validationSummary: {
    totalRows: number;
    validCount: number;
    invalidCount: number;
  };
}

export type ValidationResult =
  | { status: 'success' }
  | { status: 'error'; errors: string[] };

// Holding types
export interface Instrument {
  id: string;
  symbol: string;
  name?: string | null;
  currency: string;
  notes?: string | null;
  quoteMode: QuoteMode;
  preferredProvider?: string | null;
  classifications?: AssetClassifications | null;
}

export interface AssetClassifications {
  assetType?: TaxonomyCategory | null;
  riskCategory?: TaxonomyCategory | null;
  assetClasses: CategoryWithWeight[];
  sectors: CategoryWithWeight[];
  regions: CategoryWithWeight[];
  customGroups: CategoryWithWeight[];
}

export interface TaxonomyCategory {
  id: string;
  taxonomyId: string;
  parentId?: string | null;
  name: string;
  key: string;
  color: string;
  description?: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CategoryRef {
  id: string;
  name: string;
}

export interface CategoryWithWeight {
  category: TaxonomyCategory;
  topLevelCategory: CategoryRef;
  weight: number;
}

export interface MonetaryValue {
  local: number;
  base: number;
}

export interface Lot {
  id: string;
  positionId: string;
  acquisitionDate: string;
  quantity: number;
  costBasis: number;
  acquisitionPrice: number;
  acquisitionFees: number;
}

export interface Position {
  id: string;
  accountId: string;
  assetId: string;
  quantity: number;
  averageCost: number;
  totalCostBasis: number;
  currency: string;
  inceptionDate: string;
  lots: Lot[];
}

export interface CashHolding {
  id: string;
  accountId: string;
  currency: string;
  amount: number;
  lastUpdated: string;
}

export interface Holding {
  id: string;
  holdingType: HoldingType;
  accountId: string;
  instrument?: Instrument | null;
  assetKind?: AssetKind | null;
  quantity: number;
  openDate?: string | Date | null;
  lots?: Lot[] | null;
  localCurrency: string;
  baseCurrency: string;
  fxRate?: number | null;
  marketValue: MonetaryValue;
  costBasis?: MonetaryValue | null;
  price?: number | null;
  unrealizedGain?: MonetaryValue | null;
  unrealizedGainPct?: number | null;
  realizedGain?: MonetaryValue | null;
  realizedGainPct?: number | null;
  totalGain?: MonetaryValue | null;
  totalGainPct?: number | null;
  income?: MonetaryValue | null;
  totalReturn?: MonetaryValue | null;
  totalReturnPct?: number | null;
  returnBasis?: MonetaryValue | null;
  dayChange?: MonetaryValue | null;
  dayChangePct?: number | null;
  prevCloseValue?: MonetaryValue | null;
  weight: number;
  asOfDate: string;
}

/**
 * Asset interface matching the v3 backend model.
 * Identity is opaque (UUID). Classification is via `kind` and `instrumentType`.
 */
export interface Asset {
  id: string;

  // Core identity
  kind: AssetKind;
  name?: string | null;
  displayCode?: string | null; // User-visible ticker/label
  notes?: string | null;
  metadata?: Record<string, unknown>;

  // Status
  isActive?: boolean;

  // Valuation
  quoteMode: QuoteMode;
  quoteCcy: string; // Currency prices/valuations are quoted in

  // Instrument identity (null for non-market assets)
  instrumentType?: string | null; // EQUITY, CRYPTO, FX, OPTION, METAL
  instrumentSymbol?: string | null; // Canonical symbol (AAPL, BTC, EUR)
  instrumentExchangeMic?: string | null; // ISO 10383 MIC (XNAS, XTSE)

  // Computed canonical key (read-only from DB)
  instrumentKey?: string | null;

  // Provider configuration (single JSON blob)
  providerConfig?: Record<string, unknown> | null;

  // Derived
  exchangeName?: string | null; // Friendly exchange name (e.g., "NASDAQ")

  // Audit
  createdAt: string;
  updatedAt: string;
}

export interface Quote {
  id: string;
  createdAt: string;
  dataSource: string;
  timestamp: string;
  assetId: string;
  open: number;
  high: number;
  low: number;
  volume: number;
  close: number;
  adjclose: number;
  currency: string;
  notes?: string | null;
}

export interface QuoteUpdate {
  timestamp: string;
  assetId: string;
  open: number;
  high: number;
  low: number;
  volume: number;
  close: number;
  dataSource: string;
}

export interface Settings {
  theme: string;
  font: string;
  baseCurrency: string;
  defaultReturnMetric: 'twr' | 'irr' | 'valueReturn';
  timezone?: string;
  onboardingCompleted: boolean;
  autoUpdateCheckEnabled: boolean;
  menuBarVisible: boolean;
  syncEnabled: boolean;
}

export type GoalType =
  | 'retirement'
  | 'education'
  | 'wedding'
  | 'home'
  | 'car'
  | 'custom_save_up';
export type GoalLifecycle = 'active' | 'achieved' | 'archived';
export type GoalHealth = 'on_track' | 'at_risk' | 'off_track' | 'not_applicable';

export interface Goal {
  id: string;
  goalType?: GoalType;
  title: string;
  description?: string;
  targetAmount: number;
  statusLifecycle?: GoalLifecycle;
  statusHealth?: GoalHealth;
  priority?: number;
  coverImageKey?: string;
  currency?: string;
  startDate?: string;
  targetDate?: string;
  summaryCurrentValue?: number;
  summaryProgress?: number;
  projectedCompletionDate?: string;
  projectedValueAtTargetDate?: number;
  summaryTargetAmount?: number;
  createdAt?: string;
  updatedAt?: string;
  allocations?: GoalAllocation[];
}

export interface GoalAllocation {
  id: string;
  goalId: string;
  accountId: string;
  sharePercent: number;
  taxBucket?: string;
}

export interface GoalProgress {
  goalId: string;
  name: string;
  targetValue: number;
  currentValue: number;
  progress: number;
  currency: string;
  statusHealth?: GoalHealth;
  targetDate?: string;
}

export interface IncomeByAsset {
  assetId: string;
  kind: AssetKind;
  symbol: string;
  name: string;
  income: number;
}

export interface IncomeSummary {
  period: string;
  byMonth: Record<string, number>;
  byType: Record<string, number>;
  byAsset: Record<string, IncomeByAsset>;
  byCurrency: Record<string, number>;
  totalIncome: number;
  currency: string;
  monthlyAverage: number;
  yoyGrowth: number | null;
}

export interface DateRange {
  from: Date | undefined;
  to: Date | undefined;
}

export type TimePeriod = '1D' | '1W' | '1M' | '3M' | '6M' | 'YTD' | '1Y' | '5Y' | 'ALL';

export type ValuationStatus = 'complete' | 'partialUnpriced' | 'unavailable';
export type BasisStatus = 'complete' | 'partialUnknown' | 'unknown' | 'notApplicable';

export interface AccountValuation {
  id: string;
  accountId: string;
  valuationDate: string;
  accountCurrency: string;
  baseCurrency: string;
  fxRateToBase: number;
  cashBalance: number;
  investmentMarketValue: number;
  totalValue: number;
  costBasis: number;
  netContribution: number;
  cashBalanceBase: number;
  investmentMarketValueBase: number;
  totalValueBase: number;
  costBasisBase: number;
  netContributionBase: number;
  externalInflowBase: number;
  externalOutflowBase: number;
  externalFlowSource:
    | 'NO_FLOW'
    | 'UNKNOWN'
    | 'CASH_AMOUNT'
    | 'QUOTE_DERIVED_MARKET_VALUE'
    | 'COST_BASIS_FALLBACK'
    | 'REMOVED_LOT_BASIS_FALLBACK'
    | 'LEGACY_ACTIVITY_AMOUNT_FALLBACK'
    | 'UNKNOWN_BOUNDARY_TRANSFER'
    | 'ACTIVITY_DERIVED'
    | 'STORED_GROSS'
    | 'NET_CONTRIBUTION_FALLBACK'
    | 'MIXED';
  performanceEligibleValueBase: number;
  valueStatus: ValuationStatus;
  basisStatus: BasisStatus;
  calculatedAt: string;
}

export interface AccountSummaryView {
  accountId: string;
  accountName: string;
  accountType: string;
  accountGroup: string | null;
  accountCurrency: string;
  totalValueAccountCurrency: number;
  totalValueBaseCurrency: number;
  baseCurrency: string;
  performance: SimplePerformanceResult;
}

export interface SimplePerformanceResult {
  accountId: string;
  totalValue?: number | null;
  accountCurrency?: string | null;
  baseCurrency?: string | null;
  fxRateToBase?: number | null;
  totalGainLossAmount?: number | null;
  cumulativeReturnPercent?: number | null;
  portfolioWeight?: number | null;
}

/** @deprecated Use SimplePerformanceResult. */
export type SimplePerformanceMetrics = SimplePerformanceResult;

export interface AccountGroup {
  groupName: string;
  accounts: AccountSummaryView[];
  totalValueBaseCurrency: number;
  baseCurrency: string;
  performance: SimplePerformanceResult;
  accountCount: number;
}

export interface ExchangeRate {
  id: string;
  fromCurrency: string;
  toCurrency: string;
  fromCurrencyName?: string;
  toCurrencyName?: string;
  rate: number;
  source: string;
  isLoading?: boolean;
  timestamp: string;
}

export interface ContributionLimit {
  id: string;
  groupName: string;
  contributionYear: number;
  limitAmount: number;
  accountIds?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export type NewContributionLimit = Omit<
  ContributionLimit,
  'id' | 'createdAt' | 'updatedAt'
>;

export interface AccountDeposit {
  amount: number;
  currency: string;
  convertedAmount: number;
}

export interface DepositsCalculation {
  total: number;
  baseCurrency: string;
  byAccount: Record<string, AccountDeposit>;
}

export const ACTIVITY_TYPE_PREFIX_LENGTH = 12;

export interface ReturnData {
  date: string;
  value: number;
}

export interface PerformanceResult {
  scope: PerformanceScopeDescriptor;
  period: PerformancePeriod;
  mode: ReturnMethod;
  returns: PerformanceReturns;
  attribution: PerformanceAttribution;
  risk: PerformanceRisk;
  dataQuality: PerformanceDataQuality;
  basisStatus?: BasisStatus;
  summary?: PerformanceSummary;
  series: ReturnData[];
  isHoldingsMode?: boolean;
  isMixedTrackingMode?: boolean;
}

/** @deprecated Use PerformanceResult. */
export type PerformanceMetrics = PerformanceResult;

export interface PerformanceScopeDescriptor {
  id: string;
  currency: string;
}

export interface PerformancePeriod {
  startDate?: string | null;
  endDate?: string | null;
}

export type ReturnMethod =
  | 'timeWeighted'
  | 'valueReturn'
  | 'symbolPriceBased'
  | 'notApplicable';

export type PerformanceSummaryBasis =
  | 'marketValue'
  | 'bookBasis'
  | 'mixed'
  | 'notApplicable';
export type PerformanceSummaryStatus = 'complete' | 'unavailable';

export interface PerformanceSummary {
  amount?: number | null;
  percent?: number | null;
  method: ReturnMethod;
  basis: PerformanceSummaryBasis;
  quality: PerformanceDataQuality['status'];
  amountStatus: PerformanceSummaryStatus;
  percentStatus: PerformanceSummaryStatus;
  basisStatus: BasisStatus;
  reasons: string[];
}

export interface PerformanceReturns {
  twr?: number | null;
  annualizedTwr?: number | null;
  /** Selected-period money-weighted return derived from annualized XIRR. */
  irr?: number | null;
  /** Annualized XIRR using dated cash flows. */
  annualizedIrr?: number | null;
  valueReturn?: number | null;
  annualizedValueReturn?: number | null;
}

export interface PerformanceAttribution {
  contributions: number;
  distributions: number;
  income: number;
  realizedPnl: number;
  unrealizedPnlChange: number;
  fxEffect: number;
  fees: number;
  taxes: number;
  residual: number;
}

export interface PerformanceRisk {
  volatility?: number | null;
  maxDrawdown?: number | null;
  peakDate?: string | null;
  troughDate?: string | null;
  recoveryDate?: string | null;
  drawdownDurationDays?: number | null;
}

export interface PerformanceDataQuality {
  status: 'ok' | 'partial' | 'noData' | 'notApplicable';
  warnings?: string[];
  notApplicableReasons?: string[];
}

export interface UpdateAssetProfile {
  id: string;
  displayCode?: string | null;
  name?: string | null;
  notes?: string | null;
  kind?: AssetKind | null;
  quoteMode?: QuoteMode | null;
  providerConfig?: Record<string, unknown> | null;
}

export interface TrackedItem {
  id: string;
  type: 'account' | 'symbol';
  name: string;
}

// ============================================================================
// Import Run Types
// ============================================================================

export type ImportRunType = 'SYNC' | 'IMPORT';
export type ImportRunMode = 'INITIAL' | 'INCREMENTAL' | 'BACKFILL' | 'REPAIR';
export type ImportRunStatus =
  | 'RUNNING'
  | 'APPLIED'
  | 'NEEDS_REVIEW'
  | 'FAILED'
  | 'CANCELLED';
export type ReviewMode = 'NEVER' | 'ALWAYS' | 'IF_WARNINGS';

export interface ImportRunSummary {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  warnings: number;
  errors: number;
  removed: number;
}

export interface ImportRun {
  id: string;
  accountId: string;
  sourceSystem: string;
  runType: ImportRunType;
  mode: ImportRunMode;
  status: ImportRunStatus;
  startedAt: string;
  finishedAt?: string;
  reviewMode: ReviewMode;
  appliedAt?: string;
  checkpointIn?: Record<string, unknown>;
  checkpointOut?: Record<string, unknown>;
  summary?: ImportRunSummary;
  warnings?: string[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// Sync State Types
// ============================================================================

export type SyncStatus = 'IDLE' | 'RUNNING' | 'NEEDS_REVIEW' | 'FAILED';

export interface BrokerSyncState {
  accountId: string;
  provider: string;
  checkpointJson?: Record<string, unknown>;
  lastAttemptedAt?: string;
  lastSuccessfulAt?: string;
  lastError?: string;
  lastRunId?: string;
  syncStatus: SyncStatus;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// Snapshot Types
// ============================================================================

export interface SnapshotInfo {
  id: string;
  snapshotDate: string;
  source: string;
  positionCount: number;
  cashCurrencyCount: number;
}

export interface SnapshotHoldingInput {
  assetId?: string;
  symbol: string;
  quantity: string;
  currency: string;
  averageCost?: string;
  exchangeMic?: string;
  quoteCcy?: string;
  instrumentType?: string;
  providerId?: string;
  providerSymbol?: string;
  name?: string;
  dataSource?: string;
  assetKind?: string;
}

export interface SnapshotPositionInput {
  symbol: string;
  quantity: string;
  avgCost?: string;
  currency: string;
  exchangeMic?: string;
  quoteCcy?: string;
  instrumentType?: string;
  providerId?: string;
  providerSymbol?: string;
}

export interface SnapshotInput {
  date: string;
  positions: SnapshotPositionInput[];
  cashBalances: Record<string, string>;
}

export interface SnapshotSymbolCheckResult {
  symbol: string;
  found: boolean;
  assetName?: string;
  assetId?: string;
  currency?: string;
  exchangeMic?: string;
}

export interface CheckSnapshotImportResult {
  existingDates: string[];
  symbols: SnapshotSymbolCheckResult[];
  validationErrors: string[];
}

export interface SnapshotImportResult {
  snapshotsImported: number;
  snapshotsFailed: number;
  errors: string[];
}

/**
 * Alternative asset kind for API requests (lowercase variants)
 */
export type AlternativeAssetKind =
  | 'property'
  | 'vehicle'
  | 'collectible'
  | 'precious'
  | 'liability'
  | 'other';

/**
 * An alternative asset holding (property, vehicle, collectible, precious metal,
 * liability, or other) as shown on the Holdings assets/liabilities tabs.
 * Monetary values are decimal strings to preserve precision.
 */
export interface AlternativeAssetHolding {
  /** Asset ID (e.g., "PROP-a1b2c3d4") */
  id: string;
  /** Asset kind (property, vehicle, collectible, precious, liability, other) */
  kind: string;
  /** Asset name */
  name: string;
  /** Asset symbol (display type label, e.g., "Property", "Vehicle") */
  symbol: string;
  /** Currency */
  currency: string;
  /** Current market value from latest quote */
  marketValue: string;
  /** Purchase price if available (from metadata) */
  purchasePrice?: string;
  /** Purchase date if available (from metadata) */
  purchaseDate?: string;
  /** Unrealized gain (market_value - purchase_price) */
  unrealizedGain?: string;
  /** Unrealized gain percentage */
  unrealizedGainPct?: string;
  /** Date of the latest valuation (ISO format) */
  valuationDate: string;
  /** Kind-specific metadata */
  metadata?: Record<string, unknown>;
  /** For liabilities: linked asset ID if any */
  linkedAssetId?: string;
  /** Asset notes */
  notes?: string | null;
}

/**
 * Request to create a new alternative asset.
 * NOTE: Alternative assets don't create accounts or activities - just asset + quotes.
 */
export interface CreateAlternativeAssetRequest {
  /** The kind of alternative asset */
  kind: AlternativeAssetKind;
  /** User-provided name for the asset */
  name: string;
  /** Currency code (e.g., "USD", "EUR") */
  currency: string;
  /** Current total value as decimal string */
  currentValue: string;
  /** Valuation date in ISO format (YYYY-MM-DD) */
  valueDate: string;
  /** Optional purchase price as decimal string - for gain calculation */
  purchasePrice?: string;
  /** Optional purchase date in ISO format */
  purchaseDate?: string;
  /** Kind-specific metadata (e.g., property_type, metal_type, unit) */
  metadata?: Record<string, string>;
  /** For liabilities: optional ID of the financed asset (UI-only linking) */
  linkedAssetId?: string;
}

/**
 * Response after creating an alternative asset
 */
export interface CreateAlternativeAssetResponse {
  /** Generated asset ID with prefix (e.g., "PROP-a1b2c3d4") */
  assetId: string;
  /** ID of the initial valuation quote */
  quoteId: string;
}

/**
 * Request to update the valuation of an alternative asset
 */
export interface UpdateAlternativeAssetValuationRequest {
  /** New value as decimal string */
  value: string;
  /** Valuation date in ISO format (YYYY-MM-DD) */
  date: string;
  /** Optional notes about this valuation */
  notes?: string;
}

/**
 * Response after updating a valuation
 */
export interface UpdateAlternativeAssetValuationResponse {
  /** ID of the created quote */
  quoteId: string;
  /** The valuation date */
  valuationDate: string;
  /** The value as decimal string */
  value: string;
}
