"use client";

import type { Header, SortDirection, Table } from "@tanstack/react-table";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Icons } from "../ui/icons";

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { cn } from "../../lib/utils";
import { getColumnVariant } from "./data-grid-utils";

interface DataGridColumnHeaderProps<TData, TValue> extends React.ComponentProps<typeof DropdownMenuTrigger> {
  header: Header<TData, TValue>;
  table: Table<TData>;
}

export function DataGridColumnHeader<TData, TValue>({
  header,
  table,
  className,
  onPointerDown,
  ...props
}: DataGridColumnHeaderProps<TData, TValue>) {
  const { t } = useTranslation();
  const column = header.column;
  const label = column.columnDef.meta?.label
    ? column.columnDef.meta.label
    : typeof column.columnDef.header === "string"
      ? column.columnDef.header
      : column.id;
  const helpText = column.columnDef.meta?.helpText;

  const isAnyColumnResizing = table.getState().columnSizingInfo.isResizingColumn;

  const cellVariant = column.columnDef.meta?.cell;
  const columnVariant = getColumnVariant(cellVariant?.variant);

  const pinnedPosition = column.getIsPinned();
  const isPinnedLeft = pinnedPosition === "left";
  const isPinnedRight = pinnedPosition === "right";

  const onSortingChange = React.useCallback(
    (direction: SortDirection) => {
      // Single-column sorting: replace entire array with just this column's sort
      table.setSorting([
        {
          id: column.id,
          desc: direction === "desc",
        },
      ]);
    },
    [column.id, table],
  );

  const onSortRemove = React.useCallback(() => {
    table.setSorting([]);
  }, [table]);

  const onLeftPin = React.useCallback(() => {
    column.pin("left");
  }, [column]);

  const onRightPin = React.useCallback(() => {
    column.pin("right");
  }, [column]);

  const onUnpin = React.useCallback(() => {
    column.pin(false);
  }, [column]);

  const onTriggerPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      onPointerDown?.(event);
      if (event.defaultPrevented) return;

      if (event.button !== 0) {
        return;
      }
      table.options.meta?.onColumnClick?.(column.id);
    },
    [table.options.meta, column.id, onPointerDown],
  );

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          className={cn(
            "hover:bg-accent/40 data-[state=open]:bg-accent/40 flex size-full items-center justify-between gap-2 p-2 text-sm [&_svg]:size-4",
            isAnyColumnResizing && "pointer-events-none",
            className,
          )}
          onPointerDown={onTriggerPointerDown}
          {...props}
        >
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {columnVariant && (
              <Tooltip delayDuration={100}>
                <TooltipTrigger asChild>
                  <columnVariant.icon className="text-muted-foreground size-3.5 shrink-0" />
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p>{t(columnVariant.labelKey, columnVariant.label)}</p>
                </TooltipContent>
              </Tooltip>
            )}
            <span className="truncate">{label}</span>
            {helpText && (
              <Tooltip delayDuration={100}>
                <TooltipTrigger asChild>
                  <Icons.Info className="text-muted-foreground/70 hover:text-foreground size-3.5 shrink-0" />
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs text-xs">
                  {helpText}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          <Icons.ChevronDown className="text-muted-foreground shrink-0" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={0} className="w-60">
          {column.getCanSort() && (
            <>
              <DropdownMenuCheckboxItem
                className="[&_svg]:text-muted-foreground relative ltr:pl-2 ltr:pr-8 rtl:pl-8 rtl:pr-2 [&>span:first-child]:ltr:left-auto [&>span:first-child]:ltr:right-2 [&>span:first-child]:rtl:left-2 [&>span:first-child]:rtl:right-auto"
                checked={column.getIsSorted() === "asc"}
                onClick={() => onSortingChange("asc")}
              >
                <Icons.ChevronUp />
                {t("ui:dataGrid.sortAsc", "Sort asc")}
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                className="[&_svg]:text-muted-foreground relative ltr:pl-2 ltr:pr-8 rtl:pl-8 rtl:pr-2 [&>span:first-child]:ltr:left-auto [&>span:first-child]:ltr:right-2 [&>span:first-child]:rtl:left-2 [&>span:first-child]:rtl:right-auto"
                checked={column.getIsSorted() === "desc"}
                onClick={() => onSortingChange("desc")}
              >
                <Icons.ChevronDown />
                {t("ui:dataGrid.sortDesc", "Sort desc")}
              </DropdownMenuCheckboxItem>
              {column.getIsSorted() && (
                <DropdownMenuItem onClick={onSortRemove}>
                  <Icons.X />
                  {t("ui:dataGrid.removeSort", "Remove sort")}
                </DropdownMenuItem>
              )}
            </>
          )}
          {column.getCanPin() && (
            <>
              {column.getCanSort() && <DropdownMenuSeparator />}

              {isPinnedLeft ? (
                <DropdownMenuItem className="[&_svg]:text-muted-foreground" onClick={onUnpin}>
                  <Icons.PinOff />
                  {t("ui:dataGrid.unpinFromLeft", "Unpin from left")}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem className="[&_svg]:text-muted-foreground" onClick={onLeftPin}>
                  <Icons.Pin />
                  {t("ui:dataGrid.pinToLeft", "Pin to left")}
                </DropdownMenuItem>
              )}
              {isPinnedRight ? (
                <DropdownMenuItem className="[&_svg]:text-muted-foreground" onClick={onUnpin}>
                  <Icons.PinOff />
                  {t("ui:dataGrid.unpinFromRight", "Unpin from right")}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem className="[&_svg]:text-muted-foreground" onClick={onRightPin}>
                  <Icons.Pin />
                  {t("ui:dataGrid.pinToRight", "Pin to right")}
                </DropdownMenuItem>
              )}
            </>
          )}
          {column.getCanHide() && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="[&_svg]:text-muted-foreground"
                onClick={() => column.toggleVisibility(false)}
              >
                <Icons.EyeOff />
                {t("ui:dataGrid.hideColumn", "Hide column")}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {header.column.getCanResize() && <DataGridColumnResizer header={header} table={table} label={label} />}
    </>
  );
}

const DataGridColumnResizer = React.memo(DataGridColumnResizerImpl, (prev, next) => {
  const prevColumn = prev.header.column;
  const nextColumn = next.header.column;

  if (prevColumn.getIsResizing() !== nextColumn.getIsResizing() || prevColumn.getSize() !== nextColumn.getSize()) {
    return false;
  }

  if (prev.label !== next.label) return false;

  return true;
}) as typeof DataGridColumnResizerImpl;

interface DataGridColumnResizerProps<TData, TValue> extends DataGridColumnHeaderProps<TData, TValue> {
  label: string;
}

function DataGridColumnResizerImpl<TData, TValue>({ header, table, label }: DataGridColumnResizerProps<TData, TValue>) {
  const { t } = useTranslation();
  const defaultColumnDef = table._getDefaultColumnDef();

  const onDoubleClick = React.useCallback(() => {
    header.column.resetSize();
  }, [header.column]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("ui:dataGrid.resizeColumn", "Resize {{label}} column", { label })}
      aria-valuenow={header.column.getSize()}
      aria-valuemin={defaultColumnDef.minSize}
      aria-valuemax={defaultColumnDef.maxSize}
      tabIndex={0}
      className={cn(
        "bg-border hover:bg-primary focus:bg-primary absolute -end-px top-0 z-50 h-full w-0.5 cursor-ew-resize touch-none select-none transition-opacity after:absolute after:inset-y-0 after:start-1/2 after:h-full after:w-[18px] after:-translate-x-1/2 after:content-[''] focus:outline-none",
        header.column.getIsResizing() ? "bg-primary" : "opacity-0 hover:opacity-100",
      )}
      onDoubleClick={onDoubleClick}
      onMouseDown={header.getResizeHandler()}
      onTouchStart={header.getResizeHandler()}
    />
  );
}
