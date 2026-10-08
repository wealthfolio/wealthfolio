import { calculatePerformanceHistory } from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import { PerformanceResult, TrackedItem } from "@/lib/types";
import { keepPreviousData, useQueries, type UseQueryResult } from "@tanstack/react-query";
import { calendarDateFromLocalDate, useDateFormatting } from "@wealthfolio/ui";
import { format } from "date-fns";
import { DateRange } from "react-day-picker";

/** The first date of the earliest series among the loaded results. */
function earliestSeriesDate(queries: UseQueryResult<PerformanceResult>[]): string | undefined {
  const firstDates = queries.flatMap((query) =>
    query.isSuccess && query.data.series.length ? [query.data.series[0].date] : [],
  );
  return firstDates.length
    ? firstDates.reduce((earliest, date) => (date < earliest ? date : earliest))
    : undefined;
}

/**
 * Hook to calculate cumulative returns for a list of comparison items.
 * Uses the user-selected date range directly for queries, except when the
 * caller passes `undefined` to request all-time performance.
 *
 * @param selectedItems List of comparison items to calculate cumulative returns for.
 * @param dateRange The date range for the calculation period.
 * @param trackingMode Optional tracking mode for accounts ("HOLDINGS" or "TRANSACTIONS").
 *                     Used for SOTA performance calculations in HOLDINGS mode.
 *
 * @returns An object containing the calculated cumulative returns data,
 *          a boolean indicating whether the data is loading,
 *          a boolean indicating whether there are any errors,
 *          an array of error messages,
 *          and a formatted display date range string.
 */
export function useCalculatePerformanceHistory({
  selectedItems,
  dateRange,
  trackingMode,
}: {
  selectedItems: TrackedItem[];
  dateRange: DateRange | undefined;
  trackingMode?: "HOLDINGS" | "TRANSACTIONS";
}) {
  const formatting = useDateFormatting();
  // Filter out invalid items (defensive: handles stale localStorage data)
  const validItems = selectedItems.filter(
    (item) =>
      item && typeof item.id === "string" && item.id && typeof item.type === "string" && item.type,
  );

  // Keep dates undefined for all-time queries so the backend can apply
  // inception semantics instead of treating "ALL" as an explicit bounded range.
  const startDate = dateRange?.from ? format(dateRange.from, "yyyy-MM-dd") : undefined;
  const endDate = dateRange?.to ? format(dateRange.to, "yyyy-MM-dd") : undefined;
  const isAllTime = dateRange === undefined;
  // Enable query for all-time (`dateRange === undefined`) or valid bounded ranges.
  const enabled = isAllTime || (!!startDate && !!endDate);

  const performanceQuery = (
    item: TrackedItem,
    itemStartDate: string | undefined,
    itemEnabled: boolean,
  ) => {
    const accountFilter = item.type === "account" ? item.accountScope : undefined;

    return {
      queryKey: [
        QueryKeys.PERFORMANCE_HISTORY,
        item.type,
        item.id,
        accountFilter,
        itemStartDate,
        endDate,
        trackingMode,
      ],
      queryFn: () =>
        calculatePerformanceHistory(
          item.type,
          item.id,
          itemStartDate,
          endDate,
          // Only pass trackingMode for accounts, not for symbols
          item.type === "account" ? trackingMode : undefined,
          accountFilter,
        ),
      enabled: itemEnabled,
      staleTime: 30 * 1000,
      retry: false,
      placeholderData: keepPreviousData,
    };
  };

  const accountItems = validItems.filter((item) => item.type !== "symbol");
  const symbolItems = validItems.filter((item) => item.type === "symbol");

  const accountQueries = useQueries({
    queries: accountItems.map((item) => performanceQuery(item, startDate, enabled)),
  });

  // All-time benchmarks start where the accounts' history starts. Without a start
  // date the backend gives a symbol only its last year, which would clip the chart.
  const waitingForAccounts =
    isAllTime && !accountQueries.every((query) => query.isSuccess || query.isError);
  const symbolStartDate = isAllTime ? earliestSeriesDate(accountQueries) : startDate;

  const symbolQueries = useQueries({
    queries: symbolItems.map((item) =>
      performanceQuery(item, symbolStartDate, enabled && !waitingForAccounts),
    ),
  });

  // Results in the order the items were selected.
  const performanceQueries = validItems.map((item) =>
    item.type === "symbol"
      ? symbolQueries[symbolItems.indexOf(item)]
      : accountQueries[accountItems.indexOf(item)],
  );
  // A waiting benchmark sits on its start-less key, which can hold an earlier
  // one-year result or error: report it as loading and leave it out.
  const isWaiting = (index: number) => waitingForAccounts && validItems[index].type === "symbol";

  const isLoading = performanceQueries.some((query, index) => query.isLoading || isWaiting(index));
  const failedQueries = performanceQueries.filter(
    (query, index) => query.isError && !isWaiting(index),
  );
  const hasErrors = failedQueries.length > 0;
  const errorMessages = failedQueries
    .map((query) => query.error)
    .filter(Boolean)
    .map((error) => (error instanceof Error ? error.message : String(error)));

  // Format chart data directly from query results
  const chartData = performanceQueries
    .map((query, index) => {
      if (isWaiting(index) || query.isError || !query.data) return null;

      const item = validItems[index];
      const symbolName =
        item.type === "symbol" && item.name !== item.id ? `${item.name} (${item.id})` : item.name;
      return {
        ...query.data,
        id: item.id,
        type: item.type,
        name: item.type === "symbol" ? symbolName : item.name,
      };
    })
    .filter(Boolean);

  const displayStartDate = dateRange?.from
    ? formatting.formatCalendarDate(calendarDateFromLocalDate(dateRange.from))
    : "";

  const displayEndDate = dateRange?.to
    ? formatting.formatCalendarDate(calendarDateFromLocalDate(dateRange.to))
    : "";

  const displayDateRange =
    dateRange === undefined
      ? "All Time"
      : displayStartDate && displayEndDate
        ? `${displayStartDate} - ${displayEndDate}`
        : "Compare account performance over time";

  return {
    data: chartData,
    isLoading,
    hasErrors,
    errorMessages,
    queries: performanceQueries,
    formattedStartDate: startDate,
    formattedEndDate: endDate,
    displayDateRange,
  };
}
