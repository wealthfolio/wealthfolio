import { AnimatedToggleGroup } from "@wealthfolio/ui";

import type { BandType } from "@/lib/types";

interface DriftBandSliderProps {
  driftBandPct: number;
  onDriftBandChange: (value: number) => void;
  bandType: BandType;
  onBandTypeChange: (bandType: BandType) => void;
  relativeFactorPct: number;
  onRelativeFactorChange: (value: number) => void;
  language: string;
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
  language,
  className,
}: DriftBandSliderProps) {
  const isChinese = language === "zh-CN";
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
          { value: "hybrid", label: isChinese ? "混合" : "Hybrid" },
          { value: "absolute", label: isChinese ? "固定" : "Absolute" },
        ]}
        rounded="lg"
        className="bg-muted/30 [&_button:has(>div)]:text-primary-foreground [&_button:not(:has(>div))]:text-muted-foreground [&_button>div]:bg-primary w-full border [&_button]:flex-1 [&_button]:py-2 [&_button]:text-[12px]"
      />
      <p className="text-muted-foreground mt-2 text-[11px] leading-relaxed">
        {isHybrid
          ? isChinese
            ? "每个分类的容忍带会随目标权重缩放。小权重分类会更严格；绝对下限可避免过小交易。"
            : "Each sleeve's band scales with its target weight. Small sleeves get tighter bands; the absolute floor prevents micro-trades."
          : isChinese
            ? "所有分类使用相同的固定容忍带，不受目标权重影响。"
            : "Same fixed band applied to every sleeve regardless of its target weight."}
      </p>

      {isHybrid && (
        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-foreground text-[12px] font-medium">
              {isChinese ? "相对系数" : "Relative factor"}
            </span>
            <span className="bg-muted text-foreground rounded-md px-2 py-0.5 text-[12px] font-semibold tabular-nums">
              {isChinese ? `目标的 ±${relativeFactorPct}%` : `±${relativeFactorPct}% of target`}
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
            <span>{isChinese ? "严格" : "Tight"}</span>
            <span>{isChinese ? "标准" : "Standard"}</span>
            <span>{isChinese ? "宽松" : "Loose"}</span>
          </div>
        </div>
      )}

      <div className="mt-4">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-foreground text-[12px] font-medium">
            {isHybrid
              ? isChinese
                ? "绝对下限"
                : "Absolute floor"
              : isChinese
                ? "容忍带宽度"
                : "Band width"}
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
          <span>{isChinese ? "严格" : "Tight"}</span>
          <span>{isChinese ? "标准" : "Standard"}</span>
          <span>{isChinese ? "宽松" : "Loose"}</span>
        </div>
        {isHybrid && (
          <p className="text-muted-foreground mt-1.5 text-[11px] leading-relaxed">
            {isChinese
              ? "任意分类的最小容忍带，不受目标权重影响。"
              : "Minimum band for any sleeve, regardless of its target weight."}
          </p>
        )}
      </div>
    </div>
  );
}
