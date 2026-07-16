"use client";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Calendar } from "../ui/calendar";
import { Checkbox } from "../ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "../ui/command";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { Textarea } from "../ui/textarea";
import { Icons } from "../ui/icons";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useBadgeOverflow } from "../../hooks/use-badge-overflow";
import { useDebouncedCallback } from "../../hooks/use-debounced-callback";
import { quoteCurrencies } from "../../lib/currencies";
import { generateId } from "../../lib/id";
import { cn } from "../../lib/utils";
import { DataGridCellWrapper } from "./data-grid-cell-wrapper";
import type { DataGridCellProps, FileCellData, SymbolSearchResult } from "./data-grid-types";
import { getCellKey, getLineCount } from "./data-grid-utils";

export function ShortTextCell<TData>({
  cell,
  tableMeta,
  rowIndex,
  columnId,
  rowHeight,
  isEditing,
  isFocused,
  isSelected,
  isSearchMatch,
  isActiveSearchMatch,
  readOnly,
  cellState,
}: DataGridCellProps<TData>) {
  const initialValue = cell.getValue() as string;
  const [value, setValue] = React.useState(initialValue);
  const cellRef = React.useRef<HTMLDivElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const prevInitialValueRef = React.useRef(initialValue);
  if (initialValue !== prevInitialValueRef.current) {
    prevInitialValueRef.current = initialValue;
    setValue(initialValue);
    if (cellRef.current && !isEditing) {
      cellRef.current.textContent = initialValue;
    }
  }

  const onBlur = React.useCallback(() => {
    // Read the current value directly from the DOM to avoid stale state
    const currentValue = cellRef.current?.textContent ?? "";
    if (!readOnly && currentValue !== initialValue) {
      tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: currentValue });
    }
    tableMeta?.onCellEditingStop?.();
  }, [tableMeta, rowIndex, columnId, initialValue, readOnly]);

  const onInput = React.useCallback((event: React.FormEvent<HTMLDivElement>) => {
    const currentValue = event.currentTarget.textContent ?? "";
    setValue(currentValue);
  }, []);

  const onWrapperKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (isEditing) {
        if (event.key === "Enter") {
          event.preventDefault();
          const currentValue = cellRef.current?.textContent ?? "";
          if (currentValue !== initialValue) {
            tableMeta?.onDataUpdate?.({
              rowIndex,
              columnId,
              value: currentValue,
            });
          }
          tableMeta?.onCellEditingStop?.({ moveToNextRow: true });
        } else if (event.key === "Tab") {
          event.preventDefault();
          const currentValue = cellRef.current?.textContent ?? "";
          if (currentValue !== initialValue) {
            tableMeta?.onDataUpdate?.({
              rowIndex,
              columnId,
              value: currentValue,
            });
          }
          tableMeta?.onCellEditingStop?.({
            direction: event.shiftKey ? "left" : "right",
          });
        } else if (event.key === "Escape") {
          event.preventDefault();
          setValue(initialValue);
          cellRef.current?.blur();
        }
      } else if (isFocused && event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
        // Handle typing to pre-fill the value when editing starts
        setValue(event.key);

        queueMicrotask(() => {
          if (cellRef.current?.contentEditable === "true") {
            cellRef.current.textContent = event.key;
            const range = document.createRange();
            const selection = window.getSelection();
            range.selectNodeContents(cellRef.current);
            range.collapse(false);
            selection?.removeAllRanges();
            selection?.addRange(range);
          }
        });
      }
    },
    [isEditing, isFocused, initialValue, tableMeta, rowIndex, columnId],
  );

  React.useEffect(() => {
    if (isEditing && cellRef.current) {
      cellRef.current.focus();

      if (!cellRef.current.textContent && value) {
        cellRef.current.textContent = value;
      }

      if (cellRef.current.textContent) {
        const range = document.createRange();
        const selection = window.getSelection();
        range.selectNodeContents(cellRef.current);
        range.collapse(false);
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
  }, [isEditing, value]);

  const displayValue = !isEditing ? (value ?? "") : "";

  return (
    <DataGridCellWrapper<TData>
      ref={containerRef}
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
      onKeyDown={onWrapperKeyDown}
    >
      <div
        role="textbox"
        data-slot="grid-cell-content"
        contentEditable={isEditing}
        tabIndex={-1}
        ref={cellRef}
        onBlur={onBlur}
        onInput={onInput}
        suppressContentEditableWarning
        className={cn("size-full overflow-hidden outline-none", {
          "**:inline **:whitespace-nowrap whitespace-nowrap [&_br]:hidden": isEditing,
        })}
      >
        {displayValue}
      </div>
    </DataGridCellWrapper>
  );
}

export function LongTextCell<TData>({
  cell,
  tableMeta,
  rowIndex,
  columnId,
  rowHeight,
  isFocused,
  isEditing,
  isSelected,
  isSearchMatch,
  isActiveSearchMatch,
  readOnly,
  cellState,
}: DataGridCellProps<TData>) {
  const { t } = useTranslation();
  const initialValue = cell.getValue() as string;
  const [value, setValue] = React.useState(initialValue ?? "");
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const sideOffset = -(containerRef.current?.clientHeight ?? 0);

  const prevInitialValueRef = React.useRef(initialValue);
  if (initialValue !== prevInitialValueRef.current) {
    prevInitialValueRef.current = initialValue;
    setValue(initialValue ?? "");
  }

  // Debounced auto-save (300ms delay)
  const debouncedSave = useDebouncedCallback((newValue: string) => {
    if (!readOnly) {
      tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: newValue });
    }
  }, 300);

  const onSave = React.useCallback(() => {
    // Immediately save any pending changes and close the popover
    if (!readOnly && value !== initialValue) {
      tableMeta?.onDataUpdate?.({ rowIndex, columnId, value });
    }
    tableMeta?.onCellEditingStop?.();
  }, [tableMeta, value, initialValue, rowIndex, columnId, readOnly]);

  const onCancel = React.useCallback(() => {
    // Restore the original value
    setValue(initialValue ?? "");
    if (!readOnly) {
      tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: initialValue });
    }
    tableMeta?.onCellEditingStop?.();
  }, [tableMeta, initialValue, rowIndex, columnId, readOnly]);

  const onOpenChange = React.useCallback(
    (isOpen: boolean) => {
      if (isOpen && !readOnly) {
        tableMeta?.onCellEditingStart?.(rowIndex, columnId);
      } else {
        // Immediately save any pending changes when closing
        if (!readOnly && value !== initialValue) {
          tableMeta?.onDataUpdate?.({ rowIndex, columnId, value });
        }
        tableMeta?.onCellEditingStop?.();
      }
    },
    [tableMeta, value, initialValue, rowIndex, columnId, readOnly],
  );

  const onOpenAutoFocus: NonNullable<React.ComponentProps<typeof PopoverContent>["onOpenAutoFocus"]> =
    React.useCallback((event) => {
      event.preventDefault();
      if (textareaRef.current) {
        textareaRef.current.focus();
        const length = textareaRef.current.value.length;
        textareaRef.current.setSelectionRange(length, length);
      }
    }, []);

  const onBlur = React.useCallback(() => {
    // Immediately save any pending changes on blur
    if (!readOnly && value !== initialValue) {
      tableMeta?.onDataUpdate?.({ rowIndex, columnId, value });
    }
    tableMeta?.onCellEditingStop?.();
  }, [tableMeta, value, initialValue, rowIndex, columnId, readOnly]);

  const onChange = React.useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = event.target.value;
      setValue(newValue);
      // Debounced auto-save
      debouncedSave(newValue);
    },
    [debouncedSave],
  );

  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        onSave();
      } else if (event.key === "Tab") {
        event.preventDefault();
        // Save any pending changes
        if (value !== initialValue) {
          tableMeta?.onDataUpdate?.({ rowIndex, columnId, value });
        }
        tableMeta?.onCellEditingStop?.({
          direction: event.shiftKey ? "left" : "right",
        });
        return;
      }
      // Stop propagation to prevent grid navigation
      event.stopPropagation();
    },
    [onSave, onCancel, value, initialValue, tableMeta, rowIndex, columnId],
  );

  return (
    <Popover open={isEditing} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <DataGridCellWrapper<TData>
          ref={containerRef}
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
        >
          <span data-slot="grid-cell-content">{value}</span>
        </DataGridCellWrapper>
      </PopoverAnchor>
      <PopoverContent
        data-grid-cell-editor=""
        align="start"
        side="bottom"
        sideOffset={sideOffset}
        className="w-[400px] rounded-none p-0"
        onOpenAutoFocus={onOpenAutoFocus}
      >
        <Textarea
          placeholder={t("ui:dataGrid.enterText", "Enter text...")}
          className="max-h-[300px] min-h-[150px] resize-none overflow-y-auto rounded-none border-0 shadow-none focus-visible:ring-0"
          ref={textareaRef}
          value={value}
          onBlur={onBlur}
          onChange={onChange}
          onKeyDown={onKeyDown}
        />
      </PopoverContent>
    </Popover>
  );
}

