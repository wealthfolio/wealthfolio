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
  toolbarActions?: React.ReactNode;
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
  toolbarActions,
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
  const [sorting, setSorting] = storageKey
    ? usePersistentState<SortingState>(`${storageKey}:sorting`, defaultSorting || [])
    : React.useState<SortingState>(defaultSorting || []);

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
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
  });

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 shrink-0">
        <DataTableToolbar
          table={table}
          searchBy={searchBy}
          filters={filters}
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
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
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
