import { DataGridCell } from "@wealthfolio/ui/components/data-grid/data-grid-cell";
import type {
  CellOpts,
  DataGridCellProps,
} from "@wealthfolio/ui/components/data-grid/data-grid-types";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

interface TestRow {
  categoryId: string;
  locked: boolean;
}

const OPTIONS: CellOpts = {
  variant: "select",
  options: [
    { value: "food", label: "Food" },
    { value: "rent", label: "Rent" },
  ],
  isDisabled: (rowData) => (rowData as TestRow).locked,
};

function cellProps(
  row: TestRow,
  state: { isFocused?: boolean; isEditing?: boolean },
  tableMeta: Record<string, unknown>,
): DataGridCellProps<TestRow> {
  return {
    cell: {
      getValue: () => row.categoryId,
      row: { id: "activity-1", original: row },
      column: { columnDef: { meta: { cell: OPTIONS } } },
    },
    tableMeta,
    rowIndex: 0,
    columnId: "categoryId",
    rowHeight: "short",
    isFocused: state.isFocused ?? false,
    isEditing: state.isEditing ?? false,
    isSelected: false,
    isSearchMatch: false,
    isActiveSearchMatch: false,
    readOnly: false,
  } as unknown as DataGridCellProps<TestRow>;
}

describe("DataGrid select cell", () => {
  it("does not start editing a disabled cell", () => {
    const onCellEditingStart = vi.fn();
    render(
      <DataGridCell
        {...cellProps(
          { categoryId: "food", locked: true },
          { isFocused: true },
          { onCellEditingStart },
        )}
      />,
    );
    fireEvent.click(screen.getByText("Food"));
    fireEvent.keyDown(screen.getByText("Food"), { key: "Enter" });
    expect(onCellEditingStart).not.toHaveBeenCalled();
  });

  it("starts editing an enabled cell", () => {
    const onCellEditingStart = vi.fn();
    render(
      <DataGridCell
        {...cellProps(
          { categoryId: "food", locked: false },
          { isFocused: true },
          { onCellEditingStart },
        )}
      />,
    );
    fireEvent.click(screen.getByText("Food"));
    expect(onCellEditingStart).toHaveBeenCalledWith(0, "categoryId");
  });

  it("keeps a disabled cell closed even when editing reaches it", () => {
    render(
      <DataGridCell
        {...cellProps({ categoryId: "food", locked: true }, { isEditing: true }, {})}
      />,
    );
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("shows the row's value again when the grid refuses a pick", async () => {
    const row = { categoryId: "food", locked: false };
    // The grid refuses the update: the row keeps its value.
    const tableMeta = { onDataUpdate: vi.fn(), onCellEditingStop: vi.fn() };
    const { rerender } = render(
      <DataGridCell {...cellProps(row, { isFocused: true, isEditing: true }, tableMeta)} />,
    );
    await userEvent.click(await screen.findByRole("option", { name: "Rent" }));
    expect(tableMeta.onDataUpdate).toHaveBeenCalledWith({
      rowIndex: 0,
      columnId: "categoryId",
      value: "rent",
    });

    rerender(<DataGridCell {...cellProps(row, { isFocused: true }, tableMeta)} />);
    expect(screen.getByText("Food")).toBeInTheDocument();
    expect(screen.queryByText("Rent")).not.toBeInTheDocument();

    // Reopened, the editor starts from the row's value, not the refused pick.
    rerender(<DataGridCell {...cellProps(row, { isFocused: true, isEditing: true }, tableMeta)} />);
    expect(await screen.findByRole("option", { name: "Food", selected: true })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Rent", selected: false })).toBeInTheDocument();
  });
});
