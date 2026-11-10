import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@wealthfolio/ui/components/ui/data-table";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

interface Row {
  symbol: string;
}

const column = (id: string, label: string, enableHiding = true): ColumnDef<Row> => ({
  id,
  accessorFn: (row) => row.symbol,
  header: label,
  enableHiding,
  meta: { label },
});

// Shaped like the holdings table: a leading row label, a search-only helper column,
// a column that can't be hidden, and hideable columns.
const columns: ColumnDef<Row>[] = [
  column("symbol", "Position", false),
  column("symbolName", "Name", false),
  column("quantity", "Quantity"),
  column("marketValue", "Total Value", false),
  column("currency", "Currency"),
  { id: "actions", enableHiding: false, header: () => null, cell: () => "row-actions" },
];

const STORAGE_KEY = "column-order-test";
const ORDER_KEY = `${STORAGE_KEY}:column-order`;

const renderTable = (tableColumns = columns) =>
  render(
    <DataTable
      data={[{ symbol: "VOO" }]}
      columns={tableColumns}
      showColumnToggle
      enableColumnReordering
      storageKey={STORAGE_KEY}
      defaultColumnVisibility={{ symbolName: false, currency: false }}
    />,
  );

const headers = () =>
  screen
    .getAllByRole("columnheader")
    .map((header) => header.textContent)
    .filter(Boolean);

const lastCell = () => screen.getAllByRole("row")[1]?.lastElementChild?.textContent;

const openColumnsMenu = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: /Columns/ }));
  return screen.findByRole("menu");
};

describe("holdings column order", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("moves a column and saves the order", async () => {
    const user = userEvent.setup();
    renderTable();
    expect(headers()).toEqual(["Position", "Quantity", "Total Value"]);

    const menu = await openColumnsMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Move Quantity down" }));

    expect(headers()).toEqual(["Position", "Total Value", "Quantity"]);
    expect(JSON.parse(window.localStorage.getItem(ORDER_KEY) ?? "[]")).toEqual([
      "symbol",
      "symbolName",
      "marketValue",
      "quantity",
      "currency",
      "actions",
    ]);
    // The menu stays open so several moves can be made in a row.
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("restores a saved order and ignores ids no longer defined", () => {
    window.localStorage.setItem(
      ORDER_KEY,
      JSON.stringify(["symbol", "removedColumn", "marketValue", "quantity"]),
    );
    renderTable();

    expect(headers()).toEqual(["Position", "Total Value", "Quantity"]);
  });

  it("keeps the first column first and lists only columns that can be shown", async () => {
    const user = userEvent.setup();
    renderTable();
    const menu = await openColumnsMenu(user);

    expect(within(menu).queryByRole("menuitemcheckbox", { name: "Position" })).toBeNull();
    expect(within(menu).queryByRole("menuitemcheckbox", { name: "Name" })).toBeNull();
    // Unlabelled columns such as row actions stay where they are.
    expect(within(menu).queryByRole("menuitemcheckbox", { name: /actions/i })).toBeNull();
    // Currency is last among the movable columns, ahead of the fixed actions column.
    expect(within(menu).getByRole("menuitem", { name: "Move Currency down" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(within(menu).queryByRole("menuitem", { name: /Move Position/ })).toBeNull();
    // Total Value can't be hidden but can still be moved.
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Total Value" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(within(menu).getByRole("menuitem", { name: "Move Total Value up" })).toBeInTheDocument();
    // Quantity is already right after the first column.
    expect(within(menu).getByRole("menuitem", { name: "Move Quantity up" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("keeps the place of a column another view renders", async () => {
    const user = userEvent.setup();
    // The other view (with currency) put currency right after the first column.
    window.localStorage.setItem(
      ORDER_KEY,
      JSON.stringify(["symbol", "currency", "quantity", "marketValue"]),
    );
    renderTable(columns.filter((candidate) => candidate.id !== "currency"));

    const menu = await openColumnsMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Move Total Value up" }));

    expect(headers()).toEqual(["Position", "Total Value", "Quantity"]);
    expect(JSON.parse(window.localStorage.getItem(ORDER_KEY) ?? "[]")).toEqual([
      "symbol",
      "symbolName",
      "currency",
      "marketValue",
      "quantity",
      "actions",
    ]);
  });

  it("keeps row actions last when switching between views with different columns", async () => {
    const user = userEvent.setup();
    // Like Open and Closed holdings: each view has columns the other doesn't.
    const actionsColumn = columns[columns.length - 1];
    const closedView = [
      ...columns.filter((candidate) => candidate.id !== "quantity" && candidate !== actionsColumn),
      column("saleProceeds", "Proceeds"),
      actionsColumn,
    ];
    const view = (tableColumns: ColumnDef<Row>[]) => (
      <DataTable
        data={[{ symbol: "VOO" }]}
        columns={tableColumns}
        showColumnToggle
        enableColumnReordering
        storageKey={STORAGE_KEY}
        defaultColumnVisibility={{ symbolName: false, currency: false }}
      />
    );
    const { rerender } = render(view(columns));

    let menu = await openColumnsMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Move Total Value up" }));
    await user.keyboard("{Escape}");
    expect(headers()).toEqual(["Position", "Total Value", "Quantity"]);

    rerender(view(closedView));
    expect(headers()).toEqual(["Position", "Total Value", "Proceeds"]);
    expect(lastCell()).toBe("row-actions");

    menu = await openColumnsMenu(user);
    // Past the hidden Currency column, then past Total Value.
    await user.click(within(menu).getByRole("menuitem", { name: "Move Proceeds up" }));
    await user.click(within(menu).getByRole("menuitem", { name: "Move Proceeds up" }));
    await user.keyboard("{Escape}");
    expect(headers()).toEqual(["Position", "Proceeds", "Total Value"]);
    expect(lastCell()).toBe("row-actions");

    rerender(view(columns));
    expect(headers()).toEqual(["Position", "Total Value", "Quantity"]);
    expect(lastCell()).toBe("row-actions");
  });

  it("resets to the defined order", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(ORDER_KEY, JSON.stringify(["symbol", "marketValue", "quantity"]));
    renderTable();

    const menu = await openColumnsMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Reset column order" }));

    expect(headers()).toEqual(["Position", "Quantity", "Total Value"]);
    expect(JSON.parse(window.localStorage.getItem(ORDER_KEY) ?? "null")).toEqual([]);
  });
});
