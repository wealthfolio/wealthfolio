import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ColumnDef } from "@tanstack/react-table";
import { DataGrid, useDataGrid, type SymbolSearchResult } from "@wealthfolio/ui";
import { searchTicker } from "@/adapters";
import { CreateCustomAssetDialog } from "@/components/create-custom-asset-dialog";
import { useSettingsContext } from "@/lib/settings-provider";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface HoldingsRow {
  /** Index into the original parsedRows array */
  rowIndex: number;
  /** Parsed date (YYYY-MM-DD) or raw string if unparseable */
  date: string;
  /** Raw symbol from CSV (before mapping) */
  rawSymbol: string;
  /** Resolved symbol (after mapping) — this is what the grid displays/edits */
  symbol: string;
  /** Whether this is a $CASH row */
  isCash: boolean;
  quantity: string;
  avgCost: string;
  currency: string;
  providerId?: string;
  providerSymbol?: string;
}

export interface HoldingsDataGridProps {
  rows: HoldingsRow[];
  onDataChange: (nextRows: HoldingsRow[]) => void;
  onSymbolSelect?: (rowIndex: number, symbol: string, result?: SymbolSearchResult) => void;
  enableSymbolEditing?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Column Definitions
// ─────────────────────────────────────────────────────────────────────────────

interface UseHoldingsColumnsOptions {
  onSymbolSearch: (query: string) => Promise<SymbolSearchResult[]>;
  onSymbolSelect?: (rowIndex: number, symbol: string, result?: SymbolSearchResult) => void;
  onCreateCustomAsset?: (rowIndex: number, symbol: string) => void;
  enableSymbolEditing: boolean;
}

function useHoldingsColumns({
  onSymbolSearch,
  onSymbolSelect,
  onCreateCustomAsset,
  enableSymbolEditing,
}: UseHoldingsColumnsOptions): ColumnDef<HoldingsRow>[] {
  const { t } = useTranslation();
  return useMemo<ColumnDef<HoldingsRow>[]>(
    () => [
      // 1. Row number
      {
        id: "status",
        header: () => "#",
        cell: ({ row }) => (
          <span className="text-muted-foreground text-xs">{row.original.rowIndex + 1}</span>
        ),
        size: 50,
        minSize: 50,
        maxSize: 50,
        enableSorting: false,
        enableResizing: false,
        enableHiding: false,
        enablePinning: false,
      },
      // 2. Date (read-only)
      {
        id: "date",
        accessorKey: "date",
        header: t("activity:import.columns.date"),
        size: 120,
        meta: { cell: { variant: "short-text" } },
      },
      // 3. Symbol (with search)
      {
        id: "symbol",
        accessorKey: "symbol",
        header: t("activity:import.columns.symbol"),
        size: 160,
        meta: enableSymbolEditing
          ? {
              cell: {
                variant: "symbol",
                onSearch: onSymbolSearch,
                onSelect: onSymbolSelect,
                onCreateCustomAsset,
                isDisabled: (rowData: unknown) => (rowData as HoldingsRow).isCash,
              },
            }
          : { cell: { variant: "short-text" } },
      },
      // 4. Quantity
      {
        id: "quantity",
        accessorKey: "quantity",
        header: t("activity:import.columns.quantity"),
        size: 120,
        enableSorting: false,
        meta: { cell: { variant: "number", step: 0.000001, valueType: "string" } },
      },
      // 5. Avg Cost
      {
        id: "avgCost",
        accessorKey: "avgCost",
        header: t("activity:import.columns.avgCost"),
        size: 120,
        enableSorting: false,
        meta: { cell: { variant: "number", step: 0.000001, valueType: "string" } },
      },
      // 6. Currency
      {
        id: "currency",
        accessorKey: "currency",
        header: t("activity:import.columns.currency"),
        size: 110,
        enableSorting: false,
        meta: { cell: { variant: "currency" } },
      },
    ],
    [enableSymbolEditing, onSymbolSearch, onSymbolSelect, onCreateCustomAsset, t],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────

export function HoldingsDataGrid({
  rows,
  onDataChange,
  onSymbolSelect,
  enableSymbolEditing = true,
}: HoldingsDataGridProps) {
  const { settings } = useSettingsContext();
  const fallbackCurrency = settings?.baseCurrency ?? "USD";

  // Custom asset dialog state
  const [customAssetDialog, setCustomAssetDialog] = useState<{
    open: boolean;
    rowIndex: number;
    symbol: string;
  }>({ open: false, rowIndex: -1, symbol: "" });

  // Symbol search handler
  const handleSymbolSearch = useCallback(async (query: string): Promise<SymbolSearchResult[]> => {
    return searchTicker(query);
  }, []);

  // Symbol selection handler
  const handleSymbolSelect = useCallback(
    (rowIndex: number, _symbol: string, result?: SymbolSearchResult) => {
      if (!result) return;
      const row = rows[rowIndex];
      if (!row) return;

      const currency = result.currency ?? row.currency ?? fallbackCurrency;
      const canonicalSymbol = (result.canonicalSymbol || result.symbol).trim().toUpperCase();
      onSymbolSelect?.(row.rowIndex, canonicalSymbol, result);

      // Also update currency from search result
      const nextRows = [...rows];
      nextRows[rowIndex] = {
        ...nextRows[rowIndex],
        symbol: canonicalSymbol,
        currency,
        providerId: result.providerId,
        providerSymbol: result.providerSymbol,
      };
      onDataChange(nextRows);
    },
    [rows, fallbackCurrency, onSymbolSelect, onDataChange],
  );

  // Create custom asset
  const handleCreateCustomAsset = useCallback((rowIndex: number, symbol: string) => {
    setCustomAssetDialog({ open: true, rowIndex, symbol });
  }, []);

  const handleCustomAssetCreated = useCallback(
    (result: SymbolSearchResult) => {
      const { rowIndex } = customAssetDialog;
      if (rowIndex < 0) return;
      const row = rows[rowIndex];
      if (!row) return;

      const currency = result.currency ?? row.currency ?? fallbackCurrency;
      const canonicalSymbol = (result.canonicalSymbol || result.symbol).trim().toUpperCase();
      onSymbolSelect?.(row.rowIndex, canonicalSymbol, result);

      const nextRows = [...rows];
      nextRows[rowIndex] = {
        ...nextRows[rowIndex],
        symbol: canonicalSymbol,
        currency,
        providerId: result.providerId,
        providerSymbol: result.providerSymbol,
      };
      onDataChange(nextRows);

      setCustomAssetDialog({ open: false, rowIndex: -1, symbol: "" });
    },
    [customAssetDialog, rows, fallbackCurrency, onSymbolSelect, onDataChange],
  );

  // Column definitions
  const columns = useHoldingsColumns({
    onSymbolSearch: handleSymbolSearch,
    onSymbolSelect: handleSymbolSelect,
    onCreateCustomAsset: handleCreateCustomAsset,
    enableSymbolEditing,
  });

  // Handle data changes from inline editing
  const handleDataChange = useCallback(
    (nextData: HoldingsRow[]) => {
      onDataChange(nextData);
    },
    [onDataChange],
  );

  // Initialize data grid
  const dataGrid = useDataGrid<HoldingsRow>({
    data: rows,
    columns,
    getRowId: (row) => String(row.rowIndex),
    enableRowSelection: false,
    enableSorting: false,
    enableColumnFilters: false,
    enableSearch: false,
    enablePaste: true,
    onDataChange: handleDataChange,
    initialState: {
      columnPinning: { left: ["status"] },
    },
  });

  return (
    <>
      <DataGrid {...dataGrid} stretchColumns height="calc(100vh - 420px)" className="text-sm" />

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
            ? (rows[customAssetDialog.rowIndex]?.currency ?? fallbackCurrency)
            : fallbackCurrency
        }
      />
    </>
  );
}

export default HoldingsDataGrid;
