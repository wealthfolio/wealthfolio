import i18n from "i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getCustomProviders,
  createCustomProvider,
  updateCustomProvider,
  deleteCustomProvider,
  testCustomProviderSource,
} from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import type {
  NewCustomProvider,
  UpdateCustomProvider,
  TestSourceRequest,
} from "@/lib/types/custom-provider";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";

export function useCustomProviders() {
  return useQuery({
    queryKey: [QueryKeys.CUSTOM_PROVIDERS],
    queryFn: getCustomProviders,
  });
}

export function useCreateCustomProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: NewCustomProvider) => createCustomProvider(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.CUSTOM_PROVIDERS] });
    },
    onError: (error: Error) => {
      toast({
        title: i18n.t("common:notifications.failed_to_create_custom_provider"),
        description: error.message,
        variant: "destructive",
      });
    },
  });
}

export function useUpdateCustomProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: { providerId: string; payload: UpdateCustomProvider }) =>
      updateCustomProvider(variables.providerId, variables.payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.CUSTOM_PROVIDERS] });
    },
    onError: (error: Error) => {
      toast({
        title: i18n.t("common:notifications.failed_to_update_custom_provider"),
        description: error.message,
        variant: "destructive",
      });
    },
  });
}

export function useDeleteCustomProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (providerId: string) => deleteCustomProvider(providerId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.CUSTOM_PROVIDERS] });
    },
    onError: (error: Error) => {
      toast({
        title: i18n.t("common:notifications.failed_to_delete_custom_provider"),
        description: error.message,
        variant: "destructive",
      });
    },
  });
}

export function useTestCustomProviderSource() {
  return useMutation({
    mutationFn: (payload: TestSourceRequest) => testCustomProviderSource(payload),
    onError: (error: Error) => {
      toast({
        title: i18n.t("common:notifications.source_test_failed"),
        description: error.message,
        variant: "destructive",
      });
    },
  });
}
