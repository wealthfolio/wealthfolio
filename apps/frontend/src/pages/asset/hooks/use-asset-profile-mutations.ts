import { useMutation, useQueryClient } from "@tanstack/react-query";
import { updateAssetProfile, updateQuoteMode, uploadAssetLogo, removeAssetLogo, logger } from "@/adapters";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { QueryKeys } from "@/lib/query-keys";

export const useAssetProfileMutations = () => {
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
      handleSuccess("Asset profile updated successfully.", result.id);
    },
    onError: (error) => {
      logger.error(`Error updating asset profile: ${error}`);
      handleError("updating the asset profile");
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

  const uploadAssetLogoMutation = useMutation({
    mutationFn: ({ assetId, file }: { assetId: string; file?: File }) =>
      uploadAssetLogo(assetId, file),
    onSuccess: (_result, variables) => {
      handleSuccess("Logo updated successfully.", variables.assetId);
    },
    onError: (error) => {
      logger.error(`Error uploading asset logo: ${error}`);
      handleError("uploading the logo");
    },
  });

  const removeAssetLogoMutation = useMutation({
    mutationFn: (assetId: string) => removeAssetLogo(assetId),
    onSuccess: (_result, assetId) => {
      handleSuccess("Logo removed.", assetId);
    },
    onError: (error) => {
      logger.error(`Error removing asset logo: ${error}`);
      handleError("removing the logo");
    },
  });

  return {
    updateAssetProfileMutation,
    updateQuoteModeMutation,
    uploadAssetLogoMutation,
    removeAssetLogoMutation,
  };
};
