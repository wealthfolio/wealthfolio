import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  logger: {
    error: vi.fn(),
  },
}));

vi.mock("./platform", () => ({
  invoke: mocks.invoke,
  logger: mocks.logger,
}));

import {
  createActivity,
  saveActivities,
  saveInternalTransferPair,
  reviewInternalTransferPairSplitEffects,
  searchActivities,
  updateActivity,
} from "./activities";

const baseActivity = {
  accountId: "account-1",
  activityType: "CREDIT",
  subtype: "REFUND",
  activityDate: "2026-08-11T00:00:00.000Z",
  currency: "USD",
};

describe("activity search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads the asset quote mode that the backend sends as assetPricingMode", async () => {
    mocks.invoke.mockResolvedValue({
      data: [
        { id: "manual", assetPricingMode: "MANUAL" },
        { id: "market", assetPricingMode: "MARKET" },
      ],
      meta: { totalRowCount: 2 },
    });

    const response = await searchActivities(0, 50, {}, "");

    expect(response.data).toEqual([
      { id: "manual", assetPricingMode: "MANUAL", assetQuoteMode: "MANUAL" },
      { id: "market", assetPricingMode: "MARKET", assetQuoteMode: "MARKET" },
    ]);
    expect(response.meta).toEqual({ totalRowCount: 2 });
  });
});

describe("activity metadata serialization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invoke.mockResolvedValue({});
  });

  it("serializes object metadata for creates without mutating the caller payload", async () => {
    const activity = {
      ...baseActivity,
      metadata: { flow: { is_external: true } },
    };

    await createActivity(activity);

    expect(activity.metadata).toEqual({ flow: { is_external: true } });
    expect(mocks.invoke).toHaveBeenCalledWith("create_activity", {
      activity: {
        ...baseActivity,
        metadata: '{"flow":{"is_external":true}}',
      },
    });
  });

  it("serializes object metadata for updates", async () => {
    await updateActivity({
      id: "activity-1",
      ...baseActivity,
      metadata: { raw_type: "merchant_refund", flow: { is_external: true } },
    });

    expect(mocks.invoke).toHaveBeenCalledWith("update_activity", {
      activity: {
        id: "activity-1",
        ...baseActivity,
        metadata: '{"raw_type":"merchant_refund","flow":{"is_external":true}}',
      },
    });
  });

  it.each([
    { name: "saves", call: saveInternalTransferPair, command: "save_internal_transfer_pair" },
    {
      name: "reviews",
      call: reviewInternalTransferPairSplitEffects,
      command: "review_internal_transfer_pair_split_effects",
    },
  ])(
    "preserves the selected leg and normalizes the date for pair $name",
    async ({ call, command }) => {
      const request = {
        editedActivityId: "pair-in",
        transferOutId: "pair-out",
        transferInId: "pair-in",
        fromAccountId: "from",
        toAccountId: "to",
        activityDate: new Date("2026-02-01T10:00:00Z"),
        sourceAmount: 100,
        destinationAmount: 100,
        sourceCurrency: "USD",
        destinationCurrency: "USD",
        notes: null,
      };
      await call(request);
      expect(mocks.invoke).toHaveBeenCalledWith(command, {
        request: { ...request, activityDate: "2026-02-01T10:00:00.000Z" },
      });
      expect(request.activityDate).toBeInstanceOf(Date);
    },
  );

  it("normalizes metadata in bulk creates and updates while preserving JSON strings", async () => {
    await saveActivities({
      creates: [{ ...baseActivity, metadata: { flow: { is_external: true } } }],
      updates: [
        {
          id: "activity-1",
          ...baseActivity,
          metadata: '{"flow":{"is_external":false}}',
        },
      ],
    });

    expect(mocks.invoke).toHaveBeenCalledWith("save_activities", {
      request: {
        creates: [
          {
            ...baseActivity,
            metadata: '{"flow":{"is_external":true}}',
          },
        ],
        updates: [
          {
            id: "activity-1",
            ...baseActivity,
            metadata: '{"flow":{"is_external":false}}',
          },
        ],
        deleteIds: [],
      },
    });
  });
});
