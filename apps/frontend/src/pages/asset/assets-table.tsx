import { ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { TickerAvatar } from "@/components/ticker-avatar";
import { Badge } from "@wealthfolio/ui";
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

import { ASSET_KIND_DISPLAY_NAMES, LatestQuoteSnapshot } from "@/lib/types";
import { parseOccSymbol } from "@/lib/occ-symbol";
import { formatDate } from "@/lib/utils";
import { formatPrice } from "@wealthfolio/ui";
import { useSettingsContext } from "@/lib/settings-provider";
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
  const { t } = useTranslation();
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";
  const navigate = useNavigate();

  const PRICE_STALE_OPTIONS = useMemo(
    () => [
      { label: t("asset:table.filters.up_to_date"), value: "false" },
      { label: t("asset:table.filters.stale"), value: "true" },
    ],
    [t],
  );

  const HOLDING_STATUS_OPTIONS = useMemo(
    () => [
      { label: t("asset:table.filters.current"), value: "true" },
      { label: t("asset:table.filters.past"), value: "false" },
    ],
    [t],
  );

  const columns: ColumnDef<ParsedAsset>[] = useMemo(
    () => [
      {
        id: "symbol",
        accessorFn: (row) => row.displayCode ?? "",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("asset:table.security")} />
        ),
        size: 220,
        maxSize: 260,
        cell: ({ row }) => {
          const asset = row.original;
          const rawSymbol = asset.displayCode ?? "";
          const parsedOption = parseOccSymbol(rawSymbol);
          const displaySymbol = parsedOption
            ? parsedOption.underlying
            : (asset.displayCode ?? asset.name ?? t("asset:table.unknown"));
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
                      {t("asset:table.option")}
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
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("asset:table.market")} />
        ),
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
                    {t("asset:table.manual")}
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
          <DataTableColumnHeader
            column={column}
            title={t("asset:table.quote")}
            className="text-right"
          />
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
                  <span className="text-muted-foreground text-sm">
                    {t("asset:table.no_quotes")}
                  </span>
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
                        aria-label={t("asset:table.quote_behind_aria")}
                      />
                    </TooltipTrigger>
                    <TooltipContent>{t("asset:table.quote_behind_tooltip")}</TooltipContent>
                  </Tooltip>
                ) : null}
                <span className="font-semibold tabular-nums">
                  {formatPrice(quote.close, quote.currency ?? asset.quoteCcy ?? baseCurrency)}
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
                    aria-label={t("asset:table.open_actions")}
                  >
                    <Icons.MoreVertical className="h-4 w-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => onEdit(asset)}>
                    {t("asset:table.edit")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => onUpdateQuotes(asset)}
                    disabled={isUpdatingQuotes}
                  >
                    {t("asset:table.update_quotes")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => onRefetchQuotes(asset)}
                    disabled={isRefetchingQuotes}
                  >
                    {t("asset:table.refetch_price_history")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onSelect={() => onDelete(asset)}
                  >
                    {t("asset:table.delete")}
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
      t,
    ],
  );

  // Build filter options from assets (quoteMode)
  const quoteModeOptions = useMemo(() => {
    const modes = new Set(assets.map((asset) => asset.quoteMode).filter(Boolean));
    return Array.from(modes).map((mode) => ({
      label: mode === "MARKET" ? t("asset:table.filters.auto") : mode,
      value: mode,
    }));
  }, [assets, t]);

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
        title: t("asset:table.filters.portfolio"),
        options: HOLDING_STATUS_OPTIONS,
      },
      {
        id: "kind",
        title: t("asset:table.filters.kind"),
        options: kindOptions,
      },
      {
        id: "quoteMode",
        title: t("asset:table.filters.mode"),
        options: quoteModeOptions,
      },
      {
        id: "isStale",
        title: t("asset:table.filters.market_data"),
        options: PRICE_STALE_OPTIONS,
      },
    ],
    [kindOptions, quoteModeOptions, HOLDING_STATUS_OPTIONS, PRICE_STALE_OPTIONS, t],
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
                <TableHead>{t("asset:table.security")}</TableHead>
                <TableHead>{t("asset:table.market")}</TableHead>
                <TableHead className="text-right">{t("asset:table.quote")}</TableHead>
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
