import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCashActivityPage, useCashActivitySearch } from "./use-cash-activity-search";

const adapterMocks = vi.hoisted(() => ({
  searchCashActivities: vi.fn(),
}));

vi.mock("../adapters/cash-activities", () => adapterMocks);

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useCashActivitySearch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes a next-page error without discarding the first page", async () => {
    adapterMocks.searchCashActivities
      .mockResolvedValueOnce({ items: [], totalCount: 100 })
      .mockRejectedValueOnce(new Error("page 2 failed"));

    const { result } = renderHook(() => useCashActivitySearch({}), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    await act(async () => {
      await result.current.fetchNextPage();
    });

    await waitFor(() => expect(result.current.isFetchNextPageError).toBe(true));
    expect(result.current.totalCount).toBe(100);
    expect(result.current.hasNextPage).toBe(true);
  });

  it("asks for cash balances and keeps them on the rows", async () => {
    adapterMocks.searchCashActivities.mockResolvedValueOnce({
      items: [{ id: "coffee", cashBalance: "50", cashBalanceCurrency: "USD" }],
      totalCount: 1,
    });

    const { result } = renderHook(() => useCashActivitySearch({ includeCashBalances: true }), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(adapterMocks.searchCashActivities).toHaveBeenCalledWith(
      expect.objectContaining({ includeCashBalances: true }),
    );
    expect(result.current.items[0]?.cashBalance).toBe("50");
  });
});

describe("useCashActivityPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the current page on screen while the next one loads", async () => {
    let resolveNext!: (page: unknown) => void;
    adapterMocks.searchCashActivities.mockImplementation(({ offset }: { offset: number }) =>
      offset === 0
        ? Promise.resolve({ items: [{ id: "first" }], totalCount: 2, net: null })
        : new Promise((resolve) => {
            resolveNext = resolve;
          }),
    );

    const { result, rerender } = renderHook(
      ({ pageIndex }) => useCashActivityPage({}, { pageIndex, pageSize: 1 }),
      { wrapper: createWrapper(), initialProps: { pageIndex: 0 } },
    );
    await waitFor(() => expect(result.current.items).toEqual([{ id: "first" }]));

    rerender({ pageIndex: 1 });
    await waitFor(() => expect(result.current.isFetching).toBe(true));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.items).toEqual([{ id: "first" }]);
    expect(result.current.pageCount).toBe(2);

    await act(async () => {
      resolveNext({ items: [{ id: "second" }], totalCount: 2 });
    });
    await waitFor(() => expect(result.current.items).toEqual([{ id: "second" }]));
  });

  it("keeps the page and reports no error when its refetch fails", async () => {
    adapterMocks.searchCashActivities
      .mockResolvedValueOnce({ items: [{ id: "first" }], totalCount: 1, net: null })
      .mockRejectedValue(new Error("offline"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useCashActivityPage({}, { pageIndex: 0, pageSize: 1 }), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    await waitFor(() => expect(result.current.items).toEqual([{ id: "first" }]));

    await act(async () => {
      await result.current.refetch();
    });
    // Let the failed refetch reach the hook before reading it.
    await waitFor(() => expect(client.getQueryCache().getAll()[0]?.state.status).toBe("error"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));

    expect(result.current.isError).toBe(false);
    expect(result.current.items).toEqual([{ id: "first" }]);
  });

  it("reports an error when there is no page to show", async () => {
    adapterMocks.searchCashActivities.mockRejectedValue(new Error("offline"));

    const { result } = renderHook(() => useCashActivityPage({}, { pageIndex: 0, pageSize: 1 }), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
