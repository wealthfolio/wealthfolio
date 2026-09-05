import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { InputTags, type DataGridCellProps, useDataGrid } from "@wealthfolio/ui";
import {
  CurrencyCell,
  MultiSelectCell,
  SymbolCell,
} from "@wealthfolio/ui/components/data-grid/data-grid-cell-variants";
import type { Cell, TableMeta } from "@tanstack/react-table";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

interface TestRow {
  name: string | null;
}

interface PortalCellTestRow {
  value: string | string[];
}

type PortalCellVariant = "multi-select" | "symbol" | "currency";

class ResizeObserverStub {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterAll(() => {
  if (originalScrollIntoView) {
    Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
  } else {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  }
  vi.unstubAllGlobals();
});

function GridHarness() {
  const grid = useDataGrid<TestRow>({
    data: [{ name: null }, { name: null }],
    columns: [{ accessorKey: "name", meta: { cell: { variant: "short-text" } } }],
  });

  return (
    <>
      <button type="button" onClick={() => grid.tableMeta?.onCellEditingStart?.(0, "name")}>
        Edit cell
      </button>
      <div ref={grid.dataGridRef} data-testid="grid" />
      <output data-testid="editing">{grid.editingCell ? "editing" : "idle"}</output>
    </>
  );
}

async function renderPortalCell(variant: PortalCellVariant) {
  const initialValue =
    variant === "multi-select" ? ["alpha"] : variant === "symbol" ? "AAPL" : "USD";
  const cellOptions =
    variant === "multi-select"
      ? {
          variant,
          options: [
            { label: "Alpha", value: "alpha" },
            { label: "Beta", value: "beta" },
          ],
        }
      : variant === "symbol"
        ? { variant, onSearch: vi.fn().mockResolvedValue([]) }
        : { variant };
  const cell = {
    getValue: () => initialValue,
    column: { columnDef: { meta: { cell: cellOptions } } },
    row: { original: { value: initialValue } },
  } as unknown as Cell<PortalCellTestRow, unknown>;
  const onCellEditingStop = vi.fn();
  const tableMeta: TableMeta<PortalCellTestRow> = { onCellEditingStop };
  const props: DataGridCellProps<PortalCellTestRow> = {
    cell,
    tableMeta,
    rowIndex: 0,
    columnId: "value",
    rowHeight: "short",
    isEditing: true,
    isFocused: true,
    isSelected: false,
    isSearchMatch: false,
    isActiveSearchMatch: false,
    readOnly: false,
  };

  render(
    variant === "multi-select" ? (
      <MultiSelectCell {...props} />
    ) : variant === "symbol" ? (
      <SymbolCell {...props} />
    ) : (
      <CurrencyCell {...props} />
    ),
  );

  const input = await screen.findByRole("combobox");
  onCellEditingStop.mockClear();
  return { input, onCellEditingStop };
}

describe("CJK IME composition", () => {
  it.each(["Enter", "Escape", "Tab"])("keeps the grid edit open for composing %s", async (key) => {
    render(<GridHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Edit cell" }));
    expect(screen.getByTestId("editing")).toHaveTextContent("editing");

    fireEvent.keyDown(screen.getByTestId("grid"), { key, isComposing: true });
    await act(() => Promise.resolve());
    expect(screen.getByTestId("editing")).toHaveTextContent("editing");

    fireEvent.keyDown(screen.getByTestId("grid"), { key });
    await waitFor(() => expect(screen.getByTestId("editing")).toHaveTextContent("idle"));
  });

  it("does not add a tag until composition has finished", () => {
    const onChange = vi.fn();
    render(<InputTags aria-label="Tags" value={[]} onChange={onChange} />);
    const input = screen.getByRole("textbox", { name: "Tags" });

    fireEvent.change(input, { target: { value: "候選" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(["候選"]);
  });

  it.each(["multi-select", "symbol", "currency"] as const)(
    "keeps the %s portal cell open for composing Escape",
    async (variant) => {
      const { input, onCellEditingStop } = await renderPortalCell(variant);

      fireEvent.change(input, { target: { value: "候選" } });
      fireEvent.keyDown(input, { key: "Escape", isComposing: true });

      expect(onCellEditingStop).not.toHaveBeenCalled();
      expect(input).toHaveValue("候選");
    },
  );

  it.each(["multi-select", "symbol", "currency"] as const)(
    "keeps the %s portal cell's non-composing Escape behavior",
    async (variant) => {
      const { input, onCellEditingStop } = await renderPortalCell(variant);

      fireEvent.change(input, { target: { value: "changed" } });
      fireEvent.keyDown(input, { key: "Escape" });

      expect(onCellEditingStop).toHaveBeenCalled();
      expect(input).toHaveValue("");
    },
  );
});
