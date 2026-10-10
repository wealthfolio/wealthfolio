"use client";

import * as React from "react";

import {
  CheckboxCell,
  CurrencyCell,
  DateCell,
  DateInputCell,
  DateTimeCell,
  FileCell,
  LongTextCell,
  MultiSelectCell,
  NumberCell,
  SelectCell,
  ShortTextCell,
  SymbolCell,
  UrlCell,
} from "./data-grid-cell-variants";
import type { DataGridCellProps } from "./data-grid-types";

function areDataGridCellPropsEqual<TData>(prev: DataGridCellProps<TData>, next: DataGridCellProps<TData>): boolean {
  // Fast path: check stable primitive props first
  if (prev.isFocused !== next.isFocused) return false;
  if (prev.isEditing !== next.isEditing) return false;
  if (prev.isSelected !== next.isSelected) return false;
  if (prev.isSearchMatch !== next.isSearchMatch) return false;
  if (prev.isActiveSearchMatch !== next.isActiveSearchMatch) return false;
  if (prev.readOnly !== next.readOnly) return false;
  if (prev.rowIndex !== next.rowIndex) return false;
  if (prev.columnId !== next.columnId) return false;
  if (prev.rowHeight !== next.rowHeight) return false;
  if (prev.cellState !== next.cellState) return false;

  // Check cell value using row.original instead of getValue() for stability
  // getValue() is unstable and recreates on every render, breaking memoization
  const prevValue = (prev.cell.row.original as Record<string, unknown>)[prev.columnId];
  const nextValue = (next.cell.row.original as Record<string, unknown>)[next.columnId];
  if (prevValue !== nextValue) {
    return false;
  }

  if (
    prev.cell.column.columnDef.meta?.isReadOnly?.(prev.cell.row.original) !==
    next.cell.column.columnDef.meta?.isReadOnly?.(next.cell.row.original)
  )
    return false;

  // Check cell/row identity
  if (prev.cell.row.id !== next.cell.row.id) return false;

  // Re-render when an explicitly tracked display dependency changes. The cell
  // value can stay the same while a visibility-dependent renderer changes.
  if (prev.cell.column.columnDef.meta?.renderKey !== next.cell.column.columnDef.meta?.renderKey) return false;

  // Some renderers depend on other fields from row.original. Compare only the
  // primitive dependency they opt into so unrelated row updates stay memoized.
  const prevRowRenderKey = prev.cell.column.columnDef.meta?.getRenderKey?.(prev.cell.row.original);
  const nextRowRenderKey = next.cell.column.columnDef.meta?.getRenderKey?.(next.cell.row.original);
  if (prevRowRenderKey !== nextRowRenderKey) return false;

  return true;
}

export const DataGridCell = React.memo(DataGridCellImpl, areDataGridCellPropsEqual) as typeof DataGridCellImpl;

function DataGridCellImpl<TData>({
  cell,
  tableMeta,
  rowIndex,
  columnId,
  isFocused,
  isEditing,
  isSelected,
  isSearchMatch,
  isActiveSearchMatch,
  readOnly,
  rowHeight,
  cellState,
}: DataGridCellProps<TData>) {
  readOnly = readOnly || (cell.column.columnDef.meta?.isReadOnly?.(cell.row.original) ?? false);
  isEditing = isEditing && !readOnly;
  const cellOpts = cell.column.columnDef.meta?.cell;
  const variant = cellOpts?.variant ?? "text";

  let Comp: React.ComponentType<DataGridCellProps<TData>>;

  switch (variant) {
    case "short-text":
      Comp = ShortTextCell;
      break;
    case "long-text":
      Comp = LongTextCell;
      break;
    case "number":
      Comp = NumberCell;
      break;
    case "url":
      Comp = UrlCell;
      break;
    case "checkbox":
      Comp = CheckboxCell;
      break;
    case "select":
      Comp = SelectCell;
      break;
    case "multi-select":
      Comp = MultiSelectCell;
      break;
    case "date":
      Comp = DateCell;
      break;
    case "date-input":
      Comp = DateInputCell;
      break;
    case "datetime":
      Comp = DateTimeCell;
      break;
    case "file":
      Comp = FileCell;
      break;
    case "symbol":
      Comp = SymbolCell;
      break;
    case "currency":
      Comp = CurrencyCell;
      break;

    default:
      Comp = ShortTextCell;
      break;
  }

  return (
    <Comp
      cell={cell}
      tableMeta={tableMeta}
      rowIndex={rowIndex}
      columnId={columnId}
      rowHeight={rowHeight}
      isEditing={isEditing}
      isFocused={isFocused}
      isSelected={isSelected}
      isSearchMatch={isSearchMatch}
      isActiveSearchMatch={isActiveSearchMatch}
      readOnly={readOnly}
      cellState={cellState}
    />
  );
}
