import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountScope, Holding, HoldingsListResponse } from "@/lib/types";
import { QueryKeys } from "@/lib/query-keys";
import { useHoldings, useHoldingsWithClosedProbe } from "./use-holdings";

const mocks = vi.hoisted(() => ({
  getHoldingsList: vi.fn(),
}));

vi.mock("@/adapters", () => ({
  getHoldingsList: mocks.getHoldingsList,
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useHoldingsWithClosedProbe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not load closed positions when the open query has holdings", async () => {
    const openHolding = { id: "open" } as Holding;
    mocks.getHoldingsList.mockResolvedValue({ holdings: [openHolding], incompleteAccounts: [] });

    const { result } = renderHook(
      () =>
        useHoldingsWithClosedProbe(
          { type: "account", accountId: "account-1" },
          { includeClosed: false, probeClosedWhenEmpty: true },
        ),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.holdings).toEqual([openHolding]));

    expect(mocks.getHoldingsList).toHaveBeenCalledTimes(1);
    expect(mocks.getHoldingsList).toHaveBeenCalledWith(
      { type: "account", accountId: "account-1" },
      { includeClosed: false },
    );
    expect(result.current.hasHiddenClosedPositions).toBe(false);
  });

  it("probes closed positions after an empty open query", async () => {
    const closedHolding = { id: "closed", isClosed: true } as Holding;
    mocks.getHoldingsList.mockImplementation((_filter, options: { includeClosed?: boolean }) =>
      Promise.resolve({
        holdings: options.includeClosed ? [closedHolding] : [],
        incompleteAccounts: [],
      }),
    );

    const { result } = renderHook(
      () =>
        useHoldingsWithClosedProbe(
          { type: "account", accountId: "account-1" },
          { includeClosed: false, probeClosedWhenEmpty: true },
        ),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.hasHiddenClosedPositions).toBe(true));

    expect(mocks.getHoldingsList).toHaveBeenCalledTimes(2);
    expect(mocks.getHoldingsList).toHaveBeenCalledWith(
      { type: "account", accountId: "account-1" },
      { includeClosed: true },
    );
  });
});

describe("useHoldings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["pending", "unavailable"] as const)(
    "retains healthy rows and distinguishes %s from complete scope",
    async (status) => {
      const healthy = { id: "healthy", quantity: 1 } as Holding;
      mocks.getHoldingsList.mockResolvedValue({
        holdings: [healthy],
        incompleteAccounts: [{ accountId: "other", status, reasonCode: "test" }],
      });
      const { result } = renderHook(() => useHoldings({ type: "all" }), {
        wrapper: createWrapper(),
      });
      await waitFor(() => expect(result.current.holdings).toEqual([healthy]));
      expect(result.current.isComplete).toBe(false);
      expect(result.current.isUpdating).toBe(status === "pending");
      expect(result.current.isLoading).toBe(false);
      expect(result.current.isError).toBe(status === "unavailable");
    },
  );

  it("does not probe closed positions or claim empty when the open scope is pending", async () => {
    mocks.getHoldingsList.mockResolvedValue({
      holdings: [],
      incompleteAccounts: [
        { accountId: "account-1", status: "pending", reasonCode: "PROJECTION_PENDING" },
      ],
    });
    const { result } = renderHook(
      () =>
        useHoldingsWithClosedProbe(
          { type: "account", accountId: "account-1" },
          { includeClosed: false, probeClosedWhenEmpty: true },
        ),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.isUpdating).toBe(true));
    expect(result.current.isComplete).toBe(false);
    expect(result.current.hasHiddenClosedPositions).toBe(false);
    expect(mocks.getHoldingsList).toHaveBeenCalledTimes(1);
  });

  it("exposes background refreshes while retaining the cached holdings", async () => {
    const scope: AccountScope = { type: "account", accountId: "account-1" };
    const queryKey = [QueryKeys.HOLDINGS, scope, { includeClosed: false }];
    const cachedHolding = { id: "position", quantity: 10 } as Holding;
    const refreshedHolding = { ...cachedHolding, quantity: 6 };
    let resolveRefresh: ((holdings: HoldingsListResponse) => void) | undefined;
    mocks.getHoldingsList.mockImplementation(
      () =>
        new Promise<HoldingsListResponse>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 300_000 } },
    });
    queryClient.setQueryData(queryKey, { holdings: [cachedHolding], incompleteAccounts: [] });
    const { result } = renderHook(() => useHoldings(scope), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    });
    expect(result.current.isFetching).toBe(false);

    act(() => {
      void queryClient.invalidateQueries({ queryKey });
    });
    await waitFor(() => expect(result.current.isFetching).toBe(true));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.holdings).toEqual([cachedHolding]);

    act(() => {
      resolveRefresh?.({ holdings: [refreshedHolding], incompleteAccounts: [] });
    });
    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(result.current.holdings).toEqual([refreshedHolding]);
  });

  it("does not retain open-only positions while closed positions load", async () => {
    const openHolding = { id: "open" } as Holding;
    const closedHolding = { id: "closed", isClosed: true } as Holding;
    let resolveClosedQuery: ((holdings: HoldingsListResponse) => void) | undefined;

    mocks.getHoldingsList.mockImplementation((_filter, options: { includeClosed?: boolean }) => {
      if (!options.includeClosed) {
        return Promise.resolve({ holdings: [openHolding], incompleteAccounts: [] });
      }

      return new Promise<HoldingsListResponse>((resolve) => {
        resolveClosedQuery = resolve;
      });
    });

    const { result, rerender } = renderHook(
      ({ includeClosed }) =>
        useHoldings({ type: "account", accountId: "account-1" }, { includeClosed }),
      {
        initialProps: { includeClosed: false },
        wrapper: createWrapper(),
      },
    );

    await waitFor(() => expect(result.current.holdings).toEqual([openHolding]));

    rerender({ includeClosed: true });

    expect(result.current.holdings).toEqual([]);
    expect(result.current.isLoading).toBe(true);

    act(() => {
      resolveClosedQuery?.({ holdings: [openHolding, closedHolding], incompleteAccounts: [] });
    });

    await waitFor(() => expect(result.current.holdings).toEqual([openHolding, closedHolding]));
  });

  it("does not retain positions when the account scope changes", async () => {
    const firstAccountHolding = { id: "first-account" } as Holding;
    let resolveSecondAccount: ((holdings: HoldingsListResponse) => void) | undefined;

    mocks.getHoldingsList.mockImplementation((filter: AccountScope) => {
      if (filter.type === "account" && filter.accountId === "account-1") {
        return Promise.resolve({ holdings: [firstAccountHolding], incompleteAccounts: [] });
      }

      return new Promise<HoldingsListResponse>((resolve) => {
        resolveSecondAccount = resolve;
      });
    });

    const { result, rerender } = renderHook(
      ({ accountId }) => useHoldings({ type: "account", accountId }),
      {
        initialProps: { accountId: "account-1" },
        wrapper: createWrapper(),
      },
    );

    await waitFor(() => expect(result.current.holdings).toEqual([firstAccountHolding]));

    rerender({ accountId: "account-2" });

    expect(result.current.holdings).toEqual([]);
    expect(result.current.isLoading).toBe(true);

    act(() => {
      resolveSecondAccount?.({ holdings: [], incompleteAccounts: [] });
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
  });
});
