import {
  Button,
  DataGrid,
  DatePickerInput,
  Icons,
  Input,
  useDataGrid,
  formatPrice,
} from "@wealthfolio/ui";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { createColumnHelper } from "@tanstack/react-table";
import type { Quote } from "@/lib/types";
import { QuoteHistoryToolbar } from "./quote-history-toolbar";
import { toQuoteEntry, type QuoteEntry } from "./quote-history-utils";
import { format } from "date-fns";
import { useIsMobileViewport } from "@/hooks/use-platform";

// Helper to normalize date values (handles both Date objects and strings from DateCell)
const normalizeDate = (value: Date | string): Date => {
  if (value instanceof Date) return value;
  return new Date(value);
};

const QUOTE_DECIMAL_PRECISION = 8;

const renderPriceCellValue = (value: number | string | null, rowData: unknown) =>
  formatPrice(value, (rowData as QuoteEntry).currency, false);

interface QuoteHistoryDataGridProps {
  /** Quote data from the backend */
  data: Quote[];
  /** Asset ID for the asset */
  assetId: string;
  /** Currency for the asset */
  currency: string;
  /** Whether manual tracking is enabled */
  isManualDataSource?: boolean;
  /** Callback to save a quote */
  onSaveQuote: (quote: Quote) => void;
  /** Callback to delete a quote */
  onDeleteQuote: (quoteId: string) => void;
  /** Callback to change data source mode */
  onChangeDataSource?: (isManual: boolean) => void;
}

