import { ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";

import { TickerAvatar } from "@/components/ticker-avatar";
import { Badge, formatAmount } from "@wealthfolio/ui";
import { DataTable } from "@wealthfolio/ui/components/ui/data-table";
import { DataTableColumnHeader } from "@wealthfolio/ui/components/ui/data-table/data-table-column-header";
import { DataTableFacetedFilterProps } from "@wealthfolio/ui/components/ui/data-table/data-table-faceted-filter";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@wealthfolio/ui/components/ui/dropdown-menu";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@wealthfolio/ui/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@wealthfolio/ui/components/ui/tooltip";

import { parseOccSymbol } from "@/lib/occ-symbol";
import { useSettingsContext } from "@/lib/settings-provider";
import { ASSET_KIND_DISPLAY_NAMES, LatestQuoteSnapshot } from "@/lib/types";
import { formatDate } from "@/lib/utils";
import { getNoQuoteReasonText, isStaleQuote, ParsedAsset } from "./asset-utils";

interface AssetsTableProps {
  assets: ParsedAsset[];
  latestQuotes?: Record<string, LatestQuoteSnapshot>;
  heldAssetIds: Set<string>;
  isLoading?: boolean;
  onEdit: (asset: ParsedAsset) => void;
  onDelete: (asset: ParsedAsset) => void;
  onUpdateQuotes: (asset: ParsedAsset) => void;
  onRefetchQuotes: (asset: ParsedAsset) => void;
  isUpdatingQuotes?: boolean;
  isRefetchingQuotes?: boolean;
}

const PRICE_STALE_OPTIONS = [
  { label: "Up to Date", value: "false" },
  { label: "Stale", value: "true" },
];

const HOLDING_STATUS_OPTIONS = [
  { label: "Current", value: "true" },
  { label: "Past", value: "false" },
];

export function AssetsTable({
  assets,
  latestQuotes = {},
  heldAssetIds,
  isLoading,
  onEdit,
  onDelete,
  onUpdateQuotes,
  onRefetchQuotes,
  isUpdatingQuotes,
  isRefetchingQuotes,
}: AssetsTableProps) {
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";
  const navigate = useNavigate();

  const columns: ColumnDef<ParsedAsset>[] = useMemo(
    () => [
      {
        id: "symbol",
        accessorFn: (row) => row.displayCode ?? "",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Security" />,
        size: 220,
        maxSize: 260,
        cell: ({ row }) => {
          const asset = row.original;
          const rawSymbol = asset.displayCode ?? "";
          const parsedOption = parseOccSymbol(rawSymbol);
          const displaySymbol = parsedOption
            ? parsedOption.underlying
            : (asset.displayCode ?? asset.name ?? "Unknown");
          const subtitle = parsedOption
            ? `${new Date(parsedOption.expiration + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })} $${parsedOption.strikePrice} ${parsedOption.optionType}`
            : (asset.name ?? "—");
          const avatarSymbol = parsedOption ? parsedOption.underlying : rawSymbol;
          return (
            <button
              type="button"
              onClick={() => navigate(`/holdings/${encodeURIComponent(asset.id)}`)}
              className="hover:bg-muted/60 focus-visible:ring-ring group flex w-full items-center gap-2.5 rounded-md py-1 text-left transition"
            >
              <TickerAvatar symbol={avatarSymbol} className="h-8 w-8 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="group-hover:text-primary flex items-center gap-1.5 font-semibold leading-tight transition-colors">
                  {displaySymbol}
                  {parsedOption ? (
                    <Badge variant="secondary" className="text-[10px]">
                      Option
                    </Badge>
                  ) : null}
                </div>
                <div className="text-muted-foreground line-clamp-2 text-xs leading-tight">
                  {subtitle}
                </div>
              </div>
            </button>
          );
        },
      },
      {
        id: "market",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Market" />,
        size: 120,
        cell: ({ row }) => {
          const asset = row.original;
          const isManual = asset.quoteMode === "MANUAL";
          return (
            <div className="space-y-0.5">
              <div className="flex items-center gap-1.5 text-sm">
                {asset.exchangeName ? (
                  <>
                    <span className="font-medium">{asset.exchangeName}</span>
                    <span className="text-muted-foreground/50">·</span>
                  </>
                ) : null}
                <span className="text-muted-foreground">{asset.quoteCcy}</span>
              </div>
              {isManual ? (
                <div>
                  <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                    Manual
                  </Badge>
                </div>
              ) : null}
            </div>
          );
        },
      },
      {
        accessorKey: "quoteCcy",
        header: () => null,
        cell: () => null,
        enableHiding: false,
      },
      {
        accessorKey: "assetSubClass",
        header: () => null,
        cell: () => null,
        enableHiding: false,
      },
      {
        accessorKey: "quoteMode",
        header: () => null,
        cell: () => null,
        enableHiding: false,
      },
      {
        accessorKey: "kind",
        header: () => null,
        cell: () => null,
        enableHiding: false,
        filterFn: (row, id, value) => {
          const filterValue = value as string[];
          const cellValue = row.getValue(id);
          return filterValue.includes(cellValue as string);
        },
      },
      {
        accessorKey: "isStale",
        header: () => null,
        cell: () => null,
        enableHiding: false,
        filterFn: (row, id, value) => {
          const filterValue = value as string[];
          const cellValue = row.getValue(id);
          return filterValue.includes(cellValue as string);
        },
      },
      {
        accessorKey: "holdingStatus",
        header: () => null,
        cell: () => null,
        enableHiding: false,
        filterFn: (row, id, value) => {
          const filterValue = value as string[];
          const cellValue = row.getValue(id);
          return filterValue.includes(cellValue as string);
        },
      },
      {
        id: "latestQuote",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Quote" className="text-right" />
        ),
        size: 130,
        cell: ({ row }) => {
          const asset = row.original;
          const snapshot = latestQuotes[asset.id];
          const quote = snapshot?.quote;
          const stale = isStaleQuote(snapshot, asset);
          const noQuoteReason = getNoQuoteReasonText(snapshot, asset);

          if (!quote) {
            return (
              <div className="text-right">
                <div className="flex items-center justify-end gap-1.5">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Icons.AlertTriangle
                        className="h-3.5 w-3.5 text-amber-500"
                        aria-label={noQuoteReason}
                      />
                    </TooltipTrigger>
                    <TooltipContent>{noQuoteReason}</TooltipContent>
                  </Tooltip>
                  <span className="text-muted-foreground text-sm">No quotes</span>
                </div>
              </div>
            );
          }

          return (
            <div className="text-right">
              <div className="flex items-center justify-end gap-1.5">
                {stale ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Icons.AlertTriangle
                        className="h-3.5 w-3.5 text-amber-500"
                        aria-label="Quote is behind market day"
                      />
                    </TooltipTrigger>
                    <TooltipContent>Latest quote is behind the current market day</TooltipContent>
                  </Tooltip>
                ) : null}
                <span className="font-semibold tabular-nums">
                  {formatAmount(quote.close, quote.currency ?? asset.quoteCcy ?? baseCurrency)}
                </span>
              </div>
              <div className="text-muted-foreground text-[11px]">{formatDate(quote.timestamp)}</div>
            </div>
          );
        },
      },
      {
        id: "actions",
        header: "",
        size: 56,
        minSize: 56,
        cell: ({ row }) => {
          const asset = row.original;
          return (
            <div className="flex justify-end">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="hover:bg-muted text-muted-foreground inline-flex h-9 w-9 items-center justify-center rounded-md border transition"
                    aria-label="Open actions"
                  >
                    <Icons.MoreVertical className="h-4 w-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => onEdit(asset)}>Edit</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => onUpdateQuotes(asset)}
                    disabled={isUpdatingQuotes}
                  >
                    Update quotes
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => onRefetchQuotes(asset)}
                    disabled={isRefetchingQuotes}
                  >
                    Refetch price history
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onSelect={() => onDelete(asset)}
                  >
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        },
      },
    ],
    [
      latestQuotes,
      onDelete,
      onEdit,
      onRefetchQuotes,
      onUpdateQuotes,
      isRefetchingQuotes,
      isUpdatingQuotes,
      navigate,
    ],
  );

  // Build filter options from assets (quoteMode)
  const quoteModeOptions = useMemo(() => {
    const modes = new Set(assets.map((asset) => asset.quoteMode).filter(Boolean));
    return Array.from(modes).map((mode) => ({
      label: mode === "MARKET" ? "Auto" : mode,
      value: mode,
    }));
  }, [assets]);

  // Build filter options from assets (kind)
  const kindOptions = useMemo(() => {
    const kinds = new Set(assets.map((asset) => asset.kind).filter(Boolean));
    return Array.from(kinds).map((kind) => ({
      label: ASSET_KIND_DISPLAY_NAMES[kind] ?? kind,
      value: kind,
    }));
  }, [assets]);

  const filters: DataTableFacetedFilterProps<ParsedAsset, unknown>[] = useMemo(
    () => [
      {
        id: "holdingStatus",
        title: "Portfolio",
        options: HOLDING_STATUS_OPTIONS,
      },
      {
        id: "kind",
        title: "Kind",
        options: kindOptions,
      },
      {
        id: "quoteMode",
        title: "Mode",
        options: quoteModeOptions,
      },
      {
        id: "isStale",
        title: "Market Data",
        options: PRICE_STALE_OPTIONS,
      },
    ],
    [kindOptions, quoteModeOptions],
  );

  // Add computed field for stale status to enable filtering
  const assetsWithStaleFlag = useMemo(
    () =>
      assets.map((asset) => ({
        ...asset,
        isStale: isStaleQuote(latestQuotes[asset.id], asset) ? "true" : "false",
        holdingStatus: heldAssetIds.has(asset.id) ? "true" : "false",
      })),
    [assets, latestQuotes, heldAssetIds],
  );

  if (isLoading) {
    return (
      <div className="flex h-full flex-col">
        <div className="mb-2 shrink-0">
          <Skeleton className="h-10 w-full" />
        </div>
        <div className="min-h-0 flex-1 overflow-auto rounded-md border">
          <Table>
            <TableHeader className="bg-muted/50 sticky top-0 z-10">
              <TableRow>
                <TableHead>Security</TableHead>
                <TableHead>Market</TableHead>
                <TableHead className="text-right">Quote</TableHead>
                <TableHead className="w-10"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Array.from({ length: 6 }).map((_, index) => (
                <TableRow key={index}>
                  <TableCell>
                    <div className="flex items-center gap-2.5 py-1">
                      <Skeleton className="h-8 w-8 rounded-full" />
                      <div className="space-y-1">
                        <Skeleton className="h-4 w-14" />
                        <Skeleton className="h-3 w-28" />
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      <Skeleton className="h-4 w-20" />
                      <Skeleton className="h-4 w-10" />
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-end gap-1">
                      <Skeleton className="h-4 w-20" />
                      <Skeleton className="h-3 w-24" />
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end">
                      <Skeleton className="h-8 w-8" />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    );
  }

  return (
    <DataTable
      data={assetsWithStaleFlag}
      columns={columns}
      searchBy="symbol"
      filters={filters}
      defaultColumnVisibility={{
        quoteCcy: false,
        isStale: false,
        holdingStatus: false,
        assetSubClass: false,
        quoteMode: false,
        kind: false,
      }}
      defaultColumnFilters={[{ id: "holdingStatus", value: ["true"] }]}
      defaultSorting={[{ id: "symbol", desc: false }]}
      storageKey="securities-table-v5"
      scrollable
    />
  );
}