export function NumberCell<TData>({
  cell,
  tableMeta,
  rowIndex,
  columnId,
  rowHeight,
  isFocused,
  isEditing,
  isSelected,
  isSearchMatch,
  isActiveSearchMatch,
  readOnly,
  cellState,
}: DataGridCellProps<TData>) {
  const initialValue = cell.getValue() as number | string | null;
  const [value, setValue] = React.useState(String(initialValue ?? ""));
  const inputRef = React.useRef<HTMLInputElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const cellOpts = cell.column.columnDef.meta?.cell;
  const numberCellOpts = cellOpts?.variant === "number" ? cellOpts : null;
  const min = numberCellOpts?.min;
  const max = numberCellOpts?.max;
  const step = numberCellOpts?.step;
  const valueType = numberCellOpts?.valueType ?? "number";
  const valueRenderer = numberCellOpts?.valueRenderer;

  const prevInitialValueRef = React.useRef(initialValue);
  if (initialValue !== prevInitialValueRef.current) {
    prevInitialValueRef.current = initialValue;
    setValue(String(initialValue ?? ""));
  }

  const onBlur = React.useCallback(() => {
    const trimmed = value.trim();
    const nextValue =
      trimmed === ""
        ? null
        : valueType === "number"
          ? Number.isFinite(Number(trimmed))
            ? Number(trimmed)
            : null
          : trimmed;
    const initialComparable =
      valueType === "number"
        ? initialValue == null || initialValue === ""
          ? null
          : Number(initialValue)
        : initialValue == null
          ? null
          : String(initialValue);
    if (!readOnly && nextValue !== initialComparable) {
      tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: nextValue });
    }
    tableMeta?.onCellEditingStop?.();
  }, [tableMeta, rowIndex, columnId, initialValue, value, readOnly, valueType]);

  const onChange = React.useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setValue(event.target.value);
  }, []);

  const onWrapperKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (isEditing) {
        if (event.key === "Enter") {
          event.preventDefault();
          const trimmed = value.trim();
          const nextValue =
            trimmed === ""
              ? null
              : valueType === "number"
                ? Number.isFinite(Number(trimmed))
                  ? Number(trimmed)
                  : null
                : trimmed;
          const initialComparable =
            valueType === "number"
              ? initialValue == null || initialValue === ""
                ? null
                : Number(initialValue)
              : initialValue == null
                ? null
                : String(initialValue);
          if (nextValue !== initialComparable) {
            tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: nextValue });
          }
          tableMeta?.onCellEditingStop?.({ moveToNextRow: true });
        } else if (event.key === "Tab") {
          event.preventDefault();
          const trimmed = value.trim();
          const nextValue =
            trimmed === ""
              ? null
              : valueType === "number"
                ? Number.isFinite(Number(trimmed))
                  ? Number(trimmed)
                  : null
                : trimmed;
          const initialComparable =
            valueType === "number"
              ? initialValue == null || initialValue === ""
                ? null
                : Number(initialValue)
              : initialValue == null
                ? null
                : String(initialValue);
          if (nextValue !== initialComparable) {
            tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: nextValue });
          }
          tableMeta?.onCellEditingStop?.({
            direction: event.shiftKey ? "left" : "right",
          });
        } else if (event.key === "Escape") {
          event.preventDefault();
          setValue(String(initialValue ?? ""));
          inputRef.current?.blur();
        }
      } else if (isFocused) {
        // Handle Backspace to start editing with empty value
        if (event.key === "Backspace") {
          setValue("");
          startedByTypingRef.current = true;
        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
          // Handle typing to pre-fill the value when editing starts
          setValue(event.key);
          startedByTypingRef.current = true;
        }
      }
    },
    [isEditing, isFocused, initialValue, tableMeta, rowIndex, columnId, value, valueType],
  );

  // Track if editing was started by typing (vs double-click/Enter)
  const startedByTypingRef = React.useRef(false);

  // Track previous editing state to detect when editing stops
  const wasEditingRef = React.useRef(isEditing);
  const valueRef = React.useRef(value);
  valueRef.current = value;

  React.useEffect(() => {
    // When editing stops (transitions from true to false), save the value
    if (wasEditingRef.current && !isEditing) {
      const currentValue = valueRef.current;
      const trimmed = currentValue.trim();
      const nextValue =
        trimmed === ""
          ? null
          : valueType === "number"
            ? Number.isFinite(Number(trimmed))
              ? Number(trimmed)
              : null
            : trimmed;
      const initialComparable =
        valueType === "number"
          ? initialValue == null || initialValue === ""
            ? null
            : Number(initialValue)
          : initialValue == null
            ? null
            : String(initialValue);
      if (!readOnly && nextValue !== initialComparable) {
        tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: nextValue });
      }
      startedByTypingRef.current = false;
    }
    wasEditingRef.current = isEditing;
  }, [isEditing, initialValue, readOnly, tableMeta, rowIndex, columnId, valueType]);

  React.useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      // Only select all if editing was NOT started by typing
      // Note: input type="number" doesn't support select() in all browsers,
      // but focus() is enough when started by typing
      if (!startedByTypingRef.current) {
        try {
          inputRef.current.select();
        } catch {
          // Safari and some browsers don't support select() on number inputs
        }
      }
    }
  }, [isEditing]);

  return (
    <DataGridCellWrapper<TData>
      ref={containerRef}
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
      onKeyDown={onWrapperKeyDown}
      className="text-end"
    >
      {isEditing ? (
        <input
          ref={inputRef}
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onBlur={onBlur}
          onChange={onChange}
          className="w-full border-none bg-transparent p-0 text-end outline-none"
        />
      ) : (
        <span data-slot="grid-cell-content">
          {valueRenderer ? valueRenderer(initialValue, cell.row.original) : value}
        </span>
      )}
    </DataGridCellWrapper>
  );
}

function getUrlHref(urlString: string): string {
  if (!urlString || urlString.trim() === "") return "";

  const trimmed = urlString.trim();

  // Reject dangerous protocols (extra safety, though our http:// prefix would neutralize them)
  if (/^(javascript|data|vbscript|file):/i.test(trimmed)) {
    return "";
  }

  // Check if it already has a protocol
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }

  // Add http:// prefix for links without protocol
  return `http://${trimmed}`;
}

export function UrlCell<TData>({
  cell,
  tableMeta,
  rowIndex,
  columnId,
  rowHeight,
  isEditing,
  isFocused,
  isSelected,
  isSearchMatch,
  isActiveSearchMatch,
  readOnly,
  cellState,
}: DataGridCellProps<TData>) {
  const { t } = useTranslation();
  const initialValue = cell.getValue() as string;
  const [value, setValue] = React.useState(initialValue ?? "");
  const cellRef = React.useRef<HTMLDivElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const prevInitialValueRef = React.useRef(initialValue);
  if (initialValue !== prevInitialValueRef.current) {
    prevInitialValueRef.current = initialValue;
    setValue(initialValue ?? "");
    if (cellRef.current && !isEditing) {
      cellRef.current.textContent = initialValue ?? "";
    }
  }

  const onBlur = React.useCallback(() => {
    const currentValue = cellRef.current?.textContent?.trim() ?? "";

    if (!readOnly && currentValue !== initialValue) {
      tableMeta?.onDataUpdate?.({
        rowIndex,
        columnId,
        value: currentValue || null,
      });
    }
    tableMeta?.onCellEditingStop?.();
  }, [tableMeta, rowIndex, columnId, initialValue, readOnly]);

  const onInput = React.useCallback((event: React.FormEvent<HTMLDivElement>) => {
    const currentValue = event.currentTarget.textContent ?? "";
    setValue(currentValue);
  }, []);

  const onWrapperKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (isEditing) {
        if (event.key === "Enter") {
          event.preventDefault();
          const currentValue = cellRef.current?.textContent?.trim() ?? "";
          if (!readOnly && currentValue !== initialValue) {
            tableMeta?.onDataUpdate?.({
              rowIndex,
              columnId,
              value: currentValue || null,
            });
          }
          tableMeta?.onCellEditingStop?.({ moveToNextRow: true });
        } else if (event.key === "Tab") {
          event.preventDefault();
          const currentValue = cellRef.current?.textContent?.trim() ?? "";
          if (!readOnly && currentValue !== initialValue) {
            tableMeta?.onDataUpdate?.({
              rowIndex,
              columnId,
              value: currentValue || null,
            });
          }
          tableMeta?.onCellEditingStop?.({
            direction: event.shiftKey ? "left" : "right",
          });
        } else if (event.key === "Escape") {
          event.preventDefault();
          setValue(initialValue ?? "");
          cellRef.current?.blur();
        }
      } else if (isFocused && !readOnly && event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
        // Handle typing to pre-fill the value when editing starts
        setValue(event.key);

        queueMicrotask(() => {
          if (cellRef.current?.contentEditable === "true") {
            cellRef.current.textContent = event.key;
            const range = document.createRange();
            const selection = window.getSelection();
            range.selectNodeContents(cellRef.current);
            range.collapse(false);
            selection?.removeAllRanges();
            selection?.addRange(range);
          }
        });
      }
    },
    [isEditing, isFocused, initialValue, tableMeta, rowIndex, columnId, readOnly],
  );

  const onLinkClick = React.useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (isEditing) {
        event.preventDefault();
        return;
      }

      // Check if URL was rejected due to dangerous protocol
      const href = getUrlHref(value);
      if (!href) {
        event.preventDefault();
        toast.error(t("ui:dataGrid.invalidUrl", "Invalid URL"), {
          description: t(
            "ui:dataGrid.invalidUrlDescription",
            "URL contains a dangerous protocol (javascript:, data:, vbscript:, or file:)",
          ),
        });
        return;
      }

      // Stop propagation to prevent grid from interfering with link navigation
      event.stopPropagation();
    },
    [isEditing, value, t],
  );

  React.useEffect(() => {
    if (isEditing && cellRef.current) {
      cellRef.current.focus();

      if (!cellRef.current.textContent && value) {
        cellRef.current.textContent = value;
      }

      if (cellRef.current.textContent) {
        const range = document.createRange();
        const selection = window.getSelection();
        range.selectNodeContents(cellRef.current);
        range.collapse(false);
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
  }, [isEditing, value]);

  const displayValue = !isEditing ? (value ?? "") : "";
  const urlHref = displayValue ? getUrlHref(displayValue) : "";
  const isDangerousUrl = displayValue && !urlHref;

  return (
    <DataGridCellWrapper<TData>
      ref={containerRef}
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
      onKeyDown={onWrapperKeyDown}
    >
      {!isEditing && displayValue ? (
        <div data-slot="grid-cell-content" className="size-full overflow-hidden">
          <a
            data-focused={isFocused && !isDangerousUrl ? "" : undefined}
            data-invalid={isDangerousUrl ? "" : undefined}
            href={urlHref}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary decoration-primary/30 hover:decoration-primary/60 data-focused:text-foreground data-invalid:text-destructive data-focused:decoration-foreground/50 data-invalid:decoration-destructive/50 data-focused:hover:decoration-foreground/70 data-invalid:hover:decoration-destructive/70 data-invalid:cursor-not-allowed truncate underline underline-offset-2"
            onClick={onLinkClick}
          >
            {displayValue}
          </a>
        </div>
      ) : (
        <div
          role="textbox"
          data-slot="grid-cell-content"
          contentEditable={isEditing}
          tabIndex={-1}
          ref={cellRef}
          onBlur={onBlur}
          onInput={onInput}
          suppressContentEditableWarning
          className={cn("size-full overflow-hidden outline-none", {
            "**:inline **:whitespace-nowrap whitespace-nowrap [&_br]:hidden": isEditing,
          })}
        >
          {displayValue}
        </div>
      )}
    </DataGridCellWrapper>
  );
}

export function CheckboxCell<TData>({
  cell,
  tableMeta,
  rowIndex,
  columnId,
  rowHeight,
  isFocused,
  isSelected,
  isSearchMatch,
  isActiveSearchMatch,
  readOnly,
  cellState,
}: Omit<DataGridCellProps<TData>, "isEditing">) {
  const initialValue = cell.getValue() as boolean;
  const [value, setValue] = React.useState(Boolean(initialValue));
  const containerRef = React.useRef<HTMLDivElement>(null);

  // Get isDisabled function from cell meta options
  const cellOpts = cell.column.columnDef.meta?.cell;
  const isDisabledFn = cellOpts?.variant === "checkbox" ? cellOpts.isDisabled : undefined;
  const isDisabled = isDisabledFn ? isDisabledFn(cell.row.original) : false;
  const effectiveReadOnly = readOnly || isDisabled;

  const prevInitialValueRef = React.useRef(initialValue);
  if (initialValue !== prevInitialValueRef.current) {
    prevInitialValueRef.current = initialValue;
    setValue(Boolean(initialValue));
  }

  const onCheckedChange = React.useCallback(
    (checked: boolean) => {
      if (effectiveReadOnly) return;
      setValue(checked);
      tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: checked });
    },
    [tableMeta, rowIndex, columnId, effectiveReadOnly],
  );

  const onWrapperKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (isFocused && !effectiveReadOnly && (event.key === " " || event.key === "Enter")) {
        event.preventDefault();
        event.stopPropagation();
        onCheckedChange(!value);
      } else if (isFocused && event.key === "Tab") {
        event.preventDefault();
        tableMeta?.onCellEditingStop?.({
          direction: event.shiftKey ? "left" : "right",
        });
      }
    },
    [isFocused, value, onCheckedChange, tableMeta, effectiveReadOnly],
  );

  const onWrapperClick = React.useCallback(
    (event: React.MouseEvent) => {
      if (isFocused && !effectiveReadOnly) {
        event.preventDefault();
        event.stopPropagation();
        onCheckedChange(!value);
      }
    },
    [isFocused, value, onCheckedChange, effectiveReadOnly],
  );

  const onCheckboxClick = React.useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
  }, []);

  const onCheckboxMouseDown = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  }, []);

  const onCheckboxDoubleClick = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  }, []);

  return (
    <DataGridCellWrapper<TData>
      ref={containerRef}
      cell={cell}
      tableMeta={tableMeta}
      rowIndex={rowIndex}
      columnId={columnId}
      rowHeight={rowHeight}
      isEditing={false}
      isFocused={isFocused}
      isSelected={isSelected}
      isSearchMatch={isSearchMatch}
      isActiveSearchMatch={isActiveSearchMatch}
      readOnly={readOnly}
      cellState={cellState}
      className="flex size-full justify-center"
      onClick={onWrapperClick}
      onKeyDown={onWrapperKeyDown}
    >
      <Checkbox
        checked={value}
        onCheckedChange={onCheckedChange}
        disabled={effectiveReadOnly}
        className="border-primary"
        onClick={onCheckboxClick}
        onMouseDown={onCheckboxMouseDown}
        onDoubleClick={onCheckboxDoubleClick}
      />
    </DataGridCellWrapper>
  );
}

