import { ActivityStatus, ActivityType } from "@/lib/constants";
import type { Activity } from "@/lib/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CashActivity } from "@/features/spending/types/cash-activity";
import type { TransactionRowVM } from "./transactions-helpers";
import { resolveTransferFormActivity } from "./transfer-edit";

const adapterMocks = vi.hoisted(() => ({
  getTransferPairForActivity: vi.fn(),
  createActivity: vi.fn(),
  deleteActivity: vi.fn(),
  updateActivity: vi.fn(),
}));

vi.mock("@/adapters", () => ({
  getTransferPairForActivity: adapterMocks.getTransferPairForActivity,
  createActivity: adapterMocks.createActivity,
  deleteActivity: adapterMocks.deleteActivity,
  updateActivity: adapterMocks.updateActivity,
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

function leg(overrides: Partial<Activity> = {}): Activity {
  return {
    id: "leg",
    accountId: "acct",
    activityType: ActivityType.TRANSFER_OUT,
    status: ActivityStatus.POSTED,
    activityDate: "2026-01-01T11:06:00.000Z",
    currency: "USD",
    isUserModified: false,
    needsReview: false,
    createdAt: "2026-01-01T11:06:00.000Z",
    updatedAt: "2026-01-01T11:06:00.000Z",
    ...overrides,
  };
}

function moneyExchangeRow(): TransactionRowVM {
  const activity: CashActivity = {
    ...leg({
      id: "out-1",
      accountId: "acct-usd",
      amount: "1000",
      sourceGroupId: "group-1",
      metadata: { flow: { is_external: false } },
    }),
    cashFlowBucket: "neutral",
    assignments: [],
    splits: [],
    netAmount: -1000,
  };
  return { activity, category: null, splitCount: 0, needsReview: false };
}

describe("resolveTransferFormActivity", () => {
  beforeEach(() => {
    adapterMocks.getTransferPairForActivity.mockReset();
  });

  it("loads the counterpart leg for a linked internal transfer", async () => {
    adapterMocks.getTransferPairForActivity.mockResolvedValue({
      transferOut: leg({ id: "out-1", accountId: "acct-usd", amount: "1000" }),
      transferIn: leg({
        id: "in-1",
        accountId: "acct-eur",
        activityType: ActivityType.TRANSFER_IN,
        currency: "EUR",
        amount: "920",
        fxRate: "0.92",
      }),
    });

    const result = await resolveTransferFormActivity(moneyExchangeRow());

    expect(adapterMocks.getTransferPairForActivity).toHaveBeenCalledWith("out-1");
    expect(result).toMatchObject({
      activityType: ActivityType.TRANSFER_OUT,
      sourceGroupId: "group-1",
      transferOutId: "out-1",
      transferInId: "in-1",
      counterpartActivityId: "in-1",
      counterpartAccountId: "acct-eur",
      counterpartAmount: "920",
      counterpartCurrency: "EUR",
      counterpartFxRate: "0.92",
    });
  });

  it("leaves an unpaired transfer single-leg", async () => {
    adapterMocks.getTransferPairForActivity.mockResolvedValue(null);

    const result = await resolveTransferFormActivity(moneyExchangeRow());

    expect(result.sourceGroupId).toBe("group-1");
    expect(result.counterpartAccountId).toBeUndefined();
    expect(result.transferOutId).toBeUndefined();
  });
});
