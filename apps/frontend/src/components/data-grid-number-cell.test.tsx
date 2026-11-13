import { fireEvent, render, screen } from "@testing-library/react";
import { DirectionProvider, FormattingProvider, type UpdateCell } from "@wealthfolio/ui";
import { NumberCell } from "@wealthfolio/ui/components/data-grid/data-grid-cell-variants";
import type { Cell, TableMeta } from "@tanstack/react-table";
import { useState } from "react";
import { describe, expect, it, vi, type Mock } from "vitest";

interface TestRow {
  value: number | string;
}

function renderCell({
  initialValue = 1234.56,
  valueType = "number",
  isEditing = true,
  onDataUpdate = vi.fn(),
  locale = "de-DE",
  direction = "ltr",
}: {
  locale?: string;
  direction?: "ltr" | "rtl";
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

  const view = (nextLocale: string) => (
    <DirectionProvider direction={direction}>
      <FormattingProvider locale={nextLocale}>
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
      </FormattingProvider>
    </DirectionProvider>
  );
  const { rerender } = render(view(locale));

  return { onDataUpdate, changeLocale: (nextLocale: string) => rerender(view(nextLocale)) };
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
    expect(input).toHaveValue("1234,56");
  });

  it("cancels an edited value on Escape without committing it", () => {
    const { onDataUpdate } = renderCell();
    const input = screen.getByRole("textbox");

    fireEvent.change(input, { target: { value: "999,5" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onDataUpdate).not.toHaveBeenCalled();
    expect(input).toHaveValue("1234,56");
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
    expect(input).toHaveValue("1234,56");
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

for (const valueType of ["number", "string"] as const)
  for (const direction of ["ltr", "rtl"] as const) {
    it.each(["blur", "Enter", "Tab"])(
      `${valueType} ${direction} last digit edit preserves the decimal on %s`,
      (commit) => {
        const { onDataUpdate } = renderCell({
          initialValue: valueType === "string" ? "1.125" : 1.125,
          valueType,
          direction,
        });
        const input = screen.getByRole<HTMLInputElement>("textbox");
        expect(input).toHaveValue("1,125");
        fireEvent.change(input, { target: { value: input.value.replace(/5$/, "6") } });
        if (commit === "blur") fireEvent.blur(input);
        else fireEvent.keyDown(input, { key: commit });
        expect(onDataUpdate).toHaveBeenCalledWith({
          rowIndex: 0,
          columnId: "value",
          value: valueType === "string" ? "1.126" : 1.126,
        });
      },
    );
    it(`${valueType} ${direction} preserves an edited draft's interpretation across a region change`, () => {
      const { onDataUpdate, changeLocale } = renderCell({
        initialValue: valueType === "string" ? "1.125" : 1.125,
        valueType,
        direction,
      });
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "1,126" } });
      changeLocale("en-US");
      expect(screen.getByRole("textbox")).toHaveValue("1,126");
      fireEvent.blur(screen.getByRole("textbox"));
      expect(onDataUpdate).toHaveBeenCalledWith({
        rowIndex: 0,
        columnId: "value",
        value: valueType === "string" ? "1.126" : 1.126,
      });
    });
  }
it("opens decimal-string editors with their full exact regional text", () => {
  renderCell({ initialValue: "123456789012345678.123456780000", valueType: "string" });
  expect(screen.getByRole("textbox")).toHaveValue("123456789012345678,123456780000");
});

interface StatefulCellProps {
  locale: string;
  valueType: "number" | "string";
  onDataUpdate: Mock<(params: UpdateCell | UpdateCell[]) => void>;
  initiallyEditing?: boolean;
}
function StatefulCell({
  locale,
  valueType,
  onDataUpdate,
  initiallyEditing = true,
}: StatefulCellProps) {
  const [isEditing, setIsEditing] = useState(initiallyEditing);
  const initialValue = valueType === "string" ? "1.125" : 1.125;
  const cell = {
    getValue: () => initialValue,
    column: { columnDef: { meta: { cell: { variant: "number", valueType } } } },
    row: { original: { value: initialValue } },
  } as unknown as Cell<TestRow, unknown>;
  return (
    <FormattingProvider locale={locale}>
      <NumberCell
        cell={cell}
        tableMeta={{
          onDataUpdate,
          onCellEditingStart: () => setIsEditing(true),
          onCellEditingStop: () => setIsEditing(false),
        }}
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
      <button onClick={() => setIsEditing(false)}>Finish editing</button>
    </FormattingProvider>
  );
}
for (const valueType of ["number", "string"] as const) {
  it.each(["blur", "Enter", "Tab"])(
    `${valueType}: invalid input after a region change cannot commit during %s or stop-edit`,
    (commit) => {
      const onDataUpdate = vi.fn();
      const { rerender } = render(
        <StatefulCell locale="de-DE" valueType={valueType} onDataUpdate={onDataUpdate} />,
      );
      rerender(<StatefulCell locale="en-US" valueType={valueType} onDataUpdate={onDataUpdate} />);
      const input = screen.getByRole("textbox");
      fireEvent.change(input, { target: { value: "abc" } });
      if (commit === "blur") fireEvent.blur(input);
      else fireEvent.keyDown(input, { key: commit });
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(onDataUpdate).not.toHaveBeenCalled();
      expect(screen.getByText("1.125")).toBeInTheDocument();
    },
  );
  it(`${valueType}: stop-edit keeps a valid draft's source region then resets the next editor`, () => {
    const onDataUpdate = vi.fn();
    const { rerender } = render(
      <StatefulCell locale="de-DE" valueType={valueType} onDataUpdate={onDataUpdate} />,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "1,126" } });
    rerender(<StatefulCell locale="en-US" valueType={valueType} onDataUpdate={onDataUpdate} />);
    fireEvent.click(screen.getByText("Finish editing"));
    expect(onDataUpdate).toHaveBeenCalledWith({
      rowIndex: 0,
      columnId: "value",
      value: valueType === "string" ? "1.126" : 1.126,
    });
    fireEvent.keyDown(screen.getByRole("button", { name: "1.125" }), { key: "F2" });
    expect(screen.getByRole("textbox")).toHaveValue("1.125");
  });
  it(`${valueType}: typing to start survives the inactive reset effect`, () => {
    const onDataUpdate = vi.fn();
    render(
      <StatefulCell
        locale="de-DE"
        valueType={valueType}
        onDataUpdate={onDataUpdate}
        initiallyEditing={false}
      />,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "1,125" }), { key: "7" });
    expect(screen.getByRole("textbox")).toHaveValue("7");
    fireEvent.blur(screen.getByRole("textbox"));
    expect(onDataUpdate).toHaveBeenCalledWith({
      rowIndex: 0,
      columnId: "value",
      value: valueType === "string" ? "7" : 7,
    });
  });
}
