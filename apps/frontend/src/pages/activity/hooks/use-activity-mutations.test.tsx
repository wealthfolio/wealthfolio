import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityType } from "@/lib/constants";
import type { ActivityDetails } from "@/lib/types";
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
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["Original notes\nSecond line", "", undefined])(
    "duplicates with today's date and preserves notes %j",
    async (comment) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const now = new Date(2026, 9, 8, 23, 30);
      vi.setSystemTime(now);
      const source = {
        id: "activity-original",
        accountId: "acc-1",
        activityType: ActivityType.DEPOSIT,
        date: new Date("2024-01-15T10:00:00Z"),
        amount: "100",
        currency: "USD",
        comment,
      } as ActivityDetails;
      const { result } = renderHook(() => useActivityMutations(), { wrapper: createWrapper() });

      await act(async () => {
        await result.current.duplicateActivityMutation.mutateAsync(source);
      });

      expect(adapterMocks.createActivity).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          activityDate: now,
          comment,
          accountId: source.accountId,
          amount: source.amount,
        }),
      );
      expect(source.date).toEqual(new Date("2024-01-15T10:00:00Z"));
      expect(source.comment).toBe(comment);
      expect(adapterMocks.updateActivity).not.toHaveBeenCalled();
    },
  );

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

    const payload = adapterMocks.updateActivity.mock.calls[0][0];
    expect(payload).not.toHaveProperty("needsReview");
    expect(payload).not.toHaveProperty("status");
    expect(payload).toEqual(
      expect.objectContaining({
        asset: expect.objectContaining({
          id: "asset-tsla",
          symbol: "TSLA",
        }),
      }),
    );
  });

  it("sends an explicit empty asset patch when an edit clears the asset", async () => {
    const { result } = renderHook(() => useActivityMutations(), { wrapper: createWrapper() });

    await act(async () => {
      await result.current.updateActivityMutation.mutateAsync({
        id: "adjustment-1",
        accountId: "acc-1",
        activityType: ActivityType.ADJUSTMENT,
        activityDate: new Date("2026-04-30T16:00:00Z"),
        amount: 25,
        currency: "USD",
        currentAssetId: "asset-aapl",
        clearAsset: true,
      } as any);
    });

    expect(adapterMocks.updateActivity).toHaveBeenCalledWith(
      expect.objectContaining({ asset: {} }),
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

  it("does not copy derived amounts when duplicating price-bearing activities", async () => {
    const { result } = renderHook(() => useActivityMutations(), { wrapper: createWrapper() });

    await act(async () => {
      await result.current.duplicateActivityMutation.mutateAsync({
        id: "activity-1",
        accountId: "acc-1",
        activityType: "BUY",
        date: "2026-04-30T16:00:00Z",
        assetId: "asset-aapl",
        assetSymbol: "AAPL",
        exchangeMic: "XNAS",
        quantity: 2,
        unitPrice: 100,
        amount: 200,
        fee: 0,
        currency: "USD",
      } as any);
    });

    expect(adapterMocks.createActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: undefined,
        quantity: 2,
        unitPrice: 100,
      }),
    );
  });

  it.each([true, false])(
    "preserves only an explicit %s performance boundary when duplicating",
    async (isExternal) => {
      const { result } = renderHook(() => useActivityMutations(), { wrapper: createWrapper() });

      await act(async () => {
        await result.current.duplicateActivityMutation.mutateAsync({
          id: "activity-1",
          accountId: "acc-1",
          activityType: ActivityType.CREDIT,
          subtype: "REIMBURSEMENT",
          date: "2026-04-30T16:00:00Z",
          amount: "100",
          currency: "USD",
          metadata: {
            raw_type: "merchant_refund",
            flow: { confidence: 0.9, is_external: isExternal },
          },
        } as any);
      });

      expect(adapterMocks.createActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          subtype: "REIMBURSEMENT",
          metadata: { flow: { is_external: isExternal } },
        }),
      );
    },
  );

  it("copies bond trade amounts when duplicating buy and sell activities", async () => {
    const { result } = renderHook(() => useActivityMutations(), { wrapper: createWrapper() });
    const bondActivity = (
      activityType: typeof ActivityType.BUY | typeof ActivityType.SELL,
    ): ActivityDetails => ({
      id: "activity-1",
      accountId: "acc-1",
      accountName: "Taxable",
      accountCurrency: "CAD",
      activityType,
      date: new Date("2026-04-30T16:00:00Z"),
      assetId: "asset-bond",
      assetSymbol: "CA135087Q988",
      assetName: "Canada Bond",
      exchangeMic: "XTSE",
      instrumentType: "BOND",
      quantity: "1000",
      unitPrice: "99",
      amount: "990",
      fee: "0",
      currency: "CAD",
      needsReview: false,
      createdAt: new Date("2026-04-30T16:00:00Z"),
      updatedAt: new Date("2026-04-30T16:00:00Z"),
    });

    await act(async () => {
      await result.current.duplicateActivityMutation.mutateAsync(bondActivity(ActivityType.BUY));
      await result.current.duplicateActivityMutation.mutateAsync(bondActivity(ActivityType.SELL));
    });

    expect(adapterMocks.createActivity).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        activityType: ActivityType.BUY,
        amount: "990",
        quantity: "1000",
        unitPrice: "99",
      }),
    );
    expect(adapterMocks.createActivity).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        activityType: ActivityType.SELL,
        amount: "990",
        quantity: "1000",
        unitPrice: "99",
      }),
    );
  });
});
