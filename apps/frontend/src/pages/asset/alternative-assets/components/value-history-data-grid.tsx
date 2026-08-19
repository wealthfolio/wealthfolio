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
  DataGrid,
  DatePickerInput,
  Icons,
  InputGroup,
  InputGroupAddon,
  InputGroupText,
  MoneyInput,
  Textarea,
  useAmountFormatting,
  useDataGrid,
  useDateFormatting,
} from "@wealthfolio/ui";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createColumnHelper } from "@tanstack/react-table";
import type { Quote } from "@/lib/types";
import { useIsMobileViewport } from "@/hooks/use-platform";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { ValueHistoryToolbar } from "./value-history-toolbar";
import { format } from "date-fns";

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const UTC_MIDNIGHT_REGEX = /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.\d+)?Z$/;
const MOBILE_PAGE_SIZE = 20;

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
  /** Asset identifier used for canonical manual quote IDs */
  assetId: string;
  /** Currency for the asset */
  currency: string;
  /** Whether this is a liability (changes "Value" to "Balance" label) */
  isLiability?: boolean;
  /** Callback to save a quote */
  onSaveQuote: (quote: Quote) => Promise<void>;
  /** Callback to delete a quote */
  onDeleteQuote: (quoteId: string) => Promise<void>;
  /** Refresh quote-dependent queries after a complete persistence operation */
  onPersistComplete: () => Promise<void>;
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

const canonicalQuoteId = (entry: ValueHistoryEntry, assetId: string): string => {
  const datePart = format(entry.date, "yyyy-MM-dd");
  return `${assetId}_${datePart}_MANUAL`;
};

