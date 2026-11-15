import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FormattingProvider } from "@wealthfolio/ui";
import { DateInputCell } from "@wealthfolio/ui/components/data-grid/data-grid-cell-variants";
import type { Cell, TableMeta } from "@tanstack/react-table";
import { describe, expect, it, vi } from "vitest";

interface TestRow {
  date: Date;
}

function renderCell({
  locale,
  uiLocale,
  isEditing = false,
  onDataUpdate = vi.fn(),
  onCellEditingStop = vi.fn(),
}: {
  locale: string;
  uiLocale?: string;
  isEditing?: boolean;
  onDataUpdate?: NonNullable<TableMeta<TestRow>["onDataUpdate"]>;
  onCellEditingStop?: NonNullable<TableMeta<TestRow>["onCellEditingStop"]>;
}) {
  const value = new Date(2026, 0, 11);
  const cell = {
    getValue: () => value,
    column: { columnDef: { header: "Date" } },
  } as unknown as Cell<TestRow, unknown>;
  const tableMeta: TableMeta<TestRow> = { onDataUpdate, onCellEditingStop };

  const result = render(
    <FormattingProvider locale={locale} uiLocale={uiLocale}>
      <DateInputCell
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

  return { ...result, onDataUpdate, onCellEditingStop };
}

function segmentValues() {
  return screen
    .getAllByRole("spinbutton")
    .map((segment) => Number(segment.getAttribute("aria-valuenow")));
}

describe("DateInputCell formatting region", () => {
  it("displays the date in the formatting region", () => {
    renderCell({ locale: "es-ES", uiLocale: "es" });
    expect(screen.getByText("11/1/26")).toBeInTheDocument();
  });

  it("edits day-first under a day-first region, whatever the browser locale", () => {
    // jsdom's navigator is en-US: a native date input would edit month-first here.
    renderCell({ locale: "es-ES", uiLocale: "es", isEditing: true });

    expect(segmentValues()).toEqual([11, 1, 2026]);
    expect(screen.getAllByRole("spinbutton")[0]).toHaveFocus();
  });

  it("edits month-first under a month-first region", () => {
    renderCell({ locale: "en-US", isEditing: true });
    expect(segmentValues()).toEqual([1, 11, 2026]);
  });

  it("saves the edited day when the editor loses focus", async () => {
    const user = userEvent.setup();
    const onDataUpdate = vi.fn();
    renderCell({ locale: "en-GB", isEditing: true, onDataUpdate });

    const [day] = screen.getAllByRole("spinbutton");
    expect(day).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    await user.click(document.body);

    const update = onDataUpdate.mock.calls[0]?.[0] as { value: Date };
    expect(update.value.getFullYear()).toBe(2026);
    expect(update.value.getMonth()).toBe(0);
    expect(update.value.getDate()).toBe(12);
  });

  it("picks a day from the calendar and ends the edit", async () => {
    const user = userEvent.setup();
    const onCellEditingStop = vi.fn();
    renderCell({ locale: "es-ES", uiLocale: "es", isEditing: true, onCellEditingStop });

    await user.click(screen.getByRole("button", { name: /^Pick a date/ }));
    const calendar = await screen.findByRole("dialog");
    await user.click(within(calendar).getByRole("button", { name: /20 de enero de 2026/i }));

    expect(onCellEditingStop).toHaveBeenCalledTimes(1);
    expect(segmentValues()).toEqual([20, 1, 2026]);
  });
});
