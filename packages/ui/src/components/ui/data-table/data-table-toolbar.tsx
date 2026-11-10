import type { ColumnOrderState, Table } from "@tanstack/react-table";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn, isKeyboardEventComposing } from "../../../lib/utils";
import { Button } from "../button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../dropdown-menu";
import { Icons } from "../icons";
import type { DataTableFacetedFilterProps } from "./data-table-faceted-filter";
import { DataTableFacetedFilter } from "./data-table-faceted-filter";

interface ColumnMeta {
  label?: string;
}

interface DataTableToolbarProps<TData> {
  table: Table<TData>;
  searchBy?: string;
  filters?: DataTableFacetedFilterProps<TData, unknown>[];
  viewControl?: React.ReactNode;
  additionalFilters?: React.ReactNode;
  showColumnToggle?: boolean;
  enableColumnReordering?: boolean;
  actions?: React.ReactNode;
}

/** Ids in the order tanstack shows them: listed ids first, the rest in definition order. */
function displayOrder(columnIds: string[], columnOrder: ColumnOrderState): string[] {
  const present = new Set(columnIds);
  const ordered = columnOrder.filter((id) => present.has(id));
  const placed = new Set(ordered);
  return [...ordered, ...columnIds.filter((id) => !placed.has(id))];
}

/**
 * Place `id` just before or after `neighbourId`. Views sharing a storageKey can render
 * different columns, so ids this view doesn't render keep their place in the saved order.
 */
function moveColumn(
  columnOrder: ColumnOrderState,
  columnIds: string[],
  id: string,
  neighbourId: string,
  placement: "before" | "after",
): ColumnOrderState {
  const listed = new Set(columnOrder);
  const order = [...columnOrder, ...columnIds.filter((columnId) => !listed.has(columnId))].filter(
    (columnId) => columnId !== id,
  );
  order.splice(order.indexOf(neighbourId) + (placement === "after" ? 1 : 0), 0, id);
  return order;
}

