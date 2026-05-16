import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { useSettingsContext } from "@/lib/settings-provider";
import type { Account, ActivityDetails } from "@/lib/types";
import { useAssets } from "@/pages/asset/hooks/use-assets";
import type { SortingState, Updater, VisibilityState } from "@tanstack/react-table";
import { DataGrid, useDataGrid, type SymbolSearchResult } from "@wealthfolio/ui";
import { useCallback, useMemo, useRef, useState } from "react";
import { resolveSymbolQuote } from "@/adapters";
import { CreateCustomAssetDialog } from "@/components/create-custom-asset-dialog";
import { ActivityType } from "@/lib/constants";
import { isManualSearchResult, quoteModeFromSearchResult } from "@/lib/asset-utils";
import { generateId } from "@/lib/id";
import { LinkTransferModal } from "../link-transfer-modal";
import { useActivityMutations } from "../../hooks/use-activity-mutations";
import { ActivityDataGridPagination } from "./activity-data-grid-pagination";
import { ActivityDataGridToolbar } from "./activity-data-grid-toolbar";
import {
  applyTransactionUpdate,
  createCurrencyResolver,
  createDraftTransaction,
  PINNED_COLUMNS,
  TRACKED_FIELDS,
  valuesAreEqual,
} from "./activity-utils";
import { isPendingReview, toLocalTransaction, type LocalTransaction } from "./types";
import { useActivityColumns } from "./use-activity-columns";
import { generateTempActivityId, useActivityGridState } from "./use-activity-grid-state";
import { useSaveActivities } from "./use-save-activities";

