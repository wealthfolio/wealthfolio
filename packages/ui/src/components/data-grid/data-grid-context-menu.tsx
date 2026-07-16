"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Icons } from "../ui/icons";
import type { ColumnDef, TableMeta } from "@tanstack/react-table";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { ContextMenuState, UpdateCell } from "./data-grid-types";
import { parseCellKey } from "./data-grid-utils";

interface DataGridContextMenuProps<TData> {
  tableMeta: TableMeta<TData>;
  columns: ColumnDef<TData>[];
  contextMenu: ContextMenuState;
}

export function DataGridContextMenu<TData>({ tableMeta, columns, contextMenu }: DataGridContextMenuProps<TData>) {
  const onContextMenuOpenChange = tableMeta?.onContextMenuOpenChange;
  const selectionState = tableMeta?.selectionState;
  const dataGridRef = tableMeta?.dataGridRef;
  const onDataUpdate = tableMeta?.onDataUpdate;
  const onRowsDelete = tableMeta?.onRowsDelete;
  const onCellsCopy = tableMeta?.onCellsCopy;
  const onCellsCut = tableMeta?.onCellsCut;

  if (!contextMenu.open) return null;

  return (
    <ContextMenu
      tableMeta={tableMeta}
      columns={columns}
      dataGridRef={dataGridRef}
      contextMenu={contextMenu}
      onContextMenuOpenChange={onContextMenuOpenChange}
      selectionState={selectionState}
      onDataUpdate={onDataUpdate}
      onRowsDelete={onRowsDelete}
      onCellsCopy={onCellsCopy}
      onCellsCut={onCellsCut}
    />
  );
}

interface ContextMenuProps<TData>
  extends
    Pick<
      TableMeta<TData>,
      | "dataGridRef"
      | "onContextMenuOpenChange"
      | "selectionState"
      | "onDataUpdate"
      | "onRowsDelete"
      | "onCellsCopy"
      | "onCellsCut"
      | "readOnly"
    >,
    Required<Pick<TableMeta<TData>, "contextMenu">> {
  tableMeta: TableMeta<TData>;
  columns: ColumnDef<TData>[];
}

const ContextMenu = React.memo(ContextMenuImpl, (prev, next) => {
  if (prev.contextMenu.open !== next.contextMenu.open) return false;
  if (!next.contextMenu.open) return true;
  if (prev.contextMenu.x !== next.contextMenu.x) return false;
  if (prev.contextMenu.y !== next.contextMenu.y) return false;

  const prevSize = prev.selectionState?.selectedCells?.size ?? 0;
  const nextSize = next.selectionState?.selectedCells?.size ?? 0;
  if (prevSize !== nextSize) return false;

  return true;
}) as typeof ContextMenuImpl;

function ContextMenuImpl<TData>({
  tableMeta,
  columns,
  dataGridRef,
  contextMenu,
  onContextMenuOpenChange,
  selectionState,
  onDataUpdate,
  onRowsDelete,
  onCellsCopy,
  onCellsCut,
}: ContextMenuProps<TData>) {
  const { t } = useTranslation();
  const triggerStyle = React.useMemo<React.CSSProperties>(
    () => ({
      position: "fixed",
      left: `${contextMenu.x}px`,
      top: `${contextMenu.y}px`,
      width: "1px",
      height: "1px",
      padding: 0,
      margin: 0,
      border: "none",
      background: "transparent",
      pointerEvents: "none",
      opacity: 0,
    }),
    [contextMenu.x, contextMenu.y],
  );

  const onCloseAutoFocus: NonNullable<React.ComponentProps<typeof DropdownMenuContent>["onCloseAutoFocus"]> =
    React.useCallback(
      (event) => {
        event.preventDefault();
        dataGridRef?.current?.focus();
      },
      [dataGridRef],
    );

  const onCopy = React.useCallback(() => {
    onCellsCopy?.();
  }, [onCellsCopy]);

  const onCut = React.useCallback(() => {
    onCellsCut?.();
  }, [onCellsCut]);

  const onClear = React.useCallback(() => {
    if (!selectionState?.selectedCells || selectionState.selectedCells.size === 0) return;

    const updates: UpdateCell[] = [];

    for (const cellKey of selectionState.selectedCells) {
      const { rowIndex, columnId } = parseCellKey(cellKey);

      // Get column from columns array
      const column = columns.find((col) => {
        if (col.id) return col.id === columnId;
        if ("accessorKey" in col) return col.accessorKey === columnId;
        return false;
      });
      const cellVariant = column?.meta?.cell?.variant;

      let emptyValue: unknown = "";
      if (cellVariant === "multi-select" || cellVariant === "file") {
        emptyValue = [];
      } else if (cellVariant === "number" || cellVariant === "date") {
        emptyValue = null;
      } else if (cellVariant === "checkbox") {
        emptyValue = false;
      }

      updates.push({ rowIndex, columnId, value: emptyValue });
    }

    onDataUpdate?.(updates);

    toast.success(t("ui:dataGrid.cellsCleared", "{{count}} cell cleared", { count: updates.length }));
  }, [onDataUpdate, selectionState, columns, t]);

  const onDelete = React.useCallback(async () => {
    if (!selectionState?.selectedCells || selectionState.selectedCells.size === 0) return;

    const rowIndices = new Set<number>();
    for (const cellKey of selectionState.selectedCells) {
      const { rowIndex } = parseCellKey(cellKey);
      rowIndices.add(rowIndex);
    }

    const rowIndicesArray = Array.from(rowIndices).sort((a, b) => a - b);
    const rowCount = rowIndicesArray.length;

    await onRowsDelete?.(rowIndicesArray);

    toast.success(t("ui:dataGrid.rowsDeleted", "{{count}} row deleted", { count: rowCount }));
  }, [onRowsDelete, selectionState, t]);

  return (
    <DropdownMenu open={contextMenu.open} onOpenChange={onContextMenuOpenChange}>
      <DropdownMenuTrigger style={triggerStyle} />
      <DropdownMenuContent data-grid-popover="" align="start" className="w-48" onCloseAutoFocus={onCloseAutoFocus}>
        <DropdownMenuItem onSelect={onCopy}>
          <Icons.Copy />
          {t("ui:dataGrid.copy", "Copy")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onCut} disabled={tableMeta?.readOnly}>
          <Icons.Scissors />
          {t("ui:dataGrid.cut", "Cut")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onClear} disabled={tableMeta?.readOnly}>
          <Icons.Eraser />
          {t("ui:dataGrid.clear", "Clear")}
        </DropdownMenuItem>
        {onRowsDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Icons.Trash2 />
              {t("ui:dataGrid.deleteRows", "Delete rows")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
