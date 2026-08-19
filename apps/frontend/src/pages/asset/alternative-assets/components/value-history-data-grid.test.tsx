import { act, fireEvent, render, screen, waitFor, within } from "@/test/render";
import { format } from "date-fns";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDataGrid } from "@wealthfolio/ui";

import { useIsMobileViewport } from "@/hooks/use-platform";
import type { Quote } from "@/lib/types";

import { ValueHistoryDataGrid, type ValueHistoryEntry } from "./value-history-data-grid";

vi.mock("@/hooks/use-platform", () => ({
  useIsMobileViewport: vi.fn(),
}));

vi.mock("@wealthfolio/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wealthfolio/ui")>();
  return {
    ...actual,
    DataGrid: () => <div data-testid="data-grid" />,
    useDataGrid: vi.fn(() => ({
      table: {
        getSelectedRowModel: () => ({ rows: [] }),
        resetRowSelection: vi.fn(),
      },
      onRowAdd: vi.fn(),
    })),
  };
});

const mockUseIsMobileViewport = vi.mocked(useIsMobileViewport);
const mockUseDataGrid = vi.mocked(useDataGrid);
const assetId = "asset-home-mortgage";
const displayDate = (date: string) =>
  new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));

const createQuote = (date: string, value: number, id = `${assetId}_${date}_MANUAL`): Quote => ({
  id,
  createdAt: `${date}T00:00:00.000Z`,
  dataSource: "MANUAL",
  timestamp: `${date}T00:00:00Z`,
  assetId,
  open: value,
  high: value,
  low: value,
  volume: 0,
  close: value,
  adjclose: value,
  currency: "USD",
  notes: undefined,
});

interface RenderGridOptions {
  data?: Quote[];
  onSaveQuote?: (quote: Quote) => Promise<void>;
  onDeleteQuote?: (quoteId: string) => Promise<void>;
  onPersistComplete?: () => Promise<void>;
}

const renderGrid = ({
  data = [createQuote("2026-08-17", 495_000)],
  onSaveQuote = vi.fn().mockResolvedValue(undefined),
  onDeleteQuote = vi.fn().mockResolvedValue(undefined),
  onPersistComplete = vi.fn().mockResolvedValue(undefined),
}: RenderGridOptions = {}) => {
  return render(
    <ValueHistoryDataGrid
      data={data}
      assetId={assetId}
      currency="USD"
      isLiability
      onSaveQuote={onSaveQuote}
      onDeleteQuote={onDeleteQuote}
      onPersistComplete={onPersistComplete}
    />,
  );
};

interface CapturedDataGridOptions {
  data: ValueHistoryEntry[];
  readOnly?: boolean;
  onDataChange: (entries: ValueHistoryEntry[]) => void;
  onRowAdd: () => unknown;
  onRowsDelete: (rows: ValueHistoryEntry[], rowIndices: number[]) => void;
  columns: {
    id?: string;
    cell?: (context: unknown) => ReactNode;
  }[];
}

const getDataGridOptions = (): CapturedDataGridOptions => {
  const call = mockUseDataGrid.mock.calls.at(-1);
  if (!call) throw new Error("useDataGrid was not called");
  return call[0] as unknown as CapturedDataGridOptions;
};

beforeEach(() => {
  mockUseDataGrid.mockClear();
});

