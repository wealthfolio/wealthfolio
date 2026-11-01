import { useQueryClient } from "@tanstack/react-query";
import type { ColumnDef, SortingState, Updater, VisibilityState } from "@tanstack/react-table";
import {
  Badge,
  Button,
  DataGrid,
  Icons,
  useDataGrid,
  type CellSelectOption,
  type UpdateCell,
} from "@wealthfolio/ui";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { usePersistentState } from "@/hooks/use-persistent-state";
import { ActivityStatus, ActivityType } from "@/lib/constants";
import { useSettingsContext } from "@/lib/settings-provider";
import { getCategoryLabel } from "@/lib/taxonomy-labels";
import type { Account, TaxonomyCategory } from "@/lib/types";
import { ActivityDataGridPagination } from "@/pages/activity/components/activity-data-grid/activity-data-grid-pagination";
import { ActivityDataGridToolbar } from "@/pages/activity/components/activity-data-grid/activity-data-grid-toolbar";
import {
  applyTransactionUpdate,
  createCurrencyResolver,
  partitionReviewRowsForApproval,
  PINNED_COLUMNS,
  TRACKED_FIELDS,
  valuesAreEqual,
  withNewPairPartners,
} from "@/pages/activity/components/activity-data-grid/activity-utils";
import { isPendingReview } from "@/pages/activity/components/activity-data-grid/types";
import { createSelectColumn } from "@/pages/activity/components/activity-data-grid/use-activity-columns";
import { useActivityGridState } from "@/pages/activity/components/activity-data-grid/use-activity-grid-state";
import {
  useSaveActivities,
  type ActivitySaveOutcome,
} from "@/pages/activity/components/activity-data-grid/use-save-activities";
import { ActivityDeleteModal } from "@/pages/activity/components/activity-delete-modal";
import { ActivityTypeBadge } from "@/pages/activity/components/activity-type-badge";
import { formatActivityFieldName } from "@/pages/activity/utils/validation-labels";

import { unassignActivityCategory } from "../adapters/cash-activities";
import { useBulkAssignCategories } from "../hooks/use-cash-activities";
import {
  getActivityTypesForAccount,
  getCashActivityLabel,
  isCreditCardAccountType,
} from "../lib/constants";
import { invalidateSpendingCaches } from "../lib/invalidation";
import {
  applySpendingRules,
  categoryTaxonomyFor,
  createSpendingDraft,
  duplicateSpendingRow,
  getCategoryLock,
  getEditRejection,
  INCOME_TAXONOMY,
  isTransferRow,
  planCategoryWrites,
  prepareSpendingPayload,
  SAVINGS_TAXONOMY,
  toSpendingGridRow,
  validateSpendingRows,
  type SpendingGridRow,
} from "../lib/spending-grid";
import { toRowVM, type TransactionRowVM } from "../lib/transactions-helpers";
import type { CashActivity } from "../types/cash-activity";
import { flattenTaxonomy } from "./quick-categorize-popover";
import { TransactionRowActions } from "./transaction-row-actions";

const COLUMN_VISIBILITY_KEY = "spending-datagrid-column-visibility";
const DEFAULT_COLUMN_VISIBILITY: VisibilityState = { fxRate: false };
const TOGGLEABLE_COLUMNS = [
  "date",
  "accountName",
  "activityType",
  "categoryId",
  "amount",
  "currency",
  "fxRate",
  "comment",
] as const;
/** Stands in for a split row's category, which lives in its lines. */
const SPLIT_VALUE = "__split__";
const NO_ASSET_CURRENCIES = new Map<string, string>();

/** Row actions that open the Spending sheets and dialogs, as in the list. */
export interface SpendingGridRowActions {
  onEdit: (row: TransactionRowVM) => void;
  onEditSplits: (row: TransactionRowVM) => void;
  onMarkReimbursement: (row: TransactionRowVM) => void;
  /** Duplicates a transfer straight away, as the list does. */
  onDuplicateTransfer: (row: TransactionRowVM) => void;
  onLinkTransfer: (row: TransactionRowVM) => void;
  onUnlinkTransfer: (row: TransactionRowVM) => void;
  onLoanPayment: (row: TransactionRowVM) => void;
}

