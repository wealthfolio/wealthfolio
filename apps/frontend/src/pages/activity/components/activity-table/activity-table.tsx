import React from "react";

import { TickerAvatar } from "@/components/ticker-avatar";
import {
  calculateActivityValue,
  formatSplitRatio,
  isAssetBackedIncomeActivity,
  isCashActivity,
  isCashTransfer,
  isFeeActivity,
  isIncomeActivity,
  isSecuritiesTransfer,
  isSplitActivity,
  localizeActivitySubtypeName,
} from "@/lib/activity-utils";
import { ActivityType, getExchangeDisplayName } from "@/lib/constants";
import { formatOptionSubtitle, parseOccSymbol } from "@/lib/occ-symbol";
import { isRowBodyClick } from "@/lib/row-click";
import { useSettingsContext } from "@/lib/settings-provider";
import { ActivityDetails } from "@/lib/types";
import { cn, formatDateTime } from "@/lib/utils";
import {
  type OnChangeFn,
  type VisibilityState,
  ColumnDef,
  SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { observeElementOffset, useVirtualizer } from "@tanstack/react-virtual";
import {
  AmountDisplay,
  Button,
  EmptyPlaceholder,
  PriceDisplay,
  useNumberFormatting,
  useDateFormatting,
} from "@wealthfolio/ui";
import { DataTableColumnHeader } from "@wealthfolio/ui/components/ui/data-table/data-table-column-header";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@wealthfolio/ui/components/ui/dropdown-menu";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@wealthfolio/ui/components/ui/table";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { connectPagePath } from "@/features/wealthfolio-connect/lib/connect-url";
import { InfiniteScrollTrigger } from "@/components/infinite-scroll-trigger";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { useHorizontalOverflow } from "@/hooks/use-horizontal-overflow";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { useVirtualScrollContainer } from "@/hooks/use-virtual-scroll-container";
import { useActivityMutations } from "../../hooks/use-activity-mutations";
import { ActivityOperations } from "../activity-operations";
import { ActivityTypeBadge } from "../activity-type-badge";

/**
 * Starting height for a virtualized row. Rows report their real height once
 * measured, so this only has to keep the scrollbar honest for rows still below
 * the fold.
 */
const ROW_HEIGHT = 89;
/** Rows kept mounted past the viewport edge, so a fast scroll stays painted. */
const OVERSCAN = 8;
const ACTIVITY_TABLE_COLUMN_VISIBILITY_KEY = "activity-table-column-visibility";

interface ActivityTableProps {
  activities: ActivityDetails[];
  isLoading: boolean;
  sorting: SortingState;
  onSortingChange: (sorting: SortingState) => void;
  handleEdit: (activity?: ActivityDetails) => void;
  handleDelete: (activity: ActivityDetails) => void;
  onLinkTransfer?: (activity: ActivityDetails) => void;
  onUnlinkTransfer?: (activity: ActivityDetails) => void;
  filtersActive?: boolean;
  onAdd?: () => void;
  /** Show a "Connect Account" button next to the add button when there are no activities. */
  showConnectAccountLink?: boolean;
  onClearFilters?: () => void;
  onLoadMore?: () => void;
  hasNextPage?: boolean;
  isFetching?: boolean;
  isFetchingNextPage?: boolean;
  hasLoadMoreError?: boolean;
}

export const ActivityTable = ({
  activities,
  isLoading,
  sorting,
  onSortingChange,
  handleEdit,
  handleDelete,
  onLinkTransfer,
  onUnlinkTransfer,
  filtersActive = false,
  onAdd,
  showConnectAccountLink = false,
  onClearFilters,
  onLoadMore,
  hasNextPage = false,
  isFetching,
  isFetchingNextPage = false,
  hasLoadMoreError = false,
}: ActivityTableProps) => {
  const numberFormatting = useNumberFormatting();
  const dateFormatting = useDateFormatting();
  const { isBalanceHidden } = useBalancePrivacy();
  const { t } = useTranslation();
  const { duplicateActivityMutation } = useActivityMutations();
  // mutateAsync is stable; the mutation object is not, and `columns` depends on this handler.
  const { mutateAsync: duplicateActivity } = duplicateActivityMutation;
  const { settings } = useSettingsContext();
  const appTimezone = settings?.timezone?.trim() || undefined;

  const handleDuplicate = React.useCallback(
    async (activity: ActivityDetails) => duplicateActivity(activity),
    [duplicateActivity],
  );

  const [columnVisibility, setColumnVisibility] = usePersistentState<VisibilityState>(
    ACTIVITY_TABLE_COLUMN_VISIBILITY_KEY,
    {
      accountId: false,
      accountCurrency: false,
      assetName: false,
      currency: false,
    },
  );
  // Rows carry a balance only when the search asked for them (one cash or
  // credit-card account in date order), so their presence decides the column.
  // End-of-day balances wait for the day-grouped list; this column shows the
  // balance after each row.
  const showsCashBalance = React.useMemo(
    () =>
      activities.some(
        (activity) => activity.cashBalance != null && activity.cashBalanceScope !== "DAY",
      ),
    [activities],
  );
  const symbolExchangeCountMap = React.useMemo(() => {
    const exchangesBySymbol = new Map<string, Set<string>>();

    for (const activity of activities) {
      const symbol = (activity.assetSymbol ?? "").trim().toUpperCase();
      const exchangeMic = (activity.exchangeMic ?? "").trim().toUpperCase();
      if (!symbol || !exchangeMic) continue;

      const current = exchangesBySymbol.get(symbol) ?? new Set<string>();
      current.add(exchangeMic);
      exchangesBySymbol.set(symbol, current);
    }

    return new Map(
      Array.from(exchangesBySymbol.entries()).map(([symbol, exchanges]) => [
        symbol,
        exchanges.size,
      ]),
    );
  }, [activities]);

  const columns: ColumnDef<ActivityDetails>[] = React.useMemo(
    () => [
      {
        id: "assetSymbol",
        accessorKey: "assetSymbol",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("activity:table_symbol")} />
        ),
        cell: ({ row }) => {
          const symbol = String(row.getValue("assetSymbol"));
          const assetId = row.original.assetId;
          const activityType = String(row.getValue("activityType"));
          const instrumentType = row.original.instrumentType;
          const isTransferActivity =
            activityType === ActivityType.TRANSFER_IN || activityType === ActivityType.TRANSFER_OUT;
          const isAssetBackedIncome = isAssetBackedIncomeActivity(activityType, symbol, assetId);
          const hasAsset = Boolean(assetId?.trim());
          const isCash = isTransferActivity
            ? isCashTransfer(activityType, symbol, assetId)
            : isCashActivity(activityType) && !isAssetBackedIncome;

          // Parse OCC symbol for options
          const isOptionActivity = instrumentType === "OPTION";
          const parsedOption = isOptionActivity ? parseOccSymbol(symbol) : null;

          // For cash activities, surface the payee/merchant from notes when available
          // (e.g., "AMAZON*MARKETPLACE" instead of just "Cash").
          const cashPayee = isCash ? (row.original.comment ?? "").trim() : "";
          const displaySymbol = isCash
            ? cashPayee || t("activity:table.cash")
            : parsedOption
              ? parsedOption.underlying
              : symbol;
          const avatarSymbol = isCash ? "$CASH" : symbol;
          const normalizedSymbol = (parsedOption?.underlying ?? symbol).trim().toUpperCase();
          const shouldShowExchange =
            !isCash && !isOptionActivity && (symbolExchangeCountMap.get(normalizedSymbol) ?? 0) > 1;
          const exchangeDisplay = shouldShowExchange
            ? getExchangeDisplayName(row.original.exchangeMic)
            : "";

          const assetName = row.getValue("assetName");
          const currency = row.getValue("currency");

          // Option subtitle: "Mar 29 $150 CALL"
          const optionSubtitle = parsedOption
            ? formatOptionSubtitle(parsedOption, { ...numberFormatting, ...dateFormatting })
            : null;

          const content = (
            <div className="flex max-w-[220px] items-center gap-2">
              <TickerAvatar
                symbol={avatarSymbol}
                exchangeMic={row.original.exchangeMic}
                instrumentType={row.original.instrumentType}
                assetId={assetId}
                className="h-8 w-8 shrink-0"
              />
              <div className="flex min-w-0 flex-col">
                <span className="flex items-center gap-1 truncate font-medium">
                  <span className="truncate">{displaySymbol}</span>
                  {exchangeDisplay ? (
                    <span className="text-muted-foreground shrink-0 text-xs font-normal">
                      · {exchangeDisplay}
                    </span>
                  ) : null}
                </span>
                <span className="text-muted-foreground truncate text-xs font-light">
                  {isCash
                    ? cashPayee
                      ? `${t("activity:table.cash")} · ${String(currency)}`
                      : String(currency)
                    : (optionSubtitle ?? String(assetName ?? currency))}
                </span>
              </div>
            </div>
          );

          if (isCash || !hasAsset) {
            return content;
          }
          return (
            <Link to={`/holdings/${encodeURIComponent(assetId)}`} className="-m-1 block p-1">
              {content}
            </Link>
          );
        },
        enableHiding: false,
      },
      {
        id: "date",
        accessorKey: "date",
        enableHiding: false,
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("activity:table_date")} />
        ),
        cell: ({ row }) => {
          const dateVal = row.getValue("date");
          const formattedDate =
            typeof dateVal === "string" || dateVal instanceof Date
              ? formatDateTime(dateVal, dateFormatting, appTimezone)
              : formatDateTime(String(dateVal), dateFormatting, appTimezone);
          return (
            <div className="ml-2 flex flex-col">
              <span>{formattedDate.date}</span>
              <span className="text-muted-foreground text-xs font-light">{formattedDate.time}</span>
            </div>
          );
        },
      },
      {
        id: "activityType",
        accessorKey: "activityType",
        enableHiding: false,
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("activity:table_type")} />
        ),
        cell: ({ row }) => {
          const activityType = row.getValue("activityType");
          const normalizedActivityType = String(activityType).trim().toUpperCase();
          const normalizedSubtype = row.original.subtype?.trim().toUpperCase();
          const subtypeLabel =
            normalizedSubtype && normalizedSubtype !== normalizedActivityType
              ? localizeActivitySubtypeName(t, normalizedSubtype)
              : undefined;

          return (
            <div className="flex min-w-0 max-w-[160px] flex-col items-start gap-1 text-sm">
              <ActivityTypeBadge
                type={activityType as ActivityType}
                className="whitespace-nowrap text-xs font-normal"
              />
              {subtypeLabel && (
                <span className="text-muted-foreground max-w-full truncate text-xs font-light">
                  {subtypeLabel}
                </span>
              )}
            </div>
          );
        },
        filterFn: (row, id, value: string) => {
          const cellValue = row.getValue(id);
          if (!cellValue) {
            return false;
          }

          return value.includes(cellValue as string);
        },
      },
      {
        id: "quantity",
        accessorKey: "quantity",
        enableHiding: true,
        enableSorting: false,
        meta: {
          label: t("activity:table_quantity"),
        },
        header: ({ column }) => (
          <DataTableColumnHeader
            className="justify-end text-right"
            column={column}
            title={t("activity:table_quantity")}
          />
        ),
        cell: ({ row }) => {
          const activityType = String(row.getValue("activityType"));
          const quantity = row.getValue("quantity");
          const assetSymbol = String(row.getValue("assetSymbol"));
          const isAssetBackedIncome = isAssetBackedIncomeActivity(
            activityType,
            assetSymbol,
            row.original.assetId,
          );
          const isTransfer =
            activityType === ActivityType.TRANSFER_IN || activityType === ActivityType.TRANSFER_OUT;
          const isCash = isTransfer
            ? isCashTransfer(activityType, assetSymbol, row.original.assetId)
            : isCashActivity(activityType) && !isAssetBackedIncome;

          if (
            isCash ||
            (isIncomeActivity(activityType) && !isAssetBackedIncome) ||
            isSplitActivity(activityType) ||
            isFeeActivity(activityType)
          ) {
            return <div className="pr-4 text-right">-</div>;
          }

          if (
            quantity == null ||
            (typeof quantity !== "number" && typeof quantity !== "string") ||
            String(quantity).trim() === ""
          ) {
            return <div className="pr-4 text-right">-</div>;
          }

          return (
            <div className="pr-4 text-right">
              {isBalanceHidden
                ? "••••"
                : typeof quantity === "number"
                  ? quantity
                  : String(quantity)}
            </div>
          );
        },
      },
      {
        id: "unitPrice",
        accessorKey: "unitPrice",
        enableSorting: false,
        enableHiding: true,
        meta: {
          label: t("activity:table_price_amount"),
        },
        header: ({ column }) => (
          <DataTableColumnHeader
            className="justify-end text-right"
            column={column}
            title={t("activity:table_price_amount")}
          />
        ),
        cell: ({ row }) => {
          const activityType = String(row.getValue("activityType"));
          const unitPrice = Number(row.getValue("unitPrice"));
          const amount = row.original.amount;
          const currencyVal = row.getValue("currency");
          const currency =
            typeof currencyVal === "string" && currencyVal
              ? currencyVal
              : row.original.accountCurrency || "USD";
          const assetSymbol = String(row.getValue("assetSymbol"));
          const isAssetBackedIncome = isAssetBackedIncomeActivity(
            activityType,
            assetSymbol,
            row.original.assetId,
          );

          if (activityType === "FEE") {
            return <div className="pr-4 text-right">-</div>;
          }
          if (activityType === "SPLIT") {
            return <div className="text-right">{formatSplitRatio(Number(amount))}</div>;
          }
          if (
            (isCashActivity(activityType) &&
              !isAssetBackedIncome &&
              !isSecuritiesTransfer(activityType, assetSymbol, row.original.assetId)) ||
            isCashTransfer(activityType, assetSymbol, row.original.assetId) ||
            (isIncomeActivity(activityType) && !isAssetBackedIncome)
          ) {
            return (
              <div className="text-right">
                <AmountDisplay
                  value={Number(amount)}
                  currency={currency}
                  isHidden={isBalanceHidden}
                />
              </div>
            );
          }

          return (
            <div className="text-right">
              <PriceDisplay value={unitPrice} currency={currency} isHidden={isBalanceHidden} />
            </div>
          );
        },
      },
      {
        id: "fee",
        accessorKey: "fee",
        enableHiding: true,
        enableSorting: false,
        meta: {
          label: t("activity:table_fee"),
        },
        header: ({ column }) => (
          <DataTableColumnHeader
            className="justify-end text-right"
            column={column}
            title={t("activity:table_fee")}
          />
        ),
        cell: ({ row }) => {
          const activityType = String(row.getValue("activityType"));
          const fee = Number(row.getValue("fee"));
          const currencyVal = row.getValue("currency");
          const currency =
            typeof currencyVal === "string" && currencyVal
              ? currencyVal
              : row.original.accountCurrency || "USD";

          return (
            <div className="text-right">
              {activityType === "SPLIT" ? (
                "-"
              ) : (
                <AmountDisplay value={fee} currency={currency} isHidden={isBalanceHidden} />
              )}
            </div>
          );
        },
      },
      {
        id: "tax",
        accessorKey: "tax",
        enableHiding: true,
        enableSorting: false,
        meta: {
          label: t("activity:table.tax"),
        },
        header: ({ column }) => (
          <DataTableColumnHeader
            className="justify-end text-right"
            column={column}
            title={t("activity:table.tax")}
          />
        ),
        cell: ({ row }) => {
          const activityType = String(row.getValue("activityType"));
          const tax = Number(row.getValue("tax") ?? 0);
          const currencyVal = row.getValue("currency");
          const currency =
            typeof currencyVal === "string" && currencyVal
              ? currencyVal
              : row.original.accountCurrency || "USD";

          return (
            <div className="text-right">
              {activityType === "SPLIT" ? (
                "-"
              ) : (
                <AmountDisplay value={tax} currency={currency} isHidden={isBalanceHidden} />
              )}
            </div>
          );
        },
      },
      {
        id: "value",
        accessorKey: "value",
        enableSorting: false,
        enableHiding: true,
        meta: {
          label: t("activity:table_total"),
        },
        header: ({ column }) => (
          <DataTableColumnHeader
            className="justify-end text-right"
            column={column}
            title={t("activity:table_total")}
          />
        ),
        cell: ({ row }) => {
          const activity = row.original;
          const activityType = activity.activityType;
          const currency = activity.currency || activity.accountCurrency || "USD";

          if (activityType === "SPLIT") {
            return <div className="pr-4 text-right">-</div>;
          }

          const displayValue = calculateActivityValue(activity);
          return (
            <div className="pr-4 text-right">
              <AmountDisplay value={displayValue} currency={currency} isHidden={isBalanceHidden} />
            </div>
          );
        },
      },
      ...(showsCashBalance
        ? [
            {
              id: "cashBalance",
              accessorKey: "cashBalance",
              enableSorting: false,
              enableHiding: true,
              meta: {
                label: t("activity:table_balance"),
              },
              header: ({ column }) => (
                <DataTableColumnHeader
                  className="justify-end text-right"
                  column={column}
                  title={t("activity:table_balance")}
                />
              ),
              cell: ({ row }) => {
                const { cashBalance, cashBalanceCurrency, cashBalanceScope } = row.original;
                if (cashBalance == null || !cashBalanceCurrency || cashBalanceScope === "DAY") {
                  return <div className="pr-4 text-right">-</div>;
                }
                return (
                  <div className="whitespace-nowrap pr-4 text-right">
                    <AmountDisplay
                      value={Number(cashBalance)}
                      currency={cashBalanceCurrency}
                      isHidden={isBalanceHidden}
                    />
                  </div>
                );
              },
            } satisfies ColumnDef<ActivityDetails>,
          ]
        : []),
      {
        id: "account",
        accessorKey: "accountName",
        enableSorting: false,
        enableHiding: true,
        meta: {
          label: t("activity:table_account"),
        },
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("activity:table_account")} />
        ),
        cell: ({ row }) => {
          const accountName = row.getValue("account");
          const accountCurrency = row.getValue("accountCurrency");
          return (
            <div className="ml-2 flex min-w-[150px] flex-col">
              <span>{String(accountName)}</span>
              <span className="text-muted-foreground text-xs font-light">
                {String(accountCurrency)}
              </span>
            </div>
          );
        },
      },
      {
        id: "currency",
        accessorKey: "currency",
        enableSorting: false,
        enableHiding: true,
        meta: {
          label: t("activity:table_currency"),
        },
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("activity:table_currency")} />
        ),
        cell: ({ row }) => <div>{row.getValue("currency")}</div>,
      },
      {
        id: "assetName",
        accessorKey: "assetName",
        enableHiding: false,
      },
      {
        id: "accountCurrency",
        accessorKey: "accountCurrency",
        enableHiding: false,
      },
      {
        id: "accountId",
        accessorKey: "accountId",
        filterFn: (row, id, value: string) => {
          const cellValue = row.getValue(id);
          if (!cellValue) {
            return false;
          }

          return value.includes(cellValue as string);
        },
        enableHiding: false,
      },
      {
        id: "actions",
        header: ({ table }) => {
          const hideableColumns = table.getAllColumns().filter((column) => column.getCanHide());
          return (
            <div className="flex justify-end">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8 rounded-lg"
                    title={t("activity:table_toggle_columns")}
                  >
                    <Icons.ChevronDown className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {hideableColumns.map((column) => {
                    const meta = column.columnDef.meta as { label?: string } | undefined;
                    return (
                      <DropdownMenuCheckboxItem
                        key={column.id}
                        className="capitalize"
                        checked={column.getIsVisible()}
                        onCheckedChange={(value) => column.toggleVisibility(!!value)}
                      >
                        {meta?.label ?? column.id}
                      </DropdownMenuCheckboxItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        },
        cell: ({ row }) => {
          return (
            <ActivityOperations
              row={row}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onDuplicate={handleDuplicate}
              onLinkTransfer={onLinkTransfer}
              onUnlinkTransfer={onUnlinkTransfer}
              hoverReveal
            />
          );
        },
        enableHiding: false,
      },
    ],
    [
      appTimezone,
      dateFormatting,
      isBalanceHidden,
      handleEdit,
      handleDelete,
      handleDuplicate,
      onLinkTransfer,
      onUnlinkTransfer,
      numberFormatting,
      showsCashBalance,
      symbolExchangeCountMap,
      t,
    ],
  );

  const handleSortingChange = React.useCallback<OnChangeFn<SortingState>>(
    (updaterOrValue) => {
      const nextSorting =
        typeof updaterOrValue === "function" ? updaterOrValue(sorting) : updaterOrValue;
      onSortingChange(nextSorting);
    },
    [onSortingChange, sorting],
  );

  const table = useReactTable({
    data: activities,
    columns,
    // Without this, row ids are positions ("0", "1", ...) — and the virtualizer
    // keys its measured heights by row id, so a sort or a refetch would hand a
    // row the height cached for whatever activity previously sat at its index.
    getRowId: (row) => row.id,
    manualSorting: true,
    onSortingChange: handleSortingChange,
    onColumnVisibilityChange: setColumnVisibility,
    state: {
      sorting,
      columnVisibility,
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    debugTable: true,
  });

  const tableRows = table.getRowModel().rows;

  // Embedded tables may scroll with the page; the body can start below both
  // page content and the table header, so account for that offset.
  const { listRef, scrollElement, scrollMargin } = useVirtualScrollContainer();

  const [tableBox, setTableBox] = React.useState<HTMLDivElement | null>(null);
  const [tableElement, setTableElement] = React.useState<HTMLTableElement | null>(null);
  const scrollsSideways = useHorizontalOverflow(tableBox, tableElement);

  // Keyed by activity, so a row keeps its measured height when a page loads
  // above it or the sort order changes. Stable so the virtualizer does not
  // rebuild every row's measurement on each render.
  const getItemKey = React.useCallback(
    (index: number) => tableRows[index]?.id ?? index,
    [tableRows],
  );

  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollElement,
    // A tab can mount this table inside an already-scrolled page. Read the
    // current offset before the virtualizer performs its initial scrollTo.
    observeElementOffset: (instance, onChange) => {
      onChange(instance.scrollElement?.scrollTop ?? 0, false);
      return observeElementOffset(instance, onChange);
    },
    estimateSize: () => ROW_HEIGHT,
    getItemKey,
    overscan: OVERSCAN,
    scrollMargin,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  // `start`/`end` are offsets within the scroll box, which begins above the
  // body; the body positions its own rows from zero.
  const paddingTop = virtualItems.length ? virtualItems[0].start - scrollMargin : 0;
  // With no window yet — the scroll port is resolved in a layout effect, so the
  // first commit has none — the body still reserves the full estimated height.
  // Collapsing to nothing instead would stop the port overflowing, and the port
  // is only recognised as one because it overflows: the list would settle empty
  // rather than measure itself and fill in.
  const paddingBottom = virtualItems.length
    ? totalSize - (virtualItems[virtualItems.length - 1].end - scrollMargin)
    : totalSize;
  const columnCount = table.getVisibleFlatColumns().length;

  if (isLoading) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
        {t("activity:table.loading")}
      </div>
    );
  }

  const hasRows = tableRows.length > 0;

  if (!hasRows) {
    return (
      <div className="flex h-full flex-col">
        <EmptyPlaceholder>
          <EmptyPlaceholder.Icon name="Activity" />
          <EmptyPlaceholder.Title>{t("activity:table.no_activities")}</EmptyPlaceholder.Title>
          <EmptyPlaceholder.Description>
            {filtersActive
              ? t("activity:table.no_activities_filtered")
              : t("activity:table.no_activities_desc")}
          </EmptyPlaceholder.Description>
          {filtersActive ? (
            onClearFilters ? (
              <Button variant="outline" onClick={onClearFilters}>
                {t("activity:table.clear_filters")}
              </Button>
            ) : null
          ) : onAdd ? (
            <div className="flex flex-col items-center gap-3 sm:flex-row">
              <Button onClick={onAdd}>
                <Icons.Plus className="mr-2 h-4 w-4" aria-hidden="true" />
                {t("activity:add_activity")}
              </Button>
              {showConnectAccountLink && (
                <Button variant="outline" asChild>
                  <Link to={connectPagePath("activities_empty")}>
                    <Icons.CloudSync2 className="mr-2 h-4 w-4" aria-hidden="true" />
                    {t("activity:page.connect_account")}
                  </Link>
                </Button>
              )}
            </div>
          ) : null}
        </EmptyPlaceholder>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* `overflow-anchor: none` keeps the browser from choosing a row in here
          as its scroll anchor: rows are recycled as you scroll, and
          re-anchoring to one that just changed height fights the virtualizer.
          The header pins to the page, below any sticky page header, only if
          nothing between them is a scroll container. A box that scrolls
          sideways is one, so the box scrolls only while the table is wider
          than it, and `Table`'s own wrapper never does. */}
      <div
        ref={setTableBox}
        data-virtual-scroll-parent
        className={cn(
          "min-h-0 flex-1 rounded-md border",
          scrollsSideways ? "overflow-auto" : "overflow-clip",
        )}
        style={{ overflowAnchor: "none" }}
      >
        <Table ref={setTableElement} containerClassName="overflow-visible">
          {/* Opaque, so rows don't show through the pinned header. A collapsed
              row border stays with the table grid instead of moving with
              sticky cells, so the cells draw the header's bottom line.
              The page header's offset only applies when the header pins to
              the page. Otherwise it pins to a nearer scroll container (the
              box while it scrolls sideways, or at 1024px and below an
              ancestor `globals.css` gives `overflow-x: hidden`), where that
              offset would push it down over the rows. */}
          <TableHeader
            className={cn(
              "bg-background sticky top-0 z-10 [&_th]:shadow-[inset_0_-1px_0_var(--color-border)] [&_tr]:border-b-0",
              !scrollsSideways && "[@media(width>1024px)]:top-[var(--page-header-height,0px)]",
            )}
          >
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="bg-muted-foreground/5">
                {headerGroup.headers.map((header) => {
                  return (
                    <TableHead key={header.id}>
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>

          {/* A table row cannot be wrapped in a positioned element without
              breaking column alignment, so the rows above and below the
              rendered window are stood in for by one spacer row at each end
              and the real rows stay in normal table flow. */}
          <TableBody ref={listRef}>
            {paddingTop > 0 && (
              <TableRow aria-hidden className="hover:bg-transparent">
                <TableCell colSpan={columnCount} className="p-0" style={{ height: paddingTop }} />
              </TableRow>
            )}
            {virtualItems.map((virtualItem) => {
              const row = tableRows[virtualItem.index];
              if (!row) return null;
              return (
                <TableRow
                  key={virtualItem.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualItem.index}
                  className="group/row cursor-pointer"
                  onClick={(e) => isRowBodyClick(e) && handleEdit(row.original)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      data-row-click-ignore={cell.column.id === "actions" || undefined}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
            {paddingBottom > 0 && (
              <TableRow aria-hidden className="hover:bg-transparent">
                <TableCell
                  colSpan={columnCount}
                  className="p-0"
                  style={{ height: paddingBottom }}
                />
              </TableRow>
            )}
          </TableBody>
        </Table>
        {onLoadMore && (
          <InfiniteScrollTrigger
            onLoadMore={onLoadMore}
            hasNextPage={hasNextPage}
            isFetching={isFetching ?? isFetchingNextPage}
            isFetchingNextPage={isFetchingNextPage}
            hasLoadMoreError={hasLoadMoreError}
          />
        )}
      </div>
    </div>
  );
};

export default ActivityTable;
