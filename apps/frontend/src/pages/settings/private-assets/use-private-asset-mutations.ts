import { logger } from "@/adapters";
import {
  createFundManager,
  createPrivateAsset,
  createPrivateSnapshot,
  createPrivateSubAsset,
  updateFundManager,
  updatePrivateAsset,
  updatePrivateSnapshot,
  updatePrivateSubAsset,
} from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import type {
  UpdateFundManager,
  UpdatePrivateAsset,
  UpdatePrivateSnapshot,
  UpdatePrivateSubAsset,
} from "@/lib/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";

export function usePrivateAssetMutations() {
  const queryClient = useQueryClient();

  const invalidatePrivateAssetQueries = (assetId?: string) => {
    queryClient.invalidateQueries({ queryKey: [QueryKeys.PRIVATE_ASSET_ROWS] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.PRIVATE_ASSET_TOTALS] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.PRIVATE_ASSET_HISTORY] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.NET_WORTH] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.NET_WORTH_HISTORY] });
    if (assetId) {
      queryClient.invalidateQueries({ queryKey: QueryKeys.privateAssetDetail(assetId) });
    }
  };

  const fundManagerMutation = useMutation({
    mutationFn: createFundManager,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.FUND_MANAGERS] });
      toast({ title: "Fund manager saved", variant: "success" });
    },
    onError: (error) => {
      logger.error(`Error creating fund manager: ${error}`);
      toast({
        title: "Failed to save fund manager",
        description: "Please try again or report an issue if the problem persists.",
        variant: "destructive",
      });
    },
  });

  const updateFundManagerMutation = useMutation({
    mutationFn: ({
      fundManagerId,
      payload,
    }: {
      fundManagerId: string;
      payload: UpdateFundManager;
    }) => updateFundManager(fundManagerId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.FUND_MANAGERS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.PRIVATE_ASSET_DETAIL] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.PRIVATE_ASSET_ROWS] });
      toast({ title: "Fund manager updated", variant: "success" });
    },
    onError: (error) => {
      logger.error(`Error updating fund manager: ${error}`);
      toast({
        title: "Failed to update fund manager",
        description: "Please try again or report an issue if the problem persists.",
        variant: "destructive",
      });
    },
  });

  const createPrivateAssetMutation = useMutation({
    mutationFn: createPrivateAsset,
    onSuccess: (asset) => {
      invalidatePrivateAssetQueries(asset.id);
      toast({ title: "Private asset created", variant: "success" });
    },
    onError: (error) => {
      logger.error(`Error creating private asset: ${error}`);
      toast({
        title: "Failed to create private asset",
        description: "Please try again or report an issue if the problem persists.",
        variant: "destructive",
      });
    },
  });

  const updatePrivateAssetMutation = useMutation({
    mutationFn: ({
      privateAssetId,
      payload,
    }: {
      privateAssetId: string;
      payload: UpdatePrivateAsset;
    }) => updatePrivateAsset(privateAssetId, payload),
    onSuccess: (asset) => {
      invalidatePrivateAssetQueries(asset.id);
      toast({ title: "Private asset updated", variant: "success" });
    },
    onError: (error) => {
      logger.error(`Error updating private asset: ${error}`);
      toast({
        title: "Failed to update private asset",
        description: "Please try again or report an issue if the problem persists.",
        variant: "destructive",
      });
    },
  });

  const createPrivateSubAssetMutation = useMutation({
    mutationFn: createPrivateSubAsset,
    onSuccess: (subAsset) => {
      invalidatePrivateAssetQueries(subAsset.privateAssetId);
      toast({ title: "Sub-asset saved", variant: "success" });
    },
    onError: (error) => {
      logger.error(`Error creating private sub-asset: ${error}`);
      toast({
        title: "Failed to save sub-asset",
        description: "Please try again or report an issue if the problem persists.",
        variant: "destructive",
      });
    },
  });

  const updatePrivateSubAssetMutation = useMutation({
    mutationFn: ({
      privateSubAssetId,
      payload,
    }: {
      privateSubAssetId: string;
      privateAssetId: string;
      payload: UpdatePrivateSubAsset;
    }) => updatePrivateSubAsset(privateSubAssetId, payload),
    onSuccess: (_, variables) => {
      invalidatePrivateAssetQueries(variables.privateAssetId);
      toast({ title: "Sub-asset updated", variant: "success" });
    },
    onError: (error) => {
      logger.error(`Error updating private sub-asset: ${error}`);
      toast({
        title: "Failed to update sub-asset",
        description: "Please try again or report an issue if the problem persists.",
        variant: "destructive",
      });
    },
  });

  const createPrivateSnapshotMutation = useMutation({
    mutationFn: createPrivateSnapshot,
    onSuccess: (snapshot) => {
      invalidatePrivateAssetQueries(snapshot.privateAssetId);
      toast({ title: "Statement saved", variant: "success" });
    },
    onError: (error) => {
      logger.error(`Error creating private snapshot: ${error}`);
      toast({
        title: "Failed to save statement",
        description: "Please try again or report an issue if the problem persists.",
        variant: "destructive",
      });
    },
  });

  const updatePrivateSnapshotMutation = useMutation({
    mutationFn: ({
      privateSnapshotId,
      payload,
    }: {
      privateSnapshotId: string;
      privateAssetId: string;
      payload: UpdatePrivateSnapshot;
    }) => updatePrivateSnapshot(privateSnapshotId, payload),
    onSuccess: (_, variables) => {
      invalidatePrivateAssetQueries(variables.privateAssetId);
      toast({ title: "Statement updated", variant: "success" });
    },
    onError: (error) => {
      logger.error(`Error updating private snapshot: ${error}`);
      toast({
        title: "Failed to update statement",
        description: "Please try again or report an issue if the problem persists.",
        variant: "destructive",
      });
    },
  });

  return {
    fundManagerMutation,
    updateFundManagerMutation,
    createPrivateAssetMutation,
    updatePrivateAssetMutation,
    createPrivateSubAssetMutation,
    updatePrivateSubAssetMutation,
    createPrivateSnapshotMutation,
    updatePrivateSnapshotMutation,
  };
}
