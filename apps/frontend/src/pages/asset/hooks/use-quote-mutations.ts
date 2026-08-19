import { logger, deleteQuote, updateQuote } from "@/adapters";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { QueryKeys } from "@/lib/query-keys";
import { invalidatePerformanceCaches } from "@/lib/performance-cache";
import { Quote } from "@/lib/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

interface UseQuoteMutationsOptions {
  invalidateOnSuccess?: boolean;
}

export const useQuoteMutations = (
  assetId: string,
  { invalidateOnSuccess = true }: UseQuoteMutationsOptions = {},
) => {
  const queryClient = useQueryClient();

  const invalidateQuoteQueries = useCallback(async () => {
    invalidatePerformanceCaches(queryClient);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: [QueryKeys.ASSET_DATA, assetId] }),
      queryClient.invalidateQueries({ queryKey: [QueryKeys.QUOTE_HISTORY, assetId] }),
      queryClient.invalidateQueries({ queryKey: [QueryKeys.LATEST_QUOTES] }),
    ]);
  }, [assetId, queryClient]);

  const handleSuccess = (message: string) => {
    if (invalidateOnSuccess) {
      void invalidateQuoteQueries();
    }
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

  const saveQuoteMutation = useMutation({
    mutationFn: async (quote: Quote) => {
      await updateQuote(assetId, {
        ...quote,
        dataSource: "MANUAL",
        assetId: assetId,
        createdAt: quote.createdAt || new Date().toISOString(),
      });
    },
    onSuccess: (_, quote) => {
      handleSuccess(quote.id ? "Quote updated successfully." : "Quote added successfully.");
    },
    onError: (error) => {
      logger.error(`Error saving quote: ${error}`);
      handleError("saving the quote");
    },
  });

  const deleteQuoteMutation = useMutation({
    mutationFn: deleteQuote,
    onSuccess: () => {
      handleSuccess("Quote deleted successfully.");
    },
    onError: (error) => {
      logger.error(`Error deleting quote: ${error}`);
      handleError("deleting the quote");
    },
  });

  return {
    saveQuoteMutation,
    deleteQuoteMutation,
    invalidateQuoteQueries,
  };
};
