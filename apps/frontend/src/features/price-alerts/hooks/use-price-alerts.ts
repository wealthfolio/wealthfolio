import {
  acknowledgePriceAlertEvents,
  createPriceAlert,
  deletePriceAlert,
  getPriceAlertEvents,
  getPriceAlerts,
  getUnacknowledgedPriceAlertCount,
  pausePriceAlert,
  rearmPriceAlert,
} from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import type { NewPriceAlert, PriceAlert, PriceAlertEvent } from "@/lib/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

export const priceAlertQueryKeys = {
  alerts: [QueryKeys.PRICE_ALERTS] as const,
  events: [QueryKeys.PRICE_ALERT_EVENTS] as const,
  unreadCount: [QueryKeys.PRICE_ALERT_UNREAD_COUNT] as const,
};

export function usePriceAlerts() {
  return useQuery<PriceAlert[], Error>({
    queryKey: priceAlertQueryKeys.alerts,
    queryFn: getPriceAlerts,
  });
}

export function usePriceAlertEvents(unacknowledgedOnly = false) {
  return useQuery<PriceAlertEvent[], Error>({
    queryKey: [...priceAlertQueryKeys.events, { unacknowledgedOnly }],
    queryFn: () => getPriceAlertEvents(unacknowledgedOnly),
  });
}

export function usePriceAlertUnreadCount() {
  return useQuery<number, Error>({
    queryKey: priceAlertQueryKeys.unreadCount,
    queryFn: getUnacknowledgedPriceAlertCount,
  });
}

export function usePriceAlertMutations() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: priceAlertQueryKeys.alerts });
    void queryClient.invalidateQueries({ queryKey: priceAlertQueryKeys.events });
    void queryClient.invalidateQueries({ queryKey: priceAlertQueryKeys.unreadCount });
  };

  const createMutation = useMutation({
    mutationFn: (input: NewPriceAlert) => createPriceAlert(input),
    onSuccess: () => {
      invalidateAll();
      toast.success(t("common:price_alerts.toast.created"));
    },
    onError: (error) =>
      toast.error(t("common:price_alerts.toast.create_failed"), {
        description: error instanceof Error ? error.message : String(error),
      }),
  });

  const pauseMutation = useMutation({
    mutationFn: (id: string) => pausePriceAlert(id),
    onSuccess: invalidateAll,
    onError: () => toast.error(t("common:price_alerts.toast.update_failed")),
  });

  const rearmMutation = useMutation({
    mutationFn: (id: string) => rearmPriceAlert(id),
    onSuccess: () => {
      invalidateAll();
      toast.success(t("common:price_alerts.toast.rearmed"));
    },
    onError: () => toast.error(t("common:price_alerts.toast.update_failed")),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deletePriceAlert(id),
    onSuccess: invalidateAll,
    onError: () => toast.error(t("common:price_alerts.toast.delete_failed")),
  });

  const acknowledgeMutation = useMutation({
    mutationFn: (eventIds?: string[]) => acknowledgePriceAlertEvents(eventIds),
    onSuccess: invalidateAll,
    onError: () => toast.error(t("common:price_alerts.toast.update_failed")),
  });

  return {
    createMutation,
    pauseMutation,
    rearmMutation,
    deleteMutation,
    acknowledgeMutation,
  };
}
