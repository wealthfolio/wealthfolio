import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityType } from "@/lib/constants";
import type { Activity, ActivityDetails } from "@/lib/types";
import { isInternalTransfer, withTransferPair } from "./use-activity-action-dialogs";

const adapterMocks = vi.hoisted(() => ({
  getTransferPairForActivity: vi.fn(),
}));

vi.mock("@/adapters", () => adapterMocks);
vi.mock("./use-activity-mutations", () => ({ useActivityMutations: vi.fn() }));

function leg(overrides: Partial<Activity>): Activity {
  return {
    id: "leg",
    accountId: "acc",
    activityType: ActivityType.TRANSFER_OUT,
    amount: "800",
    currency: "EUR",
    ...overrides,
  } as Activity;
}

const pair = {
  transferOut: leg({ id: "out-1", accountId: "boursobank", amount: "800" }),
  transferIn: leg({
    id: "in-1",
    accountId: "cto",
    activityType: ActivityType.TRANSFER_IN,
    amount: "800",
    fxRate: "1",
  }),
};

describe("isInternalTransfer", () => {
  it("requires a transfer type, a group, and no external flag", () => {
    const base: Partial<ActivityDetails> = {
      activityType: ActivityType.TRANSFER_OUT,
      sourceGroupId: "group-1",
    };
    expect(isInternalTransfer(base)).toBe(true);
    expect(isInternalTransfer({ ...base, sourceGroupId: undefined })).toBe(false);
    expect(isInternalTransfer({ ...base, activityType: ActivityType.DEPOSIT })).toBe(false);
    expect(isInternalTransfer({ ...base, metadata: { flow: { is_external: true } } })).toBe(false);
  });
});

describe("withTransferPair", () => {
  beforeEach(() => {
    adapterMocks.getTransferPairForActivity.mockReset();
  });

  it("attaches the incoming leg when editing the outgoing one", async () => {
    adapterMocks.getTransferPairForActivity.mockResolvedValue(pair);

    const result = await withTransferPair({
      id: "out-1",
      activityType: ActivityType.TRANSFER_OUT,
      accountId: "boursobank",
      sourceGroupId: "group-1",
    });

    expect(adapterMocks.getTransferPairForActivity).toHaveBeenCalledWith("out-1");
    expect(result).toMatchObject({
      transferOutId: "out-1",
      transferInId: "in-1",
      counterpartActivityId: "in-1",
      counterpartAccountId: "cto",
      counterpartAmount: "800",
      counterpartCurrency: "EUR",
      counterpartFxRate: "1",
    });
  });

  it("attaches the outgoing leg when editing the incoming one", async () => {
    adapterMocks.getTransferPairForActivity.mockResolvedValue(pair);

    const result = await withTransferPair({
      id: "in-1",
      activityType: ActivityType.TRANSFER_IN,
      accountId: "cto",
      sourceGroupId: "group-1",
    });

    expect(result.counterpartActivityId).toBe("out-1");
    expect(result.counterpartAccountId).toBe("boursobank");
  });

  it("returns the activity unchanged when no pair resolves", async () => {
    const activity = { id: "out-1", activityType: ActivityType.TRANSFER_OUT };

    adapterMocks.getTransferPairForActivity.mockResolvedValueOnce(null);
    await expect(withTransferPair(activity)).resolves.toBe(activity);

    adapterMocks.getTransferPairForActivity.mockRejectedValueOnce(new Error("invalid group"));
    await expect(withTransferPair(activity)).resolves.toBe(activity);
  });
});
