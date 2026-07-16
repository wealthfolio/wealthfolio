import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { CategoryAllocation } from "@/lib/types";
import { allocationTargetColor } from "./allocation-target-colors";
import type { ModelPreset } from "./model-preset-data";
import { BUILT_IN_PRESETS } from "./model-preset-data";

export type { ModelPreset };
export { BUILT_IN_PRESETS };

interface PresetBarProps {
  weights: Record<string, number>;
  colorMap: Record<string, string>;
}

const CATEGORY_LABELS: Record<string, string> = {
  CASH: "Cash",
  EQUITY: "Equity",
  FIXED_INCOME: "Fixed Income",
  REAL_ESTATE: "Real Estate",
  COMMODITIES: "Commodities",
  ALTERNATIVES: "Alternatives",
  DIGITAL_ASSETS: "Digital Assets",
  "10": "Energy",
  "15": "Materials",
  "20": "Industrials",
  "25": "Consumer Discretionary",
  "30": "Consumer Staples",
  "35": "Health Care",
  "40": "Financials",
  "45": "Information Technology",
  "50": "Communication Services",
  "55": "Utilities",
  "60": "Real Estate",
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  R10: "Europe",
  R20: "Americas",
  R30: "Asia",
  R40: "Africa",
  R50: "Oceania",
};

const RISK_BADGE: Record<string, string> = {
  Conservative: "bg-[#dfe8dc] text-[#4f6544] dark:bg-green-900/30 dark:text-green-300",
  Moderate: "bg-[#eee5bf] text-[#746633] dark:bg-amber-900/30 dark:text-amber-300",
  Aggressive: "bg-[#eadbd3] text-[#8a5b45] dark:bg-red-900/30 dark:text-red-300",
  "From holdings": "bg-muted text-muted-foreground",
};

function PresetBar({ weights, colorMap }: PresetBarProps) {
  const nonZero = Object.entries(weights).filter(([, pct]) => pct > 0);
  return (
    <div className="flex h-3.5 w-full overflow-hidden rounded-sm">
      {nonZero.map(([key, pct]) => (
        <div key={key} style={{ width: `${pct}%`, background: colorMap[key] ?? "#878580" }} />
      ))}
    </div>
  );
}

function formattedPct(value: number): string {
  return Number.isInteger(value) ? `${value}%` : `${value.toFixed(1)}%`;
}

interface ModelPresetPickerProps {
  taxonomyId: string;
  selected: string | null;
  onSelect: (presetId: string) => void;
  currentCategories: CategoryAllocation[];
  compact?: boolean;
}