// Convert ValueHistoryEntry back to Quote for saving
const toQuote = (entry: ValueHistoryEntry, assetId: string): Quote => {
  const id =
    entry.isNew || entry.id.startsWith("temp-") ? canonicalQuoteId(entry, assetId) : entry.id;
  return {
    id,
    createdAt: new Date().toISOString(),
    dataSource: "MANUAL",
    timestamp: format(entry.date, "yyyy-MM-dd'T'00:00:00'Z'"),
    assetId,
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

const hasDuplicateDates = (entries: ValueHistoryEntry[]): boolean => {
  const dates = new Set<string>();
  return entries.some((entry) => {
    const date = format(entry.date, "yyyy-MM-dd");
    if (dates.has(date)) return true;
    dates.add(date);
    return false;
  });
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
  assetId,
  currency,
  isLiability = false,
  onSaveQuote,
  onDeleteQuote,
  onPersistComplete,
}: ValueHistoryDataGridProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobileViewport();
  const amountFormatting = useAmountFormatting();
  const dateFormatting = useDateFormatting();
  // Convert quotes to local entries
  const initialEntries = useMemo(
    () => data.map(toValueHistoryEntry).sort((a, b) => b.date.getTime() - a.date.getTime()),
    [data],
  );

  const [localEntries, setLocalEntries] = useState<ValueHistoryEntry[]>(initialEntries);
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(new Set());
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());
  const [mobilePage, setMobilePage] = useState(0);
  const [mobileDraft, setMobileDraft] = useState<ValueHistoryEntry | null>(null);
  const [mobileDeleteEntry, setMobileDeleteEntry] = useState<ValueHistoryEntry | null>(null);
  const [isPersisting, setIsPersisting] = useState(false);
  const mobileNotesId = useId();
  const lastSyncedEntriesRef = useRef(initialEntries);

  // Track if there are unsaved changes
  const hasUnsavedChanges = dirtyIds.size > 0 || deletedIds.size > 0;
  const hasPendingEdits = hasUnsavedChanges || mobileDraft !== null;

  // Sync with external data changes
  useEffect(() => {
    if (initialEntries === lastSyncedEntriesRef.current) return;
    if (isPersisting || hasPendingEdits) return;
    setLocalEntries(initialEntries);
    setMobileDeleteEntry(null);
    lastSyncedEntriesRef.current = initialEntries;
  }, [hasPendingEdits, initialEntries, isPersisting]);

  // Column definitions
  const columnHelper = createColumnHelper<ValueHistoryEntry>();

  // Delete a single row
  const handleDeleteRow = useCallback(
    (entry: ValueHistoryEntry) => {
      if (isPersisting) return;

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
    },
    [isPersisting],
  );

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
              disabled={isPersisting}
              onClick={() => handleDeleteRow(row.original)}
            >
              <Icons.X className="h-4 w-4" />
            </Button>
          </div>
        ),
      }),
    ],
    [columnHelper, isLiability, handleDeleteRow, isPersisting, t],
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
    readOnly: isPersisting,
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
  const handleSave = useCallback(async () => {
    if (isPersisting) return;
    if (hasDuplicateDates(localEntries)) {
      toast({
        title: t("asset:valueHistory.duplicate_date_error"),
        variant: "destructive",
      });
      return;
    }

    const dirtyIdsSnapshot = new Set(dirtyIds);
    const deletedIdsSnapshot = new Set(deletedIds);
    const entriesToSave = localEntries.filter((entry) => dirtyIdsSnapshot.has(entry.id));
    const quotesToSave = entriesToSave.map((entry) => toQuote(entry, assetId));
    const idsToDelete = [...deletedIdsSnapshot].filter((id) => !id.startsWith("temp-"));

    setIsPersisting(true);
    try {
      // Delete first so a same-day replacement cannot be removed after it is saved.
      for (const id of idsToDelete) {
        await onDeleteQuote(id);
      }
      for (const quote of quotesToSave) {
        await onSaveQuote(quote);
      }

      const savedEntries = new Map(
        entriesToSave.map((entry) => [
          entry.id,
          { ...entry, id: canonicalQuoteId(entry, assetId), isNew: false },
        ]),
      );
      setLocalEntries((current) => current.map((entry) => savedEntries.get(entry.id) ?? entry));
      setDirtyIds((current) => {
        const next = new Set(current);
        dirtyIdsSnapshot.forEach((id) => next.delete(id));
        return next;
      });
      setDeletedIds((current) => {
        const next = new Set(current);
        deletedIdsSnapshot.forEach((id) => next.delete(id));
        return next;
      });
      try {
        await onPersistComplete();
      } catch {
        // Persistence succeeded; a later query refresh can recover from a transient refetch error.
      }
    } catch {
      // Mutation callbacks surface their own error notifications. Keep edits for retry.
    } finally {
      setIsPersisting(false);
    }
  }, [
    assetId,
    deletedIds,
    dirtyIds,
    isPersisting,
    localEntries,
    onDeleteQuote,
    onPersistComplete,
    onSaveQuote,
    t,
  ]);

  // Cancel changes
  const handleCancel = useCallback(() => {
    setLocalEntries(initialEntries);
    setDirtyIds(new Set());
    setDeletedIds(new Set());
    dataGrid.table.resetRowSelection();
  }, [initialEntries, dataGrid.table]);

  const sortedEntries = useMemo(
    () => [...localEntries].sort((a, b) => b.date.getTime() - a.date.getTime()),
    [localEntries],
  );
  const mobilePageCount = Math.max(1, Math.ceil(sortedEntries.length / MOBILE_PAGE_SIZE));
  const mobilePageEntries = sortedEntries.slice(
    mobilePage * MOBILE_PAGE_SIZE,
    (mobilePage + 1) * MOBILE_PAGE_SIZE,
  );

  useEffect(() => {
    setMobilePage((page) => Math.min(page, mobilePageCount - 1));
  }, [mobilePageCount]);

  const handleMobileAdd = useCallback(() => {
    setMobilePage(0);
    setMobileDraft(createDraftEntry(currency));
  }, [currency]);

  const handleMobileFieldChange = useCallback(
    (field: "date" | "value" | "notes", value: Date | number | string) => {
      setMobileDraft((draft) => (draft ? { ...draft, [field]: value } : draft));
    },
    [],
  );

  const handleMobileEdit = useCallback((entry: ValueHistoryEntry) => {
    setMobileDraft({ ...entry, date: new Date(entry.date) });
  }, []);

  const handleMobileSave = useCallback(async () => {
    if (!mobileDraft || isPersisting) return;

    const quote = toQuote(mobileDraft, assetId);
    const savedEntry: ValueHistoryEntry = {
      ...mobileDraft,
      id: canonicalQuoteId(mobileDraft, assetId),
      isNew: false,
    };

    setIsPersisting(true);
    try {
      await onSaveQuote(quote);
      const savedDay = format(savedEntry.date, "yyyy-MM-dd");
      setLocalEntries((prev) => [
        savedEntry,
        ...prev.filter(
          (entry) => entry.id !== mobileDraft.id && format(entry.date, "yyyy-MM-dd") !== savedDay,
        ),
      ]);
      setMobileDraft(null);
      try {
        await onPersistComplete();
      } catch {
        // Persistence succeeded; a later query refresh can recover from a transient refetch error.
      }
    } catch {
      // Mutation callback surfaces the error. Keep the draft open for retry.
    } finally {
      setIsPersisting(false);
    }
  }, [assetId, isPersisting, mobileDraft, onPersistComplete, onSaveQuote]);

  const handleMobileDelete = useCallback(async () => {
    if (!mobileDeleteEntry || isPersisting) return;

    const entryToDelete = mobileDeleteEntry;
    setIsPersisting(true);
    try {
      await onDeleteQuote(entryToDelete.id);
      setLocalEntries((prev) => prev.filter((entry) => entry.id !== entryToDelete.id));
      setMobileDraft((draft) => (draft?.id === entryToDelete.id ? null : draft));
      setMobileDeleteEntry(null);
      try {
        await onPersistComplete();
      } catch {
        // Persistence succeeded; a later query refresh can recover from a transient refetch error.
      }
    } catch {
      // Mutation callback surfaces the error. Keep the dialog open for retry.
    } finally {
      setIsPersisting(false);
    }
  }, [isPersisting, mobileDeleteEntry, onDeleteQuote, onPersistComplete]);

  if (isMobile) {
    const valueLabel = isLiability
      ? t("asset:valueHistory.balance")
      : t("asset:valueHistory.value");
    const mobileEntries = mobileDraft?.isNew
      ? [mobileDraft, ...mobilePageEntries]
      : mobilePageEntries;

    return (
      <div className="flex flex-col space-y-3">
        <div>
          <Button
            className="h-11"
            onClick={handleMobileAdd}
            disabled={mobileDraft !== null || isPersisting}
          >
            <Icons.Plus className="mr-2 h-4 w-4" aria-hidden="true" />
            {isLiability ? t("asset:valueToolbar.add_balance") : t("asset:valueToolbar.add_value")}
          </Button>
        </div>

        <div className="bg-background isolate divide-y overflow-hidden rounded-xl border">
          {mobileEntries.length === 0 ? (
            <p className="text-muted-foreground p-6 text-center text-sm">
              {t("asset:altContent.no_valuation_data")}
            </p>
          ) : (
            mobileEntries.map((entry) => {
              const isEditing = mobileDraft?.id === entry.id;

              if (isEditing && mobileDraft) {
                const draft = mobileDraft;

                return (
                  <div key={draft.id} className="bg-background w-full space-y-3 p-3">
                    <div>
                      <span className="text-xs font-medium uppercase tracking-wide">
                        {draft.isNew
                          ? isLiability
                            ? t("asset:valueToolbar.add_balance")
                            : t("asset:valueToolbar.add_value")
                          : t("common:edit")}
                      </span>
                    </div>

                    <div className="space-y-2.5">
                      <div>
                        <label className="text-muted-foreground mb-1 block text-xs">
                          {t("asset:valueHistory.date")}
                        </label>
                        <DatePickerInput
                          value={draft.date}
                          disabled={isPersisting}
                          onChange={(date) => date && handleMobileFieldChange("date", date)}
                        />
                      </div>
                      <div>
                        <label className="text-muted-foreground mb-1 block text-xs">
                          {valueLabel}
                        </label>
                        <InputGroup className="bg-input-bg h-10 rounded-md">
                          <InputGroupAddon align="inline-start">
                            <InputGroupText>
                              {amountFormatting.formatCurrencySymbol(draft.currency)}
                            </InputGroupText>
                          </InputGroupAddon>
                          <MoneyInput
                            data-slot="input-group-control"
                            className="min-w-0 flex-1 rounded-none border-0 bg-transparent shadow-none ring-0 focus-visible:ring-0"
                            value={draft.value}
                            maxDecimalPlaces={2}
                            fixedDecimalScale
                            thousandSeparator
                            disabled={isPersisting}
                            aria-label={valueLabel}
                            onValueChange={(value) => handleMobileFieldChange("value", value ?? 0)}
                          />
                        </InputGroup>
                      </div>
                      <div>
                        <label
                          htmlFor={mobileNotesId}
                          className="text-muted-foreground mb-1 block text-xs"
                        >
                          {t("asset:valueHistory.notes")}
                        </label>
                        <Textarea
                          id={mobileNotesId}
                          rows={2}
                          className="min-h-16 resize-none"
                          value={draft.notes}
                          disabled={isPersisting}
                          onChange={(event) => handleMobileFieldChange("notes", event.target.value)}
                        />
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

              return (
                <div key={entry.id} className="flex items-center p-1.5">
                  <button
                    type="button"
                    className="active:bg-muted/40 grid min-h-11 min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2 rounded-md px-1.5 py-2 text-left disabled:opacity-50"
                    aria-label={t("asset:valueHistory.edit_entry_aria", {
                      date: dateFormatting.formatCalendarDate(format(entry.date, "yyyy-MM-dd")),
                      value: amountFormatting.formatAmount(entry.value, entry.currency),
                    })}
                    disabled={isPersisting}
                    onClick={() => handleMobileEdit(entry)}
                  >
                    <span className="text-muted-foreground truncate text-sm">
                      {dateFormatting.formatCalendarDate(format(entry.date, "yyyy-MM-dd"))}
                    </span>
                    <span className="text-foreground text-base font-semibold tabular-nums">
                      {amountFormatting.formatAmount(entry.value, entry.currency)}
                    </span>
                    <Icons.Pencil className="text-muted-foreground h-4 w-4" aria-hidden="true" />
                    {entry.notes && (
                      <span className="text-muted-foreground col-span-3 mt-1 line-clamp-2 text-xs">
                        {entry.notes}
                      </span>
                    )}
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-destructive h-11 w-11 shrink-0"
                    aria-label={t("asset:valueHistory.delete_entry_aria", {
                      date: dateFormatting.formatCalendarDate(format(entry.date, "yyyy-MM-dd")),
                      value: amountFormatting.formatAmount(entry.value, entry.currency),
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

        {mobilePageCount > 1 && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {t("asset:quoteGrid.page_of", {
                page: mobilePage + 1,
                total: mobilePageCount,
              })}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-11"
                onClick={() => setMobilePage((page) => page - 1)}
                disabled={mobilePage === 0 || mobileDraft !== null || isPersisting}
              >
                {t("common:previous")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-11"
                onClick={() => setMobilePage((page) => page + 1)}
                disabled={mobilePage >= mobilePageCount - 1 || mobileDraft !== null || isPersisting}
              >
                {t("common:next")}
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
                  event.preventDefault();
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
      <ValueHistoryToolbar
        selectedRowCount={selectedRowCount}
        hasUnsavedChanges={hasUnsavedChanges}
        dirtyCount={dirtyIds.size}
        deletedCount={deletedIds.size}
        onAddRow={() => dataGrid.onRowAdd?.()}
        onDeleteSelected={handleDeleteSelected}
        onSave={handleSave}
        onCancel={handleCancel}
        isSaving={isPersisting}
        isLiability={isLiability}
      />

      <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
        <DataGrid {...dataGrid} stretchColumns height="calc(100vh - 340px)" />
      </div>
    </div>
  );
}

export default ValueHistoryDataGrid;
