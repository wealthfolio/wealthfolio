import {
  logger,
  addExchangeRate as addExchangeRateApi,
  deleteExchangeRate as deleteExchangeRateApi,
  getExchangeRates,
  updateExchangeRate as updateExchangeRateApi,
} from "@/adapters";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { QueryKeys } from "@/lib/query-keys";
import { invalidatePerformanceCaches } from "@/lib/performance-cache";
import { ExchangeRate } from "@/lib/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export function useExchangeRates() {
  const queryClient = useQueryClient();

  const { data: exchangeRates, isLoading: isLoadingRates } = useQuery<ExchangeRate[], Error>({
    queryKey: [QueryKeys.EXCHANGE_RATES],
    queryFn: async () => {
      const rates = await getExchangeRates();

      // For manual rates, keep only from->to and filter out the reverse
      return rates.filter((rate) => {
        if (rate.source === "MANUAL") {
          const reverseManualRate = rates.find(
            (r) =>
              r.fromCurrency === rate.toCurrency &&
              r.toCurrency === rate.fromCurrency &&
              r.source === "MANUAL",
          );
          return !reverseManualRate || rate.fromCurrency < rate.toCurrency;
        }
        return true; // Keep all non-manual rates
      });
    },
  });

  const updateExchangeRateMutation = useMutation({
    mutationFn: updateExchangeRateApi,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.EXCHANGE_RATES] });
      invalidatePerformanceCaches(queryClient);
    },
    onError: (error) => {
      logger.error(`Error updating exchange rate: ${error}`);
      toast({
        title: "Uh oh! Something went wrong.",
        description: `There was a problem updating the exchange rate: ${error?.message}`,
        variant: "destructive",
      });
    },
  });

  const addExchangeRateMutation = useMutation({
    mutationFn: addExchangeRateApi,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.EXCHANGE_RATES] });
      invalidatePerformanceCaches(queryClient);
    },
    onError: (error) => {
      logger.error(`Error adding exchange rate: ${error}`);
      toast({
        title: "Error adding exchange rate",
        description: `There was a problem adding the exchange rate: ${error?.message}`,
        variant: "destructive",
      });
    },
  });

  const deleteExchangeRateMutation = useMutation({
    mutationFn: deleteExchangeRateApi,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.EXCHANGE_RATES] });
      invalidatePerformanceCaches(queryClient);
    },
    onError: (error) => {
      logger.error(`Error deleting exchange rate: ${error}`);
      toast({
        title: "Error deleting exchange rate",
        description: `There was a problem deleting the exchange rate: ${error?.message}`,
        variant: "destructive",
      });
    },
  });

  const updateExchangeRate = (rate: ExchangeRate) => {
    updateExchangeRateMutation.mutate(rate);
  };

  const addExchangeRate = (rate: Omit<ExchangeRate, "id">) => {
    addExchangeRateMutation.mutate(rate);
  };

  const deleteExchangeRate = (rateId: string) => {
    deleteExchangeRateMutation.mutate(rateId);
  };

  return {
    exchangeRates,
    isLoadingRates,
    updateExchangeRate,
    addExchangeRate,
    deleteExchangeRate,
    isDeletingRate: deleteExchangeRateMutation.isPending,
  };
}
