import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import {
  createAlternativeAsset,
  updateAlternativeAssetValuation,
  updateAlternativeAssetMetadata,
  deleteAlternativeAsset,
  linkLiability,
  unlinkLiability,
} from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import { invalidatePerformanceCaches } from "@/lib/performance-cache";
import { logger } from "@/adapters";
import type {
  CreateAlternativeAssetRequest,
  CreateAlternativeAssetResponse,
  UpdateValuationRequest,
  LinkLiabilityRequest,
} from "@/lib/types";

interface UseAlternativeAssetMutationsOptions {
  onCreateSuccess?: (response: CreateAlternativeAssetResponse) => void;
  onUpdateSuccess?: () => void;
  onDeleteSuccess?: () => void;
  onMetadataUpdateSuccess?: () => void;
}

export async function invalidateAlternativeAssetQueries(queryClient: QueryClient): Promise<void> {
  invalidatePerformanceCaches(queryClient);
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: [QueryKeys.HOLDINGS] }),
    queryClient.invalidateQueries({ queryKey: [QueryKeys.ACCOUNTS] }),
    queryClient.invalidateQueries({ queryKey: [QueryKeys.NET_WORTH] }),
    queryClient.invalidateQueries({ queryKey: [QueryKeys.NET_WORTH_HISTORY] }),
    queryClient.invalidateQueries({ queryKey: [QueryKeys.ALTERNATIVE_HOLDINGS] }),
    queryClient.invalidateQueries({ queryKey: [QueryKeys.ASSET_DATA] }),
  ]);
}

export function useAlternativeAssetMutations(options: UseAlternativeAssetMutationsOptions = {}) {
  const queryClient = useQueryClient();

  const invalidateQueries = () => invalidateAlternativeAssetQueries(queryClient);

  const createMutation = useMutation({
    mutationFn: (request: CreateAlternativeAssetRequest) => createAlternativeAsset(request),
    onSuccess: async (response) => {
      await invalidateQueries();
      toast({
        title: "Asset created successfully",
        variant: "success",
      });
      options.onCreateSuccess?.(response);
    },
    onError: (error) => {
      logger.error(`Error creating alternative asset: ${error}`);
      toast({
        title: "Failed to create asset",
        description: "Please try again or report an issue if the problem persists.",
        variant: "destructive",
      });
    },
  });

  const updateValuationMutation = useMutation({
    mutationFn: ({ assetId, request }: { assetId: string; request: UpdateValuationRequest }) =>
      updateAlternativeAssetValuation(assetId, request),
    onSuccess: async () => {
      await invalidateQueries();
      toast({
        title: "Valuation updated successfully",
        variant: "success",
      });
      options.onUpdateSuccess?.();
    },
    onError: (error) => {
      logger.error(`Error updating valuation: ${error}`);
      toast({
        title: "Failed to update valuation",
        description: "Please try again or report an issue if the problem persists.",
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (assetId: string) => deleteAlternativeAsset(assetId),
    onSuccess: async () => {
      await invalidateQueries();
      toast({
        title: "Asset deleted successfully",
        variant: "success",
      });
      options.onDeleteSuccess?.();
    },
    onError: (error) => {
      logger.error(`Error deleting alternative asset: ${error}`);
      toast({
        title: "Failed to delete asset",
        description: "Please try again or report an issue if the problem persists.",
        variant: "destructive",
      });
    },
  });

  const linkLiabilityMutation = useMutation({
    mutationFn: ({
      liabilityId,
      request,
    }: {
      liabilityId: string;
      request: LinkLiabilityRequest;
    }) => linkLiability(liabilityId, request),
    onSuccess: async () => {
      await invalidateQueries();
      toast({
        title: "Liability linked successfully",
        variant: "success",
      });
    },
    onError: (error) => {
      logger.error(`Error linking liability: ${error}`);
      toast({
        title: "Failed to link liability",
        description: "Please try again or report an issue if the problem persists.",
        variant: "destructive",
      });
    },
  });

  const unlinkLiabilityMutation = useMutation({
    mutationFn: (liabilityId: string) => unlinkLiability(liabilityId),
    onSuccess: async () => {
      await invalidateQueries();
      toast({
        title: "Liability unlinked successfully",
        variant: "success",
      });
    },
    onError: (error) => {
      logger.error(`Error unlinking liability: ${error}`);
      toast({
        title: "Failed to unlink liability",
        description: "Please try again or report an issue if the problem persists.",
        variant: "destructive",
      });
    },
  });

  const updateMetadataMutation = useMutation({
    mutationFn: ({
      assetId,
      metadata,
      name,
      notes,
    }: {
      assetId: string;
      metadata: Record<string, string>;
      name?: string;
      notes?: string | null;
    }) => updateAlternativeAssetMetadata(assetId, metadata, name, notes),
    onSuccess: async () => {
      await invalidateQueries();
      options.onMetadataUpdateSuccess?.();
    },
    onError: (error) => {
      logger.error(`Error updating asset metadata: ${error}`);
      toast({
        title: "Failed to save details",
        description: "Please try again or report an issue if the problem persists.",
        variant: "destructive",
      });
    },
  });

  return {
    createMutation,
    updateValuationMutation,
    updateMetadataMutation,
    deleteMutation,
    linkLiabilityMutation,
    unlinkLiabilityMutation,
  };
}
