import { importActivitySchema, importMappingSchema, parseConfigSchema } from "@/lib/schemas";
export { ImportType } from "@/lib/schemas";
import * as z from "zod";
import {
  AccountType,
  ActivityStatus,
  ActivityType,
  ACTIVITY_TYPE_DISPLAY_NAMES,
  AssetKind,
  HoldingType,
  QuoteMode,
  SUBTYPE_DISPLAY_NAMES,
} from "./constants";

export {
  accountCapabilities,
  accountPurposeAccountTypes,
  AccountPurpose,
  accountSupportsPurpose,
  AccountType,
  ActivityStatus,
  ActivityType,
  ACTIVITY_SUBTYPES,
  ACTIVITY_TYPE_DISPLAY_NAMES,
  ACTIVITY_TYPES,
  AlternativeAssetKind,
  ALTERNATIVE_ASSET_DEFAULT_GROUPS,
  ALTERNATIVE_ASSET_KIND_DISPLAY_NAMES,
  AssetKind,
  ASSET_KIND_DISPLAY_NAMES,
  createPortfolioAccount,
  DataSource,
  defaultGroupForAccountType,
  ExportDataType,
  ExportedFileFormat,
  HOLDING_CATEGORY_FILTERS,
  HOLDING_GROUP_DISPLAY_NAMES,
  HOLDING_GROUP_ORDER,
  HoldingType,
  ImportFormat,
  isLiabilityAccountType,
  isReportAccountType,
  PricingMode,
  QuoteMode,
  REPORT_ACCOUNT_TYPES,
  SUBTYPE_DISPLAY_NAMES,
} from "./constants";

export type { HoldingCategoryFilterId } from "./constants";

export type { ActivitySubtype, ImportRequiredField } from "./constants";

export interface PortfolioWithAccounts {
  id: string;
  name: string;
  description?: string;
  sortOrder: number;
  accountIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface NewPortfolio {
  name: string;
  description?: string;
  sortOrder?: number;
  accountIds: string[];
}

export type AccountScope =
  | { type: "all" }
  | { type: "account"; accountId: string }
  | { type: "portfolio"; portfolioId: string }
  | { type: "accounts"; accountIds: string[] };

export interface Account {
  id: string;
  name: string;
  accountType: AccountType;
  group?: string; // Optional
  balance: number;
  currency: string;
  isDefault: boolean;
  isActive: boolean;
  isArchived: boolean;
  trackingMode: TrackingMode;
  createdAt: Date;
  updatedAt: Date;
  platformId?: string; // Optional - links to platform/broker
  accountNumber?: string; // Optional - account number from broker
  meta?: string; // Optional - additional metadata as JSON string
  provider?: string; // Optional - sync provider (e.g., 'SNAPTRADE', 'PLAID', 'MANUAL')
  providerAccountId?: string; // Optional - account ID in the provider's system
}

/**
 * Activity interface matching the new backend model
 * @deprecated Use the new Activity interface with activityType field
 */
export interface ActivityLegacy {
  id: string;
  type: ActivityType;
  date: Date | string;
  quantity: number;
  unitPrice: number;
  currency: string;
  fee: number;
  tax?: number;
  isDraft: boolean;
  comment?: string | null;
  accountId?: string | null;
  createdAt: Date | string;
  symbolProfileId: string;
  updatedAt: Date | string;
  quoteMode?: QuoteMode;
}

/**
 * Activity interface matching the new backend model
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

  /**
   * Optional spending event tag — sourced from the `activity_events` join
   * table and surfaced on `CashActivity` (the spending
   * search response). Plain `getActivities()` lists don't populate this
   * field; consumers that need the tag should go through the spending
   * cash-activity search, which JOINs against `activity_events`.
   */
  eventId?: string | null;

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
  return activity.activityTypeOverride !== undefined && activity.activityTypeOverride !== null;
}

/**
 * Get display name for an activity
 */
export function getActivityDisplayName(activity: Activity): string {
  // Check subtype first (most specific)
  if (activity.subtype && SUBTYPE_DISPLAY_NAMES[activity.subtype]) {
    return SUBTYPE_DISPLAY_NAMES[activity.subtype];
  }
  // Use effective type (respects user override)
  const effectiveType = getEffectiveType(activity);
  return (ACTIVITY_TYPE_DISPLAY_NAMES as Record<string, string>)[effectiveType] || effectiveType;
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
  /** Canonical exchange MIC code for asset identification */
  exchangeMic?: string;
  instrumentType?: string;
  // Sync/source metadata
  sourceSystem?: string;
  sourceRecordId?: string;
  sourceGroupId?: string;
  idempotencyKey?: string;
  importRunId?: string;
  isUserModified?: boolean;
  metadata?: Record<string, unknown>;
  transferOutId?: string;
  transferInId?: string;
  counterpartActivityId?: string;
  counterpartAccountId?: string;
  counterpartAmount?: string | null;
  counterpartCurrency?: string | null;
  counterpartFxRate?: string | null;
  subRows?: ActivityDetails[];
}

export interface ActivitySearchResponse {
  data: ActivityDetails[];
  meta: {
    totalRowCount: number;
  };
}

/**
 * Input used by the backend to resolve an activity asset before persistence.
 */
export interface AssetResolutionInput {
  id?: string; // Existing asset ID
  symbol?: string; // e.g., "AAPL" or undefined for cash
  exchangeMic?: string; // e.g., "XNAS" or undefined
  kind?: string; // e.g., "INVESTMENT", "OTHER" - asset kind hint
  name?: string; // Asset name hint for custom assets
  quoteMode?: QuoteMode;
  quoteCcy?: string; // Optional quote currency hint from search/provider (e.g., "GBp")
  instrumentType?: string; // Optional instrument type hint (e.g., "EQUITY", "CRYPTO")
  providerId?: string;
  providerSymbol?: string;
}

/** @deprecated Use AssetResolutionInput. */
export type SymbolInput = AssetResolutionInput;

export interface ActivityCreate {
  id?: string;
  idempotencyKey?: string;
  accountId: string;
  activityType: string;
  subtype?: string | null; // Semantic variation (DRIP, STAKING_REWARD, etc.)
  activityDate: string | Date;
  /** Optional grouping key (links paired transfer legs). */
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
  metadata?: string | Record<string, unknown>; // Metadata (serialized to JSON string before sending)
}

/**
 * Payload for updating an EXISTING activity.
 */
