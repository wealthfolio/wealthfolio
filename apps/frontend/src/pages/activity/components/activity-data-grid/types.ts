import type { ActivityDetails, AssetResolutionInput } from "@/lib/types";
import type { ActivityStatus } from "@/lib/constants";

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
  /** Explicit performance boundary marker stored in metadata.flow.is_external. */
  isExternal?: boolean;
  /** Original asset symbol from server - used to detect symbol changes for updates */
  _originalAssetSymbol?: string;
  /** Original exchange MIC from server - used to detect asset identity changes for updates */
  _originalExchangeMic?: string;
  /** Original instrument type from server - used to detect asset identity changes for updates */
  _originalInstrumentType?: string;
  /** Original asset ID from server - sent for updates when symbol hasn't changed */
  _originalAssetId?: string;
  /** Original review flag from server - an update only sends needsReview when it changed */
  _originalNeedsReview?: boolean;
  /** Session-only: direct Total edit disables further automatic calculation. */
  _amountEdited?: boolean;
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
  // Preserve both explicit boundary values; absence must remain distinguishable from false.
  const flowMeta = activity.metadata?.flow as Record<string, unknown> | undefined;
  const isExternal = typeof flowMeta?.is_external === "boolean" ? flowMeta.is_external : undefined;
  return {
    ...activity,
    isNew: false,
    isExternal,
    // Capture original values for change detection during updates
    _originalAssetSymbol: activity.assetSymbol,
    _originalExchangeMic: activity.exchangeMic,
    _originalInstrumentType: activity.instrumentType,
    _originalAssetId: activity.assetId,
    _originalNeedsReview: activity.needsReview,
    _amountEdited: false,
  };
}

/**
 * Checks if a persisted transaction needs user review.
 */
export function isPendingReview(transaction: LocalTransaction): boolean {
  return transaction.needsReview === true && transaction.isNew !== true;
}

/**
 * Returns the review reasons supplied by the broker mapping service.
 */
export function getProviderMappingReasons(activity: Pick<ActivityDetails, "metadata">): string[] {
  const reasons = activity.metadata?.mapping_reasons;
  if (!Array.isArray(reasons)) {
    return [];
  }

  const normalizedReasons = reasons
    .filter((reason): reason is string => typeof reason === "string")
    .map((reason) => reason.trim())
    .filter(Boolean);

  return [...new Set(normalizedReasons)];
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
  destinationAmount?: string | null;
  destinationCurrency?: string | null;
  fee?: string | null;
  tax?: string | null;
  status?: ActivityStatus;
  fxRate?: string | null;
  notes?: string | null;
  /** JSON blob for metadata, including explicit transfer and credit boundaries. */
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
  /** Attestation: false marks a user-typed custom total as already reviewed. */
  needsReview?: boolean;
}

/**
 * Payload for updating an EXISTING activity
 *
 * Asset identification:
 * - Send asset.id for existing assets
 * - Or send asset.symbol + asset.exchangeMic to re-resolve the asset
 */
export interface ActivityUpdatePayload extends ActivityBasePayload {
  /** Omit to preserve, provide identity to replace, or pass {} to clear. */
  asset?: AssetResolutionInput;
  /** Explicit review patch; false approves a flagged activity. */
  needsReview?: boolean;
}

/**
 * Options for resolving transaction currency
 */
export interface CurrencyResolutionOptions {
  includeFallback?: boolean;
}
