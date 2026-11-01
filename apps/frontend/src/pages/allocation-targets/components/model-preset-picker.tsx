import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { CategoryAllocation } from "@/lib/types";
import {
  allocationTargetColorForRow,
  type AllocationTargetColorMap,
} from "./allocation-target-colors";
import type { ModelPreset } from "./model-preset-data";
import { BUILT_IN_PRESETS, modelPresetTitle } from "./model-preset-data";

interface PresetBarProps {
  weights: Record<string, number>;
  colorMap: Record<string, string>;
}

function PresetBar({ weights, colorMap }: PresetBarProps) {
  const nonZero = Object.entries(weights).filter(([, pct]) => pct > 0);
  return (
    <div className="flex h-3.5 w-full overflow-hidden rounded-sm">
      {nonZero.map(([key, pct]) => (
        <div
          key={key}
          style={{ width: `${pct}%`, background: colorMap[key] ?? "var(--chart-stone)" }}
        />
      ))}
    </div>
  );
}

interface ModelPresetPickerProps {
  taxonomyId: string;
  selected: string | null;
  onSelect: (presetId: string) => void;
  currentCategories: CategoryAllocation[];
  colorByCategory: AllocationTargetColorMap;
  compact?: boolean;
}

export function ModelPresetPicker({
  taxonomyId,
  selected,
  onSelect,
  currentCategories,
  colorByCategory,
  compact = false,
}: ModelPresetPickerProps) {
  const { t } = useTranslation();
  const categories = currentCategories.map((category, sortOrder) => ({
    id: category.categoryId,
    name: category.categoryName,
    sortOrder,
  }));

  const currentPreset: ModelPreset = {
    id: "current",
    taxonomyId,
    weights: Object.fromEntries(
      currentCategories.map((category) => [category.categoryId, category.percentage]),
    ),
  };

  function colorMapForWeights(weights: Record<string, number>): Record<string, string> {
    return Object.fromEntries(
      Object.keys(weights).map((categoryId, index) => [
        categoryId,
        allocationTargetColorForRow({ categoryId }, colorByCategory, index),
      ]),
    );
  }

  const taxonomyPresets = BUILT_IN_PRESETS.filter((preset) => preset.taxonomyId === taxonomyId)
    .map((preset) => ({ preset, title: modelPresetTitle(preset, categories, t) }))
    .sort((left, right) => left.title.localeCompare(right.title));
  const primaryPresets = taxonomyPresets.slice(0, 3);
  const secondaryPresets = taxonomyPresets.slice(3);
  const scratchSelected = selected === "scratch";

  function PresetCard({
    preset,
    title,
    current = false,
  }: {
    preset: ModelPreset;
    title: string;
    current?: boolean;
  }) {
    return (
      <button
        type="button"
        onClick={() => onSelect(preset.id)}
        className={cn(
          "bg-card/70 group relative flex flex-col overflow-hidden rounded-lg border text-start shadow-sm transition-colors",
          compact ? "min-h-36 px-3.5 py-3.5" : "min-h-48 px-4 py-5",
          selected === preset.id
            ? "border-foreground bg-card"
            : "border-border/70 hover:border-muted-foreground/40 hover:bg-card",
        )}
      >
        <div className="via-muted-foreground/20 pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
        <div className="flex items-start justify-between gap-3">
          <span className="bg-muted text-muted-foreground text-2xs shrink-0 rounded-md px-2 py-1 font-medium">
            {current
              ? t("allocation:presets.currentAllocation")
              : t("allocation:presets.exampleWeights")}
          </span>
          {selected === preset.id && (
            <span className="bg-foreground text-background text-2xs flex h-5 w-5 shrink-0 items-center justify-center rounded-full">
              ✓
            </span>
          )}
        </div>
        <span
          className={cn(
            "text-foreground text-base font-semibold leading-tight",
            compact ? "mt-3" : "mt-4",
          )}
        >
          {title}
        </span>
        <p
          className={cn(
            "text-muted-foreground mt-2 text-xs leading-relaxed",
            compact ? "max-h-9 min-h-9 overflow-hidden" : "min-h-10",
          )}
        >
          {current
            ? t("allocation:presets.currentAllocationDescription")
            : t("allocation:presets.exampleDescription")}
        </p>
        <div className={cn("mt-auto space-y-2.5", compact ? "pt-4" : "pt-7")}>
          <PresetBar weights={preset.weights} colorMap={colorMapForWeights(preset.weights)} />
        </div>
      </button>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-2xs leading-relaxed">
        {t("allocation:presets.disclosure")}
      </p>
      <div
        className={cn(
          "grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4",
          compact ? "gap-3" : "gap-4",
        )}
      >
        {primaryPresets.map(({ preset, title }) => (
          <PresetCard key={preset.id} preset={preset} title={title} />
        ))}
        <PresetCard
          preset={currentPreset}
          title={
            modelPresetTitle(currentPreset, categories, t) ||
            t("allocation:presets.noCurrentHoldings")
          }
          current
        />
      </div>

      {(secondaryPresets.length > 0 || compact) && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {secondaryPresets.map(({ preset, title }) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => onSelect(preset.id)}
              className={cn(
                "inline-flex h-8 max-w-full items-center gap-2 rounded-full border px-3 text-xs font-semibold transition-colors",
                selected === preset.id
                  ? "border-foreground bg-foreground text-background"
                  : "bg-card hover:border-muted-foreground/50",
              )}
              title={title}
            >
              <span className="truncate">{title}</span>
              {selected === preset.id && <span className="text-2xs">✓</span>}
            </button>
          ))}
          <button
            type="button"
            onClick={() => onSelect("scratch")}
            className={cn(
              "inline-flex h-8 items-center gap-2 rounded-full border px-3 text-xs font-semibold transition-colors",
              scratchSelected
                ? "border-foreground bg-foreground text-background"
                : "bg-card hover:border-muted-foreground/50",
            )}
          >
            {t("allocation:presets.buildFromScratch")}
            {scratchSelected && <span className="text-2xs">✓</span>}
          </button>
        </div>
      )}
    </div>
  );
}
