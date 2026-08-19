import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@wealthfolio/ui/components/ui/data-table";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

interface TestHolding {
  symbol: string;
  holdingType: string;
}

const columns: ColumnDef<TestHolding>[] = [
  {
    accessorKey: "symbol",
    header: "Symbol",
    cell: ({ getValue }) => <span data-testid="symbol-cell">{getValue<string>()}</span>,
  },
  { accessorKey: "holdingType", header: "Type" },
];

describe("holdings desktop toolbar", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("orders status before search and keeps display controls on the right", () => {
    const { container } = render(
      <DataTable
        data={[{ symbol: "VOO", holdingType: "ETF" }]}
        columns={columns}
        searchBy="symbol"
        filters={[
          {
            id: "holdingType",
            title: "Type",
            options: [{ value: "ETF", label: "ETF" }],
          },
        ]}
        toolbarView={<button data-testid="position-status">Open | Closed</button>}
        toolbarActions={<button>Currency</button>}
        showColumnToggle
      />,
    );

    const controls = Array.from(container.querySelectorAll("button, input"));
    const status = screen.getByTestId("position-status");
    const search = screen.getByRole("textbox");
    const type = screen.getByRole("button", { name: "Type" });
    const currency = screen.getByRole("button", { name: "Currency" });
    const columnToggle = screen.getByRole("button", { name: /Columns/ });

    expect(controls.indexOf(status)).toBeLessThan(controls.indexOf(search));
    expect(controls.indexOf(search)).toBeLessThan(controls.indexOf(type));
    expect(controls.indexOf(type)).toBeLessThan(controls.indexOf(currency));
    expect(controls.indexOf(currency)).toBeLessThan(controls.indexOf(columnToggle));
  });

  it("falls back to the default sorting for a removed view column without discarding it", async () => {
    window.localStorage.setItem(
      "holdings-sorting-test:sorting",
      JSON.stringify([{ id: "marketValue", desc: true }]),
    );

    render(
      <DataTable
        data={[
          { symbol: "ZZZ", holdingType: "ETF" },
          { symbol: "AAA", holdingType: "STOCK" },
        ]}
        columns={columns}
        defaultSorting={[{ id: "symbol", desc: false }]}
        storageKey="holdings-sorting-test"
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId("symbol-cell").map((cell) => cell.textContent)).toEqual([
        "AAA",
        "ZZZ",
      ]);
    });

    // The stored sort belongs to the other view and must survive this render, so
    // returning to that view restores it instead of silently resetting to the default.
    expect(
      JSON.parse(window.localStorage.getItem("holdings-sorting-test:sorting") ?? "[]"),
    ).toEqual([{ id: "marketValue", desc: true }]);
  });

  it("restores the stored sorting when its column comes back", async () => {
    const marketValueColumn: ColumnDef<TestHolding> = {
      id: "marketValue",
      accessorFn: (row) => (row.symbol === "AAA" ? 1 : 2),
      header: "Market Value",
    };
    window.localStorage.setItem(
      "holdings-sorting-test:sorting",
      JSON.stringify([{ id: "marketValue", desc: true }]),
    );
    const data = [
      { symbol: "AAA", holdingType: "STOCK" },
      { symbol: "ZZZ", holdingType: "ETF" },
    ];
    const view = (withMarketValue: boolean) => (
      <DataTable
        data={data}
        columns={withMarketValue ? [...columns, marketValueColumn] : columns}
        defaultSorting={[{ id: "symbol", desc: false }]}
        storageKey="holdings-sorting-test"
      />
    );

    const { rerender } = render(view(true));
    await waitFor(() => {
      expect(screen.getAllByTestId("symbol-cell").map((cell) => cell.textContent)).toEqual([
        "ZZZ",
        "AAA",
      ]);
    });

    // Switch to the view without the column, then back again.
    rerender(view(false));
    rerender(view(true));

    await waitFor(() => {
      expect(screen.getAllByTestId("symbol-cell").map((cell) => cell.textContent)).toEqual([
        "ZZZ",
        "AAA",
      ]);
    });
  });

  it("sorts by a leaf column nested inside a column group", async () => {
    interface GroupedRow {
      symbol: string;
      value: number;
    }
    const groupedColumns: ColumnDef<GroupedRow>[] = [
      {
        id: "group",
        header: "Group",
        columns: [
          {
            id: "symbol",
            accessorFn: (row) => row.symbol,
            header: "Symbol",
            cell: ({ getValue }) => <span data-testid="symbol-cell">{getValue<string>()}</span>,
          },
          { id: "value", accessorFn: (row) => row.value, header: "Value" },
        ],
      },
    ];
    window.localStorage.setItem(
      "grouped-sorting-test:sorting",
      JSON.stringify([{ id: "value", desc: true }]),
    );

    render(
      <DataTable
        data={[
          { symbol: "AAA", value: 1 },
          { symbol: "ZZZ", value: 2 },
        ]}
        columns={groupedColumns}
        defaultSorting={[{ id: "symbol", desc: false }]}
        storageKey="grouped-sorting-test"
      />,
    );

    // Group defs carry no accessor of their own; their leaves are the sortable columns.
    await waitFor(() => {
      expect(screen.getAllByTestId("symbol-cell").map((cell) => cell.textContent)).toEqual([
        "ZZZ",
        "AAA",
      ]);
    });
  });

  it("keeps the supported half of a partially unsupported stored sort", async () => {
    window.localStorage.setItem(
      "holdings-sorting-test:sorting",
      JSON.stringify([
        { id: "holdingType", desc: true },
        { id: "marketValue", desc: true },
      ]),
    );

    render(
      <DataTable
        data={[
          { symbol: "AAA", holdingType: "ETF" },
          { symbol: "ZZZ", holdingType: "STOCK" },
        ]}
        columns={columns}
        defaultSorting={[{ id: "symbol", desc: false }]}
        storageKey="holdings-sorting-test"
      />,
    );

    // holdingType survives and wins; only the absent marketValue entry is dropped, so the
    // default (symbol asc) must NOT take over.
    await waitFor(() => {
      expect(screen.getAllByTestId("symbol-cell").map((cell) => cell.textContent)).toEqual([
        "ZZZ",
        "AAA",
      ]);
    });
  });

  it("keeps sorting for a column whose id tanstack takes from its string header", async () => {
    const headerIdColumns: ColumnDef<TestHolding>[] = [
      {
        accessorFn: (row) => row.symbol,
        header: "Symbol",
        cell: ({ getValue }) => <span data-testid="symbol-cell">{getValue<string>()}</span>,
      },
    ];
    window.localStorage.setItem(
      "header-id-test:sorting",
      JSON.stringify([{ id: "Symbol", desc: true }]),
    );

    render(
      <DataTable
        data={[
          { symbol: "AAA", holdingType: "ETF" },
          { symbol: "ZZZ", holdingType: "STOCK" },
        ]}
        columns={headerIdColumns}
        storageKey="header-id-test"
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId("symbol-cell").map((cell) => cell.textContent)).toEqual([
        "ZZZ",
        "AAA",
      ]);
    });
  });

  it("keeps sorting for columns whose id tanstack derives for them", async () => {
    interface NestedHolding {
      nested: { value: number };
      symbol: string;
    }
    // No explicit ids: tanstack derives "nested_value" from the dotted accessor key and
    // "Symbol" from the string header.
    const derivedIdColumns: ColumnDef<NestedHolding>[] = [
      { accessorKey: "nested.value", header: "Value" },
      {
        accessorFn: (row) => row.symbol,
        header: "Symbol",
        cell: ({ getValue }) => <span data-testid="symbol-cell">{getValue<string>()}</span>,
      },
    ];
    window.localStorage.setItem(
      "derived-id-test:sorting",
      JSON.stringify([{ id: "nested_value", desc: true }]),
    );

    render(
      <DataTable
        data={[
          { symbol: "AAA", nested: { value: 1 } },
          { symbol: "ZZZ", nested: { value: 2 } },
        ]}
        columns={derivedIdColumns}
        defaultSorting={[{ id: "Symbol", desc: false }]}
        storageKey="derived-id-test"
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId("symbol-cell").map((cell) => cell.textContent)).toEqual([
        "ZZZ",
        "AAA",
      ]);
    });
  });
});
