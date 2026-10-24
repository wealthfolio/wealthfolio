import i18n from "i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  setSecret,
  deleteSecret,
  getMarketDataProviderSettings,
  updateMarketDataProviderSettings,
  type MarketDataProviderSetting,
} from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";

export function useMarketDataProviderSettings() {
  return useQuery({
    queryKey: [QueryKeys.MARKET_DATA_PROVIDER_SETTINGS],
    queryFn: getMarketDataProviderSettings,
  });
}

export function useUpdateMarketDataProviderSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (variables: { providerId: string; priority: number; enabled: boolean }) =>
      updateMarketDataProviderSettings(variables),
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: [QueryKeys.MARKET_DATA_PROVIDER_SETTINGS] });

      const previousProviders = queryClient.getQueryData<MarketDataProviderSetting[]>([
        QueryKeys.MARKET_DATA_PROVIDER_SETTINGS,
      ]);

      queryClient.setQueryData<MarketDataProviderSetting[]>(
        [QueryKeys.MARKET_DATA_PROVIDER_SETTINGS],
        (old) => {
          if (!old) return old;
          return old.map((provider) =>
            provider.id === variables.providerId
              ? { ...provider, priority: variables.priority, enabled: variables.enabled }
              : provider,
          );
        },
      );

      return { previousProviders };
    },
    onError: (error, variables, context) => {
      if (context?.previousProviders) {
        queryClient.setQueryData(
          [QueryKeys.MARKET_DATA_PROVIDER_SETTINGS],
          context.previousProviders,
        );
      }
      toast({
        title: `Failed to update settings for provider ${variables.providerId}`,
        description: error.message,
        variant: "destructive",
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.MARKET_DATA_PROVIDER_SETTINGS] });
    },
  });
}

export function useSetApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (variables: { providerId: string; apiKey: string }) =>
      setSecret(variables.providerId, variables.apiKey),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.MARKET_DATA_PROVIDER_SETTINGS] });
    },
    onError: (error) => {
      toast({
        title: i18n.t("common:notifications.failed_to_save_api_key"),
        description: error.message,
        variant: "destructive",
      });
    },
  });
}

export function useDeleteApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (variables: { providerId: string }) => deleteSecret(variables.providerId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.MARKET_DATA_PROVIDER_SETTINGS] });
    },
    onError: (error) => {
      toast({
        title: i18n.t("common:notifications.failed_to_delete_api_key"),
        description: error.message,
        variant: "destructive",
      });
    },
  });
}
