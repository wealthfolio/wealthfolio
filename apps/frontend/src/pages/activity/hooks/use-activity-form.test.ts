import { ActivityStatus, ActivityType } from "@/lib/constants";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountSelectOption } from "../components/forms/fields";
import type { ActivityFormValues } from "../config/activity-form-config";
import { useActivityForm } from "./use-activity-form";

const mutationMocks = vi.hoisted(() => ({
  addMutateAsync: vi.fn(),
  updateMutateAsync: vi.fn(),
  saveMutateAsync: vi.fn(),
  savePairMutateAsync: vi.fn(),
  unlinkMutateAsync: vi.fn(),
}));

const adapterMocks = vi.hoisted(() => ({
  getTransferPairForActivity: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/adapters", () => ({
  getTransferPairForActivity: adapterMocks.getTransferPairForActivity,
  logger: {
    error: adapterMocks.loggerError,
  },
}));

vi.mock("./use-activity-mutations", () => ({
  useActivityMutations: () => ({
    addActivityMutation: {
      mutateAsync: mutationMocks.addMutateAsync,
      isPending: false,
      error: null,
      isError: false,
    },
    updateActivityMutation: {
      mutateAsync: mutationMocks.updateMutateAsync,
      isPending: false,
      error: null,
      isError: false,
    },
    saveActivitiesMutation: {
      mutateAsync: mutationMocks.saveMutateAsync,
      isPending: false,
      error: null,
      isError: false,
    },
    saveInternalTransferPairMutation: {
      mutateAsync: mutationMocks.savePairMutateAsync,
      isPending: false,
      error: null,
      isError: false,
    },
    unlinkTransferActivitiesMutation: {
      mutateAsync: mutationMocks.unlinkMutateAsync,
      isPending: false,
      error: null,
      isError: false,
    },
  }),
}));

const accounts: AccountSelectOption[] = [
  { value: "acc-usd", label: "USD Account", currency: "USD" },
  { value: "acc-cad", label: "CAD Account", currency: "CAD" },
];

