import { DataGridCell } from "@wealthfolio/ui/components/data-grid/data-grid-cell";
import type {
  CellOpts,
  DataGridCellProps,
} from "@wealthfolio/ui/components/data-grid/data-grid-types";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

interface TestRow {
  activityType: string;
  subtype?: string;
  needsReview?: boolean;
  amount?: string;
}

function cellProps(
  cellOptions: CellOpts,
  row: TestRow,
  renderKey: boolean,
  getRenderKey?: (rowData: TestRow) => string,
): DataGridCellProps<TestRow> {
  return {
    cell: {
      getValue: () => row.activityType,
      row: { id: "activity-1", original: row },
      column: { columnDef: { meta: { cell: cellOptions, renderKey, getRenderKey } } },
    },
    tableMeta: {},
    rowIndex: 0,
    columnId: "activityType",
    rowHeight: "short",
    isFocused: false,
    isEditing: false,
    isSelected: false,
    isSearchMatch: false,
    isActiveSearchMatch: false,
    readOnly: false,
  } as unknown as DataGridCellProps<TestRow>;
}

describe("DataGridCell memoization", () => {
  it("re-renders an unchanged value when its column renderer changes", () => {
    const row = { activityType: "INTEREST" };
    const visibleSubtypeOptions: CellOpts = {
      variant: "select",
      options: [],
      valueRenderer: () => "Interest",
    };
    const hiddenSubtypeOptions: CellOpts = {
      variant: "select",
      options: [],
      valueRenderer: () => "Interest · Staking reward",
    };

    const { rerender } = render(<DataGridCell {...cellProps(visibleSubtypeOptions, row, false)} />);
    expect(screen.getByText("Interest")).toBeInTheDocument();

    rerender(<DataGridCell {...cellProps(hiddenSubtypeOptions, row, true)} />);
    expect(screen.getByText("Interest · Staking reward")).toBeInTheDocument();
  });

  it("does not re-render for an equivalent options object when the render key is unchanged", () => {
    const row = { activityType: "INTEREST" };
    const valueRenderer = vi.fn(() => "Interest");
    const firstOptions: CellOpts = { variant: "select", options: [], valueRenderer };
    const equivalentOptions: CellOpts = { variant: "select", options: [], valueRenderer };

    const { rerender } = render(<DataGridCell {...cellProps(firstOptions, row, false)} />);
    expect(valueRenderer).toHaveBeenCalledTimes(1);

    rerender(<DataGridCell {...cellProps(equivalentOptions, row, false)} />);
    expect(valueRenderer).toHaveBeenCalledTimes(1);
  });

  it("re-renders when an opted-in row dependency changes", () => {
    const valueRenderer = vi.fn((_value, _option, rowData) => {
      const row = rowData as TestRow;
      return `Interest · ${row.subtype}`;
    });
    const cellOptions: CellOpts = { variant: "select", options: [], valueRenderer };
    const getRenderKey = (row: TestRow) =>
      JSON.stringify([row.subtype ?? null, row.needsReview, false]);

    const { rerender } = render(
      <DataGridCell
        {...cellProps(
          cellOptions,
          { activityType: "INTEREST", subtype: "STAKING_REWARD", needsReview: true },
          true,
          getRenderKey,
        )}
      />,
    );
    expect(screen.getByText("Interest · STAKING_REWARD")).toBeInTheDocument();

    rerender(
      <DataGridCell
        {...cellProps(
          cellOptions,
          { activityType: "INTEREST", subtype: "CASH_INTEREST", needsReview: true },
          true,
          getRenderKey,
        )}
      />,
    );

    expect(screen.getByText("Interest · CASH_INTEREST")).toBeInTheDocument();
    expect(valueRenderer).toHaveBeenCalledTimes(2);
  });

  it("keeps the cell memoized when an unrelated row field changes", () => {
    const valueRenderer = vi.fn(() => "Interest · Staking reward");
    const cellOptions: CellOpts = { variant: "select", options: [], valueRenderer };
    const getRenderKey = (row: TestRow) =>
      JSON.stringify([row.subtype ?? null, row.needsReview, false]);

    const { rerender } = render(
      <DataGridCell
        {...cellProps(
          cellOptions,
          {
            activityType: "INTEREST",
            subtype: "STAKING_REWARD",
            needsReview: true,
            amount: "10",
          },
          true,
          getRenderKey,
        )}
      />,
    );

    rerender(
      <DataGridCell
        {...cellProps(
          cellOptions,
          {
            activityType: "INTEREST",
            subtype: "STAKING_REWARD",
            needsReview: true,
            amount: "20",
          },
          true,
          getRenderKey,
        )}
      />,
    );

    expect(valueRenderer).toHaveBeenCalledTimes(1);
  });
  it("keeps FX rows read-only even if keyboard navigation requests editing", () => {
    const props = cellProps({ variant: "short-text" }, { activityType: "FX_EXCHANGE" }, false);
    props.isEditing = true;
    props.cell.column.columnDef.meta!.isReadOnly = (row) => row.activityType === "FX_EXCHANGE";
    render(<DataGridCell {...props} />);
    expect(screen.getByRole("textbox")).toHaveAttribute("contenteditable", "false");
    expect(screen.getByText("FX_EXCHANGE")).toBeInTheDocument();
  });
});
