import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HoldingType, QuoteMode } from "@/lib/constants";
import type { Holding } from "@/lib/types";
import type { ReactNode } from "react";

import { HoldingsTable } from "./holdings-table";

vi.mock("@wealthfolio/ui/components/ui/data-table", () => ({
  DataTable: ({
    columns,
    data,
    defaultColumnVisibility,
    pinRowsToTop,
  }: {
    columns: {
      id?: string;
      accessorFn?: (row: Holding, index: number) => unknown;
      cell?: (context: { row: { original: Holding } }) => ReactNode;
      footer?: (context: {
        table: { getFilteredRowModel: () => { rows: { original: Holding }[] } };
      }) => ReactNode;
      meta?: { label?: string };
      filterFn?: (
        row: { getValue: (id: string) => unknown },
        id: string,
        value: string[],
      ) => boolean;
    }[];
    data: Holding[];
    defaultColumnVisibility?: Record<string, boolean>;
    pinRowsToTop?: (row: Holding) => boolean;
  }) => {
    const getValue = (id: string) =>
      data[0] == null
        ? undefined
        : columns.find((column) => column.id === id)?.accessorFn?.(data[0], 0);
    const getNumericValue = (id: string) => {
      const value = getValue(id);
      return typeof value === "number" ? value : "";
    };
    const holdingTypeColumn = columns.find((column) => column.id === "holdingType");
    const holdingTypeCell =
      data[0] && holdingTypeColumn?.cell
        ? holdingTypeColumn.cell({ row: { original: data[0] } })
        : null;
    const realizedReturnColumn = columns.find((column) => column.id === "realizedReturn");
    const realizedReturnCell =
      data[0] && realizedReturnColumn?.cell
        ? realizedReturnColumn.cell({ row: { original: data[0] } })
        : null;
    const matchesHoldingType = (value: string) =>
      holdingTypeColumn?.filterFn?.({ getValue: () => getValue("holdingType") }, "holdingType", [
        value,
      ]) ?? false;
    const renderFooter = (id: string) => {
      const footer = columns.find((column) => column.id === id)?.footer;
      if (!footer) return null;
      return footer({
        table: { getFilteredRowModel: () => ({ rows: data.map((original) => ({ original })) }) },
      });
    };

    return (
      <div>
        <div data-testid="column-ids">{columns.map((column) => column.id).join(",")}</div>
        <div data-testid="symbol-name-hidden">
          {String(defaultColumnVisibility?.symbolName === false)}
        </div>
        <div data-testid="closed-cost-basis">{getNumericValue("closedCostBasis")}</div>
        <div data-testid="sale-proceeds">{getNumericValue("saleProceeds")}</div>
        <div data-testid="closing-cash-flow-label">
          {columns.find((column) => column.id === "saleProceeds")?.meta?.label}
        </div>
        <div data-testid="realized-return-cell">{realizedReturnCell}</div>
        <div data-testid="holding-type-cell">{holdingTypeCell}</div>
        <div data-testid="parent-type-match">{matchesHoldingType("FUND") ? "true" : "false"}</div>
        <div data-testid="exact-type-match">
          {matchesHoldingType("FUND_MUTUAL") ? "true" : "false"}
        </div>
        <div data-testid="cash-pinning">{String(data[0] && pinRowsToTop?.(data[0]))}</div>
        <div data-testid="market-value-total">{renderFooter("marketValue")}</div>
        <div data-testid="total-pnl-total">{renderFooter("totalPnl")}</div>
        <div data-testid="symbol-footer">{renderFooter("symbol")}</div>
      </div>
    );
  },
}));

vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "USD" } }),
}));

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => vi.fn(),
}));

