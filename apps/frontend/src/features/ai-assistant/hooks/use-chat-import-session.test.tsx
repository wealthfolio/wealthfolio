import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
    adapterMocks.parseCsv
      .mockResolvedValueOnce({
        headers: ["2024-01-15", "NEWCO", "2", "10", "Buy"],
        rows: [],
        detectedConfig: {
          defaultCurrency: "USD",
          dateFormat: "auto",
          decimalSeparator: ".",
          thousandsSeparator: ",",
        },
        errors: [],
        rowCount: 0,
      })
      .mockResolvedValue({
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
        parseConfig: expect.objectContaining({ skipTopRows: 0 }),
      }),
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

  it("keeps the repaired parse config when account selection changes the import profile", async () => {
    adapterMocks.parseCsv.mockImplementation(
      async (_file: File, config?: { skipTopRows?: number }) => {
        if ((config?.skipTopRows ?? 0) > 0) {
          return {
            headers: ["2024-01-15", "Starbucks", "12.50", "Purchase"],
            rows: [],
            detectedConfig: {
              defaultCurrency: "USD",
              dateFormat: "auto",
              decimalSeparator: ".",
              thousandsSeparator: ",",
            },
            errors: [],
            rowCount: 0,
          };
        }
        return {
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
        };
      },
    );

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
      expect.objectContaining({ skipTopRows: 0 }),
    );
    await waitFor(() => expect(result.current.canConfirm).toBe(true));

    await act(async () => {
      await result.current.confirm();
    });

    expect(adapterMocks.saveAccountImportMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        parseConfig: expect.objectContaining({ skipTopRows: 0 }),
      }),
    );
  });
});
