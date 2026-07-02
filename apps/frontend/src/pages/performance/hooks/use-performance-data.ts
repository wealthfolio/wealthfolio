import { keepPreviousData, useQueries } from "@tanstack/react-query";
import { calculatePerformanceHistory } from "@/adapters";
import { format } from "date-fns";
import { DateRange } from "react-day-picker";
import { QueryKeys } from "@/lib/query-keys";
import { TrackedItem } from "@/lib/types";

function isChineseLocale(): boolean {
  return typeof document !== "undefined" && document.documentElement.lang === "zh-CN";
}

function formatDisplayDate(date: Date): string {
  if (isChineseLocale()) {
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(date);
  }
  return format(date, "MMM d, yyyy");
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
  // Filter out invalid items (defensive: handles stale localStorage data)
  const validItems = selectedItems.filter(
    (item) =>
      item && typeof item.id === "string" && item.id && typeof item.type === "string" && item.type,
  );

  // Keep dates undefined for all-time queries so the backend can apply
  // inception semantics instead of treating "ALL" as an explicit bounded range.
  const startDate = dateRange?.from ? format(dateRange.from, "yyyy-MM-dd") : undefined;
  const endDate = dateRange?.to ? format(dateRange.to, "yyyy-MM-dd") : undefined;

  const performanceQueries = useQueries({
    queries: validItems.map((item) => {
      const accountFilter = item.type === "account" ? item.accountScope : undefined;

      return {
        queryKey: [
          QueryKeys.PERFORMANCE_HISTORY,
          item.type,
          item.id,
          accountFilter,
          startDate,
          endDate,
          trackingMode,
        ],
        queryFn: () =>
          calculatePerformanceHistory(
            item.type,
            item.id,
            startDate,
            endDate,
            // Only pass trackingMode for accounts, not for symbols
            item.type === "account" ? trackingMode : undefined,
            accountFilter,
          ),
        // Enable query for all-time (`dateRange === undefined`) or valid bounded ranges.
        enabled: dateRange === undefined || (!!startDate && !!endDate),
        staleTime: 30 * 1000,
        retry: false,
        placeholderData: keepPreviousData,
      };
    }),
  });

  const isLoading = performanceQueries.some((query) => query.isLoading);
  const hasErrors = performanceQueries.some((query) => query.isError);
  const errorMessages = performanceQueries
    .filter((query) => query.isError)
    .map((query) => query.error)
    .filter(Boolean)
    .map((error) => (error instanceof Error ? error.message : String(error)));

  // Format chart data directly from query results
  const chartData = performanceQueries
    .map((query, index) => {
      if (query.isError || !query.data) return null;

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

  const displayStartDate = dateRange?.from ? formatDisplayDate(dateRange.from) : "";

  const displayEndDate = dateRange?.to ? formatDisplayDate(dateRange.to) : "";

  const displayDateRange =
    dateRange === undefined
      ? isChineseLocale()
        ? "全部时间"
        : "All Time"
      : displayStartDate && displayEndDate
        ? `${displayStartDate} - ${displayEndDate}`
        : isChineseLocale()
          ? "比较账户随时间的绩效"
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
