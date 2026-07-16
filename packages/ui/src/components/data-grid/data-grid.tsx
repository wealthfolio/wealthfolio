"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";
import { Icons } from "../ui/icons";
import { cn } from "../../lib/utils";
import { DataGridColumnHeader } from "./data-grid-column-header";
import { DataGridContextMenu } from "./data-grid-context-menu";
import { DataGridPasteDialog } from "./data-grid-paste-dialog";
import { DataGridRow } from "./data-grid-row";
import { DataGridSearch } from "./data-grid-search";
import type { Direction } from "./data-grid-types";
import { flexRender, getCommonPinningStyles } from "./data-grid-utils";
import { useDataGrid } from "./use-data-grid";

const EMPTY_CELL_SELECTION_SET = new Set<string>();

interface DataGridProps<TData>
  extends
    Omit<ReturnType<typeof useDataGrid<TData>>, "dir" | "virtualTotalSize" | "virtualItems" | "measureElement">,
    Omit<React.ComponentProps<"div">, "contextMenu"> {
  dir?: Direction;
  /** Height of the grid. Can be a number (px) or CSS string like "100%" */
  height?: number | string;
  stretchColumns?: boolean;
  virtualTotalSize: number;
  virtualItems: ReturnType<typeof useDataGrid<TData>>["virtualItems"];
  measureElement: ReturnType<typeof useDataGrid<TData>>["measureElement"];
}

export function DataGrid<TData>({
  dataGridRef,
  headerRef,
  rowMapRef,
  footerRef,
  dir = "ltr",
  table,
  tableMeta,
  virtualTotalSize,
  virtualItems,
  measureElement,
  columns,
  columnSizeVars,
  searchState,
  searchMatchesByRow,
  activeSearchMatch,
  cellSelectionMap,
  focusedCell,
  editingCell,
  rowHeight,
  contextMenu,
  pasteDialog,
  onRowAdd,
  height,
  stretchColumns = false,
  className,
  ...props
}: DataGridProps<TData>) {
  const { t } = useTranslation();
  const rows = table.getRowModel().rows;
  const readOnly = tableMeta?.readOnly ?? false;
  const columnVisibility = table.getState().columnVisibility;
  const columnPinning = table.getState().columnPinning;

  const onDataGridContextMenu = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
  }, []);

  const onAddRowKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!onRowAdd) return;

      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onRowAdd();
      }
    },
    [onRowAdd],
  );

  return (
    <div data-slot="grid-wrapper" dir={dir} {...props} className={cn("relative flex w-full flex-col", className)}>
      {searchState && <DataGridSearch {...searchState} />}
      <DataGridContextMenu tableMeta={tableMeta} columns={columns} contextMenu={contextMenu} />
      <DataGridPasteDialog tableMeta={tableMeta} pasteDialog={pasteDialog} />
      <div
        role="grid"
        aria-label={t("ui:dataGrid.label", "Data grid")}
        aria-rowcount={rows.length + (onRowAdd ? 1 : 0)}
        aria-colcount={columns.length}
        data-slot="grid"
        tabIndex={0}
        ref={dataGridRef}
        className={cn("relative grid select-none overflow-auto rounded-md border focus:outline-none", className)}
        style={{
          ...columnSizeVars,
          ...(height !== undefined && {
            maxHeight: typeof height === "number" ? `${height}px` : height,
          }),
        }}
        onContextMenu={onDataGridContextMenu}
      >
        <div
          role="rowgroup"
          data-slot="grid-header"
          ref={headerRef}
          className="bg-background sticky top-0 z-10 grid border-b"
        >
          {table.getHeaderGroups().map((headerGroup, rowIndex) => (
            <div
              key={headerGroup.id}
              role="row"
              aria-rowindex={rowIndex + 1}
              data-slot="grid-header-row"
              tabIndex={-1}
              className="flex w-full"
            >
              {headerGroup.headers.map((header, colIndex) => {
                const sorting = table.getState().sorting;
                const currentSort = sorting.find((sort) => sort.id === header.column.id);
                const isSortable = header.column.getCanSort();

                return (
                  <div
                    key={header.id}
                    role="columnheader"
                    aria-colindex={colIndex + 1}
                    aria-sort={
                      currentSort?.desc === false
                        ? "ascending"
                        : currentSort?.desc === true
                          ? "descending"
                          : isSortable
                            ? "none"
                            : undefined
                    }
                    data-slot="grid-header-cell"
                    tabIndex={-1}
                    className={cn("relative", {
                      grow: stretchColumns && header.column.id !== "select",
                      "border-e": header.column.id !== "select",
                    })}
                    style={{
                      ...getCommonPinningStyles({ column: header.column, dir }),
                      width: `calc(var(--header-${header.id}-size) * 1px)`,
                    }}
                  >
                    {header.isPlaceholder ? null : typeof header.column.columnDef.header === "function" ? (
                      <div className="size-full px-3 py-1.5">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </div>
                    ) : (
                      <DataGridColumnHeader header={header} table={table} />
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div
          role="rowgroup"
          data-slot="grid-body"
          className="relative grid"
          style={{
            height: `${virtualTotalSize}px`,
            contain: "strict",
          }}
        >
          {virtualItems.map((virtualItem) => {
            const row = rows[virtualItem.index];
            if (!row) return null;

            const cellSelectionKeys = cellSelectionMap?.get(virtualItem.index) ?? EMPTY_CELL_SELECTION_SET;

            const searchMatchColumns = searchMatchesByRow?.get(virtualItem.index) ?? null;
            const isActiveSearchRow = activeSearchMatch?.rowIndex === virtualItem.index;

            return (
              <DataGridRow
                key={row.id}
                row={row}
                tableMeta={tableMeta}
                rowMapRef={rowMapRef}
                virtualItem={virtualItem}
                measureElement={measureElement}
                rowHeight={rowHeight}
                columnVisibility={columnVisibility}
                columnPinning={columnPinning}
                focusedCell={focusedCell}
                editingCell={editingCell}
                cellSelectionKeys={cellSelectionKeys}
                searchMatchColumns={searchMatchColumns}
                activeSearchMatch={isActiveSearchRow ? activeSearchMatch : null}
                dir={dir}
                readOnly={readOnly}
                stretchColumns={stretchColumns}
                columnCount={columns.length}
              />
            );
          })}
        </div>
        {onRowAdd && (
          <div
            role="rowgroup"
            data-slot="grid-footer"
            ref={footerRef}
            className="bg-background sticky bottom-0 z-10 grid border-t"
          >
            <div
              role="row"
              aria-rowindex={rows.length + 2}
              data-slot="grid-add-row"
              tabIndex={-1}
              className="flex w-full"
            >
              <div
                role="gridcell"
                tabIndex={0}
                className="bg-muted/30 hover:bg-muted/50 focus:bg-muted/50 relative flex h-9 grow items-center transition-colors focus:outline-none"
                style={{
                  width: table.getTotalSize(),
                  minWidth: table.getTotalSize(),
                }}
                onClick={onRowAdd}
                onKeyDown={onAddRowKeyDown}
              >
                <div className="text-muted-foreground sticky start-0 flex items-center gap-2 px-3">
                  <Icons.Plus className="size-3.5" />
                  <span className="text-sm">{t("ui:dataGrid.addRow", "Add row")}</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
