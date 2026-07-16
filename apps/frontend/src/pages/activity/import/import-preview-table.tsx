import {
  ColumnDef,
  ColumnFiltersState,
  PaginationState,
  SortingState,
  VisibilityState,
  flexRender,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { DataTableColumnHeader } from "@wealthfolio/ui/components/ui/data-table/data-table-column-header";
import { DataTableFacetedFilterProps } from "@wealthfolio/ui/components/ui/data-table/data-table-faceted-filter";
import { DataTablePagination } from "@wealthfolio/ui/components/ui/data-table/data-table-pagination";
import { DataTableToolbar } from "@wealthfolio/ui/components/ui/data-table/data-table-toolbar";
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@wealthfolio/ui/components/ui/tooltip";
import type { Account, ActivityImport } from "@/lib/types";
import { cn, formatDateTime, toPascalCase } from "@/lib/utils";
import { useSettingsContext } from "@/lib/settings-provider";
import { formatAmount } from "@wealthfolio/ui";
import { motion } from "motion/react";

// Helper function to check if a field has errors
const hasFieldError = (activity: ActivityImport, fieldName: string): boolean => {
  return !!activity.errors && !!activity.errors[fieldName] && activity.errors[fieldName].length > 0;
};

// Helper function to get error message for a field
const getFieldErrorMessage = (activity: ActivityImport, fieldName: string): string[] => {
  if (activity.errors?.[fieldName]) {
    return activity.errors[fieldName];
  }
  return [];
};

const toNumber = (value: string | number | null | undefined): number | undefined => {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

// Helper function to safely format numbers, handling NaN/null/undefined values
const safeFormatAmount = (value: string | number | null | undefined, currency: string): string => {
  const parsed = toNumber(value);
  if (parsed === undefined) {
    return "-";
  }
  return formatAmount(parsed, currency);
};

// Helper function to safely display number values
const safeDisplayNumber = (value: string | number | null | undefined): string => {
  const parsed = toNumber(value);
  if (parsed === undefined) {
    return "-";
  }
  return parsed.toString();
};

export const ImportPreviewTable = ({
  activities,
  accounts,
}: {
  activities: ActivityImport[];
  accounts: Account[];
}) => {
  const { t } = useTranslation();
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";

  const [sorting, setSorting] = useState<SortingState>([
    {
      id: "lineNumber",
      desc: false,
    },
  ]);

  // Determine initial column filters based on whether activities have errors
  const initialColumnFilters = useMemo<ColumnFiltersState>(() => {
    const hasActivitiesWithErrors = activities.some((activity) => !activity.isValid);
    return hasActivitiesWithErrors ? [{ id: "isValid", value: ["false"] }] : [];
  }, [activities]);

  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>(initialColumnFilters);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({
    symbolName: false,
    accountName: false,
    lineNumber: false,
    validationErrors: false,
  });

  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 10,
  });

  const activitiesType = useMemo(() => {
    const uniqueTypesSet = new Set();
    return activities.reduce(
      (result, activity) => {
        const type = activity?.activityType;
        if (type && !uniqueTypesSet.has(type)) {
          uniqueTypesSet.add(type);
          result.push({ label: toPascalCase(type), value: type });
        }
        return result;
      },
      [] as { label: string; value: string }[],
    );
  }, [activities]);

  const filters = [
    {
      id: "isValid",
      title: t("activity:import.preview.status"),
      options: [
        { label: t("activity:import.csvViewer.error"), value: "false" },
        { label: t("activity:import.csvViewer.valid"), value: "true" },
      ],
    },
    {
      id: "activityType",
      title: t("activity:import.preview.type"),
      options: activitiesType,
    },
  ] satisfies DataTableFacetedFilterProps<ActivityImport, string>[];

  const table = useReactTable({
    data: activities,
    columns: getColumns(t, accounts, baseCurrency),
    state: {
      sorting,
      columnFilters,
      columnVisibility,
      pagination,
    },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
  });

  return (
    <div className="pt-0">
      <div className="space-y-2">
        <DataTableToolbar table={table} searchBy="symbol" filters={filters} />
        <div className="rounded-md border">
          <Table>
            <TableHeader className="bg-muted/40">
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <TableHead key={header.id} className="font-medium">
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody className="text-xs">
              {table.getRowModel().rows?.length ? (
                table.getRowModel().rows.map((row, index) => (
                  <motion.tr
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2, delay: index * 0.03 }}
                    key={row.id}
                    className={cn(
                      "hover:bg-muted/50 dark:hover:bg-muted/10 group transition-colors",
                      row.getValue("isValid")
                        ? index % 2 === 0
                          ? "bg-background"
                          : "bg-muted/20"
                        : "bg-destructive/5 dark:bg-destructive/10",
                    )}
                    data-state={row.getValue("isValid") ? "valid" : "invalid"}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className={cn(
                          "relative px-4 py-2",
                          cell.column.id === "isValid" &&
                            "border-border bg-muted/30 sticky left-0 z-20 w-[60px] border-r p-2",
                        )}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </motion.tr>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={table.getAllColumns().length} className="h-24 text-center">
                    <div className="flex flex-col items-center justify-center space-y-2 py-8">
                      <Icons.FileText className="text-muted-foreground h-10 w-10 opacity-40" />
                      <p className="text-muted-foreground text-sm">
                        {t("activity:import.preview.noActivitiesFound")}
                      </p>
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <DataTablePagination table={table} />
    </div>
  );
};

export default ImportPreviewTable;

// Enhanced error cell with improved tooltip behavior
const ErrorCell = ({
  hasError,
  errorMessages,
  children,
}: {
  hasError: boolean;
  errorMessages: string[];
  children: React.ReactNode;
}) => {
  if (!hasError) return <>{children}</>;

  return (
    <TooltipProvider>
      <Tooltip delayDuration={30}>
        <TooltipTrigger asChild>
          <div className="bg-destructive/10 absolute inset-0 cursor-help">
            <div className="relative flex h-full w-full items-center justify-between px-4 py-2">
              <div className="mr-2 flex-1">{children}</div>
              <Icons.AlertCircle className="text-destructive h-3.5 w-3.5 shrink-0" />
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent className="bg-destructive text-destructive-foreground dark:border-destructive max-w-[400px] space-y-2 border-none p-3 shadow-lg">
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {errorMessages.map((error, index) => (
              <li key={index}>{error}</li>
            ))}
          </ul>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

function getColumns(
  t: TFunction,
  accounts: Account[],
  baseCurrency: string,
): ColumnDef<ActivityImport>[] {
  const accountCurrencyLookup = new Map(accounts.map((account) => [account.id, account.currency]));
  return [
    {
      id: "lineNumber",
      accessorKey: "lineNumber",
    },
    {
      id: "isValid",
      accessorKey: "isValid",
      header: () => <span className="sr-only">{t("activity:import.preview.status")}</span>,
      cell: ({ row }) => {
        const isValid = row.getValue("isValid");
        const errors = row.original.errors || {};
        const lineNumber = row.original.lineNumber;

        // Format all errors for tooltip display
        const allErrors = Object.entries(errors).flatMap(([field, fieldErrors]) =>
          fieldErrors.map((err) => `${field}: ${err}`),
        );

        return isValid ? (
          <div className="flex w-[60px] items-center gap-1 text-xs">
            <div className="bg-success/20 text-success flex h-5 w-5 items-center justify-center rounded-full">
              <Icons.CheckCircle className="h-3.5 w-3.5" />
            </div>
            <span className="text-muted-foreground text-xs">
              {String(lineNumber).padStart(2, "0")}
            </span>
          </div>
        ) : (
          <TooltipProvider>
            <Tooltip delayDuration={30}>
              <TooltipTrigger asChild>
                <div className="flex w-[60px] cursor-help items-center gap-1 text-xs">
                  <div className="bg-destructive/20 text-destructive flex h-5 w-5 items-center justify-center rounded-full">
                    <Icons.XCircle className="h-3.5 w-3.5" />
                  </div>
                  <span className="text-muted-foreground text-xs">
                    {String(lineNumber).padStart(2, "0")}
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent
                side="right"
                sideOffset={10}
                className="bg-destructive text-destructive-foreground max-w-xs border-none p-3"
              >
                <h4 className="mb-2 font-medium">
                  {t("activity:import.preview.validationErrors")}
                </h4>
                <ul className="max-h-[300px] list-disc space-y-1 overflow-y-auto pl-5 text-sm">
                  {allErrors.length > 0 ? (
                    allErrors.map((error, index) => <li key={index}>{error}</li>)
                  ) : (
                    <li>{t("activity:import.preview.invalidActivity")}</li>
                  )}
                </ul>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        );
      },
      filterFn: (row, id, filterValue: string[]) => {
        const isValid = row.getValue(id);
        const filterBoolean = filterValue[0] === "true";
        return isValid === filterBoolean;
      },
      sortingFn: (rowA, rowB, id) => {
        const statusA = rowA.getValue(id);
        const statusB = rowB.getValue(id);
        return statusA === statusB ? 0 : statusA ? -1 : 1;
      },
    },
    {
      id: "account",
      accessorKey: "account",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title={t("activity:import.preview.account")} />
      ),
      cell: ({ row }) => {
        const accountId = row.original.accountId;
        const hasError = hasFieldError(row.original, "accountId");
        const errorMessages = getFieldErrorMessage(row.original, "accountId");
        const account = accounts.find((acc) => acc.id === accountId);

        return (
          <ErrorCell hasError={hasError} errorMessages={errorMessages}>
            <Badge variant="outline" className="font-medium">
              {account?.name || "-"}
            </Badge>
          </ErrorCell>
        );
      },
    },
    {
      id: "date",
      accessorKey: "date",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title={t("activity:import.preview.date")} />
      ),
      cell: ({ row }) => {
        const formattedDate = formatDateTime(row.getValue("date"));
        const hasError = hasFieldError(row.original, "date");
        const errorMessages = getFieldErrorMessage(row.original, "date");

        return (
          <ErrorCell hasError={hasError} errorMessages={errorMessages}>
            <div className="flex flex-col">
              <span className="text-xs">{formattedDate.date}</span>
              <span className="text-muted-foreground text-xs">{formattedDate.time}</span>
            </div>
          </ErrorCell>
        );
      },
    },
    {
      id: "activityType",
      accessorKey: "activityType",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title={t("activity:import.preview.type")} />
      ),
      cell: ({ row }) => {
        const type = row.getValue("activityType");
        const hasError = hasFieldError(row.original, "activityType");
        const errorMessages = getFieldErrorMessage(row.original, "activityType");
        return (
          <ErrorCell hasError={hasError} errorMessages={errorMessages}>
            <Badge variant="outline">{String(type)}</Badge>
          </ErrorCell>
        );
      },
      filterFn: (row, id, value: string) => {
        return value.includes(row.getValue(id));
      },
    },
    {
      id: "symbol",
      accessorKey: "symbol",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title={t("activity:import.preview.symbol")} />
      ),
      cell: ({ row }) => {
        const hasError = hasFieldError(row.original, "symbol");
        const errorMessages = getFieldErrorMessage(row.original, "symbol");
        const symbol = row.getValue("symbol");

        return (
          <ErrorCell hasError={hasError} errorMessages={errorMessages}>
            {symbol && typeof symbol === "string" && symbol.length > 0 ? (
              <Badge variant="secondary" className="min-w-[50px] rounded-sm text-xs font-medium">
                {symbol}
              </Badge>
            ) : (
              "-"
            )}
          </ErrorCell>
        );
      },
      sortingFn: (rowA, rowB, id) => {
        const profileA = String(rowA.getValue(id));
        const profileB = String(rowB.getValue(id));
        return profileA.localeCompare(profileB);
      },
      enableHiding: false,
    },
    {
      id: "quantity",
      accessorKey: "quantity",
      enableHiding: false,
      header: ({ column }) => (
        <DataTableColumnHeader
          className="justify-end text-right"
          column={column}
          title={t("activity:import.preview.shares")}
        />
      ),
      cell: ({ row }) => {
        const activityType = row.getValue("activityType");
        const quantity = row.getValue("quantity");
        const hasError = hasFieldError(row.original, "quantity");
        const errorMessages = getFieldErrorMessage(row.original, "quantity");

        return (
          <ErrorCell hasError={hasError} errorMessages={errorMessages}>
            <div className="text-right font-medium tabular-nums">
              {activityType === "SPLIT"
                ? "-"
                : safeDisplayNumber(quantity as string | number | null | undefined)}
            </div>
          </ErrorCell>
        );
      },
    },
    {
      id: "unitPrice",
      accessorKey: "unitPrice",
      enableHiding: false,
      enableSorting: false,
      header: ({ column }) => (
        <DataTableColumnHeader
          className="justify-end text-right"
          column={column}
          title={t("activity:import.preview.price")}
        />
      ),
      cell: ({ row }) => {
        const activityType = row.getValue("activityType");
        const unitPrice = row.getValue("unitPrice") as string | number | null | undefined;
        const currencyValue = row.getValue("currency");
        const accountCurrency = accountCurrencyLookup.get(row.original.accountId);
        const currency =
          typeof currencyValue === "string" && currencyValue
            ? currencyValue
            : accountCurrency || baseCurrency;
        const hasError = hasFieldError(row.original, "unitPrice");
        const errorMessages = getFieldErrorMessage(row.original, "unitPrice");

        return (
          <ErrorCell hasError={hasError} errorMessages={errorMessages}>
            <div className="text-right font-medium tabular-nums">
              {activityType === "SPLIT"
                ? (() => {
                    const ratio = toNumber(unitPrice);
                    return ratio === undefined ? "-" : `${ratio.toFixed(0)} : 1`;
                  })()
                : safeFormatAmount(unitPrice, currency)}
            </div>
          </ErrorCell>
        );
      },
    },
    {
      id: "amount",
      accessorKey: "amount",
      header: ({ column }) => (
        <DataTableColumnHeader
          className="justify-end text-right"
          column={column}
          title={t("activity:import.preview.amount")}
        />
      ),
      cell: ({ row }) => {
        const activityType = row.getValue("activityType");
        const amount = row.getValue("amount") as string | number | null | undefined;
        const currencyValue = row.getValue("currency");
        const accountCurrency = accountCurrencyLookup.get(row.original.accountId);
        const currency =
          typeof currencyValue === "string" && currencyValue
            ? currencyValue
            : accountCurrency || baseCurrency;

        // Check if amount field has errors directly
        const hasError = hasFieldError(row.original, "amount");
        const errorMessages = getFieldErrorMessage(row.original, "amount");

        return (
          <ErrorCell hasError={hasError} errorMessages={errorMessages}>
            <div className="text-right font-medium tabular-nums">
              {activityType === "SPLIT" ? "-" : safeFormatAmount(amount, currency)}
            </div>
          </ErrorCell>
        );
      },
    },
    {
      id: "fee",
      accessorKey: "fee",
      enableHiding: false,
      enableSorting: false,
      header: ({ column }) => (
        <DataTableColumnHeader
          className="justify-end text-right"
          column={column}
          title={t("activity:import.preview.fee")}
        />
      ),
      cell: ({ row }) => {
        const activityType = row.getValue("activityType");
        const fee = row.getValue("fee") as string | number | null | undefined;
        const currencyValue = row.getValue("currency");
        const accountCurrency = accountCurrencyLookup.get(row.original.accountId);
        const currency =
          typeof currencyValue === "string" && currencyValue
            ? currencyValue
            : accountCurrency || baseCurrency;
        const hasError = hasFieldError(row.original, "fee");
        const errorMessages = getFieldErrorMessage(row.original, "fee");

        return (
          <ErrorCell hasError={hasError} errorMessages={errorMessages}>
            <div className="text-muted-foreground text-right tabular-nums">
              {activityType === "SPLIT" ? "-" : safeFormatAmount(fee, currency)}
            </div>
          </ErrorCell>
        );
      },
    },
    {
      id: "tax",
      accessorKey: "tax",
      enableHiding: false,
      enableSorting: false,
      header: ({ column }) => (
        <DataTableColumnHeader
          className="justify-end text-right"
          column={column}
          title={t("activity:import.preview.tax")}
        />
      ),
      cell: ({ row }) => {
        const activityType = row.getValue("activityType");
        const tax = row.getValue("tax") as string | number | null | undefined;
        const currencyValue = row.getValue("currency");
        const accountCurrency = accountCurrencyLookup.get(row.original.accountId);
        const currency =
          typeof currencyValue === "string" && currencyValue
            ? currencyValue
            : accountCurrency || baseCurrency;
        const hasError = hasFieldError(row.original, "tax");
        const errorMessages = getFieldErrorMessage(row.original, "tax");

        return (
          <ErrorCell hasError={hasError} errorMessages={errorMessages}>
            <div className="text-muted-foreground text-right tabular-nums">
              {activityType === "SPLIT" ? "-" : safeFormatAmount(tax, currency)}
            </div>
          </ErrorCell>
        );
      },
    },

    {
      id: "currency",
      accessorKey: "currency",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title={t("activity:import.preview.currency")} />
      ),
      cell: ({ row }) => {
        const hasError = hasFieldError(row.original, "currency");
        const errorMessages = getFieldErrorMessage(row.original, "currency");
        const currencyValue = row.getValue("currency");
        const accountCurrency = accountCurrencyLookup.get(row.original.accountId);
        const currency =
          typeof currencyValue === "string" && currencyValue
            ? currencyValue
            : accountCurrency || "-";

        return (
          <ErrorCell hasError={hasError} errorMessages={errorMessages}>
            <Badge variant="outline" className="font-medium">
              {typeof currency === "string" ? currency : "-"}
            </Badge>
          </ErrorCell>
        );
      },
    },
  ];
}
