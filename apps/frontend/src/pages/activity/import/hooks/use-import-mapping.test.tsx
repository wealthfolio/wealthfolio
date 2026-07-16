import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { ImportFormat } from "@/lib/constants";
import { ActivityType, ImportType } from "@/lib/types";
import { initializeColumnMapping, useImportMapping } from "./use-import-mapping";

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useImportMapping activity type mappings", () => {
  it("does not auto-map market value into generic amount", () => {
    const mapping = initializeColumnMapping(["Date", "Market Value", "Amount"]);

    expect(mapping[ImportFormat.AMOUNT]).toBe("Amount");
  });

  it("leaves standalone market value unmapped without explicit field semantics", () => {
    const mapping = initializeColumnMapping(["Date", "Market Value"]);

    expect(mapping[ImportFormat.AMOUNT]).toBeUndefined();
  });

  it("auto-maps tax and withholding aliases", () => {
    const tradeMapping = initializeColumnMapping(["Date", "Stamp Duty", "Amount"]);
    const incomeMapping = initializeColumnMapping(["Date", "Withholding Tax", "Amount"]);

    expect(tradeMapping[ImportFormat.TAX]).toBe("Stamp Duty");
    expect(incomeMapping[ImportFormat.TAX]).toBe("Withholding Tax");
  });

  it("starts with exact identity mappings for canonical activity types", () => {
    const { result } = renderHook(() => useImportMapping(), {
      wrapper: createWrapper(),
    });

    expect(result.current.mapping.activityMappings[ActivityType.BUY]).toEqual(["BUY"]);
    expect(result.current.mapping.activityMappings[ActivityType.WITHDRAWAL]).toEqual([
      "WITHDRAWAL",
    ]);
  });

  it("stores full normalized labels and clears mappings without leaving empty keys", () => {
    const { result } = renderHook(
      () =>
        useImportMapping({
          defaultMapping: {
            accountId: "acc-1",
            importType: ImportType.ACTIVITY,
            name: "",
            fieldMappings: {},
            activityMappings: {},
            symbolMappings: {},
            accountMappings: {},
            symbolMappingMeta: {},
          },
        }),
      { wrapper: createWrapper() },
    );

    act(() => {
      result.current.handleActivityTypeMapping("Dividend Qualified", ActivityType.DIVIDEND);
    });

    expect(result.current.mapping.activityMappings[ActivityType.DIVIDEND]).toEqual([
      "DIVIDEND_QUALIFIED",
    ]);

    act(() => {
      result.current.handleActivityTypeMapping("Dividend Qualified", "");
    });

    expect(result.current.mapping.activityMappings[ActivityType.DIVIDEND]).toBeUndefined();
    expect(result.current.mapping.activityMappings[""]).toBeUndefined();
  });

  it("remaps one csv label without colliding with a different longer label", () => {
    const { result } = renderHook(
      () =>
        useImportMapping({
          defaultMapping: {
            accountId: "acc-1",
            importType: ImportType.ACTIVITY,
            name: "",
            fieldMappings: {},
            activityMappings: {},
            symbolMappings: {},
            accountMappings: {},
            symbolMappingMeta: {},
          },
        }),
      { wrapper: createWrapper() },
    );

    act(() => {
      result.current.handleActivityTypeMapping("Transfer Out Fee", ActivityType.FEE);
    });

    act(() => {
      result.current.handleActivityTypeMapping("Transfer Out", ActivityType.TRANSFER_OUT);
    });

    expect(result.current.mapping.activityMappings[ActivityType.FEE]).toEqual(["TRANSFER_OUT_FEE"]);
    expect(result.current.mapping.activityMappings[ActivityType.TRANSFER_OUT]).toEqual([
      "TRANSFER_OUT",
    ]);
  });

  it("preserves provider metadata when mapping a CSV symbol from search", () => {
    const { result } = renderHook(() => useImportMapping(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.handleSymbolMapping("SHOP.TO", "SHOP", {
        symbol: "SHOP.TO",
        canonicalSymbol: "SHOP",
        canonicalExchangeMic: "XTSE",
        exchange: "TOR",
        exchangeMic: "XTSE",
        currency: "CAD",
        shortName: "Shopify",
        longName: "Shopify Inc.",
        quoteType: "EQUITY",
        index: "quotes",
        score: 100,
        typeDisplay: "Equity",
        providerId: "YAHOO",
        providerSymbol: "SHOP.TO",
      });
    });

    expect(result.current.mapping.symbolMappings["SHOP.TO"]).toBe("SHOP");
    expect(result.current.mapping.symbolMappingMeta?.["SHOP.TO"]).toMatchObject({
      exchangeMic: "XTSE",
      quoteCcy: "CAD",
      instrumentType: "EQUITY",
      providerId: "YAHOO",
      providerSymbol: "SHOP.TO",
    });
  });
});
