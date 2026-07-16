import { useMutation, useQueryClient } from "@tanstack/react-query";

import { logger, createAsset, deleteAsset, updateAssetProfile } from "@/adapters";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { QueryKeys } from "@/lib/query-keys";
import { NewAsset, UpdateAssetProfile } from "@/lib/types";

interface UpdateAssetArgs {
  payload: UpdateAssetProfile;
}

export const useAssetManagement = () => {
  const queryClient = useQueryClient();

  const invalidateCaches = (assetId: string) => {
    queryClient.invalidateQueries({ queryKey: [QueryKeys.ASSETS] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.ASSET_DATA, assetId] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.HOLDINGS] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.ACTIVITY_DATA] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.CURRENT_VALUATION] });
  };

  const createAssetMutation = useMutation({
    mutationFn: (payload: NewAsset) => createAsset(payload),
    onSuccess: (asset) => {
      invalidateCaches(asset.id);
      toast({
        title: "Security created",
        description: `${asset.displayCode ?? asset.name ?? "New security"} has been added.`,
        variant: "success",
      });
    },
    onError: (error) => {
      logger.error(`Error creating asset: ${error}`);
      toast({
        title: "Creation failed",
        description:
          error instanceof Error ? error.message : "There was a problem creating the security.",
        variant: "destructive",
      });
    },
  });

  const updateAssetMutation = useMutation({
    mutationFn: async ({ payload }: UpdateAssetArgs) => {
      return await updateAssetProfile(payload);
    },
    onSuccess: (asset) => {
      invalidateCaches(asset.id);
      toast({
        title: "Security updated",
        description: "Changes saved successfully.",
        variant: "success",
      });
    },
    onError: (error) => {
      logger.error(`Error updating asset: ${error}`);
      toast({
        title: "Update failed",
        description: "There was a problem saving the security.",
        variant: "destructive",
      });
    },
  });

  const deleteAssetMutation = useMutation({
    mutationFn: (assetId: string) => deleteAsset(assetId),
    onSuccess: (_, assetId) => {
      invalidateCaches(assetId);
      toast({
        title: "Security deleted",
        description: "The security has been removed.",
        variant: "success",
      });
    },
    onError: (error) => {
      logger.error(`Error deleting asset: ${error}`);

      // Extract user-friendly error message
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check if it's the "asset has activities" error
      const isActivitiesError = errorMessage.toLowerCase().includes("existing activities");

      toast({
        title: "Unable to delete security",
        description: isActivitiesError
          ? "This security cannot be deleted because it has existing activities. Please delete all associated activities first."
          : errorMessage || "The security could not be removed right now.",
        variant: "destructive",
      });
    },
  });

  return { createAssetMutation, updateAssetMutation, deleteAssetMutation };
};
