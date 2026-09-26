import { useMutation, useQueryClient } from "@tanstack/react-query";
import { updateAssetProfile, updateQuoteMode, logger } from "@/adapters";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { QueryKeys } from "@/lib/query-keys";
import { useTranslation } from "react-i18next";

export const useAssetProfileMutations = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

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

  const handleError = (action: string) => {
    toast({
      title: "Uh oh! Something went wrong.",
      description: `There was a problem ${action}.`,
      variant: "destructive",
    });
  };

  const updateAssetProfileMutation = useMutation({
    mutationFn: updateAssetProfile,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.ASSET_LOGO_INDEX] });
      handleSuccess(t("asset:detailsSheet.details_saved"), result.id);
    },
    onError: (error) => {
      logger.error(`Error updating asset profile: ${error}`);
      handleError("updating the asset profile");
    },
  });

  const updateQuoteModeMutation = useMutation({
    mutationFn: ({ assetId, quoteMode }: { assetId: string; quoteMode: string }) =>
      updateQuoteMode(assetId, quoteMode),
    onSuccess: (result, { quoteMode }) => {
      const message =
        quoteMode === "DISCONTINUED"
          ? t("asset:profile.discontinued_success")
          : quoteMode === "MARKET"
            ? result.quoteMode === "MANUAL"
              ? t("asset:detailsSheet.details_saved")
              : t("asset:profile.restored_success")
            : t("asset:profile.quote_mode_updated_success");
      handleSuccess(message, result.id);
    },
    onError: (error) => {
      logger.error(`Error updating asset quote mode: ${error}`);
      handleError(t("asset:profile.updating_quote_mode"));
    },
  });

  return {
    updateAssetProfileMutation,
    updateQuoteModeMutation,
  };
};
