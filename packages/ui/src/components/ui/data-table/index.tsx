import {
  ColumnDef,
  ColumnFiltersState,
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
import * as React from "react";

import { Icons } from "../icons";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../table";
import { usePersistentState } from "../../../hooks/use-persistent-state";

import type { DataTableFacetedFilterProps } from "./data-table-faceted-filter";
import { DataTableToolbar } from "./data-table-toolbar";

export { DataTableColumnHeader } from "./data-table-column-header";
export type { DataTableFacetedFilterProps } from "./data-table-faceted-filter";

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  searchBy?: string;
  filters?: DataTableFacetedFilterProps<TData, TValue>[];
  defaultColumnVisibility?: VisibilityState;
  defaultSorting?: SortingState;
  defaultColumnFilters?: ColumnFiltersState;
  storageKey?: string;
  data: TData[];
  manualPagination?: boolean;
  scrollable?: boolean;
  showColumnToggle?: boolean;
  toolbarView?: React.ReactNode;
  toolbarFilters?: React.ReactNode;
  toolbarActions?: React.ReactNode;
  pinRowsToTop?: (row: TData) => boolean;
}

/**
 * Ids of the columns tanstack would let you sort, resolved the same way it resolves them
 * when it builds the table: `id ?? accessorKey.replaceAll(".", "_") ?? string header`,
 * sortable only when the column has an accessor and sorting is not disabled. Group defs
 * carry no accessor, so we descend into their children instead.
 */
function collectSortableColumnIds<TData, TValue>(columns: ColumnDef<TData, TValue>[], ids: string[] = []): string[] {
  for (const column of columns) {
    const children = "columns" in column ? column.columns : undefined;
    if (children?.length) {
      collectSortableColumnIds(children, ids);
      continue;
    }
    if (column.enableSorting === false) continue;
    const accessorKey = "accessorKey" in column ? String(column.accessorKey) : undefined;
    if (!("accessorFn" in column) && accessorKey === undefined) continue;
    const id =
      column.id ?? accessorKey?.replaceAll(".", "_") ?? (typeof column.header === "string" ? column.header : undefined);
    if (id) ids.push(id);
  }
  return ids;
}

export function DataTable<TData, TValue>({
  columns,
  data,
  searchBy,
  filters,
  manualPagination = false,
  defaultColumnVisibility,
  defaultSorting,
  defaultColumnFilters,
  storageKey,
  scrollable = false,
  showColumnToggle = false,
  toolbarView,
  toolbarFilters,
  toolbarActions,
  pinRowsToTop,
}: DataTableProps<TData, TValue>) {
  const [rowSelection, setRowSelection] = React.useState({});
  const [storedColumnVisibility, setColumnVisibility] = storageKey
    ? usePersistentState<VisibilityState>(`${storageKey}:column-visibility`, defaultColumnVisibility || {})
    : React.useState<VisibilityState>(defaultColumnVisibility || {});
  const columnVisibility = {
    ...(defaultColumnVisibility || {}),
    ...storedColumnVisibility,
  };
  const [columnFilters, setColumnFilters] = storageKey
    ? usePersistentState<ColumnFiltersState>(`${storageKey}:column-filters`, defaultColumnFilters || [])
    : React.useState<ColumnFiltersState>(defaultColumnFilters || []);
  const [storedSorting, setSorting] = storageKey
    ? usePersistentState<SortingState>(`${storageKey}:sorting`, defaultSorting || [])
    : React.useState<SortingState>(defaultSorting || []);

  // Views sharing one storageKey can render different column sets, so a stored sort
  // may reference a column that is absent right now. Fall back for this render only —
  // rewriting the stored value would discard the choice the user made in the other view.
  const sortableColumnIdsKey = collectSortableColumnIds(columns).join("\0");
  // Serialised so the memo below stays stable: callers pass defaultSorting as a literal.
  const defaultSortingKey = JSON.stringify(defaultSorting ?? []);

  const sorting = React.useMemo(() => {
    const sortableColumnIds = new Set(sortableColumnIdsKey.split("\0").filter(Boolean));
    const supported = storedSorting.filter(({ id }) => sortableColumnIds.has(id));

    if (supported.length === storedSorting.length) return storedSorting;
    if (supported.length > 0) return supported;
    return (JSON.parse(defaultSortingKey) as SortingState).filter(({ id }) => sortableColumnIds.has(id));
  }, [defaultSortingKey, sortableColumnIdsKey, storedSorting]);

  const table = useReactTable({
    data,
    columns,
    manualPagination: true,
    state: {
      sorting,
      columnVisibility,
      rowSelection,
      columnFilters,
      pagination: manualPagination
        ? undefined
        : {
            pageSize: 500,
            pageIndex: 0,
          },
    },

    enableRowSelection: true,
    onRowSelectionChange: setRowSelection,
    // Resolve the updater against the sorting the table is actually showing, not the
    // stored value it may have fallen back from.
    onSortingChange: (updater) => setSorting(typeof updater === "function" ? updater(sorting) : updater),
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
  });

  const rows = table.getRowModel().rows;
  const displayRows = pinRowsToTop
    ? [...rows.filter((row) => pinRowsToTop(row.original)), ...rows.filter((row) => !pinRowsToTop(row.original))]
    : rows;

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 shrink-0">
        <DataTableToolbar
          table={table}
          searchBy={searchBy}
          filters={filters}
          viewControl={toolbarView}
          additionalFilters={toolbarFilters}
          showColumnToggle={showColumnToggle}
          actions={toolbarActions}
        />
      </div>
      <div className={`min-h-0 flex-1 rounded-md border ${scrollable ? "overflow-auto" : ""}`}>
        <Table>
          <TableHeader className="bg-muted/50 sticky top-0 z-10">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  return (
                    <TableHead key={header.id}>
                      {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {displayRows.length ? (
              displayRows.map((row) => (
                <TableRow key={row.id} data-state={row.getIsSelected() && "selected"}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  <div className="flex flex-col items-center justify-center">
                    <Icons.FileText className="text-muted-foreground mb-2 h-10 w-10" />
                    <p className="text-muted-foreground text-sm">No results found.</p>
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
