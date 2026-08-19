import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountScope, Holding } from "@/lib/types";
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
    mocks.getHoldingsList.mockResolvedValue([openHolding]);

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
      Promise.resolve(options.includeClosed ? [closedHolding] : []),
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

  it("does not retain open-only positions while closed positions load", async () => {
    const openHolding = { id: "open" } as Holding;
    const closedHolding = { id: "closed", isClosed: true } as Holding;
    let resolveClosedQuery: ((holdings: Holding[]) => void) | undefined;

    mocks.getHoldingsList.mockImplementation((_filter, options: { includeClosed?: boolean }) => {
      if (!options.includeClosed) {
        return Promise.resolve([openHolding]);
      }

      return new Promise<Holding[]>((resolve) => {
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
      resolveClosedQuery?.([openHolding, closedHolding]);
    });

    await waitFor(() => expect(result.current.holdings).toEqual([openHolding, closedHolding]));
  });

  it("does not retain positions when the account scope changes", async () => {
    const firstAccountHolding = { id: "first-account" } as Holding;
    let resolveSecondAccount: ((holdings: Holding[]) => void) | undefined;

    mocks.getHoldingsList.mockImplementation((filter: AccountScope) => {
      if (filter.type === "account" && filter.accountId === "account-1") {
        return Promise.resolve([firstAccountHolding]);
      }

      return new Promise<Holding[]>((resolve) => {
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
      resolveSecondAccount?.([]);
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
  });
});