export interface ActivityUpdate {
  id: string;
  accountId: string;
  activityType: string;
  subtype?: string | null;
  activityDate: string | Date;
  /** Optional grouping key (links paired transfer legs). */
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
  metadata?: string | Record<string, unknown>; // Metadata (serialized to JSON string before sending)
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

export interface InternalTransferPairRequest {
  transferOutId?: string;
  transferInId?: string;
  sourceGroupId?: string;
  fromAccountId: string;
  toAccountId: string;
  activityDate: string | Date;
  sourceAmount: string | number;
  destinationAmount: string | number;
  sourceCurrency: string;
  destinationCurrency: string;
  fxRate?: string | number | null;
  notes?: string | null;
  transferMode?: "cash";
}

export interface InternalTransferPairResponse {
  transferOut: Activity;
  transferIn: Activity;
}

export interface TransferMatchCandidateRequest {
  activityId: string;
  windowDays?: number;
  limit?: number;
}

export interface TransferMatchCandidate {
  activity: Activity;
  matchKind: "cash" | "security" | "cash_fx_conversion";
  confidence: "high" | "medium" | "low";
  score: number;
  reasons: string[];
  warnings: string[];
}
export type ActivityImport = z.infer<typeof importActivitySchema>;
export type ImportMappingData = z.infer<typeof importMappingSchema>;
export type ParseConfig = z.infer<typeof parseConfigSchema>;
export type ImportTemplateScope = "SYSTEM" | "USER";

export interface ImportTemplateData {
  id: string;
  name: string;
  scope: ImportTemplateScope;
  kind: TemplateKind;
  fieldMappings: Record<string, string | string[]>;
  activityMappings: Record<string, string[]>;
  symbolMappings: Record<string, string>;
  accountMappings: Record<string, string>;
  symbolMappingMeta: Record<
    string,
    {
      exchangeMic?: string;
      symbolName?: string;
      quoteCcy?: string;
      instrumentType?: string;
      quoteMode?: QuoteMode;
      providerId?: string;
      providerSymbol?: string;
    }
  >;
  parseConfig?: ParseConfig;
}

export type TemplateKind = "CSV_ACTIVITY" | "CSV_HOLDINGS" | "BROKER_ACTIVITY";
export type TemplateContextKind = TemplateKind;

export type BrokerProfileScope = "ACCOUNT" | "BROKER";

export interface BrokerSyncProfileData {
  id: string;
  name: string;
  scope: ImportTemplateScope;
  sourceSystem: string;
  activityMappings: Record<string, string[]>;
  symbolMappings: Record<string, string>;
  symbolMappingMeta: Record<
    string,
    {
      exchangeMic?: string;
      symbolName?: string;
      quoteCcy?: string;
      instrumentType?: string;
      providerId?: string;
      providerSymbol?: string;
    }
  >;
}

export interface SaveBrokerSyncProfileRulesRequest {
  accountId: string;
  sourceSystem: string;
  scope: BrokerProfileScope;
  activityRulePatches: Record<string, string[]>;
  securityRulePatches: Record<string, string>;
  securityRuleMetaPatches: Record<
    string,
    {
      exchangeMic?: string;
      symbolName?: string;
      quoteCcy?: string;
      instrumentType?: string;
      providerId?: string;
      providerSymbol?: string;
    }
  >;
}

// Define a generic type for the parsed row data
export type CsvRowData = Record<string, string> & { lineNumber: string };
export interface CsvRowError {
  /** Type of error that occurred */
  type: string;
  /** Standardized error code */
  code: string;
  /** Human-readable error message */
  message: string;
  /** Row index where the error occurred (optional) */
  row?: number;
  /** Column/field index where the error occurred (optional) */
  index?: number;
}

/**
 * Error encountered during CSV parsing.
 */
export interface ParseError {
  /** Row index where the error occurred (if applicable) */
  rowIndex?: number;
  /** Column index where the error occurred (if applicable) */
  columnIndex?: number;
  /** Human-readable error message */
  message: string;
  /** Error type: "parse", "encoding", "structure" */
  errorType: string;
}

/**
 * Result of parsing a CSV file.
 */
export interface ParsedCsvResult {
  /** Headers extracted from the CSV */
  headers: string[];
  /** Data rows (each row is an array of string values) */
  rows: string[][];
  /** The configuration values actually used (with auto-detected values filled in) */
  detectedConfig: ParseConfig;
  /** Any errors encountered during parsing */
  errors: ParseError[];
  /** Total number of data rows (excluding headers and skipped rows) */
  rowCount: number;
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
  /** Provenance: "provider" | "exchange_inferred" */
  currencySource?: string;
  shortName: string;
  quoteType: string;
  symbol: string;
  index: string;
  score: number;
  typeDisplay: string;
  longName: string;
  dataSource?: string;
  quoteMode?: QuoteMode;
  /** Asset kind for custom assets (e.g., "SECURITY", "CRYPTO", "OTHER") */
  assetKind?: string;
  /** True if this asset already exists in user's database */
  isExisting?: boolean;
  /** The existing asset ID if found (e.g., "SEC:AAPL:XNAS") */
  existingAssetId?: string;
}

export interface ResolvedQuote {
  currency?: string;
  price?: number;
  resolvedProviderId?: string;
}

export interface ExchangeInfo {
  mic: string;
  name: string;
  longName: string;
  currency: string;
}

export interface MarketDataProviderInfo {
  id: string;
  name: string;
  logoFilename: string;
  lastSyncedDate: string | null; // ISO date string
  providerType?: string;
}

export interface MarketData {
  createdAt: Date;
  dataSource: string;
  date: Date;
  id: string;
  marketPrice: number;
  state: "CLOSE"; // assuming state can only be 'CLOSE', expand this as needed
  symbol: string;
  symbolProfileId: string;
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

/**
 * Result of importing activities, includes import run metadata
 */
export interface ImportActivitiesResult {
  /** The validated/imported activities */
  activities: ActivityImport[];
  /** Import run ID for tracking this batch */
  importRunId: string;
  /** Summary statistics for the import */
  summary: ImportActivitiesSummary;
}

/**
 * Summary statistics for an activity import
 */
export interface ImportActivitiesSummary {
  /** Total number of activities in the import request */
  total: number;
  /** Number of activities successfully imported */
  imported: number;
  /** Number of activities skipped (invalid or errors) */
  skipped: number;
  /** Number of duplicate activities detected and skipped */
  duplicates: number;
  /** Number of new assets created during import */
  assetsCreated: number;
  /** Whether the import was successful (no validation errors) */
  success: boolean;
  /** Human-readable reason for failure, if success is false */
  errorMessage?: string;
}

export type ValidationResult = { status: "success" } | { status: "error"; errors: string[] };

// Holding types based on Rust HoldingView model

export interface Instrument {
  id: string;
  symbol: string;
  name?: string | null;
  currency: string;
  notes?: string | null;
  quoteMode: QuoteMode;
  preferredProvider?: string | null;
  isin?: string | null;
  exchangeMic?: string | null;

