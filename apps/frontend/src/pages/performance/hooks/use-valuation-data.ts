import { getHistoricalValuations } from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import type { DateRange, TrackedItem } from "@/lib/types";
import { keepPreviousData, useQueries } from "@tanstack/react-query";
import { format } from "date-fns";

/**
 * Hook to fetch base-currency valuation history for a list of comparison items.
 * Symbol items are excluded because they do not have an inherent monetary value.
 *
 * @param selectedItems List of comparison items to fetch valuation history for.
 * @param dateRange The date range for the valuation period.
 * @param enabled Whether valuation queries should be enabled.
 *
 * @returns An object containing the monetary chart data,
 *          a boolean indicating whether the data is loading,
 *          a boolean indicating whether there are any errors,
 *          and an array of error messages.
 */
export function useValuationData({
  selectedItems,
  dateRange,
  enabled,
}: {
  selectedItems: TrackedItem[];
  dateRange: DateRange | undefined;
  enabled: boolean;
}) {
  const accountItems = selectedItems.filter((item) => item.type === "account" && item.accountScope);
  const startDate = dateRange?.from ? format(dateRange.from, "yyyy-MM-dd") : undefined;
  const endDate = dateRange?.to ? format(dateRange.to, "yyyy-MM-dd") : undefined;
  const datesReady = dateRange === undefined || (!!startDate && !!endDate);

  const valuationQueries = useQueries({
    queries: accountItems.map((item) => ({
      queryKey: [
        ...QueryKeys.valuationHistory(item.accountScope),
        "performance",
        startDate ?? null,
        endDate ?? null,
      ],
      queryFn: () => getHistoricalValuations(item.accountScope, startDate, endDate),
      enabled: enabled && datesReady,
      staleTime: 30 * 1000,
      retry: false,
      placeholderData: keepPreviousData,
    })),
  });

  return {
    data: valuationQueries.flatMap((query, index) => {
      if (query.isError || !query.data?.length) return [];
      const item = accountItems[index];
      return [
        {
          id: item.id,
          name: item.name,
          returns: query.data.map((valuation) => ({
            date: valuation.valuationDate,
            value: valuation.totalValueBase,
          })),
        },
      ];
    }),
    isLoading: enabled && valuationQueries.some((query) => query.isLoading),
    hasErrors: enabled && valuationQueries.some((query) => query.isError),
    errorMessages: valuationQueries
      .filter((query) => query.isError)
      .map((query) => query.error)
      .filter(Boolean)
      .map((error) => (error instanceof Error ? error.message : String(error))),
  };
}
