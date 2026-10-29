import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { QueryKeys } from "@/lib/query-keys";

import { searchCashActivities } from "../adapters/cash-activities";
import type {
  CashActivitySearchRequest,
  CashActivitySearchResponse,
  CashActivity,
} from "../types/cash-activity";

const PAGE_SIZE = 50;

/**
 * Server-side cash-activity search with infinite scroll. Mirrors the shape of
 * the main activity page's `useActivitySearch` so the Transactions page can
 * lean on the same UX pattern (debounced search, load-more, total count).
 */
export function useCashActivitySearch(
  request: Omit<CashActivitySearchRequest, "offset" | "limit">,
  options: { pageSize?: number; enabled?: boolean } = {},
) {
  const pageSize = options.pageSize ?? PAGE_SIZE;
  const enabled = options.enabled ?? true;

  const query = useInfiniteQuery<CashActivitySearchResponse, Error>({
    // React Query structurally compares keys, so we can pass the request object
    // directly without stringifying.
    queryKey: [QueryKeys.SPENDING_TRANSACTIONS, "search", request, pageSize],
    queryFn: ({ pageParam = 0 }) =>
      searchCashActivities({
        ...request,
        offset: pageParam as number,
        limit: pageSize,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const fetched = allPages.reduce((sum, p) => sum + p.items.length, 0);
      return fetched < lastPage.totalCount ? fetched : undefined;
    },
    enabled,
  });

  const items: CashActivity[] = useMemo(
    () => query.data?.pages.flatMap((p) => p.items) ?? [],
    [query.data],
  );
  const totalCount = query.data?.pages[0]?.totalCount ?? 0;
  // Only page one carries the net: it covers the whole filtered set, and the
  // client refetches it whenever the filter changes.
  const net = query.data?.pages[0]?.net ?? null;
  // Reported by the server rather than read from settings: it is the currency
  // `netAmountBase` is actually denominated in, so a cached page stays labelled
  // correctly even if the setting has since changed.
  const baseCurrency = query.data?.pages[0]?.baseCurrency ?? undefined;
  return {
    items,
    totalCount,
    net,
    baseCurrency,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isFetchingNextPage: query.isFetchingNextPage,
    isFetchNextPageError: query.isFetchNextPageError,
    isError: query.isError,
    hasNextPage: query.hasNextPage ?? false,
    fetchNextPage: query.fetchNextPage,
    refetch: query.refetch,
    error: query.error,
  };
}

const EMPTY_ITEMS: CashActivity[] = [];

/**
 * One page of the same server-side search, for the grid view: it pages with
 * offset and limit instead of loading more, as the Investments grid does.
 */
export function useCashActivityPage(
  request: Omit<CashActivitySearchRequest, "offset" | "limit">,
  options: { pageIndex: number; pageSize: number; enabled?: boolean },
) {
  const { pageIndex, pageSize } = options;
  const enabled = options.enabled ?? true;
  const pageQuery = (index: number) => ({
    queryKey: [QueryKeys.SPENDING_TRANSACTIONS, "page", request, index, pageSize],
    queryFn: () => searchCashActivities({ ...request, offset: index * pageSize, limit: pageSize }),
    enabled,
  });
  // The page on screen stays until the next one arrives, so turning a page
  // never empties or unmounts the grid, and its unsaved edits stay put.
  const query = useQuery<CashActivitySearchResponse, Error>({
    ...pageQuery(pageIndex),
    placeholderData: keepPreviousData,
  });
  // Only the first page carries the filter's net. On that page this is the same
  // query; on a later one it is the first page already fetched for this filter.
  const firstPage = useQuery<CashActivitySearchResponse, Error>(pageQuery(0));

  const totalCount = query.data?.totalCount ?? 0;
  return {
    items: query.data?.items ?? EMPTY_ITEMS,
    totalCount,
    pageCount: Math.ceil(totalCount / pageSize),
    net: firstPage.data?.net ?? null,
    baseCurrency: firstPage.data?.baseCurrency ?? query.data?.baseCurrency ?? undefined,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    // A failed refetch keeps the page it had: only a page with nothing to show
    // is an error, so the grid and its unsaved edits stay mounted.
    isError: query.isError && query.data === undefined,
    error: query.error,
    refetch: query.refetch,
  };
}
