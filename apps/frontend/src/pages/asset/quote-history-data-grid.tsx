import { useIsMobileViewport } from "@/hooks/use-platform";
import type { Quote } from "@/lib/types";
import { parseLocalDate } from "@/lib/utils";
import { createColumnHelper } from "@tanstack/react-table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  calendarDateFromLocalDate,
  DataGrid,
  DatePickerInput,
  Icons,
  MoneyInput,
  useAmountFormatting,
  useDataGrid,
  useDateFormatting,
  useNumberFormatting,
} from "@wealthfolio/ui";
import { format } from "date-fns";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { QuoteHistoryToolbar } from "./quote-history-toolbar";
import { toQuoteEntry, type QuoteEntry } from "./quote-history-utils";

// Helper to normalize date values (handles both Date objects and strings from DateCell)
const normalizeDate = (value: Date | string): Date => {
  if (value instanceof Date) return value;
  return parseLocalDate(value);
};

const QUOTE_DECIMAL_PRECISION = 8;

interface QuoteHistoryDataGridProps {
  /** Quote data from the backend */
  data: Quote[];
  /** Asset ID for the asset */
  assetId: string;
  /** Currency for the asset */
  currency: string;
  /** Whether manual tracking is enabled */
  isManualDataSource?: boolean;
  /** Callback to save a quote; rejects when the save fails */
  onSaveQuote: (quote: Quote) => Promise<void>;
  /** Callback to delete a quote; rejects when the delete fails */
  onDeleteQuote: (quoteId: string) => Promise<void>;
  /** Callback to change data source mode */
  onChangeDataSource?: (isManual: boolean) => void;
}

