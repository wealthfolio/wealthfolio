import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icons, Input, Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui";

import { cn } from "@/lib/utils";

/** Curated extended palette — shades grouped roughly by hue, in 5 columns × 7 rows. */
export const EXTENDED_PALETTE: string[] = [
  // Reds
  "#fecaca",
  "#f87171",
  "#ef4444",
  "#dc2626",
  "#991b1b",
  // Oranges
  "#fed7aa",
  "#fb923c",
  "#f97316",
  "#ea580c",
  "#9a3412",
  // Yellows
  "#fef08a",
  "#facc15",
  "#eab308",
  "#ca8a04",
  "#854d0e",
  // Greens
  "#bbf7d0",
  "#4ade80",
  "#22c55e",
  "#16a34a",
  "#166534",
  // Teals/Cyans
  "#a7f3d0",
  "#2dd4bf",
  "#14b8a6",
  "#0d9488",
  "#115e59",
  // Blues
  "#bfdbfe",
  "#60a5fa",
  "#3b82f6",
  "#2563eb",
  "#1e40af",
  // Purples/Pinks
  "#e9d5ff",
  "#c084fc",
  "#8b5cf6",
  "#a855f7",
  "#7e22ce",
  // Pinks
  "#fbcfe8",
  "#f472b6",
  "#ec4899",
  "#db2777",
  "#9d174d",
  // Neutrals
  "#e5e7eb",
  "#9ca3af",
  "#6b7280",
  "#4b5563",
  "#1f2937",
];

interface ColorPickerProps {
  value: string | undefined;
  onChange: (color: string) => void;
  /** Hex strings that should be highlighted as part of the parent's preset row. */
  presets?: string[];
}

const HEX_PATTERN = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;

/**
 * In-app color picker — popover with extended palette + hex text input.
 * Avoids the OS native color picker (which renders outside the Tauri window).
 */
export function ColorPicker({ value, onChange, presets = [] }: ColorPickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [hexInput, setHexInput] = useState(value ?? "#888888");

  useEffect(() => {
    if (value) setHexInput(value);
  }, [value]);

  const isCustom = !!value && !presets.map((p) => p.toLowerCase()).includes(value.toLowerCase());

  const commitHex = () => {
    if (HEX_PATTERN.test(hexInput)) onChange(hexInput);
    else setHexInput(value ?? "#888888"); // revert
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "relative flex h-8 w-8 items-center justify-center rounded-full border-2 transition-transform hover:scale-110",
            isCustom ? "border-foreground ring-2 ring-offset-2" : "border-border/60",
          )}
          style={
            isCustom
              ? { backgroundColor: value }
              : {
                  backgroundImage:
                    "conic-gradient(from 0deg, #ef4444, #f59e0b, #22c55e, #06b6d4, #6366f1, #d946ef, #ef4444)",
                }
          }
          aria-label={t("spending:category.pickCustomColor")}
        >
          {!isCustom && (
            <Icons.Plus className="text-foreground h-4 w-4 drop-shadow-[0_0_2px_rgba(0,0,0,0.6)]" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3" align="start">
        <div className="space-y-3">
          <div className="grid grid-cols-5 gap-1.5">
            {EXTENDED_PALETTE.map((color) => {
              const isActive = value?.toLowerCase() === color.toLowerCase();
              return (
                <button
                  key={color}
                  type="button"
                  onClick={() => {
                    onChange(color);
                    setOpen(false);
                  }}
                  className={cn(
                    "h-7 w-7 rounded-full border-2 transition-transform hover:scale-110",
                    isActive ? "border-foreground" : "border-transparent",
                  )}
                  style={{ backgroundColor: color }}
                  aria-label={t("spending:category.useColor", { color })}
                />
              );
            })}
          </div>
          <div className="space-y-1.5">
            <label className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wide">
              {t("spending:category.hex")}
            </label>
            <div className="flex items-center gap-2">
              <span
                className="border-border/60 h-7 w-7 shrink-0 rounded-full border"
                style={{
                  backgroundColor: HEX_PATTERN.test(hexInput) ? hexInput : "transparent",
                }}
              />
              <Input
                value={hexInput}
                onChange={(e) => setHexInput(e.target.value)}
                onBlur={commitHex}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitHex();
                    setOpen(false);
                  }
                }}
                placeholder="#888888"
                className="h-8 font-mono text-xs"
                spellCheck={false}
              />
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
