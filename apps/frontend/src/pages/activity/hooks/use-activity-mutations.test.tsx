import { ActivityType } from "@/lib/constants";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useActivityMutations } from "./use-activity-mutations";

const adapterMocks = vi.hoisted(() => ({
  createActivity: vi.fn(),
  updateActivity: vi.fn(),
  deleteActivity: vi.fn(),
  linkTransferActivities: vi.fn(),
  saveActivities: vi.fn(),
  unlinkTransferActivities: vi.fn(),
  logger: { error: vi.fn() },
}));

vi.mock("@/adapters", () => adapterMocks);
vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useActivityMutations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapterMocks.createActivity.mockResolvedValue({ id: "activity-created" });
    adapterMocks.updateActivity.mockResolvedValue({ id: "activity-updated" });
    adapterMocks.saveActivities.mockResolvedValue({
      created: [
        {
          id: "created-deposit",
          accountId: "acc-1",
          activityType: ActivityType.DEPOSIT,
        },
        {
          id: "created-buy",
          accountId: "acc-1",
          activityType: ActivityType.BUY,
        },
      ],
      updated: [],
      deleted: [],
      createdMappings: [],
      errors: [],
    });
  });

  it("does not send a stale selected asset id after the symbol is cleared", async () => {
    const { result } = renderHook(() => useActivityMutations(), { wrapper: createWrapper() });

    await act(async () => {
      await result.current.addActivityMutation.mutateAsync({
        accountId: "acc-1",
        activityType: "TRANSFER_IN",
        activityDate: new Date("2026-04-30T16:00:00Z"),
        amount: 1000,
        currency: "USD",
        assetId: "",
        existingAssetId: "asset-stale",
        exchangeMic: "XNAS",
        symbolQuoteCcy: "USD",
        symbolInstrumentType: "EQUITY",
      } as any);
    });

    expect(adapterMocks.createActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        asset: undefined,
      }),
    );
  });

  it("falls back to the current asset id when mobile edit has no selected search id", async () => {
    const { result } = renderHook(() => useActivityMutations(), { wrapper: createWrapper() });

    await act(async () => {
      await result.current.updateActivityMutation.mutateAsync({
        id: "activity-1",
        accountId: "acc-1",
        activityType: "BUY",
        activityDate: new Date("2026-04-30T16:00:00Z"),
        quantity: 1,
        unitPrice: 250,
        currency: "USD",
        assetId: "TSLA",
        currentAssetId: "asset-tsla",
      } as any);
    });

    expect(adapterMocks.updateActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        asset: expect.objectContaining({
          id: "asset-tsla",
          symbol: "TSLA",
        }),
      }),
    );
  });

  it("ignores stale selected asset id for option identities", async () => {
    const { result } = renderHook(() => useActivityMutations(), { wrapper: createWrapper() });

    await act(async () => {
      await result.current.addActivityMutation.mutateAsync({
        accountId: "acc-1",
        activityType: "BUY",
        activityDate: new Date("2026-04-30T16:00:00Z"),
        quantity: 1,
        unitPrice: 10,
        currency: "USD",
        assetId: "AAPL260116C00250000",
        existingAssetId: "asset-aapl-stock",
        symbolInstrumentType: "OPTION",
      } as any);
    });

    expect(adapterMocks.createActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        asset: expect.objectContaining({
          id: undefined,
          symbol: "AAPL260116C00250000",
          instrumentType: "OPTION",
        }),
      }),
    );
  });

  it("bulk-creates deposit and buy when includeCashDeposit is enabled", async () => {
    const { result } = renderHook(() => useActivityMutations(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.addActivityMutation.mutateAsync({
        accountId: "acc-1",
        activityType: ActivityType.BUY,
        activityDate: "2026-03-19T00:00:00.000Z",
        assetId: "AAPL260417C00150000",
        quantity: 2,
        unitPrice: 3,
        fee: 1,
        currency: "USD",
        symbolInstrumentType: "OPTION",
        contractMultiplier: 100,
        includeCashDeposit: true,
      } as never);
    });

    expect(adapterMocks.createActivity).not.toHaveBeenCalled();
    expect(adapterMocks.saveActivities).toHaveBeenCalledTimes(1);
    expect(adapterMocks.saveActivities).toHaveBeenCalledWith({
      creates: [
        expect.objectContaining({
          accountId: "acc-1",
          activityType: ActivityType.DEPOSIT,
          activityDate: "2026-03-19T00:00:00.000Z",
          amount: "601",
          currency: "USD",
          comment: "Cash deposit for AAPL260417C00150000 purchase",
        }),
        expect.objectContaining({
          accountId: "acc-1",
          activityType: ActivityType.BUY,
          quantity: "2",
          unitPrice: "3",
          fee: "1",
        }),
      ],
    });
  });
});
