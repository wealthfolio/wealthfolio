import { Button } from "@wealthfolio/ui/components/ui/button";
import { DataTable } from "@wealthfolio/ui/components/ui/data-table";
import { DataTableColumnHeader } from "@wealthfolio/ui/components/ui/data-table/data-table-column-header";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@wealthfolio/ui/components/ui/dropdown-menu";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { parseOccSymbol } from "@/lib/occ-symbol";
import { safeDivide } from "@/lib/utils";
import type { ColumnDef } from "@tanstack/react-table";
import { GainPercent, Badge } from "@wealthfolio/ui";

import { TickerAvatar } from "@/components/ticker-avatar";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@wealthfolio/ui/components/ui/tooltip";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { HoldingType } from "@/lib/constants";
import { useSettingsContext } from "@/lib/settings-provider";
import { Holding } from "@/lib/types";
import { AmountDisplay, QuantityDisplay } from "@wealthfolio/ui";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

// Helper function to get display value and currency based on toggle state
const getDisplayValueAndCurrency = (
  holding: Holding,
  valueInBase: number | null | undefined,
  showConvertedToBase: boolean,
): { value: number; currency: string } => {
  const fxRate = holding.fxRate ?? 1; // Use fxRate from Holding

  if (showConvertedToBase) {
    // Show value in Base Currency
    return {
      value: valueInBase ?? 0,
      currency: holding.baseCurrency, // Use baseCurrency from Holding
    };
  } else {
    // Show value in Asset's Original Currency
    const valueInOriginal = safeDivide(valueInBase ?? 0, fxRate);
    return {
      value: valueInOriginal,
      currency: holding.localCurrency, // Use localCurrency from Holding
    };
  }
};

