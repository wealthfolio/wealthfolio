import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icons, Input, Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui";

import { cn } from "@/lib/utils";
import { CATEGORY_ICON_NAMES } from "../lib/category-icons";
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return CATEGORY_ICON_NAMES;
    return CATEGORY_ICON_NAMES.filter((name) => name.toLowerCase().includes(q));
  }, [query]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {compact ? (
          <button
            type="button"
            className="border-input bg-background hover:bg-muted/40 ring-offset-background focus-visible:ring-ring flex h-8 w-9 items-center justify-center rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
            style={accent ? { color: accent } : undefined}
            aria-label={
              value
                ? t("spending:category.iconLabel", { name: value })
                : t("spending:category.chooseIcon")
            }
          >
            <CategoryIcon icon={value ?? null} className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="button"
            className="border-input bg-background hover:bg-muted/40 ring-offset-background focus-visible:ring-ring flex h-10 w-full items-center gap-2 rounded-md border px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
          >
            <CategoryIcon icon={value ?? null} className="h-4 w-4 shrink-0" />
            <span
              className={cn(
                "flex-1 truncate text-left",
                value ? "text-foreground" : "text-muted-foreground/70",
              )}
            >
              {value ?? t("spending:category.chooseIcon")}
            </span>
            <Icons.ChevronDown className="text-muted-foreground/60 h-3.5 w-3.5 shrink-0" />
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3" align="start">
        <div className="space-y-3">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("spending:category.searchIcons")}
            className="h-8 text-xs"
            autoFocus
          />
          <div className="grid max-h-64 grid-cols-8 gap-1 overflow-y-auto pr-1">
            {filtered.map((name) => {
              const isActive = name === value;
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() => {
                    onChange(isActive ? null : name);
                    setOpen(false);
                  }}
                  className={cn(
                    "hover:bg-muted flex h-8 w-8 items-center justify-center rounded-md transition-colors",
                    isActive && "bg-muted ring-foreground/40 ring-1 ring-inset",
                  )}
                  title={name}
                  style={isActive && accent ? { color: accent } : undefined}
                >
                  <CategoryIcon icon={name} className="h-4 w-4" />
                </button>
              );
            })}
            {filtered.length === 0 && (
              <div className="text-muted-foreground col-span-8 py-4 text-center text-xs">
                {t("spending:category.noIconsMatch", { query })}
              </div>
            )}
          </div>
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
