import { useQuery, keepPreviousData } from "@tanstack/react-query";
import type { AccountScope, AccountValuation, DateRange } from "@/lib/types";
import { getHistoricalValuations } from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import { format } from "date-fns";

export function useValuationHistory(
  dateRange: DateRange | undefined,
  filter: AccountScope = { type: "all" },
) {
  const dateRangeMode = dateRange === undefined ? "all" : "range";
  const startDate = dateRange?.from ? format(dateRange.from, "yyyy-MM-dd") : undefined;
  const endDate = dateRange?.to ? format(dateRange.to, "yyyy-MM-dd") : undefined;
  const {
    data: valuationHistory,
    isLoading,
    isFetching,
  } = useQuery<AccountValuation[], Error>({
    queryKey: [
      ...QueryKeys.valuationHistory(filter),
      dateRangeMode,
      startDate ?? null,
      endDate ?? null,
    ],
    queryFn: () => {
      if (dateRangeMode === "all") {
        return getHistoricalValuations(filter, undefined, undefined);
      }

      if (!startDate || !endDate) {
        console.error("Invalid date range provided to useValuationHistory");
        return Promise.resolve([]);
      }

      return getHistoricalValuations(filter, startDate, endDate);
    },
    enabled: dateRangeMode === "all" || (!!startDate && !!endDate),
    placeholderData: keepPreviousData,
  });

  return {
    valuationHistory,
    isLoading: isLoading || isFetching,
  };
}
