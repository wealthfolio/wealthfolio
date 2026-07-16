import { QueryKeys } from "@/lib/query-keys";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { logger, importActivities } from "@/adapters";
import { invalidateSpendingCaches } from "@/features/spending/lib/invalidation";
import { invalidatePerformanceCaches } from "@/lib/performance-cache";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import type { ImportActivitiesResult, ActivityImport } from "@/lib/types";

export function useActivityImportMutations({
  onSuccess,
  onError,
}: {
  onSuccess?: (activities: ActivityImport[], result: ImportActivitiesResult) => void;
  onError?: (error: string) => void;
} = {}) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const confirmImportMutation = useMutation({
    mutationFn: importActivities,
    onSuccess: async (result: ImportActivitiesResult) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [QueryKeys.ACTIVITY_DATA] }),
        queryClient.invalidateQueries({ queryKey: [QueryKeys.ACTIVITIES] }),
        queryClient.invalidateQueries({ queryKey: [QueryKeys.IMPORT_RUNS] }),
      ]);
      invalidatePerformanceCaches(queryClient);
      invalidateSpendingCaches(queryClient);

      // Call the provided onSuccess callback if it exists
      // Note: We don't show a toast here since the result step displays the success state
      if (onSuccess) {
        onSuccess(result.activities, result);
      }
    },
    onError: (error: unknown) => {
      logger.error(`Error confirming import: ${String(error)}`);

      // Call the provided onError callback if it exists
      if (onError) {
        const errMsg =
          error && typeof error === "object" && "message" in error
            ? String((error as { message?: unknown }).message)
            : t("activity:import.errors.importFailedFallback");
        onError(errMsg);
      } else {
        toast({
          title: t("activity:import.errors.importErrorTitle"),
          description: t("activity:import.errors.importErrorDescription"),
          variant: "destructive",
        });
      }
    },
  });

  return {
    confirmImportMutation,
  };
}
