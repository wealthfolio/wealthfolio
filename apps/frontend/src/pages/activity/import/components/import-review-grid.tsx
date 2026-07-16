import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ColumnDef, RowSelectionState } from "@tanstack/react-table";
import {
  DataGrid,
  useDataGrid,
  Checkbox,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  type SymbolSearchResult,
} from "@wealthfolio/ui";

import { ActivityType, INSTRUMENT_TYPE_OPTIONS, SUBTYPES_BY_ACTIVITY_TYPE } from "@/lib/constants";
import {
  localizeActivitySubtypeName,
  localizeActivityTypeName,
  needsImportAssetResolution,
} from "@/lib/activity-utils";
import { quoteModeFromSearchResult } from "@/lib/asset-utils";
import { ActivityTypeBadge } from "../../components/activity-type-badge";
import type { DraftActivity, DraftActivityStatus } from "../context";
import { ImportToolbar, ImportContextMenu } from "./import-toolbar";
import { useAccounts } from "@/hooks/use-accounts";
import { searchTicker } from "@/adapters";
import { CreateCustomAssetDialog } from "@/components/create-custom-asset-dialog";
import { useSettingsContext } from "@/lib/settings-provider";
import {
  DEFAULT_ACTIVITY_IMPORT_PROFILE,
  type ActivityImportProfile,
} from "../utils/activity-import-profile";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ImportReviewGridProps {
  drafts: DraftActivity[];
  nonSelectableRowIndexes?: number[];
  onDraftUpdate: (rowIndex: number, updates: Partial<DraftActivity>) => void;
  selectedRows: number[];
  onSelectionChange: (selectedRows: number[]) => void;
  // Bulk action handlers
  onBulkSkip?: (rowIndexes: number[]) => void;
  onBulkUnskip?: (rowIndexes: number[]) => void;
  onBulkForceImport?: (rowIndexes: number[]) => void;
  onBulkSetCurrency?: (rowIndexes: number[], currency: string) => void;
  onBulkSetAccount?: (rowIndexes: number[], accountId: string) => void;
  /** Override the grid height (default: "calc(100vh - 360px)"). */
  gridHeight?: string | number;
  importProfile?: ActivityImportProfile;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status Display Configuration
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_LABEL_KEY: Record<DraftActivityStatus, string> = {
  valid: "activity:import.status.valid",
  warning: "activity:import.status.warning",
  error: "activity:import.status.error",
  skipped: "activity:import.status.skipped",
  duplicate: "activity:import.status.duplicate",
};

// ─────────────────────────────────────────────────────────────────────────────
// Cell Components
// ─────────────────────────────────────────────────────────────────────────────

function getStatusTitle(
  t: TFunction,
  status: DraftActivityStatus,
  skipReason?: string,
  duplicateOfId?: string,
  duplicateOfLineNumber?: number,
  errors?: Record<string, string[]>,
  warnings?: Record<string, string[]>,
): string | undefined {
  if (status === "valid") return undefined;
  if (status === "skipped" && skipReason) return skipReason;
  if (typeof duplicateOfLineNumber === "number") {
    return t("activity:import.status.duplicateOfLine", { line: duplicateOfLineNumber });
  }
  if (duplicateOfId) return t("activity:import.status.duplicateExisting");
  if (errors) {
    const errorDetails = Object.entries(errors)
      .flatMap(([field, msgs]) => msgs.map((msg) => `${field}: ${msg}`))
      .join("\n");
    if (errorDetails) {
      return errorDetails;
    }
  }
  if (warnings) {
    const warningDetails = Object.entries(warnings)
      .flatMap(([field, msgs]) =>
        msgs.map((msg) => (field.startsWith("_") ? msg : `${field}: ${msg}`)),
      )
      .join("\n");
    if (warningDetails) {
      return warningDetails;
    }
  }
  return t(STATUS_LABEL_KEY[status]);
}

const STATUS_DOT_COLOR: Record<DraftActivityStatus, string> = {
  valid: "",
  error: "bg-red-500",
  warning: "bg-yellow-500",
  duplicate: "bg-blue-500",
  skipped: "bg-gray-400",
};

// ─────────────────────────────────────────────────────────────────────────────
// Column Definitions
// ─────────────────────────────────────────────────────────────────────────────

interface UseImportReviewColumnsOptions {
  accounts: { id: string; name: string }[];
  onSymbolSearch: (query: string) => Promise<SymbolSearchResult[]>;
  onSymbolSelect?: (rowIndex: number, symbol: string, result?: SymbolSearchResult) => void;
  onCreateCustomAsset?: (rowIndex: number, symbol: string) => void;
  importProfile: ActivityImportProfile;
}

function useImportReviewColumns({
  accounts,
  onSymbolSearch,
  onSymbolSelect,
  onCreateCustomAsset,
  importProfile,
}: UseImportReviewColumnsOptions): ColumnDef<DraftActivity>[] {
  const { t } = useTranslation();
  const accountOptions = useMemo(
    () =>
      accounts.map((account) => ({
        value: account.id,
        label: account.name,
      })),
    [accounts],
  );

  const activityTypeOptions = useMemo(
    () =>
      importProfile.allowedActivityTypes.map((type) => ({
        value: type,
        label: localizeActivityTypeName(t, type),
      })),
    [importProfile.allowedActivityTypes, t],
  );

  // Dynamic subtype options based on activity type
  const getSubtypeOptions = useCallback(
    (rowData: unknown) => {
      const draft = rowData as DraftActivity;
      const activityType = draft.activityType?.toUpperCase();
      if (!activityType) return [];

      const allowedSubtypes = SUBTYPES_BY_ACTIVITY_TYPE[activityType] || [];
      return allowedSubtypes.map((subtype) => ({
        value: subtype,
        label: localizeActivitySubtypeName(t, subtype),
      }));
    },
    [t],
  );

  return useMemo<ColumnDef<DraftActivity>[]>(() => {
    const visibleDataColumns = new Set<string>(importProfile.reviewColumns);
    const allColumns: ColumnDef<DraftActivity>[] = [
      // === Pinned left (always visible) ===
      // 1. Select
      {
        id: "select",
        header: ({ table }) => (
          <Checkbox
            disabled={!table.getRowModel().rows.some((row) => row.getCanSelect())}
            checked={
              table.getIsAllRowsSelected() || (table.getIsSomeRowsSelected() && "indeterminate")
            }
            onCheckedChange={(checked) => table.toggleAllRowsSelected(Boolean(checked))}
            aria-label={t("activity:import.columns.selectAllRows")}
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            disabled={!row.getCanSelect()}
            checked={row.getIsSelected()}
            onCheckedChange={(checked) => row.toggleSelected(Boolean(checked))}
            aria-label={t("activity:import.columns.selectRow")}
          />
        ),
        size: 40,
        minSize: 40,
        maxSize: 40,
        enableSorting: false,
        enableResizing: false,
        enableHiding: false,
        enablePinning: false,
      },
      // 2. Status indicator (row number + validation status)
      {
        id: "status",
        header: () => "#",
        cell: ({ row }) => {
          const {
            status,
            skipReason,
            duplicateOfId,
            duplicateOfLineNumber,
            errors,
            warnings,
            rowIndex,
            forceImport,
          } = row.original;
          const isForcedDuplicate = status === "duplicate" && forceImport;
          const title = isForcedDuplicate
            ? t("activity:import.status.forcedDuplicate")
            : getStatusTitle(
                t,
                status,
                skipReason,
                duplicateOfId,
                duplicateOfLineNumber,
                errors,
                warnings,
              );
          const dotColor = isForcedDuplicate ? "bg-amber-500" : STATUS_DOT_COLOR[status];
          const dot = dotColor ? (
            <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${dotColor}`} />
          ) : null;
          return (
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground shrink-0 text-xs">{rowIndex + 1}</span>
              {dot && title ? (
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>{dot}</TooltipTrigger>
                    <TooltipContent
                      side="right"
                      className={
                        status === "error"
                          ? "bg-destructive text-destructive-foreground border-destructive max-w-xs whitespace-pre-wrap text-xs"
                          : "max-w-xs whitespace-pre-wrap text-xs"
                      }
                    >
                      {title}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : (
                dot
              )}
            </div>
          );
        },
        size: 70,
        minSize: 70,
        maxSize: 70,
        enableSorting: false,
        enableResizing: false,
        enableHiding: false,
        enablePinning: false,
      },
      // 3. Date & Time
      {
        id: "activityDate",
        accessorKey: "activityDate",
        header: t("activity:import.columns.dateTime"),
        size: 180,
        meta: { cell: { variant: "datetime" } },
      },
      // 4. Account
      {
        id: "accountId",
        accessorKey: "accountId",
        header: t("activity:import.columns.account"),
        size: 180,
        meta: { cell: { variant: "select", options: accountOptions } },
      },

      // === Identity / classification ===
      // 5. Type
      {
        id: "activityType",
        accessorKey: "activityType",
        header: t("activity:import.columns.type"),
        size: 150,
        enablePinning: false,
        meta: {
          cell: {
            variant: "select",
            options: activityTypeOptions,
            valueRenderer: (value: string, _option, rowData) => (
              <ActivityTypeBadge
                type={value as ActivityType}
                subtype={(rowData as { subtype?: string } | undefined)?.subtype}
                className="text-xs font-normal"
              />
            ),
          },
        },
      },
      // 6. Subtype - dynamic options based on activity type
      {
        id: "subtype",
        accessorKey: "subtype",
        header: t("activity:import.columns.subtype"),
        size: 180,
        enableSorting: false,
        enableHiding: true,
        meta: {
          cell: {
            variant: "select",
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            options: getSubtypeOptions as any,
            allowEmpty: true,
            emptyLabel: t("activity:import.columns.none"),
          },
        },
      },
      // 7. External (checkbox for TRANSFER_IN/TRANSFER_OUT only)
      {
        id: "isExternal",
        accessorKey: "isExternal",
        header: t("activity:import.columns.external"),
        size: 80,
        enableSorting: false,
        enableHiding: true,
        meta: {
          cell: {
            variant: "checkbox",
            // Only enabled for transfer types
            isDisabled: (rowData: unknown) => {
              const row = rowData as DraftActivity;
              const activityType = row.activityType?.toUpperCase();
              return (
                activityType !== ActivityType.TRANSFER_IN &&
                activityType !== ActivityType.TRANSFER_OUT
              );
            },
          },
        },
      },
      // 8. Symbol
      {
        id: "symbol",
        accessorKey: "symbol",
        header: t("activity:import.columns.symbol"),
        size: 140,
        meta: {
          cell: {
            variant: "symbol",
            onSearch: onSymbolSearch,
            onSelect: onSymbolSelect,
            onCreateCustomAsset,
            isClearable: (rowData: unknown) => {
              const row = rowData as DraftActivity;
              return !needsImportAssetResolution(row.activityType ?? "", row.subtype);
            },
          },
        },
      },
      // 9. Instrument Type
      {
        id: "instrumentType",
        accessorKey: "instrumentType",
        header: t("activity:import.columns.instrument"),
        size: 120,
        enableSorting: false,
        enableHiding: true,
        meta: {
          cell: {
            variant: "select",
            options: [...INSTRUMENT_TYPE_OPTIONS],
            allowEmpty: true,
            emptyLabel: t("activity:import.columns.auto"),
          },
        },
      },

      // === Numbers (grouped, right-aligned) ===
      // 10. Quantity
      {
        id: "quantity",
        accessorKey: "quantity",
        header: t("activity:import.columns.quantity"),
        size: 120,
        enableSorting: false,
        meta: { cell: { variant: "number", step: 0.000001, valueType: "string" } },
      },
      // 9. Price
      {
        id: "unitPrice",
        accessorKey: "unitPrice",
        header: t("activity:import.columns.price"),
        size: 120,
        enableSorting: false,
        meta: {
          helpText: t("activity:import.columns.unitPriceHelp"),
          cell: { variant: "number", step: 0.000001, valueType: "string" },
        },
      },
      // 10. Amount
      {
        id: "amount",
        accessorKey: "amount",
        header: t("activity:import.columns.amount"),
        size: 120,
        enableSorting: false,
        meta: { cell: { variant: "number", step: 0.000001, valueType: "string" } },
      },
      // 11. Currency
      {
        id: "currency",
        accessorKey: "currency",
        header: t("activity:import.columns.currency"),
        size: 110,
        enableSorting: false,
        meta: { cell: { variant: "currency" } },
      },
      // 12. Fee
      {
        id: "fee",
        accessorKey: "fee",
        header: t("activity:import.columns.fee"),
        size: 100,
        enableSorting: false,
        meta: { cell: { variant: "number", step: 0.000001, valueType: "string" } },
      },
      // 13. Tax
      {
        id: "tax",
        accessorKey: "tax",
        header: t("activity:import.columns.tax"),
        size: 100,
        enableSorting: false,
        meta: { cell: { variant: "number", step: 0.000001, valueType: "string" } },
      },
      // 14. FX Rate
      {
        id: "fxRate",
        accessorKey: "fxRate",
        header: t("activity:import.columns.fxRate"),
        size: 100,
        enableSorting: false,
        meta: { cell: { variant: "number", step: 0.000001, valueType: "string" } },
      },

      // === Notes ===
      // 14. Comment
      {
        id: "comment",
        accessorKey: "comment",
        header: t("activity:import.columns.comment"),
        size: 260,
        enableSorting: false,
        meta: { cell: { variant: "long-text" } },
      },
    ];

    return allColumns.filter(
      (column) =>
        column.id === "select" ||
        column.id === "status" ||
        (column.id ? visibleDataColumns.has(column.id) : true),
    );
  }, [
    accountOptions,
    activityTypeOptions,
    getSubtypeOptions,
    importProfile.reviewColumns,
    onSymbolSearch,
    onSymbolSelect,
    onCreateCustomAsset,
    t,
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────

export function ImportReviewGrid({
  drafts,
  nonSelectableRowIndexes = [],
  onDraftUpdate,
  selectedRows,
  onSelectionChange,
  onBulkSkip,
  onBulkUnskip,
  onBulkForceImport,
  onBulkSetCurrency,
  onBulkSetAccount,
  gridHeight,
  importProfile = DEFAULT_ACTIVITY_IMPORT_PROFILE,
}: ImportReviewGridProps) {
  const { settings } = useSettingsContext();
  const fallbackCurrency = settings?.baseCurrency ?? "USD";
  const nonSelectableRowIndexSet = useMemo(
    () => new Set(nonSelectableRowIndexes),
    [nonSelectableRowIndexes],
  );

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
  }>({ open: false, x: 0, y: 0 });

  // Custom asset dialog state
  const [customAssetDialog, setCustomAssetDialog] = useState<{
    open: boolean;
    rowIndex: number;
    symbol: string;
  }>({ open: false, rowIndex: -1, symbol: "" });

  // Handle context menu (right-click)
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      // Only show context menu if there are selected rows
      if (selectedRows.length > 0) {
        e.preventDefault();
        setContextMenu({
          open: true,
          x: e.clientX,
          y: e.clientY,
        });
      }
    },
    [selectedRows.length],
  );

  // Close context menu
  const handleContextMenuOpenChange = useCallback((open: boolean) => {
    setContextMenu((prev) => ({ ...prev, open }));
  }, []);

  // Handle horizontal scroll with mouse wheel (Shift + wheel or just wheel)
  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const target = e.currentTarget.querySelector<HTMLElement>('[data-slot="grid"]');
    if (!target) return;

    // If user is scrolling horizontally with trackpad (deltaX), let it happen naturally
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      return;
    }

    // Convert vertical scroll to horizontal when Shift is pressed
    if (e.shiftKey && e.deltaY !== 0) {
      e.preventDefault();
      target.scrollLeft += e.deltaY;
    }
  }, []);

  // Bulk action handlers
  const handleSkip = useCallback(() => {
    onBulkSkip?.(selectedRows);
  }, [onBulkSkip, selectedRows]);

  const handleUnskip = useCallback(() => {
    onBulkUnskip?.(selectedRows);
  }, [onBulkUnskip, selectedRows]);

  const handleForceImport = useCallback(() => {
    onBulkForceImport?.(selectedRows);
  }, [onBulkForceImport, selectedRows]);

  const handleSetCurrency = useCallback(
    (currency: string) => {
      onBulkSetCurrency?.(selectedRows, currency);
    },
    [onBulkSetCurrency, selectedRows],
  );

  const handleSetAccount = useCallback(
    (accountId: string) => {
      onBulkSetAccount?.(selectedRows, accountId);
    },
    [onBulkSetAccount, selectedRows],
  );

  const handleClearSelection = useCallback(() => {
    onSelectionChange([]);
  }, [onSelectionChange]);

  // Get accounts for the account selector
  const { accounts } = useAccounts({ filterActive: true, includeArchived: false });

  // Symbol search handler
  const handleSymbolSearch = useCallback(async (query: string): Promise<SymbolSearchResult[]> => {
    return searchTicker(query);
  }, []);

  // Symbol selection handler - update draft with symbol and currency from search result
  const handleSymbolSelect = useCallback(
    (rowIndex: number, _symbol: string, result?: SymbolSearchResult) => {
      if (!result) return;

      // Find the draft by rowIndex
      const draft = drafts.find((d) => d.rowIndex === rowIndex);
      if (!draft) return;

      // Currency fallback: search result → current draft currency → fallback
      const currency = result.currency ?? draft.currency ?? fallbackCurrency;
      const canonicalSymbol = (result.canonicalSymbol || result.symbol).trim().toUpperCase();
      const canonicalExchangeMic = result.canonicalExchangeMic || result.exchangeMic;

      onDraftUpdate(rowIndex, {
        symbol: canonicalSymbol,
        currency,
        currencySource: result.currency ? "resolved" : draft.currencySource,
        exchangeMic: canonicalExchangeMic,
        quoteCcy: result.currency ?? draft.quoteCcy,
        instrumentType: result.quoteType,
        quoteMode: quoteModeFromSearchResult(result),
        providerId: result.providerId,
        providerSymbol: result.providerSymbol,
        symbolName: result.longName || result.shortName || draft.symbolName,
        assetId: undefined,
        importAssetKey: undefined,
      });
    },
    [drafts, fallbackCurrency, onDraftUpdate],
  );

  // Request to create a custom asset - opens the dialog
  const handleCreateCustomAsset = useCallback((rowIndex: number, symbol: string) => {
    setCustomAssetDialog({ open: true, rowIndex, symbol });
  }, []);

  // Handle custom asset created from dialog
  const handleCustomAssetCreated = useCallback(
    (result: SymbolSearchResult) => {
      const { rowIndex } = customAssetDialog;
      if (rowIndex < 0) return;

      // Find the draft by rowIndex
      const draft = drafts.find((d) => d.rowIndex === rowIndex);
      if (!draft) return;

      const currency = result.currency ?? draft.currency ?? fallbackCurrency;
      const canonicalSymbol = (result.canonicalSymbol || result.symbol).trim().toUpperCase();
      const canonicalExchangeMic = result.canonicalExchangeMic || result.exchangeMic;

      onDraftUpdate(rowIndex, {
        symbol: canonicalSymbol,
        currency,
        currencySource: result.currency ? "resolved" : draft.currencySource,
        exchangeMic: canonicalExchangeMic,
        quoteCcy: result.currency ?? draft.quoteCcy,
        instrumentType: result.quoteType,
        quoteMode: quoteModeFromSearchResult(result),
        providerId: result.providerId,
        providerSymbol: result.providerSymbol,
        symbolName: result.longName || result.shortName || draft.symbolName,
        assetId: undefined,
        importAssetKey: undefined,
      });

      setCustomAssetDialog({ open: false, rowIndex: -1, symbol: "" });
    },
    [customAssetDialog, drafts, fallbackCurrency, onDraftUpdate],
  );

  // Column definitions
  const columns = useImportReviewColumns({
    accounts,
    onSymbolSearch: handleSymbolSearch,
    onSymbolSelect: handleSymbolSelect,
    onCreateCustomAsset: handleCreateCustomAsset,
    importProfile,
  });

  // Ref to track if we're in the middle of syncing selection
  const isSyncingRef = useRef(false);

  // Convert selectedRows (row indices) to initial row selection state
  const initialRowSelection = useMemo(() => {
    const selection: RowSelectionState = {};
    for (const rowIndex of selectedRows) {
      selection[String(rowIndex)] = true;
    }
    return selection;
  }, [selectedRows]);

  // Handle data changes from inline editing
  const handleDataChange = useCallback(
    (nextData: DraftActivity[]) => {
      // Find which rows changed and dispatch updates
      for (let i = 0; i < nextData.length; i++) {
        const nextRow = nextData[i];
        const prevRow = drafts[i];

        if (nextRow !== prevRow) {
          // Something changed in this row
          const updates: Partial<DraftActivity> = {};
          const fields: (keyof DraftActivity)[] = [
            "activityDate",
            "activityType",
            "symbol",
            "instrumentType",
            "quantity",
            "unitPrice",
            "amount",
            "currency",
            "fee",
            "tax",
            "fxRate",
            "subtype",
            "isExternal",
            "accountId",
            "comment",
          ];

          for (const field of fields) {
            if (nextRow[field] !== prevRow[field]) {
              (updates as Record<string, unknown>)[field] = nextRow[field];
            }
          }

          if (Object.keys(updates).length > 0) {
            onDraftUpdate(nextRow.rowIndex, updates);
          }
        }
      }
    },
    [drafts, onDraftUpdate],
  );

  // Keep a synchronously-updated ref so getCellState always reads the latest
  // drafts even when the DataGrid's internal propsRef lags by one layout-effect.
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

  // Cell state callback for error/warning highlighting with messages
  const getCellState = useCallback(
    (
      rowIndex: number,
      columnId: string,
    ): { type: "error" | "warning"; messages: string[] } | null => {
      const draft = draftsRef.current[rowIndex];
      if (!draft) return null;

      // Skip non-data columns
      if (columnId === "select" || columnId === "status") return null;

      // Check for errors first (higher priority)
      const errors = draft.errors?.[columnId];
      if (errors?.length) {
        return { type: "error", messages: errors };
      }

      // Then check for warnings
      const warnings = draft.warnings?.[columnId];
      if (warnings?.length) {
        return { type: "warning", messages: warnings };
      }

      return null;
    },
    [],
  );

  // Initialize data grid
  const dataGrid = useDataGrid<DraftActivity>({
    data: drafts,
    columns,
    getRowId: (row) => String(row.rowIndex),
    enableRowSelection: (row) => !nonSelectableRowIndexSet.has(row.original.rowIndex),
    enableMultiRowSelection: true,
    enableSorting: false,
    enableColumnFilters: false,
    enableSearch: false,
    enablePaste: true,
    onDataChange: handleDataChange,

    meta: {
      getCellState,
    } as any,
    initialState: {
      rowSelection: initialRowSelection,
      columnPinning: { left: ["select", "status"] },
      columnVisibility: {
        subtype: true,
        isExternal: true,
      },
    },
  });

  // Sync selection changes to parent
  const tableSelectedRows = dataGrid.table.getSelectedRowModel().rows;
  const prevSelectedRef = useRef<number[]>([]);

  useEffect(() => {
    const selectableRows = selectedRows.filter(
      (rowIndex) => !nonSelectableRowIndexSet.has(rowIndex),
    );
    if (selectableRows.length !== selectedRows.length) {
      onSelectionChange(selectableRows);
    }
  }, [selectedRows, onSelectionChange, nonSelectableRowIndexSet]);

  useEffect(() => {
    if (isSyncingRef.current) return;

    const currentSelected = tableSelectedRows.map((row) => row.original.rowIndex).sort();
    const prevSelected = prevSelectedRef.current;

    // Check if selection actually changed
    const hasChanged =
      currentSelected.length !== prevSelected.length ||
      currentSelected.some((idx, i) => idx !== prevSelected[i]);

    if (hasChanged) {
      prevSelectedRef.current = currentSelected;
      onSelectionChange(currentSelected);
    }
  }, [tableSelectedRows, onSelectionChange]);

  // Sync external selection changes to table
  useEffect(() => {
    const currentTableSelection = dataGrid.table.getState().rowSelection;
    const newSelection: RowSelectionState = {};

    for (const rowIndex of selectedRows) {
      newSelection[String(rowIndex)] = true;
    }

    // Check if external selection differs from table selection
    const tableKeys = Object.keys(currentTableSelection).filter((k) => currentTableSelection[k]);
    const newKeys = Object.keys(newSelection);

    const needsSync =
      tableKeys.length !== newKeys.length ||
      tableKeys.some((k) => !newSelection[k]) ||
      newKeys.some((k) => !currentTableSelection[k]);

    if (needsSync) {
      isSyncingRef.current = true;
      dataGrid.table.setRowSelection(newSelection);
      // Reset sync flag after microtask to allow state to settle
      queueMicrotask(() => {
        isSyncingRef.current = false;
      });
    }
  }, [selectedRows, dataGrid.table]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* Bulk operations toolbar */}
      <ImportToolbar
        selectedCount={selectedRows.length}
        onSkip={handleSkip}
        onUnskip={handleUnskip}
        onForceImport={onBulkForceImport ? handleForceImport : undefined}
        onSetCurrency={handleSetCurrency}
        onSetAccount={handleSetAccount}
        onClearSelection={handleClearSelection}
      />

      {/* Data grid with context menu support */}
      <div className="min-h-0 flex-1" onContextMenu={handleContextMenu} onWheel={handleWheel}>
        <DataGrid
          {...dataGrid}
          stretchColumns
          height={gridHeight ?? "calc(100vh - 360px)"}
          className="text-sm"
        />
      </div>

      {/* Context menu */}
      <ImportContextMenu
        open={contextMenu.open}
        position={{ x: contextMenu.x, y: contextMenu.y }}
        onOpenChange={handleContextMenuOpenChange}
        selectedCount={selectedRows.length}
        onSkip={handleSkip}
        onUnskip={handleUnskip}
        onForceImport={onBulkForceImport ? handleForceImport : undefined}
        onSetCurrency={handleSetCurrency}
        onSetAccount={handleSetAccount}
      />

      {/* Custom asset creation dialog */}
      <CreateCustomAssetDialog
        open={customAssetDialog.open}
        onOpenChange={(open) => {
          if (!open) {
            setCustomAssetDialog({ open: false, rowIndex: -1, symbol: "" });
          }
        }}
        onAssetCreated={handleCustomAssetCreated}
        defaultSymbol={customAssetDialog.symbol}
        defaultCurrency={
          customAssetDialog.rowIndex >= 0
            ? (drafts.find((d) => d.rowIndex === customAssetDialog.rowIndex)?.currency ??
              fallbackCurrency)
            : fallbackCurrency
        }
      />
    </div>
  );
}

export default ImportReviewGrid;