// Special value for empty selection (Radix Select requires non-empty string values)
const EMPTY_SELECT_VALUE = "__EMPTY__";

export function SelectCell<TData>({
  cell,
  tableMeta,
  rowIndex,
  columnId,
  rowHeight,
  isFocused,
  isEditing,
  isSelected,
  isSearchMatch,
  isActiveSearchMatch,
  readOnly,
  cellState,
}: DataGridCellProps<TData>) {
  const { t } = useTranslation();
  const initialValue = cell.getValue() as string;
  const [value, setValue] = React.useState(initialValue || "");
  const containerRef = React.useRef<HTMLDivElement>(null);
  const cellOpts = cell.column.columnDef.meta?.cell;

  // Get options - support both static array and dynamic function
  const rawOptions = cellOpts?.variant === "select" ? cellOpts.options : [];
  const options = React.useMemo(() => {
    if (typeof rawOptions === "function") {
      return rawOptions(cell.row.original);
    }
    return rawOptions;
  }, [rawOptions, cell.row.original]);

  const valueRenderer = cellOpts?.variant === "select" ? cellOpts.valueRenderer : undefined;
  const allowEmpty = cellOpts?.variant === "select" ? cellOpts.allowEmpty : false;
  const noneLabel = t("ui:dataGrid.none", "None");
  const emptyLabel = cellOpts?.variant === "select" ? (cellOpts.emptyLabel ?? noneLabel) : noneLabel;

  const prevInitialValueRef = React.useRef(initialValue);
  if (initialValue !== prevInitialValueRef.current) {
    prevInitialValueRef.current = initialValue;
    setValue(initialValue || "");
  }

  const onValueChange = React.useCallback(
    (newValue: string) => {
      if (readOnly) return;
      // Convert empty placeholder back to empty string
      const actualValue = newValue === EMPTY_SELECT_VALUE ? "" : newValue;
      setValue(actualValue);
      tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: actualValue || undefined });
      tableMeta?.onCellEditingStop?.();
    },
    [tableMeta, rowIndex, columnId, readOnly],
  );

  const onOpenChange = React.useCallback(
    (isOpen: boolean) => {
      if (isOpen && !readOnly) {
        tableMeta?.onCellEditingStart?.(rowIndex, columnId);
      } else {
        tableMeta?.onCellEditingStop?.();
      }
    },
    [tableMeta, rowIndex, columnId, readOnly],
  );

  const onWrapperKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (isEditing && event.key === "Escape") {
        event.preventDefault();
        setValue(initialValue || "");
        tableMeta?.onCellEditingStop?.();
      } else if (!isEditing && isFocused && event.key === "Tab") {
        event.preventDefault();
        tableMeta?.onCellEditingStop?.({
          direction: event.shiftKey ? "left" : "right",
        });
      }
    },
    [isEditing, isFocused, initialValue, tableMeta],
  );

  const selectedOption = options.find((opt) => opt.value === value);
  const displayLabel = selectedOption?.label ?? value;

  // Render the display content - use valueRenderer if provided, otherwise default Badge
  const renderDisplayContent = () => {
    if (!displayLabel) return null;

    if (valueRenderer) {
      // Don't wrap in data-slot="grid-cell-content" - let valueRenderer control its own styling
      // This prevents line-clamp from truncating badges/custom renderers
      return valueRenderer(value, selectedOption, cell.row.original);
    }

    return (
      <Badge data-slot="grid-cell-content" variant="secondary" className="whitespace-pre-wrap px-1.5 text-xs">
        {displayLabel}
      </Badge>
    );
  };

  // Use placeholder value for Radix Select when value is empty
  const selectValue = value || (allowEmpty ? EMPTY_SELECT_VALUE : "");

  return (
    <DataGridCellWrapper<TData>
      ref={containerRef}
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
      onKeyDown={onWrapperKeyDown}
    >
      {isEditing ? (
        <Select value={selectValue} onValueChange={onValueChange} open={isEditing} onOpenChange={onOpenChange}>
          <SelectTrigger className="size-full h-auto items-start border-none p-0 shadow-none focus-visible:ring-0 dark:bg-transparent [&_svg]:hidden">
            {displayLabel ? (
              <Badge variant="secondary" className="whitespace-pre-wrap px-1.5 text-xs">
                <SelectValue />
              </Badge>
            ) : (
              <span className="text-muted-foreground text-xs">{emptyLabel}</span>
            )}
          </SelectTrigger>
          <SelectContent
            data-grid-cell-editor=""
            // compensate for the wrapper padding
            align="start"
            alignOffset={-8}
            sideOffset={-8}
            className="min-w-[calc(var(--radix-select-trigger-width)+16px)]"
          >
            {allowEmpty && (
              <SelectItem value={EMPTY_SELECT_VALUE} className="text-muted-foreground">
                {emptyLabel}
              </SelectItem>
            )}
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        renderDisplayContent()
      )}
    </DataGridCellWrapper>
  );
}

