import i18n from "i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getAiProviders,
  updateAiProviderSettings,
  setDefaultAiProvider,
  listAiModels,
  logger,
  setSecret,
  getSecret,
  deleteSecret,
} from "@/adapters";
import type { UpdateProviderSettingsRequest, SetDefaultProviderRequest } from "@/lib/types";
import { QueryKeys } from "@/lib/query-keys";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";

const AI_PROVIDERS_KEY = [QueryKeys.AI_PROVIDERS] as const;

/**
 * Hook to fetch all AI providers with merged settings.
 */
export function useAiProviders() {
  return useQuery({
    queryKey: AI_PROVIDERS_KEY,
    queryFn: getAiProviders,
  });
}

/**
 * Hook to update a provider's settings.
 */
export function useUpdateAiProviderSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: UpdateProviderSettingsRequest) => updateAiProviderSettings(request),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: AI_PROVIDERS_KEY });
    },
  });
}

/**
 * Hook to set the default AI provider.
 */
export function useSetDefaultAiProvider() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: SetDefaultProviderRequest) => setDefaultAiProvider(request),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: AI_PROVIDERS_KEY });
    },
  });
}

/**
 * Hook to manage API keys for AI providers.
 * Uses the ai_{providerId} key format in the secret store.
 */
export function useAiProviderApiKey(providerId: string) {
  const queryClient = useQueryClient();
  const secretKey = `ai_${providerId}`;

  const setApiKey = useMutation({
    mutationFn: async (apiKey: string) => {
      await setSecret(secretKey, apiKey);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: AI_PROVIDERS_KEY });
      toast({
        title: i18n.t("common:notifications.api_key_saved"),
        variant: "success",
        duration: 1500,
      });
    },
    onError: (error) => {
      logger.error(`Failed to save API key for ${providerId}: ${error}`);
      toast({
        title: i18n.t("common:notifications.failed_to_save_api_key"),
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    },
  });

  const deleteApiKey = useMutation({
    mutationFn: async () => {
      await deleteSecret(secretKey);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: AI_PROVIDERS_KEY });
      toast({
        title: i18n.t("common:notifications.api_key_deleted"),
        variant: "success",
        duration: 1500,
      });
    },
    onError: (error) => {
      logger.error(`Failed to delete API key for ${providerId}: ${error}`);
      toast({
        title: i18n.t("common:notifications.failed_to_delete_api_key"),
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    },
  });

  const revealApiKey = async (): Promise<string | null> => {
    return getSecret(secretKey);
  };

  return {
    setApiKey,
    deleteApiKey,
    revealApiKey,
  };
}

/**
 * Hook to list available models from a provider.
 * Fetches models on demand; disabled by default until enabled explicitly.
 */
export function useListAiModels(providerId: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: QueryKeys.aiProviderModels(providerId),
    queryFn: () => listAiModels(providerId),
    enabled: options?.enabled ?? false,
  });
}
