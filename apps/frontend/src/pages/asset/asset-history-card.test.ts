// @vitest-environment node

import { ActivityDetails, ActivityType } from "@/lib/types";
import { describe, expect, it } from "vitest";
import {
  activityMarkerLabel,
  activityMarkerTone,
  activityMarkerVariant,
  isAssetMarkerActivity,
} from "./asset-history-markers";

const createActivity = (
  activityType: ActivityType,
  overrides: Partial<ActivityDetails> = {},
): ActivityDetails =>
  ({
    id: "activity-1",
    activityType,
    date: new Date("2026-02-12T00:00:00Z"),
    quantity: "1",
    unitPrice: "56702.20",
    amount: null,
    fee: null,
    currency: "USD",
    needsReview: false,
    createdAt: new Date("2026-02-12T00:00:00Z"),
    updatedAt: new Date("2026-02-12T00:00:00Z"),
    accountId: "account-1",
    accountName: "Account",
    accountCurrency: "USD",
    assetId: "BTC-USD",
    assetSymbol: "BTC",
    ...overrides,
  }) as ActivityDetails;

describe("asset history marker helpers", () => {
  it("includes securities transfers for the selected asset", () => {
    const activity = createActivity(ActivityType.TRANSFER_IN);

    expect(isAssetMarkerActivity(activity, "BTC-USD")).toBe(true);
    expect(activityMarkerVariant(activity.activityType)).toBe("activity");
    expect(activityMarkerLabel(activity.activityType)).toBe("T");
    expect(activityMarkerTone(activity.activityType)).toBe("success");
  });

  it("includes trades with trade-specific marker variants", () => {
    expect(isAssetMarkerActivity(createActivity(ActivityType.BUY), "BTC-USD")).toBe(true);
    expect(activityMarkerVariant(ActivityType.BUY)).toBe("buy");
    expect(activityMarkerVariant(ActivityType.SELL)).toBe("sell");
    expect(activityMarkerLabel(ActivityType.BUY)).toBe("B");
    expect(activityMarkerLabel(ActivityType.SELL)).toBe("S");
    expect(activityMarkerTone(ActivityType.BUY)).toBe("success");
    expect(activityMarkerTone(ActivityType.SELL)).toBe("destructive");
  });

  it("includes splits with a split-specific marker variant", () => {
    const activity = createActivity(ActivityType.SPLIT);

    expect(isAssetMarkerActivity(activity, "BTC-USD")).toBe(true);
    expect(activityMarkerVariant(activity.activityType)).toBe("split");
    expect(activityMarkerLabel(activity.activityType)).toBe("SP");
    expect(activityMarkerTone(activity.activityType)).toBe("warning");
  });

  it("includes asset-backed income and neutral marker variants", () => {
    const activity = createActivity(ActivityType.DIVIDEND);

    expect(isAssetMarkerActivity(activity, "BTC-USD")).toBe(true);
    expect(activityMarkerVariant(activity.activityType)).toBe("activity");
    expect(activityMarkerLabel(activity.activityType)).toBe("D");
    expect(activityMarkerTone(activity.activityType)).toBe("info");
  });

  it("uses badge tones for other relevant asset activity types", () => {
    expect(activityMarkerLabel(ActivityType.ADJUSTMENT)).toBe("AD");
    expect(activityMarkerTone(ActivityType.ADJUSTMENT)).toBe("secondary");
    expect(activityMarkerLabel(ActivityType.TRANSFER_OUT)).toBe("T");
    expect(activityMarkerTone(ActivityType.TRANSFER_OUT)).toBe("destructive");
  });

  it("rejects unrelated and cash-only activities", () => {
    expect(isAssetMarkerActivity(createActivity(ActivityType.DEPOSIT), "BTC-USD")).toBe(false);
    expect(
      isAssetMarkerActivity(
        createActivity(ActivityType.TRANSFER_IN, {
          assetId: "CASH:USD",
          assetSymbol: "CASH:USD",
        }),
        "BTC-USD",
      ),
    ).toBe(false);
  });
});
