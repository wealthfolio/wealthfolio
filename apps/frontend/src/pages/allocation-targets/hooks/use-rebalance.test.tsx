import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import type { RebalancePlan } from "@/lib/types";
import { useRebalancePlan } from "./use-rebalance";

const { calculateRebalancePlanMock } = vi.hoisted(() => ({
  calculateRebalancePlanMock: vi.fn(),
}));

vi.mock("@/adapters", () => ({
  calculateRebalancePlan: calculateRebalancePlanMock,
  canonicalizeEligibleAssetIds: (assetIds?: readonly string[]) =>
    assetIds === undefined ? undefined : [...new Set(assetIds)].sort(),
}));

const plan: RebalancePlan = {
  targetId: "target-1",
  availableCash: 100,
  cashUsed: 100,
  cashRemaining: 0,
  maxDriftBpsBefore: 100,
  maxDriftBpsAfter: 0,
  trades: [],
  warnings: [],
  afterBpsByCategory: {},
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

describe("useRebalancePlan eligibility cache", () => {
  it("separates allowlists in the cache and reuses an exact canonical input", async () => {
    calculateRebalancePlanMock.mockReset().mockResolvedValue(plan);
    const wrapper = createWrapper();
    const { result, rerender } = renderHook(
      ({ eligibleAssetIds }: { eligibleAssetIds?: string[] }) =>
        useRebalancePlan({
          targetId: "target-1",
          cash: 100,
          filter: { type: "all" },
          scenarioMode: "cash_flow_only",
          sourceKey: "source-1",
          eligibleAssetIds,
        }),
      {
        initialProps: { eligibleAssetIds: ["asset-z", "asset-a", "asset-z"] },
        wrapper,
      },
    );

    let firstResult: unknown;
    await act(async () => {
      firstResult = (await result.current.refetch()).data;
    });
    expect(firstResult).toBeDefined();
    expect(calculateRebalancePlanMock).toHaveBeenCalledTimes(1);
    expect(calculateRebalancePlanMock).toHaveBeenLastCalledWith(
      "target-1",
      100,
      { type: "all" },
      "cash_flow_only",
      ["asset-a", "asset-z"],
    );
    rerender({ eligibleAssetIds: ["asset-b"] });
    expect(result.current.data).toBeUndefined();
    await act(async () => {
      await result.current.refetch();
    });
    expect(calculateRebalancePlanMock).toHaveBeenCalledTimes(2);

    rerender({ eligibleAssetIds: ["asset-z", "asset-a"] });
    await waitFor(() => expect(result.current.data).toEqual(firstResult));
    expect(calculateRebalancePlanMock).toHaveBeenCalledTimes(2);
  });
});