interface SpendingActivityDataGridProps extends SpendingGridRowActions {
  items: CashActivity[];
  /** Spending accounts, including inactive ones that rows may still use. */
  accounts: Account[];
  categories: Map<string, TaxonomyCategory>;
  sorting: SortingState;
  onSortingChange: (updater: Updater<SortingState>) => void;
  pageIndex: number;
  pageSize: number;
  pageCount: number;
  totalRowCount: number;
  isFetching: boolean;
  onPageChange: (pageIndex: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onRefetch: () => Promise<unknown>;
}

/**
 * Spending activity in the shared data grid: edits wait for Save, as in the
 * Investments grid, and go through the same bulk activity save; category
 * picks follow in one batch.
 */
export function SpendingActivityDataGrid({
  items,
  accounts,
  categories,
  sorting,
  onSortingChange,
  pageIndex,
  pageSize,
  pageCount,
  totalRowCount,
  isFetching,
  onPageChange,
  onPageSizeChange,
  onRefetch,
  onEdit,
  onEditSplits,
  onMarkReimbursement,
  onDuplicateTransfer,
  onLinkTransfer,
  onUnlinkTransfer,
  onLoanPayment,
}: SpendingActivityDataGridProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { settings } = useSettingsContext();
  const fallbackCurrency = settings?.baseCurrency ?? "USD";

  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const accountTypeOf = useCallback(
    (accountId: string) => accountById.get(accountId)?.accountType,
    [accountById],
  );
  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const serverRows = useMemo(
    () => items.map((item) => toSpendingGridRow(item, accountById.get(item.accountId))),
    [items, accountById],
  );

  const {
    serverTransactions,
    localTransactions: rows,
    setLocalTransactions: setRows,
    dirtyTransactionIds,
    pendingDeleteIds,
    hasUnsavedChanges,
    changesSummary,
    markDirtyBatch,
    markForDeletion,
    markForDeletionBatch,
    resetChangeState,
  } = useActivityGridState<SpendingGridRow>({ activities: serverRows });
  const originals = useMemo(
    () => new Map(serverTransactions.map((row) => [row.id, row])),
    [serverTransactions],
  );

  // Row menus are memoized cells, so their handlers read the current rows here.
  const latest = useRef({ rows, dirtyTransactionIds, itemsById });
  useEffect(() => {
    latest.current = { rows, dirtyTransactionIds, itemsById };
  }, [rows, dirtyTransactionIds, itemsById]);

  const [columnVisibility, setColumnVisibility] = usePersistentState<VisibilityState>(
    COLUMN_VISIBILITY_KEY,
    DEFAULT_COLUMN_VISIBILITY,
  );

  const activeAccounts = useMemo(() => accounts.filter((a) => a.isActive), [accounts]);
  const accountOptions = useMemo<CellSelectOption[]>(
    () => activeAccounts.map((a) => ({ value: a.id, label: a.name })),
    [activeAccounts],
  );

  const categoryOptionsByTaxonomy = useMemo(() => {
    const byTaxonomy = new Map<string, TaxonomyCategory[]>();
    categories.forEach((category) => {
      byTaxonomy.set(category.taxonomyId, [
        ...(byTaxonomy.get(category.taxonomyId) ?? []),
        category,
      ]);
    });
    const label = (c: TaxonomyCategory) => getCategoryLabel(t, c.taxonomyId, c.id, c.name);
    const options = new Map<string, CellSelectOption[]>();
    byTaxonomy.forEach((list, taxonomyId) => {
      const group =
        taxonomyId === INCOME_TAXONOMY
          ? "Income"
          : taxonomyId === SAVINGS_TAXONOMY
            ? "Savings"
            : "Expense";
      options.set(
        taxonomyId,
        flattenTaxonomy(taxonomyId, list, group).map(({ category, parent }) => ({
          value: category.id,
          label: parent ? `${label(parent)} / ${label(category)}` : label(category),
        })),
      );
    });
    return options;
  }, [categories, t]);

  // Cells re-render on their own value or a render key, so options that load
  // later reach the cells through these.
  const optionsVersion = `${accounts.length}:${categories.size}`;

  const resolveTransactionCurrency = useMemo(
    () => createCurrencyResolver(NO_ASSET_CURRENCIES, fallbackCurrency),
    [fallbackCurrency],
  );
  const dirtyCurrencyLookup = useMemo(() => {
    const lookup = new Map<string, string>();
    for (const row of rows) {
      if (dirtyTransactionIds.has(row.id) || row.isNew) {
        lookup.set(row.id, row.currency ?? row.accountCurrency ?? fallbackCurrency);
      }
    }
    return lookup;
  }, [dirtyTransactionIds, fallbackCurrency, rows]);

  // --- Row actions -------------------------------------------------------
  const [pendingPairDelete, setPendingPairDelete] = useState<SpendingGridRow | null>(null);

  const requireSaved = useCallback(
    (action: (row: TransactionRowVM) => void) => (row: TransactionRowVM) => {
      if (latest.current.dirtyTransactionIds.has(row.activity.id)) {
        toast({ title: t("activity:datagrid.save_edits_first"), variant: "destructive" });
        return;
      }
      action(row);
    },
    [t],
  );

  const handleDelete = useCallback(
    (vm: TransactionRowVM) => {
      const row = latest.current.rows.find((r) => r.id === vm.activity.id);
      if (!row) return;
      if (isTransferRow(row) && row.sourceGroupId) {
        setPendingPairDelete(row);
        return;
      }
      markForDeletion(row.id, !!row.isNew);
    },
    [markForDeletion],
  );

  const confirmPairDelete = useCallback(() => {
    const row = pendingPairDelete;
    setPendingPairDelete(null);
    if (!row) return;
    markForDeletion(row.id, !!row.isNew);
    // The other leg may sit on another page or account; the save deletes it with this one.
    const counterpart = latest.current.rows.find(
      (r) => r.sourceGroupId === row.sourceGroupId && r.id !== row.id,
    );
    if (counterpart) markForDeletion(counterpart.id, !!counterpart.isNew);
  }, [markForDeletion, pendingPairDelete]);

  const handleDuplicate = useCallback(
    (vm: TransactionRowVM) => {
      const row = latest.current.rows.find((r) => r.id === vm.activity.id);
      if (!row) return;
      if (isTransferRow(row)) {
        requireSaved(onDuplicateTransfer)(vm);
        return;
      }
      const duplicate = duplicateSpendingRow(row, accountTypeOf(row.accountId));
      setRows((prev) => [duplicate, ...prev]);
      markDirtyBatch([duplicate.id]);
    },
    [accountTypeOf, markDirtyBatch, onDuplicateTransfer, requireSaved, setRows],
  );

  const rowActions = useMemo(
    () => ({
      onEdit: requireSaved(onEdit),
      onEditSplits: requireSaved(onEditSplits),
      onMarkReimbursement: requireSaved(onMarkReimbursement),
      onLinkTransfer: requireSaved(onLinkTransfer),
      onUnlinkTransfer: requireSaved(onUnlinkTransfer),
      onLoanPayment: requireSaved(onLoanPayment),
      onDuplicate: handleDuplicate,
      onDelete: handleDelete,
    }),
    [
      handleDelete,
      handleDuplicate,
      onEdit,
      onEditSplits,
      onLinkTransfer,
      onLoanPayment,
      onMarkReimbursement,
      onUnlinkTransfer,
      requireSaved,
    ],
  );

  // --- Columns -------------------------------------------------------------
  const columns = useMemo<ColumnDef<SpendingGridRow>[]>(
    () => [
      createSelectColumn<SpendingGridRow>(t),
      {
        id: "date",
        accessorKey: "date",
        header: t("activity:datagrid.column.date_time"),
        size: 180,
        meta: { cell: { variant: "datetime" } },
      },
      {
        id: "accountName",
        accessorKey: "accountId",
        header: t("activity:datagrid.column.account"),
        size: 180,
        enableSorting: false,
        meta: {
          renderKey: optionsVersion,
          cell: {
            variant: "select",
            options: (rowData: unknown) => {
              const own = accountById.get((rowData as SpendingGridRow).accountId);
              return own && !own.isActive
                ? [...accountOptions, { value: own.id, label: own.name }]
                : accountOptions;
            },
          },
        },
      },
      {
        accessorKey: "activityType",
        header: t("activity:datagrid.column.type"),
        size: 170,
        enableSorting: false,
        enablePinning: false,
        meta: {
          getRenderKey: (row) => `${accountTypeOf(row.accountId) ?? ""}:${row.subtype ?? ""}`,
          cell: {
            variant: "select",
            options: (rowData: unknown) => {
              const row = rowData as SpendingGridRow;
              const accountType = accountTypeOf(row.accountId);
              // Transfers are made and changed in the transfer form.
              const types: string[] = isTransferRow(row)
                ? [row.activityType]
                : getActivityTypesForAccount(accountType).filter(
                    (type) =>
                      type !== ActivityType.TRANSFER_IN && type !== ActivityType.TRANSFER_OUT,
                  );
              const withCurrent = types.includes(row.activityType)
                ? types
                : [...types, row.activityType];
              return withCurrent.map((type) => ({
                value: type,
                label: getCashActivityLabel(
                  t,
                  type,
                  accountType,
                  type === ActivityType.CREDIT && !isCreditCardAccountType(accountType)
                    ? "REIMBURSEMENT"
                    : undefined,
                ),
              }));
            },
            isDisabled: (rowData: unknown) => isTransferRow(rowData as SpendingGridRow),
            valueRenderer: (value: string, _option, rowData) => {
              const row = rowData as SpendingGridRow | undefined;
              const accountType = row ? accountTypeOf(row.accountId) : undefined;
              return (
                <ActivityTypeBadge
                  type={value as ActivityType}
                  label={getCashActivityLabel(t, value, accountType, row?.subtype)}
                  className="text-xs font-normal"
                />
              );
            },
          },
        },
      },
      {
        id: "categoryId",
        accessorFn: (row) => (row.splitCount > 0 ? SPLIT_VALUE : row.categoryId),
        header: t("spending:filters.category"),
        size: 220,
        enableSorting: false,
        meta: {
          renderKey: optionsVersion,
          getRenderKey: (row) => `${row.splitCount}:${getCategoryLock(row, originals.get(row.id))}`,
          cell: {
            variant: "select",
            options: (rowData: unknown) => {
              const row = rowData as SpendingGridRow;
              if (row.splitCount > 0) {
                return [
                  {
                    value: SPLIT_VALUE,
                    label: t("spending:transactions.splitLines", { count: row.splitCount }),
                  },
                ];
              }
              const taxonomyId = categoryTaxonomyFor(row, accountTypeOf(row.accountId));
              return taxonomyId ? (categoryOptionsByTaxonomy.get(taxonomyId) ?? []) : [];
            },
            allowEmpty: true,
            emptyLabel: t("spending:filters.statusUncategorized"),
            isDisabled: (rowData: unknown) => {
              const row = rowData as SpendingGridRow;
              return getCategoryLock(row, originals.get(row.id)) !== null;
            },
            valueRenderer: (value: string, option) =>
              value === SPLIT_VALUE ? (
                <span className="text-muted-foreground inline-flex min-w-0 items-center gap-1 text-xs">
                  <Icons.SplitHorizontal className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">{option?.label}</span>
                </span>
              ) : (
                <Badge
                  data-slot="grid-cell-content"
                  variant="secondary"
                  className="px-1.5 text-xs whitespace-pre-wrap"
                >
                  {option?.label ?? value}
                </Badge>
              ),
          },
        },
      },
      {
        accessorKey: "amount",
        header: t("activity:datagrid.column.amount"),
        size: 130,
        meta: { cell: { variant: "number", step: 0.000001, valueType: "string" } },
      },
      {
        accessorKey: "currency",
        header: t("activity:datagrid.column.currency"),
        size: 110,
        enableSorting: false,
        meta: { cell: { variant: "currency" } },
      },
      {
        accessorKey: "fxRate",
        header: t("activity:datagrid.column.fx_rate"),
        size: 100,
        enableSorting: false,
        meta: { cell: { variant: "number", step: 0.000001, valueType: "string" } },
      },
      {
        accessorKey: "comment",
        header: t("activity:datagrid.column.comment"),
        size: 260,
        enableSorting: false,
        meta: { cell: { variant: "long-text" } },
      },
      {
        id: "actions",
        header: () => null,
        size: 64,
        enableSorting: false,
        enableResizing: false,
        enableHiding: false,
        meta: {
          // The menu reads the saved row, which a refetch can change.
          getRenderKey: (row) => {
            const item = itemsById.get(row.id);
            return item
              ? `${item.updatedAt}:${item.transferLinkStatus ?? ""}:${item.cashFlowBucket}`
              : `new:${row.isNew === true}`;
          },
        },
        cell: ({ row }) => {
          const item = itemsById.get(row.original.id);
          if (row.original.isNew || !item) {
            return (
              <div className="flex size-full items-center justify-center">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 border"
                  title={t("activity:datagrid_delete")}
                  aria-label={t("activity:datagrid_delete")}
                  onClick={() => markForDeletion(row.original.id, !!row.original.isNew)}
                >
                  <Icons.Trash className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            );
          }
          return (
            <div className="flex size-full items-center justify-center">
              <TransactionRowActions
                row={toRowVM(item, categories)}
                account={accountById.get(item.accountId)}
                triggerClassName="h-8 w-8 border"
                {...rowActions}
              />
            </div>
          );
        },
      },
    ],
    [
      accountById,
      accountOptions,
      accountTypeOf,
      categories,
      categoryOptionsByTaxonomy,
      itemsById,
      markForDeletion,
      optionsVersion,
      originals,
      rowActions,
      t,
    ],
  );

  // --- Edits ---------------------------------------------------------------
  const onDataChange = useCallback(
    (
      nextData: SpendingGridRow[],
      _writtenCells?: ReadonlyMap<number, readonly Omit<UpdateCell, "rowIndex">[]>,
    ) => {
      const previousById = new Map(rows.map((row) => [row.id, row]));
      for (const next of nextData) {
        const previous = previousById.get(next.id);
        if (!previous) continue;
        const rejection = getEditRejection(
          previous,
          { ...next, categoryId: next.categoryId ?? "" },
          originals.get(next.id),
        );
        if (rejection) {
          // Paste and clear arrive here too: refuse the whole operation.
          toast({ description: t(rejection) });
          return;
        }
      }

      const accountLookup = new Map(
        accounts.map((a) => [a.id, { id: a.id, name: a.name, currency: a.currency }]),
      );
      setRows((prev) => {
        const prevById = new Map(prev.map((row) => [row.id, row]));
        const changedIds: string[] = [];
        const normalized = nextData.map((next) => {
          const previous = prevById.get(next.id);
          if (!previous) {
            changedIds.push(next.id);
            return next;
          }
          let updated = previous;
          let changed = false;
          for (const field of TRACKED_FIELDS) {
            if (!valuesAreEqual(field, previous[field], next[field])) {
              // The shared update spreads the row, so the Spending fields stay.
              updated = applyTransactionUpdate({
                transaction: updated,
                field,
                value: next[field],
                accountLookup,
                assetCurrencyLookup: NO_ASSET_CURRENCIES,
                fallbackCurrency,
                resolveTransactionCurrency,
              }) as SpendingGridRow;
              changed = true;
            }
          }
          const categoryId = next.categoryId ?? "";
          if (categoryId !== previous.categoryId) {
            updated = { ...updated, categoryId };
            changed = true;
          }
          if (!changed) return previous;
          changedIds.push(next.id);
          return applySpendingRules(previous, updated, accountTypeOf);
        });
        if (changedIds.length > 0) markDirtyBatch(changedIds);
        return normalized;
      });
    },
    [
      accountTypeOf,
      accounts,
      fallbackCurrency,
      markDirtyBatch,
      originals,
      resolveTransactionCurrency,
      rows,
      setRows,
      t,
    ],
  );

  const onRowAdd = useCallback(() => {
    const draft = createSpendingDraft(activeAccounts[0], fallbackCurrency);
    setRows((prev) => [draft, ...prev]);
    markDirtyBatch([draft.id]);
    return { rowIndex: 0, columnId: "activityType" };
  }, [activeAccounts, fallbackCurrency, markDirtyBatch, setRows]);

  const onRowsAdd = useCallback(
    (count: number) => {
      if (count <= 0) return;
      const drafts = Array.from({ length: count }, () =>
        createSpendingDraft(activeAccounts[0], fallbackCurrency),
      );
      setRows((prev) => [...drafts, ...prev]);
      markDirtyBatch(drafts.map((draft) => draft.id));
    },
    [activeAccounts, fallbackCurrency, markDirtyBatch, setRows],
  );

  const onRowsDelete = useCallback(
    (rowsToDelete: SpendingGridRow[]) => {
      if (rowsToDelete.length === 0) return;
      markForDeletionBatch(
        withNewPairPartners(rowsToDelete, rows).map((row) => ({
          id: row.id,
          isNew: !!row.isNew,
        })),
      );
    },
    [markForDeletionBatch, rows],
  );

  const dataGrid = useDataGrid<SpendingGridRow>({
    data: rows,
    columns,
    getRowId: (row) => row.id,
    enableRowSelection: true,
    enableMultiRowSelection: true,
    enableSorting: true,
    enableColumnFilters: true,
    enableSearch: true,
    enablePaste: true,
    manualSorting: true,
    onDataChange,
    onRowAdd,
    onRowsAdd,
    onRowsDelete,
    onSortingChange,
    onColumnVisibilityChange: setColumnVisibility,
    state: { columnVisibility },
    initialState: {
      sorting,
      columnPinning: { left: [...PINNED_COLUMNS.left], right: [...PINNED_COLUMNS.right] },
    },
  });

  const selectedRows = dataGrid.table.getSelectedRowModel().rows;
  const selectedPendingCount = useMemo(
    () => selectedRows.filter((row) => isPendingReview(row.original)).length,
    [selectedRows],
  );

  const deleteSelectedRows = useCallback(() => {
    const selected = dataGrid.table.getSelectedRowModel().rows;
    if (selected.length === 0) return;
    onRowsDelete(selected.map((row) => row.original));
    dataGrid.table.resetRowSelection();
  }, [dataGrid.table, onRowsDelete]);

  const approveSelectedRows = useCallback(() => {
    const pending = dataGrid.table
      .getSelectedRowModel()
      .rows.filter((row) => isPendingReview(row.original))
      .map((row) => row.original);
    if (pending.length === 0) return;
    const { approvable, incomplete } = partitionReviewRowsForApproval(pending);
    const approvableIds = new Set(approvable.map((row) => row.id));
    if (approvable.length > 0) {
      setRows((prev) =>
        prev.map((row) =>
          approvableIds.has(row.id)
            ? {
                ...row,
                needsReview: false,
                status: row.status === ActivityStatus.DRAFT ? ActivityStatus.POSTED : row.status,
              }
            : row,
        ),
      );
      markDirtyBatch([...approvableIds]);
    }
    dataGrid.table.resetRowSelection();
    if (incomplete.length > 0) {
      toast({
        title: t("activity:datagrid.approve_missing_amount", { count: incomplete.length }),
        description: t("activity:datagrid.approve_missing_amount_description"),
        variant: "destructive",
      });
    }
  }, [dataGrid.table, markDirtyBatch, setRows, t]);

  // --- Save ----------------------------------------------------------------
  const bulkAssignCategories = useBulkAssignCategories();
  const [isWritingCategories, setIsWritingCategories] = useState(false);

  const preparePayload = useCallback(
    (payload: Parameters<typeof prepareSpendingPayload>[0]) =>
      prepareSpendingPayload(payload, new Map(rows.map((row) => [row.id, row])), originals),
    [originals, rows],
  );

  const writeCategories = useCallback(
    async (outcome: ActivitySaveOutcome) => {
      const writes = planCategoryWrites(rows, dirtyTransactionIds, outcome, accountTypeOf);
      const unsaved = new Set<string>();
      if (writes.assign.length === 0 && writes.clear.length === 0) return unsaved;
      setIsWritingCategories(true);
      try {
        if (writes.assign.length > 0) {
          try {
            // One batch: the server applies all of it or none.
            await bulkAssignCategories.mutateAsync(writes.assign);
          } catch {
            // The mutation reports the failure.
            writes.assign.forEach((item) => unsaved.add(item.activityId));
          }
        }
        if (writes.clear.length > 0) {
          const results = await Promise.allSettled(
            writes.clear.map((item) => unassignActivityCategory(item.activityId, item.taxonomyId)),
          );
          invalidateSpendingCaches(queryClient);
          results.forEach((result, index) => {
            if (result.status === "rejected") unsaved.add(writes.clear[index].activityId);
          });
          const failed = results.filter((result) => result.status === "rejected").length;
          if (failed > 0) {
            toast({
              title: t("spending:txTab.failedOnCount", { count: failed }),
              variant: "destructive",
            });
          }
        }
        // A saved row keeps its failed pick for Save to retry. A row created in
        // this save comes back from the server on the refetch, so its pick is
        // only reported.
        const created = new Set(outcome.createdIds.values());
        return new Set([...unsaved].filter((id) => !created.has(id)));
      } finally {
        setIsWritingCategories(false);
      }
    },
    [accountTypeOf, bulkAssignCategories, dirtyTransactionIds, queryClient, rows, t],
  );

  const { saveActivities, isSaving } = useSaveActivities<SpendingGridRow>({
    localTransactions: rows,
    dirtyTransactionIds,
    pendingDeleteIds,
    resolveTransactionCurrency,
    dirtyCurrencyLookup,
    assetCurrencyLookup: NO_ASSET_CURRENCIES,
    fallbackCurrency,
    setLocalTransactions: setRows,
    resetChangeState,
    resetRowSelection: () => dataGrid.table.resetRowSelection(),
    onRefetch,
    preparePayload,
    afterActivitiesSaved: writeCategories,
  });

  const handleSave = useCallback(async () => {
    if (!hasUnsavedChanges) return;
    const errors = validateSpendingRows(rows, dirtyTransactionIds, originals, accountTypeOf, {
      typeNotForAccount: t("spending:grid.typeNotForAccount"),
      amountNonNegative: t("spending:cashForm.amountNonNegative"),
      amountRequired: t("spending:grid.amountRequired"),
    });
    if (errors.length > 0) {
      toast({
        title: t("common:notifications.validation_failed"),
        description:
          errors
            .slice(0, 3)
            .map((error) => `${formatActivityFieldName(error.field)}: ${error.message}`)
            .join(", ") + (errors.length > 3 ? "..." : ""),
        variant: "destructive",
      });
      return;
    }
    await saveActivities();
  }, [accountTypeOf, dirtyTransactionIds, hasUnsavedChanges, originals, rows, saveActivities, t]);

  const handleCancel = useCallback(() => {
    resetChangeState();
    dataGrid.table.resetRowSelection();
    // Back to the saved rows: a refetch that returns the same data would not
    // replace the edited and deleted ones.
    setRows(serverTransactions);
    void onRefetch();
    toast({
      title: t("activity:datagrid_changes_discarded"),
      description: t("activity:datagrid_unsaved_cleared"),
      variant: "default",
    });
  }, [dataGrid.table, onRefetch, resetChangeState, serverTransactions, setRows, t]);

  const columnLabels = useMemo(() => ({ categoryId: t("spending:filters.category") }), [t]);

  return (
    <div className="flex min-h-0 flex-1 flex-col space-y-3" data-testid="spending-activity-grid">
      <ActivityDataGridToolbar<SpendingGridRow>
        selectedRowCount={selectedRows.length}
        selectedPendingCount={selectedPendingCount}
        hasUnsavedChanges={hasUnsavedChanges}
        changesSummary={changesSummary}
        isSaving={isSaving || isWritingCategories}
        table={dataGrid.table}
        toggleableColumns={TOGGLEABLE_COLUMNS}
        columnLabels={columnLabels}
        onAddRow={() => dataGrid.onRowAdd?.()}
        onDeleteSelected={deleteSelectedRows}
        onApproveSelected={approveSelectedRows}
        onSave={handleSave}
        onCancel={handleCancel}
      />

      <div className="min-h-0 flex-1">
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

      <ActivityDeleteModal
        isOpen={!!pendingPairDelete}
        linkedTransfer={true}
        conversion={false}
        onConfirm={confirmPairDelete}
        onCancel={() => setPendingPairDelete(null)}
      />
    </div>
  );
}
