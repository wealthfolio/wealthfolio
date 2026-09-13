import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { syncBrokerData } from "../services/broker-service";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";

/**
 * Hook to trigger broker data sync.
 * The actual sync runs in the background and results are handled via
 * global event listeners (SSE events trigger toasts and query invalidation).
 */
export function useSyncBrokerData() {
  const { t } = useTranslation();
  return useMutation({
    mutationFn: syncBrokerData,
    onSuccess: () => {
      toast.loading(t("connect:sync.syncingBrokerData"), { id: "broker-sync-start" });
    },
    onError: (error) => {
      toast.error(
        t("connect:sync.startFailed", {
          error: error instanceof Error ? error.message : t("connect:errors.unknown"),
        }),
      );
    },
  });
}
