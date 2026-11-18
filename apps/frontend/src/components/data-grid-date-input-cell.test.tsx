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

  it("edits in the formatting region's order when the interface language differs", async () => {
    // es-US is day-first, en-US month-first: the field must match the displayed date.
    const user = userEvent.setup();
    renderCell({ locale: "en-US", uiLocale: "es", isEditing: true });

    expect(segmentValues()).toEqual([1, 11, 2026]);

    // The calendar keeps the interface language.
    await user.click(screen.getByRole("button", { name: /^Pick a date/ }));
    const calendar = await screen.findByRole("dialog");
    expect(
      within(calendar).getByRole("button", { name: /20 de enero de 2026/i }),
    ).toBeInTheDocument();
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

  it("does not save a day the month doesn't have", async () => {
    const user = userEvent.setup();
    const onDataUpdate = vi.fn();
    renderCell({ locale: "en-GB", isEditing: true, onDataUpdate });

    const [day, month] = screen.getAllByRole("spinbutton");
    await user.click(month);
    await user.keyboard("4");
    await user.click(day);
    await user.keyboard("31");
    await user.click(document.body);

    expect(onDataUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ["after the last digit is released", "31{Tab}"],
    ["while the last digit is still held", "3{1>}{Tab}{/1}"],
  ])("does not save 31 April on Tab %s", async (_when, keys) => {
    const user = userEvent.setup();
    const onDataUpdate = vi.fn();
    renderCell({ locale: "en-GB", isEditing: true, onDataUpdate });

    const [day, month] = screen.getAllByRole("spinbutton");
    await user.click(month);
    await user.keyboard("4");
    await user.click(day);
    await user.keyboard(keys);

    expect(onDataUpdate).not.toHaveBeenCalled();
  });

  it("does not save a month that doesn't have the typed day", async () => {
    const user = userEvent.setup();
    const onDataUpdate = vi.fn();
    renderCell({ locale: "en-GB", isEditing: true, onDataUpdate });

    const [day, month] = screen.getAllByRole("spinbutton");
    await user.click(day);
    await user.keyboard("31");
    await user.click(month);
    await user.keyboard("11");
    await user.click(document.body);

    expect(onDataUpdate).not.toHaveBeenCalled();
  });

  it("does not save a year that doesn't have 29 February", async () => {
    const user = userEvent.setup();
    const onDataUpdate = vi.fn();
    renderCell({ locale: "en-GB", isEditing: true, onDataUpdate });

    const [day, month, year] = screen.getAllByRole("spinbutton");
    await user.click(year);
    await user.keyboard("2028");
    await user.click(month);
    await user.keyboard("2");
    await user.click(day);
    await user.keyboard("29");
    await user.click(year);
    await user.keyboard("2029");
    await user.click(document.body);

    expect(onDataUpdate).not.toHaveBeenCalled();
  });

  it("saves a valid month and year typed over the stored date", async () => {
    const user = userEvent.setup();
    const onDataUpdate = vi.fn();
    renderCell({ locale: "en-GB", isEditing: true, onDataUpdate });

    const [, month, year] = screen.getAllByRole("spinbutton");
    await user.click(month);
    await user.keyboard("12");
    await user.click(year);
    await user.keyboard("2032");
    await user.click(document.body);

    const update = onDataUpdate.mock.calls[0]?.[0] as { value: Date };
    expect(update.value.getFullYear()).toBe(2032);
    expect(update.value.getMonth()).toBe(11);
    expect(update.value.getDate()).toBe(11);
  });

  it("saves a month typed with a leading zero while its last digit is held", async () => {
    const user = userEvent.setup();
    const onDataUpdate = vi.fn();
    renderCell({ locale: "en-GB", isEditing: true, onDataUpdate });

    const [, month] = screen.getAllByRole("spinbutton");
    await user.click(month);
    await user.keyboard("0{6>}{Tab}{/6}");

    const update = onDataUpdate.mock.calls[0]?.[0] as { value: Date };
    expect(update.value.getMonth()).toBe(5);
    expect(update.value.getDate()).toBe(11);
  });

  it("saves the corrected date after an impossible day", async () => {
    const user = userEvent.setup();
    const onDataUpdate = vi.fn();
    renderCell({ locale: "en-GB", isEditing: true, onDataUpdate });

    const [day, month] = screen.getAllByRole("spinbutton");
    await user.click(month);
    await user.keyboard("4");
    await user.click(day);
    await user.keyboard("31");
    await user.click(day);
    await user.keyboard("30");
    await user.click(document.body);

    const update = onDataUpdate.mock.calls[0]?.[0] as { value: Date };
    expect(update.value.getMonth()).toBe(3);
    expect(update.value.getDate()).toBe(30);
  });

  it("keeps the saved date when the date is cleared", async () => {
    const user = userEvent.setup();
    const onDataUpdate = vi.fn();
    renderCell({ locale: "en-GB", isEditing: true, onDataUpdate });

    for (const segment of screen.getAllByRole("spinbutton")) {
      await user.click(segment);
      await user.keyboard("{Backspace}{Backspace}{Backspace}{Backspace}");
    }
    await user.click(document.body);

    expect(onDataUpdate).not.toHaveBeenCalled();
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
