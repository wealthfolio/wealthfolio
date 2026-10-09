import { Icons } from "@wealthfolio/ui";
import type { InputHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

interface StepperFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Shown before the value, the currency in amount mode. */
  prefix?: string;
  /** Shown after the value, the percent sign in percentage mode. */
  suffix?: string;
  /** One-unit steps around the field; absent where a unit has no price. */
  unitSteps?: {
    downLabel: string;
    upLabel: string;
    /** Absent when a step down would cross what the worksheet allows. */
    onDown?: () => void;
    onUp: () => void;
  };
}

/**
 * An amount field with one-unit steps on either side, shared by a row and its
 * account allocation so both read and click the same way. The steps are
 * separate segments large enough to hit, 44 px on a phone.
 */
export function StepperField({
  prefix,
  suffix,
  unitSteps,
  className,
  ...input
}: StepperFieldProps) {
  const segment =
    "text-foreground hover:bg-muted flex w-11 shrink-0 items-center justify-center transition-colors disabled:pointer-events-none disabled:opacity-30 sm:w-9";
  return (
    <div
      className={cn(
        "border-input bg-background flex h-11 min-w-0 flex-1 items-stretch overflow-hidden rounded-lg border focus-within:border-[#557866] focus-within:ring-1 focus-within:ring-[#557866]/30 sm:h-9",
        className,
      )}
    >
      {unitSteps && (
        <button
          type="button"
          aria-label={unitSteps.downLabel}
          disabled={!unitSteps.onDown}
          onClick={unitSteps.onDown}
          className={cn(segment, "border-r")}
        >
          <Icons.Minus className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      )}
      <span className="flex min-w-0 flex-1 items-center gap-1.5 px-2.5">
        {prefix && <span className="text-muted-foreground text-[11px]">{prefix}</span>}
        <input
          {...input}
          className="min-w-0 flex-1 bg-transparent text-right font-mono text-[13px] font-medium tabular-nums outline-none"
        />
        {suffix && <span className="text-muted-foreground text-xs">{suffix}</span>}
      </span>
      {unitSteps && (
        <button
          type="button"
          aria-label={unitSteps.upLabel}
          onClick={unitSteps.onUp}
          className={cn(segment, "border-l")}
        >
          <Icons.Plus className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      )}
    </div>
  );
}
