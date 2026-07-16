import { Button, DataGrid, Icons, useDataGrid } from "@wealthfolio/ui";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { createColumnHelper } from "@tanstack/react-table";
import type { Quote } from "@/lib/types";
import { ValueHistoryToolbar } from "./value-history-toolbar";
import { format } from "date-fns";

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const UTC_MIDNIGHT_REGEX = /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.\d+)?Z$/;

// Parse YYYY-MM-DD as local midnight to avoid timezone shifts in date-only values.
const parseLocalDate = (dateOnly: string): Date => new Date(dateOnly + "T00:00:00");

// Preserve legacy non-midnight timestamps while treating canonical midnight UTC as date-only.
const parseCalendarDate = (value: string): Date => {
  const trimmed = value.trim();
  if (DATE_ONLY_REGEX.test(trimmed)) return parseLocalDate(trimmed);
  if (UTC_MIDNIGHT_REGEX.test(trimmed)) return parseLocalDate(trimmed.substring(0, 10));
  return new Date(trimmed);
};

// Helper to normalize date values (handles both Date objects and strings from DateCell)
const normalizeDate = (value: Date | string): Date => {
  if (value instanceof Date) return value;
  return parseCalendarDate(value);
};

// Round number to 2 decimal places (standard for alternative assets)
const roundToDecimals = (value: number): number => {
  return Math.round(value * 100) / 100;
};

/**
 * Local representation of a value history entry for the data grid.
 * Maps from Quote but with simplified fields for alternative assets.
 */
export interface ValueHistoryEntry {
  id: string;
  date: Date;
  value: number;
  notes: string;
  currency: string;
  isNew?: boolean;
}

interface ValueHistoryDataGridProps {
  /** Quote data from the backend */
  data: Quote[];
  /** Currency for the asset */
  currency: string;
  /** Whether this is a liability (changes "Value" to "Balance" label) */
  isLiability?: boolean;
  /** Callback to save a quote */
  onSaveQuote: (quote: Quote) => void;
  /** Callback to delete a quote */
  onDeleteQuote: (quoteId: string) => void;
}