  // Taxonomy-based classifications
  classifications?: AssetClassifications | null;
}

export interface MonetaryValue {
  local: number;
  base: number;
}

export interface Lot {
  id: string;
  positionId: string;
  acquisitionDate: string; // ISO date string
  quantity: number;
  costBasis: number;
  acquisitionPrice: number;
  acquisitionFees: number;
}

export type AssetLotSource = "TRANSACTION_LOT" | "SNAPSHOT_POSITION";

export interface AssetLotView {
  id: string;
  accountId: string;
  accountName: string;
  assetId: string;
  source: AssetLotSource;
  currency: string;
  baseCurrency?: string | null;
  valuationCurrency: string;
  quantity: number;
  originalQuantity: number;
  remainingQuantity: number;
  costBasis: number;
  costBasisBase?: number | null;
  unitCost: number;
  fees: number;
  taxes: number;
  taxesBase?: number | null;
  valuationUnitCost?: number | null;
  valuationCostBasis?: number | null;
  fxRateToBase?: number | null;
  splitRatio: number;
  contractMultiplier: number;
  acquisitionDate?: string | null;
  snapshotDate?: string | null;
  isClosed: boolean;
  closeDate?: string | null;
  disposalProceeds?: number | null;
  disposalCostBasis?: number | null;
  disposalCostBasisBase?: number | null;
  realizedPnl?: number | null;
  realizedPnlBase?: number | null;
  valuationDisposalCostBasis?: number | null;
  valuationRealizedPnl?: number | null;
}

export interface Position {
  id: string;
  accountId: string;
  assetId: string;
  quantity: number;
  averageCost: number;
  totalCostBasis: number;
  currency: string;
  inceptionDate: string; // ISO date string
  lots: Lot[];
}

export interface CashHolding {
  id: string;
  accountId: string;
  currency: string;
  amount: number;
  lastUpdated: string; // ISO date string
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
  contractMultiplier?: number | null;
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
  /** Source account IDs for aggregated holdings (portfolio/multi-account scope). Empty for single-account. */
  sourceAccountIds?: string[];
}

/**
 * Lightweight holding summary for allocation drill-down views.
 * Contains only the fields needed to display a list of holdings for a category.
 */
export interface HoldingSummary {
  id: string;
  symbol: string;
  name?: string | null;
  accountName?: string | null;
  holdingType: HoldingType;
  quantity: number;
  marketValue: number; // Base currency value
  currency: string;
  weightInCategory: number; // Percentage weight within the category (0-100)
}

/**
 * Holdings within an allocation category.
 * Returned by getHoldingsByAllocation for drill-down views.
 */
export interface AllocationHoldings {
  taxonomyId: string;
  taxonomyName: string;
  categoryId: string;
  categoryName: string;
  color: string;
  holdings: HoldingSummary[];
  totalValue: number;
  currency: string;
}

/**
 * Asset interface matching the new provider-agnostic backend model
 * Note: Legacy fields (assetClass, assetSubClass, isin, profile) are stored in metadata.legacy
 * for migration purposes only. Use taxonomy system for classifications.
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
  quoteMode: "MARKET" | "MANUAL";
  quoteCcy: string; // Currency prices/valuations are quoted in
  valuationMarketPrice?: number | null;
  valuationMarketCurrency?: string | null;

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
  createdAt: string; // ISO date string
  updatedAt: string; // ISO date string
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

export interface LatestQuoteSnapshot {
  quote?: Quote | null;
  isStale: boolean;
  effectiveMarketDate: string; // YYYY-MM-DD in market timezone semantics
  quoteDate?: string | null; // YYYY-MM-DD extracted from quote timestamp
  noQuoteReason?: {
    code: string;
    message: string;
  } | null;
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
  language: string;
  baseCurrency: string;
  defaultReturnMetric: "twr" | "irr" | "valueReturn";
  timezone: string;
  onboardingCompleted: boolean;
  autoUpdateCheckEnabled: boolean;
  menuBarVisible: boolean;
  syncEnabled: boolean;
}

export interface SettingsContextType {
  settings: Settings | null;
  isLoading: boolean;
  isError: boolean;
  updateBaseCurrency: (currency: Settings["baseCurrency"]) => Promise<void>;
  accountsGrouped: boolean;
  setAccountsGrouped: (value: boolean) => void;
}

export type GoalType = "retirement" | "education" | "wedding" | "home" | "car" | "custom_save_up";
export type GoalLifecycle = "active" | "achieved" | "archived";
export type GoalHealth = "on_track" | "at_risk" | "off_track" | "not_applicable";
export type PlanKind = "retirement" | "save_up";
export type PlannerMode = "fire" | "traditional";

export interface Goal {
  id: string;
  goalType: GoalType;
  title: string;
  description?: string;
  targetAmount?: number;
  statusLifecycle: GoalLifecycle;
  statusHealth: GoalHealth;
  priority: number;
  coverImageKey?: string;
  currency?: string;
  startDate?: string;
  targetDate?: string;
  summaryCurrentValue?: number;
  summaryProgress?: number;
  projectedCompletionDate?: string;
  projectedValueAtTargetDate?: number;
  createdAt: string;
  updatedAt: string;
  summaryTargetAmount?: number;
}

export interface NewGoal {
  id?: string;
  goalType: GoalType;
  title: string;
  description?: string;
  targetAmount?: number;
  statusLifecycle?: GoalLifecycle;
  statusHealth?: GoalHealth;
  priority?: number;
  coverImageKey?: string;
  currency?: string;
  startDate?: string;
  targetDate?: string;
}

export interface GoalFundingRule {
  id: string;
  goalId: string;
  accountId: string;
  sharePercent: number;
  taxBucket?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GoalFundingRuleInput {
  accountId: string;
  sharePercent: number;
  taxBucket?: string;
}

export interface GoalPlan {
  goalId: string;
  planKind: PlanKind;
  plannerMode?: PlannerMode;
  settingsJson: string;
  summaryJson: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SaveGoalPlan {
  goalId: string;
  planKind: PlanKind;
  plannerMode?: PlannerMode;
  settingsJson: string;
  summaryJson?: string;
}

export interface IncomeByAsset {
  assetId: string;
  kind: AssetKind;
  symbol: string;
  name: string;
  income: number;
}

export interface IncomeByAccount {
  accountId: string;
  accountName: string;
  byMonth: Record<string, number>;
  total: number;
}

export interface IncomeSummary {
  period: string;
  byMonth: Record<string, number>;
  byType: Record<string, number>;
  byAsset: Record<string, IncomeByAsset>;
  byCurrency: Record<string, number>;
  byAccount: Record<string, IncomeByAccount>;
  totalIncome: number;
  currency: string;
  monthlyAverage: number;
  yoyGrowth: number | null; // Changed from optional to nullable
}

// Define custom DateRange type matching react-day-picker's
export interface DateRange {
  from: Date | undefined;
  to: Date | undefined;
}

export type TimePeriod = "1D" | "1W" | "1M" | "3M" | "6M" | "YTD" | "1Y" | "5Y" | "ALL";

export type ValuationStatus = "complete" | "partialUnpriced" | "unavailable";

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
  bookBasis: number;
  netContribution: number;
  cashBalanceBase: number;
  investmentMarketValueBase: number;
  totalValueBase: number;
  costBasisBase: number;
  bookBasisBase: number;
  netContributionBase: number;
  externalInflowBase: number;
  externalOutflowBase: number;
  externalFlowSource:
    | "NO_FLOW"
    | "UNKNOWN"
    | "CASH_AMOUNT"
    | "QUOTE_DERIVED_MARKET_VALUE"
    | "COST_BASIS_FALLBACK"
    | "REMOVED_LOT_BASIS_FALLBACK"
    | "LEGACY_ACTIVITY_AMOUNT_FALLBACK"
    | "UNKNOWN_BOUNDARY_TRANSFER"
    | "ACTIVITY_DERIVED"
    | "STORED_GROSS"
    | "NET_CONTRIBUTION_FALLBACK"
    | "MIXED";
  performanceEligibleValueBase: number;
  valueStatus: ValuationStatus;
  basisStatus: BasisStatus;
  calculatedAt: string;
}

export interface CurrentAccountValuation {
  accountId: string;
  accountCurrency: string;
  baseCurrency: string;
  cashBalance: number;
  investmentMarketValue: number;
  totalValue: number;
  cashBalanceBase: number;
  investmentMarketValueBase: number;
  totalValueBase: number;
  sourceDataAsOf: string | null;
  calculatedAt: string;
  warnings: string[];
}

export interface CurrentValuationSplit {
  currency: string;
  valueBase: number;
  valueLocal?: number | null;
  percentage: number;
}

export interface CurrentValuationSummary {
  scopeId: string;
  baseCurrency: string;
  cashBalanceBase: number;
  investmentMarketValueBase: number;
  totalValueBase: number;
  holdingsCount: number;
  accountCount: number;
  currencySplit: CurrentValuationSplit[];
  cashCurrencySplit: CurrentValuationSplit[];
  sourceDataAsOf: string | null;
  calculatedAt: string;
  warnings: string[];
}

export interface CurrentValuationResponse {
  summary: CurrentValuationSummary;
  accounts: CurrentAccountValuation[];
}

export interface AccountValueSource {
  accountId: string;
  totalValue?: number | null;
  totalValueBase?: number | null;
  fxRateToBase?: number | null;
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

export type NewContributionLimit = Omit<ContributionLimit, "id" | "createdAt" | "updatedAt">;

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

// Renamed from CumulativeReturn to match Rust struct ReturnData
export interface ReturnData {
  date: string; // Changed from CumulativeReturn
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

export type PerformanceSummaryProfile = "full" | "summary" | "dashboard";

export interface PerformanceScopeDescriptor {
  id: string;
  currency: string;
}

export interface PerformancePeriod {
  startDate?: string | null;
  endDate?: string | null;
}

export type ReturnMethod = "timeWeighted" | "valueReturn" | "symbolPriceBased" | "notApplicable";

export type BasisStatus = "complete" | "partialUnknown" | "unknown" | "notApplicable";

export type PerformanceSummaryBasis = "marketValue" | "bookBasis" | "mixed" | "notApplicable";

export type PerformanceSummaryStatus = "complete" | "unavailable";

export interface PerformanceSummary {
  amount?: number | null;
  percent?: number | null;
  method: ReturnMethod;
  basis: PerformanceSummaryBasis;
  quality: PerformanceDataQuality["status"];
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
  status: "ok" | "partial" | "noData" | "notApplicable";
  warnings?: string[];
  notApplicableReasons?: string[];
}

export interface PerformanceSummaryScope {
  accountIds: string[];
}

export type PerformanceSummaryMap = Record<string, PerformanceResult>;

export interface NewAsset {
  id?: string;
  kind: string;
  name?: string;
  displayCode?: string;
  isActive: boolean;
  quoteMode: string;
  quoteCcy: string;
  instrumentType?: string;
  instrumentSymbol?: string;
  instrumentExchangeMic?: string;
  providerId?: string;
  providerSymbol?: string;
  providerConfig?: Record<string, unknown> | null;
  notes?: string;
}

export interface ImportAssetCandidate {
  key: string;
  accountId: string;
  symbol: string;
  currency?: string;
  instrumentType?: string;
  quoteCcy?: string;
  quoteMode?: string;
  exchangeMic?: string;
  isin?: string;
  providerId?: string;
  providerSymbol?: string;
}

export type ImportAssetPreviewStatus =
  | "EXISTING_ASSET"
  | "AUTO_RESOLVED_NEW_ASSET"
  | "NEEDS_FIXING";

export interface ImportAssetPreviewItem {
  key: string;
  status: ImportAssetPreviewStatus;
  resolutionSource: string;
  reviewSymbol?: string;
  assetId?: string;
  draft?: NewAsset;
  errors?: Record<string, string[]>;
  warnings?: Record<string, string[]>;
}

export interface UpdateAssetProfile {
  id: string;
  displayCode?: string | null;
  name?: string | null;
  notes?: string | null;
  kind?: AssetKind | null;
  quoteMode?: QuoteMode | null;
  quoteCcy?: string | null;
  instrumentType?: string | null;
  instrumentExchangeMic?: string | null;
  providerConfig?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

// Rename ComparisonItem to TrackedItem
export interface TrackedItem {
  id: string;
  type: "account" | "symbol";
  name: string;
  accountScope?: AccountScope;
}

// Addon Store Types
export interface AddonStoreListing {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  downloadUrl: string;
  downloads: number;
  rating: number;
  reviewCount: number;
  status?: "active" | "inactive" | "deprecated" | "coming-soon";
  lastUpdated: string;
  releaseNotes: string;
  changelogUrl: string;
  images: string[];
  /** Classification tags for filtering */
  tags?: string[];
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  notes?: string;
  pubDate?: string;
  isAppStoreBuild: boolean;
  storeUrl?: string;
  changelogUrl?: string;
  screenshots?: string[];
}

// Platform/Broker type
export interface Platform {
  id: string;
  name: string | null;
  url: string;
  externalId: string | null;
  logoUrl?: string | null;
}

// ============================================================================
// Import Run Types
// ============================================================================

export type ImportRunType = "SYNC" | "IMPORT";
export type ImportRunMode = "INITIAL" | "INCREMENTAL" | "BACKFILL" | "REPAIR";
export type ImportRunStatus = "RUNNING" | "APPLIED" | "NEEDS_REVIEW" | "FAILED" | "CANCELLED";
export type ReviewMode = "NEVER" | "ALWAYS" | "IF_WARNINGS";

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

export type SyncStatus = "IDLE" | "RUNNING" | "NEEDS_REVIEW" | "FAILED";

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
// Alternative Assets Types
// ============================================================================

/**
 * Alternative asset kind for API requests (lowercase variants)
 */
export type AlternativeAssetKindApi =
  | "property"
  | "vehicle"
  | "collectible"
  | "precious"
  | "liability"
  | "other";

/**
 * Request to create a new alternative asset (property, vehicle, collectible, etc.)
 * All monetary values are decimal strings to preserve precision.
 *
 * NOTE: Alternative assets don't create accounts or activities - just asset + quotes.
 */
export interface CreateAlternativeAssetRequest {
  /** The kind of alternative asset */
  kind: AlternativeAssetKindApi;
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
export interface UpdateValuationRequest {
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
export interface UpdateValuationResponse {
  /** ID of the created quote */
  quoteId: string;
  /** The valuation date */
  valuationDate: string;
  /** The value as decimal string */
  value: string;
}

/**
 * Request to link a liability to an asset (UI-only aggregation)
 */
export interface LinkLiabilityRequest {
  /** ID of the property/vehicle to link to */
  targetAssetId: string;
}

/**
 * Information about a stale asset valuation
 */
export interface StaleAssetInfo {
  /** Asset ID */
  assetId: string;
  /** Asset name (if available) */
  name?: string;
  /** Date of the last valuation (ISO format) */
  valuationDate: string;
  /** Number of days since last valuation */
  daysStale: number;
}

/**
 * Individual item in the assets or liabilities breakdown
 */
export interface BreakdownItem {
  /** Category key (e.g., "cash", "investments", "properties") */
  category: string;
  /** Display name */
  name: string;
  /** Value in base currency (positive magnitude) as decimal string */
  value: string;
  /** Optional: asset ID for individual items */
  assetId?: string;
  /** Individual items rolled up into this category, for drill-down. */
  children?: BreakdownItem[];
}

/**
 * Assets section of the balance sheet
 */
export interface AssetsSection {
  /** Total assets value in base currency as decimal string */
  total: string;
  /** Breakdown by category */
  breakdown: BreakdownItem[];
}

/**
 * Liabilities section of the balance sheet
 */
export interface LiabilitiesSection {
  /** Total liabilities value in base currency as decimal string */
  total: string;
  /** Breakdown by individual liability */
  breakdown: BreakdownItem[];
}

/**
 * Response containing net worth calculation - structured as a balance sheet
 */
export interface NetWorthResponse {
  /** As-of date for the calculation (ISO format) */
  date: string;
  /** Assets section with total and breakdown */
  assets: AssetsSection;
  /** Liabilities section with total and breakdown */
  liabilities: LiabilitiesSection;
  /** Net worth (assets - liabilities) as decimal string */
  netWorth: string;
  /** Base currency used for the calculation */
  currency: string;
  /** Oldest valuation date used in the calculation */
  oldestValuationDate?: string;
  /** Assets with valuations older than 90 days */
  staleAssets: StaleAssetInfo[];
}

/**
 * Single point in net worth history.
 * Provides component-level breakdown for accurate gain calculation.
 */
export interface NetWorthHistoryPoint {
  /** Date of this data point (ISO format) */
  date: string;