// Generate a temporary ID for new entries
const generateTempId = () => `temp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

// Convert QuoteEntry back to Quote for saving
const toQuote = (entry: QuoteEntry, assetId: string): Quote => {
  const datePart = format(entry.date, "yyyy-MM-dd").replace(/-/g, "");
  return {
    id: entry.id.startsWith("temp-") ? `${datePart}_${assetId.toUpperCase()}` : entry.id,
    createdAt: new Date().toISOString(),
    dataSource: "MANUAL",
    timestamp: entry.date.toISOString(),
    assetId: assetId,
    open: entry.open,
    high: entry.high,
    low: entry.low,
    close: entry.close,
    volume: entry.volume,
    adjclose: entry.close,
    currency: entry.currency,
  };
};

// Create draft entry
const createDraftEntry = (currency: string): QuoteEntry => ({
  id: generateTempId(),
  date: new Date(),
  open: 0,
  high: 0,
  low: 0,
  close: 0,
  volume: 0,
  currency,
  isNew: true,
});

// Pagination constants
const MOBILE_PAGE_SIZE = 20;

export function QuoteHistoryDataGrid({
  data,
  assetId,
  currency,
  isManualDataSource = false,
  onSaveQuote,
  onDeleteQuote,
  onChangeDataSource,
}: QuoteHistoryDataGridProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobileViewport();
  // Convert quotes to local entries without changing their stored precision.
  const initialEntries = useMemo(
    () => data.map(toQuoteEntry).sort((a, b) => b.date.getTime() - a.date.getTime()),
    [data],
  );

  const [localEntries, setLocalEntries] = useState<QuoteEntry[]>(initialEntries);
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

  // Column definitions
  const columnHelper = createColumnHelper<QuoteEntry>();

  // Calculate step value for number inputs based on precision
  const stepValue = Math.pow(10, -QUOTE_DECIMAL_PRECISION);

  // Delete a single row
  const handleDeleteRow = useCallback((entry: QuoteEntry) => {
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
        header: t("asset:quoteGrid.date"),
        size: 140,
        meta: { cell: { variant: "date-input" } },
      }),
      columnHelper.accessor("open", {
        header: t("asset:quoteGrid.open"),
        size: 120,
        meta: {
          cell: { variant: "number", min: 0, step: stepValue, valueRenderer: renderPriceCellValue },
        },
      }),
      columnHelper.accessor("high", {
        header: t("asset:quoteGrid.high"),
        size: 120,
        meta: {
          cell: { variant: "number", min: 0, step: stepValue, valueRenderer: renderPriceCellValue },
        },
      }),
      columnHelper.accessor("low", {
        header: t("asset:quoteGrid.low"),
        size: 120,
        meta: {
          cell: { variant: "number", min: 0, step: stepValue, valueRenderer: renderPriceCellValue },
        },
      }),
      columnHelper.accessor("close", {
        header: t("asset:quoteGrid.close"),
        size: 120,
        meta: {
          cell: { variant: "number", min: 0, step: stepValue, valueRenderer: renderPriceCellValue },
        },
      }),
      columnHelper.accessor("volume", {
        header: t("asset:quoteGrid.volume"),
        size: 120,
        meta: { cell: { variant: "number", min: 0 } },
      }),
      // Actions column (only visible in manual mode)
      ...(isManualDataSource
        ? [
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
          ]
        : []),
    ],
    [columnHelper, stepValue, isManualDataSource, handleDeleteRow, t],
  );

  // Handle data changes from the grid
  const onDataChange = useCallback((nextData: QuoteEntry[]) => {
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
        const openChanged = entry.open !== previous.open;
        const highChanged = entry.high !== previous.high;
        const lowChanged = entry.low !== previous.low;
        const closeChanged = entry.close !== previous.close;
        const volumeChanged = entry.volume !== previous.volume;

        if (
          dateChanged ||
          openChanged ||
          highChanged ||
          lowChanged ||
          closeChanged ||
          volumeChanged
        ) {
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
  const onRowsDelete = useCallback((rowsToDelete: QuoteEntry[]) => {
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
  const dataGrid = useDataGrid<QuoteEntry>({
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
        const quote = toQuote(entry, assetId);
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
  }, [localEntries, dirtyIds, deletedIds, assetId, onSaveQuote, onDeleteQuote]);

  // Cancel changes
  const handleCancel = useCallback(() => {
    setLocalEntries(initialEntries);
    setDirtyIds(new Set());
    setDeletedIds(new Set());
    dataGrid.table.resetRowSelection();
  }, [initialEntries, dataGrid.table]);

  // Mobile state
  const [mobilePage, setMobilePage] = useState(0);
  const [mobileEditingId, setMobileEditingId] = useState<string | null>(null);
  const sortedEntries = useMemo(
    () => [...localEntries].sort((a, b) => b.date.getTime() - a.date.getTime()),
    [localEntries],
  );
  const mobilePageCount = Math.max(1, Math.ceil(sortedEntries.length / MOBILE_PAGE_SIZE));
  const mobilePageEntries = sortedEntries.slice(
    mobilePage * MOBILE_PAGE_SIZE,
    (mobilePage + 1) * MOBILE_PAGE_SIZE,
  );

  // Mobile: add a new row and open it for editing
  const handleMobileAdd = useCallback(() => {
    const draft = createDraftEntry(currency);
    setLocalEntries((prev) => [draft, ...prev]);
    setDirtyIds((prev) => new Set(prev).add(draft.id));
    setMobilePage(0);
    setMobileEditingId(draft.id);
  }, [currency]);

  // Mobile: update a field on a specific entry
  const handleMobileFieldChange = useCallback(
    (id: string, field: keyof QuoteEntry, value: number | Date) => {
      setLocalEntries((prev) => prev.map((e) => (e.id === id ? { ...e, [field]: value } : e)));
      setDirtyIds((prev) => new Set(prev).add(id));
    },
    [],
  );

  if (isMobile) {
    return (
      <div className="flex flex-col space-y-3">
        <QuoteHistoryToolbar
          selectedRowCount={0}
          hasUnsavedChanges={hasUnsavedChanges}
          dirtyCount={dirtyIds.size}
          deletedCount={deletedIds.size}
          isManualDataSource={isManualDataSource}
          onAddRow={handleMobileAdd}
          onDeleteSelected={handleDeleteSelected}
          onSave={handleSave}
          onCancel={handleCancel}
          onChangeDataSource={onChangeDataSource}
        />

        <div className="divide-y rounded-md border">
          {mobilePageEntries.length === 0 ? (
            <p className="text-muted-foreground p-6 text-center text-sm">
              {t("asset:quoteGrid.no_quotes_available")}
            </p>
          ) : (
            mobilePageEntries.map((entry) => {
              const isEditing = mobileEditingId === entry.id;

              if (isEditing && isManualDataSource) {
                return (
                  <div key={entry.id} className="bg-muted/30 space-y-3 p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium uppercase tracking-wide">
                        {entry.isNew
                          ? t("asset:quoteGrid.new_quote")
                          : t("asset:quoteGrid.edit_quote")}
                      </span>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => setMobileEditingId(null)}
                        >
                          <Icons.Check className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <div>
                        <label className="text-muted-foreground mb-1 block text-xs">
                          {t("asset:quoteGrid.date")}
                        </label>
                        <DatePickerInput
                          value={entry.date}
                          onChange={(date) =>
                            date && handleMobileFieldChange(entry.id, "date", date)
                          }
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-muted-foreground mb-1 block text-xs">
                            {t("asset:quoteGrid.close")}
                          </label>
                          <Input
                            type="number"
                            value={entry.close || ""}
                            step={stepValue}
                            placeholder="0"
                            onChange={(e) =>
                              handleMobileFieldChange(
                                entry.id,
                                "close",
                                parseFloat(e.target.value) || 0,
                              )
                            }
                          />
                        </div>
                        <div>
                          <label className="text-muted-foreground mb-1 block text-xs">
                            {t("asset:quoteGrid.open")}
                          </label>
                          <Input
                            type="number"
                            value={entry.open || ""}
                            step={stepValue}
                            placeholder="0"
                            onChange={(e) =>
                              handleMobileFieldChange(
                                entry.id,
                                "open",
                                parseFloat(e.target.value) || 0,
                              )
                            }
                          />
                        </div>
                        <div>
                          <label className="text-muted-foreground mb-1 block text-xs">
                            {t("asset:quoteGrid.high")}
                          </label>
                          <Input
                            type="number"
                            value={entry.high || ""}
                            step={stepValue}
                            placeholder="0"
                            onChange={(e) =>
                              handleMobileFieldChange(
                                entry.id,
                                "high",
                                parseFloat(e.target.value) || 0,
                              )
                            }
                          />
                        </div>
                        <div>
                          <label className="text-muted-foreground mb-1 block text-xs">
                            {t("asset:quoteGrid.low")}
                          </label>
                          <Input
                            type="number"
                            value={entry.low || ""}
                            step={stepValue}
                            placeholder="0"
                            onChange={(e) =>
                              handleMobileFieldChange(
                                entry.id,
                                "low",
                                parseFloat(e.target.value) || 0,
                              )
                            }
                          />
                        </div>
                        <div>
                          <label className="text-muted-foreground mb-1 block text-xs">
                            {t("asset:quoteGrid.volume")}
                          </label>
                          <Input
                            type="number"
                            value={entry.volume || ""}
                            placeholder="0"
                            onChange={(e) =>
                              handleMobileFieldChange(
                                entry.id,
                                "volume",
                                parseInt(e.target.value) || 0,
                              )
                            }
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                );
              }

              return (
                <div
                  key={entry.id}
                  className={`space-y-1.5 p-3 ${isManualDataSource ? "active:bg-muted/40 cursor-pointer" : ""}`}
                  onClick={isManualDataSource ? () => setMobileEditingId(entry.id) : undefined}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{format(entry.date, "yyyy-MM-dd")}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">
                        {formatPrice(entry.close, entry.currency, false)}
                      </span>
                      {isManualDataSource && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground hover:text-destructive h-7 w-7"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteRow(entry);
                          }}
                        >
                          <Icons.X className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                  <div className="text-muted-foreground grid grid-cols-4 gap-x-2 text-xs">
                    <div>
                      <span className="block">{t("asset:quoteGrid.open")}</span>
                      <span className="text-foreground">
                        {formatPrice(entry.open, entry.currency, false)}
                      </span>
                    </div>
                    <div>
                      <span className="block">{t("asset:quoteGrid.high")}</span>
                      <span className="text-foreground">
                        {formatPrice(entry.high, entry.currency, false)}
                      </span>
                    </div>
                    <div>
                      <span className="block">{t("asset:quoteGrid.low")}</span>
                      <span className="text-foreground">
                        {formatPrice(entry.low, entry.currency, false)}
                      </span>
                    </div>
                    <div>
                      <span className="block">{t("asset:quoteGrid.vol")}</span>
                      <span className="text-foreground">{entry.volume.toLocaleString()}</span>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Pagination */}
        {mobilePageCount > 1 && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {t("asset:quoteGrid.page_of", { page: mobilePage + 1, total: mobilePageCount })}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setMobilePage((p) => p - 1)}
                disabled={mobilePage === 0}
              >
                {t("asset:quoteGrid.previous")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setMobilePage((p) => p + 1)}
                disabled={mobilePage >= mobilePageCount - 1}
              >
                {t("asset:quoteGrid.next")}
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col space-y-3">
      <QuoteHistoryToolbar
        selectedRowCount={selectedRowCount}
        hasUnsavedChanges={hasUnsavedChanges}
        dirtyCount={dirtyIds.size}
        deletedCount={deletedIds.size}
        isManualDataSource={isManualDataSource}
        onAddRow={() => dataGrid.onRowAdd?.()}
        onDeleteSelected={handleDeleteSelected}
        onSave={handleSave}
        onCancel={handleCancel}
        onChangeDataSource={onChangeDataSource}
      />

      <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
        <DataGrid {...dataGrid} stretchColumns height="calc(100vh - 340px)" />
      </div>
    </div>
  );
}

export default QuoteHistoryDataGrid;
