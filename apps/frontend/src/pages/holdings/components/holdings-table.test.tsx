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
  }: {
    columns: {
      id?: string;
      accessorFn?: (row: Holding, index: number) => unknown;
      cell?: (context: { row: { original: Holding } }) => ReactNode;
      meta?: { label?: string };
      filterFn?: (
        row: { getValue: (id: string) => unknown },
        id: string,
        value: string[],
      ) => boolean;
    }[];
    data: Holding[];
    defaultColumnVisibility?: Record<string, boolean>;
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
});