describe("ValueHistoryDataGrid mobile", () => {
  beforeEach(() => {
    mockUseIsMobileViewport.mockReturnValue(true);
  });

  it("provides contextual row actions and a labelled notes field", () => {
    renderGrid();

    expect(
      screen.getByRole("button", { name: `Edit ${displayDate("2026-08-17")}, $495,000.00` }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: `Delete ${displayDate("2026-08-17")}, $495,000.00` }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: `Edit ${displayDate("2026-08-17")}, $495,000.00` }),
    );

    expect(screen.getByLabelText("Notes")).toBeInTheDocument();
  });

  it("preserves an existing quote ID so the backend can move or canonicalize it", async () => {
    const existingId = "6f5a0b1e-3e6d-4b17-8824-6247b036e123";
    const onSaveQuote = vi.fn().mockResolvedValue(undefined);
    renderGrid({ data: [createQuote("2026-08-17", 495_000, existingId)], onSaveQuote });

    fireEvent.click(
      screen.getByRole("button", { name: `Edit ${displayDate("2026-08-17")}, $495,000.00` }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Balance" }), {
      target: { value: "510000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSaveQuote).toHaveBeenCalledTimes(1));
    expect(onSaveQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        id: existingId,
        assetId,
        close: 510_000,
      }),
    );
    expect(
      await screen.findByRole("button", {
        name: `Edit ${displayDate("2026-08-17")}, $510,000.00`,
      }),
    ).toBeInTheDocument();
  });

  it("keeps the draft open when saving fails", async () => {
    const onSaveQuote = vi.fn().mockRejectedValue(new Error("save failed"));
    renderGrid({ onSaveQuote });

    fireEvent.click(
      screen.getByRole("button", { name: `Edit ${displayDate("2026-08-17")}, $495,000.00` }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Balance" }), {
      target: { value: "510000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSaveQuote).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Balance" })).toHaveValue("510,000.00");
  });

  it("preserves an open draft when external data refreshes", () => {
    const onSaveQuote = vi.fn().mockResolvedValue(undefined);
    const onDeleteQuote = vi.fn().mockResolvedValue(undefined);
    const onPersistComplete = vi.fn().mockResolvedValue(undefined);
    const view = renderGrid({ onSaveQuote, onDeleteQuote, onPersistComplete });

    fireEvent.click(
      screen.getByRole("button", { name: `Edit ${displayDate("2026-08-17")}, $495,000.00` }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Balance" }), {
      target: { value: "510000" },
    });

    view.rerender(
      <ValueHistoryDataGrid
        data={[createQuote("2026-08-17", 500_000)]}
        assetId={assetId}
        currency="USD"
        isLiability
        onSaveQuote={onSaveQuote}
        onDeleteQuote={onDeleteQuote}
        onPersistComplete={onPersistComplete}
      />,
    );

    expect(screen.getByRole("textbox", { name: "Balance" })).toHaveValue("510,000.00");
  });

  it("keeps the row and confirmation open when deletion fails", async () => {
    const onDeleteQuote = vi.fn().mockRejectedValue(new Error("delete failed"));
    renderGrid({ onDeleteQuote });

    fireEvent.click(
      screen.getByRole("button", {
        name: `Delete ${displayDate("2026-08-17")}, $495,000.00`,
      }),
    );
    const dialog = screen.getByRole("alertdialog", { name: "Delete history entry?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(onDeleteQuote).toHaveBeenCalledTimes(1));
    const openDialog = screen.getByRole("alertdialog", { name: "Delete history entry?" });
    expect(openDialog).toBeInTheDocument();
    fireEvent.click(within(openDialog).getByRole("button", { name: "Cancel" }));
    expect(
      screen.getByRole("button", { name: `Edit ${displayDate("2026-08-17")}, $495,000.00` }),
    ).toBeInTheDocument();
  });

  it("uses the explicit asset ID when saving the first history entry", async () => {
    const onSaveQuote = vi.fn().mockResolvedValue(undefined);
    renderGrid({ data: [], onSaveQuote });

    fireEvent.click(screen.getByRole("button", { name: "Add Balance" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSaveQuote).toHaveBeenCalledTimes(1));
    const today = format(new Date(), "yyyy-MM-dd");
    expect(onSaveQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `${assetId}_${today}_MANUAL`,
        assetId,
      }),
    );
  });

  it("replaces an existing entry when adding another balance for the same day", async () => {
    const today = format(new Date(), "yyyy-MM-dd");
    const onSaveQuote = vi.fn().mockResolvedValue(undefined);
    renderGrid({ data: [createQuote(today, 495_000)], onSaveQuote });

    fireEvent.click(screen.getByRole("button", { name: "Add Balance" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Balance" }), {
      target: { value: "490000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByRole("button", { name: `Edit ${displayDate(today)}, $490,000.00` }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: new RegExp(`^Edit ${displayDate(today)},`) }),
    ).toHaveLength(1);
  });
});

describe("ValueHistoryDataGrid desktop persistence", () => {
  beforeEach(() => {
    mockUseIsMobileViewport.mockReturnValue(false);
  });

  it("keeps the complete retry set when a later batch save fails", async () => {
    const onSaveQuote = vi
      .fn<(quote: Quote) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("save failed"));
    const onPersistComplete = vi.fn().mockResolvedValue(undefined);
    renderGrid({
      data: [createQuote("2026-08-17", 495_000), createQuote("2026-06-07", 500_000)],
      onSaveQuote,
      onPersistComplete,
    });

    const grid = getDataGridOptions();
    act(() => {
      grid.onDataChange(grid.data.map((entry) => ({ ...entry, value: entry.value - 1_000 })));
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(onSaveQuote).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save Changes" })).toBeEnabled());
    expect(onPersistComplete).not.toHaveBeenCalled();
    expect(screen.getByText("2 modified")).toBeInTheDocument();
  });

  it("preserves unsaved edits when external data refreshes", () => {
    const onSaveQuote = vi.fn().mockResolvedValue(undefined);
    const onDeleteQuote = vi.fn().mockResolvedValue(undefined);
    const onPersistComplete = vi.fn().mockResolvedValue(undefined);
    const view = renderGrid({ onSaveQuote, onDeleteQuote, onPersistComplete });

    const grid = getDataGridOptions();
    act(() => {
      grid.onDataChange(grid.data.map((entry) => ({ ...entry, value: 490_000 })));
    });

    view.rerender(
      <ValueHistoryDataGrid
        data={[createQuote("2026-08-17", 500_000)]}
        assetId={assetId}
        currency="USD"
        isLiability
        onSaveQuote={onSaveQuote}
        onDeleteQuote={onDeleteQuote}
        onPersistComplete={onPersistComplete}
      />,
    );

    expect(getDataGridOptions().data[0].value).toBe(490_000);
    expect(screen.getByText("1 modified")).toBeInTheDocument();
  });

  it("makes the data grid read-only while the saved snapshot is in flight", async () => {
    let resolveSave: (() => void) | undefined;
    const onSaveQuote = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const onPersistComplete = vi.fn().mockResolvedValue(undefined);
    renderGrid({ onSaveQuote, onPersistComplete });

    const grid = getDataGridOptions();
    act(() => {
      grid.onDataChange(grid.data.map((entry) => ({ ...entry, value: 490_000 })));
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(getDataGridOptions().readOnly).toBe(true));
    const lockedGrid = getDataGridOptions();
    const actionsColumn = lockedGrid.columns.find((column) => column.id === "actions");
    if (typeof actionsColumn?.cell !== "function") {
      throw new Error("actions column was not configured");
    }
    const actionCell = actionsColumn.cell({ row: { original: lockedGrid.data[0] } });
    const action = render(<>{actionCell}</>);
    expect(within(action.container).getByRole("button")).toBeDisabled();
    action.unmount();

    act(() => resolveSave?.());
    await waitFor(() => expect(onPersistComplete).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getDataGridOptions().readOnly).toBe(false));
  });

  it("rejects multiple entries with the same calendar date", () => {
    const onSaveQuote = vi.fn().mockResolvedValue(undefined);
    const onPersistComplete = vi.fn().mockResolvedValue(undefined);
    renderGrid({
      data: [createQuote("2026-08-17", 495_000), createQuote("2026-06-07", 500_000)],
      onSaveQuote,
      onPersistComplete,
    });

    const grid = getDataGridOptions();
    act(() => {
      grid.onDataChange(
        grid.data.map((entry, index) =>
          index === 1 ? { ...entry, date: new Date("2026-08-17T00:00:00") } : entry,
        ),
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(onSaveQuote).not.toHaveBeenCalled();
    expect(onPersistComplete).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeEnabled();
  });

  it("deletes an existing same-day entry before saving its replacement", async () => {
    const events: string[] = [];
    const onDeleteQuote = vi.fn(() => {
      events.push("delete");
      return Promise.resolve();
    });
    const onSaveQuote = vi.fn(() => {
      events.push("save");
      return Promise.resolve();
    });
    const onPersistComplete = vi.fn().mockResolvedValue(undefined);
    const today = format(new Date(), "yyyy-MM-dd");
    renderGrid({
      data: [createQuote(today, 495_000, "legacy-quote-id")],
      onSaveQuote,
      onDeleteQuote,
      onPersistComplete,
    });

    const grid = getDataGridOptions();
    act(() => {
      grid.onRowsDelete([grid.data[0]], [0]);
      grid.onRowAdd();
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(onPersistComplete).toHaveBeenCalledTimes(1));
    expect(events).toEqual(["delete", "save"]);
    expect(onSaveQuote).toHaveBeenCalledWith(
      expect.objectContaining({ id: `${assetId}_${today}_MANUAL` }),
    );
  });
});