interface ActivityDataGridProps {
  accounts: Account[];
  activities: ActivityDetails[];
  onRefetch: () => Promise<unknown>;
  onEditActivity: (activity: ActivityDetails) => void;
  sorting: SortingState;
  onSortingChange: (updater: Updater<SortingState>) => void;
  // Pagination props
  pageIndex: number;
  pageSize: number;
  pageCount: number;
  totalRowCount: number;
  isFetching: boolean;
  onPageChange: (pageIndex: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}

function canUseResolvedCurrency(result: SymbolSearchResult): boolean {
  if (result.isExisting || isManualSearchResult(result)) {
    return false;
  }
  return true;
}

const ACTIVITY_GRID_COLUMN_VISIBILITY_KEY = "activity-datagrid-column-visibility";

const DEFAULT_COLUMN_VISIBILITY: VisibilityState = {
  subtype: true,
  isExternal: true,
  instrumentType: false,
  activityStatus: false,
};

/**
 * Activity data grid component with inline editing, bulk operations, and optimistic updates
 */
export function ActivityDataGrid({
  accounts,
  activities,
  onRefetch,
  onEditActivity,
  sorting,
  onSortingChange,
  pageIndex,
  pageSize,
  pageCount,
  totalRowCount,
  isFetching,
  onPageChange,
  onPageSizeChange,
}: ActivityDataGridProps) {
  // State management
  const {
    localTransactions,
    setLocalTransactions,
    dirtyTransactionIds,
    pendingDeleteIds,
    hasUnsavedChanges,
    changesSummary,
    markDirtyBatch,
    markForDeletion,
    markForDeletionBatch,
    resetChangeState,
  } = useActivityGridState({ activities });

  // Persist column visibility preferences.
  const [columnVisibility, setColumnVisibility] = usePersistentState<VisibilityState>(
    ACTIVITY_GRID_COLUMN_VISIBILITY_KEY,
    DEFAULT_COLUMN_VISIBILITY,
  );

  const { assets } = useAssets();
  const { settings } = useSettingsContext();

  // Derived values - use app base currency as the ultimate fallback
  const baseCurrency = settings?.baseCurrency ?? "USD";
  const fallbackCurrency = baseCurrency;

  const accountLookup = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts],
  );

  const assetCurrencyLookup = useMemo(() => {
    const entries = new Map<string, string>();
    assets.forEach((asset) => {
      if (!asset.quoteCcy) return;
      const displayKey = asset.displayCode?.trim().toUpperCase();
      const symbolKey = asset.instrumentSymbol?.trim().toUpperCase();
      const idKey = asset.id?.trim().toUpperCase();
      if (displayKey) entries.set(displayKey, asset.quoteCcy);
      if (symbolKey && symbolKey !== displayKey) entries.set(symbolKey, asset.quoteCcy);
      if (idKey) entries.set(idKey, asset.quoteCcy);
    });
    return entries;
  }, [assets]);

  const resolveTransactionCurrency = useMemo(
    () => createCurrencyResolver(assetCurrencyLookup, fallbackCurrency),
    [assetCurrencyLookup, fallbackCurrency],
  );

  // Currency lookup for dirty transactions (single pass)
  const dirtyCurrencyLookup = useMemo(() => {
    const lookup = new Map<string, string>();
    for (const transaction of localTransactions) {
      const isDirtyOrNew = dirtyTransactionIds.has(transaction.id) || transaction.isNew;
      if (!isDirtyOrNew) continue;

      const resolved =
        transaction.currency ??
        resolveTransactionCurrency(transaction) ??
        transaction.accountCurrency ??
        fallbackCurrency;
      if (resolved) {
        lookup.set(transaction.id, resolved);
      }
    }
    return lookup;
  }, [dirtyTransactionIds, fallbackCurrency, localTransactions, resolveTransactionCurrency]);

  // Row operations
  const handleDuplicate = useCallback(
    (activity: ActivityDetails) => {
      const now = new Date();
      const source = toLocalTransaction(activity);
      const duplicated: LocalTransaction = {
        ...source,
        id: generateTempActivityId(),
        date: now,
        createdAt: now,
        updatedAt: now,
        isNew: true,
        comment: "Duplicated",
        idempotencyKey: generateId("manual-duplicate"),
      };
      setLocalTransactions((prev) => [duplicated, ...prev]);
      markDirtyBatch([duplicated.id]);
    },
    [markDirtyBatch, setLocalTransactions],
  );

  const handleDelete = useCallback(
    (activity: ActivityDetails) => {
      const source = toLocalTransaction(activity);
      markForDeletion(activity.id, !!source.isNew);
    },
    [markForDeletion],
  );

  // Race condition guard for async quote resolution
  const latestResolveRequestId = useRef(0);

  // Custom asset dialog state
  const [customAssetDialog, setCustomAssetDialog] = useState<{
    open: boolean;
    rowIndex: number;
    symbol: string;
  }>({ open: false, rowIndex: -1, symbol: "" });

  // Handle symbol selection to capture exchangeMic, currency, and asset metadata from search result
  const handleSymbolSelect = useCallback(
    (rowIndex: number, result: SymbolSearchResult) => {
      latestResolveRequestId.current += 1;
      const requestId = latestResolveRequestId.current;

      // Currency fallback: search result (from exchange) → account → base
      const provisionalCurrency = result.currency;
      const canonicalSymbol = (result.canonicalSymbol || result.symbol).trim().toUpperCase();
      const canonicalExchangeMic = result.canonicalExchangeMic || result.exchangeMic;
      let dirtyId: string | undefined;

      setLocalTransactions((prev) => {
        const updated = [...prev];
        if (updated[rowIndex]) {
          const row = updated[rowIndex];
          dirtyId = row.id;
          const currency = provisionalCurrency ?? row.accountCurrency ?? fallbackCurrency;
          updated[rowIndex] = {
            ...row,
            assetSymbol: canonicalSymbol,
            exchangeMic: canonicalExchangeMic,
            assetQuoteMode: quoteModeFromSearchResult(result),
            currency,
            instrumentType: result.quoteType,
            pendingAssetId: result.existingAssetId,
            // Capture asset metadata for custom assets
            pendingAssetName: result.longName,
            pendingAssetKind: result.assetKind,
            pendingQuoteCcy: result.currency,
            pendingInstrumentType: result.quoteType,
            pendingProviderId: result.providerId,
            pendingProviderSymbol: result.providerSymbol,
          };
        }
        return updated;
      });
      if (dirtyId) {
        markDirtyBatch([dirtyId]);
      }

      // Resolve quote to confirm currency and get latest price
      if (result.dataSource !== "MANUAL") {
        const shouldUseResolvedCurrency = canUseResolvedCurrency(result);
        resolveSymbolQuote(
          canonicalSymbol,
          canonicalExchangeMic,
          result.quoteType,
          result.providerId,
          result.currency,
        ).then((resolved) => {
          if (requestId !== latestResolveRequestId.current) return;
          if (!resolved) return;

          let didUpdate = false;
          let updatedRowId: string | undefined;

          setLocalTransactions((prev) => {
            const updated = [...prev];
            if (!updated[rowIndex]) return prev;
            const row = updated[rowIndex];

            const changes: Partial<LocalTransaction> = {};

            // Update currency from resolved quote only if the user has not edited it since selection.
            if (resolved.currency && shouldUseResolvedCurrency) {
              const confirmedCurrency = resolved.currency.trim();
              if (
                confirmedCurrency &&
                row.currency !== confirmedCurrency &&
                row.currency === (provisionalCurrency ?? row.accountCurrency ?? fallbackCurrency)
              ) {
                changes.currency = confirmedCurrency;
              }
              changes.pendingQuoteCcy = resolved.currency;
            }

            // Set unit price from resolved quote
            if (resolved.price != null) {
              changes.unitPrice = String(resolved.price);
            }

            if (Object.keys(changes).length === 0) return prev;

            didUpdate = true;
            updatedRowId = row.id;
            updated[rowIndex] = { ...row, ...changes };
            return updated;
          });

          if (didUpdate && updatedRowId) {
            markDirtyBatch([updatedRowId]);
          }
        });
      }
    },
    [setLocalTransactions, fallbackCurrency, markDirtyBatch],
  );

  // Handle request to create a custom asset - opens the dialog
  const handleCreateCustomAsset = useCallback((rowIndex: number, symbol: string) => {
    setCustomAssetDialog({ open: true, rowIndex, symbol });
  }, []);

  // Handle custom asset created from dialog
  const handleCustomAssetCreated = useCallback(
    (result: SymbolSearchResult) => {
      const { rowIndex } = customAssetDialog;
      if (rowIndex < 0) return;

      // Update the transaction with the symbol and asset metadata
      const canonicalSymbol = (result.canonicalSymbol || result.symbol).trim().toUpperCase();
      const canonicalExchangeMic = result.canonicalExchangeMic || result.exchangeMic;
      let dirtyId: string | undefined;
      setLocalTransactions((prev) => {
        const updated = [...prev];
        if (updated[rowIndex]) {
          const row = updated[rowIndex];
          dirtyId = row.id;
          const currency = result.currency ?? row.accountCurrency ?? fallbackCurrency;
          updated[rowIndex] = {
            ...row,
            assetSymbol: canonicalSymbol,
            exchangeMic: canonicalExchangeMic,
            assetQuoteMode: "MANUAL",
            currency,
            instrumentType: result.quoteType,
            pendingAssetId: result.existingAssetId,
            pendingAssetName: result.longName,
            pendingAssetKind: result.assetKind,
            pendingQuoteCcy: result.currency,
            pendingInstrumentType: result.quoteType,
            pendingProviderId: result.providerId,
            pendingProviderSymbol: result.providerSymbol,
          };
        }
        return updated;
      });

      // Mark the transaction as dirty
      if (dirtyId) {
        markDirtyBatch([dirtyId]);
      }

      setCustomAssetDialog({ open: false, rowIndex: -1, symbol: "" });
    },
    [customAssetDialog, setLocalTransactions, fallbackCurrency, markDirtyBatch],
  );

  // Column definitions
  const columns = useActivityColumns({
    accounts,
    onEditActivity,
    onDuplicate: handleDuplicate,
    onDelete: handleDelete,
    onSymbolSelect: handleSymbolSelect,
    onCreateCustomAsset: handleCreateCustomAsset,
  });

  // Data change handler - processes changes from the data grid
  const onDataChange = useCallback(
    (nextData: LocalTransaction[]) => {
      setLocalTransactions((prev) => {
        const prevById = new Map(prev.map((t) => [t.id, t]));
        const changedIds: string[] = [];

        const normalized = nextData.map((nextRow) => {
          const previous = prevById.get(nextRow.id);
          if (!previous) {
            changedIds.push(nextRow.id);
            return nextRow;
          }

          let updated = previous;
          let changed = false;

          for (const field of TRACKED_FIELDS) {
            const prevValue = previous[field];
            const nextValue = nextRow[field];
            if (!valuesAreEqual(field, prevValue, nextValue)) {
              updated = applyTransactionUpdate({
                transaction: updated,
                field,
                value: nextValue,
                accountLookup,
                assetCurrencyLookup,
                fallbackCurrency,
                resolveTransactionCurrency,
              });
              changed = true;
            }
          }

          if (!changed) return previous;
          changedIds.push(nextRow.id);
          return updated;
        });

        if (changedIds.length > 0) {
          markDirtyBatch(changedIds);
        }

        return normalized;
      });
    },
    [
      accountLookup,
      assetCurrencyLookup,
      fallbackCurrency,
      markDirtyBatch,
      resolveTransactionCurrency,
      setLocalTransactions,
    ],
  );

  // Add single row at the top
  const onRowAdd = useCallback(() => {
    const draft = createDraftTransaction(accounts, fallbackCurrency);
    setLocalTransactions((prev) => [draft, ...prev]);
    markDirtyBatch([draft.id]);
    return { rowIndex: 0, columnId: "activityType" };
  }, [accounts, fallbackCurrency, markDirtyBatch, setLocalTransactions]);

  // Add multiple rows at the top
  const onRowsAdd = useCallback(
    (count: number) => {
      if (count <= 0) return;
      const drafts = Array.from({ length: count }, () =>
        createDraftTransaction(accounts, fallbackCurrency),
      );
      setLocalTransactions((prev) => [...drafts, ...prev]);
      markDirtyBatch(drafts.map((d) => d.id));
    },
    [accounts, fallbackCurrency, markDirtyBatch, setLocalTransactions],
  );

  // Delete multiple rows
  const onRowsDelete = useCallback(
    (rowsToDelete: LocalTransaction[]) => {
      if (rowsToDelete.length === 0) return;
      markForDeletionBatch(rowsToDelete.map((row) => ({ id: row.id, isNew: !!row.isNew })));
    },
    [markForDeletionBatch],
  );

  // Initialize data grid
  const dataGrid = useDataGrid<LocalTransaction>({
    data: localTransactions,
    columns,
    getRowId: (row) => row.id,
    enableRowSelection: true,
    enableMultiRowSelection: true,
    enableSorting: true,
    enableColumnFilters: true,
    enableSearch: true,
    enablePaste: true,
    manualSorting: true, // Server-side sorting - prevents row reordering during edits
    onDataChange,
    onRowAdd,
    onRowsAdd,
    onRowsDelete,
    onSortingChange,
    onColumnVisibilityChange: setColumnVisibility,
    state: {
      columnVisibility,
    },
    initialState: {
      sorting,
      columnPinning: { left: [...PINNED_COLUMNS.left], right: [...PINNED_COLUMNS.right] },
    },
  });

  const selectedRows = dataGrid.table.getSelectedRowModel().rows;
  const selectedRowCount = selectedRows.length;

  // Count selected rows that are pending review (needsReview=true and not new)
  const selectedPendingCount = useMemo(
    () => selectedRows.filter((row) => isPendingReview(row.original)).length,
    [selectedRows],
  );

  // Link state: validate that the 2-row selection is a valid TRANSFER_IN/TRANSFER_OUT pair
  const { linkTransferActivitiesMutation, unlinkTransferActivitiesMutation } =
    useActivityMutations();
  const [transferDialogOpen, setTransferDialogOpen] = useState(false);
  const [transferDialogMode, setTransferDialogMode] = useState<"link" | "unlink">("link");

  const linkValidation = useMemo(() => {
    if (selectedRows.length !== 2) {
      return { canLink: false, reason: "" } as const;
    }
    const [first, second] = selectedRows.map((row) => row.original);
    if (first.isNew || second.isNew) {
      return {
        canLink: false,
        reason: "Save new activities before linking",
      } as const;
    }
    if (dirtyTransactionIds.has(first.id) || dirtyTransactionIds.has(second.id)) {
      return {
        canLink: false,
        reason: "Save or discard pending edits on the selected rows before linking",
      } as const;
    }
    const types = new Set([first.activityType, second.activityType]);
    if (
      !types.has(ActivityType.TRANSFER_IN) ||
      !types.has(ActivityType.TRANSFER_OUT) ||
      types.size !== 2
    ) {
      return {
        canLink: false,
        reason: "Select one TRANSFER_IN and one TRANSFER_OUT activity",
      } as const;
    }
    if (first.sourceGroupId || second.sourceGroupId) {
      return {
        canLink: false,
        reason: "One of the selected activities is already linked",
      } as const;
    }
    const transferIn = first.activityType === ActivityType.TRANSFER_IN ? first : second;
    const transferOut = first.activityType === ActivityType.TRANSFER_OUT ? first : second;
    if (transferIn.accountId === transferOut.accountId) {
      return {
        canLink: false,
        reason: "Both legs share the same account",
      } as const;
    }
    return { canLink: true, transferIn, transferOut } as const;
  }, [selectedRows, dirtyTransactionIds]);

  const unlinkValidation = useMemo(() => {
    if (selectedRows.length !== 2) {
      return { canUnlink: false, reason: "" } as const;
    }
    const [first, second] = selectedRows.map((row) => row.original);
    if (first.isNew || second.isNew) {
      return {
        canUnlink: false,
        reason: "Save new activities before unlinking",
      } as const;
    }
    if (dirtyTransactionIds.has(first.id) || dirtyTransactionIds.has(second.id)) {
      return {
        canUnlink: false,
        reason: "Save or discard pending edits on the selected rows before unlinking",
      } as const;
    }
    const types = new Set([first.activityType, second.activityType]);
    if (
      !types.has(ActivityType.TRANSFER_IN) ||
      !types.has(ActivityType.TRANSFER_OUT) ||
      types.size !== 2
    ) {
      return {
        canUnlink: false,
        reason: "Select one TRANSFER_IN and one TRANSFER_OUT activity",
      } as const;
    }
    if (!first.sourceGroupId || !second.sourceGroupId) {
      return {
        canUnlink: false,
        reason: "Both selected activities must already be linked",
      } as const;
    }
    if (first.sourceGroupId !== second.sourceGroupId) {
      return {
        canUnlink: false,
        reason: "Selected activities belong to different linked transfers",
      } as const;
    }
    const transferIn = first.activityType === ActivityType.TRANSFER_IN ? first : second;
    const transferOut = first.activityType === ActivityType.TRANSFER_OUT ? first : second;
    return { canUnlink: true, transferIn, transferOut } as const;
  }, [selectedRows, dirtyTransactionIds]);

  const showUnlinkSelected = useMemo(
    () => selectedRows.length === 2 && selectedRows.every((row) => !!row.original.sourceGroupId),
    [selectedRows],
  );

  const linkWarnings = useMemo(() => {
    if (!linkValidation.canLink) return [] as string[];
    const { transferIn, transferOut } = linkValidation;
    const warnings: string[] = [];
    if (transferIn.currency !== transferOut.currency) {
      warnings.push(
        `Currencies differ (${transferOut.currency} → ${transferIn.currency}). The pair will still be linked.`,
      );
    }
    const inAmount = Number(transferIn.amount ?? transferIn.unitPrice ?? 0);
    const outAmount = Number(transferOut.amount ?? transferOut.unitPrice ?? 0);
    if (Number.isFinite(inAmount) && Number.isFinite(outAmount) && inAmount && outAmount) {
      const diff = Math.abs(inAmount - outAmount) / Math.max(inAmount, outAmount);
      if (diff > 0.01) {
        warnings.push("Amounts differ by more than 1%.");
      }
    }
    const inDate = new Date(transferIn.date).getTime();
    const outDate = new Date(transferOut.date).getTime();
    if (Number.isFinite(inDate) && Number.isFinite(outDate)) {
      const dayDiff = Math.abs(inDate - outDate) / (1000 * 60 * 60 * 24);
      if (dayDiff > 7) {
        warnings.push(`Dates differ by ${Math.round(dayDiff)} days.`);
      }
    }
    return warnings;
  }, [linkValidation]);

  const handleLinkConfirm = useCallback(async () => {
    if (!linkValidation.canLink) return;
    await linkTransferActivitiesMutation.mutateAsync({
      activityAId: linkValidation.transferIn.id,
      activityBId: linkValidation.transferOut.id,
    });
    setTransferDialogOpen(false);
    dataGrid.table.resetRowSelection();
    onRefetch();
  }, [linkValidation, linkTransferActivitiesMutation, dataGrid.table, onRefetch]);

  const handleUnlinkConfirm = useCallback(async () => {
    if (!unlinkValidation.canUnlink) return;
    await unlinkTransferActivitiesMutation.mutateAsync({
      activityAId: unlinkValidation.transferIn.id,
      activityBId: unlinkValidation.transferOut.id,
    });
    setTransferDialogOpen(false);
    dataGrid.table.resetRowSelection();
    onRefetch();
  }, [unlinkValidation, unlinkTransferActivitiesMutation, dataGrid.table, onRefetch]);

  // Delete selected rows handler
  const deleteSelectedRows = useCallback(() => {
    const selected = dataGrid.table.getSelectedRowModel().rows;
    if (selected.length === 0) return;

    const selectedTransactions = selected.map((row) => row.original);
    onRowsDelete(selectedTransactions);
    dataGrid.table.resetRowSelection();
  }, [dataGrid.table, onRowsDelete]);

  // Approve selected synced activities (mark needsReview=false)
  const approveSelectedRows = useCallback(() => {
    const selected = dataGrid.table.getSelectedRowModel().rows;
    const pendingToApprove = selected
      .filter((row) => isPendingReview(row.original))
      .map((row) => row.original);

    if (pendingToApprove.length === 0) return;

    // Mark all pending activities as approved (needsReview=false) and mark them as dirty
    setLocalTransactions((prev) =>
      prev.map((transaction) => {
        const shouldApprove = pendingToApprove.some((p) => p.id === transaction.id);
        if (shouldApprove) {
          return { ...transaction, needsReview: false };
        }
        return transaction;
      }),
    );

    // Mark them as dirty so they will be saved
    markDirtyBatch(pendingToApprove.map((transaction) => transaction.id));
    dataGrid.table.resetRowSelection();
  }, [dataGrid.table, markDirtyBatch, setLocalTransactions]);

  // Save activities hook with validation and error handling
  const { saveActivities, isSaving } = useSaveActivities({
    localTransactions,
    dirtyTransactionIds,
    pendingDeleteIds,
    resolveTransactionCurrency,
    dirtyCurrencyLookup,
    assetCurrencyLookup,
    fallbackCurrency,
    setLocalTransactions,
    resetChangeState,
    resetRowSelection: () => dataGrid.table.resetRowSelection(),
    onRefetch,
  });

  // Save changes handler
  const handleSaveChanges = useCallback(async () => {
    if (!hasUnsavedChanges) return;
    await saveActivities();
  }, [hasUnsavedChanges, saveActivities]);

  // Cancel changes handler
  const handleCancelChanges = useCallback(() => {
    resetChangeState();
    dataGrid.table.resetRowSelection();
    setLocalTransactions((prev) => prev.filter((transaction) => !transaction.isNew));
    onRefetch();
    toast({
      title: "Changes discarded",
      description: "Unsaved edits and drafts have been cleared.",
      variant: "default",
    });
  }, [dataGrid.table, onRefetch, resetChangeState, setLocalTransactions]);

  // Get default currency for custom asset dialog from the row's account
  const dialogDefaultCurrency =
    customAssetDialog.rowIndex >= 0 && localTransactions[customAssetDialog.rowIndex]
      ? (localTransactions[customAssetDialog.rowIndex].accountCurrency ?? fallbackCurrency)
      : fallbackCurrency;
  let dialogActivityIn: LocalTransaction | undefined;
  let dialogActivityOut: LocalTransaction | undefined;
  if (transferDialogMode === "link" && linkValidation.canLink) {
    dialogActivityIn = linkValidation.transferIn;
    dialogActivityOut = linkValidation.transferOut;
  } else if (transferDialogMode === "unlink" && unlinkValidation.canUnlink) {
    dialogActivityIn = unlinkValidation.transferIn;
    dialogActivityOut = unlinkValidation.transferOut;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col space-y-3">
      <ActivityDataGridToolbar
        selectedRowCount={selectedRowCount}
        selectedPendingCount={selectedPendingCount}
        hasUnsavedChanges={hasUnsavedChanges}
        changesSummary={changesSummary}
        isSaving={isSaving}
        table={dataGrid.table}
        onAddRow={() => dataGrid.onRowAdd?.()}
        onDeleteSelected={deleteSelectedRows}
        onApproveSelected={approveSelectedRows}
        onSave={handleSaveChanges}
        onCancel={handleCancelChanges}
        onLinkSelected={() => {
          setTransferDialogMode("link");
          setTransferDialogOpen(true);
        }}
        canLinkSelected={linkValidation.canLink}
        linkDisabledReason={linkValidation.canLink ? undefined : linkValidation.reason}
        isLinking={linkTransferActivitiesMutation.isPending}
        onUnlinkSelected={() => {
          setTransferDialogMode("unlink");
          setTransferDialogOpen(true);
        }}
        showUnlinkSelected={showUnlinkSelected}
        canUnlinkSelected={unlinkValidation.canUnlink}
        unlinkDisabledReason={unlinkValidation.canUnlink ? undefined : unlinkValidation.reason}
        isUnlinking={unlinkTransferActivitiesMutation.isPending}
      />

      <div className="min-h-0 flex-1 overflow-hidden">
        <DataGrid {...dataGrid} stretchColumns height="calc(100vh - 260px)" />
      </div>

      <ActivityDataGridPagination
        pageIndex={pageIndex}
        pageSize={pageSize}
        pageCount={pageCount}
        totalRowCount={totalRowCount}
        isFetching={isFetching}
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
      />

      <CreateCustomAssetDialog
        open={customAssetDialog.open}
        onOpenChange={(open) => {
          if (!open) {
            setCustomAssetDialog({ open: false, rowIndex: -1, symbol: "" });
          }
        }}
        onAssetCreated={handleCustomAssetCreated}
        defaultSymbol={customAssetDialog.symbol}
        defaultCurrency={dialogDefaultCurrency}
      />

      <LinkTransferModal
        isOpen={transferDialogOpen}
        mode={transferDialogMode}
        isProcessing={
          transferDialogMode === "link"
            ? linkTransferActivitiesMutation.isPending
            : unlinkTransferActivitiesMutation.isPending
        }
        activityIn={dialogActivityIn}
        activityOut={dialogActivityOut}
        warnings={transferDialogMode === "link" ? linkWarnings : []}
        onConfirm={transferDialogMode === "link" ? handleLinkConfirm : handleUnlinkConfirm}
        onCancel={() => setTransferDialogOpen(false)}
      />
    </div>
  );
}
