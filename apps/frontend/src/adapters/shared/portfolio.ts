// Portfolio Commands
import type {
  AccountScope,
  Holding,
  AllocationHoldings,
  IncomeSummary,
  AccountValuation,
  CurrentValuationResponse,
  PerformanceSummaryMap,
  PerformanceSummaryProfile,
  PerformanceSummaryScope,
  PerformanceResult,
  PortfolioAllocations,
  SimplePerformanceResult,
  HoldingsSnapshotInput,
  ImportHoldingsCsvResult,
  CheckHoldingsImportResult,
  SnapshotInfo,
  AssetLotView,
} from "@/lib/types";

import { invoke, logger } from "./platform";

export const updatePortfolio = async (): Promise<void> => {
  return invoke<void>("update_portfolio");
};

export const recalculatePortfolio = async (): Promise<void> => {
  return invoke<void>("recalculate_portfolio");
};

export const getHoldings = async (filter: AccountScope): Promise<Holding[]> => {
  return invoke<Holding[]>("get_holdings", { filter });
};

export const getHoldingsList = async (filter: AccountScope): Promise<Holding[]> => {
  return invoke<Holding[]>("get_holdings_list", { filter });
};

export const getIncomeSummary = async (filter?: AccountScope): Promise<IncomeSummary[]> => {
  return invoke<IncomeSummary[]>("get_income_summary", { filter });
};

export const getHistoricalValuations = async (
  filter?: AccountScope,
  startDate?: string,
  endDate?: string,
): Promise<AccountValuation[]> => {
  const params: {
    filter?: AccountScope;
    startDate?: string;
    endDate?: string;
  } = { filter: filter ?? { type: "all" } };
  if (startDate) params.startDate = startDate;
  if (endDate) params.endDate = endDate;

  return invoke<AccountValuation[]>(
    "get_historical_valuations",
    Object.keys(params).length > 0 ? params : undefined,
  );
};

export const getLatestValuations = async (accountIds: string[]): Promise<AccountValuation[]> => {
  return invoke<AccountValuation[]>("get_latest_valuations", { accountIds });
};

export const getCurrentValuation = async ({
  filter,
  includeAccounts = false,
}: {
  filter: AccountScope;
  includeAccounts?: boolean;
}): Promise<CurrentValuationResponse> => {
  return invoke<CurrentValuationResponse>("get_current_valuation", {
    filter,
    includeAccounts,
  });
};

export const calculatePerformanceHistory = async (
  itemType: "account" | "symbol",
  itemId: string,
  startDate: string | undefined,
  endDate: string | undefined,
  trackingMode?: "HOLDINGS" | "TRANSACTIONS",
  filter?: AccountScope,
): Promise<PerformanceResult> => {
  const args: Record<string, unknown> = { itemType, itemId };
  if (startDate) args.startDate = startDate;
  if (endDate) args.endDate = endDate;
  if (trackingMode) args.trackingMode = trackingMode;
  if (filter) args.filter = filter;
  const response = await invoke<PerformanceResult>("calculate_performance_history", args);

  if (typeof response === "string" || !response || Object.keys(response).length === 0) {
    throw new Error(
      typeof response === "string" ? response : "Failed to calculate performance history",
    );
  }

  return response;
};

interface CalculatePerformanceSummaryArgs {
  itemType: "account" | "symbol";
  itemId: string;
  startDate?: string | null;
  endDate?: string | null;
  trackingMode?: "HOLDINGS" | "TRANSACTIONS";
  filter?: AccountScope;
  profile?: PerformanceSummaryProfile;
}

export const calculatePerformanceSummary = async ({
  itemType,
  itemId,
  startDate,
  endDate,
  trackingMode,
  filter,
  profile,
}: CalculatePerformanceSummaryArgs): Promise<PerformanceResult> => {
  const args: Record<string, unknown> = {
    itemType,
    itemId,
  };
  if (startDate) {
    args.startDate = startDate;
  }
  if (endDate) {
    args.endDate = endDate;
  }
  if (trackingMode) {
    args.trackingMode = trackingMode;
  }
  if (filter) {
    args.filter = filter;
  }
  if (profile) {
    args.profile = profile;
  }

  const response = await invoke<PerformanceResult>("calculate_performance_summary", args);

  if (!response || typeof response !== "object" || !response.scope?.id) {
    logger.error(
      `Invalid data received from calculate_performance_summary. Response: ${JSON.stringify(response)}`,
    );
    throw new Error("Received invalid performance summary data from backend.");
  }

  return response;
};

export const performanceSummaryScopeKey = (accountIds: string[]): string => {
  const sortedAccountIds = [...new Set(accountIds)].sort();
  return `accounts:${sortedAccountIds.join(",")}`;
};

export const calculatePerformanceSummaries = async (
  scopes: PerformanceSummaryScope[],
  startDate?: string | null,
  endDate?: string | null,
  profile?: PerformanceSummaryProfile,
): Promise<PerformanceSummaryMap> => {
  const args: Record<string, unknown> = {
    scopes,
    startDate,
    endDate,
  };
  if (profile) {
    args.profile = profile;
  }
  return invoke<PerformanceSummaryMap>("get_performance_summaries", args);
};

export const calculateAccountsSimplePerformance = async (
  accountIds: string[],
): Promise<SimplePerformanceResult[]> => {
  return invoke<SimplePerformanceResult[]>("calculate_accounts_simple_performance", {
    accountIds,
  });
};

export const getHolding = async (accountId: string, assetId: string): Promise<Holding | null> => {
  return invoke<Holding | null>("get_holding", { accountId, assetId });
};

