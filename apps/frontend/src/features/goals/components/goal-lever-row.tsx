import { MoneyInput } from "@wealthfolio/ui";
import type { ReactNode } from "react";
import { useRef, useState } from "react";

export function sliderMaxFor(value: number, baseMax: number, increment: number) {
  const valueInclusiveMax = Math.ceil((value + increment) / increment) * increment;
  return Math.max(baseMax, valueInclusiveMax);
}

export function rateSliderMaxFor(
  value: number,
  baseMax: number,
  increment: number,
  inputMax: number,
) {
  if (value <= baseMax) return baseMax;
  return Math.min(inputMax, Math.ceil(value / increment) * increment + increment);
}

interface GoalLeverRowProps {
  label: ReactNode;
  hint?: string;
  kind?: "money" | "number";
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  inputMax?: number;
  step: number;
  prefix?: string;
  suffix?: string;
  format: (value: number) => string;
  warning?: ReactNode;
  inputWidthClassName?: string;
}

export function GoalLeverRow({
  label,
  hint,
  kind = "number",
  value,
  onChange,
  min,
  max,
  inputMax,
  step,
  prefix,
  suffix,
  format,
  warning,
  inputWidthClassName,
}: GoalLeverRowProps) {
  const inputScale = suffix === "%" ? 100 : 1;
  // Money fields have no natural hard cap (currencies vary by orders of
  // magnitude, e.g. IDR vs USD), so typed amounts stay unclamped unless the
  // caller passes an explicit inputMax. The slider itself stays bounded to a
  // practical, value-relative range via `max`.
  const inputUpperBound = inputMax ?? (kind === "money" ? Number.MAX_SAFE_INTEGER : max);
  // Sliders use a practical range; text inputs can allow a higher hard cap.
  const sliderUpperBound = Math.min(max, inputUpperBound);
  const clampedValue = Math.min(sliderUpperBound, Math.max(min, value));
  const pct = sliderUpperBound > min ? ((clampedValue - min) / (sliderUpperBound - min)) * 100 : 0;
  const clampSliderValue = (next: number) => Math.min(sliderUpperBound, Math.max(min, next));
  const clampMoneyInputValue = (next: number | undefined) =>
    Math.min(inputUpperBound, Math.max(min, next ?? 0));
  const clampInputValue = (next: number) =>
    Math.min(inputUpperBound * inputScale, Math.max(min * inputScale, next)) / inputScale;
  // Focused drafts are intentionally local until commit/cancel so previews do not overwrite typing.
  const [moneyDraftValue, setMoneyDraftValue] = useState<number | undefined>(undefined);
  const [moneyInputFocused, setMoneyInputFocused] = useState(false);
  const skipNextMoneyCommitRef = useRef(false);
  const [draftValue, setDraftValue] = useState<string | null>(null);
  const displayValue = draftValue ?? format(value);

  const commitMoneyDraftValue = () => {
    if (skipNextMoneyCommitRef.current) {
      skipNextMoneyCommitRef.current = false;
      setMoneyInputFocused(false);
      return;
    }
    if (!moneyInputFocused) return;

    const next = clampMoneyInputValue(moneyDraftValue);
    onChange(next);
    setMoneyDraftValue(next);
    setMoneyInputFocused(false);
  };

  const commitDraftValue = () => {
    const raw = displayValue.trim();
    if (!raw) {
      setDraftValue(null);
      return;
    }

    const parsed = parseFloat(raw.replace(/,/g, ""));
    if (Number.isNaN(parsed)) {
      setDraftValue(null);
      return;
    }

    const next = clampInputValue(parsed);
    onChange(next);
    setDraftValue(null);
  };

  return (
    <div className="py-4 first:pt-1 last:pb-1">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-foreground text-sm font-semibold leading-tight">{label}</div>
          {hint && <div className="text-muted-foreground mt-1 text-xs leading-tight">{hint}</div>}
        </div>
        <div
          className={`bg-muted/70 flex h-8 items-center gap-1 rounded-md border px-2.5 ${
            inputWidthClassName ?? (kind === "money" ? "w-44" : "w-32")
          }`}
          onFocus={
            kind === "money"
              ? () => {
                  setMoneyInputFocused(true);
                  setMoneyDraftValue(value);
                }
              : undefined
          }
          onBlur={kind === "money" ? commitMoneyDraftValue : undefined}
        >
          {prefix && <span className="text-muted-foreground text-xs tabular-nums">{prefix}</span>}
          {kind === "money" ? (
            <MoneyInput
              value={moneyInputFocused ? moneyDraftValue : value}
              onValueChange={setMoneyDraftValue}
              thousandSeparator
              maxDecimalPlaces={0}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
                if (event.key === "Escape") {
                  skipNextMoneyCommitRef.current = true;
                  setMoneyDraftValue(value);
                  event.currentTarget.blur();
                }
              }}
              className="text-foreground dark:bg-input/0 h-auto min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-right text-sm tabular-nums shadow-none outline-none ring-0 focus-visible:ring-0"
            />
          ) : (
            <input
              type="text"
              inputMode={suffix === "%" ? "decimal" : "numeric"}
              value={displayValue}
              onFocus={() => {
                setDraftValue(format(value));
              }}
              onChange={(event) => {
                const next = event.target.value;
                if (/^-?\d*([.,]\d*)?$/.test(next)) {
                  setDraftValue(next);
                }
              }}
              onBlur={() => {
                commitDraftValue();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
                if (event.key === "Escape") {
                  setDraftValue(null);
                }
              }}
              className="text-foreground w-full min-w-0 bg-transparent text-right text-sm tabular-nums outline-none"
            />
          )}
          {suffix && <span className="text-muted-foreground text-xs tabular-nums">{suffix}</span>}
        </div>
      </div>
      <input
        type="range"
        value={clampedValue}
        min={min}
        max={sliderUpperBound}
        step={step}
        onChange={(event) => onChange(clampSliderValue(parseFloat(event.target.value)))}
        className="lever-slider mt-3 w-full"
        style={{ ["--lever-pct" as string]: `${pct}%` }}
      />
      {warning && (
        <p className="mt-2 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-xs leading-snug text-amber-800 dark:text-amber-300">
          {warning}
        </p>
      )}
    </div>
  );
}