export function DataTableToolbar<TData>({
  table,
  searchBy,
  filters,
  viewControl,
  additionalFilters,
  showColumnToggle = false,
  enableColumnReordering = false,
  actions,
}: DataTableToolbarProps<TData>) {
  const { t } = useTranslation();
  const isFiltered = table.getState().columnFilters.length > 0 || table.getState().globalFilter;
  const columnIds = table.getAllLeafColumns().map((column) => column.id);
  const columnOrder = table.getState().columnOrder;
  // The first column names the row, so it stays put.
  const canMove = (id: string) => enableColumnReordering && id !== columnIds[0];
  // A column that can't be hidden is still listed so it can be moved, if it is shown and
  // labelled. That leaves out helper columns kept for searching and unlabelled ones such
  // as row actions, which stay where they are.
  const menuColumns = (
    enableColumnReordering
      ? displayOrder(columnIds, columnOrder)
          .map((id) => table.getColumn(id))
          .filter((column) => column !== undefined)
      : table.getAllColumns()
  ).filter(
    (column) =>
      column.getCanHide() ||
      (canMove(column.id) && column.getIsVisible() && !!(column.columnDef.meta as ColumnMeta | undefined)?.label),
  );
  const movableIds = menuColumns.filter((column) => canMove(column.id)).map((column) => column.id);
  const move = (id: string, neighbourId: string, placement: "before" | "after") =>
    table.setColumnOrder(moveColumn(columnOrder, columnIds, id, neighbourId, placement));

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {viewControl}
        {searchBy && (
          <SearchInput
            placeholder={t("ui:dataTable.search", "Search ...")}
            value={table.getState().globalFilter ?? ""}
            onChange={(value) => table.setGlobalFilter(value)}
            className="w-37.5 lg:w-62.5"
          />
        )}
        {filters?.map((filter) => (
          <DataTableFacetedFilter<TData, unknown>
            id={filter.id}
            key={filter.id}
            column={table.getColumn(filter.id)}
            title={filter.title}
            options={filter.options}
          />
        ))}
        {additionalFilters}
        {isFiltered && (
          <Button
            variant="ghost"
            onClick={() => {
              table.resetColumnFilters();
              table.resetGlobalFilter();
            }}
            className="h-8 px-2 lg:px-3"
          >
            {t("ui:dataTable.reset", "Reset")}
            <Icons.Close className="ms-2 h-4 w-4" />
          </Button>
        )}
      </div>
      <div className="flex items-center gap-2">
        {actions}
        {showColumnToggle && menuColumns.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  className="bg-secondary/30 hover:bg-muted/80 ms-auto gap-1.5 rounded-md border-[1.5px] border-none px-3 py-1 text-sm font-medium"
                />
              }
            >
              {t("ui:dataTable.columns", "Columns")} <Icons.ChevronDown className="ms-2 h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {menuColumns.map((column) => {
                const meta = column.columnDef.meta as ColumnMeta | undefined;
                const label = meta?.label ?? column.id;
                const checkbox = (
                  <DropdownMenuCheckboxItem
                    key={column.id}
                    className={cn("capitalize", enableColumnReordering && "flex-1")}
                    checked={column.getIsVisible()}
                    disabled={!column.getCanHide()}
                    onCheckedChange={(value) => column.toggleVisibility(!!value)}
                  >
                    {label}
                  </DropdownMenuCheckboxItem>
                );
                const index = movableIds.indexOf(column.id);
                if (index < 0) return checkbox;

                const previousId = movableIds[index - 1];
                const nextId = movableIds[index + 1];
                return (
                  <div key={column.id} className="flex items-center">
                    {checkbox}
                    <DropdownMenuItem
                      closeOnClick={false}
                      disabled={!previousId}
                      aria-label={t("ui:dataTable.moveColumnUp", { column: label, defaultValue: "Move {{column}} up" })}
                      onClick={() => previousId && move(column.id, previousId, "before")}
                      className="px-2"
                    >
                      <Icons.ArrowUp />
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      closeOnClick={false}
                      disabled={!nextId}
                      aria-label={t("ui:dataTable.moveColumnDown", {
                        column: label,
                        defaultValue: "Move {{column}} down",
                      })}
                      onClick={() => nextId && move(column.id, nextId, "after")}
                      className="px-2"
                    >
                      <Icons.ArrowDown />
                    </DropdownMenuItem>
                  </div>
                );
              })}
              {enableColumnReordering && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    closeOnClick={false}
                    disabled={columnOrder.length === 0}
                    onClick={() => table.setColumnOrder([])}
                  >
                    <Icons.RotateCcw />
                    {t("ui:dataTable.resetColumnOrder", "Reset column order")}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}

function SearchInput({
  value: initialValue,
  onChange,
  placeholder = "Search ...",
  className,
}: {
  value: string | number;
  onChange: (value: string | number) => void;
  placeholder?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    setValue(initialValue);
  }, [initialValue]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (isKeyboardEventComposing(e.nativeEvent)) return;

    if (e.key === "Enter") {
      onChange(value);
    }
  };

  const handleBlur = () => {
    onChange(value);
  };

  const handleClear = () => {
    setValue("");
    onChange("");
  };

  return (
    <div className={cn("relative", className)}>
      <Icons.Search className="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2" />
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        placeholder={placeholder}
        className={cn(
          "shadow-inner-xs bg-muted/90 hover:bg-muted/80 h-8 w-full rounded-md pe-8 ps-8 text-sm outline-none transition-colors",
          "placeholder:text-muted-foreground",
          "focus-visible:outline-solid focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2",
        )}
      />
      {value && (
        <button
          type="button"
          onClick={handleClear}
          className="text-muted-foreground hover:text-foreground absolute end-2 top-1/2 -translate-y-1/2"
        >
          <Icons.Close className="h-4 w-4" />
          <span className="sr-only">{t("ui:search.clear", "Clear search")}</span>
        </button>
      )}
    </div>
  );
}
