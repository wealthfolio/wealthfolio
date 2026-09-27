import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { updateAssetProfile, updateQuoteMode, logger } from "@/adapters";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { QueryKeys } from "@/lib/query-keys";

export const useAssetProfileMutations = () => {
  const queryClient = useQueryClient();
  const { t } = useTranslation("asset");

  const handleSuccess = (message: string, assetId: string) => {
    queryClient.invalidateQueries({ queryKey: [QueryKeys.HOLDINGS] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.ASSET_DATA, assetId] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.ACTIVITY_DATA] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.CURRENT_VALUATION] });
    toast({
      title: message,
      variant: "success",
    });
  };

  const handleError = (action: string, description?: string) => {
    toast({
      title: "Uh oh! Something went wrong.",
      description: description ?? `There was a problem ${action}.`,
      variant: "destructive",
    });
  };

  const updateAssetProfileMutation = useMutation({
    mutationFn: updateAssetProfile,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.ASSET_LOGO_INDEX] });
      handleSuccess("Asset profile updated successfully.", result.id);
    },
    onError: (error) => {
      logger.error(`Error updating asset profile: ${error}`);
      const message = error instanceof Error ? error.message : String(error);
      handleError(
        "updating the asset profile",
        message.includes("ASSET_IDENTITY_CONFLICT:") ? t("editSheet.identity_conflict") : undefined,
      );
    },
  });

  const updateQuoteModeMutation = useMutation({
    mutationFn: ({ assetId, quoteMode }: { assetId: string; quoteMode: string }) =>
      updateQuoteMode(assetId, quoteMode),
    onSuccess: (result) => {
      handleSuccess("Asset quote mode updated successfully.", result.id);
    },
    onError: (error) => {
      logger.error(`Error updating asset quote mode: ${error}`);
      handleError("updating the asset quote mode");
    },
  });

  return {
    updateAssetProfileMutation,
    updateQuoteModeMutation,
  };
};
