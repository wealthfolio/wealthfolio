import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { CategoryAllocation } from "@/lib/types";
import { allocationTargetColor } from "./allocation-target-colors";
import type { ModelPreset } from "./model-preset-data";
import { BUILT_IN_PRESETS, CATEGORY_LABELS, modelPresetTitle } from "./model-preset-data";

interface PresetBarProps {
  weights: Record<string, number>;
  colorMap: Record<string, string>;
}

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
  const categories = currentCategories.map((category, sortOrder) => ({
    id: category.categoryId,
    name: category.categoryName,
    sortOrder,
  }));
  const categoryNames = Object.fromEntries(
    categories.map((category) => [category.id, category.name]),
  );
  const currentColorMap = Object.fromEntries(
    currentCategories.map((category, index) => [
      category.categoryId,
      allocationTargetColor(category.categoryId, category.categoryName, index),
    ]),
  );

  const currentPreset: ModelPreset = {
    id: "current",
    taxonomyId,
    weights: Object.fromEntries(
      currentCategories.map((category) => [category.categoryId, category.percentage]),
    ),
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

  const taxonomyPresets = BUILT_IN_PRESETS.filter((preset) => preset.taxonomyId === taxonomyId)
    .map((preset) => ({ preset, title: modelPresetTitle(preset, categories) }))
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
          "bg-card/70 group relative flex flex-col overflow-hidden rounded-lg border text-left shadow-sm transition-colors",
          compact ? "min-h-36 px-3.5 py-3.5" : "min-h-48 px-4 py-5",
          selected === preset.id
            ? "border-foreground bg-card"
            : "border-border/70 hover:border-muted-foreground/40 hover:bg-card",
        )}
      >
        <div className="via-muted-foreground/20 pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
        <div className="flex items-start justify-between gap-3">
          <span className="bg-muted text-muted-foreground shrink-0 rounded-md px-2 py-1 text-[10px] font-medium">
            {current
              ? t("allocation:presets.currentAllocation")
              : t("allocation:presets.exampleWeights")}
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
          {title}
        </span>
        <p
          className={cn(
            "text-muted-foreground mt-2 text-[12px] leading-relaxed",
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
      <p className="text-muted-foreground text-[11px] leading-relaxed">
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
            modelPresetTitle(currentPreset, categories) || t("allocation:presets.noCurrentHoldings")
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
                "inline-flex h-8 max-w-full items-center gap-2 rounded-full border px-3 text-[12px] font-semibold transition-colors",
                selected === preset.id
                  ? "border-foreground bg-foreground text-background"
                  : "bg-card hover:border-muted-foreground/50",
              )}
              title={title}
            >
              <span className="truncate">{title}</span>
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
