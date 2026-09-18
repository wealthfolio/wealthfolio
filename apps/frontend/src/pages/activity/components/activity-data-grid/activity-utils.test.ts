import { ACTIVITY_SUBTYPES, ActivityStatus, ActivityType } from "@/lib/constants";
import type { Account } from "@/lib/types";
import { describe, expect, it } from "vitest";
import {
  applyTransactionUpdate,
  buildSavePayload,
  createCurrencyResolver,
  createDraftTransaction,
  hasFinalCashAmountForApproval,
  partitionReviewRowsForApproval,
  resolveAssetIdForTransaction,
  TRACKED_FIELDS,
  validateTransactionsForSave,
  valuesAreEqual,
} from "./activity-utils";
import type { LocalTransaction } from "./types";

// Helper to create mock account
const createMockAccount = (overrides: Partial<Account> = {}): Account => ({
  id: "account-1",
  name: "Test Account",
  accountType: "SECURITIES",
  balance: 10000,
  currency: "USD",
  isDefault: true,
  isActive: true,
  isArchived: false,
  trackingMode: "TRANSACTIONS",
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

// Helper to create mock transaction
const createMockTransaction = (overrides: Partial<LocalTransaction> = {}): LocalTransaction => ({
  id: "tx-1",
  activityType: ActivityType.BUY,
  date: new Date("2024-01-15T10:00:00Z"),
  quantity: "10",
  unitPrice: "100",
  amount: "1000",
  fee: "5",
  currency: "USD",
  needsReview: false,
  comment: "",
  createdAt: new Date(),
  assetId: "AAPL",
  updatedAt: new Date(),
  accountId: "account-1",
  accountName: "Test Account",
  accountCurrency: "USD",
  assetSymbol: "AAPL",
  assetName: "Apple Inc.",
  ...overrides,
});

describe("activity-utils", () => {
  it("clears the old rate when the transaction currency changes", () => {
    const updated = applyTransactionUpdate({
      transaction: createMockTransaction({ currency: "EUR", fxRate: "1.2" }),
      field: "currency",
      value: "GBP",
      accountLookup: new Map(),
      assetCurrencyLookup: new Map(),
      resolveTransactionCurrency: createCurrencyResolver(new Map(), "USD"),
      fallbackCurrency: "USD",
    });
    expect(updated.currency).toBe("GBP");
    expect(updated.fxRate).toBeNull();
  });

  it.each(["USD", "CAD"])("serializes an invalidated FX rate for %s accounts", (currency) => {
    const resolver = createCurrencyResolver(new Map(), "USD");
    const updated = applyTransactionUpdate({
      transaction: createMockTransaction({ currency: "EUR", fxRate: "1.2" }),
      field: "accountId",
      value: "account-2",
      accountLookup: new Map([["account-2", createMockAccount({ id: "account-2", currency })]]),
      assetCurrencyLookup: new Map(),
      resolveTransactionCurrency: resolver,
      fallbackCurrency: "USD",
    });
    const payload = buildSavePayload(
      [updated],
      new Set([updated.id]),
      new Set(),
      resolver,
      new Map(),
      new Map(),
      "USD",
    );
    expect(JSON.parse(JSON.stringify(payload.updates[0]))).toMatchObject({
      currency: "EUR",
      fxRate: currency === "USD" ? "1.2" : null,
    });
  });
  it.each([true, false])("handles account changes for a row with isNew=%s", (isNew) => {
    const updated = applyTransactionUpdate({
      transaction: createMockTransaction({
        activityType: ActivityType.FEE,
        currency: "EUR",
        amount: "5",
        isNew,
      }),
      field: "accountId",
      value: "account-2",
      accountLookup: new Map([
        ["account-2", createMockAccount({ id: "account-2", name: "Other USD account" })],
      ]),
      assetCurrencyLookup: new Map(),
      resolveTransactionCurrency: createCurrencyResolver(new Map(), "USD"),
      fallbackCurrency: "USD",
    });
    expect(updated.accountId).toBe("account-2");
    expect(updated.accountCurrency).toBe("USD");
    expect(updated.amount).toBe("5");
    expect(updated.currency).toBe(isNew ? "USD" : "EUR");
  });
  describe("valuesAreEqual", () => {
    describe("numeric fields", () => {
      it("should compare numbers correctly", () => {
        expect(valuesAreEqual("quantity", 10, 10)).toBe(true);
        expect(valuesAreEqual("quantity", 10, 20)).toBe(false);
      });

      it("should handle string to number comparison", () => {
        expect(valuesAreEqual("quantity", "10", 10)).toBe(true);
        expect(valuesAreEqual("unitPrice", 100.5, "100.5")).toBe(true);
      });

      it("should treat undefined/null as distinct from 0", () => {
        expect(valuesAreEqual("quantity", undefined, 0)).toBe(false);
        expect(valuesAreEqual("fee", null, 0)).toBe(false);
      });

      it("should handle NaN cases", () => {
        expect(valuesAreEqual("amount", NaN, NaN)).toBe(true);
        expect(valuesAreEqual("amount", NaN, 0)).toBe(false);
      });
    });

    describe("non-numeric fields", () => {
      it("should use Object.is for comparison", () => {
        expect(valuesAreEqual("activityType", "BUY", "BUY")).toBe(true);
        expect(valuesAreEqual("activityType", "BUY", "SELL")).toBe(false);
      });

      it("should handle undefined correctly", () => {
        expect(valuesAreEqual("comment", undefined, undefined)).toBe(true);
        expect(valuesAreEqual("comment", "", undefined)).toBe(false);
      });
    });
  });

  describe("resolveAssetIdForTransaction", () => {
    it("should return existing assetId if present", () => {
      const tx = createMockTransaction({ assetId: "AAPL", assetSymbol: "AAPL" });
      expect(resolveAssetIdForTransaction(tx, "USD")).toBe("AAPL");
    });

    it("should return assetSymbol if assetId is empty", () => {
      const tx = createMockTransaction({ assetId: "", assetSymbol: "MSFT" });
      expect(resolveAssetIdForTransaction(tx, "USD")).toBe("MSFT");
    });

    it("should return undefined for cash activities (backend generates ID)", () => {
      const tx = createMockTransaction({
        activityType: ActivityType.DEPOSIT,
        assetId: "",
        assetSymbol: "",
        currency: "EUR",
      });
      // Backend now generates CASH:{currency} IDs, frontend returns undefined
      expect(resolveAssetIdForTransaction(tx, "USD")).toBeUndefined();
    });

    it("should return undefined for cash activities without currency (backend generates ID)", () => {
      const tx = createMockTransaction({
        activityType: ActivityType.WITHDRAWAL,
        assetId: "",
        assetSymbol: "",
        currency: "",
        accountCurrency: "",
      });
      // Backend now generates CASH:{currency} IDs, frontend returns undefined
      expect(resolveAssetIdForTransaction(tx, "GBP")).toBeUndefined();
    });

    it("should return assetId for staking reward interest", () => {
      const tx = createMockTransaction({
        activityType: ActivityType.INTEREST,
        subtype: ACTIVITY_SUBTYPES.STAKING_REWARD,
        assetId: "ETH",
        assetSymbol: "ETH",
      });
      expect(resolveAssetIdForTransaction(tx, "USD")).toBe("ETH");
    });

    it("should return undefined for non-cash activities without asset", () => {
      const tx = createMockTransaction({
        activityType: ActivityType.BUY,
        assetId: "",
        assetSymbol: "",
      });
      expect(resolveAssetIdForTransaction(tx, "USD")).toBeUndefined();
    });

    it("should keep transfer activity asset identifiers when symbol is set", () => {
      const tx = createMockTransaction({
        activityType: ActivityType.TRANSFER_IN,
        assetId: "",
        assetSymbol: "AAPL",
      });
      expect(resolveAssetIdForTransaction(tx, "USD")).toBe("AAPL");
    });
  });

  describe("createDraftTransaction", () => {
    it("should create a transaction with temp ID", () => {
      const accounts = [createMockAccount()];
      const draft = createDraftTransaction(accounts, "USD");

      expect(draft.id).toMatch(/^temp-/);
      expect(draft.isNew).toBe(true);
      // needsReview should be false - it's reserved for sync service activities needing review
      expect(draft.needsReview).toBe(false);
    });

    it("should use default account values", () => {
      const accounts = [
        createMockAccount({ id: "acc-1", name: "Account 1", currency: "EUR", isActive: true }),
      ];
      const draft = createDraftTransaction(accounts, "USD");

      expect(draft.accountId).toBe("acc-1");
      expect(draft.accountName).toBe("Account 1");
      expect(draft.currency).toBe("EUR");
    });

    it("should use first active account", () => {
      const accounts = [
        createMockAccount({ id: "acc-1", isActive: false }),
        createMockAccount({ id: "acc-2", isActive: true }),
      ];
      const draft = createDraftTransaction(accounts, "USD");

      expect(draft.accountId).toBe("acc-2");
    });

    it("should use fallback currency when no accounts", () => {
      const draft = createDraftTransaction([], "GBP");

      expect(draft.currency).toBe("GBP");
      expect(draft.accountCurrency).toBe("GBP");
    });

    it("should set default activity type to BUY", () => {
      const accounts = [createMockAccount()];
      const draft = createDraftTransaction(accounts, "USD");

      expect(draft.activityType).toBe(ActivityType.BUY);
    });

    it("should initialize numeric values to null", () => {
      const accounts = [createMockAccount()];
      const draft = createDraftTransaction(accounts, "USD");

      expect(draft.quantity).toBeNull();
      expect(draft.unitPrice).toBeNull();
      expect(draft.amount).toBeNull();
      expect(draft.fee).toBeNull();
    });
  });

  describe("createCurrencyResolver", () => {
    const assetCurrencyLookup = new Map([
      ["AAPL", "USD"],
      ["VOD.L", "GBP"],
      ["CASH:EUR", "EUR"],
    ]);

    it("should return transaction currency if set", () => {
      const resolver = createCurrencyResolver(assetCurrencyLookup, "USD");
      const tx = createMockTransaction({ currency: "CHF" });

      expect(resolver(tx)).toBe("CHF");
    });

    it("should resolve currency from asset lookup when transaction currency is empty", () => {
      const resolver = createCurrencyResolver(assetCurrencyLookup, "USD");
      // Must also set accountCurrency to empty to test asset lookup
      const tx = createMockTransaction({
        currency: "",
        assetSymbol: "VOD.L",
        assetId: "VOD.L",
        accountCurrency: "",
      });

      expect(resolver(tx)).toBe("GBP");
    });

    it("should extract currency from cash asset symbol", () => {
      const resolver = createCurrencyResolver(assetCurrencyLookup, "USD");
      const tx = createMockTransaction({
        currency: "",
        assetId: "CASH:EUR",
        assetSymbol: "CASH:EUR",
        accountCurrency: "",
      });

      expect(resolver(tx)).toBe("EUR");
    });

    it("should extract currency from CASH:{currency} asset id", () => {
      const resolver = createCurrencyResolver(assetCurrencyLookup, "USD");
      const tx = createMockTransaction({
        currency: "",
        assetId: "CASH:USD",
        assetSymbol: "CASH:USD",
        accountCurrency: "",
      });

      expect(resolver(tx)).toBe("USD");
    });

    it("should not treat CASH:XTSE as a cash currency", () => {
      const resolver = createCurrencyResolver(assetCurrencyLookup, "USD");
      const tx = createMockTransaction({
        currency: "",
        assetId: "CASH:XTSE",
        assetSymbol: "CASH:XTSE",
        accountCurrency: "CAD",
      });

      expect(resolver(tx, { includeFallback: true })).toBe("CAD");
    });

    it("should use account currency as fallback", () => {
      const resolver = createCurrencyResolver(assetCurrencyLookup, "JPY");
      const tx = createMockTransaction({
        currency: "",
        assetId: "UNKNOWN",
        assetSymbol: "UNKNOWN",
        accountCurrency: "CAD",
      });

      expect(resolver(tx, { includeFallback: true })).toBe("CAD");
    });

    it("should use fallback currency when no other currency found", () => {
      const resolver = createCurrencyResolver(assetCurrencyLookup, "JPY");
      const tx = createMockTransaction({
        currency: "",
        assetId: "UNKNOWN",
        assetSymbol: "UNKNOWN",
        accountCurrency: "",
      });

      expect(resolver(tx, { includeFallback: true })).toBe("JPY");
    });

    it("should return undefined when includeFallback is false and no currency found", () => {
      const resolver = createCurrencyResolver(assetCurrencyLookup, "JPY");
      const tx = createMockTransaction({
        currency: "",
        assetSymbol: "UNKNOWN",
        assetId: "UNKNOWN",
        accountCurrency: "",
      });

      expect(resolver(tx, { includeFallback: false })).toBeUndefined();
    });
  });

  describe("buildSavePayload", () => {
    const mockResolveTransactionCurrency = () => "USD";
    const dirtyCurrencyLookup = new Map<string, string>();
    const assetCurrencyLookup = new Map<string, string>();

    it("should separate new and existing transactions", () => {
      const transactions: LocalTransaction[] = [
        createMockTransaction({ id: "existing-1", isNew: false }),
        createMockTransaction({ id: "temp-new-1", isNew: true }),
      ];
      const dirtyIds = new Set(["existing-1", "temp-new-1"]);
      const pendingDeleteIds = new Set<string>();

      const result = buildSavePayload(
        transactions,
        dirtyIds,
        pendingDeleteIds,
        mockResolveTransactionCurrency,
        dirtyCurrencyLookup,
        assetCurrencyLookup,
        "USD",
      );

      expect(result.creates).toHaveLength(1);
      expect(result.updates).toHaveLength(1);
      expect(result.creates[0].id).toBe("temp-new-1");
      expect(result.updates[0].id).toBe("existing-1");
    });

    it("should persist an explicit review approval on an existing transaction", () => {
      const result = buildSavePayload(
        [createMockTransaction({ id: "review-1", isNew: false, needsReview: false })],
        new Set(["review-1"]),
        new Set(),
        mockResolveTransactionCurrency,
        dirtyCurrencyLookup,
        assetCurrencyLookup,
        "USD",
      );

      expect(result.updates).toHaveLength(1);
      expect(result.updates[0].needsReview).toBe(false);
    });

    it("omits the amount for an untouched existing trade and sends it once edited", () => {
      const result = buildSavePayload(
        [
          createMockTransaction({ id: "untouched", isNew: false, _amountEdited: false }),
          createMockTransaction({ id: "edited", isNew: false, _amountEdited: true }),
        ],
        new Set(["untouched", "edited"]),
        new Set(),
        mockResolveTransactionCurrency,
        dirtyCurrencyLookup,
        assetCurrencyLookup,
        "USD",
      );

      const byId = new Map(result.updates.map((update) => [update.id, update]));
      expect(byId.get("untouched")?.amount).toBeUndefined();
      expect(byId.get("edited")?.amount).toBe("1000");
    });

    it("applies the same amount-ownership rule to new trades", () => {
      const result = buildSavePayload(
        [
          createMockTransaction({ id: "temp-auto", isNew: true, _amountEdited: false }),
          createMockTransaction({ id: "temp-typed", isNew: true, _amountEdited: true }),
        ],
        new Set(["temp-auto", "temp-typed"]),
        new Set(),
        mockResolveTransactionCurrency,
        dirtyCurrencyLookup,
        assetCurrencyLookup,
        "USD",
      );

      const byId = new Map(result.creates.map((create) => [create.id, create]));
      expect(byId.get("temp-auto")?.amount).toBeUndefined();
      expect(byId.get("temp-typed")?.amount).toBe("1000");
    });

    it("always sends the amount for asset-backed income composites", () => {
      const result = buildSavePayload(
        [
          createMockTransaction({
            id: "drip-1",
            isNew: false,
            activityType: ActivityType.DIVIDEND,
            subtype: ACTIVITY_SUBTYPES.DRIP,
            _amountEdited: false,
          }),
        ],
        new Set(["drip-1"]),
        new Set(),
        mockResolveTransactionCurrency,
        dirtyCurrencyLookup,
        assetCurrencyLookup,
        "USD",
      );

      expect(result.updates[0].amount).toBe("1000");
    });

    it("omits needsReview when it matches the server value", () => {
      const result = buildSavePayload(
        [
          createMockTransaction({
            id: "unchanged-review",
            isNew: false,
            needsReview: false,
            _originalNeedsReview: false,
          }),
        ],
        new Set(["unchanged-review"]),
        new Set(),
        mockResolveTransactionCurrency,
        dirtyCurrencyLookup,
        assetCurrencyLookup,
        "USD",
      );

      expect(result.updates[0].needsReview).toBeUndefined();
    });

    it("attests a trade total the user typed this session", () => {
      const result = buildSavePayload(
        [
          createMockTransaction({
            id: "typed-total",
            isNew: false,
            status: ActivityStatus.POSTED,
            needsReview: false,
            _originalNeedsReview: false,
            _amountEdited: true,
          }),
        ],
        new Set(["typed-total"]),
        new Set(),
        mockResolveTransactionCurrency,
        dirtyCurrencyLookup,
        assetCurrencyLookup,
        "USD",
      );

      expect(result.updates[0].needsReview).toBe(false);
    });

    it("attests a typed trade total on a new row", () => {
      const result = buildSavePayload(
        [
          createMockTransaction({
            id: "temp-typed-review",
            isNew: true,
            _amountEdited: true,
          }),
        ],
        new Set(["temp-typed-review"]),
        new Set(),
        mockResolveTransactionCurrency,
        dirtyCurrencyLookup,
        assetCurrencyLookup,
        "USD",
      );

      expect(result.creates[0].needsReview).toBe(false);
    });

    it("does not attest a typed total on a Draft — it stays in its queue", () => {
      const result = buildSavePayload(
        [
          createMockTransaction({
            id: "draft-typed",
            isNew: false,
            status: ActivityStatus.DRAFT,
            needsReview: true,
            _originalNeedsReview: true,
            _amountEdited: true,
          }),
        ],
        new Set(["draft-typed"]),
        new Set(),
        mockResolveTransactionCurrency,
        dirtyCurrencyLookup,
        assetCurrencyLookup,
        "USD",
      );

      expect(result.updates[0].needsReview).toBeUndefined();
    });

    it("does not attest a non-trade amount edit", () => {
      const result = buildSavePayload(
        [
          createMockTransaction({
            id: "deposit-typed",
            isNew: false,
            activityType: ActivityType.DEPOSIT,
            status: ActivityStatus.POSTED,
            needsReview: true,
            _originalNeedsReview: true,
            _amountEdited: true,
          }),
        ],
        new Set(["deposit-typed"]),
        new Set(),
        mockResolveTransactionCurrency,
        dirtyCurrencyLookup,
        assetCurrencyLookup,
        "USD",
      );

      expect(result.updates[0].needsReview).toBeUndefined();
    });

    it("should include exchangeMic and quoteCcy hints for new market activities", () => {
      const transactions: LocalTransaction[] = [
        createMockTransaction({
          id: "temp-new-1",
          isNew: true,
          assetId: "",
          assetSymbol: "VWRPL.XC",
          exchangeMic: "XLON",
          pendingQuoteCcy: "GBP",
          pendingInstrumentType: "EQUITY",
        }),
      ];
      const dirtyIds = new Set(["temp-new-1"]);

      const result = buildSavePayload(
        transactions,
        dirtyIds,
        new Set(),
        mockResolveTransactionCurrency,
        dirtyCurrencyLookup,
        assetCurrencyLookup,
        "USD",
      );

      expect(result.creates).toHaveLength(1);
      expect(result.creates[0].asset).toEqual(
        expect.objectContaining({
          symbol: "VWRPL.XC",
          exchangeMic: "XLON",
          quoteCcy: "GBP",
          instrumentType: "EQUITY",
        }),
      );
    });

    it("should save staking rewards as asset-backed income", () => {
      const transactions: LocalTransaction[] = [
        createMockTransaction({
          id: "temp-staking-1",
          isNew: true,
          activityType: ActivityType.INTEREST,
          subtype: ACTIVITY_SUBTYPES.STAKING_REWARD,
          assetId: "",
          assetSymbol: "ETH",
          quantity: "0.25",
          unitPrice: "4000",
          amount: "1000",
          pendingQuoteCcy: "USD",
          pendingInstrumentType: "CRYPTO",
        }),
      ];
      const dirtyIds = new Set(["temp-staking-1"]);

      const result = buildSavePayload(
        transactions,
        dirtyIds,
        new Set(),
        mockResolveTransactionCurrency,
        dirtyCurrencyLookup,
        assetCurrencyLookup,
        "USD",
      );

      expect(result.creates).toHaveLength(1);
      expect(result.creates[0]).toEqual(
        expect.objectContaining({
          activityType: ActivityType.INTEREST,
          subtype: ACTIVITY_SUBTYPES.STAKING_REWARD,
          quantity: "0.25",
          unitPrice: "4000",
          amount: "1000",
        }),
      );
      expect(result.creates[0].asset).toEqual(
        expect.objectContaining({
          symbol: "ETH",
          quoteCcy: "USD",
          instrumentType: "CRYPTO",
        }),
      );
    });

    it("should send an empty subtype marker when clearing subtype on an existing row", () => {
      const transactions: LocalTransaction[] = [
        createMockTransaction({
          id: "existing-interest-1",
          isNew: false,
          activityType: ActivityType.INTEREST,
          subtype: undefined,
          amount: "25",
        }),
      ];
      const dirtyIds = new Set(["existing-interest-1"]);

      const result = buildSavePayload(
        transactions,
        dirtyIds,
        new Set(),
        mockResolveTransactionCurrency,
        dirtyCurrencyLookup,
        assetCurrencyLookup,
        "USD",
      );

      expect(result.updates).toHaveLength(1);
      expect(result.updates[0].subtype).toBe("");
    });

    it("should preserve explicit idempotency keys for new manual duplicates", () => {
      const transactions: LocalTransaction[] = [
        createMockTransaction({
          id: "temp-new-1",
          isNew: true,
          idempotencyKey: "manual-duplicate-123",
        }),
      ];
      const dirtyIds = new Set(["temp-new-1"]);

      const result = buildSavePayload(
        transactions,
        dirtyIds,
        new Set(),
        mockResolveTransactionCurrency,
        dirtyCurrencyLookup,
        assetCurrencyLookup,
        "USD",
      );

      expect(result.creates).toHaveLength(1);
      expect(result.creates[0].idempotencyKey).toBe("manual-duplicate-123");
    });

    it.each([true, false])(
      "should preserve only an explicit %s credit boundary for a new duplicate",
      (isExternal) => {
        const transactions: LocalTransaction[] = [
          createMockTransaction({
            id: "temp-credit-1",
            isNew: true,
            activityType: ActivityType.CREDIT,
            subtype: ACTIVITY_SUBTYPES.REIMBURSEMENT,
            assetId: undefined,
            assetSymbol: undefined,
            amount: "100",
            isExternal,
            metadata: {
              raw_type: "merchant_refund",
              flow: { confidence: 0.9, is_external: isExternal },
            },
          }),
        ];

        const result = buildSavePayload(
          transactions,
          new Set(["temp-credit-1"]),
          new Set(),
          mockResolveTransactionCurrency,
          dirtyCurrencyLookup,
          assetCurrencyLookup,
          "USD",
        );

        expect(JSON.parse(result.creates[0].metadata ?? "{}")).toEqual({
          flow: { is_external: isExternal },
        });
      },
    );

    it("should leave credit metadata absent when no boundary was specified", () => {
      const transactions: LocalTransaction[] = [
        createMockTransaction({
          id: "temp-credit-1",
          isNew: true,
          activityType: ActivityType.CREDIT,
          subtype: ACTIVITY_SUBTYPES.REFUND,
          assetId: undefined,
          assetSymbol: undefined,
          amount: "100",
          isExternal: undefined,
        }),
      ];

      const result = buildSavePayload(
        transactions,
        new Set(["temp-credit-1"]),
        new Set(),
        mockResolveTransactionCurrency,
        dirtyCurrencyLookup,
        assetCurrencyLookup,
        "USD",
      );

      expect(result.creates[0].metadata).toBeUndefined();
    });

    it("should include existing asset id selected from search for new market activities", () => {
      const transactions: LocalTransaction[] = [
        createMockTransaction({
          id: "temp-new-1",
          isNew: true,
          assetId: "",
          assetSymbol: "AAPL",
          exchangeMic: "XNAS",
          pendingAssetId: "SEC:AAPL:XNAS",
          pendingQuoteCcy: "USD",
          pendingInstrumentType: "EQUITY",
        }),
      ];
      const dirtyIds = new Set(["temp-new-1"]);

      const result = buildSavePayload(
        transactions,
        dirtyIds,
        new Set(),
        mockResolveTransactionCurrency,
        dirtyCurrencyLookup,
        assetCurrencyLookup,
        "USD",
      );

      expect(result.creates).toHaveLength(1);
      expect(result.creates[0].asset).toEqual(
        expect.objectContaining({
          id: "SEC:AAPL:XNAS",
          symbol: "AAPL",
          exchangeMic: "XNAS",
          quoteCcy: "USD",
          instrumentType: "EQUITY",
        }),
      );
    });

    it("should send asset identity when same symbol changes exchange", () => {
      const transactions: LocalTransaction[] = [
        createMockTransaction({
          id: "existing-1",
          isNew: false,
          assetSymbol: "FBTC",
          exchangeMic: "XTSE",
          _originalAssetSymbol: "FBTC",
          _originalExchangeMic: "NEOE",
          _originalAssetId: "SEC:FBTC:NEOE",
          pendingAssetId: "SEC:FBTC:XTSE",
          pendingQuoteCcy: "CAD",
          pendingInstrumentType: "ETF",
        }),
      ];
      const dirtyIds = new Set(["existing-1"]);

      const result = buildSavePayload(
        transactions,
        dirtyIds,
        new Set(),
        mockResolveTransactionCurrency,
        dirtyCurrencyLookup,
        assetCurrencyLookup,
        "USD",
      );

      expect(result.updates).toHaveLength(1);
      expect(result.updates[0].asset).toEqual(
        expect.objectContaining({
          id: "SEC:FBTC:XTSE",
          symbol: "FBTC",
          exchangeMic: "XTSE",
          quoteCcy: "CAD",
          instrumentType: "ETF",
        }),
      );
    });

    it("should include quoteCcy hint for existing assets when symbol is unchanged", () => {
      const transactions: LocalTransaction[] = [
        createMockTransaction({
          id: "existing-1",
          isNew: false,
          assetSymbol: "VWRPL.XC",
          _originalAssetSymbol: "VWRPL.XC",
          _originalAssetId: "asset-1",
          pendingQuoteCcy: "GBP",
          pendingInstrumentType: "EQUITY",
        }),
      ];
      const dirtyIds = new Set(["existing-1"]);

      const result = buildSavePayload(
        transactions,
        dirtyIds,
        new Set(),
        mockResolveTransactionCurrency,
        dirtyCurrencyLookup,
        assetCurrencyLookup,
        "USD",
      );

      expect(result.updates).toHaveLength(1);
      expect(result.updates[0].asset).toEqual(
        expect.objectContaining({
          id: "asset-1",
          quoteCcy: "GBP",
          instrumentType: "EQUITY",
        }),
      );
    });

    it("should normalize optional symbol fields and avoid empty string payload values", () => {
      const transactions: LocalTransaction[] = [
        createMockTransaction({
          id: "temp-new-1",
          isNew: true,
          assetId: "",
          assetSymbol: "VWRPL.XC",
          exchangeMic: " XLON ",
          pendingAssetKind: " ",
          pendingAssetName: "",
          pendingQuoteCcy: " GBP ",
          pendingInstrumentType: " EQUITY ",
        }),
      ];
      const dirtyIds = new Set(["temp-new-1"]);

      const result = buildSavePayload(
        transactions,
        dirtyIds,
        new Set(),
        mockResolveTransactionCurrency,
        dirtyCurrencyLookup,
        assetCurrencyLookup,
        "USD",
      );

      expect(result.creates).toHaveLength(1);
      expect(result.creates[0].asset).toEqual(
        expect.objectContaining({
          symbol: "VWRPL.XC",
          exchangeMic: "XLON",
          quoteCcy: "GBP",
          instrumentType: "EQUITY",
        }),
      );
      expect(result.creates[0].asset?.kind).toBeUndefined();
      expect(result.creates[0].asset?.name).toBeUndefined();
    });

    it("should include pending delete IDs", () => {
      const transactions: LocalTransaction[] = [];
      const dirtyIds = new Set<string>();
      const pendingDeleteIds = new Set(["del-1", "del-2"]);

      const result = buildSavePayload(
        transactions,
        dirtyIds,
        pendingDeleteIds,
        mockResolveTransactionCurrency,
        dirtyCurrencyLookup,
        assetCurrencyLookup,
        "USD",
      );

      expect(result.deleteIds).toEqual(["del-1", "del-2"]);
    });

    it("should only include dirty transactions", () => {
      const transactions: LocalTransaction[] = [
        createMockTransaction({ id: "tx-1" }),
        createMockTransaction({ id: "tx-2" }),
        createMockTransaction({ id: "tx-3" }),
      ];
      const dirtyIds = new Set(["tx-1", "tx-3"]);
      const pendingDeleteIds = new Set<string>();

      const result = buildSavePayload(
        transactions,
        dirtyIds,
        pendingDeleteIds,
        mockResolveTransactionCurrency,
        dirtyCurrencyLookup,
        assetCurrencyLookup,
        "USD",
      );

      expect(result.updates).toHaveLength(2);
      expect(result.updates.map((u) => u.id)).toContain("tx-1");
      expect(result.updates.map((u) => u.id)).toContain("tx-3");
      expect(result.updates.map((u) => u.id)).not.toContain("tx-2");
    });

    it("should convert date to ISO string", () => {
      const testDate = new Date("2024-06-15T14:30:00Z");
      const transactions: LocalTransaction[] = [
        createMockTransaction({ id: "tx-1", date: testDate }),
      ];
      const dirtyIds = new Set(["tx-1"]);

      const result = buildSavePayload(
        transactions,
        dirtyIds,
        new Set(),
        mockResolveTransactionCurrency,
        dirtyCurrencyLookup,
        assetCurrencyLookup,
        "USD",
      );

      expect(result.updates[0].activityDate).toBe("2024-06-15T14:30:00.000Z");
    });

    it("should handle cash activities without assetId (backend generates ID)", () => {
      const transactions: LocalTransaction[] = [
        createMockTransaction({
          id: "tx-1",
          activityType: ActivityType.DEPOSIT,
          assetId: "",
          assetSymbol: "",
        }),
      ];
      const dirtyIds = new Set(["tx-1"]);

      const result = buildSavePayload(
        transactions,
        dirtyIds,
        new Set(),
        mockResolveTransactionCurrency,
        dirtyCurrencyLookup,
        assetCurrencyLookup,
        "USD",
      );

      // Backend now generates CASH:{currency} IDs for cash activities
      // Frontend doesn't set symbol for cash activities
      expect(result.updates[0].asset).toBeUndefined();
    });

    it("preserves a symbol-backed adjustment asset on unrelated edits", () => {
      const transactions: LocalTransaction[] = [
        createMockTransaction({
          id: "adjustment-1",
          activityType: ActivityType.ADJUSTMENT,
          assetId: "asset-aapl",
          assetSymbol: "AAPL",
          _originalAssetId: "asset-aapl",
          _originalAssetSymbol: "AAPL",
        }),
      ];

      const result = buildSavePayload(
        transactions,
        new Set(["adjustment-1"]),
        new Set(),
        mockResolveTransactionCurrency,
        dirtyCurrencyLookup,
        assetCurrencyLookup,
        "USD",
      );

      expect(result.updates[0].asset).toEqual(expect.objectContaining({ id: "asset-aapl" }));
    });

    it("explicitly clears an adjustment asset when its symbol is removed", () => {
      const transactions: LocalTransaction[] = [
        createMockTransaction({
          id: "adjustment-1",
          activityType: ActivityType.ADJUSTMENT,
          assetId: "",
          assetSymbol: "",
          _originalAssetId: "asset-aapl",
          _originalAssetSymbol: "AAPL",
        }),
      ];

      const result = buildSavePayload(
        transactions,
        new Set(["adjustment-1"]),
        new Set(),
        mockResolveTransactionCurrency,
        dirtyCurrencyLookup,
        assetCurrencyLookup,
        "USD",
      );

      expect(result.updates[0].asset).toEqual({});
    });

    it("should not force account currency for securities transfers", () => {
      const transactions: LocalTransaction[] = [
        createMockTransaction({
          id: "tx-1",
          activityType: ActivityType.TRANSFER_IN,
          assetId: "",
          assetSymbol: "AAPL",
          currency: "",
          accountCurrency: "USD",
        }),
      ];
      const dirtyIds = new Set(["tx-1"]);

      const result = buildSavePayload(
        transactions,
        dirtyIds,
        new Set(),
        () => undefined,
        dirtyCurrencyLookup,
        assetCurrencyLookup,
        "USD",
      );

      expect(result.updates[0].currency).toBeUndefined();
      expect(result.updates[0].asset).toEqual(
        expect.objectContaining({
          symbol: "AAPL",
        }),
      );
    });

    it("should remove quantity and unitPrice for SPLIT activities", () => {
      const transactions: LocalTransaction[] = [
        createMockTransaction({
          id: "tx-1",
          activityType: ActivityType.SPLIT,
          quantity: "2",
          unitPrice: "0",
        }),
      ];
      const dirtyIds = new Set(["tx-1"]);

      const result = buildSavePayload(
        transactions,
        dirtyIds,
        new Set(),
        mockResolveTransactionCurrency,
        dirtyCurrencyLookup,
        assetCurrencyLookup,
        "USD",
      );

      expect(result.updates[0].quantity).toBeUndefined();
      expect(result.updates[0].unitPrice).toBeUndefined();
    });
  });

  describe("applyTransactionUpdate", () => {
    it("should clear amount when value is null", () => {
      const accountLookup = new Map<string, { id: string; name: string; currency: string }>([
        ["account-1", { id: "account-1", name: "Test Account", currency: "USD" }],
      ]);
      const assetCurrencyLookup = new Map<string, string>();
      const tx = createMockTransaction({ amount: "1000" });

      const updated = applyTransactionUpdate({
        transaction: tx,
        field: "amount",
        value: null,
        accountLookup,
        assetCurrencyLookup,
        fallbackCurrency: "USD",
        resolveTransactionCurrency: () => "USD",
      });

      expect(updated.amount).toBeNull();
    });

    it("should round asset-backed auto-computed amounts before storing them", () => {
      const accountLookup = new Map<string, { id: string; name: string; currency: string }>([
        ["account-1", { id: "account-1", name: "Test Account", currency: "USD" }],
      ]);
      const assetCurrencyLookup = new Map<string, string>();
      const tx = createMockTransaction({
        activityType: ActivityType.DIVIDEND,
        subtype: ACTIVITY_SUBTYPES.DRIP,
        quantity: "1",
        unitPrice: "0.2",
        amount: "0.2",
      });

      const updated = applyTransactionUpdate({
        transaction: tx,
        field: "quantity",
        value: "0.1",
        accountLookup,
        assetCurrencyLookup,
        fallbackCurrency: "USD",
        resolveTransactionCurrency: () => "USD",
      });

      expect(updated.amount).toBe("0.02");
    });

    it("keeps asset-backed income charges separate from the final amount", () => {
      const accountLookup = new Map<string, { id: string; name: string; currency: string }>([
        ["account-1", { id: "account-1", name: "Test Account", currency: "USD" }],
      ]);
      const tx = createMockTransaction({
        activityType: ActivityType.DIVIDEND,
        subtype: ACTIVITY_SUBTYPES.DRIP,
        quantity: "2",
        unitPrice: "50",
        amount: "100",
        tax: "15",
      });

      const updated = applyTransactionUpdate({
        transaction: tx,
        field: "tax",
        value: "20",
        accountLookup,
        assetCurrencyLookup: new Map<string, string>(),
        fallbackCurrency: "USD",
        resolveTransactionCurrency: () => "USD",
      });

      expect(updated.amount).toBe("100");
      expect(updated.tax).toBe("20");
    });

    it("stops automatic totals after the user explicitly edits amount", () => {
      const accountLookup = new Map<string, { id: string; name: string; currency: string }>([
        ["account-1", { id: "account-1", name: "Test Account", currency: "USD" }],
      ]);
      const common = {
        accountLookup,
        assetCurrencyLookup: new Map<string, string>(),
        fallbackCurrency: "USD",
        resolveTransactionCurrency: () => "USD",
      };
      const tx = createMockTransaction({
        activityType: ActivityType.DIVIDEND,
        subtype: ACTIVITY_SUBTYPES.DRIP,
        quantity: "2",
        unitPrice: "50",
        amount: "100",
      });
      const explicitlyEdited = applyTransactionUpdate({
        transaction: tx,
        field: "amount",
        value: "90",
        ...common,
      });

      const quantityChanged = applyTransactionUpdate({
        transaction: explicitlyEdited,
        field: "quantity",
        value: "3",
        ...common,
      });

      expect(quantityChanged.amount).toBe("90");
    });

    it("preserves a stored custom trade amount for non-economic edits", () => {
      const tx = createMockTransaction({
        activityType: ActivityType.BUY,
        quantity: "10",
        unitPrice: "100",
        fee: "5",
        amount: "975",
        _amountEdited: false,
      });

      const updated = applyTransactionUpdate({
        transaction: tx,
        field: "comment",
        value: "reviewed total",
        accountLookup: new Map([
          ["account-1", { id: "account-1", name: "Test Account", currency: "USD" }],
        ]),
        assetCurrencyLookup: new Map<string, string>(),
        fallbackCurrency: "USD",
        resolveTransactionCurrency: () => "USD",
      });

      expect(updated.amount).toBe("975");
    });

    it("should keep staking rewards asset-backed when subtype is selected", () => {
      const accountLookup = new Map<string, { id: string; name: string; currency: string }>([
        ["account-1", { id: "account-1", name: "Test Account", currency: "USD" }],
      ]);
      const assetCurrencyLookup = new Map<string, string>();
      const tx = createMockTransaction({
        activityType: ActivityType.INTEREST,
        assetSymbol: "CASH",
        assetId: "",
        quantity: null,
        unitPrice: null,
        amount: "100",
      });

      const updated = applyTransactionUpdate({
        transaction: tx,
        field: "subtype",
        value: ACTIVITY_SUBTYPES.STAKING_REWARD,
        accountLookup,
        assetCurrencyLookup,
        fallbackCurrency: "USD",
        resolveTransactionCurrency: () => "USD",
      });

      expect(updated.subtype).toBe(ACTIVITY_SUBTYPES.STAKING_REWARD);
      expect(updated.assetSymbol).toBe("");
      expect(updated.assetId).toBe("");
      expect(updated.quantity).toBeNull();
      expect(updated.unitPrice).toBeNull();
    });

    it("should clear asset-backed-only fields when removing a dividend subtype", () => {
      const accountLookup = new Map<string, { id: string; name: string; currency: string }>([
        ["account-1", { id: "account-1", name: "Test Account", currency: "USD" }],
      ]);
      const assetCurrencyLookup = new Map<string, string>();
      const tx = createMockTransaction({
        activityType: ActivityType.DIVIDEND,
        subtype: ACTIVITY_SUBTYPES.DIVIDEND_IN_KIND,
        assetSymbol: "AAPL",
        quantity: "2",
        unitPrice: "100",
        amount: "200",
      });

      const updated = applyTransactionUpdate({
        transaction: tx,
        field: "subtype",
        value: "",
        accountLookup,
        assetCurrencyLookup,
        fallbackCurrency: "USD",
        resolveTransactionCurrency: () => "USD",
      });

      expect(updated.subtype).toBeUndefined();
      expect(updated.quantity).toBeNull();
      expect(updated.unitPrice).toBeNull();
      expect(updated.amount).toBe("200");
      expect(updated._amountEdited).toBe(true);
    });

    it("should clear invalid staking subtype fields when changing to dividend", () => {
      const accountLookup = new Map<string, { id: string; name: string; currency: string }>([
        ["account-1", { id: "account-1", name: "Test Account", currency: "USD" }],
      ]);
      const assetCurrencyLookup = new Map<string, string>();
      const tx = createMockTransaction({
        activityType: ActivityType.INTEREST,
        subtype: ACTIVITY_SUBTYPES.STAKING_REWARD,
        assetSymbol: "ETH",
        assetId: "ETH",
        quantity: "0.25",
        unitPrice: "3000",
        amount: "750",
      });

      const updated = applyTransactionUpdate({
        transaction: tx,
        field: "activityType",
        value: ActivityType.DIVIDEND,
        accountLookup,
        assetCurrencyLookup,
        fallbackCurrency: "USD",
        resolveTransactionCurrency: () => "USD",
      });

      expect(updated.activityType).toBe(ActivityType.DIVIDEND);
      expect(updated.subtype).toBeUndefined();
      expect(updated.quantity).toBeNull();
      expect(updated.unitPrice).toBeNull();
      expect(updated.amount).toBe("750");
      expect(updated._amountEdited).toBe(true);
      expect(updated.assetSymbol).toBe("ETH");
      expect(updated.assetId).toBe("ETH");
    });

    it("should clear invalid dividend-in-kind subtype fields when changing to a market type", () => {
      const accountLookup = new Map<string, { id: string; name: string; currency: string }>([
        ["account-1", { id: "account-1", name: "Test Account", currency: "USD" }],
      ]);
      const assetCurrencyLookup = new Map<string, string>();
      const tx = createMockTransaction({
        activityType: ActivityType.DIVIDEND,
        subtype: ACTIVITY_SUBTYPES.DIVIDEND_IN_KIND,
        assetSymbol: "AAPL",
        assetId: "AAPL",
        quantity: "2",
        unitPrice: "100",
        amount: "200",
      });

      const updated = applyTransactionUpdate({
        transaction: tx,
        field: "activityType",
        value: ActivityType.BUY,
        accountLookup,
        assetCurrencyLookup,
        fallbackCurrency: "USD",
        resolveTransactionCurrency: () => "USD",
      });

      expect(updated.activityType).toBe(ActivityType.BUY);
      expect(updated.subtype).toBeUndefined();
      expect(updated.quantity).toBeNull();
      expect(updated.unitPrice).toBeNull();
      expect(updated.amount).toBeNull();
      expect(updated._amountEdited).toBe(false);
      expect(updated.assetSymbol).toBe("AAPL");
      expect(updated.assetId).toBe("AAPL");
    });

    it("should not force transfer activity rows to CASH", () => {
      const accountLookup = new Map<string, { id: string; name: string; currency: string }>([
        ["account-1", { id: "account-1", name: "Test Account", currency: "USD" }],
      ]);
      const assetCurrencyLookup = new Map<string, string>();
      const tx = createMockTransaction({
        activityType: ActivityType.BUY,
        assetSymbol: "AAPL",
        assetId: "AAPL",
      });

      const updated = applyTransactionUpdate({
        transaction: tx,
        field: "activityType",
        value: ActivityType.TRANSFER_IN,
        accountLookup,
        assetCurrencyLookup,
        fallbackCurrency: "USD",
        resolveTransactionCurrency: () => "USD",
      });

      expect(updated.assetSymbol).toBe("AAPL");
      expect(updated.assetId).toBe("AAPL");
    });
  });

  describe("validateTransactionsForSave", () => {
    it("rejects approval when a final-cash activity still has no amount", () => {
      const transaction = createMockTransaction({
        id: "sell-missing-final",
        activityType: ActivityType.SELL,
        amount: null,
        needsReview: false,
        _originalNeedsReview: true,
      });

      const result = validateTransactionsForSave([transaction], new Set(["sell-missing-final"]));

      expect(result.isValid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          transactionId: "sell-missing-final",
          field: "amount",
          message: "Final cash amount is required before approval",
        }),
      );
    });

    it("allows the unresolved activity to remain in review", () => {
      const transaction = createMockTransaction({
        id: "sell-still-reviewing",
        activityType: ActivityType.SELL,
        amount: null,
        needsReview: true,
        _originalNeedsReview: true,
      });

      const result = validateTransactionsForSave([transaction], new Set(["sell-still-reviewing"]));

      expect(result.isValid).toBe(true);
    });

    it("should require asset-backed income fields for staking rewards", () => {
      const transactions: LocalTransaction[] = [
        createMockTransaction({
          id: "staking-1",
          activityType: ActivityType.INTEREST,
          subtype: ACTIVITY_SUBTYPES.STAKING_REWARD,
          assetSymbol: "ETH",
          assetId: "ETH",
          quantity: null,
          unitPrice: null,
          amount: "100",
        }),
      ];

      const result = validateTransactionsForSave(transactions, new Set(["staking-1"]));

      expect(result.isValid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: "quantity" })]),
      );
      expect(result.errors).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ field: "unitPrice" })]),
      );
    });

    it("should allow asset-backed income with amount instead of unit price", () => {
      const transactions: LocalTransaction[] = [
        createMockTransaction({
          id: "staking-amount-only",
          activityType: ActivityType.INTEREST,
          subtype: ACTIVITY_SUBTYPES.STAKING_REWARD,
          assetSymbol: "ETH",
          assetId: "ETH",
          quantity: "0.05",
          unitPrice: null,
          amount: "200",
        }),
      ];

      const result = validateTransactionsForSave(transactions, new Set(["staking-amount-only"]));

      expect(result.isValid).toBe(true);
    });

    it("should require an amount or unit price for asset-backed income", () => {
      const transactions: LocalTransaction[] = [
        createMockTransaction({
          id: "staking-missing-value",
          activityType: ActivityType.INTEREST,
          subtype: ACTIVITY_SUBTYPES.STAKING_REWARD,
          assetSymbol: "ETH",
          assetId: "ETH",
          quantity: "0.05",
          unitPrice: null,
          amount: null,
        }),
      ];

      const result = validateTransactionsForSave(transactions, new Set(["staking-missing-value"]));

      expect(result.isValid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: "unitPrice" })]),
      );
    });
  });

  describe("hasFinalCashAmountForApproval", () => {
    it("rejects a cash-bearing activity with no final amount", () => {
      expect(
        hasFinalCashAmountForApproval(
          createMockTransaction({ activityType: ActivityType.SELL, amount: null }),
        ),
      ).toBe(false);
    });

    it("rejects an untouched legacy zero on a trade", () => {
      expect(
        hasFinalCashAmountForApproval(
          createMockTransaction({ activityType: ActivityType.SELL, amount: "0" }),
        ),
      ).toBe(false);
    });

    it("accepts a zero trade total explicitly confirmed this session", () => {
      expect(
        hasFinalCashAmountForApproval(
          createMockTransaction({
            activityType: ActivityType.SELL,
            amount: "0",
            _amountEdited: true,
          }),
        ),
      ).toBe(true);
    });

    it("does not require an amount for a securities transfer", () => {
      expect(
        hasFinalCashAmountForApproval(
          createMockTransaction({
            activityType: ActivityType.TRANSFER_OUT,
            assetId: "asset-aapl",
            assetSymbol: "AAPL",
            amount: null,
          }),
        ),
      ).toBe(true);
    });
  });

  describe("partitionReviewRowsForApproval", () => {
    it("separates complete and incomplete rows from one bulk selection", () => {
      const complete = createMockTransaction({
        id: "complete-sell",
        activityType: ActivityType.SELL,
        amount: "125",
      });
      const missing = createMockTransaction({
        id: "missing-sell",
        activityType: ActivityType.SELL,
        amount: null,
      });
      const untouchedZero = createMockTransaction({
        id: "zero-buy",
        activityType: ActivityType.BUY,
        amount: "0",
      });

      const result = partitionReviewRowsForApproval([complete, missing, untouchedZero]);

      expect(result.approvable.map((transaction) => transaction.id)).toEqual(["complete-sell"]);
      expect(result.incomplete.map((transaction) => transaction.id)).toEqual([
        "missing-sell",
        "zero-buy",
      ]);
    });
  });

  describe("TRACKED_FIELDS", () => {
    it("should contain expected fields", () => {
      expect(TRACKED_FIELDS).toContain("activityType");
      expect(TRACKED_FIELDS).toContain("date");
      expect(TRACKED_FIELDS).toContain("assetSymbol");
      expect(TRACKED_FIELDS).toContain("quantity");
      expect(TRACKED_FIELDS).toContain("unitPrice");
      expect(TRACKED_FIELDS).toContain("amount");
      expect(TRACKED_FIELDS).toContain("fee");
      expect(TRACKED_FIELDS).toContain("accountId");
      expect(TRACKED_FIELDS).toContain("currency");
      expect(TRACKED_FIELDS).toContain("comment");
    });

    it("should not contain metadata fields", () => {
      expect(TRACKED_FIELDS).not.toContain("id");
      expect(TRACKED_FIELDS).not.toContain("createdAt");
      expect(TRACKED_FIELDS).not.toContain("updatedAt");
      expect(TRACKED_FIELDS).not.toContain("isNew");
    });
  });
});
