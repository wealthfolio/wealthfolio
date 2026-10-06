import { act, renderHook } from "@/test/render";
import { ActivityStatus, ActivityType } from "@/lib/constants";
import type { ActivityDetails } from "@/lib/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useActivityActionDialogs } from "./use-activity-action-dialogs";

const adapterMocks = vi.hoisted(() => ({
  getTransferPairForActivity: vi.fn(),
}));

vi.mock("@/adapters", () => ({
  getTransferPairForActivity: adapterMocks.getTransferPairForActivity,
}));

vi.mock("./use-activity-mutations", () => ({
  useActivityMutations: () => ({
    deleteActivityMutation: { mutateAsync: vi.fn(), isPending: false },
    duplicateActivityMutation: { mutateAsync: vi.fn() },
  }),
}));

function activity(overrides: Partial<ActivityDetails>): ActivityDetails {
  return { id: "out-1", accountId: "acct-usd", ...overrides } as ActivityDetails;
}

describe("useActivityActionDialogs openForm", () => {
  beforeEach(() => {
    adapterMocks.getTransferPairForActivity.mockReset();
  });

  it("opens a linked internal transfer with its counterpart", async () => {
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
    const { result } = renderHook(() => useActivityActionDialogs());

    await act(() =>
      result.current.openForm(
        activity({ activityType: ActivityType.TRANSFER_OUT, sourceGroupId: "group-1" }),
      ),
    );

    expect(adapterMocks.getTransferPairForActivity).toHaveBeenCalledWith("out-1");
    expect(result.current.formOpen).toBe(true);
    expect(result.current.selectedActivity).toMatchObject({
      id: "out-1",
      counterpartAccountId: "acct-eur",
      transferOutId: "out-1",
      transferInId: "in-1",
    });
  });

  it("opens any other activity without a pair lookup", () => {
    const deposit = activity({ activityType: ActivityType.DEPOSIT });
    const { result } = renderHook(() => useActivityActionDialogs());

    act(() => {
      void result.current.openForm(deposit);
    });

    expect(adapterMocks.getTransferPairForActivity).not.toHaveBeenCalled();
    expect(result.current.formOpen).toBe(true);
    expect(result.current.selectedActivity).toBe(deposit);
  });
});
