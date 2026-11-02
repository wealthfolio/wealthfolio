import i18n from "i18next";
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
      title: i18n.t("settings:settings_update_error_title"),
      description: description ?? i18n.t(`asset:notifications.${action}`),
      variant: "destructive",
    });
  };

  const updateAssetProfileMutation = useMutation({
    mutationFn: updateAssetProfile,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.ASSET_LOGO_INDEX] });
      handleSuccess(i18n.t("asset:notifications.profile_updated"), result.id);
    },
    onError: (error) => {
      logger.error(`Error updating asset profile: ${error}`);
      const message = error instanceof Error ? error.message : String(error);
      handleError(
        "profile_failed",
        message.includes("ASSET_IDENTITY_CONFLICT:") ? t("editSheet.identity_conflict") : undefined,
      );
    },
  });

  const updateQuoteModeMutation = useMutation({
    mutationFn: ({ assetId, quoteMode }: { assetId: string; quoteMode: string }) =>
      updateQuoteMode(assetId, quoteMode),
    onSuccess: (result) => {
      handleSuccess(i18n.t("asset:notifications.quote_mode_updated"), result.id);
    },
    onError: (error) => {
      logger.error(`Error updating asset quote mode: ${error}`);
      handleError("quote_mode_failed");
    },
  });

  return {
    updateAssetProfileMutation,
    updateQuoteModeMutation,
  };
};
