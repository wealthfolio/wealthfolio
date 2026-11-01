import i18n from "i18next";
import enAi from "@/i18n/locales/en/ai.json";
import zhAi from "@/i18n/locales/zh/ai.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccountType, ActivityType } from "@/lib/constants";
import type { ImportCsvMappingOutput } from "../types";
import { useChatImportSession } from "./use-chat-import-session";

const adapterMocks = vi.hoisted(() => ({
  checkActivitiesImport: vi.fn(),
  createAsset: vi.fn(),
  importActivities: vi.fn(),
  parseCsv: vi.fn(),
  previewImportAssets: vi.fn(),
  saveAccountImportMapping: vi.fn(),
  updateToolResult: vi.fn(),
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

const spendingInvalidationMocks = vi.hoisted(() => ({
  invalidateSpendingCaches: vi.fn(),
}));

vi.mock("@/adapters", () => adapterMocks);
vi.mock("@/features/spending/lib/invalidation", () => spendingInvalidationMocks);

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

const mapping = {
  csvContent: "Date,Symbol,Quantity,Price,Type\n2024-01-15,NEWCO,2,10,Buy",
  appliedMapping: {
    name: "AI Import",
    accountId: "acct-1",
    importType: "CSV_ACTIVITY",
    fieldMappings: {
      date: "Date",
      symbol: "Symbol",
      quantity: "Quantity",
      unitPrice: "Price",
      activityType: "Type",
    },
    activityMappings: {
      BUY: ["Buy"],
    },
    symbolMappings: {},
    accountMappings: {},
    symbolMappingMeta: {},
  },
  parseConfig: {
    defaultCurrency: "USD",
    dateFormat: "auto",
    decimalSeparator: ".",
    thousandsSeparator: ",",
  },
  accountId: "acct-1",
  detectedHeaders: ["Date", "Symbol", "Quantity", "Price", "Type"],
  sampleRows: [["2024-01-15", "NEWCO", "2", "10", "Buy"]],
  totalRows: 1,
  mappingConfidence: "HIGH",
  availableAccounts: [{ id: "acct-1", name: "Brokerage", currency: "USD" }],
} as ImportCsvMappingOutput;

describe("useChatImportSession", () => {
  it("localizes missing CSV without starting provider or import work", async () => {
    i18n.addResourceBundle("zh", "ai", zhAi, true, true);
    await i18n.changeLanguage("zh");
    try {
      const { result, unmount } = renderHook(
        () => useChatImportSession({ mapping: { ...mapping, csvContent: "" } }),
        { wrapper: createWrapper() },
      );
      await waitFor(() => expect(result.current.error).toBe(zhAi.importSessionErrors.missingCsv));
      expect(adapterMocks.parseCsv).not.toHaveBeenCalled();
      expect(adapterMocks.importActivities).not.toHaveBeenCalled();
      unmount();
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    adapterMocks.parseCsv.mockResolvedValue({
      headers: ["Date", "Symbol", "Quantity", "Price", "Type"],
      rows: [["2024-01-15", "NEWCO", "2", "10", "Buy"]],
      detectedConfig: {
        defaultCurrency: "USD",
        dateFormat: "auto",
        decimalSeparator: ".",
        thousandsSeparator: ",",
      },
      errors: [],
      rowCount: 1,
    });
    adapterMocks.checkActivitiesImport.mockResolvedValue([]);
    adapterMocks.previewImportAssets.mockImplementation(
      ({ candidates }: { candidates: { key: string }[] }) => [
        {
          key: candidates[0].key,
          status: "AUTO_RESOLVED_NEW_ASSET",
          resolutionSource: "AUTO",
          draft: {
            kind: "INVESTMENT",
            name: "NewCo",
            displayCode: "NEWCO",
            isActive: true,
            quoteMode: "MARKET",
            quoteCcy: "USD",
            instrumentType: "EQUITY",
            instrumentSymbol: "NEWCO",
          },
        },
      ],
    );
    adapterMocks.createAsset.mockResolvedValue({ id: "asset-newco" });
    adapterMocks.importActivities.mockResolvedValue({
      importRunId: "run-1",
      summary: { success: true, imported: 1 },
      activities: [],
    });
    adapterMocks.saveAccountImportMapping.mockResolvedValue(undefined);
    adapterMocks.updateToolResult.mockResolvedValue(undefined);
  });

  it("creates auto-resolved pending assets before importing chat CSV drafts", async () => {
    const { result } = renderHook(() => useChatImportSession({ mapping }), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.confirm();
    });

    expect(adapterMocks.createAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        instrumentSymbol: "NEWCO",
        quoteCcy: "USD",
        instrumentType: "EQUITY",
      }),
    );
    expect(adapterMocks.importActivities).toHaveBeenCalledWith({
      activities: [
        expect.objectContaining({
          assetId: "asset-newco",
          symbol: "NEWCO",
        }),
      ],
    });
    expect(spendingInvalidationMocks.invalidateSpendingCaches).toHaveBeenCalledTimes(1);
  });

  it("saves the repaired mapping used for a successful chat import", async () => {
    adapterMocks.parseCsv.mockResolvedValue({
      headers: ["Date", "Symbol", "Quantity", "Price", "Type"],
      rows: [["2024-01-15", "NEWCO", "2", "10", "Buy"]],
      detectedConfig: {
        defaultCurrency: "USD",
        dateFormat: "auto",
        decimalSeparator: ".",
        thousandsSeparator: ",",
      },
      errors: [],
      rowCount: 1,
    });
    const staleMapping: ImportCsvMappingOutput = {
      ...mapping,
      appliedMapping: {
        ...mapping.appliedMapping,
        fieldMappings: {
          date: "WrongDate",
          symbol: "WrongSymbol",
          quantity: "WrongQuantity",
          unitPrice: "WrongPrice",
          activityType: "WrongType",
        },
        accountMappings: {
          "Manual Brokerage Alias": "acct-1",
        },
      },
      parseConfig: {
        ...mapping.parseConfig,
        skipTopRows: 1,
      },
    };

    const { result } = renderHook(() => useChatImportSession({ mapping: staleMapping }), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.confirm();
    });

    expect(adapterMocks.saveAccountImportMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        fieldMappings: expect.objectContaining({
          date: "Date",
          symbol: "Symbol",
          quantity: "Quantity",
          unitPrice: "Price",
          activityType: "Type",
        }),
        parseConfig: expect.objectContaining({ skipTopRows: 1 }),
      }),
    );
    // The tool's skipTopRows is used as given; the file is never reparsed without it.
    expect(adapterMocks.parseCsv).toHaveBeenCalledTimes(1);
    expect(adapterMocks.parseCsv).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({ skipTopRows: 1 }),
    );
    const savedMapping = adapterMocks.saveAccountImportMapping.mock.calls[0]?.[0];
    expect(savedMapping.accountMappings).toEqual({
      "Manual Brokerage Alias": "acct-1",
    });
  });

  it("replaces stale backend errors after the user changes account", async () => {
    const mappingWithTwoAccounts: ImportCsvMappingOutput = {
      ...mapping,
      availableAccounts: [
        { id: "acct-1", name: "Brokerage", currency: "USD" },
        { id: "acct-2", name: "Test", currency: "USD" },
      ],
    };
    adapterMocks.checkActivitiesImport
      .mockResolvedValueOnce([
        {
          lineNumber: 1,
          isValid: false,
          errors: { general: ["Validation failed: Record not found"] },
        },
      ])
      .mockResolvedValueOnce([
        {
          lineNumber: 1,
          isValid: true,
          warnings: {},
          errors: {},
        },
      ]);

    const { result } = renderHook(() => useChatImportSession({ mapping: mappingWithTwoAccounts }), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.stats.errors).toBe(1));

    act(() => {
      result.current.setAccountId("acct-2");
    });

    await waitFor(() => expect(result.current.stats.errors).toBe(0));
    expect(result.current.stats.valid).toBe(1);
  });

  it("allows confirm when CSV rows carry valid per-row accounts", async () => {
    adapterMocks.parseCsv.mockResolvedValueOnce({
      headers: ["Date", "Symbol", "Quantity", "Price", "Type", "Account"],
      rows: [["2024-01-15", "NEWCO", "2", "10", "Buy", "Test"]],
      detectedConfig: {
        defaultCurrency: "USD",
        dateFormat: "auto",
        decimalSeparator: ".",
        thousandsSeparator: ",",
      },
      errors: [],
      rowCount: 1,
    });

    const mappingWithRowAccount: ImportCsvMappingOutput = {
      ...mapping,
      accountId: null,
      appliedMapping: {
        ...mapping.appliedMapping,
        accountId: "",
        fieldMappings: {
          ...mapping.appliedMapping.fieldMappings,
          account: "Account",
        },
      },
      availableAccounts: [
        { id: "acct-1", name: "Brokerage", currency: "USD" },
        { id: "acct-2", name: "Test", currency: "USD" },
      ],
    };

    const { result } = renderHook(() => useChatImportSession({ mapping: mappingWithRowAccount }), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.accountId).toBe("");
    expect(result.current.drafts[0]?.accountId).toBe("acct-2");
    expect(result.current.canConfirm).toBe(true);
  });

  it("rebuilds ambiguous CSV drafts with the transaction profile after selecting a card account", async () => {
    adapterMocks.parseCsv.mockResolvedValue({
      headers: ["Date", "Merchant", "Amount", "Type"],
      rows: [["2024-01-15", "Starbucks", "12.50", "Purchase"]],
      detectedConfig: {
        defaultCurrency: "USD",
        dateFormat: "auto",
        decimalSeparator: ".",
        thousandsSeparator: ",",
      },
      errors: [],
      rowCount: 1,
    });

    const ambiguousCardStatement: ImportCsvMappingOutput = {
      ...mapping,
      csvContent: "Date,Merchant,Amount,Type\n2024-01-15,Starbucks,12.50,Purchase",
      accountId: null,
      appliedMapping: {
        ...mapping.appliedMapping,
        accountId: "",
        fieldMappings: {
          date: "Date",
          symbol: "Merchant",
          amount: "Amount",
          activityType: "Type",
        },
        activityMappings: {
          [ActivityType.WITHDRAWAL]: ["Purchase"],
        },
      },
      availableAccounts: [
        {
          id: "brokerage-1",
          name: "Brokerage",
          currency: "USD",
          accountType: AccountType.SECURITIES,
        },
        {
          id: "card-1",
          name: "Visa",
          currency: "USD",
          accountType: AccountType.CREDIT_CARD,
        },
      ],
    };

    const { result } = renderHook(() => useChatImportSession({ mapping: ambiguousCardStatement }), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.importProfile.kind).toBe("investment");

    act(() => {
      result.current.setAccountId("card-1");
    });

    await waitFor(() => expect(result.current.drafts[0]?.comment).toBe("Starbucks"));

    expect(result.current.importProfile.kind).toBe("transaction");
    expect(result.current.drafts[0]).toMatchObject({
      accountId: "card-1",
      activityType: ActivityType.WITHDRAWAL,
      symbol: undefined,
      comment: "Starbucks",
      amount: "12.50",
    });
  });

  it("keeps the tool's parse config when account selection changes the import profile", async () => {
    adapterMocks.parseCsv.mockResolvedValue({
      headers: ["Date", "Merchant", "Amount", "Type"],
      rows: [["2024-01-15", "Starbucks", "12.50", "Purchase"]],
      detectedConfig: {
        defaultCurrency: "USD",
        dateFormat: "auto",
        decimalSeparator: ".",
        thousandsSeparator: ",",
      },
      errors: [],
      rowCount: 1,
    });

    const staleAmbiguousStatement: ImportCsvMappingOutput = {
      ...mapping,
      csvContent: "Date,Merchant,Amount,Type\n2024-01-15,Starbucks,12.50,Purchase",
      accountId: null,
      appliedMapping: {
        ...mapping.appliedMapping,
        accountId: "",
        fieldMappings: {
          date: "Date",
          symbol: "Merchant",
          amount: "Amount",
          activityType: "Type",
        },
        activityMappings: {
          [ActivityType.WITHDRAWAL]: ["Purchase"],
        },
      },
      parseConfig: {
        ...mapping.parseConfig,
        skipTopRows: 1,
      },
      availableAccounts: [
        {
          id: "brokerage-1",
          name: "Brokerage",
          currency: "USD",
          accountType: AccountType.SECURITIES,
        },
        {
          id: "card-1",
          name: "Visa",
          currency: "USD",
          accountType: AccountType.CREDIT_CARD,
        },
      ],
    };

    const { result } = renderHook(
      () => useChatImportSession({ mapping: staleAmbiguousStatement }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.setAccountId("card-1");
    });

    await waitFor(() => expect(result.current.drafts[0]?.accountId).toBe("card-1"));
    expect(adapterMocks.parseCsv).toHaveBeenLastCalledWith(
      expect.any(File),
      expect.objectContaining({ skipTopRows: 1 }),
    );
    await waitFor(() => expect(result.current.canConfirm).toBe(true));

    await act(async () => {
      await result.current.confirm();
    });

    expect(adapterMocks.saveAccountImportMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        parseConfig: expect.objectContaining({ skipTopRows: 1 }),
      }),
    );
  });

  describe("held error language changes", () => {
    beforeEach(async () => {
      i18n.addResourceBundle("zh", "ai", zhAi, true, true);
      await i18n.changeLanguage("en");
    });
    afterEach(async () => {
      await act(() => i18n.changeLanguage("en"));
    });

    function workCalls() {
      return [
        adapterMocks.parseCsv,
        adapterMocks.checkActivitiesImport,
        adapterMocks.previewImportAssets,
        adapterMocks.createAsset,
        adapterMocks.importActivities,
        adapterMocks.saveAccountImportMapping,
        adapterMocks.updateToolResult,
      ].map((mock) => mock.mock.calls.length);
    }

    async function expectHeldError(
      result: { current: ReturnType<typeof useChatImportSession> },
      english: string,
      chinese: string,
    ) {
      await waitFor(() => expect(result.current.error).toBe(english));
      const calls = workCalls();
      const drafts = result.current.drafts;
      const status = result.current.status;
      const revalidate = result.current.revalidate;
      const confirm = result.current.confirm;
      await act(() => i18n.changeLanguage("zh"));
      expect(result.current.error).toBe(chinese);
      await act(() => i18n.changeLanguage("en"));
      expect(result.current.error).toBe(english);
      expect(workCalls()).toEqual(calls);
      expect(result.current.drafts).toBe(drafts);
      expect(result.current.status).toBe(status);
      expect(result.current.revalidate).toBe(revalidate);
      expect(result.current.confirm).toBe(confirm);
    }

    it.each(["missingCsv", "emptyCsv", "prepareFailed"] as const)(
      "retranslates an already-held %s initialization error without parsing again",
      async (key) => {
        const currentMapping = key === "missingCsv" ? { ...mapping, csvContent: "" } : mapping;
        if (key === "emptyCsv") {
          adapterMocks.parseCsv.mockResolvedValueOnce({
            headers: [],
            rows: [],
            detectedConfig: {},
          });
        } else if (key === "prepareFailed") {
          adapterMocks.parseCsv.mockRejectedValueOnce({ code: "unexpected" });
        }
        const { result } = renderHook(() => useChatImportSession({ mapping: currentMapping }), {
          wrapper: createWrapper(),
        });
        await expectHeldError(result, enAi.importSessionErrors[key], zhAi.importSessionErrors[key]);
        expect(adapterMocks.parseCsv).toHaveBeenCalledTimes(key === "missingCsv" ? 0 : 1);
      },
    );

    it.each(["nothing", "allInvalid", "revalidateFailed", "importFailed"] as const)(
      "retranslates an already-held %s action error without repeating work",
      async (key) => {
        const { result } = renderHook(() => useChatImportSession({ mapping }), {
          wrapper: createWrapper(),
        });
        await waitFor(() => expect(result.current.status).toBe("ready"));
        if (key === "nothing") {
          act(() => result.current.skipRow(0));
        } else if (key === "allInvalid") {
          adapterMocks.checkActivitiesImport.mockResolvedValueOnce([
            { lineNumber: 1, isValid: false, errors: { general: ["Backend diagnostic"] } },
          ]);
        } else if (key === "revalidateFailed") {
          adapterMocks.checkActivitiesImport.mockRejectedValueOnce({ code: "unexpected" });
        } else {
          adapterMocks.importActivities.mockRejectedValueOnce({ code: "unexpected" });
        }
        await act(async () => {
          if (key === "revalidateFailed") await result.current.revalidate();
          else await result.current.confirm();
        });
        await expectHeldError(result, enAi.importSessionErrors[key], zhAi.importSessionErrors[key]);
      },
    );

    it.each([
      { name: "missing summary", response: {}, raw: undefined },
      { name: "null summary", response: { summary: null }, raw: undefined },
      {
        name: "undefined error",
        response: { summary: { success: false, imported: 0, errorMessage: undefined } },
        raw: undefined,
      },
      {
        name: "missing error",
        response: { summary: { success: false, imported: 0 } },
        raw: undefined,
      },
      {
        name: "null error",
        response: { summary: { success: false, imported: 0, errorMessage: null } },
        raw: undefined,
      },
      {
        name: "failure with imported rows",
        response: { summary: { success: false, imported: 1 } },
        raw: undefined,
      },
      {
        name: "success with zero rows",
        response: { summary: { success: true, imported: 0 } },
        raw: undefined,
      },
      ...[
        "",
        "   ",
        "ai:importSessionErrors.reviewAndRetry",
        "Provider detail: row 7 rejected.",
        "Import failed. Review the errors and try again.",
      ].map((raw) => ({
        name: `raw error ${JSON.stringify(raw)}`,
        response: { summary: { success: false, imported: 0, errorMessage: raw } },
        raw,
      })),
    ])(
      "retains a failed-import summary message across language changes: $name",
      async ({ response, raw }) => {
        adapterMocks.importActivities.mockResolvedValueOnce({
          ...response,
          activities: [
            { lineNumber: 1, isValid: false, errors: { general: ["Provider row diagnostic"] } },
          ],
        });
        const { result } = renderHook(() => useChatImportSession({ mapping }), {
          wrapper: createWrapper(),
        });
        await waitFor(() => expect(result.current.status).toBe("ready"));
        await act(() => result.current.confirm());
        await expectHeldError(
          result,
          raw ?? enAi.importSessionErrors.reviewAndRetry,
          raw ?? zhAi.importSessionErrors.reviewAndRetry,
        );
        expect(enAi.importSessionErrors.reviewAndRetry).toBe(
          "Import failed. Review the errors and try again.",
        );
        expect(result.current.status).toBe("error");
        expect(result.current.submitted).toBe(false);
        expect(result.current.drafts[0].errors.general).toEqual(["Provider row diagnostic"]);
        expect(adapterMocks.importActivities).toHaveBeenCalledTimes(1);
        expect(adapterMocks.saveAccountImportMapping).not.toHaveBeenCalled();
        expect(adapterMocks.updateToolResult).not.toHaveBeenCalled();
      },
    );

    it.each(["initialization", "revalidation", "submission"] as const)(
      "preserves raw Error and key-looking string diagnostics from %s",
      async (phase) => {
        for (const diagnostic of [
          new Error("Provider's raw diagnostic"),
          new Error("ai:importSessionErrors.nothing"),
          "ai:importSessionErrors.nothing",
        ]) {
          if (phase === "initialization") adapterMocks.parseCsv.mockRejectedValueOnce(diagnostic);
          const { result, unmount } = renderHook(() => useChatImportSession({ mapping }), {
            wrapper: createWrapper(),
          });
          if (phase !== "initialization") {
            await waitFor(() => expect(result.current.status).toBe("ready"));
            if (phase === "revalidation")
              adapterMocks.checkActivitiesImport.mockRejectedValueOnce(diagnostic);
            else adapterMocks.importActivities.mockRejectedValueOnce(diagnostic);
            await act(async () => {
              if (phase === "revalidation") await result.current.revalidate();
              else await result.current.confirm();
            });
          }
          const raw = diagnostic instanceof Error ? diagnostic.message : diagnostic;
          const fallbackKey = phase === "revalidation" ? "revalidateFailed" : "importFailed";
          const passesThrough = diagnostic instanceof Error || phase === "initialization";
          await expectHeldError(
            result,
            passesThrough ? raw : enAi.importSessionErrors[fallbackKey],
            passesThrough ? raw : zhAi.importSessionErrors[fallbackKey],
          );
          unmount();
        }
      },
    );
  });

  it("carries local row-error provenance through edits and backend merges without sending it", async () => {
    const currentMapping: ImportCsvMappingOutput = {
      ...mapping,
      accountId: "",
      appliedMapping: { ...mapping.appliedMapping, accountId: "" },
      availableAccounts: [
        ...mapping.availableAccounts,
        { id: "acct-2", name: "Second", currency: "USD" },
      ],
    };
    const { result } = renderHook(() => useChatImportSession({ mapping: currentMapping }), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.drafts[0].localErrorMessages?.accountId?.[0].key).toBe(
      "activity:validation.account_is_required",
    );
    act(() => result.current.setAccountId("acct-1"));
    await waitFor(() => expect(result.current.drafts[0].errors.accountId).toBeUndefined());
    expect(result.current.drafts[0].localErrorMessages?.accountId).toBeUndefined();

    act(() => result.current.editDraft(0, { activityDate: "" }));
    const localError = result.current.drafts[0].errors.activityDate[0];
    expect(result.current.drafts[0].localErrorMessages?.activityDate).toEqual([
      { key: "activity:validation.date_is_required", originalMessage: localError },
    ]);
    act(() => result.current.bulkSkip([0]));
    act(() => result.current.bulkUnskip([0]));
    expect(result.current.drafts[0].localErrorMessages?.activityDate?.[0].originalMessage).toBe(
      localError,
    );
    adapterMocks.checkActivitiesImport.mockResolvedValueOnce([
      {
        lineNumber: 1,
        isValid: false,
        errors: { activityDate: ["ai:importSessionErrors.nothing"] },
      },
    ]);
    await act(() => result.current.revalidate());
    expect(result.current.drafts[0].errors.activityDate).toEqual([
      localError,
      "ai:importSessionErrors.nothing",
    ]);
    expect(result.current.drafts[0].localErrorMessages?.activityDate).toHaveLength(1);
    for (const call of adapterMocks.checkActivitiesImport.mock.calls) {
      for (const activity of call[0].activities)
        expect(activity).not.toHaveProperty("localErrorMessages");
    }
    act(() => result.current.editDraft(0, { activityDate: "2024-01-15" }));
    expect(result.current.drafts[0].errors.activityDate).toBeUndefined();
    expect(result.current.drafts[0].localErrorMessages?.activityDate).toBeUndefined();
  });
});
