import i18n from "i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { updatePortfolio, recalculatePortfolio } from "@/adapters";
import { logger } from "@/adapters";
import { invalidatePerformanceCaches } from "@/lib/performance-cache";

export function useUpdatePortfolioMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: updatePortfolio,
    onSuccess: () => {
      invalidatePerformanceCaches(queryClient);
    },
    onError: (error) => {
      queryClient.invalidateQueries();
      toast({
        title: i18n.t("common:notifications.failed_to_update_portfolio_data"),
        description: i18n.t("activity:import.errors.importErrorDescription"),
        variant: "destructive",
      });
      logger.error(`Error calculating historical data: ${String(error)}`);
    },
  });
}

export function useRecalculatePortfolioMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: recalculatePortfolio,
    onSuccess: () => {
      invalidatePerformanceCaches(queryClient);
    },
    onError: (error) => {
      queryClient.invalidateQueries();
      toast({
        title: i18n.t("common:notifications.failed_to_recalculate_portfolio"),
        description: i18n.t("activity:import.errors.importErrorDescription"),
        variant: "destructive",
      });
      console.warn("Error recalculating portfolio:", error);
      logger.error(`Error recalculating portfolio: ${String(error)}`);
    },
  });
}
