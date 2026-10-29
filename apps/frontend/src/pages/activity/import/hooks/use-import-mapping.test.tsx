import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { ImportFormat } from "@/lib/constants";
import { ActivityType, ImportType } from "@/lib/types";
import {
  CASH_TRANSACTION_IMPORT_PROFILE,
  CREDIT_CARD_TRANSACTION_IMPORT_PROFILE,
  DEFAULT_ACTIVITY_IMPORT_PROFILE,
} from "../utils/activity-import-profile";
import {
  computeFieldMappings,
  initializeColumnMapping,
  useImportMapping,
} from "./use-import-mapping";

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("CSV column auto-mapping", () => {
  const bankHeaders = [
    "Transaction Date",
    "Transaction Type",
    "Sort Code",
    "Account Number",
    "Transaction Description",
    "Debit Amount",
    "Credit Amount",
    "Balance",
  ];
  const canonicalHeaders = ["date", "account", "amount", "activityType", "subtype", "comment"];

  const profiles = [
    { name: "investment", profile: DEFAULT_ACTIVITY_IMPORT_PROFILE },
    { name: "cash", profile: CASH_TRANSACTION_IMPORT_PROFILE },
    { name: "credit card", profile: CREDIT_CARD_TRANSACTION_IMPORT_PROFILE },
  ];

  describe.each(profiles)("$name imports", ({ profile }) => {
    it.each(["appended", "prepended"])(
      "prefers canonical columns when they are %s to bank columns",
      (position) => {
        const headers =
          position === "appended"
            ? [...bankHeaders, ...canonicalHeaders]
            : [...canonicalHeaders, ...bankHeaders];

        expect(computeFieldMappings(headers, undefined, profile)).toEqual({
          date: "date",
          account: "account",
          amount: "amount",
          activityType: "activityType",
          subtype: "subtype",
          comment: "comment",
        });
      },
    );

    it("matches canonical names ignoring case and surrounding whitespace", () => {
      expect(
        computeFieldMappings(
          [...bankHeaders, " DATE ", " ACTIVITYTYPE ", " Amount ", " COMMENT "],
          undefined,
          profile,
        ),
      ).toMatchObject({
        date: " DATE ",
        activityType: " ACTIVITYTYPE ",
        amount: " Amount ",
        comment: " COMMENT ",
      });
    });

    it("preserves explicit saved mappings over canonical columns", () => {
      const saved = {
        date: "Transaction Date",
        account: "Account Number",
        activityType: "Transaction Type",
        comment: "Transaction Description",
        amount: ["Debit Amount", "Credit Amount"],
      };

      expect(
        computeFieldMappings([...bankHeaders, ...canonicalHeaders], saved, profile),
      ).toMatchObject(saved);
    });

    it("falls back to auto-detection when a saved column is missing", () => {
      expect(
        computeFieldMappings(
          [...bankHeaders, ...canonicalHeaders],
          { date: "Missing Date", amount: ["Missing Debit", "Missing Credit"] },
          profile,
        ),
      ).toMatchObject({ date: "date", amount: "amount" });
    });
  });

  it("prefers canonical investment fields over earlier aliases", () => {
    expect(
      initializeColumnMapping(["Ticker", "Price", "Total", "symbol", "unitPrice", "amount"]),
    ).toEqual({ symbol: "symbol", unitPrice: "unitPrice", amount: "amount" });
  });

  it("continues matching exact, word-boundary, and substring aliases without canonical columns", () => {
    expect(
      initializeColumnMapping([
        "TransactionDateUTC",
        "Transaction Type",
        "Trade Currency (ISO)",
        "Net Amount",
        "Memo",
      ]),
    ).toEqual({
      date: "TransactionDateUTC",
      activityType: "Transaction Type",
      currency: "Trade Currency (ISO)",
      amount: "Net Amount",
      comment: "Memo",
    });
  });

  it.each([CASH_TRANSACTION_IMPORT_PROFILE, CREDIT_CARD_TRANSACTION_IMPORT_PROFILE])(
    "preserves debit/credit fallbacks when there is no canonical amount ($label)",
    (profile) => {
      expect(
        computeFieldMappings(
          ["Date", "Debit Amount", "Credit Amount", "Market Value"],
          undefined,
          profile,
        ),
      ).toEqual({ date: "Date", amount: ["Debit Amount", "Credit Amount"] });
    },
  );
});

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
