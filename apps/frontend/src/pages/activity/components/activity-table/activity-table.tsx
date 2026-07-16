import React from "react";

import { TickerAvatar } from "@/components/ticker-avatar";
import { parseOccSymbol } from "@/lib/occ-symbol";
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
import {
  calculateActivityValue,
  isAssetBackedIncomeActivity,
  isCashActivity,
  isCashTransfer,
  isSecuritiesTransfer,
  isFeeActivity,
  isIncomeActivity,
  isSplitActivity,
  formatSplitRatio,
} from "@/lib/activity-utils";
import { localizeActivitySubtypeName } from "@/lib/activity-utils";
import { ActivityType, getExchangeDisplayName } from "@/lib/constants";
import { ActivityDetails } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";
import { useSettingsContext } from "@/lib/settings-provider";
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
import { Button, EmptyPlaceholder, formatAmount, formatPrice } from "@wealthfolio/ui";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useActivityMutations } from "../../hooks/use-activity-mutations";
import { ActivityOperations } from "../activity-operations";
import { ActivityTypeBadge } from "../activity-type-badge";

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
  onClearFilters?: () => void;
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
  onClearFilters,
}: ActivityTableProps) => {
  const { t } = useTranslation();
  const { duplicateActivityMutation } = useActivityMutations();
  const { settings } = useSettingsContext();
  const appTimezone = settings?.timezone?.trim() || undefined;

  const handleDuplicate = React.useCallback(
    async (activity: ActivityDetails) => duplicateActivityMutation.mutateAsync(activity),
    [duplicateActivityMutation],
  );

  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({
    accountId: false,
    accountCurrency: false,
    assetName: false,
    currency: false,
  });
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
              ? formatDateTime(dateVal, appTimezone)
              : formatDateTime(String(dateVal), appTimezone);
          return (
            <div className="ml-2 flex flex-col">
              <span>{formattedDate.date}</span>
              <span className="text-muted-foreground text-xs font-light">{formattedDate.time}</span>
            </div>
          );
        },
      },
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
            ? `${new Date(parsedOption.expiration + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })} $${parsedOption.strikePrice} ${parsedOption.optionType}`
            : null;

          const content = (
            <div className="flex max-w-[220px] items-center gap-2">
              <TickerAvatar symbol={avatarSymbol} className="h-8 w-8 shrink-0" />
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
              {typeof quantity === "number" ? quantity : String(quantity)}
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
            return <div className="text-right">{formatAmount(Number(amount), currency)}</div>;
          }

          return <div className="text-right">{formatPrice(unitPrice, currency)}</div>;
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
              {activityType === "SPLIT" ? "-" : formatAmount(fee, currency)}
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
              {activityType === "SPLIT" ? "-" : formatAmount(tax, currency)}
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
          return <div className="pr-4 text-right">{formatAmount(displayValue, currency)}</div>;
        },
      },
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
            />
          );
        },
        enableHiding: false,
      },
    ],
    [
      appTimezone,
      handleEdit,
      handleDelete,
      handleDuplicate,
      onLinkTransfer,
      onUnlinkTransfer,
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

  if (isLoading) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
        {t("activity:table.loading")}
      </div>
    );
  }

  const hasRows = table.getRowModel().rows?.length > 0;

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
            <Button onClick={onAdd}>
              <Icons.Plus className="mr-2 h-4 w-4" aria-hidden="true" />
              {t("activity:add_activity")}
            </Button>
          ) : null}
        </EmptyPlaceholder>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto rounded-md border">
        <Table>
          <TableHeader className="bg-muted-foreground/5 sticky top-0 z-10">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
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

          <TableBody>
            {table.getRowModel().rows.map((row) => {
              return (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
};

export default ActivityTable;