export function MultiSelectCell<TData>({
  cell,
  tableMeta,
  rowIndex,
  columnId,
  rowHeight,
  isFocused,
  isEditing,
  isSelected,
  isSearchMatch,
  isActiveSearchMatch,
  readOnly,
  cellState,
}: DataGridCellProps<TData>) {
  const { t } = useTranslation();
  const cellValue = React.useMemo(() => {
    const value = cell.getValue() as string[];
    return value ?? [];
  }, [cell]);

  const cellKey = getCellKey(rowIndex, columnId);
  const prevCellKeyRef = React.useRef(cellKey);

  const [selectedValues, setSelectedValues] = React.useState<string[]>(cellValue);
  const [searchValue, setSearchValue] = React.useState("");
  const containerRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const cellOpts = cell.column.columnDef.meta?.cell;
  const options = cellOpts?.variant === "multi-select" ? cellOpts.options : [];
  const sideOffset = -(containerRef.current?.clientHeight ?? 0);

  const prevCellValueRef = React.useRef(cellValue);
  if (cellValue !== prevCellValueRef.current) {
    prevCellValueRef.current = cellValue;
    setSelectedValues(cellValue);
  }

  if (prevCellKeyRef.current !== cellKey) {
    prevCellKeyRef.current = cellKey;
    setSearchValue("");
  }

  const onValueChange = React.useCallback(
    (value: string) => {
      if (readOnly) return;
      const newValues = selectedValues.includes(value)
        ? selectedValues.filter((v) => v !== value)
        : [...selectedValues, value];

      setSelectedValues(newValues);
      tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: newValues });
      setSearchValue("");
      queueMicrotask(() => inputRef.current?.focus());
    },
    [selectedValues, tableMeta, rowIndex, columnId, readOnly],
  );

  const removeValue = React.useCallback(
    (valueToRemove: string, event?: React.MouseEvent) => {
      if (readOnly) return;
      event?.stopPropagation();
      event?.preventDefault();
      const newValues = selectedValues.filter((v) => v !== valueToRemove);
      setSelectedValues(newValues);
      tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: newValues });
      // Focus back on input after removing
      setTimeout(() => inputRef.current?.focus(), 0);
    },
    [selectedValues, tableMeta, rowIndex, columnId, readOnly],
  );

  const clearAll = React.useCallback(() => {
    if (readOnly) return;
    setSelectedValues([]);
    tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: [] });
    queueMicrotask(() => inputRef.current?.focus());
  }, [tableMeta, rowIndex, columnId, readOnly]);

  const onOpenChange = React.useCallback(
    (isOpen: boolean) => {
      if (isOpen && !readOnly) {
        tableMeta?.onCellEditingStart?.(rowIndex, columnId);
      } else {
        setSearchValue("");
        tableMeta?.onCellEditingStop?.();
      }
    },
    [tableMeta, rowIndex, columnId, readOnly],
  );

  const onOpenAutoFocus: NonNullable<React.ComponentProps<typeof PopoverContent>["onOpenAutoFocus"]> =
    React.useCallback((event) => {
      event.preventDefault();
      inputRef.current?.focus();
    }, []);

  const onWrapperKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (isEditing && event.key === "Escape") {
        event.preventDefault();
        setSelectedValues(cellValue);
        setSearchValue("");
        tableMeta?.onCellEditingStop?.();
      } else if (!isEditing && isFocused && event.key === "Tab") {
        event.preventDefault();
        setSearchValue("");
        tableMeta?.onCellEditingStop?.({
          direction: event.shiftKey ? "left" : "right",
        });
      }
    },
    [isEditing, isFocused, cellValue, tableMeta],
  );

  const onInputKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      // Handle backspace when input is empty - remove last selected item
      if (event.key === "Backspace" && searchValue === "" && selectedValues.length > 0) {
        event.preventDefault();
        const lastValue = selectedValues[selectedValues.length - 1];
        if (lastValue) {
          removeValue(lastValue);
        }
      }
      // Prevent escape from propagating to close the popover immediately
      // Let the command handle it first
      if (event.key === "Escape") {
        event.stopPropagation();
      }
    },
    [searchValue, selectedValues, removeValue],
  );

  const displayLabels = selectedValues
    .map((val) => options.find((opt) => opt.value === val)?.label ?? val)
    .filter(Boolean);

  const lineCount = getLineCount(rowHeight);

  const { visibleItems: visibleLabels, hiddenCount: hiddenBadgeCount } = useBadgeOverflow({
    items: displayLabels,
    getLabel: (label) => label,
    containerRef,
    lineCount,
  });

  return (
    <DataGridCellWrapper<TData>
      ref={containerRef}
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
      onKeyDown={onWrapperKeyDown}
    >
      {isEditing ? (
        <Popover open={isEditing} onOpenChange={onOpenChange}>
          <PopoverAnchor asChild>
            <div className="absolute inset-0" />
          </PopoverAnchor>
          <PopoverContent
            data-grid-cell-editor=""
            align="start"
            sideOffset={sideOffset}
            className="w-[300px] rounded-none p-0"
            onOpenAutoFocus={onOpenAutoFocus}
          >
            <Command className="**:data-[slot=command-input-wrapper]:h-auto **:data-[slot=command-input-wrapper]:border-none **:data-[slot=command-input-wrapper]:p-0 [&_[data-slot=command-input-wrapper]_svg]:hidden">
              <div className="flex min-h-9 flex-wrap items-center gap-1 border-b px-3 py-1.5">
                {selectedValues.map((value) => {
                  const option = options.find((opt) => opt.value === value);
                  const label = option?.label ?? value;

                  return (
                    <Badge key={value} variant="secondary" className="gap-1 px-1.5 text-xs">
                      {label}
                      <button
                        type="button"
                        onClick={(event) => removeValue(value, event)}
                        onPointerDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                      >
                        <Icons.X className="size-3" />
                      </button>
                    </Badge>
                  );
                })}
                <CommandInput
                  ref={inputRef}
                  value={searchValue}
                  onValueChange={setSearchValue}
                  onKeyDown={onInputKeyDown}
                  placeholder={t("ui:dataGrid.search", "Search...")}
                  className="h-auto flex-1 p-0"
                />
              </div>
              <CommandList className="max-h-full">
                <CommandEmpty>{t("ui:dataGrid.noOptionsFound", "No options found.")}</CommandEmpty>
                <CommandGroup className="max-h-[300px] scroll-py-1 overflow-y-auto overflow-x-hidden">
                  {options.map((option) => {
                    const isSelected = selectedValues.includes(option.value);

                    return (
                      <CommandItem key={option.value} value={option.label} onSelect={() => onValueChange(option.value)}>
                        <div
                          className={cn(
                            "border-primary flex size-4 items-center justify-center rounded-sm border",
                            isSelected ? "bg-primary text-primary-foreground" : "opacity-50 [&_svg]:invisible",
                          )}
                        >
                          <Icons.Check className="size-3" />
                        </div>
                        <span>{option.label}</span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
                {selectedValues.length > 0 && (
                  <>
                    <CommandSeparator />
                    <CommandGroup>
                      <CommandItem onSelect={clearAll} className="text-muted-foreground justify-center">
                        {t("ui:dataGrid.clearAll", "Clear all")}
                      </CommandItem>
                    </CommandGroup>
                  </>
                )}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      ) : null}
      {displayLabels.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1 overflow-hidden">
          {visibleLabels.map((label, index) => (
            <Badge key={selectedValues[index]} variant="secondary" className="shrink-0 px-1.5 text-xs">
              {label}
            </Badge>
          ))}
          {hiddenBadgeCount > 0 && (
            <Badge variant="outline" className="text-muted-foreground shrink-0 px-1.5 text-xs">
              +{hiddenBadgeCount}
            </Badge>
          )}
        </div>
      ) : null}
    </DataGridCellWrapper>
  );
}

function formatDateForDisplay(dateStr: string) {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  return date.toLocaleDateString();
}

export function DateCell<TData>({
  cell,
  tableMeta,
  rowIndex,
  columnId,
  rowHeight,
  isFocused,
  isEditing,
  isSelected,
  isSearchMatch,
  isActiveSearchMatch,
  readOnly,
  cellState,
}: DataGridCellProps<TData>) {
  const initialValue = cell.getValue() as string;
  const [value, setValue] = React.useState(initialValue ?? "");
  const containerRef = React.useRef<HTMLDivElement>(null);

  const prevInitialValueRef = React.useRef(initialValue);
  if (initialValue !== prevInitialValueRef.current) {
    prevInitialValueRef.current = initialValue;
    setValue(initialValue ?? "");
  }

  const selectedDate = value ? new Date(value) : undefined;

  const onDateSelect = React.useCallback(
    (date: Date | undefined) => {
      if (!date || readOnly) return;

      const formattedDate = date.toISOString().split("T")[0] ?? "";
      setValue(formattedDate);
      tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: formattedDate });
      tableMeta?.onCellEditingStop?.();
    },
    [tableMeta, rowIndex, columnId, readOnly],
  );

  const onOpenChange = React.useCallback(
    (isOpen: boolean) => {
      if (isOpen && !readOnly) {
        tableMeta?.onCellEditingStart?.(rowIndex, columnId);
      } else {
        tableMeta?.onCellEditingStop?.();
      }
    },
    [tableMeta, rowIndex, columnId, readOnly],
  );

  const onWrapperKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (isEditing && event.key === "Escape") {
        event.preventDefault();
        setValue(initialValue);
        tableMeta?.onCellEditingStop?.();
      } else if (!isEditing && isFocused && event.key === "Tab") {
        event.preventDefault();
        tableMeta?.onCellEditingStop?.({
          direction: event.shiftKey ? "left" : "right",
        });
      }
    },
    [isEditing, isFocused, initialValue, tableMeta],
  );

  return (
    <DataGridCellWrapper<TData>
      ref={containerRef}
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
      onKeyDown={onWrapperKeyDown}
    >
      <Popover open={isEditing} onOpenChange={onOpenChange}>
        <PopoverAnchor asChild>
          <span data-slot="grid-cell-content">{formatDateForDisplay(value)}</span>
        </PopoverAnchor>
        {isEditing && (
          <PopoverContent data-grid-cell-editor="" align="start" alignOffset={-8} className="w-auto p-0">
            <Calendar
              autoFocus
              captionLayout="dropdown"
              mode="single"
              defaultMonth={selectedDate ?? new Date()}
              selected={selectedDate}
              onSelect={onDateSelect}
            />
          </PopoverContent>
        )}
      </Popover>
    </DataGridCellWrapper>
  );
}

// Parse date string as local timezone. new Date("YYYY-MM-DD") parses as UTC midnight,
// which shifts back a day in negative UTC offsets. Appending T00:00:00 forces local parsing.
function parseDateLocal(value: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(value + "T00:00:00");
  }
  return new Date(value);
}

