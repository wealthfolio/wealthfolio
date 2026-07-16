import { searchActivities } from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import { ActivityType } from "@/lib/constants";
import { ActivityDetails, ActivitySearchResponse } from "@/lib/types";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { SortingState } from "@tanstack/react-table";
import { useMemo } from "react";

export type ActivityStatusFilter = "all" | "pending" | "validated";

export interface ActivitySearchFilters {
  accountIds?: string[];
  activityTypes: ActivityType[];
  instrumentTypes?: string[];
  status?: ActivityStatusFilter;
  /** Inclusive date bounds (YYYY-MM-DD) — used by Health Center deeplinks. */
  dateFrom?: string;
  dateTo?: string;
  /** Exact activity ids — used by Health Center deep-links to one transaction. */
  activityIds?: string[];
}

interface BaseOptions {
  filters: ActivitySearchFilters;
  searchQuery: string;
  sorting: SortingState;
  pageSize?: number;
}

export interface UseActivitySearchInfiniteOptions extends BaseOptions {
  mode?: "infinite";
}

export interface UseActivitySearchPaginatedOptions extends BaseOptions {
  mode: "paginated";
  pageIndex: number;
}

export type UseActivitySearchOptions =
  | UseActivitySearchInfiniteOptions
  | UseActivitySearchPaginatedOptions;

// Result type for infinite mode (load more)
export interface UseActivitySearchInfiniteResult {
  mode: "infinite";
  data: ActivityDetails[];
  totalRowCount: number;
  fetchNextPage: () => Promise<unknown>;
  hasNextPage: boolean | undefined;
  isFetching: boolean;
  isFetchingNextPage: boolean;
  isLoading: boolean;
  refetch: () => Promise<unknown>;
}

// Result type for paginated mode
export interface UseActivitySearchPaginatedResult {
  mode: "paginated";
  data: ActivityDetails[];
  totalRowCount: number;
  pageCount: number;
  isFetching: boolean;
  isLoading: boolean;
  refetch: () => Promise<unknown>;
}

export type UseActivitySearchResult =
  | UseActivitySearchInfiniteResult
  | UseActivitySearchPaginatedResult;

const DEFAULT_SORT = { id: "date", desc: true };
const DEFAULT_PAGE_SIZE = 50;
const EMPTY_RESPONSE: ActivitySearchResponse = { data: [], meta: { totalRowCount: 0 } };

export function useActivitySearch(
  options: UseActivitySearchInfiniteOptions,
): UseActivitySearchInfiniteResult;
export function useActivitySearch(
  options: UseActivitySearchPaginatedOptions,
): UseActivitySearchPaginatedResult;
export function useActivitySearch(options: UseActivitySearchOptions): UseActivitySearchResult {
  const { filters, searchQuery, sorting, pageSize = DEFAULT_PAGE_SIZE } = options;
  const mode = options.mode ?? "infinite";
  const pageIndex = "pageIndex" in options ? options.pageIndex : 0;
  const hasClosedAccountScope = filters.accountIds?.length === 0;

  const normalizedFilters = useMemo(() => {
    // Convert status filter to needsReview boolean
    let needsReview: boolean | undefined;
    if (filters.status === "pending") {
      needsReview = true;
    } else if (filters.status === "validated") {
      needsReview = false;
    }
    // Undefined means all accounts; an empty array means a closed-empty scope.

    return {
      accountIds: filters.accountIds,
      activityTypes: filters.activityTypes.length > 0 ? filters.activityTypes : undefined,
      instrumentTypes: filters.instrumentTypes?.length ? filters.instrumentTypes : undefined,
      needsReview,
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      activityIds: filters.activityIds?.length ? filters.activityIds : undefined,
    } as Record<string, unknown>;
  }, [
    filters.accountIds,
    filters.activityTypes,
    filters.instrumentTypes,
    filters.status,
    filters.dateFrom,
    filters.dateTo,
    filters.activityIds,
  ]);

  const primarySort = useMemo(
    () =>
      sorting.length > 0 && sorting[0]?.id
        ? ({ id: sorting[0].id, desc: sorting[0].desc ?? false } as {
            id: string;
            desc: boolean;
          })
        : DEFAULT_SORT,
    [sorting],
  );

  // Infinite query for "load more" mode
  const infiniteQuery = useInfiniteQuery<ActivitySearchResponse, Error>({
    queryKey: [
      QueryKeys.ACTIVITY_DATA,
      "infinite",
      normalizedFilters,
      searchQuery,
      hasClosedAccountScope,
      primarySort,
      pageSize,
    ],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      if (hasClosedAccountScope) return EMPTY_RESPONSE;
      const page = typeof pageParam === "number" ? pageParam : 0;
      return searchActivities(page, pageSize, normalizedFilters, searchQuery, primarySort);
    },
    getNextPageParam: (lastPage, allPages) => {
      const fetched = allPages.reduce((acc, page) => acc + page.data.length, 0);
      return fetched < lastPage.meta.totalRowCount ? allPages.length : undefined;
    },
    enabled: mode === "infinite",
  });

  // Standard query for paginated mode
  const paginatedQuery = useQuery<ActivitySearchResponse, Error>({
    queryKey: [
      QueryKeys.ACTIVITY_DATA,
      "paginated",
      normalizedFilters,
      searchQuery,
      hasClosedAccountScope,
      primarySort,
      pageIndex,
      pageSize,
    ],
    queryFn: async () => {
      if (hasClosedAccountScope) return EMPTY_RESPONSE;
      return searchActivities(pageIndex, pageSize, normalizedFilters, searchQuery, primarySort);
    },
    enabled: mode === "paginated",
  });

  // Memoized data for infinite mode
  const infiniteData = useMemo(
    () => infiniteQuery.data?.pages.flatMap((page) => page.data) ?? [],
    [infiniteQuery.data?.pages],
  );

  const infiniteTotalRowCount = useMemo(
    () => infiniteQuery.data?.pages?.[0]?.meta.totalRowCount ?? 0,
    [infiniteQuery.data?.pages],
  );

  // Memoized data for paginated mode
  const paginatedData = paginatedQuery.data?.data ?? [];
  const paginatedTotalRowCount = paginatedQuery.data?.meta.totalRowCount ?? 0;
  const pageCount = Math.ceil(paginatedTotalRowCount / pageSize);

  if (mode === "paginated") {
    return {
      mode: "paginated",
      data: paginatedData,
      totalRowCount: paginatedTotalRowCount,
      pageCount,
      isFetching: paginatedQuery.isFetching,
      isLoading: paginatedQuery.isLoading,
      refetch: paginatedQuery.refetch,
    };
  }

  return {
    mode: "infinite",
    data: infiniteData,
    totalRowCount: infiniteTotalRowCount,
    fetchNextPage: infiniteQuery.fetchNextPage,
    hasNextPage: infiniteQuery.hasNextPage,
    isFetching: infiniteQuery.isFetching,
    isFetchingNextPage: infiniteQuery.isFetchingNextPage,
    isLoading: infiniteQuery.isLoading,
    refetch: infiniteQuery.refetch,
  };
}