export const getAssetHoldings = async (assetId: string): Promise<Holding[]> => {
  return invoke<Holding[]>("get_asset_holdings", { assetId });
};

export const getAssetLots = async (
  assetId: string,
  includeSnapshotPositions = false,
): Promise<AssetLotView[]> => {
  return invoke<AssetLotView[]>("get_asset_lots", {
    assetId,
    includeSnapshotPositions,
  });
};

export const getPortfolioAllocations = async (
  filter: AccountScope,
): Promise<PortfolioAllocations> => {
  return invoke<PortfolioAllocations>("get_portfolio_allocations", { filter });
};

/**
 * Gets holdings filtered by a taxonomy category.
 * Used for allocation drill-down views when user clicks on a category in charts.
 * Returns full category metadata along with the holdings.
 */
export const getHoldingsByAllocation = async (
  filter: AccountScope,
  taxonomyId: string,
  categoryId: string,
): Promise<AllocationHoldings> => {
  return invoke<AllocationHoldings>("get_holdings_by_allocation", {
    filter,
    taxonomyId,
    categoryId,
  });
};

/**
 * Input for a single holding when saving manual holdings
 *
 * For existing holdings: provide `assetId` (preferred, avoids regenerating IDs)
 * For new holdings: provide `symbol` + optional `exchangeMic`, backend generates the ID
 */
export interface HoldingInput {
  /** For existing holdings, pass the known asset ID directly */
  assetId?: string;
  /** Symbol for new holdings (backend generates ID from this) */
  symbol: string;
  quantity: string;
  currency: string;
  averageCost?: string;
  /** Exchange MIC code for new holdings (e.g., "XNAS", "XTSE"). Required for symbols without Yahoo suffixes. */
  exchangeMic?: string;
  /** Quote currency resolved from search/provider (e.g., GBp). */
  quoteCcy?: string;
  /** Instrument type resolved from search/provider (e.g., EQUITY, CRYPTO). */
  instrumentType?: string;
  /** Market data provider that resolved this holding, if selected. */
  providerId?: string;
  /** Provider-native symbol/code selected by search/import. */
  providerSymbol?: string;
  /** Asset name for new custom assets */
  name?: string;
  /** Data source (e.g., "MANUAL" for custom assets) — sets quote mode to manual */
  dataSource?: string;
  /** Asset kind (e.g., "INVESTMENT", "OTHER") */
  assetKind?: string;
}

/**
 * Saves manual holdings for a HOLDINGS-mode account.
 * Creates or updates a snapshot for the specified date with the given holdings and cash balances.
 */
export const saveManualHoldings = async (
  accountId: string,
  holdings: HoldingInput[],
  cashBalances: Record<string, string>,
  snapshotDate?: string,
): Promise<void> => {
  return invoke<void>("save_manual_holdings", {
    accountId,
    holdings,
    cashBalances,
    snapshotDate,
  });
};

/**
 * Imports holdings snapshots from CSV data for a HOLDINGS-mode account.
 * Each snapshot represents the holdings state at a specific date.
 *
 * CSV format:
 * ```csv
 * date,symbol,quantity,price,currency
 * 2024-01-15,AAPL,100,185.50,USD
 * 2024-01-15,GOOGL,50,142.30,USD
 * 2024-01-15,$CASH,10000,,USD
 * ```
 *
 * - `$CASH` is a reserved symbol for cash balances (price is ignored)
 * - Rows with the same date form one snapshot
 * - Multiple dates create multiple snapshots
 */
/**
 * Checks holdings import data before committing.
 * Returns existing snapshot dates (overwrite warnings), symbol lookup results, and validation errors.
 */
export const checkHoldingsImport = async (
  accountId: string,
  snapshots: HoldingsSnapshotInput[],
): Promise<CheckHoldingsImportResult> => {
  return invoke<CheckHoldingsImportResult>("check_holdings_import", {
    accountId,
    snapshots,
  });
};

export const importHoldingsCsv = async (
  accountId: string,
  snapshots: HoldingsSnapshotInput[],
): Promise<ImportHoldingsCsvResult> => {
  try {
    return await invoke<ImportHoldingsCsvResult>("import_holdings_csv", {
      accountId,
      snapshots,
    });
  } catch (error) {
    logger.error(`Error importing holdings CSV: ${String(error)}`);
    throw error;
  }
};

// ============================================================================
// Manual Snapshot Management
// ============================================================================

/**
 * Gets snapshots for an account (all sources: CALCULATED, MANUAL_ENTRY, etc.)
 * Optionally filtered by date range. Returns snapshot metadata without full position details.
 * @param accountId - The account ID
 * @param dateFrom - Optional start date (YYYY-MM-DD, inclusive)
 * @param dateTo - Optional end date (YYYY-MM-DD, inclusive)
 */
export const getSnapshots = async (
  accountId: string,
  dateFrom?: string,
  dateTo?: string,
): Promise<SnapshotInfo[]> => {
  return invoke<SnapshotInfo[]>("get_snapshots", { accountId, dateFrom, dateTo });
};

/**
 * Gets the full snapshot data for a specific date.
 * Returns holdings in the same format as getHoldings (without live valuation).
 */
export const getSnapshotByDate = async (accountId: string, date: string): Promise<Holding[]> => {
  return invoke<Holding[]>("get_snapshot_by_date", { accountId, date });
};

/**
 * Deletes a manual/imported snapshot for a specific date.
 * Only non-CALCULATED snapshots can be deleted.
 */
export const deleteSnapshot = async (accountId: string, date: string): Promise<void> => {
  return invoke<void>("delete_snapshot", { accountId, date });
};