describe("useActivityForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutationMocks.addMutateAsync.mockResolvedValue({});
    mutationMocks.updateMutateAsync.mockResolvedValue({});
    mutationMocks.saveMutateAsync.mockResolvedValue({});
    mutationMocks.savePairMutateAsync.mockResolvedValue({});
    mutationMocks.unlinkMutateAsync.mockResolvedValue({});
    adapterMocks.getTransferPairForActivity.mockReset();
    adapterMocks.loggerError.mockReset();
  });

  it.each([ActivityType.TRANSFER_OUT, ActivityType.TRANSFER_IN])(
    "identifies the selected %s record when saving a linked cash transfer",
    async (activityType) => {
      const selectedId = activityType === ActivityType.TRANSFER_OUT ? "pair-out" : "pair-in";
      const { result } = renderHook(() =>
        useActivityForm({
          accounts,
          selectedType: "TRANSFER",
          activity: {
            id: selectedId,
            activityType,
            sourceRecordId: "provider-record",
            transferOutId: "pair-out",
            transferInId: "pair-in",
          },
        }),
      );
      const activityDate = new Date("2026-02-01T10:00:00.000Z");
      await act(async () => {
        await result.current.handleSubmit({
          isExternal: false,
          transferMode: "cash",
          fromAccountId: "acc-usd",
          toAccountId: "acc-cad",
          sourceCurrency: "USD",
          destinationCurrency: "CAD",
          sourceAmount: 100,
          destinationAmount: 130,
          currency: "USD",
          activityDate,
          comment: null,
        } as ActivityFormValues);
      });
      expect(mutationMocks.savePairMutateAsync).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          editedActivityId: selectedId,
          transferOutId: "pair-out",
          transferInId: "pair-in",
          activityDate,
          notes: null,
          sourceAmount: 100,
          destinationAmount: 130,
        }),
      );
      expect(mutationMocks.updateMutateAsync).not.toHaveBeenCalled();
      expect(mutationMocks.saveMutateAsync).not.toHaveBeenCalled();
    },
  );

  it("preserves user-selected currency for DEPOSIT", async () => {
    const { result } = renderHook(() =>
      useActivityForm({
        accounts,
        selectedType: "DEPOSIT",
      }),
    );

    const formData = {
      accountId: "acc-usd",
      activityDate: new Date("2026-02-01T10:00:00.000Z"),
      amount: 1000,
      comment: "test",
      currency: "EUR",
      fxRate: 1.25,
    } as ActivityFormValues;

    await act(async () => {
      await result.current.handleSubmit(formData);
    });

    expect(mutationMocks.addMutateAsync).toHaveBeenCalledTimes(1);
    expect(mutationMocks.addMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc-usd",
        activityType: ActivityType.DEPOSIT,
        currency: "EUR",
      }),
    );
  });

  it("falls back to account currency when DEPOSIT currency is empty", async () => {
    const { result } = renderHook(() =>
      useActivityForm({
        accounts,
        selectedType: "DEPOSIT",
      }),
    );

    const formData = {
      accountId: "acc-usd",
      activityDate: new Date("2026-02-01T10:00:00.000Z"),
      amount: 1000,
      comment: null,
      currency: "   ",
    } as ActivityFormValues;

    await act(async () => {
      await result.current.handleSubmit(formData);
    });

    expect(mutationMocks.addMutateAsync).toHaveBeenCalledTimes(1);
    expect(mutationMocks.addMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc-usd",
        activityType: ActivityType.DEPOSIT,
        currency: "USD",
      }),
    );
  });

  it("preserves Draft review lifecycle when editing without explicit approval", async () => {
    const { result } = renderHook(() =>
      useActivityForm({
        accounts,
        selectedType: "DEPOSIT",
        activity: {
          id: "draft-deposit",
          accountId: "acc-usd",
          activityType: ActivityType.DEPOSIT,
          status: ActivityStatus.DRAFT,
          needsReview: true,
        },
      }),
    );

    await act(async () => {
      await result.current.handleSubmit({
        accountId: "acc-usd",
        activityDate: new Date("2026-02-01T10:00:00.000Z"),
        amount: 1000,
        comment: "corrected details",
        currency: "USD",
      } as ActivityFormValues);
    });

    const payload = mutationMocks.updateMutateAsync.mock.calls[0][0];
    expect(payload).not.toHaveProperty("status");
    expect(payload).not.toHaveProperty("needsReview");
  });

  it("attests every non-Draft form submission as reviewed", async () => {
    // A form save is a review: the whole form is on screen when the user
    // submits, so creates and Posted edits carry needsReview: false.
    const { result } = renderHook(() =>
      useActivityForm({
        accounts,
        selectedType: "DEPOSIT",
      }),
    );

    await act(async () => {
      await result.current.handleSubmit({
        accountId: "acc-usd",
        activityDate: new Date("2026-02-01T10:00:00.000Z"),
        amount: 1000,
        comment: null,
        currency: "USD",
      } as ActivityFormValues);
    });

    expect(mutationMocks.addMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ needsReview: false }),
    );

    const { result: editResult } = renderHook(() =>
      useActivityForm({
        accounts,
        selectedType: "DEPOSIT",
        activity: {
          id: "posted-deposit",
          accountId: "acc-usd",
          activityType: ActivityType.DEPOSIT,
          status: ActivityStatus.POSTED,
          needsReview: true,
        },
      }),
    );

    await act(async () => {
      await editResult.current.handleSubmit({
        accountId: "acc-usd",
        activityDate: new Date("2026-02-01T10:00:00.000Z"),
        amount: 1000,
        comment: "reviewed in the form",
        currency: "USD",
      } as ActivityFormValues);
    });

    expect(mutationMocks.updateMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ id: "posted-deposit", needsReview: false }),
    );
  });

  it("forwards the custom-total attestation when editing a Posted trade", async () => {
    const { result } = renderHook(() =>
      useActivityForm({
        accounts,
        selectedType: "BUY",
        activity: {
          id: "buy-posted",
          accountId: "acc-usd",
          activityType: ActivityType.BUY,
          status: ActivityStatus.POSTED,
          needsReview: false,
        },
      }),
    );

    await act(async () => {
      await result.current.handleSubmit({
        accountId: "acc-usd",
        activityDate: new Date("2026-02-01T10:00:00.000Z"),
        assetId: "AAPL",
        quantity: 2,
        unitPrice: 10,
        fee: 1,
        amount: 30,
        needsReview: false,
        currency: "USD",
      } as unknown as ActivityFormValues);
    });

    const payload = mutationMocks.updateMutateAsync.mock.calls[0][0];
    expect(payload.needsReview).toBe(false);
    expect(payload.amount).toBe(30);
  });

  it("strips the custom-total attestation when editing a Draft trade", async () => {
    const { result } = renderHook(() =>
      useActivityForm({
        accounts,
        selectedType: "BUY",
        activity: {
          id: "buy-draft",
          accountId: "acc-usd",
          activityType: ActivityType.BUY,
          status: ActivityStatus.DRAFT,
          needsReview: true,
        },
      }),
    );

    await act(async () => {
      await result.current.handleSubmit({
        accountId: "acc-usd",
        activityDate: new Date("2026-02-01T10:00:00.000Z"),
        assetId: "AAPL",
        quantity: 2,
        unitPrice: 10,
        fee: 1,
        amount: 30,
        needsReview: false,
        currency: "USD",
      } as unknown as ActivityFormValues);
    });

    const payload = mutationMocks.updateMutateAsync.mock.calls[0][0];
    expect(payload).not.toHaveProperty("needsReview");
  });

  it("preserves user-selected currency for external TRANSFER", async () => {
    const { result } = renderHook(() =>
      useActivityForm({
        accounts,
        selectedType: "TRANSFER",
      }),
    );

    const formData = {
      isExternal: true,
      direction: "in",
      accountId: "acc-usd",
      fromAccountId: "",
      toAccountId: "",
      activityDate: new Date("2026-02-01T10:00:00.000Z"),
      transferMode: "cash",
      amount: 250,
      assetId: null,
      quantity: null,
      unitPrice: null,
      comment: "external transfer",
      currency: "EUR",
      fxRate: 1.2,
      subtype: null,
      quoteMode: "MARKET",
    } as ActivityFormValues;

    await act(async () => {
      await result.current.handleSubmit(formData);
    });

    expect(mutationMocks.addMutateAsync).toHaveBeenCalledTimes(1);
    expect(mutationMocks.addMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc-usd",
        activityType: ActivityType.TRANSFER_IN,
        currency: "EUR",
      }),
    );
  });

  it("updates both existing legs when editing an internal securities transfer", async () => {
    const { result } = renderHook(() =>
      useActivityForm({
        accounts,
        selectedType: "TRANSFER",
        activity: {
          id: "transfer-out-id",
          activityType: ActivityType.TRANSFER_OUT,
          transferOutId: "transfer-out-id",
          transferInId: "transfer-in-id",
        },
      }),
    );

    const formData = {
      isExternal: false,
      direction: "out",
      accountId: "",
      fromAccountId: "acc-usd",
      toAccountId: "acc-cad",
      activityDate: new Date("2026-02-01T10:00:00.000Z"),
      transferMode: "securities",
      amount: undefined,
      sourceAmount: undefined,
      destinationAmount: undefined,
      sourceCurrency: "USD",
      destinationCurrency: "CAD",
      assetId: "AAPL",
      quantity: 10,
      unitPrice: 100,
      comment: "move shares",
      currency: "USD",
      fxRate: 1.35,
      subtype: null,
      quoteMode: "MARKET",
    } as ActivityFormValues;

    await act(async () => {
      await result.current.handleSubmit(formData);
    });

    expect(mutationMocks.saveMutateAsync).toHaveBeenCalledTimes(1);
    expect(mutationMocks.saveMutateAsync).toHaveBeenCalledWith({
      updates: [
        expect.objectContaining({
          id: "transfer-out-id",
          accountId: "acc-usd",
          activityType: ActivityType.TRANSFER_OUT,
          currency: "USD",
        }),
        expect.objectContaining({
          id: "transfer-in-id",
          accountId: "acc-cad",
          activityType: ActivityType.TRANSFER_IN,
          currency: "CAD",
          fxRate: 1.35,
        }),
      ],
    });
  });

  it("includes paired unlink intent in the reviewed external edit", async () => {
    adapterMocks.getTransferPairForActivity.mockResolvedValue({
      transferOut: { id: "transfer-out-id" },
      transferIn: { id: "transfer-in-id" },
    });

    const { result } = renderHook(() =>
      useActivityForm({
        accounts,
        selectedType: "TRANSFER",
        activity: {
          id: "transfer-in-id",
          activityType: ActivityType.TRANSFER_IN,
          accountId: "acc-cad",
          sourceGroupId: "group-1",
        },
      }),
    );

    const formData = {
      isExternal: true,
      direction: "in",
      accountId: "acc-cad",
      fromAccountId: "",
      toAccountId: "",
      activityDate: new Date("2026-02-01T10:00:00.000Z"),
      transferMode: "cash",
      amount: 250,
      assetId: null,
      quantity: null,
      unitPrice: null,
      comment: "external transfer",
      currency: "CAD",
      fxRate: null,
      subtype: null,
      quoteMode: "MARKET",
    } as ActivityFormValues;

    await act(async () => {
      await result.current.handleSubmit(formData);
    });

    expect(adapterMocks.getTransferPairForActivity).toHaveBeenCalledWith("transfer-in-id");
    expect(mutationMocks.unlinkMutateAsync).not.toHaveBeenCalled();
    expect(mutationMocks.updateMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "transfer-in-id",
        accountId: "acc-cad",
        activityType: ActivityType.TRANSFER_IN,
        metadata: { flow: { is_external: true } },
        unlinkTransferPairId: "transfer-out-id",
      }),
    );
  });

  it("skips the unlink when the grouped transfer has no resolvable pair", async () => {
    adapterMocks.getTransferPairForActivity.mockResolvedValue(null);

    const { result } = renderHook(() =>
      useActivityForm({
        accounts,
        selectedType: "TRANSFER",
        activity: {
          id: "transfer-in-id",
          activityType: ActivityType.TRANSFER_IN,
          accountId: "acc-cad",
          sourceGroupId: "orphan-group",
        },
      }),
    );

    const formData = {
      isExternal: true,
      direction: "in",
      accountId: "acc-cad",
      fromAccountId: "",
      toAccountId: "",
      activityDate: new Date("2026-02-01T10:00:00.000Z"),
      transferMode: "cash",
      amount: 250,
      assetId: null,
      quantity: null,
      unitPrice: null,
      comment: "external transfer",
      currency: "CAD",
      fxRate: null,
      subtype: null,
      quoteMode: "MARKET",
    } as ActivityFormValues;

    await act(async () => {
      await result.current.handleSubmit(formData);
    });

    expect(adapterMocks.getTransferPairForActivity).toHaveBeenCalledWith("transfer-in-id");
    expect(mutationMocks.unlinkMutateAsync).not.toHaveBeenCalled();
    expect(mutationMocks.updateMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "transfer-in-id",
        metadata: { flow: { is_external: true } },
      }),
    );
  });
});
describe("useActivityForm conversions", () => {
  const conversion = {
    accountId: "acc-usd",
    activityDate: new Date("2026-02-03T00:00:00Z"),
    fromAssetId: "FUNDA",
    fromExistingAssetId: "asset-a",
    fromQuantity: 25,
    toAssetId: "FUNDB",
    toExistingAssetId: "asset-b",
    toQuantity: 40,
    comment: "switch",
  } as unknown as ActivityFormValues;

  beforeEach(() => {
    vi.clearAllMocks();
    mutationMocks.saveMutateAsync.mockResolvedValue({ errors: [], created: [], updated: [] });
  });

  it("creates both rows of a conversion in one group", async () => {
    const { result } = renderHook(() => useActivityForm({ accounts, selectedType: "CONVERSION" }));
    await act(async () => {
      await result.current.handleSubmit(conversion);
    });

    const [request] = mutationMocks.saveMutateAsync.mock.calls[0];
    const [leaving, arriving] = request.creates;
    expect(request.updates).toBeUndefined();
    expect(leaving).toMatchObject({
      accountId: "acc-usd",
      activityType: ActivityType.ADJUSTMENT,
      subtype: "CONVERSION_OUT",
      quantity: 25,
      currency: "USD",
      comment: "switch",
    });
    expect(arriving).toMatchObject({
      activityType: ActivityType.ADJUSTMENT,
      subtype: "CONVERSION_IN",
      quantity: 40,
    });
    // Existing assets go by id alone, so the backend never re-infers them.
    expect(leaving.asset).toEqual({ id: "asset-a" });
    expect(arriving.asset).toEqual({ id: "asset-b" });
    expect(leaving.sourceGroupId).toBeTruthy();
    expect(arriving.sourceGroupId).toBe(leaving.sourceGroupId);
    expect(leaving.activityDate).toEqual(arriving.activityDate);
  });

  it.each([
    ["CONVERSION_OUT", "row-out", "row-in"],
    ["CONVERSION_IN", "row-in", "row-out"],
  ])("edits both rows from the %s row", async (subtype, ownId, otherId) => {
    const onSuccess = vi.fn();
    const { result } = renderHook(() =>
      useActivityForm({
        accounts,
        selectedType: "CONVERSION",
        onSuccess,
        activity: {
          id: ownId,
          activityType: ActivityType.ADJUSTMENT,
          subtype,
          sourceGroupId: "conv-1",
          counterpartActivityId: otherId,
        },
      }),
    );
    await act(async () => {
      await result.current.handleSubmit(conversion);
    });

    const [request] = mutationMocks.saveMutateAsync.mock.calls[0];
    expect(request.creates).toBeUndefined();
    expect(request.updates).toEqual([
      expect.objectContaining({ id: "row-out", subtype: "CONVERSION_OUT", quantity: 25 }),
      expect.objectContaining({ id: "row-in", subtype: "CONVERSION_IN", quantity: 40 }),
    ]);
    // An unchanged asset is sent by id alone: a bond's symbol would read as equity.
    expect(request.updates.map((row: { asset: unknown }) => row.asset)).toEqual([
      { id: "asset-a" },
      { id: "asset-b" },
    ]);
    expect(onSuccess).toHaveBeenCalled();
  });

  it.each([
    ["left as it opened", "2026-02-03T10:00:00Z", "2026-02-03T12:00:00Z", "2026-02-03T10:00:00Z"],
    ["edited", "2026-02-05T09:00:00Z", "2026-02-05T09:00:00Z", "2026-02-05T09:00:00Z"],
  ])("saves each row's time when the date is %s", async (_case, formDate, outTime, inTime) => {
    const { result } = renderHook(() =>
      useActivityForm({
        accounts,
        selectedType: "CONVERSION",
        activity: {
          id: "row-out",
          activityType: ActivityType.ADJUSTMENT,
          subtype: "CONVERSION_OUT",
          sourceGroupId: "conv-1",
          counterpartActivityId: "row-in",
          // The leaving row at 12:00, the arriving row at 10:00: the pair
          // folds at 10:00, the time the form opens on.
          date: new Date("2026-02-03T12:00:00Z"),
          counterpartDate: "2026-02-03T10:00:00Z",
        },
      }),
    );
    await act(async () => {
      await result.current.handleSubmit({
        ...conversion,
        activityDate: new Date(formDate),
      } as unknown as ActivityFormValues);
    });

    const [request] = mutationMocks.saveMutateAsync.mock.calls[0];
    const times = request.updates.map((row: { activityDate: Date | string }) =>
      new Date(row.activityDate).toISOString(),
    );
    expect(times).toEqual([new Date(outTime).toISOString(), new Date(inTime).toISOString()]);
  });

  it("sends a newly picked asset by its identity", async () => {
    const { result } = renderHook(() => useActivityForm({ accounts, selectedType: "CONVERSION" }));
    await act(async () => {
      await result.current.handleSubmit({
        ...conversion,
        toAssetId: "NEWB",
        toExistingAssetId: undefined,
        toExchangeMic: "XNAS",
        toSymbolQuoteCcy: "USD",
        toSymbolInstrumentType: "EQUITY",
        toQuoteMode: "MANUAL",
      } as unknown as ActivityFormValues);
    });

    const [request] = mutationMocks.saveMutateAsync.mock.calls[0];
    // A custom asset keeps the manual pricing it was created with.
    expect(request.creates[1].asset).toEqual({
      symbol: "NEWB",
      exchangeMic: "XNAS",
      quoteCcy: "USD",
      instrumentType: "EQUITY",
      quoteMode: "MANUAL",
    });
  });
});
