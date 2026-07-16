import { AnimatedToggleGroup } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";

import type { BandType } from "@/lib/types";

interface DriftBandSliderProps {
  driftBandPct: number;
  onDriftBandChange: (value: number) => void;
  bandType: BandType;
  onBandTypeChange: (bandType: BandType) => void;
  relativeFactorPct: number;
  onRelativeFactorChange: (value: number) => void;
  className?: string;
}

const MIN_DRIFT_BAND = 0.5;
const MAX_DRIFT_BAND = 10;
const MIN_RELATIVE_FACTOR = 5;
const MAX_RELATIVE_FACTOR = 50;

const DEFAULT_ABSOLUTE_PCT = 5;
const DEFAULT_HYBRID_FLOOR_PCT = 1;
const DEFAULT_RELATIVE_FACTOR_PCT = 20;

export function DriftBandSlider({
  driftBandPct,
  onDriftBandChange,
  bandType,
  onBandTypeChange,
  relativeFactorPct,
  onRelativeFactorChange,
  className,
}: DriftBandSliderProps) {
  const { t } = useTranslation();
  const isHybrid = bandType === "hybrid";
  const floorPct = ((driftBandPct - MIN_DRIFT_BAND) / (MAX_DRIFT_BAND - MIN_DRIFT_BAND)) * 100;
  const relativePct =
    ((relativeFactorPct - MIN_RELATIVE_FACTOR) / (MAX_RELATIVE_FACTOR - MIN_RELATIVE_FACTOR)) * 100;

  function handleBandTypeChange(next: BandType) {
    if (next === bandType) return;
    onBandTypeChange(next);
    if (next === "hybrid") {
      onRelativeFactorChange(DEFAULT_RELATIVE_FACTOR_PCT);
      onDriftBandChange(DEFAULT_HYBRID_FLOOR_PCT);
    } else {
      onDriftBandChange(DEFAULT_ABSOLUTE_PCT);
    }
  }

  return (
    <div className={className}>
      <AnimatedToggleGroup<BandType>
        value={bandType}
        onValueChange={handleBandTypeChange}
        items={[
          { value: "hybrid", label: t("allocation:band.hybrid") },
          { value: "absolute", label: t("allocation:band.absolute") },
        ]}
        rounded="lg"
        className="bg-muted/30 [&_button:has(>div)]:text-primary-foreground [&_button:not(:has(>div))]:text-muted-foreground [&_button>div]:bg-primary w-full border [&_button]:flex-1 [&_button]:py-2 [&_button]:text-[12px]"
      />
      <p className="text-muted-foreground mt-2 text-[11px] leading-relaxed">
        {isHybrid
          ? t("allocation:band.hybridDescription")
          : t("allocation:band.absoluteDescription")}
      </p>

      {isHybrid && (
        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-foreground text-[12px] font-medium">
              {t("allocation:band.relativeFactor")}
            </span>
            <span className="bg-muted text-foreground rounded-md px-2 py-0.5 text-[12px] font-semibold tabular-nums">
              {t("allocation:band.percentOfTarget", { value: relativeFactorPct })}
            </span>
          </div>
          <input
            type="range"
            min={MIN_RELATIVE_FACTOR}
            max={MAX_RELATIVE_FACTOR}
            step={5}
            value={relativeFactorPct}
            onChange={(event) => onRelativeFactorChange(parseFloat(event.target.value))}
            className="lever-slider block w-full"
            style={{ ["--lever-pct" as string]: `${relativePct}%` }}
          />
          <div className="text-muted-foreground mt-1.5 flex justify-between text-[10px]">
            <span>{t("allocation:band.tight")}</span>
            <span>{t("allocation:band.standard")}</span>
            <span>{t("allocation:band.loose")}</span>
          </div>
        </div>
      )}

      <div className="mt-4">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-foreground text-[12px] font-medium">
            {isHybrid ? t("allocation:band.absoluteFloor") : t("allocation:band.bandWidth")}
          </span>
          <span className="bg-muted text-foreground rounded-md px-2 py-0.5 text-[12px] font-semibold tabular-nums">
            ±{driftBandPct.toFixed(1)}%
          </span>
        </div>
        <input
          type="range"
          min={MIN_DRIFT_BAND}
          max={MAX_DRIFT_BAND}
          step={0.5}
          value={driftBandPct}
          onChange={(event) => onDriftBandChange(parseFloat(event.target.value))}
          className="lever-slider block w-full"
          style={{ ["--lever-pct" as string]: `${floorPct}%` }}
        />
        <div className="text-muted-foreground mt-1.5 flex justify-between text-[10px]">
          <span>{t("allocation:band.tight")}</span>
          <span>{t("allocation:band.standard")}</span>
          <span>{t("allocation:band.loose")}</span>
        </div>
        {isHybrid && (
          <p className="text-muted-foreground mt-1.5 text-[11px] leading-relaxed">
            {t("allocation:band.minimumBandNote")}
          </p>
        )}
      </div>
    </div>
  );
}
