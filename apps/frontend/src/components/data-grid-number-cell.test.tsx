import { fireEvent, render, screen } from "@testing-library/react";
import { FormattingProvider, type UpdateCell } from "@wealthfolio/ui";
import { NumberCell } from "@wealthfolio/ui/components/data-grid/data-grid-cell-variants";
import type { Cell, TableMeta } from "@tanstack/react-table";
import { describe, expect, it, vi, type Mock } from "vitest";

interface TestRow {
  value: number | string;
}

function renderCell({
  initialValue = 1234.56,
  valueType = "number",
  isEditing = true,
  onDataUpdate = vi.fn(),
}: {
  initialValue?: number | string;
  valueType?: "number" | "string";
  isEditing?: boolean;
  onDataUpdate?: Mock<(params: UpdateCell | UpdateCell[]) => void>;
} = {}) {
  const cell = {
    getValue: () => initialValue,
    column: { columnDef: { meta: { cell: { variant: "number", valueType } } } },
    row: { original: { value: initialValue } },
  } as unknown as Cell<TestRow, unknown>;
  const tableMeta: TableMeta<TestRow> = { onDataUpdate };

  render(
    <FormattingProvider locale="de-DE">
      <NumberCell
        cell={cell}
        tableMeta={tableMeta}
        rowIndex={0}
        columnId="value"
        rowHeight="short"
        isEditing={isEditing}
        isFocused
        isSelected={false}
        isSearchMatch={false}
        isActiveSearchMatch={false}
        readOnly={false}
      />
    </FormattingProvider>,
  );

  return { onDataUpdate };
}

describe("NumberCell localized editing", () => {
  it("does not erase an untouched machine-format value", () => {
    const { onDataUpdate } = renderCell({ initialValue: 1.234 });

    fireEvent.blur(screen.getByRole("textbox"));

    expect(onDataUpdate).not.toHaveBeenCalled();
  });

  it("does not rewrite an untouched machine-format string", () => {
    const { onDataUpdate } = renderCell({ initialValue: "1.234", valueType: "string" });

    fireEvent.blur(screen.getByRole("textbox"));

    expect(onDataUpdate).not.toHaveBeenCalled();
  });

  it("commits localized decimal input", () => {
    const { onDataUpdate } = renderCell();
    const input = screen.getByRole("textbox");

    fireEvent.change(input, { target: { value: "1234,75" } });
    fireEvent.blur(input);

    expect(onDataUpdate).toHaveBeenCalledWith({ rowIndex: 0, columnId: "value", value: 1234.75 });
  });

  it("preserves the original value when non-empty input is invalid", () => {
    const { onDataUpdate } = renderCell();
    const input = screen.getByRole("textbox");

    fireEvent.change(input, { target: { value: "invalid" } });
    fireEvent.blur(input);

    expect(onDataUpdate).not.toHaveBeenCalled();
    expect(input).toHaveValue("1234.56");
  });

  it("cancels an edited value on Escape without committing it", () => {
    const { onDataUpdate } = renderCell();
    const input = screen.getByRole("textbox");

    fireEvent.change(input, { target: { value: "999,5" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onDataUpdate).not.toHaveBeenCalled();
    expect(input).toHaveValue("1234.56");
  });

  it("commits localized decimals as invariant strings without losing precision", () => {
    const { onDataUpdate } = renderCell({
      initialValue: "123456789012345678.12345678",
      valueType: "string",
    });
    const input = screen.getByRole("textbox");

    fireEvent.change(input, { target: { value: "123456789012345678,87654321" } });
    fireEvent.blur(input);

    expect(onDataUpdate).toHaveBeenCalledWith({
      rowIndex: 0,
      columnId: "value",
      value: "123456789012345678.87654321",
    });
  });

  it("restores a string-backed value when localized input is invalid", () => {
    const { onDataUpdate } = renderCell({ initialValue: "1234.56", valueType: "string" });
    const input = screen.getByRole("textbox");

    fireEvent.change(input, { target: { value: "1,23,4" } });
    fireEvent.blur(input);

    expect(onDataUpdate).not.toHaveBeenCalled();
    expect(input).toHaveValue("1234.56");
  });

  it("renders string-backed decimals without coercing their integer precision", () => {
    renderCell({
      initialValue: "123456789012345678.12345678",
      valueType: "string",
      isEditing: false,
    });

    expect(screen.getByText("123.456.789.012.345.678,12345678")).toBeInTheDocument();
  });
});
