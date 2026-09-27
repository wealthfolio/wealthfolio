import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useDeleteAlternativeAsset } from "@/hooks/use-alternative-assets";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { QueryKeys } from "@/lib/query-keys";

import { useAssetManagement } from "./use-asset-management";
import { useAssetProfileMutations } from "./use-asset-profile-mutations";

const adapterMocks = vi.hoisted(() => ({
  createAsset: vi.fn(),
  createAlternativeAsset: vi.fn(),
  deleteAsset: vi.fn(),
  deleteAlternativeAsset: vi.fn(),
  getAlternativeHoldings: vi.fn(),
  getNetWorth: vi.fn(),
  getNetWorthHistory: vi.fn(),
  linkLiability: vi.fn(),
  logger: { error: vi.fn() },
  unlinkLiability: vi.fn(),
  updateAlternativeAssetValuation: vi.fn(),
  updateAssetProfile: vi.fn(),
  updateQuoteMode: vi.fn(),
}));

vi.mock("@/adapters", () => adapterMocks);
vi.mock("@/lib/performance-cache", () => ({ invalidatePerformanceCaches: vi.fn() }));
vi.mock("@wealthfolio/ui/components/ui/use-toast", () => ({ toast: vi.fn() }));

const assetId = "asset-a";

const createHarness = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
};

describe("asset logo index invalidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapterMocks.updateAssetProfile.mockResolvedValue({ id: assetId });
    adapterMocks.deleteAsset.mockResolvedValue(undefined);
    adapterMocks.deleteAlternativeAsset.mockResolvedValue(undefined);
  });

  it("invalidates after an asset profile update", async () => {
    const { queryClient, wrapper } = createHarness();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(useAssetProfileMutations, { wrapper });

    await act(async () => {
      await result.current.updateAssetProfileMutation.mutateAsync({
        id: assetId,
        displayCode: "NEW",
      });
    });

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: [QueryKeys.ASSET_LOGO_INDEX],
    });
  });

  it("invalidates after asset management updates and deletes", async () => {
    const { queryClient, wrapper } = createHarness();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(useAssetManagement, { wrapper });

    await act(async () => {
      await result.current.updateAssetMutation.mutateAsync({
        payload: { id: assetId, displayCode: "NEW" },
      });
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: [QueryKeys.ASSET_LOGO_INDEX],
    });

    invalidateQueries.mockClear();
    await act(async () => {
      await result.current.deleteAssetMutation.mutateAsync(assetId);
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: [QueryKeys.ASSET_LOGO_INDEX],
    });
  });

  it("invalidates after deleting an alternative asset", async () => {
    const { queryClient, wrapper } = createHarness();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useDeleteAlternativeAsset(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync(assetId);
    });

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: [QueryKeys.ASSET_LOGO_INDEX],
    });
  });
});

describe("asset profile identity conflicts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    new Error("Constraint violation: ASSET_IDENTITY_CONFLICT: Duplicate asset"),
    "Constraint violation: ASSET_IDENTITY_CONFLICT: Duplicate asset",
  ])("explains the conflict for web and desktop errors", async (error) => {
    adapterMocks.updateAssetProfile.mockRejectedValueOnce(error);
    const { queryClient, wrapper } = createHarness();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(useAssetProfileMutations, { wrapper });

    await act(async () => {
      await expect(
        result.current.updateAssetProfileMutation.mutateAsync({
          id: assetId,
          instrumentExchangeMic: "BCXE",
        }),
      ).rejects.toBe(error);
    });

    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "destructive",
        description:
          "Another asset already has this identity. Your changes were not saved. Use the existing asset or choose a different exchange.",
      }),
    );
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});
