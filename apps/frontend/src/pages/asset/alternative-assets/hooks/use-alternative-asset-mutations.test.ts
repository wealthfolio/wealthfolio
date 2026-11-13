import { createElement, type ReactNode } from "react";
import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { renderHook, waitFor } from "@/test/render";
import { QueryKeys } from "@/lib/query-keys";
import {
  invalidateAlternativeAssetQueries,
  useAlternativeAssetMutations,
} from "./use-alternative-asset-mutations";

const mocks = vi.hoisted(() => ({ update: vi.fn(), updateValuation: vi.fn(), toast: vi.fn() }));
vi.mock("@/adapters", () => ({
  createAlternativeAsset: vi.fn(),
  updateAlternativeAssetValuation: mocks.updateValuation,
  updateAlternativeAssetMetadata: mocks.update,
  deleteAlternativeAsset: vi.fn(),
  linkLiability: vi.fn(),
  unlinkLiability: vi.fn(),
  logger: { error: vi.fn() },
}));
vi.mock("@wealthfolio/ui/components/ui/use-toast", () => ({ toast: mocks.toast }));

describe("alternative asset query invalidation", () => {
  it("waits for holdings and metadata queries to finish refreshing", async () => {
    let resolveAlternativeHoldings: (() => void) | undefined;
    const alternativeHoldingsRefresh = new Promise<void>((resolve) => {
      resolveAlternativeHoldings = resolve;
    });
    const invalidateQueries = vi.fn(({ queryKey }: { queryKey: string[] }) =>
      queryKey[0] === QueryKeys.ALTERNATIVE_HOLDINGS
        ? alternativeHoldingsRefresh
        : Promise.resolve(),
    );
    const queryClient = { invalidateQueries } as unknown as QueryClient;

    let completed = false;
    const invalidation = invalidateAlternativeAssetQueries(queryClient).then(() => {
      completed = true;
    });
    await Promise.resolve();

    expect(completed).toBe(false);
    resolveAlternativeHoldings?.();
    await invalidation;
    expect(completed).toBe(true);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: [QueryKeys.ASSET_DATA],
    });
  });

  it("leaves account values and performance alone", async () => {
    const invalidateQueries = vi.fn((_: { queryKey: string[] }) => Promise.resolve());
    await invalidateAlternativeAssetQueries({ invalidateQueries } as unknown as QueryClient);

    const keys = invalidateQueries.mock.calls.map(([{ queryKey }]) => queryKey[0]);
    expect(keys).toContain(QueryKeys.QUOTE_HISTORY);
    for (const key of [
      QueryKeys.ACCOUNTS,
      QueryKeys.HISTORY_VALUATION,
      QueryKeys.PERFORMANCE_HISTORY,
      QueryKeys.PERFORMANCE_SUMMARY,
    ]) {
      expect(keys).not.toContain(key);
    }
  });

  it("refreshes health status without waiting for the health check", async () => {
    const healthCheck = new Promise<void>(() => undefined);
    const invalidateQueries = vi.fn(({ queryKey }: { queryKey: string[] }) =>
      queryKey[0] === QueryKeys.HEALTH_STATUS ? healthCheck : Promise.resolve(),
    );
    const queryClient = { invalidateQueries } as unknown as QueryClient;

    await invalidateAlternativeAssetQueries(queryClient);

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: [QueryKeys.HEALTH_STATUS],
    });
  });
});

describe("updating a value", () => {
  it("reloads the asset's value history", async () => {
    mocks.updateValuation.mockResolvedValueOnce({
      quoteId: "q2",
      valuationDate: "2026-11-01",
      value: "460000",
    });
    // Nothing goes stale on its own here, as with the app's five-minute window.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const loadHistory = vi.fn().mockResolvedValue([]);
    const { result } = renderHook(
      () => {
        useQuery({ queryKey: [QueryKeys.QUOTE_HISTORY, "house"], queryFn: loadHistory });
        return useAlternativeAssetMutations();
      },
      { wrapper },
    );
    await waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(1));

    await act(() =>
      result.current.updateValuationMutation.mutateAsync({
        assetId: "house",
        request: { value: "460000", date: "2026-11-01" },
      }),
    );

    expect(loadHistory).toHaveBeenCalledTimes(2);
  });
});

describe("saving details", () => {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: new QueryClient() }, children);
  const save = async (loan?: { originalAmount: number }) => {
    const { result } = renderHook(() => useAlternativeAssetMutations(), { wrapper });
    await act(() =>
      result.current.updateMetadataMutation
        .mutateAsync({ assetId: "loan", metadata: { sub_type: "mortgage" }, name: "Home", loan })
        .catch(() => undefined),
    );
  };

  it("sends a loan setup with the other details in one request", async () => {
    mocks.update.mockResolvedValueOnce(undefined);
    await save({ originalAmount: 1200 });
    expect(mocks.update).toHaveBeenCalledWith("loan", { sub_type: "mortgage" }, "Home", undefined, {
      originalAmount: 1200,
    });
  });

  it("leaves a refused loan setup to the form, and reports other failures", async () => {
    mocks.toast.mockClear();
    mocks.update.mockRejectedValueOnce(new Error("LOAN_MATURITY_BEFORE_ORIGINATION"));
    await save({ originalAmount: 1200 });
    expect(mocks.toast).not.toHaveBeenCalled();
    mocks.update.mockRejectedValueOnce(new Error("database is locked"));
    await save({ originalAmount: 1200 });
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });
});
