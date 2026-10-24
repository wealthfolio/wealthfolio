import i18n from "i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { logger } from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import { invalidatePerformanceCaches } from "@/lib/performance-cache";
import {
  createAlternativeAsset,
  updateAlternativeAssetValuation,
  deleteAlternativeAsset,
  linkLiability,
  unlinkLiability,
  getNetWorth,
  getNetWorthHistory,
  getAlternativeHoldings,
} from "@/adapters";
import type {
  AlternativeAssetHolding,
  CreateAlternativeAssetRequest,
  CreateAlternativeAssetResponse,
  UpdateValuationRequest,
  UpdateValuationResponse,
  NetWorthResponse,
  NetWorthHistoryPoint,
} from "@/lib/types";

interface UseAlternativeAssetMutationsOptions {
  onSuccess?: () => void;
}

/**
 * Hook for creating alternative assets (property, vehicle, collectible, precious metal, liability, other)
 */
export function useCreateAlternativeAsset(options?: UseAlternativeAssetMutationsOptions) {
  const queryClient = useQueryClient();
  const { onSuccess } = options ?? {};

  return useMutation<CreateAlternativeAssetResponse, Error, CreateAlternativeAssetRequest>({
    mutationFn: createAlternativeAsset,
    onSuccess: (data) => {
      // Invalidate relevant queries
      queryClient.invalidateQueries({ queryKey: [QueryKeys.ALTERNATIVE_HOLDINGS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.ASSETS] });
      invalidatePerformanceCaches(queryClient);

      toast({
        title: i18n.t("common:notifications.asset_created_successfully"),
        description: i18n.t("common:notifications.asset_created_id", { assetId: data.assetId }),
        variant: "success",
      });

      onSuccess?.();
    },
    onError: (error) => {
      logger.error(`Error creating alternative asset: ${error}`);
      toast({
        title: i18n.t("common:notifications.failed_to_create_asset"),
        description: i18n.t("common:notifications.asset_create_error_description"),
        variant: "destructive",
      });
    },
  });
}

interface UpdateValuationParams {
  assetId: string;
  value: string;
  date: string;
  notes?: string;
}

/**
 * Hook for updating the valuation of an alternative asset
 */
export function useUpdateValuation(options?: UseAlternativeAssetMutationsOptions) {
  const queryClient = useQueryClient();
  const { onSuccess } = options ?? {};

  return useMutation<UpdateValuationResponse, Error, UpdateValuationParams>({
    mutationFn: ({ assetId, value, date, notes }) => {
      const request: UpdateValuationRequest = { value, date, notes };
      return updateAlternativeAssetValuation(assetId, request);
    },
    onSuccess: () => {
      // Invalidate holdings-related queries to reflect the new valuation
      queryClient.invalidateQueries({ queryKey: [QueryKeys.ALTERNATIVE_HOLDINGS] });
      invalidatePerformanceCaches(queryClient);

      toast({
        title: i18n.t("common:notifications.valuation_updated"),
        description: i18n.t(
          "common:notifications.the_asset_valuation_has_been_updated_successfully",
        ),
        variant: "success",
      });

      onSuccess?.();
    },
    onError: (error) => {
      logger.error(`Error updating valuation: ${error}`);
      toast({
        title: i18n.t("common:notifications.failed_to_update_valuation"),
        description: i18n.t("common:notifications.valuation_update_error_description"),
        variant: "destructive",
      });
    },
  });
}

/**
 * Hook for deleting an alternative asset
 */
export function useDeleteAlternativeAsset(options?: UseAlternativeAssetMutationsOptions) {
  const queryClient = useQueryClient();
  const { onSuccess } = options ?? {};

  return useMutation<void, Error, string>({
    mutationFn: deleteAlternativeAsset,
    onSuccess: () => {
      // Invalidate all relevant queries
      queryClient.invalidateQueries({ queryKey: [QueryKeys.ALTERNATIVE_HOLDINGS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.ASSETS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.ASSET_LOGO_INDEX] });
      invalidatePerformanceCaches(queryClient);

      toast({
        title: i18n.t("common:notifications.asset_deleted"),
        description: i18n.t(
          "common:notifications.the_asset_and_its_associated_data_have_been_removed",
        ),
        variant: "success",
      });

      onSuccess?.();
    },
    onError: (error) => {
      logger.error(`Error deleting alternative asset: ${error}`);
      toast({
        title: i18n.t("common:notifications.failed_to_delete_asset"),
        description: i18n.t("common:notifications.asset_delete_error_description"),
        variant: "destructive",
      });
    },
  });
}

interface LinkLiabilityParams {
  liabilityId: string;
  targetAssetId: string;
}

/**
 * Hook for linking a liability to an asset (UI-only aggregation)
 */
export function useLinkLiability(options?: UseAlternativeAssetMutationsOptions) {
  const queryClient = useQueryClient();
  const { onSuccess } = options ?? {};

  return useMutation<void, Error, LinkLiabilityParams>({
    mutationFn: ({ liabilityId, targetAssetId }) => linkLiability(liabilityId, { targetAssetId }),
    onSuccess: () => {
      // Invalidate queries to reflect the link change
      queryClient.invalidateQueries({ queryKey: [QueryKeys.HOLDINGS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.ASSETS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.ALTERNATIVE_HOLDINGS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.NET_WORTH] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.NET_WORTH_HISTORY] });

      toast({
        title: i18n.t("common:notifications.liability_linked"),
        description: i18n.t("common:notifications.the_liability_has_been_linked_to_the_asset"),
        variant: "success",
      });

      onSuccess?.();
    },
    onError: (error) => {
      logger.error(`Error linking liability: ${error}`);
      toast({
        title: i18n.t("common:notifications.failed_to_link_liability"),
        description: i18n.t("common:notifications.liability_link_error_description"),
        variant: "destructive",
      });
    },
  });
}

/**
 * Hook for unlinking a liability from its linked asset
 */
export function useUnlinkLiability(options?: UseAlternativeAssetMutationsOptions) {
  const queryClient = useQueryClient();
  const { onSuccess } = options ?? {};

  return useMutation<void, Error, string>({
    mutationFn: unlinkLiability,
    onSuccess: () => {
      // Invalidate queries to reflect the unlink change
      queryClient.invalidateQueries({ queryKey: [QueryKeys.HOLDINGS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.ASSETS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.ALTERNATIVE_HOLDINGS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.NET_WORTH] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.NET_WORTH_HISTORY] });

      toast({
        title: i18n.t("common:notifications.liability_unlinked"),
        description: i18n.t("common:notifications.the_liability_has_been_unlinked_from_the_asset"),
        variant: "success",
      });

      onSuccess?.();
    },
    onError: (error) => {
      logger.error(`Error unlinking liability: ${error}`);
      toast({
        title: i18n.t("common:notifications.failed_to_unlink_liability"),
        description: i18n.t("common:notifications.liability_unlink_error_description"),
        variant: "destructive",
      });
    },
  });
}

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
