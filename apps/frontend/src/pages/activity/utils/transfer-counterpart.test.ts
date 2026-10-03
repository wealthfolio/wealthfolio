import { ActivityStatus, ActivityType } from "@/lib/constants";
import type { Activity, ActivityDetails } from "@/lib/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachTransferCounterpart } from "./transfer-counterpart";

const adapterMocks = vi.hoisted(() => ({
  getTransferPairForActivity: vi.fn(),
}));

vi.mock("@/adapters", () => ({
  getTransferPairForActivity: adapterMocks.getTransferPairForActivity,
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

function baseTransferOut(overrides: Partial<ActivityDetails> = {}): Partial<ActivityDetails> {
  return {
    id: "out-1",
    activityType: ActivityType.TRANSFER_OUT,
    sourceGroupId: "group-1",
    accountId: "acct-usd",
    ...overrides,
  };
}

describe("attachTransferCounterpart", () => {
  beforeEach(() => {
    adapterMocks.getTransferPairForActivity.mockReset();
  });

  it("returns the activity unchanged when it has no id", async () => {
    const activity = baseTransferOut({ id: undefined });

    await expect(attachTransferCounterpart(activity)).resolves.toBe(activity);
    expect(adapterMocks.getTransferPairForActivity).not.toHaveBeenCalled();
  });

  it("returns the activity unchanged without a source group", async () => {
    const activity = baseTransferOut({ sourceGroupId: undefined });

    await expect(attachTransferCounterpart(activity)).resolves.toBe(activity);
    expect(adapterMocks.getTransferPairForActivity).not.toHaveBeenCalled();
  });

  it("returns the activity unchanged when the transfer is external", async () => {
    const activity = baseTransferOut({ metadata: { flow: { is_external: true } } });

    await expect(attachTransferCounterpart(activity)).resolves.toBe(activity);
    expect(adapterMocks.getTransferPairForActivity).not.toHaveBeenCalled();
  });

  it("returns the activity unchanged when it is not a transfer leg", async () => {
    const activity = baseTransferOut({ activityType: ActivityType.BUY });

    await expect(attachTransferCounterpart(activity)).resolves.toBe(activity);
    expect(adapterMocks.getTransferPairForActivity).not.toHaveBeenCalled();
  });

  it("returns the activity unchanged when the pair is missing", async () => {
    adapterMocks.getTransferPairForActivity.mockResolvedValue(null);
    const activity = baseTransferOut();

    await expect(attachTransferCounterpart(activity)).resolves.toBe(activity);
  });

  it("returns the activity unchanged when the pair lookup throws", async () => {
    adapterMocks.getTransferPairForActivity.mockRejectedValue(new Error("orphan group"));
    const activity = baseTransferOut();

    await expect(attachTransferCounterpart(activity)).resolves.toBe(activity);
  });

  it("merges the transfer-in leg for an edited transfer-out", async () => {
    adapterMocks.getTransferPairForActivity.mockResolvedValue({
      transferOut: {
        id: "out-1",
        accountId: "acct-usd",
        activityType: ActivityType.TRANSFER_OUT,
        status: ActivityStatus.POSTED,
        activityDate: "2026-01-01T11:06:00.000Z",
        currency: "USD",
        amount: "1000",
      },
      transferIn: {
        id: "in-1",
        accountId: "acct-eur",
        activityType: ActivityType.TRANSFER_IN,
        status: ActivityStatus.POSTED,
        activityDate: "2026-01-01T11:06:00.000Z",
        currency: "EUR",
        amount: "920",
        fxRate: "0.92",
      },
    });

    const result = await attachTransferCounterpart(baseTransferOut());

    expect(result).toMatchObject({
      transferOutId: "out-1",
      transferInId: "in-1",
      counterpartActivityId: "in-1",
      counterpartAccountId: "acct-eur",
      counterpartAmount: "920",
      counterpartCurrency: "EUR",
      counterpartFxRate: "0.92",
    });
  });

  it("merges the transfer-out leg for an edited transfer-in", async () => {
    adapterMocks.getTransferPairForActivity.mockResolvedValue({
      transferOut: {
        id: "out-1",
        accountId: "acct-usd",
        activityType: ActivityType.TRANSFER_OUT,
        status: ActivityStatus.POSTED,
        activityDate: "2026-01-01T11:06:00.000Z",
        currency: "USD",
        amount: "1000",
      },
      transferIn: {
        id: "in-1",
        accountId: "acct-eur",
        activityType: ActivityType.TRANSFER_IN,
        status: ActivityStatus.POSTED,
        activityDate: "2026-01-01T11:06:00.000Z",
        currency: "EUR",
        amount: "920",
        fxRate: "0.92",
      },
    });

    const activity = baseTransferOut({
      id: "in-1",
      activityType: ActivityType.TRANSFER_IN,
      accountId: "acct-eur",
    });

    const result = await attachTransferCounterpart(activity);

    expect(result).toMatchObject({
      counterpartActivityId: "out-1",
      counterpartAccountId: "acct-usd",
      counterpartAmount: "1000",
      counterpartCurrency: "USD",
      // Always the pair's IN-leg rate, preserving the pre-existing merge;
      // TRANSFER.getDefaults reads it only as a fallback behind activity.fxRate.
      counterpartFxRate: "0.92",
    });
  });

  it("refuses to use the row itself as counterpart when the type contradicts the pair", async () => {
    adapterMocks.getTransferPairForActivity.mockResolvedValue({
      transferOut: {
        id: "out-1",
        accountId: "acct-usd",
        activityType: ActivityType.TRANSFER_OUT,
        status: ActivityStatus.POSTED,
        activityDate: "2026-01-01T11:06:00.000Z",
        currency: "USD",
        amount: "1000",
      },
      transferIn: {
        id: "in-1",
        accountId: "acct-eur",
        activityType: ActivityType.TRANSFER_IN,
        status: ActivityStatus.POSTED,
        activityDate: "2026-01-01T11:06:00.000Z",
        currency: "EUR",
        amount: "920",
      },
    });

    // The edited id is the OUT leg, but the payload claims TRANSFER_IN, so
    // type-based selection would return the row itself as its counterpart.
    const activity = baseTransferOut({ activityType: ActivityType.TRANSFER_IN });

    await expect(attachTransferCounterpart(activity)).resolves.toBe(activity);
  });

  it("returns the activity unchanged when neither leg matches its id", async () => {
    adapterMocks.getTransferPairForActivity.mockResolvedValue({
      transferOut: leg({ id: "other-out" }),
      transferIn: leg({ id: "other-in", activityType: ActivityType.TRANSFER_IN }),
    });
    const activity = baseTransferOut();

    await expect(attachTransferCounterpart(activity)).resolves.toBe(activity);
  });
});
