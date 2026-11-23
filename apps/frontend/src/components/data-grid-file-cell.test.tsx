import type { Cell, TableMeta } from "@tanstack/react-table";
import { fireEvent, render, screen } from "@testing-library/react";
import { FormattingProvider, stripBidiControls } from "@wealthfolio/ui";
import { FileCell } from "@wealthfolio/ui/components/data-grid/data-grid-cell-variants";
import { DirectionProvider } from "@wealthfolio/ui/components/ui/direction";
import { toast } from "sonner";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: vi.fn() }));

interface TestRow {
  files: unknown[];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(["ltr", "rtl"] as const)(
  "refreshes file-size validation after a region change in %s",
  (direction) => {
    const files: unknown[] = [];
    const cell = {
      getValue: () => files,
      column: {
        columnDef: { meta: { cell: { variant: "file", maxFileSize: 1.5 * 1024 * 1024 } } },
      },
      row: { original: { files } },
    } as unknown as Cell<TestRow, unknown>;
    const tableMeta: TableMeta<TestRow> = { onFilesUpload: vi.fn(), onDataUpdate: vi.fn() };
    const view = (locale: string) => (
      <DirectionProvider direction={direction}>
        <FormattingProvider locale={locale}>
          <FileCell
            cell={cell}
            tableMeta={tableMeta}
            rowIndex={0}
            columnId="files"
            rowHeight="short"
            isEditing={false}
            isFocused
            isSelected={false}
            isSearchMatch={false}
            isActiveSearchMatch={false}
            readOnly={false}
          />
        </FormattingProvider>
      </DirectionProvider>
    );
    const { rerender } = render(view("US"));
    const oversized = new File(["large"], "large.txt");
    Object.defineProperty(oversized, "size", { value: 2 * 1024 * 1024 });
    const dropFile = () =>
      fireEvent.drop(screen.getByRole("button"), { dataTransfer: { files: [oversized] } });
    dropFile();
    expect(stripBidiControls(vi.mocked(toast).mock.lastCall?.[0] as string)).toBe(
      "File size exceeds 1.5 MB",
    );
    rerender(view("ES"));
    dropFile();
    expect(stripBidiControls(vi.mocked(toast).mock.lastCall?.[0] as string)).toBe(
      "File size exceeds 1,5 MB",
    );
    expect(tableMeta.onFilesUpload).not.toHaveBeenCalled();
    expect(tableMeta.onDataUpdate).not.toHaveBeenCalled();
  },
);