// Generate a temporary ID for new entries
const generateTempId = () => `temp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

// A price left at 0 was not entered. Like quote imports and providers, fall back to close.
const priceOrClose = (price: number, close: number) => (price === 0 ? close : price);

// Convert QuoteEntry back to Quote for saving
const toQuote = (entry: QuoteEntry, assetId: string): Quote => {
  const datePart = format(entry.date, "yyyy-MM-dd").replace(/-/g, "");
  return {
    id: entry.id.startsWith("temp-") ? `${datePart}_${assetId.toUpperCase()}` : entry.id,
    createdAt: new Date().toISOString(),
    dataSource: "MANUAL",
    timestamp: format(entry.date, "yyyy-MM-dd'T'00:00:00'Z'"),
    assetId: assetId,
    open: priceOrClose(entry.open, entry.close),
    high: priceOrClose(entry.high, entry.close),
    low: priceOrClose(entry.low, entry.close),
    close: entry.close,
    volume: entry.volume,
    adjclose: entry.close,
    currency: entry.currency,
  };
};

// Manual quotes are stored under one ID per asset and day
const canonicalQuoteId = (entry: QuoteEntry, assetId: string): string =>
  `${assetId}_${format(entry.date, "yyyy-MM-dd")}_MANUAL`;

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
  const amountFormatting = useAmountFormatting();
  const dateFormatting = useDateFormatting();
  const numberFormatting = useNumberFormatting();

  const renderPriceCellValue = useCallback(
    (value: number | string | null, rowData: unknown) =>
      amountFormatting.formatPrice(value, (rowData as QuoteEntry).currency, false),
    [amountFormatting],
  );

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
    [columnHelper, stepValue, isManualDataSource, handleDeleteRow, renderPriceCellValue, t],
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

  // Save all changes. The mutations report their own failures.
  const handleSave = useCallback(() => {
    // Save dirty entries
    for (const entry of localEntries) {
      if (dirtyIds.has(entry.id)) {
        const quote = toQuote(entry, assetId);
        onSaveQuote(quote).catch(() => undefined);
      }
    }

    // Delete marked entries
    for (const id of deletedIds) {
      if (!id.startsWith("temp-")) {
        onDeleteQuote(id).catch(() => undefined);
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

  // Mobile state: one quote is edited at a time and saved on its own.
  const [mobilePage, setMobilePage] = useState(0);
  const [mobileDraft, setMobileDraft] = useState<QuoteEntry | null>(null);
  const [mobileDeleteEntry, setMobileDeleteEntry] = useState<QuoteEntry | null>(null);
  const [isPersisting, setIsPersisting] = useState(false);
  // Leaving manual mode (toolbar switch or asset editor) drops the open quote.
  const [draftIsManual, setDraftIsManual] = useState(isManualDataSource);
  if (draftIsManual !== isManualDataSource) {
    setDraftIsManual(isManualDataSource);
    setMobileDraft(null);
    setMobileDeleteEntry(null);
  }
  const sortedEntries = useMemo(
    () => [...localEntries].sort((a, b) => b.date.getTime() - a.date.getTime()),
    [localEntries],
  );
  const mobilePageCount = Math.max(1, Math.ceil(sortedEntries.length / MOBILE_PAGE_SIZE));
  // Deleting the last quote on the last page must not leave an empty page.
  const currentMobilePage = Math.min(mobilePage, mobilePageCount - 1);
  const mobilePageEntries = sortedEntries.slice(
    currentMobilePage * MOBILE_PAGE_SIZE,
    (currentMobilePage + 1) * MOBILE_PAGE_SIZE,
  );

  // Mobile: open a new quote for editing
  const handleMobileAdd = useCallback(() => {
    setMobilePage(0);
    setMobileDraft(createDraftEntry(currency));
  }, [currency]);

  // Mobile: update a field on the open quote
  const handleMobileFieldChange = useCallback(
    (field: "date" | "open" | "high" | "low" | "close" | "volume", value: number | Date) => {
      setMobileDraft((draft) => (draft ? { ...draft, [field]: value } : draft));
    },
    [],
  );

  const handleMobileSave = useCallback(async () => {
    if (!mobileDraft || isPersisting) return;

    const draft = mobileDraft;
    // The backend stores every manual save under the canonical ID, replacing a provider ID.
    const savedEntry: QuoteEntry = {
      ...draft,
      id: canonicalQuoteId(draft, assetId),
      isNew: false,
    };

    setIsPersisting(true);
    try {
      await onSaveQuote(toQuote(draft, assetId));
      // A manual quote replaces any other quote on the same day.
      const savedDay = format(savedEntry.date, "yyyy-MM-dd");
      setLocalEntries((prev) => [
        savedEntry,
        ...prev.filter(
          (entry) => entry.id !== draft.id && format(entry.date, "yyyy-MM-dd") !== savedDay,
        ),
      ]);
      setMobileDraft(null);
    } catch {
      // The mutation reports the error. Keep the draft open for retry.
    } finally {
      setIsPersisting(false);
    }
  }, [assetId, isPersisting, mobileDraft, onSaveQuote]);

  const handleMobileDelete = useCallback(async () => {
    if (!mobileDeleteEntry || isPersisting) return;

    const entryToDelete = mobileDeleteEntry;
    setIsPersisting(true);
    try {
      await onDeleteQuote(entryToDelete.id);
      setLocalEntries((prev) => prev.filter((entry) => entry.id !== entryToDelete.id));
      setMobileDraft((draft) => (draft?.id === entryToDelete.id ? null : draft));
      setMobileDeleteEntry(null);
    } catch {
      // The mutation reports the error. Keep the dialog open for retry.
    } finally {
      setIsPersisting(false);
    }
  }, [isPersisting, mobileDeleteEntry, onDeleteQuote]);

  if (isMobile) {
    const mobileEntries = mobileDraft?.isNew
      ? [mobileDraft, ...mobilePageEntries]
      : mobilePageEntries;
    const priceFields = [
      { field: "close", label: t("asset:quoteGrid.close") },
      { field: "open", label: t("asset:quoteGrid.open") },
      { field: "high", label: t("asset:quoteGrid.high") },
      { field: "low", label: t("asset:quoteGrid.low") },
    ] as const;

    return (
      <div className="flex flex-col space-y-3">
        <QuoteHistoryToolbar
          selectedRowCount={0}
          hasUnsavedChanges={hasUnsavedChanges}
          dirtyCount={dirtyIds.size}
          deletedCount={deletedIds.size}
          isManualDataSource={isManualDataSource}
          isAddDisabled={mobileDraft !== null || isPersisting}
          onAddRow={handleMobileAdd}
          onDeleteSelected={handleDeleteSelected}
          onSave={handleSave}
          onCancel={handleCancel}
          onChangeDataSource={onChangeDataSource}
        />

        <div className="divide-y rounded-md border">
          {mobileEntries.length === 0 ? (
            <p className="text-muted-foreground p-6 text-center text-sm">
              {t("asset:quoteGrid.no_quotes_available")}
            </p>
          ) : (
            mobileEntries.map((entry) => {
              if (mobileDraft?.id === entry.id) {
                const draft = mobileDraft;

                return (
                  <div key={draft.id} className="bg-muted/30 space-y-3 p-3">
                    <span className="block text-xs font-medium uppercase tracking-wide">
                      {draft.isNew
                        ? t("asset:quoteGrid.new_quote")
                        : t("asset:quoteGrid.edit_quote")}
                    </span>
                    <div className="space-y-2">
                      <div>
                        <label className="text-muted-foreground mb-1 block text-xs">
                          {t("asset:quoteGrid.date")}
                        </label>
                        <DatePickerInput
                          value={draft.date}
                          disabled={isPersisting}
                          onChange={(date) => date && handleMobileFieldChange("date", date)}
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        {priceFields.map(({ field, label }) => (
                          <div key={field}>
                            <label className="text-muted-foreground mb-1 block text-xs">
                              {label}
                            </label>
                            <MoneyInput
                              value={draft[field] || ""}
                              maxDecimalPlaces={QUOTE_DECIMAL_PRECISION}
                              placeholder="0"
                              disabled={isPersisting}
                              aria-label={label}
                              onValueChange={(value, isUserEdit) => {
                                if (!isUserEdit) return;
                                handleMobileFieldChange(field, value ?? 0);
                              }}
                            />
                          </div>
                        ))}
                        <div>
                          <label className="text-muted-foreground mb-1 block text-xs">
                            {t("asset:quoteGrid.volume")}
                          </label>
                          <MoneyInput
                            value={draft.volume || ""}
                            maxDecimalPlaces={0}
                            placeholder="0"
                            disabled={isPersisting}
                            aria-label={t("asset:quoteGrid.volume")}
                            onValueChange={(value, isUserEdit) => {
                              if (!isUserEdit) return;
                              handleMobileFieldChange("volume", value ?? 0);
                            }}
                          />
                        </div>
                      </div>
                    </div>
                    <div className="flex justify-end gap-2 pt-1">
                      <Button
                        variant="outline"
                        className="h-11"
                        disabled={isPersisting}
                        onClick={() => setMobileDraft(null)}
                      >
                        {t("common:cancel")}
                      </Button>
                      <Button className="h-11" disabled={isPersisting} onClick={handleMobileSave}>
                        <Icons.Save className="mr-2 h-4 w-4" aria-hidden="true" />
                        {t("common:save")}
                      </Button>
                    </div>
                  </div>
                );
              }

              const dateLabel = dateFormatting.formatCalendarDate(
                calendarDateFromLocalDate(entry.date),
                { dateStyle: "short" },
              );
              const closeLabel = amountFormatting.formatPrice(entry.close, entry.currency, false);
              const details = (
                <>
                  <span className="flex items-center justify-between">
                    <span className="text-sm font-medium">{dateLabel}</span>
                    <span className="text-sm font-semibold">{closeLabel}</span>
                  </span>
                  <span className="text-muted-foreground grid grid-cols-4 gap-x-2 text-xs">
                    <span>
                      <span className="block">{t("asset:quoteGrid.open")}</span>
                      <span className="text-foreground">
                        {amountFormatting.formatPrice(entry.open, entry.currency, false)}
                      </span>
                    </span>
                    <span>
                      <span className="block">{t("asset:quoteGrid.high")}</span>
                      <span className="text-foreground">
                        {amountFormatting.formatPrice(entry.high, entry.currency, false)}
                      </span>
                    </span>
                    <span>
                      <span className="block">{t("asset:quoteGrid.low")}</span>
                      <span className="text-foreground">
                        {amountFormatting.formatPrice(entry.low, entry.currency, false)}
                      </span>
                    </span>
                    <span>
                      <span className="block">{t("asset:quoteGrid.vol")}</span>
                      <span className="text-foreground">
                        {numberFormatting.formatDecimal(entry.volume)}
                      </span>
                    </span>
                  </span>
                </>
              );

              if (!isManualDataSource) {
                return (
                  <div key={entry.id} className="space-y-1.5 p-3">
                    {details}
                  </div>
                );
              }

              return (
                <div key={entry.id} className="flex items-center gap-1 p-1.5">
                  <button
                    type="button"
                    className="active:bg-muted/40 min-w-0 flex-1 space-y-1.5 rounded-md p-1.5 text-left disabled:opacity-50"
                    aria-label={t("asset:valueHistory.edit_entry_aria", {
                      date: dateLabel,
                      value: closeLabel,
                    })}
                    disabled={isPersisting}
                    onClick={() => setMobileDraft({ ...entry })}
                  >
                    {details}
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-destructive h-11 w-11 shrink-0"
                    aria-label={t("asset:valueHistory.delete_entry_aria", {
                      date: dateLabel,
                      value: closeLabel,
                    })}
                    disabled={isPersisting}
                    onClick={() => setMobileDeleteEntry(entry)}
                  >
                    <Icons.Trash className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
              );
            })
          )}
        </div>

        {/* Pagination */}
        {mobilePageCount > 1 && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {t("asset:quoteGrid.page_of", {
                page: currentMobilePage + 1,
                total: mobilePageCount,
              })}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setMobilePage(currentMobilePage - 1)}
                disabled={currentMobilePage === 0 || mobileDraft !== null || isPersisting}
              >
                {t("asset:quoteGrid.previous")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setMobilePage(currentMobilePage + 1)}
                disabled={
                  currentMobilePage >= mobilePageCount - 1 || mobileDraft !== null || isPersisting
                }
              >
                {t("asset:quoteGrid.next")}
              </Button>
            </div>
          </div>
        )}

        <AlertDialog
          open={mobileDeleteEntry !== null}
          onOpenChange={(open) => !open && !isPersisting && setMobileDeleteEntry(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("asset:valueHistory.delete_title")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("asset:valueHistory.delete_description")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isPersisting}>{t("common:cancel")}</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                disabled={isPersisting}
                onClick={(event) => {
                  event.preventBaseUIHandler();
                  void handleMobileDelete();
                }}
              >
                {t("common:delete")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
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