// Helper functions for date-input variant
function formatDateInputForDisplay(date: Date | string | undefined): string {
  if (!date) return "";
  const d = date instanceof Date ? date : parseDateLocal(date);
  if (Number.isNaN(d.getTime())) return "";
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toDateInputString(date: Date | string | undefined): string {
  if (!date) return "";
  const d = date instanceof Date ? date : parseDateLocal(date);
  if (Number.isNaN(d.getTime())) return "";
  // Format: YYYY-MM-DD (required format for date input)
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Helper to get date-only timestamp (midnight) for comparison
function getDateOnlyTimestamp(value: Date | string | undefined): number | null {
  if (!value) return null;
  const d = value instanceof Date ? value : parseDateLocal(value);
  if (Number.isNaN(d.getTime())) return null;
  // Normalize to midnight for date-only comparison
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function DateInputCell<TData>({
  cell,
  tableMeta,
  rowIndex,
  columnId,
  rowHeight,
  isFocused,
  isEditing,
  isSelected,
  isSearchMatch,
  isActiveSearchMatch,
  readOnly,
  cellState,
}: DataGridCellProps<TData>) {
  const initialValue = cell.getValue() as Date | string | undefined;
  const [value, setValue] = React.useState(() => toDateInputString(initialValue));
  const inputRef = React.useRef<HTMLInputElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  // Compare by date-only timestamp instead of reference for Date objects
  const prevTimestampRef = React.useRef(getDateOnlyTimestamp(initialValue));
  const currentTimestamp = getDateOnlyTimestamp(initialValue);
  if (currentTimestamp !== prevTimestampRef.current) {
    prevTimestampRef.current = currentTimestamp;
    setValue(toDateInputString(initialValue));
  }

  const onBlur = React.useCallback(() => {
    if (readOnly) {
      tableMeta?.onCellEditingStop?.();
      return;
    }
    const date = value ? parseDateLocal(value) : undefined;
    const initialDate = initialValue
      ? initialValue instanceof Date
        ? initialValue
        : parseDateLocal(initialValue)
      : undefined;

    // Compare date-only (ignore time)
    const newTimestamp = getDateOnlyTimestamp(date);
    const oldTimestamp = getDateOnlyTimestamp(initialDate);
    if (newTimestamp !== oldTimestamp) {
      tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: date });
    }
    tableMeta?.onCellEditingStop?.();
  }, [tableMeta, rowIndex, columnId, value, initialValue, readOnly]);

  const onChange = React.useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setValue(event.target.value);
  }, []);

  // Track previous editing state to detect when editing stops
  const wasEditingRef = React.useRef(isEditing);
  const valueRef = React.useRef(value);
  valueRef.current = value;

  React.useEffect(() => {
    // When editing stops (transitions from true to false), save the value
    if (wasEditingRef.current && !isEditing) {
      const currentValue = valueRef.current;
      const date = currentValue ? parseDateLocal(currentValue) : undefined;
      const initialDate = initialValue
        ? initialValue instanceof Date
          ? initialValue
          : parseDateLocal(initialValue)
        : undefined;

      const newTimestamp = getDateOnlyTimestamp(date);
      const oldTimestamp = getDateOnlyTimestamp(initialDate);
      if (!readOnly && newTimestamp !== oldTimestamp) {
        tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: date });
      }
    }
    wasEditingRef.current = isEditing;
  }, [isEditing, initialValue, readOnly, tableMeta, rowIndex, columnId]);

  const onWrapperKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (isEditing) {
        if (event.key === "Enter") {
          event.preventDefault();
          const date = value ? parseDateLocal(value) : undefined;
          const initialDate = initialValue
            ? initialValue instanceof Date
              ? initialValue
              : parseDateLocal(initialValue)
            : undefined;
          const newTimestamp = getDateOnlyTimestamp(date);
          const oldTimestamp = getDateOnlyTimestamp(initialDate);
          if (newTimestamp !== oldTimestamp) {
            tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: date });
          }
          tableMeta?.onCellEditingStop?.({ moveToNextRow: true });
        } else if (event.key === "Tab") {
          event.preventDefault();
          const date = value ? parseDateLocal(value) : undefined;
          const initialDate = initialValue
            ? initialValue instanceof Date
              ? initialValue
              : parseDateLocal(initialValue)
            : undefined;
          const newTimestamp = getDateOnlyTimestamp(date);
          const oldTimestamp = getDateOnlyTimestamp(initialDate);
          if (newTimestamp !== oldTimestamp) {
            tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: date });
          }
          tableMeta?.onCellEditingStop?.({
            direction: event.shiftKey ? "left" : "right",
          });
        } else if (event.key === "Escape") {
          event.preventDefault();
          setValue(toDateInputString(initialValue));
          tableMeta?.onCellEditingStop?.();
        }
      } else if (isFocused && event.key === "Tab") {
        event.preventDefault();
        tableMeta?.onCellEditingStop?.({
          direction: event.shiftKey ? "left" : "right",
        });
      }
    },
    [isEditing, isFocused, initialValue, tableMeta, rowIndex, columnId, value],
  );

  React.useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  return (
    <DataGridCellWrapper<TData>
      ref={containerRef}
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
      onKeyDown={onWrapperKeyDown}
    >
      {isEditing ? (
        <input
          ref={inputRef}
          type="date"
          value={value}
          onChange={onChange}
          onBlur={onBlur}
          className="w-full border-none bg-transparent p-0 text-sm outline-none"
        />
      ) : (
        <span data-slot="grid-cell-content">{formatDateInputForDisplay(value)}</span>
      )}
    </DataGridCellWrapper>
  );
}

function formatDateTimeForDisplay(date: Date | string | undefined): string {
  if (!date) return "";
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  // Format: YYYY-MM-DD, HH:MM AM/PM (matches datetime-local visual style)
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  const hour12 = hours % 12 || 12;
  const hourStr = String(hour12).padStart(2, "0");
  return `${year}-${month}-${day}, ${hourStr}:${minutes} ${ampm}`;
}

function toDateTimeLocalString(date: Date | string | undefined): string {
  if (!date) return "";
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  // Format: YYYY-MM-DDTHH:mm (required format for datetime-local input)
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

// Helper to get timestamp from date value for comparison
function getDateTimestamp(value: Date | string | undefined): number | null {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

export function DateTimeCell<TData>({
  cell,
  tableMeta,
  rowIndex,
  columnId,
  rowHeight,
  isFocused,
  isEditing,
  isSelected,
  isSearchMatch,
  isActiveSearchMatch,
  readOnly,
  cellState,
}: DataGridCellProps<TData>) {
  const initialValue = cell.getValue() as Date | string | undefined;
  const [value, setValue] = React.useState(() => toDateTimeLocalString(initialValue));
  const inputRef = React.useRef<HTMLInputElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  // Compare by timestamp instead of reference for Date objects
  const prevTimestampRef = React.useRef(getDateTimestamp(initialValue));
  const currentTimestamp = getDateTimestamp(initialValue);
  if (currentTimestamp !== prevTimestampRef.current) {
    prevTimestampRef.current = currentTimestamp;
    setValue(toDateTimeLocalString(initialValue));
  }

  const onBlur = React.useCallback(() => {
    if (readOnly) {
      tableMeta?.onCellEditingStop?.();
      return;
    }
    const date = value ? new Date(value) : undefined;
    const initialDate = initialValue
      ? initialValue instanceof Date
        ? initialValue
        : new Date(initialValue)
      : undefined;

    // Only update if value changed
    if (date?.getTime() !== initialDate?.getTime()) {
      tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: date });
    }
    tableMeta?.onCellEditingStop?.();
  }, [tableMeta, rowIndex, columnId, value, initialValue, readOnly]);

  const onChange = React.useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setValue(event.target.value);
  }, []);

  // Track previous editing state to detect when editing stops
  const wasEditingRef = React.useRef(isEditing);
  const valueRef = React.useRef(value);
  valueRef.current = value;

  React.useEffect(() => {
    // When editing stops (transitions from true to false), save the value
    if (wasEditingRef.current && !isEditing) {
      const currentValue = valueRef.current;
      const date = currentValue ? parseDateLocal(currentValue) : undefined;
      const initialDate = initialValue
        ? initialValue instanceof Date
          ? initialValue
          : parseDateLocal(initialValue)
        : undefined;

      if (!readOnly && date?.getTime() !== initialDate?.getTime()) {
        tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: date });
      }
    }
    wasEditingRef.current = isEditing;
  }, [isEditing, initialValue, readOnly, tableMeta, rowIndex, columnId]);

  const onWrapperKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (isEditing) {
        if (event.key === "Enter") {
          event.preventDefault();
          const date = value ? parseDateLocal(value) : undefined;
          const initialDate = initialValue
            ? initialValue instanceof Date
              ? initialValue
              : parseDateLocal(initialValue)
            : undefined;
          if (date?.getTime() !== initialDate?.getTime()) {
            tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: date });
          }
          tableMeta?.onCellEditingStop?.({ moveToNextRow: true });
        } else if (event.key === "Tab") {
          event.preventDefault();
          const date = value ? parseDateLocal(value) : undefined;
          const initialDate = initialValue
            ? initialValue instanceof Date
              ? initialValue
              : parseDateLocal(initialValue)
            : undefined;
          if (date?.getTime() !== initialDate?.getTime()) {
            tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: date });
          }
          tableMeta?.onCellEditingStop?.({
            direction: event.shiftKey ? "left" : "right",
          });
        } else if (event.key === "Escape") {
          event.preventDefault();
          setValue(toDateTimeLocalString(initialValue));
          tableMeta?.onCellEditingStop?.();
        }
      } else if (isFocused && event.key === "Tab") {
        event.preventDefault();
        tableMeta?.onCellEditingStop?.({
          direction: event.shiftKey ? "left" : "right",
        });
      }
    },
    [isEditing, isFocused, initialValue, tableMeta, rowIndex, columnId, value],
  );

  React.useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  return (
    <DataGridCellWrapper<TData>
      ref={containerRef}
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
      onKeyDown={onWrapperKeyDown}
    >
      {isEditing ? (
        <input
          ref={inputRef}
          type="datetime-local"
          value={value}
          onChange={onChange}
          onBlur={onBlur}
          className="w-full border-none bg-transparent p-0 text-sm outline-none"
        />
      ) : (
        <span data-slot="grid-cell-content">{formatDateTimeForDisplay(value)}</span>
      )}
    </DataGridCellWrapper>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Number.parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
}

function getFileIcon(type: string) {
  if (type.startsWith("image/")) return Icons.FileImage;
  if (type.startsWith("video/")) return Icons.FileVideo;
  if (type.startsWith("audio/")) return Icons.FileAudio;
  if (type.includes("pdf")) return Icons.FileText;
  if (type.includes("zip") || type.includes("rar")) return Icons.FileArchive;
  if (type.includes("word") || type.includes("document") || type.includes("doc")) return Icons.FileText;
  if (type.includes("sheet") || type.includes("excel") || type.includes("xls")) return Icons.FileSpreadsheet;
  if (type.includes("presentation") || type.includes("powerpoint") || type.includes("ppt")) return Icons.Presentation;
  return Icons.File;
}

