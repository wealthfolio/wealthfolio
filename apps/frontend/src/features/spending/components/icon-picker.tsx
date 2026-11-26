import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { useDirection } from "@wealthfolio/ui/components/ui/direction";

import { Icons, Input, Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui";

import { cn } from "@/lib/utils";
import { LUCIDE_CATEGORY_ICON_NAMES } from "../lib/category-icons";
import { CategoryIcon } from "./category-chips";

interface IconPickerProps {
  value: string | null | undefined;
  onChange: (icon: string | null) => void;
  /** Tint color for the selected icon preview (matches category color). */
  accent?: string | null;
  /** Compact icon-only trigger (square button) instead of the full labeled row. */
  compact?: boolean;
}

export function IconPicker({ value, onChange, accent, compact = false }: IconPickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const sizingGrid = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(8);
  const columnsRef = useRef(8);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const pendingFocus = useRef<number | null>(null);
  const direction = useDirection();
  const displayValue = value?.startsWith("lucide:") ? value.slice(7).replaceAll("-", " ") : value;

  useLayoutEffect(() => {
    if (!scrollElement || !sizingGrid.current) return;
    const grid = sizingGrid.current;
    const measure = () => {
      const cell = grid.firstElementChild?.getBoundingClientRect().width ?? 0;
      if (!cell) return;
      const gap = Number.parseFloat(getComputedStyle(grid).columnGap) || 0;
      const style = getComputedStyle(scrollElement);
      const available =
        scrollElement.clientWidth -
        (Number.parseFloat(style.paddingLeft) || 0) -
        (Number.parseFloat(style.paddingRight) || 0);
      const next = Math.max(1, Math.min(8, Math.floor((available + gap + 0.01) / (cell + gap))));
      if (columnsRef.current === next) return;
      if (scrollElement.contains(document.activeElement)) {
        const index = (document.activeElement as HTMLElement).dataset.iconIndex;
        if (index !== undefined) pendingFocus.current = Number(index);
      }
      columnsRef.current = next;
      setColumns(next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(scrollElement);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [scrollElement]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/\s+/g, "-");
    if (!q) return LUCIDE_CATEGORY_ICON_NAMES;
    return LUCIDE_CATEGORY_ICON_NAMES.filter((name) => name.includes(q));
  }, [query]);
  const virtualizer = useVirtualizer({
    count: Math.ceil(filtered.length / columns),
    getScrollElement: () => scrollElement,
    estimateSize: () => 36,
    overscan: 2,
    rangeExtractor: (range) => {
      const rows = defaultRangeExtractor(range);
      const focusedRow = focusedIndex === null ? -1 : Math.floor(focusedIndex / columns);
      return focusedRow >= 0 && focusedRow < range.count && !rows.includes(focusedRow)
        ? [...rows, focusedRow].sort((a, b) => a - b)
        : rows;
    },
  });

  const moveFocus = (index: number) => {
    if (index < 0 || index >= filtered.length) return;
    setFocusedIndex(index);
    pendingFocus.current = index;
    virtualizer.scrollToIndex(Math.floor(index / columns));
    const button = scrollElement?.querySelector<HTMLButtonElement>(`[data-icon-index="${index}"]`);
    if (button) {
      pendingFocus.current = null;
      button.focus();
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setFocusedIndex(null);
          pendingFocus.current = null;
        }
      }}
    >
      <PopoverTrigger
        render={
          compact ? (
            <button
              type="button"
              className="border-input bg-background hover:bg-muted/40 ring-offset-background focus-visible:ring-ring flex h-8 w-9 items-center justify-center rounded-md border transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              style={accent ? { color: accent } : undefined}
              aria-label={
                value
                  ? t("spending:category.iconLabel", { name: displayValue })
                  : t("spending:category.chooseIcon")
              }
            >
              <CategoryIcon icon={value ?? null} className="h-4 w-4" />
            </button>
          ) : (
            <button
              type="button"
              className="border-input bg-background hover:bg-muted/40 ring-offset-background focus-visible:ring-ring flex h-10 w-full items-center gap-2 rounded-md border px-3 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            >
              <CategoryIcon icon={value ?? null} className="h-4 w-4 shrink-0" />
              <span
                className={cn(
                  "flex-1 truncate text-start",
                  value ? "text-foreground" : "text-muted-foreground/70",
                )}
              >
                {displayValue ?? t("spending:category.chooseIcon")}
              </span>
              <Icons.ChevronDown className="text-muted-foreground/60 h-3.5 w-3.5 shrink-0" />
            </button>
          )
        }
      />
      {/* The mobile global max-width rule otherwise overrides the available-width cap. */}
      <PopoverContent
        className="w-max max-w-[min(var(--available-width),calc(100vw_-_2rem))]! p-3"
        align="start"
      >
        <div className="w-max max-w-full! space-y-3">
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setFocusedIndex(null);
              pendingFocus.current = null;
              if (scrollElement) scrollElement.scrollTop = 0;
            }}
            placeholder={t("spending:category.searchIcons")}
            className="h-8 text-xs"
            autoFocus
          />
          {open && (
            <div
              ref={setScrollElement}
              className="max-h-64 w-max max-w-full! [scrollbar-gutter:stable] overflow-y-auto pe-1"
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setFocusedIndex(null);
              }}
            >
              <div
                ref={sizingGrid}
                aria-hidden="true"
                className="invisible grid h-0 w-max max-w-full! grid-cols-8 gap-1 overflow-hidden"
              >
                {Array.from({ length: 8 }, (_, index) => (
                  <span key={index} className="h-8 w-8" />
                ))}
              </div>
              {filtered.length === 0 ? (
                <div className="text-muted-foreground w-0 min-w-full py-4 text-center text-xs break-words">
                  {t("spending:category.noIconsMatch", { query })}
                </div>
              ) : (
                <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                  {virtualizer.getVirtualItems().map((row) => (
                    <div
                      key={row.key}
                      className="absolute start-0 grid w-full gap-1"
                      style={{
                        top: row.start,
                        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                      }}
                    >
                      {filtered
                        .slice(row.index * columns, row.index * columns + columns)
                        .map((name, column) => {
                          const index = row.index * columns + column;
                          const iconValue = `lucide:${name}`;
                          const isActive = iconValue === value;
                          const label = name.replaceAll("-", " ");
                          return (
                            <button
                              key={name}
                              ref={(element) => {
                                if (element && pendingFocus.current === index) {
                                  pendingFocus.current = null;
                                  element.focus();
                                }
                              }}
                              data-icon-index={index}
                              type="button"
                              aria-label={label}
                              aria-pressed={isActive}
                              tabIndex={
                                focusedIndex === null
                                  ? index === row.index * columns &&
                                    row.index === virtualizer.getVirtualItems()[0]?.index
                                    ? 0
                                    : -1
                                  : focusedIndex === index
                                    ? 0
                                    : -1
                              }
                              onFocus={() => setFocusedIndex(index)}
                              onKeyDown={(event) => {
                                const horizontal = direction === "rtl" ? -1 : 1;
                                const delta =
                                  event.key === "ArrowRight"
                                    ? horizontal
                                    : event.key === "ArrowLeft"
                                      ? -horizontal
                                      : event.key === "ArrowDown"
                                        ? columns
                                        : event.key === "ArrowUp"
                                          ? -columns
                                          : 0;
                                if (delta) {
                                  event.preventDefault();
                                  moveFocus(index + delta);
                                }
                              }}
                              onClick={() => {
                                onChange(isActive ? null : iconValue);
                                setOpen(false);
                              }}
                              className={cn(
                                "hover:bg-muted flex h-8 w-8 items-center justify-center rounded-md transition-colors",
                                isActive && "bg-muted ring-foreground/40 ring-1 ring-inset",
                              )}
                              title={label}
                              style={isActive && accent ? { color: accent } : undefined}
                            >
                              <CategoryIcon icon={iconValue} className="h-4 w-4" />
                            </button>
                          );
                        })}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {value && (
            <button
              type="button"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
              className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
            >
              {t("spending:category.clearIcon")}
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
