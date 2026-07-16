import type { ActivityDetails, AssetResolutionInput } from "@/lib/types";

/**
 * Represents a local transaction that extends ActivityDetails with draft state
 */
export interface LocalTransaction extends ActivityDetails {
  /** Indicates if the transaction is newly created and not yet persisted */
  isNew?: boolean;
  /** Pending asset name from custom asset dialog (not yet persisted) */
  pendingAssetName?: string;
  /** Pending asset kind from custom asset dialog (e.g., "SECURITY", "CRYPTO", "OTHER") */
  pendingAssetKind?: string;
  /** Pending symbol quote currency hint from search/provider (e.g., "GBp") */
  pendingQuoteCcy?: string;
  /** Pending symbol instrument type hint from search/provider (e.g., "EQUITY") */
  pendingInstrumentType?: string;
  /** Pending provider that resolved this symbol. */
  pendingProviderId?: string;
  /** Pending provider-native symbol/code from search/provider. */
  pendingProviderSymbol?: string;
  /** Persisted asset id selected from symbol search, if the result already exists */
  pendingAssetId?: string;
  /** Whether this transfer is external (from/to outside tracked accounts). Stored in metadata.flow.is_external */
  isExternal?: boolean;
  /** Original asset symbol from server - used to detect symbol changes for updates */
  _originalAssetSymbol?: string;
  /** Original exchange MIC from server - used to detect asset identity changes for updates */
  _originalExchangeMic?: string;
  /** Original instrument type from server - used to detect asset identity changes for updates */
  _originalInstrumentType?: string;
  /** Original asset ID from server - sent for updates when symbol hasn't changed */
  _originalAssetId?: string;
}

/**
 * Type guard to check if an ActivityDetails is a LocalTransaction
 */
export function isLocalTransaction(activity: ActivityDetails): activity is LocalTransaction {
  return "isNew" in activity;
}

/**
 * Converts an ActivityDetails to a LocalTransaction with default isNew=false
 */
export function toLocalTransaction(activity: ActivityDetails): LocalTransaction {
  if (isLocalTransaction(activity)) {
    return activity;
  }
  // Extract isExternal from metadata.flow.is_external
  const flowMeta = activity.metadata?.flow as Record<string, unknown> | undefined;
  const isExternal = flowMeta?.is_external === true;
  return {
    ...activity,
    isNew: false,
    isExternal,
    // Capture original values for change detection during updates
    _originalAssetSymbol: activity.assetSymbol,
    _originalExchangeMic: activity.exchangeMic,
    _originalInstrumentType: activity.instrumentType,
    _originalAssetId: activity.assetId,
  };
}

/**
 * Checks if a transaction is pending review (synced but not yet approved)
 * A transaction is pending review if needsReview=true AND it's not a locally created new row
 */
export function isPendingReview(transaction: LocalTransaction): boolean {
  return transaction.needsReview === true && transaction.isNew !== true;
}

/**
 * Tracks the state of changes to transactions
 */
export interface TransactionChangeState {
  /** Set of transaction IDs that have been modified */
  dirtyIds: Set<string>;
  /** Set of transaction IDs pending deletion */
  pendingDeleteIds: Set<string>;
}

/**
 * Summary of pending changes for display purposes
 */
export interface ChangesSummary {
  newCount: number;
  updatedCount: number;
  deletedCount: number;
  totalPendingChanges: number;
}

/**
 * Parameters for creating a draft transaction
 */
export interface DraftTransactionParams {
  accountId: string;
  accountName: string;
  accountCurrency: string;
  fallbackCurrency: string;
}

/**
 * Parameters for applying a field update to a transaction
 */
export interface TransactionUpdateParams {
  transaction: LocalTransaction;
  field: keyof LocalTransaction;
  value: unknown;
  accountLookup: Map<string, { id: string; name: string; currency: string }>;
  assetCurrencyLookup: Map<string, string>;
  fallbackCurrency: string;
  resolveTransactionCurrency: (
    transaction: LocalTransaction,
    options?: { includeFallback?: boolean },
  ) => string | undefined;
}

/**
 * Result of building a save payload
 */
export interface SavePayloadResult {
  creates: ActivityCreatePayload[];
  updates: ActivityUpdatePayload[];
  deleteIds: string[];
}

/**
 * Base activity payload fields (shared between create and update)
 * Note: Decimal fields (quantity, unitPrice, amount, fee, tax, fxRate) use strings
 * to preserve precision for very small values like 0.000000099
 */
interface ActivityBasePayload {
  id: string;
  accountId: string;
  activityType: string;
  activityDate: string;

  // Activity data
  subtype?: string;
  quantity?: string | null;
  unitPrice?: string | null;
  amount?: string | null;
  currency?: string;
  fee?: string | null;
  tax?: string | null;
  fxRate?: string | null;
  notes?: string | null;
  /** JSON blob for metadata (e.g., flow.is_external for transfers) */
  metadata?: string;
}

/**
 * Payload for creating a NEW activity
 *
 * Asset identification:
 * - Send asset.symbol + asset.exchangeMic for natural identity resolution
 * - For CASH activities: don't send asset, backend generates CASH:{currency}
 */
export interface ActivityCreatePayload extends ActivityBasePayload {
  /** Explicit key for intentional manual duplicates. */
  idempotencyKey?: string;
  /** Asset resolution input - id plus natural identity and creation hints */
  asset?: AssetResolutionInput;
}

/**
 * Payload for updating an EXISTING activity
 *
 * Asset identification:
 * - Send asset.id for existing assets
 * - Or send asset.symbol + asset.exchangeMic to re-resolve the asset
 */
export interface ActivityUpdatePayload extends ActivityBasePayload {
  /** Asset resolution input - id plus natural identity and creation hints */
  asset?: AssetResolutionInput;
}

/**
 * Options for resolving transaction currency
 */
export interface CurrencyResolutionOptions {
  includeFallback?: boolean;
}
