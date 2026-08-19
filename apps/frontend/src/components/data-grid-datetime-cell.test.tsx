import { fireEvent, render, screen } from "@testing-library/react";
import { FormattingProvider } from "@wealthfolio/ui";
import { DateTimeCell } from "@wealthfolio/ui/components/data-grid/data-grid-cell-variants";
import type { Cell, TableMeta } from "@tanstack/react-table";
import { describe, expect, it, vi } from "vitest";

interface TestRow {
  date: Date;
}

function renderCell({
  isEditing = false,
  onDataUpdate = vi.fn(),
}: {
  isEditing?: boolean;
  onDataUpdate?: NonNullable<TableMeta<TestRow>["onDataUpdate"]>;
} = {}) {
  const value = new Date("2026-08-18T00:00:00.000Z");
  const cell = { getValue: () => value } as unknown as Cell<TestRow, unknown>;
  const tableMeta: TableMeta<TestRow> = { onDataUpdate };

  render(
    <FormattingProvider locale="en-US" timezone="Asia/Tokyo">
      <DateTimeCell
        cell={cell}
        tableMeta={tableMeta}
        rowIndex={0}
        columnId="date"
        rowHeight="short"
        isEditing={isEditing}
        isFocused={false}
        isSelected={false}
        isSearchMatch={false}
        isActiveSearchMatch={false}
        readOnly={false}
      />
    </FormattingProvider>,
  );

  return { onDataUpdate };
}

describe("DateTimeCell timezone handling", () => {
  it("displays an instant in the configured timezone", () => {
    renderCell();
    expect(screen.getByText("8/18/26, 9:00 AM")).toBeInTheDocument();
  });

  it("interprets edited wall-clock time in the configured timezone", () => {
    const onDataUpdate = vi.fn();
    renderCell({ isEditing: true, onDataUpdate });
    const input = screen.getByDisplayValue<HTMLInputElement>("2026-08-18T09:00");

    fireEvent.change(input, { target: { value: "2026-08-18T10:00" } });
    fireEvent.blur(input);

    const update = onDataUpdate.mock.calls[0]?.[0] as { value: Date };
    expect(update.value.toISOString()).toBe("2026-08-18T01:00:00.000Z");
  });
});
