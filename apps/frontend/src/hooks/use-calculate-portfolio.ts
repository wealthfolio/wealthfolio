import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { updatePortfolio, recalculatePortfolio } from "@/adapters";
import { logger } from "@/adapters";
import { useI18n } from "@/i18n/i18n-provider";
import { translateUiText } from "@/i18n/ui-text";
import { invalidatePerformanceCaches } from "@/lib/performance-cache";

export function useUpdatePortfolioMutation() {
  const queryClient = useQueryClient();
  const { language } = useI18n();

  return useMutation({
    mutationFn: updatePortfolio,
    onSuccess: () => {
      invalidatePerformanceCaches(queryClient);
    },
    onError: (error) => {
      queryClient.invalidateQueries();
      toast({
        title: translateUiText(language, "Failed to update portfolio data."),
        description: translateUiText(
          language,
          "Please try again or report an issue if the problem persists.",
        ),
        variant: "destructive",
      });
      logger.error(`Error calculating historical data: ${String(error)}`);
    },
  });
}

export function useRecalculatePortfolioMutation() {
  const queryClient = useQueryClient();
  const { language } = useI18n();
  return useMutation({
    mutationFn: recalculatePortfolio,
    onSuccess: () => {
      invalidatePerformanceCaches(queryClient);
    },
    onError: (error) => {
      queryClient.invalidateQueries();
      toast({
        title: translateUiText(language, "Failed to recalculate portfolio."),
        description: translateUiText(
          language,
          "Please try again or report an issue if the problem persists.",
        ),
        variant: "destructive",
      });
      console.warn("Error recalculating portfolio:", error);
      logger.error(`Error recalculating portfolio: ${String(error)}`);
    },
  });
}