describe("HoldingsTable columns", () => {
  it("uses market columns for open positions", () => {
    render(<HoldingsTable holdings={[]} isLoading={false} visibilityFilters={["open"]} />);

    const columnIds = screen.getByTestId("column-ids").textContent;
    expect(columnIds).toContain("marketPrice");
    expect(columnIds).toContain("marketValue");
    expect(columnIds).not.toContain("saleProceeds");
  });

  it("uses realized-performance columns for closed positions", () => {
    render(<HoldingsTable holdings={[]} isLoading={false} visibilityFilters={["closed"]} />);

    expect(screen.getByTestId("column-ids")).toHaveTextContent(
      [
        "symbol",
        "closedCostBasis",
        "saleProceeds",
        "closedRealizedPnl",
        "realizedReturn",
        "symbolName",
        "holdingType",
        "currency",
        "actions",
      ].join(","),
    );
    expect(screen.getByTestId("symbol-name-hidden")).toHaveTextContent("true");
  });

  it("derives closing cash flow from disposed cost basis and realized gain", () => {
    const holding: Holding = {
      id: "closed-position",
      accountId: "account-1",
      holdingType: HoldingType.SECURITY,
      isClosed: true,
      quantity: 0,
      localCurrency: "USD",
      baseCurrency: "USD",
      marketValue: { local: 0, base: 0 },
      costBasis: { local: 0, base: 0 },
      returnBasis: { local: 100, base: 125 },
      realizedGain: { local: 20, base: 25 },
      weight: 0,
      asOfDate: "2026-08-18",
    };

    render(<HoldingsTable holdings={[holding]} isLoading={false} visibilityFilters={["closed"]} />);

    expect(screen.getByTestId("closed-cost-basis")).toHaveTextContent("125");
    expect(screen.getByTestId("sale-proceeds")).toHaveTextContent("150");
    expect(screen.getByTestId("closing-cash-flow-label")).toHaveTextContent("Closing Cash Flow");
    expect(screen.getByTestId("realized-return-cell")).toHaveTextContent("—");
  });

  it("keeps the closing cash flow signed for a closed short position", () => {
    const holding: Holding = {
      id: "closed-short-position",
      accountId: "account-1",
      holdingType: HoldingType.SECURITY,
      isClosed: true,
      quantity: 0,
      localCurrency: "USD",
      baseCurrency: "USD",
      marketValue: { local: 0, base: 0 },
      costBasis: { local: 0, base: 0 },
      returnBasis: { local: -1000, base: -1000 },
      realizedGain: { local: 200, base: 200 },
      realizedGainPct: 0.2,
      weight: 0,
      asOfDate: "2026-08-18",
    };

    render(<HoldingsTable holdings={[holding]} isLoading={false} visibilityFilters={["closed"]} />);

    expect(screen.getByTestId("closed-cost-basis")).toHaveTextContent("-1000");
    expect(screen.getByTestId("sale-proceeds")).toHaveTextContent("-800");
  });

  it("renders a localized asset type and matches its taxonomy key exactly", () => {
    const holding: Holding = {
      id: "mutual-fund",
      accountId: "account-1",
      holdingType: HoldingType.SECURITY,
      quantity: 1,
      localCurrency: "USD",
      baseCurrency: "USD",
      marketValue: { local: 100, base: 100 },
      weight: 1,
      asOfDate: "2026-08-18",
      instrument: {
        id: "asset-mutual-fund",
        symbol: "FUND",
        currency: "USD",
        quoteMode: QuoteMode.MARKET,
        classifications: {
          assetType: {
            id: "FUND_MUTUAL",
            taxonomyId: "instrument_type",
            name: "Mutual Fund",
            key: "FUND_MUTUAL",
            color: "#000000",
            sortOrder: 1,
            createdAt: "2026-08-18",
            updatedAt: "2026-08-18",
          },
          assetClasses: [],
          sectors: [],
          regions: [],
          customGroups: [],
        },
      },
    };

    render(<HoldingsTable holdings={[holding]} isLoading={false} visibilityFilters={["open"]} />);

    expect(screen.getByTestId("holding-type-cell")).toHaveTextContent("Mutual Fund");
    expect(screen.getByTestId("parent-type-match")).toHaveTextContent("false");
    expect(screen.getByTestId("exact-type-match")).toHaveTextContent("true");
  });

  it("totals market value and P&L in base currency across mixed-currency holdings", () => {
    const usHolding: Holding = {
      id: "us-stock",
      accountId: "account-1",
      holdingType: HoldingType.SECURITY,
      quantity: 10,
      localCurrency: "USD",
      baseCurrency: "USD",
      marketValue: { local: 100, base: 100 },
      totalGain: { local: 20, base: 20 },
      weight: 0.25,
      asOfDate: "2026-08-20",
    };
    const euHolding: Holding = {
      id: "eu-stock",
      accountId: "account-1",
      holdingType: HoldingType.SECURITY,
      quantity: 5,
      localCurrency: "EUR",
      baseCurrency: "USD",
      fxRate: 1.1,
      // Foreign holding: local is EUR, base is the already-converted USD value.
      marketValue: { local: 200, base: 220 },
      totalGain: { local: 30, base: 33 },
      weight: 0.55,
      asOfDate: "2026-08-20",
    };

    render(
      <HoldingsTable
        holdings={[usHolding, euHolding]}
        isLoading={false}
        visibilityFilters={["open"]}
      />,
    );

    // 100 (USD) + 220 (EUR→USD base) = 320
    expect(screen.getByTestId("market-value-total")).toHaveTextContent("320");
    // 20 + 33 = 53
    expect(screen.getByTestId("total-pnl-total")).toHaveTextContent("53");
    expect(screen.getByTestId("symbol-footer")).toHaveTextContent("Total");
  });

  it("excludes closed positions from the market value total", () => {
    const openHolding: Holding = {
      id: "open-stock",
      accountId: "account-1",
      holdingType: HoldingType.SECURITY,
      quantity: 10,
      localCurrency: "USD",
      baseCurrency: "USD",
      marketValue: { local: 100, base: 100 },
      weight: 1,
      asOfDate: "2026-08-20",
    };
    const closedHolding: Holding = {
      id: "closed-stock",
      accountId: "account-1",
      holdingType: HoldingType.SECURITY,
      isClosed: true,
      quantity: 0,
      localCurrency: "USD",
      baseCurrency: "USD",
      marketValue: { local: 999, base: 999 },
      weight: 0,
      asOfDate: "2026-08-20",
    };

    render(
      <HoldingsTable
        holdings={[openHolding, closedHolding]}
        isLoading={false}
        visibilityFilters={["open"]}
      />,
    );

    const total = screen.getByTestId("market-value-total").textContent ?? "";
    expect(total).toContain("100");
    expect(total).not.toContain("999");
    expect(total).not.toContain("1,099");
  });

  it("does not pin cash rows above an explicit column sort", () => {
    const cashHolding: Holding = {
      id: "cash-usd",
      accountId: "account-1",
      holdingType: HoldingType.CASH,
      quantity: 100,
      localCurrency: "USD",
      baseCurrency: "USD",
      marketValue: { local: 100, base: 100 },
      weight: 0.1,
      asOfDate: "2026-08-20",
    };

    render(
      <HoldingsTable holdings={[cashHolding]} isLoading={false} visibilityFilters={["open"]} />,
    );

    expect(screen.getByTestId("cash-pinning")).toHaveTextContent("undefined");
  });
});