export function FileCell<TData>({
  cell,
  tableMeta,
  rowIndex,
  columnId,
  rowHeight,
  isFocused,
  isEditing,
  isSelected,
  isSearchMatch,
  isActiveSearchMatch,
  readOnly,
  cellState,
}: DataGridCellProps<TData>) {
  const { t } = useTranslation();
  const cellValue = React.useMemo(() => (cell.getValue() as FileCellData[]) ?? [], [cell]);

  const cellKey = getCellKey(rowIndex, columnId);
  const prevCellKeyRef = React.useRef(cellKey);

  const labelId = React.useId();
  const descriptionId = React.useId();

  const [files, setFiles] = React.useState<FileCellData[]>(cellValue);
  const [uploadingFiles, setUploadingFiles] = React.useState<Set<string>>(new Set());
  const [deletingFiles, setDeletingFiles] = React.useState<Set<string>>(new Set());
  const [isDraggingOver, setIsDraggingOver] = React.useState(false);
  const [isDragging, setIsDragging] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const isUploading = uploadingFiles.size > 0;
  const isDeleting = deletingFiles.size > 0;
  const isPending = isUploading || isDeleting;
  const containerRef = React.useRef<HTMLDivElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const dropzoneRef = React.useRef<HTMLDivElement>(null);
  const cellOpts = cell.column.columnDef.meta?.cell;
  const sideOffset = -(containerRef.current?.clientHeight ?? 0);

  const fileCellOpts = cellOpts?.variant === "file" ? cellOpts : null;
  const maxFileSize = fileCellOpts?.maxFileSize ?? 10 * 1024 * 1024;
  const maxFiles = fileCellOpts?.maxFiles ?? 10;
  const accept = fileCellOpts?.accept;
  const multiple = fileCellOpts?.multiple ?? false;

  const acceptedTypes = React.useMemo(() => (accept ? accept.split(",").map((t) => t.trim()) : null), [accept]);

  const prevCellValueRef = React.useRef(cellValue);
  if (cellValue !== prevCellValueRef.current) {
    prevCellValueRef.current = cellValue;
    for (const file of files) {
      if (file.url) {
        URL.revokeObjectURL(file.url);
      }
    }
    setFiles(cellValue);
    setError(null);
  }

  if (prevCellKeyRef.current !== cellKey) {
    prevCellKeyRef.current = cellKey;
    setError(null);
  }

  const validateFile = React.useCallback(
    (file: File): string | null => {
      if (maxFileSize && file.size > maxFileSize) {
        return t("ui:dataGrid.fileSizeExceeds", "File size exceeds {{size}}", {
          size: formatFileSize(maxFileSize),
        });
      }
      if (acceptedTypes) {
        const fileExtension = `.${file.name.split(".").pop()}`;
        const isAccepted = acceptedTypes.some((type) => {
          if (type.endsWith("/*")) {
            const baseType = type.slice(0, -2);
            return file.type.startsWith(`${baseType}/`);
          }
          if (type.startsWith(".")) {
            return fileExtension.toLowerCase() === type.toLowerCase();
          }
          return file.type === type;
        });
        if (!isAccepted) {
          return t("ui:dataGrid.fileTypeNotAccepted", "File type not accepted");
        }
      }
      return null;
    },
    [maxFileSize, acceptedTypes, t],
  );

  const addFiles = React.useCallback(
    async (newFiles: File[], skipUpload = false) => {
      if (readOnly || isPending) return;
      setError(null);

      if (maxFiles && files.length + newFiles.length > maxFiles) {
        const errorMessage = t("ui:dataGrid.maxFilesAllowed", "Maximum {{count}} files allowed", { count: maxFiles });
        setError(errorMessage);
        toast(errorMessage);
        setTimeout(() => {
          setError(null);
        }, 2000);
        return;
      }

      const rejectedFiles: { name: string; reason: string }[] = [];
      const filesToValidate: File[] = [];

      for (const file of newFiles) {
        const validationError = validateFile(file);
        if (validationError) {
          rejectedFiles.push({ name: file.name, reason: validationError });
          continue;
        }
        filesToValidate.push(file);
      }

      if (rejectedFiles.length > 0) {
        const firstError = rejectedFiles[0];
        if (firstError) {
          setError(firstError.reason);

          const truncatedName = firstError.name.length > 20 ? `${firstError.name.slice(0, 20)}...` : firstError.name;

          if (rejectedFiles.length === 1) {
            toast(firstError.reason, {
              description: t("ui:dataGrid.fileRejected", '"{{name}}" has been rejected', { name: truncatedName }),
            });
          } else {
            toast(firstError.reason, {
              description: t("ui:dataGrid.filesRejected", '"{{name}}" and {{count}} more rejected', {
                name: truncatedName,
                count: rejectedFiles.length - 1,
              }),
            });
          }

          setTimeout(() => {
            setError(null);
          }, 2000);
        }
      }

      if (filesToValidate.length > 0) {
        if (!skipUpload) {
          const tempFiles = filesToValidate.map((f) => ({
            id: generateId(),
            name: f.name,
            size: f.size,
            type: f.type,
            url: undefined,
          }));
          const filesWithTemp = [...files, ...tempFiles];
          setFiles(filesWithTemp);

          const uploadingIds = new Set<string>(tempFiles.map((f) => f.id));
          setUploadingFiles(uploadingIds);

          let uploadedFiles: FileCellData[] = [];

          if (tableMeta?.onFilesUpload) {
            try {
              uploadedFiles = await tableMeta.onFilesUpload({
                files: filesToValidate,
                rowIndex,
                columnId,
              });
            } catch (error) {
              toast.error(
                error instanceof Error
                  ? error.message
                  : t("ui:dataGrid.uploadFailed", "Failed to upload {{count}} file", {
                      count: filesToValidate.length,
                    }),
              );
              setFiles((prev) => prev.filter((f) => !uploadingIds.has(f.id)));
              setUploadingFiles(new Set());
              return;
            }
          } else {
            uploadedFiles = filesToValidate.map((f, i) => ({
              id: tempFiles[i]?.id ?? generateId(),
              name: f.name,
              size: f.size,
              type: f.type,
              url: URL.createObjectURL(f),
            }));
          }

          const finalFiles = filesWithTemp
            .map((f) => {
              if (uploadingIds.has(f.id)) {
                return uploadedFiles.find((uf) => uf.name === f.name) ?? f;
              }
              return f;
            })
            .filter((f) => f.url !== undefined);

          setFiles(finalFiles);
          setUploadingFiles(new Set());
          tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: finalFiles });
        } else {
          const newFilesData: FileCellData[] = filesToValidate.map((f) => ({
            id: generateId(),
            name: f.name,
            size: f.size,
            type: f.type,
            url: URL.createObjectURL(f),
          }));
          const updatedFiles = [...files, ...newFilesData];
          setFiles(updatedFiles);
          tableMeta?.onDataUpdate?.({
            rowIndex,
            columnId,
            value: updatedFiles,
          });
        }
      }
    },
    [files, maxFiles, validateFile, tableMeta, rowIndex, columnId, readOnly, isPending, t],
  );

  const removeFile = React.useCallback(
    async (fileId: string) => {
      if (readOnly || isPending) return;
      setError(null);

      const fileToRemove = files.find((f) => f.id === fileId);
      if (!fileToRemove) return;

      setDeletingFiles((prev) => new Set(prev).add(fileId));

      if (tableMeta?.onFilesDelete) {
        try {
          await tableMeta.onFilesDelete({
            fileIds: [fileId],
            rowIndex,
            columnId,
          });
        } catch (error) {
          toast.error(
            error instanceof Error
              ? error.message
              : t("ui:dataGrid.deleteFailed", "Failed to delete {{name}}", { name: fileToRemove.name }),
          );
          setDeletingFiles((prev) => {
            const next = new Set(prev);
            next.delete(fileId);
            return next;
          });
          return;
        }
      }

      if (fileToRemove.url?.startsWith("blob:")) {
        URL.revokeObjectURL(fileToRemove.url);
      }

      const updatedFiles = files.filter((f) => f.id !== fileId);
      setFiles(updatedFiles);
      setDeletingFiles((prev) => {
        const next = new Set(prev);
        next.delete(fileId);
        return next;
      });
      tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: updatedFiles });
    },
    [files, tableMeta, rowIndex, columnId, readOnly, isPending, t],
  );

  const clearAll = React.useCallback(async () => {
    if (readOnly || isPending) return;
    setError(null);

    const fileIds = files.map((f) => f.id);
    setDeletingFiles(new Set(fileIds));

    if (tableMeta?.onFilesDelete && files.length > 0) {
      try {
        await tableMeta.onFilesDelete({
          fileIds,
          rowIndex,
          columnId,
        });
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : t("ui:dataGrid.deleteFilesFailed", "Failed to delete files"),
        );
        setDeletingFiles(new Set());
        return;
      }
    }

    for (const file of files) {
      if (file.url?.startsWith("blob:")) {
        URL.revokeObjectURL(file.url);
      }
    }
    setFiles([]);
    setDeletingFiles(new Set());
    tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: [] });
  }, [files, tableMeta, rowIndex, columnId, readOnly, isPending, t]);

  const onCellDragEnter = React.useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer.types.includes("Files")) {
      setIsDraggingOver(true);
    }
  }, []);

  const onCellDragLeave = React.useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX;
    const y = event.clientY;

    if (x <= rect.left || x >= rect.right || y <= rect.top || y >= rect.bottom) {
      setIsDraggingOver(false);
    }
  }, []);

  const onCellDragOver = React.useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const onCellDrop = React.useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setIsDraggingOver(false);

      const droppedFiles = Array.from(event.dataTransfer.files);
      if (droppedFiles.length > 0) {
        addFiles(droppedFiles, false);
      }
    },
    [addFiles],
  );

  const onDropzoneDragEnter = React.useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(true);
  }, []);

  const onDropzoneDragLeave = React.useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX;
    const y = event.clientY;

    if (x <= rect.left || x >= rect.right || y <= rect.top || y >= rect.bottom) {
      setIsDragging(false);
    }
  }, []);

  const onDropzoneDragOver = React.useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const onDropzoneDrop = React.useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setIsDragging(false);

      const droppedFiles = Array.from(event.dataTransfer.files);
      addFiles(droppedFiles, false);
    },
    [addFiles],
  );

  const onDropzoneClick = React.useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onDropzoneKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onDropzoneClick();
      }
    },
    [onDropzoneClick],
  );

  const onFileInputChange = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const selectedFiles = Array.from(event.target.files ?? []);
      addFiles(selectedFiles, false);
      event.target.value = "";
    },
    [addFiles],
  );

  const onOpenChange = React.useCallback(
    (isOpen: boolean) => {
      if (isOpen && !readOnly) {
        setError(null);
        tableMeta?.onCellEditingStart?.(rowIndex, columnId);
      } else {
        setError(null);
        tableMeta?.onCellEditingStop?.();
      }
    },
    [tableMeta, rowIndex, columnId, readOnly],
  );

  const onEscapeKeyDown: NonNullable<React.ComponentProps<typeof PopoverContent>["onEscapeKeyDown"]> =
    React.useCallback((event) => {
      // Prevent the escape key from propagating to the data grid's keyboard handler
      // which would call blurCell() and remove focus from the cell
      event.stopPropagation();
    }, []);

  const onOpenAutoFocus: NonNullable<React.ComponentProps<typeof PopoverContent>["onOpenAutoFocus"]> =
    React.useCallback((event) => {
      event.preventDefault();
      queueMicrotask(() => {
        dropzoneRef.current?.focus();
      });
    }, []);

  const onWrapperKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (isEditing) {
        if (event.key === "Escape") {
          event.preventDefault();
          setFiles(cellValue);
          setError(null);
          tableMeta?.onCellEditingStop?.();
        } else if (event.key === " ") {
          event.preventDefault();
          onDropzoneClick();
        }
      } else if (isFocused && event.key === "Enter") {
        event.preventDefault();
        tableMeta?.onCellEditingStart?.(rowIndex, columnId);
      } else if (!isEditing && isFocused && event.key === "Tab") {
        event.preventDefault();
        tableMeta?.onCellEditingStop?.({
          direction: event.shiftKey ? "left" : "right",
        });
      }
    },
    [isEditing, isFocused, cellValue, tableMeta, onDropzoneClick, rowIndex, columnId],
  );

  React.useEffect(() => {
    return () => {
      for (const file of files) {
        if (file.url) {
          URL.revokeObjectURL(file.url);
        }
      }
    };
  }, [files]);

  const lineCount = getLineCount(rowHeight);

  const { visibleItems: visibleFiles, hiddenCount: hiddenFileCount } = useBadgeOverflow({
    items: files,
    getLabel: (file) => file.name,
    containerRef,
    lineCount,
    cacheKeyPrefix: "file",
    iconSize: 12,
    maxWidth: 100,
  });

  return (
    <DataGridCellWrapper<TData>
      ref={containerRef}
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
      className={cn({
        "ring-primary/80 ring-1 ring-inset": isDraggingOver,
      })}
      onDragEnter={onCellDragEnter}
      onDragLeave={onCellDragLeave}
      onDragOver={onCellDragOver}
      onDrop={onCellDrop}
      onKeyDown={onWrapperKeyDown}
    >
      {isEditing ? (
        <Popover open={isEditing} onOpenChange={onOpenChange}>
          <PopoverAnchor asChild>
            <div className="absolute inset-0" />
          </PopoverAnchor>
          <PopoverContent
            data-grid-cell-editor=""
            align="start"
            sideOffset={sideOffset}
            className="w-[400px] rounded-none p-0"
            onEscapeKeyDown={onEscapeKeyDown}
            onOpenAutoFocus={onOpenAutoFocus}
          >
            <div className="flex flex-col gap-2 p-3">
              <span id={labelId} className="sr-only">
                {t("ui:dataGrid.fileUpload", "File upload")}
              </span>
              <div
                role="region"
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
                aria-invalid={!!error}
                aria-disabled={isPending}
                data-dragging={isDragging ? "" : undefined}
                data-invalid={error ? "" : undefined}
                data-disabled={isPending ? "" : undefined}
                tabIndex={isDragging || isPending ? -1 : 0}
                className="hover:bg-accent/30 focus-visible:border-ring/50 data-dragging:border-primary/30 data-invalid:border-destructive data-dragging:bg-accent/30 data-invalid:ring-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-50 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-6 outline-none transition-colors"
                ref={dropzoneRef}
                onClick={onDropzoneClick}
                onDragEnter={onDropzoneDragEnter}
                onDragLeave={onDropzoneDragLeave}
                onDragOver={onDropzoneDragOver}
                onDrop={onDropzoneDrop}
                onKeyDown={onDropzoneKeyDown}
              >
                <Icons.Upload className="text-muted-foreground size-8" />
                <div className="text-center text-sm">
                  <p className="font-medium">
                    {isDragging
                      ? t("ui:dataGrid.dropFilesHere", "Drop files here")
                      : t("ui:dataGrid.dragFilesHere", "Drag files here")}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {t("ui:dataGrid.clickToBrowse", "or click to browse")}
                  </p>
                </div>
                <p id={descriptionId} className="text-muted-foreground text-xs">
                  {maxFileSize
                    ? maxFiles
                      ? t("ui:dataGrid.maxSizeAndFiles", "Max size: {{size}} • Max {{count}} files", {
                          size: formatFileSize(maxFileSize),
                          count: maxFiles,
                        })
                      : t("ui:dataGrid.maxSize", "Max size: {{size}}", { size: formatFileSize(maxFileSize) })
                    : maxFiles
                      ? t("ui:dataGrid.maxFiles", "Max {{count}} files", { count: maxFiles })
                      : t("ui:dataGrid.selectFilesToUpload", "Select files to upload")}
                </p>
              </div>
              <input
                type="file"
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
                multiple={multiple}
                accept={accept}
                className="sr-only"
                ref={fileInputRef}
                onChange={onFileInputChange}
              />
              {files.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <p className="text-muted-foreground text-xs font-medium">
                      {t("ui:dataGrid.fileCount", "{{count}} file", { count: files.length })}
                    </p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground h-6 text-xs"
                      onClick={clearAll}
                      disabled={isPending}
                    >
                      {t("ui:dataGrid.clearAll", "Clear all")}
                    </Button>
                  </div>
                  <div className="max-h-[200px] space-y-1 overflow-y-auto">
                    {files.map((file) => {
                      const FileIcon = getFileIcon(file.type);
                      const isFileUploading = uploadingFiles.has(file.id);
                      const isFileDeleting = deletingFiles.has(file.id);
                      const isFilePending = isFileUploading || isFileDeleting;

                      return (
                        <div
                          key={file.id}
                          data-pending={isFilePending ? "" : undefined}
                          className="bg-muted/50 data-pending:opacity-60 flex items-center gap-2 rounded-md border px-2 py-1.5"
                        >
                          {FileIcon && <FileIcon className="text-muted-foreground size-4 shrink-0" />}
                          <div className="flex-1 overflow-hidden">
                            <p className="truncate text-sm">{file.name}</p>
                            <p className="text-muted-foreground text-xs">
                              {isFileUploading
                                ? t("ui:dataGrid.uploading", "Uploading...")
                                : isFileDeleting
                                  ? t("ui:dataGrid.deleting", "Deleting...")
                                  : formatFileSize(file.size)}
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-5 rounded-sm"
                            onClick={() => removeFile(file.id)}
                            disabled={isPending}
                          >
                            <Icons.X className="size-3" />
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
      {isDraggingOver ? (
        <div className="text-primary flex items-center justify-center gap-2 text-sm">
          <Icons.Upload className="size-4" />
          <span>{t("ui:dataGrid.dropFilesHere", "Drop files here")}</span>
        </div>
      ) : files.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1 overflow-hidden">
          {visibleFiles.map((file) => {
            const isUploading = uploadingFiles.has(file.id);

            if (isUploading) {
              return (
                <Skeleton
                  key={file.id}
                  className="h-5 shrink-0 px-1.5"
                  style={{
                    width: `${Math.min(file.name.length * 8 + 30, 100)}px`,
                  }}
                />
              );
            }

            return (
              <Badge key={file.id} variant="secondary" className="shrink-0 gap-1 px-1.5 text-xs">
                {React.createElement(getFileIcon(file.type), {
                  className: "size-3 shrink-0",
                })}
                <span className="max-w-[100px] truncate">{file.name}</span>
              </Badge>
            );
          })}
          {hiddenFileCount > 0 && (
            <Badge variant="outline" className="text-muted-foreground shrink-0 px-1.5 text-xs">
              +{hiddenFileCount}
            </Badge>
          )}
        </div>
      ) : null}
    </DataGridCellWrapper>
  );
}

export function SymbolCell<TData>({
  cell,
  tableMeta,
  rowIndex,
  columnId,
  rowHeight,
  isFocused,
  isEditing,
  isSelected,
  isSearchMatch,
  isActiveSearchMatch,
  readOnly,
  cellState,
}: DataGridCellProps<TData>) {
  const { t } = useTranslation();
  const normalizeCryptoPairSymbol = React.useCallback((symbol: string, currencyHint?: string) => {
    // Provider may return a pair symbol like "BTC-USD". Canonical crypto IDs use the base symbol.
    const trimmed = symbol.trim();
    const match = /^(.*)-([A-Za-z]{3,5})$/.exec(trimmed);
    if (!match) return trimmed;
    const base = match[1]?.trim();
    const quote = match[2]?.trim().toUpperCase();
    const hint = currencyHint?.trim().toUpperCase();
    if (hint && quote && quote !== hint) {
      return trimmed;
    }
    return base || trimmed;
  }, []);

  const initialValue = cell.getValue() as string;
  const [value, setValue] = React.useState(initialValue ?? "");
  const [searchQuery, setSearchQuery] = React.useState("");
  const [options, setOptions] = React.useState<SymbolSearchResult[]>([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isError, setIsError] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const cellOpts = cell.column.columnDef.meta?.cell;
  const symbolCellOpts = cellOpts?.variant === "symbol" ? cellOpts : null;
  const onSearch = symbolCellOpts?.onSearch;
  const onSelectCallback = symbolCellOpts?.onSelect;
  const onCreateCustomAssetCallback = symbolCellOpts?.onCreateCustomAsset;
  const getDisplayContextFn = symbolCellOpts?.getDisplayContext;
  const isDisabledFn = symbolCellOpts?.isDisabled;
  const isClearableFn = symbolCellOpts?.isClearable;
  const rowData = cell.row.original;
  const disabled = isDisabledFn ? isDisabledFn(rowData) : false;
  const clearable = isClearableFn ? isClearableFn(rowData) : false;
  const displayContext = value ? getDisplayContextFn?.(rowData) : undefined;
  const sideOffset = -(containerRef.current?.clientHeight ?? 0);

  const prevInitialValueRef = React.useRef(initialValue);
  if (initialValue !== prevInitialValueRef.current) {
    prevInitialValueRef.current = initialValue;
    setValue(initialValue ?? "");
  }

  // Debounced search
  const debouncedSearch = useDebouncedCallback(async (query: string) => {
    if (!onSearch || query.trim().length < 2) {
      setOptions([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setIsError(false);

    try {
      // Results are already sorted by backend (existing assets first, then by score)
      const results = await onSearch(query);
      setOptions(results);
    } catch {
      setIsError(true);
      setOptions([]);
    } finally {
      setIsLoading(false);
    }
  }, 300);

  const onSearchChange = React.useCallback(
    (query: string) => {
      setSearchQuery(query);
      debouncedSearch(query);
    },
    [debouncedSearch],
  );

  const handleSelect = React.useCallback(
    (symbol: string, result?: SymbolSearchResult) => {
      const trimmed = symbol.trim();
      const canonicalSymbol =
        result?.canonicalSymbol ||
        (result?.assetKind?.toUpperCase() === "CRYPTO"
          ? normalizeCryptoPairSymbol(trimmed, result?.currency)
          : trimmed);
      const normalized = canonicalSymbol.trim().toUpperCase();
      setValue(normalized);
      tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: normalized });
      onSelectCallback?.(rowIndex, normalized, result);
      setSearchQuery("");
      setOptions([]);
      tableMeta?.onCellEditingStop?.();
    },
    [tableMeta, rowIndex, columnId, onSelectCallback, normalizeCryptoPairSymbol],
  );

  const handleCustomSymbol = React.useCallback(() => {
    const trimmed = searchQuery.trim();
    if (!trimmed) return;

    // If a custom asset creation callback is provided, use it instead of just setting the symbol
    if (onCreateCustomAssetCallback) {
      setSearchQuery("");
      setOptions([]);
      tableMeta?.onCellEditingStop?.();
      onCreateCustomAssetCallback(rowIndex, trimmed);
    } else {
      // Fallback: just set the symbol value directly
      handleSelect(trimmed, undefined);
    }
  }, [searchQuery, handleSelect, onCreateCustomAssetCallback, rowIndex, tableMeta]);

  const handleClear = React.useCallback(() => {
    setValue("");
    tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: "" });
    onSelectCallback?.(rowIndex, "", undefined);
    setSearchQuery("");
    setOptions([]);
    tableMeta?.onCellEditingStop?.();
  }, [tableMeta, rowIndex, columnId, onSelectCallback]);

  const onOpenChange = React.useCallback(
    (isOpen: boolean) => {
      if (isOpen && !readOnly) {
        setSearchQuery(value);
        tableMeta?.onCellEditingStart?.(rowIndex, columnId);
      } else {
        setSearchQuery("");
        setOptions([]);
        tableMeta?.onCellEditingStop?.();
      }
    },
    [tableMeta, rowIndex, columnId, readOnly, value],
  );

  const onOpenAutoFocus: NonNullable<React.ComponentProps<typeof PopoverContent>["onOpenAutoFocus"]> =
    React.useCallback((event) => {
      event.preventDefault();
      inputRef.current?.focus();
    }, []);

  const onWrapperKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (isEditing && event.key === "Escape") {
        event.preventDefault();
        setValue(initialValue ?? "");
        setSearchQuery("");
        setOptions([]);
        tableMeta?.onCellEditingStop?.();
      } else if (!isEditing && isFocused && event.key === "Tab") {
        event.preventDefault();
        tableMeta?.onCellEditingStop?.({
          direction: event.shiftKey ? "left" : "right",
        });
      }
    },
    [isEditing, isFocused, initialValue, tableMeta],
  );

  const onInputKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setValue(initialValue ?? "");
        setSearchQuery("");
        setOptions([]);
        tableMeta?.onCellEditingStop?.();
      } else if (event.key === "Tab") {
        event.preventDefault();
        setSearchQuery("");
        setOptions([]);
        tableMeta?.onCellEditingStop?.({
          direction: event.shiftKey ? "left" : "right",
        });
      } else if (event.key === "Enter" && searchQuery.trim() && options.length === 0) {
        event.preventDefault();
        handleCustomSymbol();
      }
    },
    [initialValue, tableMeta, searchQuery, options.length, handleCustomSymbol],
  );

  const displayName = (option: SymbolSearchResult) => {
    return option.longName || option.shortName || option.symbol;
  };
  const getOptionKey = (option: SymbolSearchResult) => {
    const parts = [option.symbol, option.exchangeMic ?? option.exchange, option.currency].filter(Boolean);
    return parts.join("|");
  };

  const trimmedQuery = searchQuery.trim();

  return (
    <DataGridCellWrapper<TData>
      ref={containerRef}
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
      onKeyDown={onWrapperKeyDown}
    >
      <Popover open={isEditing && !disabled} onOpenChange={onOpenChange}>
        <PopoverAnchor asChild>
          <span data-slot="grid-cell-content" className={cn(!value && "text-muted-foreground")}>
            {disabled ? value || "—" : value}
            {value && displayContext ? (
              <span className="text-muted-foreground ml-1 text-xs">({displayContext})</span>
            ) : null}
          </span>
        </PopoverAnchor>
        {isEditing && !disabled && (
          <PopoverContent
            data-grid-cell-editor=""
            align="start"
            sideOffset={sideOffset}
            className="w-[280px] rounded-none p-0"
            onOpenAutoFocus={onOpenAutoFocus}
          >
            <Command shouldFilter={false}>
              <CommandInput
                ref={inputRef}
                placeholder={t("ui:dataGrid.searchSymbol", "Search symbol or company...")}
                value={searchQuery}
                onValueChange={onSearchChange}
                onKeyDown={onInputKeyDown}
              />
              <CommandList>
                {isLoading ? <CommandEmpty>{t("ui:dataGrid.loading", "Loading...")}</CommandEmpty> : null}
                {!isLoading && !isError && options.length > 0 ? (
                  <CommandGroup>
                    {options.map((option) =>
                      (() => {
                        const normalizedOptionSymbol =
                          option.canonicalSymbol ||
                          (option.assetKind?.toUpperCase() === "CRYPTO"
                            ? normalizeCryptoPairSymbol(option.symbol, option.currency)
                            : option.symbol);

                        return (
                          <CommandItem
                            key={getOptionKey(option)}
                            value={getOptionKey(option)}
                            onSelect={() => handleSelect(option.symbol, option)}
                            className="flex items-center justify-between"
                          >
                            <div className="flex flex-col">
                              <span className="font-mono text-xs font-semibold uppercase">{option.symbol}</span>
                              <span className="text-muted-foreground text-xs">{displayName(option)}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-muted-foreground text-xs">{option.exchange}</span>
                              {value === normalizedOptionSymbol.toUpperCase() && <Icons.Check className="size-4" />}
                            </div>
                          </CommandItem>
                        );
                      })(),
                    )}
                  </CommandGroup>
                ) : null}
                {/* Always show "Create custom asset" option at the bottom when there's a query */}
                {!isLoading && trimmedQuery.length > 1 ? (
                  <CommandGroup>
                    <CommandItem
                      value={`create-${trimmedQuery}`}
                      onSelect={handleCustomSymbol}
                      className="flex items-center justify-between"
                    >
                      <div className="flex items-center gap-3">
                        <Icons.PlusCircle className="text-muted-foreground size-4" />
                        <div className="flex flex-col">
                          <span className="font-mono text-xs font-semibold uppercase">
                            {trimmedQuery.toUpperCase()}
                          </span>
                          <span className="text-muted-foreground text-xs font-light">
                            {t("ui:dataGrid.createCustomAsset", "Create custom asset")}
                          </span>
                        </div>
                      </div>
                    </CommandItem>
                  </CommandGroup>
                ) : null}
                {clearable && value && trimmedQuery.length === 0 ? (
                  <CommandGroup>
                    <CommandItem value="__clear__" onSelect={handleClear} className="flex items-center gap-3">
                      <Icons.X className="text-muted-foreground size-4" />
                      <span className="text-muted-foreground text-xs">
                        {t("ui:dataGrid.clearSymbol", "Clear symbol")}
                      </span>
                    </CommandItem>
                  </CommandGroup>
                ) : null}
              </CommandList>
            </Command>
          </PopoverContent>
        )}
      </Popover>
    </DataGridCellWrapper>
  );
}