  // Component values
  /** Portfolio value from aggregated real-account valuations as decimal string */
  portfolioValue: string;
  /** Alternative assets value (properties, vehicles, collectibles, etc.) as decimal string */
  alternativeAssetsValue: string;
  /** Total liabilities as decimal string (positive magnitude, subtracted for net worth) */
  totalLiabilities: string;

  // Totals
  /** Total assets = portfolio_value + alternative_assets_value as decimal string */
  totalAssets: string;
  /** Net worth (assets - liabilities) as decimal string */
  netWorth: string;

  // For gain calculation
  /** Cumulative net contributions (deposits - withdrawals) from portfolio as decimal string */
  netContribution: string;

  /**
   * Per-category / per-liability values at this date as decimal strings.
   * Keys mirror the point-in-time breakdown: asset category keys (`cash`,
   * `investments`, `properties`, ...) for aggregated asset categories, and the
   * individual liability id (matching `BreakdownItem.assetId`) for each liability.
   */
  breakdown: Record<string, string>;

  /** Currency */
  currency: string;
}

/**
 * Alternative asset holding with valuation details.
 * Simplified model: no account, no activities, just asset + quotes.
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
 * Property-specific metadata fields
 */
export interface PropertyMetadata {
  propertyType?: "residence" | "rental" | "land" | "commercial";
  address?: string;
  purchasePrice?: string;
  purchaseDate?: string;
  purchaseCurrency?: string;
}

/**
 * Vehicle-specific metadata fields
 */
export interface VehicleMetadata {
  vehicleType?: "car" | "motorcycle" | "boat" | "rv";
  purchasePrice?: string;
  purchaseDate?: string;
}

/**
 * Collectible-specific metadata fields
 */
export interface CollectibleMetadata {
  collectibleType?: "art" | "wine" | "watch" | "jewelry" | "memorabilia";
  purchasePrice?: string;
  purchaseDate?: string;
}

/**
 * Physical precious metals-specific metadata fields
 */
export interface PreciousMetalMetadata {
  metalType?: "gold" | "silver" | "platinum" | "palladium";
  unit?: "oz" | "g" | "kg";
  purchasePricePerUnit?: string;
  purchaseDate?: string;
}

/**
 * Liability-specific metadata fields
 */
export interface LiabilityMetadata {
  liabilityType?:
    | "mortgage"
    | "auto_loan"
    | "student_loan"
    | "credit_card"
    | "personal_loan"
    | "heloc";
  linkedAssetId?: string;
  originalAmount?: string;
  originationDate?: string;
  interestRate?: string;
}

/**
 * User configuration for net worth view
 */
export interface NetWorthConfig {
  includeInvestments: boolean;
  includeProperties: boolean;
  includeVehicles: boolean;
  includeCollectibles: boolean;
  includePreciousMetals: boolean;
  includeOtherAssets: boolean;
  includeLiabilities: boolean;
}

// ============================================================================
// Taxonomy Types
// ============================================================================

/**
 * Taxonomy - a classification system (e.g., "Asset Classes", "Regions", "Industries")
 */
export type TaxonomyScope = "asset" | "activity";

export interface Taxonomy {
  id: string;
  name: string;
  color: string;
  description?: string | null;
  isSystem: boolean;
  isSingleSelect: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  /** What entity kind this taxonomy classifies. Defaults to "asset" for backwards compat. */
  scope: TaxonomyScope;
}

/**
 * Category within a taxonomy (hierarchical)
 */
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
  /** Optional Lucide icon name for UI display (used by spending categories). */
  icon?: string | null;
}

/**
 * Taxonomy with its categories
 */
export interface TaxonomyWithCategories {
  taxonomy: Taxonomy;
  categories: TaxonomyCategory[];
}

/**
 * Assignment of an asset to a taxonomy category
 */
export interface AssetTaxonomyAssignment {
  id: string;
  assetId: string;
  taxonomyId: string;
  categoryId: string;
  weight: number; // basis points: 10000 = 100%
  source: string; // "manual", "provider", "inferred"
  createdAt: string;
  updatedAt: string;
}

/**
 * Create a new taxonomy
 */
export interface NewTaxonomy {
  id?: string | null;
  name: string;
  color: string;
  description?: string | null;
  isSystem: boolean;
  isSingleSelect: boolean;
  sortOrder: number;
  scope?: TaxonomyScope;
}

/**
 * Create a new category
 */
export interface NewTaxonomyCategory {
  id?: string | null;
  taxonomyId: string;
  parentId?: string | null;
  name: string;
  key: string;
  color: string;
  description?: string | null;
  sortOrder: number;
  icon?: string | null;
}

/**
 * Create a new asset taxonomy assignment
 */
export interface NewAssetTaxonomyAssignment {
  id?: string | null;
  assetId: string;
  taxonomyId: string;
  categoryId: string;
  weight: number; // basis points: 10000 = 100%
  source: string;
}

/**
 * JSON format for taxonomy import/export (Portfolio Performance compatible)
 */
export interface TaxonomyJson {
  name: string;
  color: string;
  categories: TaxonomyCategoryJson[];
  instruments?: TaxonomyInstrumentMappingJson[];
}

/**
 * Category in JSON format (recursive children structure)
 */
export interface TaxonomyCategoryJson {
  name: string;
  key: string;
  color: string;
  description?: string | null;
  children: TaxonomyCategoryJson[];
}

/**
 * Instrument mapping in taxonomy JSON
 */
export interface TaxonomyInstrumentMappingJson {
  isin?: string | null;
  symbol?: string | null;
  categoryKey: string;
  weight: number;
}

// Asset classifications from taxonomy system
export interface AssetClassifications {
  assetType?: TaxonomyCategory | null;
  riskCategory?: TaxonomyCategory | null;
  assetClasses: CategoryWithWeight[];
  sectors: CategoryWithWeight[];
  regions: CategoryWithWeight[];
  customGroups: CategoryWithWeight[];
}

// Simple reference to a category with just id and name (for top-level lookups)
export interface CategoryRef {
  id: string;
  name: string;
}

export interface CategoryWithWeight {
  category: TaxonomyCategory;
  // The top-level ancestor category (for hierarchical taxonomies like GICS)
  // Used for filtering when allocations are rolled up to top-level
  topLevelCategory: CategoryRef;
  weight: number; // 0-100 percentage
}

// Migration status
export interface MigrationStatus {
  needed: boolean;
  assetsWithLegacyData: number;
  assetsAlreadyMigrated: number;
}

// Portfolio allocation types for taxonomy-based breakdowns
export interface CategoryAllocation {
  categoryId: string;
  categoryName: string;
  color: string;
  value: number; // Base currency value
  percentage: number; // 0-100
  children?: CategoryAllocation[]; // Child allocations for drill-down
}

export interface TaxonomyAllocation {
  taxonomyId: string;
  taxonomyName: string;
  color: string;
  categories: CategoryAllocation[];
}

export interface PortfolioAllocations {
  assetClasses: TaxonomyAllocation;
  sectors: TaxonomyAllocation;
  regions: TaxonomyAllocation;
  riskCategory: TaxonomyAllocation;
  securityTypes: TaxonomyAllocation;
  customGroups: TaxonomyAllocation[];
  totalValue: number;
}

export interface MigrationResult {
  sectorsMigrated: number;
  countriesMigrated: number;
  assetsProcessed: number;
  errors: string[];
}

// ============================================================================
// Tracking Mode Types
// ============================================================================

/**
 * Tracking mode for an account - determines how holdings are tracked.
 * Matches the backend TrackingMode enum.
 */
export type TrackingMode = "TRANSACTIONS" | "HOLDINGS" | "NOT_SET";

// ============================================================================
// AI Provider Types
// ============================================================================

/**
 * Model capabilities from the catalog.
 */
export interface ModelCapabilities {
  tools: boolean;
  thinking: boolean;
  vision: boolean;
  /** Whether the model supports streaming responses. */
  streaming: boolean;
}

/**
 * Capability overrides for a specific model (tools/streaming/vision).
 * User can set these for fetched/unknown models that aren't in the catalog.
 */
export interface ModelCapabilityOverrides {
  tools?: boolean;
  thinking?: boolean;
  vision?: boolean;
  streaming?: boolean;
}

/**
 * A model in the merged view returned to the UI.
 */
export interface MergedModel {
  id: string;
  /** Display name (may differ from id for fetched models). */
  name?: string;
  capabilities: ModelCapabilities;
  /** Whether this model is from the catalog (true) or dynamically fetched (false). */
  isCatalog: boolean;
  /** Whether this model is marked as a user favorite. */
  isFavorite: boolean;
  /** Whether capabilities have user overrides applied. */
  hasCapabilityOverrides: boolean;
}

/**
 * Connection field definition for provider configuration UI.
 */
export interface ConnectionField {
  key: string;
  label: string;
  type: string;
  placeholder: string;
  required: boolean;
  helpUrl?: string;
}

/**
 * Capability metadata from the catalog.
 */
export interface CapabilityInfo {
  name: string;
  description: string;
  icon: string;
}

/**
 * Catalog-defined generation tuning defaults for a provider. Any field can be
 * partially overridden by the user via `ProviderTuningOverrides`.
 *
 * Validation bounds (server-side, when overrides are persisted):
 * - `temperature`: 0.0 – 2.0
 * - `maxTokens` / `maxTokensThinking`: 256 – 131072
 */
export interface ProviderTuning {
  /** Sampling temperature. Lower values → more deterministic output. */
  temperature?: number;
  /** Maximum output tokens per response (safety cap). */
  maxTokens?: number;
  /** Max tokens when the model's thinking/reasoning mode is enabled. */
  maxTokensThinking?: number;
  /**
   * Provider-specific raw JSON (Ollama's `num_ctx`/`repeat_penalty`, Gemini's
   * `safetySettings`, etc.). Catalog-only — not user-editable.
   */
  extraOptions?: Record<string, unknown>;
}

/**
 * User-provided tuning overrides. Any field left undefined falls back to the
 * catalog default.
 *
 * `extraOptionOverrides` is a per-key merge onto the catalog's `extraOptions`.
 * Only primitive values (number, boolean, string, or null to reset) are
 * accepted — complex shapes (arrays, objects like Gemini's `safetySettings`)
 * remain catalog-only.
 */
export interface ProviderTuningOverrides {
  temperature?: number;
  maxTokens?: number;
  maxTokensThinking?: number;
  extraOptionOverrides?: Record<string, number | boolean | string | null>;
}

/**
 * A provider in the merged view returned to the UI.
 * Combines catalog data with user settings and computed fields.
 */
export interface MergedProvider {
  // From catalog (immutable)
  id: string;
  name: string;
  type: string;
  icon: string;
  description: string;
  envKey: string;
  connectionFields: ConnectionField[];
  models: MergedModel[];
  defaultModel: string;
  documentationUrl: string;

