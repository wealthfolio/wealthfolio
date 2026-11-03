import i18n from "i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { syncMarketData } from "@/adapters";
import { useToast } from "@wealthfolio/ui/components/ui/use-toast";
import { invalidatePerformanceCaches } from "@/lib/performance-cache";
import { QueryKeys } from "@/lib/query-keys";

export function useSyncMarketDataMutation(refetchAll = false, refetchRecentDays?: number) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (assetIds: string[]) => {
      await syncMarketData(assetIds, refetchAll, refetchRecentDays);
    },
    onSuccess: (_data, assetIds) => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.QUOTE_HISTORY] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.LATEST_QUOTES] });
      for (const assetId of assetIds) {
        queryClient.invalidateQueries({ queryKey: [QueryKeys.ASSET_DATA, assetId] });
      }
      invalidatePerformanceCaches(queryClient);
    },
    onError: (error: Error) => {
      toast({
        title: i18n.t("common:notifications.failed_to_sync_market_data"),
        description: error.message,
        variant: "destructive",
      });
    },
  });
}