export function CurrencyCell<TData>({
  cell,
  tableMeta,
  rowIndex,
  columnId,
  rowHeight,
  isFocused,
  isEditing,
  isSelected,
  isSearchMatch,
  isActiveSearchMatch,
  readOnly,
  cellState,
}: DataGridCellProps<TData>) {
  const { t } = useTranslation();
  const initialValue = cell.getValue() as string;
  const [value, setValue] = React.useState(initialValue ?? "");
  const [searchQuery, setSearchQuery] = React.useState("");
  const containerRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const sideOffset = -(containerRef.current?.clientHeight ?? 0);

  const prevInitialValueRef = React.useRef(initialValue);
  if (initialValue !== prevInitialValueRef.current) {
    prevInitialValueRef.current = initialValue;
    setValue(initialValue ?? "");
  }

  const filteredCurrencies = React.useMemo(() => {
    if (!searchQuery.trim()) {
      return quoteCurrencies;
    }
    const query = searchQuery.toLowerCase();
    return quoteCurrencies.filter(
      (currency) => currency.value.toLowerCase().includes(query) || currency.label.toLowerCase().includes(query),
    );
  }, [searchQuery]);

  const handleSelect = React.useCallback(
    (currencyValue: string) => {
      setValue(currencyValue);
      tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: currencyValue });
      setSearchQuery("");
      tableMeta?.onCellEditingStop?.();
    },
    [tableMeta, rowIndex, columnId],
  );

  const onOpenChange = React.useCallback(
    (isOpen: boolean) => {
      if (isOpen && !readOnly) {
        tableMeta?.onCellEditingStart?.(rowIndex, columnId);
      } else {
        setSearchQuery("");
        tableMeta?.onCellEditingStop?.();
      }
    },
    [tableMeta, rowIndex, columnId, readOnly],
  );

  const onOpenAutoFocus: NonNullable<React.ComponentProps<typeof PopoverContent>["onOpenAutoFocus"]> =
    React.useCallback((event) => {
      event.preventDefault();
      inputRef.current?.focus();
    }, []);

  const onWrapperKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (isEditing && event.key === "Escape") {
        event.preventDefault();
        setValue(initialValue ?? "");
        setSearchQuery("");
        tableMeta?.onCellEditingStop?.();
      } else if (!isEditing && isFocused && event.key === "Tab") {
        event.preventDefault();
        tableMeta?.onCellEditingStop?.({
          direction: event.shiftKey ? "left" : "right",
        });
      }
    },
    [isEditing, isFocused, initialValue, tableMeta],
  );

  const onInputKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setValue(initialValue ?? "");
        setSearchQuery("");
        tableMeta?.onCellEditingStop?.();
      } else if (event.key === "Tab") {
        event.preventDefault();
        setSearchQuery("");
        tableMeta?.onCellEditingStop?.({
          direction: event.shiftKey ? "left" : "right",
        });
      }
    },
    [initialValue, tableMeta],
  );

  return (
    <DataGridCellWrapper<TData>
      ref={containerRef}
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
      onKeyDown={onWrapperKeyDown}
    >
      <Popover open={isEditing} onOpenChange={onOpenChange}>
        <PopoverAnchor asChild>
          <span data-slot="grid-cell-content" className={cn(!value && "text-muted-foreground")}>
            {value || t("ui:dataGrid.currency", "Currency")}
          </span>
        </PopoverAnchor>
        {isEditing && (
          <PopoverContent
            data-grid-cell-editor=""
            align="start"
            sideOffset={sideOffset}
            className="w-[280px] rounded-none p-0"
            onOpenAutoFocus={onOpenAutoFocus}
          >
            <Command shouldFilter={false}>
              <CommandInput
                ref={inputRef}
                placeholder={t("ui:dataGrid.searchCurrency", "Search currency...")}
                value={searchQuery}
                onValueChange={setSearchQuery}
                onKeyDown={onInputKeyDown}
              />
              <CommandList>
                <CommandEmpty>{t("ui:dataGrid.noCurrencyFound", "No currency found.")}</CommandEmpty>
                <CommandGroup className="max-h-[300px] overflow-y-auto">
                  {filteredCurrencies.map((currency) => (
                    <CommandItem
                      key={currency.value}
                      value={currency.value}
                      onSelect={() => handleSelect(currency.value)}
                      className="flex items-center justify-between"
                    >
                      <div className="flex flex-col">
                        <span className="font-mono text-xs font-semibold">{currency.value}</span>
                        <span className="text-muted-foreground text-xs">{currency.label}</span>
                      </div>
                      {value === currency.value && <Icons.Check className="size-4" />}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        )}
      </Popover>
    </DataGridCellWrapper>
  );
}
