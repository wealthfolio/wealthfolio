import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FormattingProvider, useDataGrid } from "@wealthfolio/ui";
import type { ColumnDef } from "@tanstack/react-table";
import { useCallback } from "react";
import { describe, expect, it, vi } from "vitest";

interface TestRow {
  calendarDate: string | null;
  inputDate: Date | null;
  amount: string | null;
  numericAmount: number | null;
}

function GridHarness({
  columns,
  focusColumn,
  onDataChange,
}: {
  columns: ColumnDef<TestRow>[];
  focusColumn: keyof TestRow;
  onDataChange: (data: TestRow[]) => void;
}) {
  const handleDataChange = useCallback((data: TestRow[]) => onDataChange(data), [onDataChange]);
  const grid = useDataGrid({
    data: [{ calendarDate: null, inputDate: null, amount: null, numericAmount: null }],
    columns,
    enablePaste: true,
    onDataChange: handleDataChange,
  });

  return (
    <>
      <button type="button" onClick={() => grid.tableMeta?.onCellClick?.(0, focusColumn)}>
        Focus cell
      </button>
      <div ref={grid.dataGridRef} data-testid="grid" />
    </>
  );
}

async function pasteIntoColumn(
  column: ColumnDef<TestRow>,
  focusColumn: keyof TestRow,
  clipboardText: string,
  locale = "de-DE",
) {
  const onDataChange = vi.fn<(data: TestRow[]) => void>();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { readText: vi.fn().mockResolvedValue(clipboardText) },
  });

  render(
    <FormattingProvider locale={locale}>
      <GridHarness columns={[column]} focusColumn={focusColumn} onDataChange={onDataChange} />
    </FormattingProvider>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Focus cell" }));
  fireEvent.keyDown(screen.getByTestId("grid"), { key: "v", ctrlKey: true });
  await waitFor(() => expect(onDataChange).toHaveBeenCalledTimes(1));
  return onDataChange.mock.calls[0]![0];
}

describe("data grid localized paste", () => {
  it("stores DateCell paste values as calendar-date strings", async () => {
    const data = await pasteIntoColumn(
      {
        accessorKey: "calendarDate",
        meta: { cell: { variant: "date" } },
      },
      "calendarDate",
      "31.12.2026",
    );

    expect(data[0]?.calendarDate).toBe("2026-12-31");
  });

  it("keeps date-input paste values as Date objects", async () => {
    const data = await pasteIntoColumn(
      {
        accessorKey: "inputDate",
        meta: { cell: { variant: "date-input" } },
      },
      "inputDate",
      "31.12.2026",
    );

    expect(data[0]?.inputDate).toBeInstanceOf(Date);
    expect(data[0]?.inputDate?.getFullYear()).toBe(2026);
    expect(data[0]?.inputDate?.getMonth()).toBe(11);
    expect(data[0]?.inputDate?.getDate()).toBe(31);
  });

  it("preserves English month-name dates under a Japanese formatting locale", async () => {
    const data = await pasteIntoColumn(
      {
        accessorKey: "calendarDate",
        meta: { cell: { variant: "date" } },
      },
      "calendarDate",
      "Jul 3, 2026",
      "ja-JP",
    );

    expect(data[0]?.calendarDate).toBe("2026-07-03");
  });

  it("normalizes localized string-backed numbers without losing precision", async () => {
    const data = await pasteIntoColumn(
      {
        accessorKey: "amount",
        meta: { cell: { variant: "number", valueType: "string" } },
      },
      "amount",
      "123456789012345678,12345678",
    );

    expect(data[0]?.amount).toBe("123456789012345678.12345678");
  });

  it("accepts invariant decimals in numeric cells under a German locale", async () => {
    const data = await pasteIntoColumn(
      {
        accessorKey: "numericAmount",
        meta: { cell: { variant: "number" } },
      },
      "numericAmount",
      "1234.5",
    );

    expect(data[0]?.numericAmount).toBe(1234.5);
  });
});