export function ModelPresetPicker({
  taxonomyId,
  selected,
  onSelect,
  currentCategories,
  compact = false,
}: ModelPresetPickerProps) {
  const { t } = useTranslation();
  const categoryNames = Object.fromEntries(
    currentCategories.map((category) => [category.categoryId, category.categoryName]),
  );
  const currentColorMap = Object.fromEntries(
    currentCategories.map((category, index) => [
      category.categoryId,
      allocationTargetColor(category.categoryId, category.categoryName, index),
    ]),
  );

  const currentWeights = Object.fromEntries(
    currentCategories.map((category) => [category.categoryId, category.percentage]),
  );

  const currentPreset: ModelPreset = {
    id: "current",
    taxonomyId,
    name: t("allocation:presets.currentAllocation"),
    description: t("allocation:presets.currentAllocationDescription"),
    risk: "From holdings",
    featured: true,
    weights: currentWeights,
  };

  function categoryLabel(categoryId: string): string {
    return categoryNames[categoryId] ?? CATEGORY_LABELS[categoryId] ?? categoryId;
  }

  function colorMapForWeights(weights: Record<string, number>): Record<string, string> {
    return Object.fromEntries(
      Object.keys(weights).map((categoryId, index) => [
        categoryId,
        currentColorMap[categoryId] ??
          allocationTargetColor(categoryId, categoryLabel(categoryId), index),
      ]),
    );
  }

  function allocationSummary(weights: Record<string, number>): string {
    const nonZero = Object.entries(weights)
      .filter(([, pct]) => pct > 0)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3);

    if (nonZero.length === 0) return t("allocation:presets.noCurrentHoldings");

    return nonZero
      .map(([categoryId, pct]) => `${categoryLabel(categoryId)} ${formattedPct(pct)}`)
      .join(" / ");
  }

  const taxonomyPresets = BUILT_IN_PRESETS.filter((preset) => preset.taxonomyId === taxonomyId);
  const explicitFeatured = taxonomyPresets.filter((preset) => preset.featured);
  const featuredPresets =
    explicitFeatured.length > 0 ? explicitFeatured : taxonomyPresets.slice(0, 3);
  const featuredIds = new Set(featuredPresets.map((preset) => preset.id));
  const secondaryPresets = taxonomyPresets.filter((preset) => !featuredIds.has(preset.id));
  const cardPresets = [...featuredPresets, currentPreset];
  const scratchSelected = selected === "scratch";

  function PresetCard({ preset }: { preset: ModelPreset }) {
    return (
      <button
        type="button"
        onClick={() => onSelect(preset.id)}
        className={cn(
          "bg-card/70 group relative flex flex-col overflow-hidden rounded-lg border text-left shadow-sm transition-colors",
          compact ? "min-h-36 px-3.5 py-3.5" : "min-h-48 px-4 py-5",
          selected === preset.id
            ? "border-foreground bg-card"
            : "border-border/70 hover:border-muted-foreground/40 hover:bg-card",
        )}
      >
        <div className="via-muted-foreground/20 pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
        <div className="flex items-start justify-between gap-3">
          <span
            className={cn(
              "shrink-0 rounded-md px-2 py-1 text-[10px] font-medium",
              RISK_BADGE[preset.risk] ?? "bg-muted text-muted-foreground",
            )}
          >
            {preset.risk}
          </span>
          {selected === preset.id && (
            <span className="bg-foreground text-background flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px]">
              ✓
            </span>
          )}
        </div>
        <span
          className={cn(
            "text-foreground text-[15px] font-semibold leading-tight",
            compact ? "mt-3" : "mt-4",
          )}
        >
          {preset.name}
        </span>
        <p
          className={cn(
            "text-muted-foreground mt-2 text-[12px] leading-relaxed",
            compact ? "max-h-9 min-h-9 overflow-hidden" : "min-h-10",
          )}
        >
          {preset.description}
        </p>
        <div className={cn("mt-auto space-y-2.5", compact ? "pt-4" : "pt-7")}>
          <PresetBar weights={preset.weights} colorMap={colorMapForWeights(preset.weights)} />
          <div className={cn("border-border/60 border-t", compact ? "pt-2" : "pt-2.5")} />
          <p className="text-muted-foreground truncate text-[11px] font-medium">
            {allocationSummary(preset.weights)}
          </p>
        </div>
      </button>
    );
  }

  return (
    <div className="space-y-3">
      <div
        className={cn(
          "grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4",
          compact ? "gap-3" : "gap-4",
        )}
      >
        {cardPresets.map((preset) => (
          <PresetCard key={preset.id} preset={preset} />
        ))}
      </div>

      {(secondaryPresets.length > 0 || compact) && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {secondaryPresets.length > 0 && (
            <span className="text-muted-foreground mr-1 text-[11px] font-medium uppercase tracking-wider">
              {t("allocation:presets.moreTemplates")}
            </span>
          )}
          {secondaryPresets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => onSelect(preset.id)}
              className={cn(
                "inline-flex h-8 items-center gap-2 rounded-full border px-3 text-[12px] font-semibold transition-colors",
                selected === preset.id
                  ? "border-foreground bg-foreground text-background"
                  : "bg-card hover:border-muted-foreground/50",
              )}
              title={allocationSummary(preset.weights)}
            >
              {preset.name}
              {selected === preset.id && <span className="text-[10px]">✓</span>}
            </button>
          ))}
          <button
            type="button"
            onClick={() => onSelect("scratch")}
            className={cn(
              "inline-flex h-8 items-center gap-2 rounded-full border px-3 text-[12px] font-semibold transition-colors",
              scratchSelected
                ? "border-foreground bg-foreground text-background"
                : "bg-card hover:border-muted-foreground/50",
            )}
          >
            {t("allocation:presets.buildFromScratch")}
            {scratchSelected && <span className="text-[10px]">✓</span>}
          </button>
        </div>
      )}
    </div>
  );
}