  // From user settings (mutable)
  enabled: boolean;
  favorite: boolean;
  selectedModel?: string;
  customUrl?: string;
  priority: number;
  /** User's favorite model IDs (including fetched models not in catalog). */
  favoriteModels: string[];
  /** Capability overrides for specific models. */
  modelCapabilityOverrides: Record<string, ModelCapabilityOverrides>;
  /** Allowlist of tool IDs that this provider can use. null = all tools enabled. */
  toolsAllowlist?: string[] | null;

  // Computed
  hasApiKey: boolean;
  isDefault: boolean;
  /** Whether this provider supports dynamic model listing via API. */
  supportsModelListing: boolean;

  // Tuning (three views: what ships, what user changed, what runtime uses)
  /** Catalog tuning defaults for this provider (immutable reference). */
  catalogTuning?: ProviderTuning;
  /** User-supplied overrides; undefined means the user hasn't customized. */
  tuningOverrides?: ProviderTuningOverrides;
  /** Effective tuning the runtime will use (catalog merged with overrides). */
  resolvedTuning?: ProviderTuning;
}

/**
 * The complete merged response returned to the UI.
 */
export interface AiProvidersResponse {
  providers: MergedProvider[];
  capabilities: Record<string, CapabilityInfo>;
  defaultProvider?: string;
}

/**
 * Update for a single model's capability overrides.
 */
export interface ModelCapabilityOverrideUpdate {
  /** The model ID to update. */
  modelId: string;
  /** The capability overrides to set. Use undefined to remove overrides for this model. */
  overrides?: ModelCapabilityOverrides;
}

/**
 * Request to update a single provider's settings.
 */
export interface UpdateProviderSettingsRequest {
  providerId: string;
  enabled?: boolean;
  favorite?: boolean;
  selectedModel?: string;
  customUrl?: string;
  priority?: number;
  /** Set capability overrides for a specific model. */
  modelCapabilityOverride?: ModelCapabilityOverrideUpdate;
  /** Update the list of favorite models (replaces the entire list). */
  favoriteModels?: string[];
  /** Update tools allowlist. null = all tools enabled, [] = no tools, [...] = only specified tools. */
  toolsAllowlist?: string[] | null;
  /** Update user tuning overrides. null = reset to catalog defaults, {} or partial = set. */
  tuningOverrides?: ProviderTuningOverrides | null;
}

/**
 * Request to set the default provider.
 */
export interface SetDefaultProviderRequest {
  providerId?: string;
}

/**
 * Model info returned from provider API.
 */
export interface FetchedModel {
  id: string;
  name?: string;
}

/**
 * Response from model listing.
 */
export interface ListModelsResponse {
  models: FetchedModel[];
  supportsListing: boolean;
}

// ============================================================================
// Health Center Types
// ============================================================================

/**
 * Severity level for health issues.
 */
export type HealthSeverity = "INFO" | "WARNING" | "ERROR" | "CRITICAL";

/**
 * Category of health issue.
 */
export type HealthCategory =
  | "PRICE_STALENESS"
  | "FX_INTEGRITY"
  | "CLASSIFICATION"
  | "DATA_CONSISTENCY"
  | "ACCOUNT_CONFIGURATION"
  | "SETTINGS_CONFIGURATION";

/**
 * Navigation action for health issue resolution.
 */
export interface NavigateAction {
  route: string;
  query?: Record<string, unknown>;
  label: string;
}

/**
 * Fix action for health issue resolution.
 */
export interface FixAction {
  id: string;
  label: string;
  /** Arbitrary JSON payload (e.g. an array of asset IDs); shape varies by action id. */
  payload: unknown;
}

/**
 * An item affected by a health issue.
 */
export interface AffectedItem {
  id: string;
  name: string;
  symbol?: string;
  route?: string;
}

/**
 * A single supporting-evidence row for a diagnostic.
 */
export interface Evidence {
  label: string;
  value: string;
  route?: string;
}

/**
 * An ordered remediation action attached to a diagnostic.
 *
 * Serialized flat with a `kind` discriminator: `fix` carries the {@link FixAction}
 * fields (id/label/payload); `navigate` carries the {@link NavigateAction} fields
 * (route/query/label).
 */
export type DiagnosticAction = { primary: boolean } & (
  | ({ kind: "fix" } & FixAction)
  | ({ kind: "navigate" } & NavigateAction)
);

export type DiagnosticDomain =
  | "unknown"
  | "accountSetup"
  | "ledger"
  | "marketData"
  | "fx"
  | "classification"
  | "generatedData"
  | "performanceInputs";

export type DiagnosticLevel = "source" | "generated" | "workflow";

export interface HealthImpact {
  affectedCount?: number;
  affectedMvPct?: number;
  amount?: number;
  currency?: string;
  description?: string;
}

export interface HealthEntityRef {
  kind: string;
  id: string;
  label?: string;
  route?: string;
}

export interface HealthDateRange {
  start: string;
  end: string;
}

/**
 * A structured diagnostic: root cause, supporting evidence, and ordered actions.
 */
export interface HealthDiagnostic {
  fingerprint: string;
  domain: DiagnosticDomain;
  level: DiagnosticLevel;
  severity: HealthSeverity;
  code: string;
  title: string;
  explanation: string;
  impact?: HealthImpact;
  entities: HealthEntityRef[];
  date?: string;
  dateRange?: HealthDateRange;
  evidence: Evidence[];
  actions: DiagnosticAction[];
}

/**
 * A single health issue detected by the health center.
 */
export interface HealthIssue {
  id: string;
  severity: HealthSeverity;
  category: HealthCategory;
  title: string;
  message: string;
  /** Stable message code; when present the frontend renders health:issues.<code>.* */
  code?: string;
  /** Interpolation params for the translated title/message (count, symbol, dates, …). */
  params?: Record<string, unknown>;
  affectedCount: number;
  affectedMvPct?: number;
  fixAction?: FixAction;
  navigateAction?: NavigateAction;
  details?: string;
  affectedItems?: AffectedItem[];
  diagnostics?: HealthDiagnostic[];
  dataHash: string;
  timestamp: string;
}

/**
 * Aggregated health status.
 * Note: issueCounts is a partial map - missing keys mean 0 count.
 */
export interface HealthStatus {
  overallSeverity: HealthSeverity;
  issueCounts: Partial<Record<HealthSeverity, number>>;
  issues: HealthIssue[];
  checkedAt: string;
  isStale: boolean;
}

/**
 * Health center configuration.
 */
export interface HealthConfig {
  stalePriceWarningDays: number;
  stalePriceErrorDays: number;
  criticalMvThresholdPercent: number;
  enabled: boolean;
}

// ============================================================================
// Snapshot Info Types
// ============================================================================

/**
 * Information about a manual/imported snapshot for UI display
 */
export interface SnapshotInfo {
  /** Snapshot ID */
  id: string;
  /** Date of the snapshot (YYYY-MM-DD) */
  snapshotDate: string;
  /** Source of the snapshot (MANUAL_ENTRY, CSV_IMPORT, BROKER_IMPORTED) */
  source: string;
  /** Number of positions in this snapshot */
  positionCount: number;
  /** Number of cash currencies in this snapshot */
  cashCurrencyCount: number;
  /** Total cash converted to account currency */
  cashTotalAccountCurrency: string;
}

// ============================================================================
// Holdings CSV Import Types
// ============================================================================

/**
 * A single position in a holdings snapshot for CSV import
 */
export interface HoldingsPositionInput {
  /** Symbol from CSV (e.g., "AAPL", "GOOGL") */
  symbol: string;
  /** Quantity held as string to preserve precision */
  quantity: string;
  /** Optional average cost per unit */
  avgCost?: string;
  /** Currency for this position */
  currency: string;
  /** Exchange MIC code (e.g., "XNAS", "XTSE") resolved during check step */
  exchangeMic?: string;
  /** Quote currency resolved during asset review/search (e.g., GBp). */
  quoteCcy?: string;
  /** Instrument type resolved during asset review/search (e.g., EQUITY, CRYPTO). */
  instrumentType?: string;
  /** Market data provider that resolved this position, if selected. */
  providerId?: string;
  /** Provider-native symbol/code selected by search/import. */
  providerSymbol?: string;
  /** Resolved asset ID from asset review step */
  assetId?: string;
}

/**
 * A single snapshot from CSV import (one date's worth of holdings)
 */
export interface HoldingsSnapshotInput {
  /** The date of this snapshot (YYYY-MM-DD) */
  date: string;
  /** Securities held on this date */
  positions: HoldingsPositionInput[];
  /** Cash balances by currency (e.g., {"USD": "10000", "EUR": "5000"}) */
  cashBalances: Record<string, string>;
}

/**
 * Result of importing holdings CSV
 */
export interface ImportHoldingsCsvResult {
  /** Number of snapshots successfully imported */
  snapshotsImported: number;
  /** Number of snapshots that failed to import */
  snapshotsFailed: number;
  /** Error messages for failed snapshots */
  errors: string[];
}

/**
 * Result of checking a single symbol during holdings import
 */
export interface SymbolCheckResult {
  symbol: string;
  found: boolean;
  assetName?: string;
  assetId?: string;
  currency?: string;
  exchangeMic?: string;
}

/**
 * Result of checking holdings import data before committing
 */
export interface CheckHoldingsImportResult {
  /** Dates that already have snapshots in the DB (will be overwritten) */
  existingDates: string[];
  /** Per-unique-symbol lookup results */
  symbols: SymbolCheckResult[];
  /** Validation errors found in the import data */
  validationErrors: string[];
}

// ─── Planning DTOs (backend-computed overviews) ──────────────────

export interface TaxBucketBalances {
  taxable: number;
  taxDeferred: number;
  taxFree: number;
}

export interface RetirementOverview {
  analysisMode: string;
  status: string;
  successStatus: string;
  desiredFireAge: number;
  fiAge: number | null;
  retirementStartAge: number | null;
  retirementStartReason?: "funded" | "target_age_forced" | null;
  fundedAtGoalAge: boolean;
  eventuallyReachesFi: boolean;
  fundedAtRetirementStart: boolean;
  portfolioNow: number;
  portfolioAtRetirementStart: number;
  netFireTarget: number;
  grossFireTarget: number;
  portfolioAtGoalAge: number;
  requiredCapitalReachable: boolean;
  requiredCapitalAtGoalAge: number;
  shortfallAtGoalAge: number;
  surplusAtGoalAge: number;
  fundedThroughAge: number | null;
  failureAge: number | null;
  spendingShortfallAge: number | null;
  requiredAdditionalMonthlyContribution: number;
  suggestedGoalAgeIfUnchanged: number | null;
  coastAmountToday: number;
  coastReached: boolean;
  progress: number;
  taxBucketBalances: TaxBucketBalances;
  budgetBreakdown: BudgetBreakdown;
  targetReconciliation: TargetReconciliation;
  trajectory: RetirementTrajectoryPoint[];
}

export interface RetirementTrajectoryPoint {
  age: number;
  year: number;
  phase: string;
  portfolioStart: number;
  annualContribution: number;
  annualIncome: number;
  annualExpenses: number;
  netWithdrawalFromPortfolio: number;
  portfolioEnd: number;
  requiredCapital: number | null;
  pensionAssets: number;
  annualTaxes?: number;
  grossWithdrawal?: number;
  plannedExpenses?: number;
  fundedExpenses?: number;
  annualShortfall?: number;
}

export interface BudgetBreakdown {
  totalMonthlyBudget: number;
  monthlyPortfolioWithdrawal: number;
  incomeStreams: BudgetStreamItem[];
  effectiveTaxRate?: number;
}

export interface BudgetStreamItem {
  label: string;
  monthlyAmount: number;
  percentageOfBudget: number;
}

export interface TargetReconciliation {
  targetAge: number;
  requiredCapitalReachable: boolean;
  inflationFactorToTarget: number;
  plannedAnnualExpensesTodayValue: number;
  plannedAnnualExpensesNominal: number;
  annualIncomeTodayValue: number;
  annualIncomeNominal: number;
  netAnnualSpendingGapTodayValue: number;
  netAnnualSpendingGapNominal: number;
  grossAnnualPortfolioWithdrawalTodayValue: number;
  grossAnnualPortfolioWithdrawalNominal: number;
  estimatedAnnualTaxesTodayValue: number;
  estimatedAnnualTaxesNominal: number;
  requiredCapitalTodayValue: number;
  requiredCapitalNominal: number;
  portfolioAtTargetTodayValue: number;
  portfolioAtTargetNominal: number;
  shortfallTodayValue: number;
  shortfallNominal: number;
  preRetirementNetReturn: number;
  retirementNetReturn: number;
  annualInvestmentFeeRate: number;
}

export interface SaveUpOverviewDTO {
  currentValue: number;
  targetAmount: number;
  progress: number;
  health: GoalHealth;
  projectedValueAtTargetDate: number;
  requiredMonthlyContribution: number;
  projectedCompletionDate: string | null;
  trajectory: SaveUpTrajectoryPointDTO[];
}

export interface SaveUpPreviewInputDTO {
  currentValue: number;
  targetAmount: number;
  targetDate: string | null;
  monthlyContribution: number;
  expectedAnnualReturn: number;
}

export interface SaveUpTrajectoryPointDTO {
  date: string;
  nominal: number;
  optimistic: number;
  pessimistic: number;
  target: number;
}

export interface SaveUpProjectionPointDTO extends SaveUpTrajectoryPointDTO {
  range: [number, number];
}

// ============================================================================
// Allocation Target Types
// ============================================================================

export type TargetScopeType = "all" | "portfolio" | "account";
export type TriggerType = "manual" | "threshold";
export type RebalanceGoal = "nearest_band" | "exact_target";
export type ScenarioMode = "cash_flow_only" | "sell_to_rebalance" | "hybrid";
export type DriftStatus = "in_band" | "underweight" | "overweight" | "not_targeted";
export type RebalanceTo = "nearest_band" | "exact_target";

export type BandType = "absolute" | "hybrid";

export interface AllocationTarget {
  id: string;
  name: string;
  scopeType: TargetScopeType;
  scopeId?: string | null;
  taxonomyId: string;
  triggerType: TriggerType;
  driftBandBps: number;
  bandType: BandType;
  relativeFactorBps: number;
  rebalanceGoal: RebalanceGoal;
  minTradeAmount: string;
  wholeSharesOnly: boolean;
  allowSells: boolean;
  maxTurnoverBps?: number | null;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
}

export interface NewAllocationTarget {
  name: string;
  scopeType: TargetScopeType;
  scopeId?: string | null;
  taxonomyId: string;
  triggerType: TriggerType;
  driftBandBps: number;
  bandType?: BandType;
  relativeFactorBps?: number;
  rebalanceGoal?: RebalanceGoal;
  minTradeAmount?: string;
  wholeSharesOnly?: boolean;
  allowSells?: boolean;
  maxTurnoverBps?: number | null;
}

export interface AllocationTargetWeight {
  id: string;
  targetId: string;
  taxonomyId: string;
  categoryId: string;
  targetBps: number;
  isLocked: boolean;
  isRequired: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NewAllocationTargetWeight {
  categoryId: string;
  targetBps: number;
  isLocked: boolean;
  isRequired: boolean;
}

export interface SaveAllocationTargetResult {
  target: AllocationTarget;
  weights: AllocationTargetWeight[];
}

export type ConstraintSubjectType = "asset" | "account" | "category";
export type ConstraintAction = "buy" | "sell" | "trade";
export type ConstraintEffect = "block" | "avoid";

export interface AllocationTargetConstraint {
  id: string;
  targetId: string;
  subjectType: ConstraintSubjectType;
  subjectId: string;
  action: ConstraintAction;
  effect: ConstraintEffect;
  reason?: string | null;
  metadataJson?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DriftRow {
  categoryId: string;
  categoryName: string;
  color: string;
  currentBps: number;
  targetBps: number;
  driftBps: number;
  currentValue: number;
  targetValue: number;
  valueDelta: number;
  effectiveBandBps: number;
  status: DriftStatus;
  isRequired: boolean;
  isZeroCurrent: boolean;
  isCash: boolean;
}

export interface DriftReport {
  targetId: string;
  scopeType: TargetScopeType;
  scopeId?: string | null;
  totalValue: number;
  baseCurrency: string;
  maxDriftBps: number;
  outOfBandCount: number;
  rows: DriftRow[];
  holdings?: DriftHoldingsReport | null;
  deployableCash: number;
}

export interface DriftHoldingRow {
  id: string;
  holdingId: string;
  assetId: string;
  accountId: string;
  sourceAccountIds?: string[];
  symbol: string;
  name: string;
  categoryId: string;
  categoryName: string;
  categoryColor?: string | null;
  value: number;
  currentPct: number;
  targetPct?: number | null;
  driftBps?: number | null;
  isUnknownCategory: boolean;
  isCash: boolean;
}

export interface DriftHoldingsReport {
  targetId: string;
  totalValue: number;
  baseCurrency: string;
  rows: DriftHoldingRow[];
}

export type RebalanceWarningKind =
  | "missing_quote"
  | "no_buy_candidate"
  | "tagged_cash"
  | "unclassified_asset"
  | "partial_classification"
  | "constraint_skipped_sell"
  | "turnover_cap_reached";

export interface RebalanceWarning {
  kind: RebalanceWarningKind;
  categoryId: string;
  message: string;
}

export interface SuggestedManualTrade {
  action: string;
  categoryId: string;
  categoryName: string;
  assetId?: string | null;
  accountId?: string | null;
  holdingId?: string | null;
  symbol?: string | null;
  name?: string | null;
  quantity?: number | null;
  estimatedPrice?: number | null;
  estimatedAmount: number;
  reason: string;
}

export interface RebalancePlan {
  targetId: string;
  availableCash: number;
  cashUsed: number;
  cashRemaining: number;
  maxDriftBpsBefore: number;
  maxDriftBpsAfter: number;
  trades: SuggestedManualTrade[];
  warnings: RebalanceWarning[];
  afterBpsByCategory: Record<string, number>;
}
