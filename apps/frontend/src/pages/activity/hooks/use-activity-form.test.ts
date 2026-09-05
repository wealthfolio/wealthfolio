import { ACTIVITY_SUBTYPES, ActivityStatus, ActivityType } from "@/lib/constants";
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

  it("unlinks a valid grouped transfer before saving it as external", async () => {
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
    expect(mutationMocks.unlinkMutateAsync).toHaveBeenCalledWith({
      activityAId: "transfer-out-id",
      activityBId: "transfer-in-id",
    });
    expect(mutationMocks.updateMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "transfer-in-id",
        accountId: "acc-cad",
        activityType: ActivityType.TRANSFER_IN,
        metadata: { flow: { is_external: true } },
      }),
    );
    expect(mutationMocks.unlinkMutateAsync.mock.invocationCallOrder[0]).toBeLessThan(
      mutationMocks.updateMutateAsync.mock.invocationCallOrder[0],
    );
  });

  it("creates a paired EXCHANGE_OUT/EXCHANGE_IN activity sharing a source group id", async () => {
    const { result } = renderHook(() =>
      useActivityForm({
        accounts,
        selectedType: "EXCHANGE",
      }),
    );

    const formData = {
      accountId: "acc-usd",
      activityDate: new Date("2026-02-01T10:00:00.000Z"),
      toActivityDate: new Date("2026-02-03T10:00:00.000Z"),
      fromAssetId: "AAPL",
      fromExistingAssetId: null,
      fromQuantity: 2,
      fromCurrency: "USD",
      fromQuoteMode: "MARKET",
      fromExchangeMic: null,
      fromSymbolQuoteCcy: "USD",
      fromSymbolInstrumentType: "EQUITY",
      fromAssetMetadata: undefined,
      toAssetId: "GOOGL",
      toExistingAssetId: null,
      toQuantity: 1,
      toCurrency: "USD",
      toQuoteMode: "MARKET",
      toExchangeMic: null,
      toSymbolQuoteCcy: "USD",
      toSymbolInstrumentType: "EQUITY",
      toAssetMetadata: undefined,
      fee: 0,
      comment: "fund switch",
    } as ActivityFormValues;

    await act(async () => {
      await result.current.handleSubmit(formData);
    });

    expect(mutationMocks.saveMutateAsync).toHaveBeenCalledTimes(1);
    const call = mutationMocks.saveMutateAsync.mock.calls[0][0] as {
      creates: Record<string, unknown>[];
    };
    expect(call.creates).toHaveLength(2);

    const [outActivity, inActivity] = call.creates;
    expect(outActivity).toEqual(
      expect.objectContaining({
        accountId: "acc-usd",
        activityType: ActivityType.ADJUSTMENT,
        subtype: ACTIVITY_SUBTYPES.EXCHANGE_OUT,
        activityDate: new Date("2026-02-01T10:00:00.000Z"),
        quantity: 2,
        currency: "USD",
      }),
    );
    expect(inActivity).toEqual(
      expect.objectContaining({
        accountId: "acc-usd",
        activityType: ActivityType.ADJUSTMENT,
        subtype: ACTIVITY_SUBTYPES.EXCHANGE_IN,
        activityDate: new Date("2026-02-03T10:00:00.000Z"),
        quantity: 1,
        currency: "USD",
      }),
    );
    expect(outActivity.sourceGroupId).toBeTruthy();
    expect(outActivity.sourceGroupId).toBe(inActivity.sourceGroupId);
    expect(outActivity.asset).toEqual(expect.objectContaining({ symbol: "AAPL" }));
    expect(inActivity.asset).toEqual(expect.objectContaining({ symbol: "GOOGL" }));
  });

  it("falls back to account currency when EXCHANGE leg currency is empty", async () => {
    const { result } = renderHook(() =>
      useActivityForm({
        accounts,
        selectedType: "EXCHANGE",
      }),
    );

    const formData = {
      accountId: "acc-usd",
      activityDate: new Date("2026-02-01T10:00:00.000Z"),
      toActivityDate: new Date("2026-02-01T10:00:00.000Z"),
      fromAssetId: "AAPL",
      fromExistingAssetId: null,
      fromQuantity: 2,
      fromCurrency: "   ",
      fromQuoteMode: "MARKET",
      fromExchangeMic: null,
      fromSymbolQuoteCcy: null,
      fromSymbolInstrumentType: null,
      fromAssetMetadata: undefined,
      toAssetId: "GOOGL",
      toExistingAssetId: null,
      toQuantity: 1,
      toCurrency: "",
      toQuoteMode: "MARKET",
      toExchangeMic: null,
      toSymbolQuoteCcy: null,
      toSymbolInstrumentType: null,
      toAssetMetadata: undefined,
      fee: 0,
      comment: null,
    } as ActivityFormValues;

    await act(async () => {
      await result.current.handleSubmit(formData);
    });

    const call = mutationMocks.saveMutateAsync.mock.calls[0][0] as {
      creates: Record<string, unknown>[];
    };
    const [outActivity, inActivity] = call.creates;
    expect(outActivity.currency).toBe("USD");
    expect(inActivity.currency).toBe("USD");
  });

  it("updates both existing legs when editing an exchange pair", async () => {
    const { result } = renderHook(() =>
      useActivityForm({
        accounts,
        selectedType: "EXCHANGE",
        activity: {
          id: "exchange-out-id",
          activityType: ActivityType.ADJUSTMENT,
          subtype: ACTIVITY_SUBTYPES.EXCHANGE_OUT,
          exchangeOutId: "exchange-out-id",
          exchangeInId: "exchange-in-id",
        },
      }),
    );

    const formData = {
      accountId: "acc-usd",
      activityDate: new Date("2026-02-01T10:00:00.000Z"),
      toActivityDate: new Date("2026-02-04T10:00:00.000Z"),
      fromAssetId: "AAPL",
      fromExistingAssetId: null,
      fromQuantity: 3,
      fromCurrency: "USD",
      fromQuoteMode: "MARKET",
      fromExchangeMic: null,
      fromSymbolQuoteCcy: "USD",
      fromSymbolInstrumentType: "EQUITY",
      fromAssetMetadata: undefined,
      toAssetId: "GOOGL",
      toExistingAssetId: null,
      toQuantity: 2,
      toCurrency: "USD",
      toQuoteMode: "MARKET",
      toExchangeMic: null,
      toSymbolQuoteCcy: "USD",
      toSymbolInstrumentType: "EQUITY",
      toAssetMetadata: undefined,
      fee: 5,
      comment: "corrected quantity",
    } as ActivityFormValues;

    await act(async () => {
      await result.current.handleSubmit(formData);
    });

    expect(mutationMocks.saveMutateAsync).toHaveBeenCalledTimes(1);
    expect(mutationMocks.saveMutateAsync).toHaveBeenCalledWith({
      updates: [
        expect.objectContaining({
          id: "exchange-out-id",
          accountId: "acc-usd",
          activityType: ActivityType.ADJUSTMENT,
          subtype: ACTIVITY_SUBTYPES.EXCHANGE_OUT,
          activityDate: new Date("2026-02-01T10:00:00.000Z"),
          quantity: 3,
          currency: "USD",
        }),
        expect.objectContaining({
          id: "exchange-in-id",
          accountId: "acc-usd",
          activityType: ActivityType.ADJUSTMENT,
          subtype: ACTIVITY_SUBTYPES.EXCHANGE_IN,
          activityDate: new Date("2026-02-04T10:00:00.000Z"),
          quantity: 2,
          currency: "USD",
          fee: 5,
        }),
      ],
    });
  });

  it("throws when editing an exchange with a missing counterpart leg id", async () => {
    const { result } = renderHook(() =>
      useActivityForm({
        accounts,
        selectedType: "EXCHANGE",
        activity: {
          id: "exchange-out-id",
          activityType: ActivityType.ADJUSTMENT,
          subtype: ACTIVITY_SUBTYPES.EXCHANGE_OUT,
          exchangeOutId: "exchange-out-id",
          // exchangeInId intentionally missing
        },
      }),
    );

    const formData = {
      accountId: "acc-usd",
      activityDate: new Date("2026-02-01T10:00:00.000Z"),
      toActivityDate: new Date("2026-02-01T10:00:00.000Z"),
      fromAssetId: "AAPL",
      fromQuantity: 3,
      fromCurrency: "USD",
      toAssetId: "GOOGL",
      toQuantity: 2,
      toCurrency: "USD",
      fee: 0,
      comment: null,
    } as ActivityFormValues;

    await act(async () => {
      await result.current.handleSubmit(formData);
    });

    expect(mutationMocks.saveMutateAsync).not.toHaveBeenCalled();
    expect(adapterMocks.loggerError).toHaveBeenCalled();
  });
});