// Generate a temporary ID for new entries
const generateTempId = () => `temp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

// Convert Quote to ValueHistoryEntry with rounding
const toValueHistoryEntry = (quote: Quote): ValueHistoryEntry => ({
  id: quote.id,
  date: parseCalendarDate(quote.timestamp),
  value: roundToDecimals(quote.close),
  notes: quote.notes ?? "",
  currency: quote.currency,
  isNew: false,
});

// Convert ValueHistoryEntry back to Quote for saving
const toQuote = (entry: ValueHistoryEntry, symbol: string): Quote => {
  const datePart = format(entry.date, "yyyy-MM-dd").replace(/-/g, "");
  return {
    id: entry.id.startsWith("temp-") ? `${datePart}_${symbol.toUpperCase()}` : entry.id,
    createdAt: new Date().toISOString(),
    dataSource: "MANUAL",
    timestamp: format(entry.date, "yyyy-MM-dd'T'00:00:00'Z'"),
    assetId: symbol,
    open: entry.value,
    high: entry.value,
    low: entry.value,
    volume: 0,
    close: entry.value,
    adjclose: entry.value,
    currency: entry.currency,
    notes: entry.notes || undefined,
  };
};

// Create draft entry
const createDraftEntry = (currency: string): ValueHistoryEntry => ({
  id: generateTempId(),
  date: new Date(),
  value: 0,
  notes: "",
  currency,
  isNew: true,
});

export function ValueHistoryDataGrid({
  data,
  currency,
  isLiability = false,
  onSaveQuote,
  onDeleteQuote,
}: ValueHistoryDataGridProps) {
  const { t } = useTranslation();
  // Convert quotes to local entries
  const initialEntries = useMemo(
    () => data.map(toValueHistoryEntry).sort((a, b) => b.date.getTime() - a.date.getTime()),
    [data],
  );

  const [localEntries, setLocalEntries] = useState<ValueHistoryEntry[]>(initialEntries);
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(new Set());
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());

  // Sync with external data changes
  useMemo(() => {
    setLocalEntries(initialEntries);
    setDirtyIds(new Set());
    setDeletedIds(new Set());
  }, [initialEntries]);

  // Track if there are unsaved changes
  const hasUnsavedChanges = dirtyIds.size > 0 || deletedIds.size > 0;

  // Get assetId from first quote or use empty string
  const symbol = data[0]?.assetId ?? "";

  // Column definitions
  const columnHelper = createColumnHelper<ValueHistoryEntry>();

  // Delete a single row
  const handleDeleteRow = useCallback((entry: ValueHistoryEntry) => {
    if (entry.isNew) {
      // Remove new entries immediately
      setLocalEntries((prev) => prev.filter((e) => e.id !== entry.id));
      setDirtyIds((prev) => {
        const next = new Set(prev);
        next.delete(entry.id);
        return next;
      });
    } else {
      // Mark existing entries for deletion
      setDeletedIds((prev) => new Set(prev).add(entry.id));
      setLocalEntries((prev) => prev.filter((e) => e.id !== entry.id));
    }
  }, []);

  const columns = useMemo(
    () => [
      columnHelper.accessor("date", {
        header: t("asset:valueHistory.date"),
        size: 140,
        meta: { cell: { variant: "date-input" } },
      }),
      columnHelper.accessor("value", {
        header: isLiability ? t("asset:valueHistory.balance") : t("asset:valueHistory.value"),
        size: 180,
        meta: { cell: { variant: "number", min: 0 } },
      }),
      columnHelper.accessor("notes", {
        header: t("asset:valueHistory.notes"),
        size: 300,
        meta: { cell: { variant: "long-text" } },
      }),
      // Actions column with delete button
      columnHelper.display({
        id: "actions",
        header: () => null,
        size: 50,
        enableSorting: false,
        enableResizing: false,
        enableHiding: false,
        cell: ({ row }) => (
          <div className="flex size-full items-center justify-center">
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-destructive h-7 w-7"
              onClick={() => handleDeleteRow(row.original)}
            >
              <Icons.X className="h-4 w-4" />
            </Button>
          </div>
        ),
      }),
    ],
    [columnHelper, isLiability, handleDeleteRow, t],
  );

  // Handle data changes from the grid
  const onDataChange = useCallback((nextData: ValueHistoryEntry[]) => {
    setLocalEntries((prev) => {
      const prevById = new Map(prev.map((e) => [e.id, e]));
      const changedIds: string[] = [];

      const updated = nextData.map((entry) => {
        const previous = prevById.get(entry.id);
        // Normalize date (DateCell returns string, we need Date)
        const normalizedEntry = {
          ...entry,
          date: normalizeDate(entry.date),
        };

        if (!previous) {
          changedIds.push(entry.id);
          return normalizedEntry;
        }

        // Check if any field changed
        const dateChanged = normalizedEntry.date.getTime() !== previous.date.getTime();
        const valueChanged = entry.value !== previous.value;
        const notesChanged = entry.notes !== previous.notes;

        if (dateChanged || valueChanged || notesChanged) {
          changedIds.push(entry.id);
          return normalizedEntry;
        }

        return previous;
      });

      if (changedIds.length > 0) {
        setDirtyIds((prev) => {
          const next = new Set(prev);
          changedIds.forEach((id) => next.add(id));
          return next;
        });
      }

      return updated;
    });
  }, []);

  // Add a new row
  const onRowAdd = useCallback(() => {
    const draft = createDraftEntry(currency);
    setLocalEntries((prev) => [draft, ...prev]);
    setDirtyIds((prev) => new Set(prev).add(draft.id));
    return { rowIndex: 0, columnId: "date" };
  }, [currency]);

  // Add multiple rows
  const onRowsAdd = useCallback(
    (count: number) => {
      if (count <= 0) return;
      const drafts = Array.from({ length: count }, () => createDraftEntry(currency));
      setLocalEntries((prev) => [...drafts, ...prev]);
      setDirtyIds((prev) => {
        const next = new Set(prev);
        drafts.forEach((d) => next.add(d.id));
        return next;
      });
    },
    [currency],
  );

  // Delete rows
  const onRowsDelete = useCallback((rowsToDelete: ValueHistoryEntry[]) => {
    if (rowsToDelete.length === 0) return;

    const newIds = rowsToDelete.filter((r) => r.isNew).map((r) => r.id);
    const existingIds = rowsToDelete.filter((r) => !r.isNew).map((r) => r.id);

    // Remove new entries immediately
    if (newIds.length > 0) {
      setLocalEntries((prev) => prev.filter((e) => !newIds.includes(e.id)));
      setDirtyIds((prev) => {
        const next = new Set(prev);
        newIds.forEach((id) => next.delete(id));
        return next;
      });
    }

    // Mark existing entries for deletion
    if (existingIds.length > 0) {
      setDeletedIds((prev) => {
        const next = new Set(prev);
        existingIds.forEach((id) => next.add(id));
        return next;
      });
      setLocalEntries((prev) => prev.filter((e) => !existingIds.includes(e.id)));
    }
  }, []);

  // Initialize data grid
  const dataGrid = useDataGrid<ValueHistoryEntry>({
    data: localEntries,
    columns,
    getRowId: (row) => row.id,
    enableRowSelection: true,
    enableMultiRowSelection: true,
    enableSorting: true,
    enableSearch: true,
    enablePaste: true,
    onDataChange,
    onRowAdd,
    onRowsAdd,
    onRowsDelete,
    initialState: {
      sorting: [{ id: "date", desc: true }],
    },
  });

  const selectedRowCount = dataGrid.table.getSelectedRowModel().rows.length;

  // Delete selected rows
  const handleDeleteSelected = useCallback(() => {
    const selected = dataGrid.table.getSelectedRowModel().rows;
    if (selected.length === 0) return;
    onRowsDelete(selected.map((row) => row.original));
    dataGrid.table.resetRowSelection();
  }, [dataGrid.table, onRowsDelete]);

  // Save all changes
  const handleSave = useCallback(() => {
    // Save dirty entries
    for (const entry of localEntries) {
      if (dirtyIds.has(entry.id)) {
        const quote = toQuote(entry, symbol);
        onSaveQuote(quote);
      }
    }

    // Delete marked entries
    for (const id of deletedIds) {
      if (!id.startsWith("temp-")) {
        onDeleteQuote(id);
      }
    }

    // Reset state
    setDirtyIds(new Set());
    setDeletedIds(new Set());
  }, [localEntries, dirtyIds, deletedIds, symbol, onSaveQuote, onDeleteQuote]);

  // Cancel changes
  const handleCancel = useCallback(() => {
    setLocalEntries(initialEntries);
    setDirtyIds(new Set());
    setDeletedIds(new Set());
    dataGrid.table.resetRowSelection();
  }, [initialEntries, dataGrid.table]);

  return (
    <div className="flex min-h-0 flex-1 flex-col space-y-3">
      <ValueHistoryToolbar
        selectedRowCount={selectedRowCount}
        hasUnsavedChanges={hasUnsavedChanges}
        dirtyCount={dirtyIds.size}
        deletedCount={deletedIds.size}
        onAddRow={() => dataGrid.onRowAdd?.()}
        onDeleteSelected={handleDeleteSelected}
        onSave={handleSave}
        onCancel={handleCancel}
        isLiability={isLiability}
      />

      <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
        <DataGrid {...dataGrid} stretchColumns height="calc(100vh - 340px)" />
      </div>
    </div>
  );
}

export default ValueHistoryDataGrid;
