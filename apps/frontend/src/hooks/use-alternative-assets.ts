import { useQuery } from "@tanstack/react-query";
import { QueryKeys } from "@/lib/query-keys";
import { getNetWorth, getNetWorthHistory, getAlternativeHoldings } from "@/adapters";
import type { AlternativeAssetHolding, NetWorthResponse, NetWorthHistoryPoint } from "@/lib/types";

interface UseNetWorthOptions {
  /** Optional date for as-of calculation (ISO format: YYYY-MM-DD). Defaults to today. */
  date?: string;
  /** Whether the query is enabled. Defaults to true. */
  enabled?: boolean;
}

/**
 * Hook for fetching net worth data
 * @param options - Optional configuration for the query
 * @returns Query result with net worth data
 */
export function useNetWorth(options?: UseNetWorthOptions) {
  const { date, enabled = true } = options ?? {};

  return useQuery<NetWorthResponse, Error>({
    queryKey: QueryKeys.netWorth(date),
    queryFn: () => getNetWorth(date),
    enabled,
  });
}

interface UseAlternativeHoldingsOptions {
  /** Whether the query is enabled. Defaults to true. */
  enabled?: boolean;
}

/**
 * Hook for fetching alternative holdings (assets with their latest valuations).
 * Returns all alternative assets (Property, Vehicle, Collectible, PhysicalPrecious,
 * Liability, Other) formatted for display in the Holdings page.
 */
export function useAlternativeHoldings(options?: UseAlternativeHoldingsOptions) {
  const { enabled = true } = options ?? {};

  return useQuery<AlternativeAssetHolding[], Error>({
    queryKey: [QueryKeys.ALTERNATIVE_HOLDINGS],
    queryFn: getAlternativeHoldings,
    enabled,
  });
}

interface UseNetWorthHistoryOptions {
  /** Start date (ISO format: YYYY-MM-DD) */
  startDate: string;
  /** End date (ISO format: YYYY-MM-DD) */
  endDate: string;
  /** Whether the query is enabled. Defaults to true. */
  enabled?: boolean;
}

/**
 * Hook for fetching net worth history over a date range.
 * Returns time series data for charting total assets, liabilities, and net worth.
 */
export function useNetWorthHistory(options: UseNetWorthHistoryOptions) {
  const { startDate, endDate, enabled = true } = options;

  return useQuery<NetWorthHistoryPoint[], Error>({
    queryKey: QueryKeys.netWorthHistory(startDate, endDate),
    queryFn: () => getNetWorthHistory(startDate, endDate),
    enabled,
  });
}

interface UseAlternativeAssetHoldingOptions {
  /** The asset ID to fetch */
  assetId: string;
  /** Whether the query is enabled. Defaults to true. */
  enabled?: boolean;
}

/**
 * Hook for fetching a single alternative asset holding by ID.
 * Derives from the full list of alternative holdings.
 */
export function useAlternativeAssetHolding(options: UseAlternativeAssetHoldingOptions) {
  const { assetId, enabled = true } = options;
  const { data: holdings, isLoading, isError, error } = useAlternativeHoldings({ enabled });

  const holding = holdings?.find((h) => h.id === assetId) ?? null;

  return {
    data: holding,
    isLoading,
    isError,
    error,
  };
}

interface UseLinkedLiabilitiesOptions {
  /** The asset ID to find linked liabilities for */
  assetId: string;
  /** Whether the query is enabled. Defaults to true. */
  enabled?: boolean;
}

/**
 * Hook for fetching liabilities linked to a specific asset (property/vehicle).
 * Returns all liability holdings that have linkedAssetId matching the given assetId.
 */
export function useLinkedLiabilities(options: UseLinkedLiabilitiesOptions) {
  const { assetId, enabled = true } = options;
  const { data: holdings, isLoading, isError, error } = useAlternativeHoldings({ enabled });

  const linkedLiabilities =
    holdings?.filter((h) => h.kind.toLowerCase() === "liability" && h.linkedAssetId === assetId) ??
    [];

  return {
    data: linkedLiabilities,
    isLoading,
    isError,
    error,
  };
}
