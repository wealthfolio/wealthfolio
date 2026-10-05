import { createElement, type ReactNode } from "react";
import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@/test/render";
import { QueryKeys } from "@/lib/query-keys";
import {
  invalidateAlternativeAssetQueries,
  useAlternativeAssetMutations,
} from "./use-alternative-asset-mutations";

const mocks = vi.hoisted(() => ({ update: vi.fn(), toast: vi.fn() }));
vi.mock("@/adapters", () => ({
  createAlternativeAsset: vi.fn(),
  updateAlternativeAssetValuation: vi.fn(),
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
