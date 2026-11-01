import i18n from "i18next";
import { useTranslation } from "react-i18next";
import { useMemo } from "react";
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
import { getCurrencyDisplayName } from "@wealthfolio/ui";

export function useExchangeRates() {
  const queryClient = useQueryClient();
  const { t, i18n: translation } = useTranslation();

  const {
    data: rawExchangeRates,
    isLoading: isLoadingRates,
    dataUpdatedAt,
  } = useQuery<ExchangeRate[], Error>({
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

  const exchangeRates = useMemo(
    () =>
      rawExchangeRates?.map((rate) => ({
        ...rate,
        fromCurrencyName: getCurrencyDisplayName(
          rate.fromCurrency,
          translation.resolvedLanguage ?? translation.language,
          t,
        ),
        toCurrencyName: getCurrencyDisplayName(
          rate.toCurrency,
          translation.resolvedLanguage ?? translation.language,
          t,
        ),
      })),
    [rawExchangeRates, translation.resolvedLanguage, translation.language, t],
  );

  const updateExchangeRateMutation = useMutation({
    mutationFn: updateExchangeRateApi,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.EXCHANGE_RATES] });
      invalidatePerformanceCaches(queryClient);
    },
    onError: (error) => {
      logger.error(`Error updating exchange rate: ${error}`);
      toast({
        title: i18n.t("settings:settings_update_error_title"),
        description: i18n.t("settings:messages.exchange.updatingFailed", {
          error: error?.message ?? "",
        }),
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
        title: i18n.t("common:notifications.error_adding_exchange_rate"),
        description: i18n.t("settings:messages.exchange.addingFailed", {
          error: error?.message ?? "",
        }),
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
        title: i18n.t("common:notifications.error_deleting_exchange_rate"),
        description: i18n.t("settings:messages.exchange.deletingFailed", {
          error: error?.message ?? "",
        }),
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
    dataUpdatedAt,
    updateExchangeRate,
    addExchangeRate,
    deleteExchangeRate,
    isDeletingRate: deleteExchangeRateMutation.isPending,
  };
}
