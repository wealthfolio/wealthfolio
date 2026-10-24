import i18n from "i18next";
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
        title: i18n.t("common:notifications.security_created"),
        description: i18n.t("common:notifications.security_added", {
          name: asset.displayCode ?? asset.name ?? i18n.t("common:notifications.new_security"),
        }),
        variant: "success",
      });
    },
    onError: (error) => {
      logger.error(`Error creating asset: ${error}`);
      toast({
        title: i18n.t("common:notifications.creation_failed"),
        description:
          error instanceof Error
            ? error.message
            : i18n.t("common:notifications.security_create_error_description"),
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
      queryClient.invalidateQueries({ queryKey: [QueryKeys.ASSET_LOGO_INDEX] });
      toast({
        title: i18n.t("common:notifications.security_updated"),
        description: i18n.t("common:notifications.changes_saved_successfully"),
        variant: "success",
      });
    },
    onError: (error) => {
      logger.error(`Error updating asset: ${error}`);
      toast({
        title: i18n.t("common:notifications.security_update_failed"),
        description: i18n.t("common:notifications.security_update_error_description"),
        variant: "destructive",
      });
    },
  });

  const deleteAssetMutation = useMutation({
    mutationFn: (assetId: string) => deleteAsset(assetId),
    onSuccess: (_, assetId) => {
      invalidateCaches(assetId);
      queryClient.invalidateQueries({ queryKey: [QueryKeys.ASSET_LOGO_INDEX] });
      toast({
        title: i18n.t("common:notifications.security_deleted"),
        description: i18n.t("common:notifications.the_security_has_been_removed"),
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
        title: i18n.t("common:notifications.unable_to_delete_security"),
        description: isActivitiesError
          ? i18n.t("common:notifications.security_has_activities")
          : errorMessage || i18n.t("common:notifications.security_delete_error_description"),
        variant: "destructive",
      });
    },
  });

  return { createAssetMutation, updateAssetMutation, deleteAssetMutation };
};