export const HoldingsTable = ({
  holdings,
  isLoading,
  onClassify,
}: {
  holdings: Holding[];
  isLoading: boolean;
  onClassify?: (holding: Holding) => void;
}) => {
  const { isBalanceHidden } = useBalancePrivacy();
  const { settings } = useSettingsContext();
  const [showConvertedValues, setShowConvertedValues] = useState(false);

  const baseCurrency = settings?.baseCurrency ?? holdings[0]?.baseCurrency;
  const hasMultipleCurrencies = holdings.some((holding) => {
    if (!baseCurrency || !holding.localCurrency) {
      return false;
    }

    return holding.localCurrency.toUpperCase() !== baseCurrency.toUpperCase();
  });

  if (isLoading) {
    return (
      <div className="space-y-4 pt-6">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  const uniqueTypesSet = new Set();
  const assetsTypes: { label: string; value: string }[] = holdings.reduce(
    (result: { label: string; value: string }[], asset) => {
      // Use taxonomy-based assetType classification
      const type = asset.instrument?.classifications?.assetType?.name;
      if (type && !uniqueTypesSet.has(type)) {
        uniqueTypesSet.add(type);
        result.push({ label: type.toUpperCase(), value: type });
      }
      return result;
    },
    [],
  );

  const filters = [
    {
      id: "holdingType",
      title: "Type",
      options: assetsTypes,
    },
  ];

  return (
    <div className="flex h-full flex-col">
      <DataTable
        data={holdings}
        columns={getColumns(isBalanceHidden, showConvertedValues, onClassify)}
        searchBy="symbol"
        filters={filters}
        showColumnToggle={true}
        storageKey="holdings-table-v2"
        defaultColumnVisibility={{
          currency: false,
          symbolName: false,
          holdingType: false,
          bookValue: false,
          totalPnl: false,
          unrealizedPnl: false,
          income: false,
          dayPnl: false,
          avgCost: false,
          portfolioWeight: false,
        }}
        defaultSorting={[{ id: "symbol", desc: false }]}
        scrollable={true}
        toolbarActions={
          <div className="mr-2 flex items-center gap-2">
            {hasMultipleCurrencies && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setShowConvertedValues(!showConvertedValues)}
                    className="h-8 w-8 rounded-lg"
                  >
                    {showConvertedValues ? (
                      <Icons.Globe className="h-4 w-4" />
                    ) : (
                      <Icons.DollarSign className="h-4 w-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Show values in {showConvertedValues ? "Asset Currency" : "Base Currency"}</p>
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        }
      />
    </div>
  );
};

export default HoldingsTable;

const getColumns = (
  isHidden: boolean,
  showConvertedValues: boolean,
  onClassify?: (holding: Holding) => void,
): ColumnDef<Holding>[] => [
  {
    id: "symbol",
    accessorKey: "instrument.symbol",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Position" />,
    meta: {
      label: "Position",
    },
    cell: ({ row }) => {
      const navigate = useNavigate();
      const holding = row.original;
      const symbol = holding.instrument?.symbol ?? holding.id;
      const isCash = holding.holdingType === HoldingType.CASH;

      // Parse OCC symbol for options
      const parsedOption = isCash ? null : parseOccSymbol(symbol);
      const displaySymbol = parsedOption ? parsedOption.underlying : symbol;
      const avatarSymbol = isCash
        ? `CASH:${holding.localCurrency}`
        : parsedOption
          ? parsedOption.underlying
          : symbol;

      // Option subtitle: "Mar 29 $150 CALL"
      const optionSubtitle = parsedOption
        ? `${new Date(parsedOption.expiration + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })} $${parsedOption.strikePrice} ${parsedOption.optionType}`
        : null;

      const handleNavigate = () => {
        // Use instrument.id (asset ID) for navigation, not symbol (which may be stripped)
        const navSymbol = holding.instrument?.id ?? holding.id;
        navigate(`/holdings/${encodeURIComponent(navSymbol)}`, { state: { holding } });
      };

      const isManual = holding.instrument?.quoteMode === "MANUAL";
      const content = (
        <div className="flex items-center">
          <TickerAvatar symbol={avatarSymbol} className="mr-2 h-8 w-8" />
          <div className="flex flex-col">
            <div className="flex items-center gap-1.5">
              <span className="font-medium">{displaySymbol}</span>
              {isManual && (
                <Badge variant="secondary" className="h-4 px-1 py-0 text-[10px]">
                  Manual
                </Badge>
              )}
            </div>
            <span className="text-muted-foreground line-clamp-1 text-xs">
              {optionSubtitle ?? holding.instrument?.name ?? null}
            </span>
          </div>
        </div>
      );

      return (
        <div className="-m-1 cursor-pointer p-1" onClick={handleNavigate}>
          {content}
        </div>
      );
    },
    sortingFn: (rowA, rowB) => {
      const symbolA = rowA.original.instrument?.symbol ?? rowA.original.id;
      const symbolB = rowB.original.instrument?.symbol ?? rowB.original.id;
      return symbolA.localeCompare(symbolB);
    },
    filterFn: (row, _columnId, filterValue) => {
      const holding = row.original;
      const searchTerm = filterValue as string;
      const lowerSearch = searchTerm.toLowerCase();
      const nameMatch = holding.instrument?.name?.toLowerCase().includes(lowerSearch);
      const symbolMatch = holding.instrument?.symbol?.toLowerCase().includes(lowerSearch);
      const idMatch = holding.id.toLowerCase().includes(lowerSearch);
      // Also match on the underlying symbol for options
      const parsed = parseOccSymbol(holding.instrument?.symbol ?? "");
      const underlyingMatch = parsed?.underlying.toLowerCase().includes(lowerSearch);
      return !!(symbolMatch || nameMatch || idMatch || underlyingMatch);
    },
    enableHiding: false,
  },
  {
    id: "symbolName",
    accessorFn: (row) => row.instrument?.name || row.id,
    meta: {
      label: "Symbol Name",
    },
    enableHiding: false,
  },
  {
    id: "quantity",
    accessorKey: "quantity",
    enableHiding: true,
    header: ({ column }) => (
      <DataTableColumnHeader className="justify-end text-right" column={column} title="Qty" />
    ),
    meta: {
      label: "Quantity",
    },
    cell: ({ row }) => {
      const symbol = row.original.instrument?.symbol ?? row.original.id;
      const isOption = !!parseOccSymbol(symbol);
      const assetTypeKey = row.original.instrument?.classifications?.assetType?.key ?? "";
      const isBond =
        assetTypeKey.startsWith("BOND_") ||
        assetTypeKey === "DEBT_SECURITY" ||
        assetTypeKey === "MONEY_MARKET_DEBT";
      return (
        <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
          <QuantityDisplay value={row.original.quantity} isHidden={isHidden} />
          <span className="text-muted-foreground text-xs">
            {isOption ? "contracts" : isBond ? "bonds" : "shares"}
          </span>
        </div>
      );
    },
    sortingFn: (rowA, rowB) => rowA.original.quantity - rowB.original.quantity,
  },
  {
    id: "marketPrice",
    accessorFn: (row) => row.price ?? 0,
    enableHiding: true,
    enableSorting: true,
    header: ({ column }) => (
      <DataTableColumnHeader
        className="justify-end text-right"
        column={column}
        title="Today's Price"
      />
    ),
    meta: {
      label: "Today's Price",
    },
    cell: ({ row }) => {
      const holding = row.original;
      const price = holding.price ?? 0;
      const currency = holding.localCurrency;
      return (
        <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
          <AmountDisplay value={price} currency={currency} />
          <GainPercent className="text-xs" value={holding.dayChangePct || 0} />
        </div>
      );
    },
  },
  {
    id: "bookValue",
    accessorFn: (row) => row.costBasis?.local ?? 0,
    enableHiding: true,
    header: ({ column }) => (
      <DataTableColumnHeader className="justify-end" column={column} title="Book Cost" />
    ),
    meta: {
      label: "Book Cost",
    },
    cell: ({ row }) => {
      const holding = row.original;
      const value = holding.costBasis?.local ?? 0;
      const currency = holding.localCurrency;

      return (
        <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
          <AmountDisplay value={value} currency={currency} isHidden={isHidden} />
          <div className="text-xs text-transparent">-</div>
        </div>
      );
    },
    sortingFn: (rowA, rowB) => {
      const valueA = rowA.original.costBasis?.local ?? 0;
      const valueB = rowB.original.costBasis?.local ?? 0;
      return valueA - valueB;
    },
  },
  {
    id: "avgCost",
    accessorFn: (row) => safeDivide(row.costBasis?.local ?? 0, row.quantity),
    enableHiding: true,
    header: ({ column }) => (
      <DataTableColumnHeader className="justify-end" column={column} title="Avg Cost" />
    ),
    meta: {
      label: "Avg Cost",
    },
    cell: ({ row }) => {
      const holding = row.original;
      const avgCost = safeDivide(holding.costBasis?.local ?? 0, holding.quantity);
      return (
        <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
          <AmountDisplay value={avgCost} currency={holding.localCurrency} isHidden={isHidden} />
          <div className="text-xs text-transparent">-</div>
        </div>
      );
    },
    sortingFn: (rowA, rowB) => {
      const a = safeDivide(rowA.original.costBasis?.local ?? 0, rowA.original.quantity);
      const b = safeDivide(rowB.original.costBasis?.local ?? 0, rowB.original.quantity);
      return a - b;
    },
  },
  {
    id: "portfolioWeight",
    accessorFn: (row) => row.weight,
    enableHiding: true,
    header: ({ column }) => (
      <DataTableColumnHeader className="justify-end" column={column} title="Allocation" />
    ),
    meta: {
      label: "Allocation",
    },
    cell: ({ row }) => (
      <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
        <span className="font-medium">{(row.original.weight * 100).toFixed(2)}%</span>
        <div className="text-xs text-transparent">-</div>
      </div>
    ),
    sortingFn: (rowA, rowB) => rowA.original.weight - rowB.original.weight,
  },
  {
    id: "marketValue",
    accessorFn: (row) => row.marketValue.base ?? 0,
    enableHiding: false,
    header: ({ column }) => (
      <DataTableColumnHeader className="justify-end" column={column} title="Total Value" />
    ),
    meta: {
      label: "Total Value",
    },
    cell: ({ row }) => {
      const holding = row.original;
      const { value, currency } = getDisplayValueAndCurrency(
        holding,
        holding.marketValue.base,
        showConvertedValues,
      );

      return (
        <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
          <AmountDisplay value={value} currency={currency} isHidden={isHidden} />
          <div className="text-muted-foreground text-xs">{currency}</div>
        </div>
      );
    },
    sortingFn: (rowA, rowB) => {
      const holdingA = rowA.original;
      const holdingB = rowB.original;

      // Always sort by base currency value for consistency
      const valueA = holdingA.marketValue.base ?? 0;
      const valueB = holdingB.marketValue.base ?? 0;

      return valueA - valueB;
    },
  },
  {
    id: "totalPnl",
    accessorFn: (row) => row.totalGain?.base ?? 0,
    enableHiding: true,
    header: ({ column }) => (
      <DataTableColumnHeader className="justify-end" column={column} title="Total P&L" />
    ),
    meta: {
      label: "Total P&L",
    },
    cell: ({ row }) => {
      const holding = row.original;
      const value = showConvertedValues
        ? (holding.totalGain?.base ?? 0)
        : (holding.totalGain?.local ?? 0);
      const currency = showConvertedValues ? holding.baseCurrency : holding.localCurrency;

      return (
        <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
          <AmountDisplay value={value} currency={currency} colorFormat={true} isHidden={isHidden} />
          <GainPercent className="text-xs" value={holding.totalGainPct || 0} />
        </div>
      );
    },
    sortingFn: (rowA, rowB) => {
      const holdingA = rowA.original;
      const holdingB = rowB.original;

      // Always sort by base currency value for consistency
      const valueA = holdingA.totalGain?.base ?? 0;
      const valueB = holdingB.totalGain?.base ?? 0;

      return valueA - valueB;
    },
  },
  {
    id: "totalReturn",
    accessorFn: (row) => row.totalReturn?.base ?? row.totalGain?.base ?? 0,
    enableHiding: true,
    header: ({ column }) => (
      <DataTableColumnHeader className="justify-end" column={column} title="Total Return" />
    ),
    meta: {
      label: "Total Return",
    },
    cell: ({ row }) => {
      const holding = row.original;
      const value = showConvertedValues
        ? (holding.totalReturn?.base ?? 0)
        : (holding.totalReturn?.local ?? 0);
      const currency = showConvertedValues ? holding.baseCurrency : holding.localCurrency;

      return (
        <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
          <AmountDisplay value={value} currency={currency} colorFormat={true} isHidden={isHidden} />
          <GainPercent className="text-xs" value={holding.totalReturnPct || 0} />
        </div>
      );
    },
    sortingFn: (rowA, rowB) => {
      const valueA = rowA.original.totalReturn?.base ?? rowA.original.totalGain?.base ?? 0;
      const valueB = rowB.original.totalReturn?.base ?? rowB.original.totalGain?.base ?? 0;
      return valueA - valueB;
    },
  },
  {
    id: "dayPnl",
    accessorFn: (row) => row.dayChange?.base ?? 0,
    enableHiding: true,
    header: ({ column }) => (
      <DataTableColumnHeader className="justify-end" column={column} title="Day P&L" />
    ),
    meta: {
      label: "Day P&L",
    },
    cell: ({ row }) => {
      const holding = row.original;
      const value = showConvertedValues
        ? (holding.dayChange?.base ?? 0)
        : (holding.dayChange?.local ?? 0);
      const currency = showConvertedValues ? holding.baseCurrency : holding.localCurrency;

      return (
        <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
          <AmountDisplay value={value} currency={currency} colorFormat={true} isHidden={isHidden} />
          <GainPercent className="text-xs" value={holding.dayChangePct || 0} />
        </div>
      );
    },
    sortingFn: (rowA, rowB) => {
      const valueA = rowA.original.dayChange?.base ?? 0;
      const valueB = rowB.original.dayChange?.base ?? 0;
      return valueA - valueB;
    },
  },
  {
    id: "unrealizedPnl",
    accessorFn: (row) => row.unrealizedGain?.base ?? 0,
    enableHiding: true,
    header: ({ column }) => (
      <DataTableColumnHeader className="justify-end" column={column} title="Unrealized P&L" />
    ),
    meta: {
      label: "Unrealized P&L",
    },
    cell: ({ row }) => {
      const holding = row.original;
      const value = showConvertedValues
        ? (holding.unrealizedGain?.base ?? 0)
        : (holding.unrealizedGain?.local ?? 0);
      const currency = showConvertedValues ? holding.baseCurrency : holding.localCurrency;

      return (
        <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
          <AmountDisplay value={value} currency={currency} colorFormat={true} isHidden={isHidden} />
          <GainPercent className="text-xs" value={holding.unrealizedGainPct || 0} />
        </div>
      );
    },
    sortingFn: (rowA, rowB) => {
      const valueA = rowA.original.unrealizedGain?.base ?? 0;
      const valueB = rowB.original.unrealizedGain?.base ?? 0;
      return valueA - valueB;
    },
  },
  {
    id: "income",
    accessorFn: (row) => row.income?.base ?? 0,
    enableHiding: true,
    header: ({ column }) => (
      <DataTableColumnHeader className="justify-end" column={column} title="Income" />
    ),
    meta: {
      label: "Income",
    },
    cell: ({ row }) => {
      const holding = row.original;
      const value = showConvertedValues
        ? (holding.income?.base ?? 0)
        : (holding.income?.local ?? 0);
      const currency = showConvertedValues ? holding.baseCurrency : holding.localCurrency;

      return (
        <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
          <AmountDisplay value={value} currency={currency} colorFormat={true} isHidden={isHidden} />
          <div className="text-xs text-transparent">-</div>
        </div>
      );
    },
    sortingFn: (rowA, rowB) => {
      const valueA = rowA.original.income?.base ?? 0;
      const valueB = rowB.original.income?.base ?? 0;
      return valueA - valueB;
    },
  },
  {
    id: "holdingType",
    accessorFn: (row) => row.instrument?.classifications?.assetType?.name,
    meta: {
      label: "Asset Type",
    },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Asset Type" />,
    filterFn: "arrIncludesSome",
  },
  {
    id: "currency",
    accessorKey: "localCurrency",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Currency" />,
    meta: {
      label: "Currency",
    },
    cell: ({ row }) => <div className="text-muted-foreground">{row.original.localCurrency}</div>,
    filterFn: (row, id, value) => {
      return value.includes(row.getValue(id));
    },
  },
  {
    id: "actions",
    enableHiding: false,
    header: () => null,
    cell: ({ row }) => {
      const navigate = useNavigate();
      const holding = row.original;
      const hasInstrument = !!holding.instrument;

      const handleNavigate = () => {
        // Use instrument.id (asset ID) for navigation, not symbol (which may be stripped)
        const navSymbol = holding.instrument?.id ?? holding.id;
        navigate(`/holdings/${encodeURIComponent(navSymbol)}`, {
          state: { holding },
        });
      };

      return (
        <div className="flex items-center justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
                <Icons.MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {hasInstrument && onClassify && (
                <DropdownMenuItem onClick={() => onClassify(holding)}>
                  <Icons.Tag className="mr-2 h-4 w-4" />
                  Classify
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={handleNavigate}>
                <Icons.ChevronRight className="mr-2 h-4 w-4" />
                View Details
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      );
    },
  },
];
